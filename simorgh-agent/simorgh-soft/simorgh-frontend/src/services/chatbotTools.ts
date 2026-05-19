// Chatbot tool registry — the bridge between the AI assistant and the
// running app. Each tool declares a name, a short description, a JSON
// schema for its arguments, and an `execute(args, ctx)` function that
// runs against the app state.
//
// The chatbot sends prompts to the backend; the backend (an LLM with
// function-calling) may reply with both a human-readable answer *and*
// a list of tool_calls. The chatbot executes those locally so the user
// sees the side effects immediately.
//
// Architecture rationale lives in
//   docs/TEMPLATE_HIERARCHY_AND_AI.md
// — read it first if you want to add or change a tool.

import {
  ProjectData, Equipment, DeviceTableRow, TemplateItem, TemplateHierarchy,
} from '../types/project';

// ── Shared context passed to every tool ──────────────────────────────────────
export interface ChatToolContext {
  projectData: ProjectData;
  selectedEquipment: Equipment | null;
  updateEquipment: (id: string, data: Partial<Equipment>) => void;
  updateProjectData: (data: Partial<ProjectData>) => void;
}

export interface ChatToolCall {
  name: string;
  args: Record<string, any>;
}

export interface ChatToolResult {
  ok: boolean;
  summary: string;
  data?: any;
}

export interface ChatTool {
  name: string;
  description: string;
  /** Loose schema — `args` is a record describing each accepted field. */
  args: Record<string, { type: string; description: string; required?: boolean }>;
  execute: (args: any, ctx: ChatToolContext) => ChatToolResult | Promise<ChatToolResult>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function findEquipment(ctx: ChatToolContext, name?: string): Equipment | null {
  if (!name) return ctx.selectedEquipment;
  const target = name.toLowerCase().trim();
  return (ctx.projectData.equipments ?? []).find(e =>
    e.name?.toLowerCase().trim() === target
  ) || null;
}

function isMatch(rowVal: string | undefined, expected: string, fuzzy = false): boolean {
  const a = String(rowVal ?? '').trim();
  const b = String(expected ?? '').trim();
  if (!fuzzy) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

// ── Tools ───────────────────────────────────────────────────────────────────

const list_equipments: ChatTool = {
  name: 'list_equipments',
  description: 'Return the list of equipment in the current project (id, name, type, row count).',
  args: {},
  execute: (_args, ctx) => {
    const eqs = (ctx.projectData.equipments ?? []).map(e => ({
      id: e.id, name: e.name, type: e.type, rows: e.devices?.length ?? 0,
    }));
    return { ok: true, summary: `${eqs.length} equipment(s).`, data: eqs };
  },
};

const list_rows: ChatTool = {
  name: 'list_rows',
  description: 'Return all rows of an equipment. If equipmentName is omitted, the currently selected equipment is used.',
  args: {
    equipmentName: { type: 'string', description: 'Equipment name (case-insensitive). Optional.', required: false },
  },
  execute: ({ equipmentName }, ctx) => {
    const eq = findEquipment(ctx, equipmentName);
    if (!eq) return { ok: false, summary: 'Equipment not found and none selected.' };
    return {
      ok: true,
      summary: `${eq.devices.length} row(s) in ${eq.name}.`,
      data: { equipmentId: eq.id, equipmentName: eq.name, type: eq.type, rows: eq.devices },
    };
  },
};

const update_row: ChatTool = {
  name: 'update_row',
  description: 'Update one column in a single row of the active (or named) equipment.',
  args: {
    rowNumber:     { type: 'number', description: '1-based row number to update.', required: true },
    column:        { type: 'string', description: 'Column key (e.g. wiringType, ratingPower, flc, feederNo, busSection, tag, size, sfdHfd, moduleNo, cableSize, templateName, description).', required: true },
    value:         { type: 'string', description: 'New cell value.', required: true },
    equipmentName: { type: 'string', description: 'Optional — defaults to the selected equipment.', required: false },
  },
  execute: ({ rowNumber, column, value, equipmentName }, ctx) => {
    const eq = findEquipment(ctx, equipmentName);
    if (!eq) return { ok: false, summary: 'Equipment not found.' };
    const idx = (eq.devices ?? []).findIndex(r => r.rowNumber === Number(rowNumber));
    if (idx < 0) return { ok: false, summary: `Row #${rowNumber} not found in ${eq.name}.` };
    const nextDevices = eq.devices.map((r, i) =>
      i === idx ? { ...r, [column]: String(value) } as DeviceTableRow : r
    );
    ctx.updateEquipment(eq.id, { devices: nextDevices });
    return { ok: true, summary: `Set row #${rowNumber} of ${eq.name}: ${column} = "${value}".` };
  },
};

const bulk_update: ChatTool = {
  name: 'bulk_update',
  description: 'Find every row whose `where.column` equals `where.equals` and overwrite `set.column` with `set.value`. Returns the count of rows changed.',
  args: {
    where:         { type: 'object', description: '{ column, equals }', required: true },
    set:           { type: 'object', description: '{ column, value }',   required: true },
    equipmentName: { type: 'string', description: 'Optional — defaults to the selected equipment.', required: false },
    fuzzy:         { type: 'boolean', description: 'Case-insensitive match when comparing `where.equals`. Default false.', required: false },
  },
  execute: ({ where, set, equipmentName, fuzzy }, ctx) => {
    if (!where?.column || where?.equals == null || !set?.column || set?.value == null) {
      return { ok: false, summary: 'where.column / where.equals / set.column / set.value are all required.' };
    }
    const eq = findEquipment(ctx, equipmentName);
    if (!eq) return { ok: false, summary: 'Equipment not found.' };
    let changed = 0;
    const next = (eq.devices ?? []).map(r => {
      const current = (r as any)[where.column];
      if (isMatch(current, where.equals, !!fuzzy)) {
        changed++;
        return { ...r, [set.column]: String(set.value) } as DeviceTableRow;
      }
      return r;
    });
    if (changed > 0) ctx.updateEquipment(eq.id, { devices: next });
    return {
      ok: true,
      summary: `Updated ${changed} row(s) in ${eq.name} where ${where.column}="${where.equals}" → ${set.column}="${set.value}".`,
      data: { changed },
    };
  },
};

const add_row: ChatTool = {
  name: 'add_row',
  description: 'Append a new row to an equipment. Pass any subset of column values; missing ones default to empty.',
  args: {
    values:        { type: 'object', description: 'Map of column → value.', required: false },
    equipmentName: { type: 'string', description: 'Optional — defaults to the selected equipment.', required: false },
  },
  execute: ({ values, equipmentName }, ctx) => {
    const eq = findEquipment(ctx, equipmentName);
    if (!eq) return { ok: false, summary: 'Equipment not found.' };
    const next: DeviceTableRow = {
      id: `device-${Date.now()}`,
      rowNumber: (eq.devices?.length ?? 0) + 1,
      templateId: '', templateName: '',
      busSection: '', feederNo: '', wiringType: '', ratingPower: '', flc: '',
      tag: '', description: '', cableSize: '', sfdHfd: '', moduleNo: '', size: '',
      equipmentId: eq.id,
      ...(values || {}),
    } as DeviceTableRow;
    ctx.updateEquipment(eq.id, { devices: [...(eq.devices ?? []), next] });
    return { ok: true, summary: `Added row #${next.rowNumber} to ${eq.name}.` };
  },
};

const set_cell_color: ChatTool = {
  name: 'set_cell_color',
  description: 'Highlight one cell by setting its background colour (CSS hex). Pass empty string to clear.',
  args: {
    rowNumber:     { type: 'number', description: '1-based row number.', required: true },
    column:        { type: 'string', description: 'Column key.',         required: true },
    color:         { type: 'string', description: 'CSS colour (hex). Empty = clear.', required: true },
    equipmentName: { type: 'string', description: 'Optional.',            required: false },
  },
  execute: ({ rowNumber, column, color, equipmentName }, ctx) => {
    const eq = findEquipment(ctx, equipmentName);
    if (!eq) return { ok: false, summary: 'Equipment not found.' };
    const next = (eq.devices ?? []).map(r => {
      if (r.rowNumber !== Number(rowNumber)) return r;
      const cellColors = { ...(r.cellColors || {}) };
      if (color) cellColors[column] = String(color);
      else delete cellColors[column];
      return { ...r, cellColors };
    });
    ctx.updateEquipment(eq.id, { devices: next });
    return { ok: true, summary: `Cell colour for row #${rowNumber} / ${column} → ${color || 'cleared'}.` };
  },
};

const set_row_color: ChatTool = {
  name: 'set_row_color',
  description: 'Highlight an entire row.',
  args: {
    rowNumber:     { type: 'number', description: '1-based row number.', required: true },
    color:         { type: 'string', description: 'CSS colour (hex). Empty = clear.', required: true },
    equipmentName: { type: 'string', description: 'Optional.',            required: false },
  },
  execute: ({ rowNumber, color, equipmentName }, ctx) => {
    const eq = findEquipment(ctx, equipmentName);
    if (!eq) return { ok: false, summary: 'Equipment not found.' };
    const next = (eq.devices ?? []).map(r =>
      r.rowNumber === Number(rowNumber) ? { ...r, rowColor: color || undefined } : r
    );
    ctx.updateEquipment(eq.id, { devices: next });
    return { ok: true, summary: `Row #${rowNumber} colour → ${color || 'cleared'}.` };
  },
};

const apply_excel: ChatTool = {
  name: 'apply_excel',
  description: 'Apply a pre-parsed Excel slice (array of rows) into the active equipment. `columnMapping` says which Excel column maps to which row field. `rangeFrom` / `rangeTo` are inclusive row numbers (1-based) and bound the write target — omit to overwrite from row #1.',
  args: {
    excelRows:     { type: 'array',  description: 'Array of row objects parsed from Excel (one entry per row).', required: true },
    columnMapping: { type: 'object', description: 'Map of excelColumn → rowField (e.g. {"Wiring":"wiringType"}).', required: true },
    rangeFrom:     { type: 'number', description: 'Optional inclusive start (defaults to 1).', required: false },
    rangeTo:       { type: 'number', description: 'Optional inclusive end.', required: false },
    equipmentName: { type: 'string', description: 'Optional — defaults to the selected equipment.', required: false },
  },
  execute: ({ excelRows, columnMapping, rangeFrom, rangeTo, equipmentName }, ctx) => {
    const eq = findEquipment(ctx, equipmentName);
    if (!eq) return { ok: false, summary: 'Equipment not found.' };
    if (!Array.isArray(excelRows) || excelRows.length === 0) {
      return { ok: false, summary: 'excelRows is empty.' };
    }
    const startIdx = Math.max(0, (Number(rangeFrom) || 1) - 1);
    const endIdx   = rangeTo != null ? Number(rangeTo) - 1 : startIdx + excelRows.length - 1;
    let updated = 0;

    const existing = [...(eq.devices ?? [])];
    for (let i = 0; i + startIdx <= endIdx && i < excelRows.length; i++) {
      const targetIdx = startIdx + i;
      const excelRow  = excelRows[i] as Record<string, any>;
      const mapped: Record<string, any> = {};
      for (const [excelCol, rowField] of Object.entries(columnMapping || {})) {
        if (excelRow[excelCol] != null) mapped[String(rowField)] = String(excelRow[excelCol]);
      }
      if (Object.keys(mapped).length === 0) continue;
      if (existing[targetIdx]) {
        existing[targetIdx] = { ...existing[targetIdx], ...mapped };
      } else {
        existing[targetIdx] = {
          id: `device-${Date.now()}-${targetIdx}`,
          rowNumber: targetIdx + 1,
          templateId: '', templateName: '',
          busSection: '', feederNo: '', wiringType: '', ratingPower: '', flc: '',
          tag: '', description: '', cableSize: '', sfdHfd: '', moduleNo: '', size: '',
          equipmentId: eq.id,
          ...mapped,
        } as DeviceTableRow;
      }
      updated++;
    }
    // Renumber.
    const renumbered = existing.map((r, i) => r ? { ...r, rowNumber: i + 1 } : r).filter(Boolean) as DeviceTableRow[];
    ctx.updateEquipment(eq.id, { devices: renumbered });
    return { ok: true, summary: `Applied ${updated} Excel row(s) into ${eq.name} (rows ${startIdx + 1}–${endIdx + 1}).` };
  },
};

// ── Template hierarchy / recommendations ────────────────────────────────────

const find_similar_templates: ChatTool = {
  name: 'find_similar_templates',
  description: 'Suggest existing templates matching a hierarchical path. Ranks by leafKind match and parameter proximity (kW, currentA).',
  args: {
    type:      { type: 'string',  description: 'LV | MV | HV',                            required: true },
    path:      { type: 'array',   description: 'Path nodes from top to leaf.',            required: true },
    leafKind:  { type: 'string',  description: 'motor | transformer | lighting | other',  required: false },
    kw:        { type: 'string',  description: 'Rated kW or kVA (text).',                 required: false },
    currentA:  { type: 'string',  description: 'Full-load current (A).',                  required: false },
    limit:     { type: 'number',  description: 'Max results, default 5.',                 required: false },
  },
  execute: ({ type, path, leafKind, kw, currentA, limit }, ctx) => {
    const tier = (type || '').toUpperCase() as 'LV' | 'MV' | 'HV';
    if (!['LV', 'MV', 'HV'].includes(tier)) return { ok: false, summary: 'type must be LV/MV/HV.' };
    const candidates = (ctx.projectData.templates?.[tier] ?? []).filter(t => {
      const p = t.hierarchy?.path;
      if (!p || !Array.isArray(path)) return false;
      if (p.length !== path.length) return false;
      return p.every((step, i) => String(step).toLowerCase() === String(path[i]).toLowerCase());
    });

    const nKw  = parseFloat(String(kw ?? ''));
    const nA   = parseFloat(String(currentA ?? ''));

    const scored = candidates.map(t => {
      let score = 0;
      if (leafKind && t.hierarchy?.leafKind === leafKind) score += 100;
      const tKw = parseFloat(String(t.hierarchy?.params?.kw ?? ''));
      const tA  = parseFloat(String(t.hierarchy?.params?.currentA ?? ''));
      if (!Number.isNaN(nKw) && !Number.isNaN(tKw)) score -= Math.abs(nKw - tKw);
      if (!Number.isNaN(nA)  && !Number.isNaN(tA))  score -= Math.abs(nA  - tA);
      return { score, template: t };
    }).sort((a, b) => b.score - a.score).slice(0, Number(limit) || 5);

    return {
      ok: true,
      summary: `${scored.length} matching template(s) at path ${(path || []).join('/')}.`,
      data: scored.map(s => ({
        id:        s.template.id,
        name:      s.template.name,
        type:      s.template.type,
        hierarchy: s.template.hierarchy,
        score:     s.score,
      })),
    };
  },
};

const create_template: ChatTool = {
  name: 'create_template',
  description: 'Create a new (empty) template at the given hierarchical path. Returns the new id.',
  args: {
    type:      { type: 'string', description: 'LV | MV | HV',                                  required: true },
    name:      { type: 'string', description: 'Display name.',                                  required: true },
    path:      { type: 'array',  description: 'Hierarchical path (top → leaf).',                required: true },
    leafKind:  { type: 'string', description: 'motor | transformer | lighting | other',         required: false },
    kw:        { type: 'string', description: 'Rated power (kW / kVA).',                        required: false },
    currentA:  { type: 'string', description: 'Full-load current (A).',                         required: false },
  },
  execute: ({ type, name, path, leafKind, kw, currentA }, ctx) => {
    const tier = (type || '').toUpperCase() as 'LV' | 'MV' | 'HV';
    if (!['LV', 'MV', 'HV'].includes(tier)) return { ok: false, summary: 'type must be LV/MV/HV.' };
    if (!name) return { ok: false, summary: 'name is required.' };
    if (!Array.isArray(path)) return { ok: false, summary: 'path must be an array.' };

    const hierarchy: TemplateHierarchy = {
      path: path.map(String),
      leafKind: (leafKind as any) || undefined,
      params: { kw: kw ? String(kw) : undefined, currentA: currentA ? String(currentA) : undefined },
    };
    const newTmpl: TemplateItem = {
      id:         `tmpl-${Date.now()}`,
      name:       String(name),
      type:       tier,
      properties: {},
      hierarchy,
    };
    const tmpls = ctx.projectData.templates ?? { LV: [], MV: [], HV: [] };
    ctx.updateProjectData({ templates: { ...tmpls, [tier]: [...(tmpls[tier] ?? []), newTmpl] } });
    return { ok: true, summary: `Created template "${name}" at ${path.join('/')}.`, data: { id: newTmpl.id } };
  },
};

// ── Registry ────────────────────────────────────────────────────────────────
const TOOLS: ChatTool[] = [
  list_equipments, list_rows, update_row, bulk_update, add_row,
  set_cell_color, set_row_color, apply_excel,
  find_similar_templates, create_template,
];

export const CHAT_TOOLS: Record<string, ChatTool> = Object.fromEntries(
  TOOLS.map(t => [t.name, t])
);

/** Compact schema sent to the backend so the LLM knows what's callable. */
export function chatToolSchemas() {
  return TOOLS.map(t => ({
    name:        t.name,
    description: t.description,
    args:        t.args,
  }));
}

/** Execute a single tool call. Unknown names produce an error result. */
export async function executeChatTool(call: ChatToolCall, ctx: ChatToolContext): Promise<ChatToolResult> {
  const tool = CHAT_TOOLS[call.name];
  if (!tool) return { ok: false, summary: `Unknown tool: ${call.name}.` };
  try {
    return await tool.execute(call.args || {}, ctx);
  } catch (err: any) {
    return { ok: false, summary: `Tool ${call.name} threw: ${err?.message || err}` };
  }
}

/** Run every tool call in order; returns one result per call. */
export async function executeChatToolBatch(
  calls: ChatToolCall[],
  ctx: ChatToolContext
): Promise<ChatToolResult[]> {
  const results: ChatToolResult[] = [];
  for (const c of calls) {
    results.push(await executeChatTool(c, ctx));
  }
  return results;
}
