// Heuristic intent parser — a safety net for when the local LLM doesn't
// return our JSON envelope. Covers the common command shapes the user
// asks repeatedly (row edits, colour changes, field-set, navigation).
//
// Used purely as a fallback: if `parseToolEnvelope(reply).tool_calls` is
// empty AND this parser finds a clear intent in the user's prompt, the
// chatbot runs the matched tool call directly. The model's text reply
// is still shown above the action.
//
// This is intentionally a thin, regex-based layer — when the model behaves
// (e.g. on Qwen2.5 with response_format: json_object), it never fires.

import { ProjectData, Equipment } from '../types/project';
import { ChatToolCall } from './chatbotTools';

// ── Field aliases ───────────────────────────────────────────────────────────
// Map common terms users say to internal column/field names. Persian +
// English aliases live in the same table.
const COLUMN_ALIASES: { match: RegExp; field: string }[] = [
  { match: /\bwiring\s*type\b|\bwiring\b|\bسیم[\s‌]*کشی\b/i, field: 'wiringType' },
  { match: /\brating\s*power\b|\brating\b|\bpower\b|\bتوان\b/i,    field: 'ratingPower' },
  { match: /\bflc\b|\bجریان\b/i,                                   field: 'flc' },
  { match: /\bfeeder\s*(?:no\.?|number)?\b|\bفیدر\b/i,            field: 'feederNo' },
  { match: /\bbus\s*section\b|\bباس[\s‌]*سکشن\b/i,           field: 'busSection' },
  { match: /\btag\b|\bتگ\b/i,                                       field: 'tag' },
  { match: /\bdescription\b|\bتوضیحات\b/i,                          field: 'description' },
  { match: /\bcable\s*size\b|\bسایز\s*کابل\b/i,                    field: 'cableSize' },
  { match: /\bsfd\s*\/?\s*hfd\b|\bsfd\b|\bhfd\b/i,                 field: 'sfdHfd' },
  { match: /\bmodule\s*(?:no\.?|number)?\b|\bماژول\b/i,            field: 'moduleNo' },
  { match: /\bsize\b|\bسایز\b|\bاندازه\b/i,                         field: 'size' },
  { match: /\btemplate\b|\bتمپلیت\b/i,                              field: 'templateName' },
];

// Map common terms to techSettings dot-paths.
const TECH_ALIASES: { match: RegExp; path: string }[] = [
  { match: /\baltitude\b|\bارتفاع\b/i,                                  path: 'general.altitudeAboveSeaLevel' },
  { match: /\bdesign\s*temperature\b|\bدمای\s*طراحی\b/i,                path: 'general.designTemperature' },
  { match: /\bcontrol\s*circuit\b|\bمدار\s*کنترل\b/i,                   path: 'wireSize.controlCircuit' },
  { match: /\bct\s*secondary\b/i,                                       path: 'wireSize.ctSecondary' },
  { match: /\bpt\s*secondary\b/i,                                       path: 'wireSize.ptSecondary' },
  { match: /\bplc\s*power\s*supply\b/i,                                 path: 'wireSize.plcPowerSupply' },
  { match: /\b3[\s\-]?phase\b|\bسه[\s‌]*فاز\b/i,                  path: 'wireColor.threePhase' },
  { match: /\bac\s*phase\b/i,                                           path: 'wireColor.acPhase' },
  { match: /\bac\s*neutral\b/i,                                         path: 'wireColor.acNeutral' },
  { match: /\bdc\s*[+plus]\b|\bdc\s*\+\b/i,                            path: 'wireColor.dcPlus' },
  { match: /\bdc\s*[-minus−]\b/i,                                       path: 'wireColor.dcMinus' },
  { match: /\bplc\s*input\b/i,                                          path: 'wireColor.plcInput' },
  { match: /\bplc\s*output\b/i,                                         path: 'wireColor.plcOutput' },
  { match: /\bthickness\s*of\s*painting\b|\bضخامت\s*رنگ\b/i,           path: 'others.thicknessOfPainting' },
  { match: /\bcolor\s*type\b|\bنوع\s*رنگ\b/i,                          path: 'others.colorType' },
  { match: /\bbackground\s*color\b|\bرنگ\s*پس[\s‌]*زمینه\b/i,    path: 'others.backgroundColor' },
  { match: /\bwriting\s*color\b|\bرنگ\s*نوشته\b/i,                     path: 'others.writingColor' },
];

const PROJECT_ALIASES: { match: RegExp; field: string }[] = [
  { match: /\bproject\s*name\b|\bنام\s*پروژه\b/i,    field: 'projectName' },
  { match: /\bproject\s*id\b|\bpid\b|\bشناسه\b/i,    field: 'projectId' },
  { match: /\bproject\s*number\b|\boe\b|\bشماره\b/i, field: 'projectNumber' },
  { match: /\bclient\b|\bمشتری\b/i,                   field: 'client' },
  { match: /\blocation\b|\bموقعیت\b|\bمکان\b/i,       field: 'location' },
  { match: /\bstandard\b|\bاستاندارد\b/i,             field: 'standard' },
  { match: /\bcountry\b|\bکشور\b/i,                   field: 'country' },
  { match: /\blanguage\b|\bزبان\b/i,                  field: 'language' },
  { match: /\bplanner\b|\bطراح\b/i,                   field: 'planner' },
  { match: /\bdesign\s*office\b|\bدفتر\s*طراحی\b/i,   field: 'designOffice' },
];

// Persian/English colour name → hex (matches the chatbotTools palette).
const COLOR_WORDS: Record<string, string> = {
  // English
  red: '#ef4444', green: '#22c55e', yellow: '#facc15',
  blue: '#3b82f6', purple: '#a855f7', pink: '#ec4899',
  orange: '#f97316', amber: '#f59e0b', gray: '#9ca3af', grey: '#9ca3af',
  cyan: '#06b6d4', teal: '#14b8a6', black: '#000000', white: '#ffffff',
  // Persian
  'قرمز': '#ef4444', 'سبز': '#22c55e', 'زرد': '#facc15',
  'آبی': '#3b82f6', 'بنفش': '#a855f7', 'صورتی': '#ec4899',
  'نارنجی': '#f97316', 'مشکی': '#000000', 'سیاه': '#000000', 'سفید': '#ffffff',
  'خاکستری': '#9ca3af', 'فیروزه‌ای': '#06b6d4',
};
function colourForWord(s: string): string | null {
  const k = s.toLowerCase().trim();
  return COLOR_WORDS[k] || null;
}

function findColumnField(s: string): string | null {
  for (const a of COLUMN_ALIASES) if (a.match.test(s)) return a.field;
  return null;
}
function findTechPath(s: string): string | null {
  for (const a of TECH_ALIASES) if (a.match.test(s)) return a.path;
  return null;
}
function findProjectField(s: string): string | null {
  for (const a of PROJECT_ALIASES) if (a.match.test(s)) return a.field;
  return null;
}

const TAB_PATTERN = /\b(project[\s-]?(?:definition)?|template|create[\s-]?template|device[\s-]?selection|devices?|output[\s-]?types?|output|export)\b/i;
const TAB_TO_NAME: Record<string, string> = {
  project: 'project', 'project definition': 'project',
  template: 'template', 'create template': 'template', 'create-template': 'template',
  devices: 'devices', device: 'devices', 'device selection': 'devices',
  output: 'output', 'output types': 'output', export: 'output',
};

/** Try a battery of heuristics. Returns a tool_call (or null) plus a
 *  short summary the chatbot can show alongside the model's reply. */
export function intentParse(
  prompt: string,
  _ctx: { projectData: ProjectData; selectedEquipment: Equipment | null },
): { call: ChatToolCall; summary: string } | null {
  if (!prompt) return null;
  const p = prompt.trim();
  const lower = p.toLowerCase();

  // 1) Navigate tabs — "go to template", "تب تمپلیت", …
  if (/\b(go to|open|switch to|برو(?: به)?|باز کن|تب)\b/i.test(lower)) {
    const m = lower.match(TAB_PATTERN);
    if (m) {
      const key = TAB_TO_NAME[m[1].toLowerCase().replace(/[-]/g, ' ').replace(/\s+/g, ' ').trim()];
      if (key) return {
        call: { name: 'set_active_tab', args: { tab: key } },
        summary: `Switch to ${key} tab.`,
      };
    }
  }

  // 2) Row colour — "row 3 red", "ردیف ۲ را قرمز کن"
  //    Try numeric row + colour word.
  const rowNum = (() => {
    const m = p.match(/(?:row|ردیف)\s*(\d+)/i) || p.match(/(\d+)\s*(?:ام|ا|th|st|nd|rd)?/);
    return m ? Number(m[1]) : null;
  })();
  if (rowNum != null && rowNum >= 1) {
    // Find colour word anywhere in prompt
    const allWords = p.match(/[A-Za-z؀-ۿ]+/g) || [];
    let col: string | null = null;
    for (const w of allWords) {
      const c = colourForWord(w);
      if (c) { col = c; break; }
    }
    // Row colour
    if (col && /\b(highlight|colour|color|رنگ|بکن)\b/i.test(lower)) {
      // Check if a specific column was named — if so, cell colour.
      const colField = findColumnField(p);
      if (colField && colField !== 'templateName') {
        return {
          call: { name: 'set_cell_color', args: { rowNumber: rowNum, column: colField, color: col } },
          summary: `Cell colour: row #${rowNum} · ${colField} → ${col}.`,
        };
      }
      return {
        call: { name: 'set_row_color', args: { rowNumber: rowNum, color: col } },
        summary: `Row colour: row #${rowNum} → ${col}.`,
      };
    }
  }

  // 3) Update one row's column — "row 3 feederNo to L03", "ردیف ۳ feederNo را L03 کن"
  if (rowNum != null && rowNum >= 1) {
    const colField = findColumnField(p);
    // Capture the new value (last quoted string OR last bare token after "to"/"را"/"="/"به")
    const valMatch =
      p.match(/(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/) ||
      p.match(/(?:to|=|را\s+(?:بکن|کن)|=>|→|بشه|به)\s*([\w؀-ۿ.\-+/]+)\s*$/i) ||
      p.match(/(?:to|=|→|بشه|به)\s*([\w؀-ۿ.\-+/]+)/i);
    const newVal = valMatch ? (valMatch[1] || valMatch[2] || valMatch[3] || valMatch[4] || '').trim() : '';
    if (colField && newVal && colField !== 'templateName' && newVal.length < 100) {
      return {
        call: { name: 'update_row', args: { rowNumber: rowNum, column: colField, value: newVal } },
        summary: `Set row #${rowNum} ${colField} → "${newVal}".`,
      };
    }
  }

  // 4) Tech setting (e.g. "3 Phase را مشکی کن", "altitude is 1200")
  const techPath = findTechPath(p);
  if (techPath) {
    // Colour word? Use for wireColor.*
    if (techPath.startsWith('wireColor.')) {
      const allWords = p.match(/[A-Za-z؀-ۿ]+/g) || [];
      for (const w of allWords) {
        const c = colourForWord(w);
        if (c) {
          // For colours we store the name, not the hex (matches existing data).
          // English name is more searchable than hex for the user.
          const nameMatch = Object.entries(COLOR_WORDS).find(([_, v]) => v === c);
          const value = nameMatch ? nameMatch[0] : w;
          return {
            call: { name: 'set_tech_setting', args: { path: techPath, value } },
            summary: `Set ${techPath} = "${value}".`,
          };
        }
      }
    }
    // Numeric value (altitude, design temperature, painting thickness, …)
    const num = p.match(/(\d+(?:[.,]\d+)?)/);
    if (num) {
      return {
        call: { name: 'set_tech_setting', args: { path: techPath, value: num[1].replace(',', '.') } },
        summary: `Set ${techPath} = "${num[1]}".`,
      };
    }
    // Last quoted token as value
    const q = p.match(/(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/);
    if (q) {
      const v = (q[1] || q[2] || q[3] || '').trim();
      return {
        call: { name: 'set_tech_setting', args: { path: techPath, value: v } },
        summary: `Set ${techPath} = "${v}".`,
      };
    }
  }

  // 5) Project-level fields — "project name to Pars Refinery", "client = NIORDC"
  const projField = findProjectField(p);
  if (projField) {
    const valMatch =
      p.match(/(?:to|=|→|را|به|is)\s+([^,;\n]+?)\s*$/i) ||
      p.match(/(?:to|=|→|را|به|is)\s+([\w؀-ۿ .\-]+)/i);
    if (valMatch) {
      const v = valMatch[1].trim().replace(/[\"'`]+$/g, '').replace(/^[\"'`]+/g, '');
      if (v.length > 0 && v.length < 200) {
        return {
          call: { name: 'set_project_fields', args: { fields: { [projField]: v } } },
          summary: `Set project.${projField} = "${v}".`,
        };
      }
    }
  }

  // 6) "Everywhere X is Y change to Z" → bulk_update
  const bulk = p.match(/(?:everywhere|wherever|all\s+rows\s+where|where|هرجا|هر\s*جا)\s+([\w]+)\s+(?:is|=|equals?|مساوی|برابر)\s+([^\s,]+)[^.,]*?(?:to|→|=|change(?:d)?\s*to|بشود|بکن|تغییر\s*بده?\s*به)\s+([^\s.,]+)/i);
  if (bulk) {
    const colField = findColumnField(bulk[1]);
    if (colField) {
      return {
        call: { name: 'bulk_update', args: {
          where: { column: colField, equals: bulk[2] },
          set:   { column: colField, value: bulk[3] },
        }},
        summary: `Bulk update ${colField}: "${bulk[2]}" → "${bulk[3]}".`,
      };
    }
  }

  return null;
}
