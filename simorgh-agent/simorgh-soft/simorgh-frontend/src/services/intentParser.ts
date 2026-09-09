// Heuristic intent parser — a safety net for when the local LLM doesn't
// return our JSON envelope. Covers the command shapes the user asks
// repeatedly (row edits, colour changes, field-set, navigation).
//
// Two things decide what a command means:
//
//   1. The ACTIVE TAB. A command is read the way a colleague standing at
//      the screen would read it: "دما را ۵۰ کن" on Project Definition is
//      the design temperature in Technical Settings; the same words on
//      Device Selection are about the rows. Without that rule "temperature"
//      reaches the row tools, matches no column, and the user is told
//      "Equipment not found" about something that was never equipment.
//   2. What the sentence names explicitly. "ردیف ۳" or an equipment name
//      always wins over the tab.
//
// Two traps this file has to avoid, both of which used to make every
// Persian command silently fall through:
//
//   • `\b` cannot bound a Persian word. It marks a transition between an
//     ASCII word character and a non-word one, and Persian letters are
//     neither — so /\bارتفاع\b/ only ever matched when the term was glued
//     to ASCII. Terms are matched through `term()` below instead.
//   • Persian digits. "ردیف ۲" carries U+06F2, which `\d` does not match,
//     so every command written with a Persian keyboard missed. The prompt
//     is normalised to ASCII digits first.

import { ProjectData, Equipment } from '../types/project';
import { ChatToolCall } from './chatbotTools';

// Tab indices, named so the rules below read like the screen.
export const TAB_PROJECT  = 0;
export const TAB_TEMPLATE = 1;
export const TAB_DEVICES  = 2;

export interface IntentContext {
  projectData: ProjectData;
  selectedEquipment: Equipment | null;
  /** Index of the tab the user is looking at. */
  activeTab?: number;
}
export interface Intent { call: ChatToolCall; summary: string }

// ── Text normalisation ──────────────────────────────────────────────────────
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS  = '٠١٢٣٤٥٦٧٨٩';

/** Persian/Arabic digits → ASCII, ZWNJ → space, Arabic ye/kaf → Persian. */
function normalize(input: string): string {
  return input
    .replace(/[۰-۹]/g, d => String(PERSIAN_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, d => String(ARABIC_DIGITS.indexOf(d)))
    .replace(/‌/g, ' ')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/\s+/g, ' ')
    .trim();
}

// A boundary that works for both scripts: anything that is not an ASCII word
// character and not an Arabic-script letter. Written as plain character
// classes (no lookbehind) so it runs in every browser the app supports.
const EDGE = '[^\\w\\u0600-\\u06FF]';
const term = (...alternatives: string[]) =>
  new RegExp(`(?:^|${EDGE})(?:${alternatives.join('|')})(?:$|${EDGE})`, 'i');

// ── Field aliases ───────────────────────────────────────────────────────────
// Device-row columns (Device Selection).
const COLUMN_ALIASES: { match: RegExp; field: string }[] = [
  { match: term('wiring\\s*type', 'wiring', 'نوع سیم کشی', 'سیم کشی'), field: 'wiringType' },
  { match: term('rating\\s*power', 'rating', 'power', 'توان'),          field: 'ratingPower' },
  { match: term('flc', 'جریان بار کامل', 'جریان'),                      field: 'flc' },
  { match: term('feeder\\s*(?:no\\.?|number)?', 'شماره فیدر', 'فیدر'),  field: 'feederNo' },
  { match: term('bus\\s*section', 'باس سکشن', 'سکشن'),                  field: 'busSection' },
  { match: term('tag', 'تگ'),                                            field: 'tag' },
  { match: term('description', 'توضیحات', 'شرح'),                        field: 'description' },
  { match: term('cable\\s*size', 'سایز کابل', 'کابل'),                   field: 'cableSize' },
  { match: term('sfd\\s*/?\\s*hfd', 'sfd', 'hfd'),                       field: 'sfdHfd' },
  { match: term('module\\s*(?:no\\.?|number)?', 'شماره ماژول', 'ماژول'), field: 'moduleNo' },
  { match: term('size', 'سایز', 'اندازه'),                               field: 'size' },
  { match: term('template', 'تمپلیت'),                                    field: 'templateName' },
];

// Technical Settings (Project Definition). Most specific first.
const TECH_ALIASES: { match: RegExp; path: string }[] = [
  { match: term('altitude', 'ارتفاع از سطح دریا', 'سطح دریا', 'سطح آب دریا',
                'ارتفاع'),                                                        path: 'general.altitudeAboveSeaLevel' },
  { match: term('design\\s*temp(?:erature)?', 'temp(?:erature)?',
                'دمای طراحی', 'دمای', 'دما', 'حرارت'),                           path: 'general.designTemperature' },
  { match: term('control\\s*circuit', 'مدار کنترل'),                            path: 'wireSize.controlCircuit' },
  { match: term('ct\\s*secondary', 'ثانویه ct'),                                path: 'wireSize.ctSecondary' },
  { match: term('pt\\s*secondary', 'ثانویه pt'),                                path: 'wireSize.ptSecondary' },
  { match: term('plc\\s*power\\s*supply', 'تغذیه plc'),                         path: 'wireSize.plcPowerSupply' },
  { match: term('3\\s*-?\\s*phase', 'three\\s*phase', 'سه فاز'),                path: 'wireColor.threePhase' },
  { match: term('ac\\s*phase', 'فاز ac'),                                       path: 'wireColor.acPhase' },
  { match: term('ac\\s*neutral', 'نول'),                                        path: 'wireColor.acNeutral' },
  { match: term('dc\\s*\\+', 'dc\\s*plus', 'مثبت dc'),                          path: 'wireColor.dcPlus' },
  { match: term('dc\\s*-', 'dc\\s*minus', 'منفی dc'),                           path: 'wireColor.dcMinus' },
  { match: term('plc\\s*input', 'ورودی plc'),                                   path: 'wireColor.plcInput' },
  { match: term('plc\\s*output', 'خروجی plc'),                                  path: 'wireColor.plcOutput' },
  { match: term('thickness\\s*of\\s*painting', 'ضخامت رنگ'),                    path: 'others.thicknessOfPainting' },
  { match: term('color\\s*type', 'colour\\s*type', 'نوع رنگ'),                  path: 'others.colorType' },
  { match: term('background\\s*colou?r', 'رنگ پس زمینه', 'رنگ زمینه'),          path: 'others.backgroundColor' },
  { match: term('writing\\s*colou?r', 'رنگ نوشته'),                             path: 'others.writingColor' },
];

// Project master data (Project Definition).
const PROJECT_ALIASES: { match: RegExp; field: string }[] = [
  { match: term('project\\s*name', 'نام پروژه'),                 field: 'projectName' },
  { match: term('project\\s*id', 'pid', 'شناسه پروژه'),          field: 'projectId' },
  { match: term('project\\s*number', 'oe', 'شماره پروژه'),       field: 'projectNumber' },
  { match: term('project\\s*description', 'شرح پروژه'),          field: 'projectDescription' },
  { match: term('client', 'مشتری', 'کارفرما'),                    field: 'client' },
  { match: term('location', 'موقعیت', 'مکان'),                    field: 'location' },
  { match: term('standard', 'استاندارد'),                         field: 'standard' },
  { match: term('country', 'کشور'),                               field: 'country' },
  { match: term('language', 'زبان'),                              field: 'language' },
  { match: term('planner', 'طراح'),                               field: 'planner' },
  { match: term('design\\s*office', 'دفتر طراحی'),                field: 'designOffice' },
];

// Persian/English colour name → hex (matches the chatbotTools palette).
const COLOR_WORDS: Record<string, string> = {
  red: '#ef4444', green: '#22c55e', yellow: '#facc15',
  blue: '#3b82f6', purple: '#a855f7', pink: '#ec4899',
  orange: '#f97316', amber: '#f59e0b', gray: '#9ca3af', grey: '#9ca3af',
  cyan: '#06b6d4', teal: '#14b8a6', black: '#000000', white: '#ffffff',
  'قرمز': '#ef4444', 'سبز': '#22c55e', 'زرد': '#facc15',
  'آبی': '#3b82f6', 'بنفش': '#a855f7', 'صورتی': '#ec4899',
  'نارنجی': '#f97316', 'مشکی': '#000000', 'سیاه': '#000000', 'سفید': '#ffffff',
  'خاکستری': '#9ca3af', 'فیروزه ای': '#06b6d4',
};
const COLOUR_RE = new RegExp(
  `(?:^|${EDGE})(${Object.keys(COLOR_WORDS).join('|')})(?:$|${EDGE})`, 'i');

function findColour(s: string): string | null {
  const m = s.match(COLOUR_RE);
  return m ? COLOR_WORDS[m[1].toLowerCase()] || null : null;
}
/** The stored value for a colour is its name, which is what the tables hold. */
function colourName(hex: string, fallback: string): string {
  const entry = Object.entries(COLOR_WORDS).find(([, v]) => v === hex);
  return entry ? entry[0] : fallback;
}

function findColumnField(s: string): string | null {
  for (const a of COLUMN_ALIASES) if (a.match.test(s)) return a.field;
  return null;
}
function findTechPath(s: string): { path: string; end: number } | null {
  for (const a of TECH_ALIASES) {
    const m = s.match(a.match);
    if (m) return { path: a.path, end: (m.index ?? 0) + m[0].length };
  }
  return null;
}
function findProjectField(s: string): { field: string; end: number } | null {
  for (const a of PROJECT_ALIASES) {
    const m = s.match(a.match);
    if (m) return { field: a.field, end: (m.index ?? 0) + m[0].length };
  }
  return null;
}

// A question is not an instruction: "what is the client?" must not set the
// client to "the client". Only a short, plain remainder is taken as a value.
const ASKING = /[?؟]|(?:^|[^\w\u0600-\u06FF])(?:what|which|why|how|چی|چیه|چیست|کیست|کجاست|چه|کدام|چند|چقدر|چطور|آیا)(?:$|[^\w\u0600-\u06FF])/i;

/** The words right after a field name — "client NIORDC" with no connector. */
function valueAfterTerm(p: string, end: number): string {
  if (ASKING.test(p)) return '';
  const rest = p.slice(end)
    .replace(TRAILING_VERBS, ' ')
    .replace(/[.,;:!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!rest) return '';
  return rest.split(' ').length <= 5 ? rest : '';
}

// ── Navigation ──────────────────────────────────────────────────────────────
const GO_RE = term('go to', 'open', 'switch to', 'برو', 'برو به', 'باز کن', 'تب');
const TAB_PATTERN =
  /(project[\s-]?(?:definition)?|create[\s-]?template|template|device[\s-]?selection|devices?|output[\s-]?types?|output|export|eplanix|پروژه|تمپلیت|دستگاه|خروجی)/i;
const TAB_TO_NAME: Record<string, string> = {
  project: 'project', 'project definition': 'project', 'پروژه': 'project',
  template: 'template', 'create template': 'template', 'تمپلیت': 'template',
  devices: 'devices', device: 'devices', 'device selection': 'devices', 'دستگاه': 'devices',
  output: 'output', 'output types': 'output', export: 'output', 'خروجی': 'output',
  eplanix: 'eplanix',
};

// "row 3", "ردیف ۳" — a row is only a row when it is named as one. A bare
// number is a value: "M3" used to be read as row 3 and swallow bulk edits.
const ROW_RE = term('row|ردیف') && /(?:row|ردیف)\s*#?\s*(\d+)/i;

// The words that introduce a value ("… to L03", "… را L03 کن"), and the
// verbs that trail it in Persian and are not part of it.
const CONNECTORS = ['to', 'be', 'is', 'into', '=', '=>', '→', 'به', 'را', 'برابر', 'بشه', 'بشود', 'شود'];
const TRAILING_VERBS = /(?:^|[^\w\u0600-\u06FF])(?:کن|بکن|کند|بشه|بشود|شود|باشد|بده|بذار|تغییر|بشین|است|هست|درجه|متر|میلیمتر|mm|m)(?=$|[^\w\u0600-\u06FF])/gi;
const CONNECTOR_RE = new RegExp(
  `(?:^|${EDGE})(?:${CONNECTORS.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:$|${EDGE})`, 'gi');

/** Everything after the last connector — used where a value may have spaces
 *  (a project name, a client). Trailing Persian verbs are not part of it. */
function trailingPhrase(p: string): string {
  const quoted = p.match(/"([^"]+)"|'([^']+)'|`([^`]+)`/);
  if (quoted) return (quoted[1] || quoted[2] || quoted[3] || '').trim();
  CONNECTOR_RE.lastIndex = 0;
  let end = -1;
  let m: RegExpExecArray | null;
  while ((m = CONNECTOR_RE.exec(p)) !== null) {
    end = m.index + m[0].length;
    // A connector that ends the sentence introduces nothing.
    if (end >= p.length) break;
  }
  if (end < 0 || end >= p.length) return '';
  let tail = p.slice(end);
  tail = tail.replace(TRAILING_VERBS, ' ');
  return tail.replace(/[.,;:!?]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The single token after the last connector — a cell value. */
function trailingValue(p: string): string {
  const phrase = trailingPhrase(p);
  if (!phrase) return '';
  return phrase.split(' ')[0];
}

/**
 * The number that belongs to a term — the first one AFTER it, falling back to
 * the one before when the sentence puts the value first. Taking simply the
 * first number in the sentence is what turned "سطح دریا 2000 و دما را بکن 50"
 * into a design temperature of 2000.
 */
function numberFor(p: string, termEnd: number): string | null {
  const after = p.slice(termEnd).match(/(\d+(?:[.,]\d+)?)/);
  if (after) return after[1].replace(',', '.');
  const before = p.slice(0, termEnd).match(/(\d+(?:[.,]\d+)?)(?!.*\d)/);
  return before ? before[1].replace(',', '.') : null;
}

// ── Tab-scoped families ─────────────────────────────────────────────────────

/** Project Definition: Technical Settings and project master data. */
function projectScopedParse(p: string): Intent | null {
  const tech = findTechPath(p);
  if (tech) {
    const { path } = tech;
    if (/colou?r/i.test(path)) {
      const hex = findColour(p);
      if (hex) {
        const value = colourName(hex, '');
        return {
          call: { name: 'set_tech_setting', args: { path, value } },
          summary: `Set ${path} = "${value}".`,
        };
      }
    }
    const num = numberFor(p, tech.end);
    if (num) {
      return {
        call: { name: 'set_tech_setting', args: { path, value: num } },
        summary: `Set ${path} = "${num}".`,
      };
    }
    const v = trailingValue(p);
    if (v) {
      return {
        call: { name: 'set_tech_setting', args: { path, value: v } },
        summary: `Set ${path} = "${v}".`,
      };
    }
  }

  const proj = findProjectField(p);
  if (proj) {
    const v = (trailingPhrase(p) || valueAfterTerm(p, proj.end))
      .replace(/^["'`]+|["'`]+$/g, '');
    if (v.length > 0 && v.length < 200) {
      return {
        call: { name: 'set_project_fields', args: { fields: { [proj.field]: v } } },
        summary: `Set project.${proj.field} = "${v}".`,
      };
    }
  }
  return null;
}

/** Device Selection: whole-table edits and single-row edits. */
function rowScopedParse(p: string): Intent | null {
  // "Everywhere X is Y change to Z" — checked BEFORE the single-row rules,
  // otherwise the "3" inside a value like "M3" is read as a row number and
  // the bulk edit is silently turned into an edit of row 3.
  const bulk = p.match(
    /(?:everywhere|wherever|all\s+rows\s+where|where|هرجا|هر جا|هرکجا)\s+([\w]+)\s+(?:is|=|equals?|مساوی|برابر)\s+([^\s,]+)[\s\S]*?(?:changed?\s*to|to|→|=|تغییر بده به|بشود|بکن|به)\s+([^\s.,]+)/i);
  if (bulk) {
    const colField = findColumnField(bulk[1]) || bulk[1];
    return {
      call: { name: 'bulk_update', args: {
        where: { column: colField, equals: bulk[2] },
        set:   { column: colField, value: bulk[3] },
      }},
      summary: `Bulk update ${colField}: "${bulk[2]}" → "${bulk[3]}".`,
    };
  }

  const rowMatch = p.match(ROW_RE as RegExp);
  const rowNum = rowMatch ? Number(rowMatch[1]) : null;
  if (rowNum == null || rowNum < 1) return null;

  // Colour: "ردیف ۲ را قرمز کن", "highlight row 2 red".
  const hex = findColour(p);
  if (hex) {
    const colField = findColumnField(p);
    if (colField && colField !== 'templateName') {
      return {
        call: { name: 'set_cell_color', args: { rowNumber: rowNum, column: colField, color: hex } },
        summary: `Cell colour: row #${rowNum} · ${colField} → ${hex}.`,
      };
    }
    return {
      call: { name: 'set_row_color', args: { rowNumber: rowNum, color: hex } },
      summary: `Row colour: row #${rowNum} → ${hex}.`,
    };
  }

  // One column of one row: "row 3 feederNo to L03".
  const colField = findColumnField(p);
  const newVal = trailingValue(p);
  if (colField && newVal && newVal.length < 100) {
    return {
      call: { name: 'update_row', args: { rowNumber: rowNum, column: colField, value: newVal } },
      summary: `Set row #${rowNum} ${colField} → "${newVal}".`,
    };
  }
  return null;
}

/** Navigation is tab-independent — it is how the user changes tabs. */
function navigationParse(p: string): Intent | null {
  if (!GO_RE.test(p)) return null;
  const m = p.match(TAB_PATTERN);
  if (!m) return null;
  const key = TAB_TO_NAME[m[1].toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').trim()];
  if (!key) return null;
  return {
    call: { name: 'set_active_tab', args: { tab: key } },
    summary: `Switch to ${key} tab.`,
  };
}

/**
 * Try a battery of heuristics. Returns a tool call (or null) plus a short
 * summary the chatbot shows alongside the model's reply.
 *
 * The active tab decides which family is asked first; whatever the sentence
 * names explicitly (a row number, "هرجا …") still wins.
 */
function parseOne(p: string, ctx: IntentContext): Intent | null {
  const nav = navigationParse(p);
  if (nav) return nav;

  // A question is for the model to answer. Acting on one would turn "what is
  // the client?" into a client named "the client".
  if (ASKING.test(p)) return null;

  const namesARow = (ROW_RE as RegExp).test(p);
  const onProjectTab = ctx.activeTab === TAB_PROJECT;

  // On Project Definition the row family only gets a look in when the user
  // actually named a row; otherwise a number in the sentence is a value.
  const order = onProjectTab && !namesARow
    ? [projectScopedParse, rowScopedParse]
    : [rowScopedParse, projectScopedParse];

  for (const parse of order) {
    const hit = parse(p);
    if (hit) return hit;
  }
  return null;
}

/**
 * Every command in the sentence, in order.
 *
 * People put more than one instruction in a line — "سطح دریا 2000 و دما را
 * بکن 50" is two. Read as one sentence it becomes a single setting with the
 * wrong number attached, so the clauses are parsed separately. The split is
 * only trusted when it yields more than one command; otherwise the sentence
 * is read whole, which keeps values that contain "and" or "و" intact.
 */
export function intentParseAll(prompt: string, ctx: IntentContext): Intent[] {
  if (!prompt) return [];
  const p = normalize(prompt);
  if (!p) return [];

  const clauses = p
    .split(new RegExp(`(?:${EDGE}(?:و|and)${EDGE}|[،؛,;]|\\bو\\b)`, 'i'))
    .map(c => c.trim())
    .filter(Boolean);

  if (clauses.length > 1) {
    const found: Intent[] = [];
    const seen = new Set<string>();
    for (const clause of clauses) {
      const hit = parseOne(clause, ctx);
      // The same call twice (a term repeated across clauses) is one command.
      if (hit) {
        const key = JSON.stringify(hit.call);
        if (!seen.has(key)) { seen.add(key); found.push(hit); }
      }
    }
    if (found.length > 1) return found;
  }

  const whole = parseOne(p, ctx);
  return whole ? [whole] : [];
}

/** The first command in the sentence, for callers that want just one. */
export function intentParse(prompt: string, ctx: IntentContext): Intent | null {
  return intentParseAll(prompt, ctx)[0] ?? null;
}
