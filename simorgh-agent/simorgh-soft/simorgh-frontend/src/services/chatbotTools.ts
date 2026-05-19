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
  DeviceLibraryItem,
} from '../types/project';

// ── Shared context passed to every tool ──────────────────────────────────────
// The frontend wires every relevant ProjectContext / UI handle in here, so
// tools can drive any tab without reaching for window globals.
export interface ChatToolContext {
  projectData: ProjectData;
  selectedEquipment: Equipment | null;
  updateEquipment: (id: string, data: Partial<Equipment>) => void;
  updateProjectData: (data: Partial<ProjectData>) => void;
  addEquipment: (eq: Equipment) => void;
  deleteEquipment: (id: string) => void;
  setSelectedEquipment: (eq: Equipment | null) => void;
  deleteTemplate: (id: string) => void;
  /** Switch between top-level tabs. Indices: 0 Project Definition,
   *  1 Template Creation, 2 Device Selection, 3 Output Types. */
  setActiveTab?: (idx: number) => void;
  /** Save the project to the backend (Mongo). */
  saveProject?: () => Promise<void>;
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

// ──────────────────────────────────────────────────────────────────────────
// Tab navigation
// ──────────────────────────────────────────────────────────────────────────
const TAB_NAMES: Record<string, number> = {
  // Multiple aliases per tab so the model can be sloppy about phrasing.
  'project':            0, 'project-definition': 0, 'project_definition': 0, 'definition': 0,
  'template':           1, 'templates': 1, 'create-template': 1, 'create_template': 1, 'create template': 1,
  'devices':            2, 'device-selection': 2, 'device_selection': 2, 'device selection': 2,
  'output':             3, 'output-types': 3, 'output_types': 3, 'output types': 3, 'export': 3,
};

const set_active_tab: ChatTool = {
  name: 'set_active_tab',
  description: 'Switch the visible tab. Accepts "project", "template", "devices", or "output" (case-insensitive; spaces/hyphens/underscores are OK).',
  args: {
    tab: { type: 'string', description: 'project | template | devices | output', required: true },
  },
  execute: ({ tab }, ctx) => {
    const idx = TAB_NAMES[String(tab || '').toLowerCase().trim()];
    if (idx === undefined) return { ok: false, summary: `Unknown tab "${tab}".` };
    if (!ctx.setActiveTab) return { ok: false, summary: 'Tab navigation not wired into this context.' };
    ctx.setActiveTab(idx);
    const label = ['Project Definition', 'Create Template', 'Device Selection', 'Output Types'][idx];
    return { ok: true, summary: `Switched to "${label}" tab.` };
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Project Definition tab — project-level metadata & technical settings
// ──────────────────────────────────────────────────────────────────────────
const PROJECT_TEXT_FIELDS = new Set([
  'projectName', 'projectId', 'projectNumber', 'projectDescription',
  'planner', 'designOffice', 'location', 'client', 'standard',
  'country', 'language', 'comment',
  'noticeToProceedDate', 'deliveryDate',
]);

const set_project_fields: ChatTool = {
  name: 'set_project_fields',
  description: 'Update one or more top-level project metadata fields (projectName, projectId, projectNumber, client, location, standard, country, language, planner, designOffice, projectDescription, comment, noticeToProceedDate, deliveryDate).',
  args: {
    fields: { type: 'object', description: 'Map of field → new value.', required: true },
  },
  execute: ({ fields }, ctx) => {
    if (!fields || typeof fields !== 'object') return { ok: false, summary: 'fields must be an object.' };
    const accepted: Record<string, any> = {};
    const rejected: string[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (PROJECT_TEXT_FIELDS.has(k)) accepted[k] = String(v ?? '');
      else rejected.push(k);
    }
    if (Object.keys(accepted).length === 0) {
      return { ok: false, summary: `No accepted fields. Unknown: ${rejected.join(', ')}` };
    }
    ctx.updateProjectData(accepted);
    return {
      ok: true,
      summary: `Updated ${Object.keys(accepted).length} project field(s): ${Object.keys(accepted).join(', ')}.` +
               (rejected.length ? ` (Ignored: ${rejected.join(', ')})` : ''),
    };
  },
};

const set_tech_setting: ChatTool = {
  name: 'set_tech_setting',
  description: 'Update one technical-settings value. `path` is a dot-path under `techSettings`: e.g. "general.altitudeAboveSeaLevel", "wireSize.controlCircuit", "wireColor.acPhase", "wireManufacturer.lv", "others.thicknessOfPainting".',
  args: {
    path:  { type: 'string', description: 'Dot path under techSettings.', required: true },
    value: { type: 'string', description: 'New value (string).', required: true },
  },
  execute: ({ path, value }, ctx) => {
    if (!path) return { ok: false, summary: 'path is required.' };
    const segments = String(path).split('.').filter(Boolean);
    if (segments.length < 2) return { ok: false, summary: 'path must have at least 2 segments (e.g. general.altitudeAboveSeaLevel).' };
    const tech = JSON.parse(JSON.stringify(ctx.projectData.techSettings || {}));
    let node: any = tech;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (typeof node[seg] !== 'object' || node[seg] == null) node[seg] = {};
      node = node[seg];
    }
    node[segments[segments.length - 1]] = String(value);
    ctx.updateProjectData({ techSettings: tech });
    return { ok: true, summary: `Set techSettings.${path} = "${value}".` };
  },
};

const save_project: ChatTool = {
  name: 'save_project',
  description: 'Persist the current project to the backend (MongoDB) immediately. Auto-save also runs every 5s, but this forces it.',
  args: {},
  execute: async (_args, ctx) => {
    if (!ctx.saveProject) return { ok: false, summary: 'Save handle not available in this context.' };
    try {
      await ctx.saveProject();
      return { ok: true, summary: 'Project saved.' };
    } catch (e: any) {
      return { ok: false, summary: `Save failed: ${e?.message || e}` };
    }
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Device Library (Project Definition → Device Library sub-tab)
// ──────────────────────────────────────────────────────────────────────────
const add_library_device: ChatTool = {
  name: 'add_library_device',
  description: 'Create a new device-library entry in a given tier (LV/MV/HV) with optional pre-filled properties.',
  args: {
    type:       { type: 'string', description: 'LV | MV | HV', required: true },
    name:       { type: 'string', description: 'Display name for the device.', required: true },
    properties: { type: 'object', description: 'Optional DeviceLibraryProperties map.', required: false },
  },
  execute: ({ type, name, properties }, ctx) => {
    const tier = String(type || '').toUpperCase() as 'LV' | 'MV' | 'HV';
    if (!['LV','MV','HV'].includes(tier)) return { ok: false, summary: 'type must be LV/MV/HV.' };
    if (!name) return { ok: false, summary: 'name is required.' };
    const item: DeviceLibraryItem = {
      id: `dev-${Date.now()}`,
      name: String(name),
      type: tier,
      properties: (properties && typeof properties === 'object' ? properties : {}) as any,
    };
    const lib = ctx.projectData.deviceLibrary || { LV: [], MV: [], HV: [] };
    ctx.updateProjectData({ deviceLibrary: { ...lib, [tier]: [...(lib[tier] ?? []), item] } });
    return { ok: true, summary: `Added ${tier} device "${name}" to the library.`, data: { id: item.id } };
  },
};

const update_library_device: ChatTool = {
  name: 'update_library_device',
  description: 'Modify an existing device-library entry by id OR by name (case-insensitive match within the tier).',
  args: {
    type:       { type: 'string', description: 'LV | MV | HV', required: true },
    id:         { type: 'string', description: 'Device id (preferred when known).', required: false },
    name:       { type: 'string', description: 'Device name (case-insensitive). Used if id is missing.', required: false },
    fields:     { type: 'object', description: 'Patch — fields to overwrite. May include `name` and any DeviceLibraryProperties key.', required: true },
  },
  execute: ({ type, id, name, fields }, ctx) => {
    const tier = String(type || '').toUpperCase() as 'LV' | 'MV' | 'HV';
    if (!['LV','MV','HV'].includes(tier)) return { ok: false, summary: 'type must be LV/MV/HV.' };
    if (!fields || typeof fields !== 'object') return { ok: false, summary: 'fields is required.' };
    const lib = ctx.projectData.deviceLibrary || { LV: [], MV: [], HV: [] };
    const list = lib[tier] || [];
    const idx = id
      ? list.findIndex(d => d.id === id)
      : list.findIndex(d => d.name?.toLowerCase() === String(name || '').toLowerCase());
    if (idx < 0) return { ok: false, summary: `Device not found in ${tier} library.` };
    const target = list[idx];
    const { name: newName, ...propPatch } = fields as any;
    const next: DeviceLibraryItem = {
      ...target,
      ...(newName ? { name: String(newName) } : {}),
      properties: { ...(target.properties as any), ...propPatch } as any,
    };
    const nextList = [...list]; nextList[idx] = next;
    ctx.updateProjectData({ deviceLibrary: { ...lib, [tier]: nextList } });
    return { ok: true, summary: `Updated ${tier} device "${target.name}".` };
  },
};

const delete_library_device: ChatTool = {
  name: 'delete_library_device',
  description: 'Remove a device-library entry by id OR by name (case-insensitive within the tier).',
  args: {
    type: { type: 'string', description: 'LV | MV | HV', required: true },
    id:   { type: 'string', description: 'Device id.', required: false },
    name: { type: 'string', description: 'Device name.', required: false },
  },
  execute: ({ type, id, name }, ctx) => {
    const tier = String(type || '').toUpperCase() as 'LV' | 'MV' | 'HV';
    if (!['LV','MV','HV'].includes(tier)) return { ok: false, summary: 'type must be LV/MV/HV.' };
    const lib = ctx.projectData.deviceLibrary || { LV: [], MV: [], HV: [] };
    const list = lib[tier] || [];
    const target = id
      ? list.find(d => d.id === id)
      : list.find(d => d.name?.toLowerCase() === String(name || '').toLowerCase());
    if (!target) return { ok: false, summary: `Device not found in ${tier} library.` };
    ctx.updateProjectData({ deviceLibrary: { ...lib, [tier]: list.filter(d => d.id !== target.id) } });
    return { ok: true, summary: `Deleted ${tier} device "${target.name}".` };
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Equipment (Device Selection tab's right-side tree)
// ──────────────────────────────────────────────────────────────────────────
const add_equipment: ChatTool = {
  name: 'add_equipment',
  description: 'Create a new equipment in the equipment tree. Optionally bind it to a device-library item.',
  args: {
    name: { type: 'string', description: 'Equipment name.', required: true },
    type: { type: 'string', description: 'LV | MV | HV', required: true },
    deviceLibraryItemName: { type: 'string', description: 'Optional device-library item name to bind.', required: false },
    select: { type: 'boolean', description: 'Auto-select the new equipment (default true).', required: false },
  },
  execute: ({ name, type, deviceLibraryItemName, select }, ctx) => {
    const tier = String(type || '').toUpperCase() as 'LV' | 'MV' | 'HV';
    if (!['LV','MV','HV'].includes(tier)) return { ok: false, summary: 'type must be LV/MV/HV.' };
    if (!name) return { ok: false, summary: 'name is required.' };
    let libId: string | undefined;
    if (deviceLibraryItemName) {
      const lib = (ctx.projectData.deviceLibrary?.[tier] ?? []);
      const item = lib.find(d => d.name?.toLowerCase() === String(deviceLibraryItemName).toLowerCase());
      if (item) libId = item.id;
    }
    const newEq: Equipment = {
      id: `eq-${Date.now()}`,
      name: String(name),
      type: tier,
      properties: libId ? { deviceLibraryItemId: libId } : {},
      devices: [],
    };
    ctx.addEquipment(newEq);
    if (select !== false) ctx.setSelectedEquipment(newEq);
    return { ok: true, summary: `Added ${tier} equipment "${name}".`, data: { id: newEq.id } };
  },
};

const delete_equipment: ChatTool = {
  name: 'delete_equipment',
  description: 'Delete an equipment (and its rows). Reference by `name` (case-insensitive).',
  args: {
    name: { type: 'string', description: 'Equipment name.', required: true },
  },
  execute: ({ name }, ctx) => {
    const eq = (ctx.projectData.equipments ?? []).find(e => e.name?.toLowerCase() === String(name || '').toLowerCase());
    if (!eq) return { ok: false, summary: `Equipment "${name}" not found.` };
    ctx.deleteEquipment(eq.id);
    return { ok: true, summary: `Deleted equipment "${eq.name}".` };
  },
};

const select_equipment: ChatTool = {
  name: 'select_equipment',
  description: 'Set the active equipment (the one the Device Selection editor focuses on).',
  args: {
    name: { type: 'string', description: 'Equipment name (case-insensitive).', required: true },
  },
  execute: ({ name }, ctx) => {
    const eq = (ctx.projectData.equipments ?? []).find(e => e.name?.toLowerCase() === String(name || '').toLowerCase());
    if (!eq) return { ok: false, summary: `Equipment "${name}" not found.` };
    ctx.setSelectedEquipment(eq);
    return { ok: true, summary: `Active equipment: ${eq.name} (${eq.type}).` };
  },
};

const delete_row: ChatTool = {
  name: 'delete_row',
  description: 'Delete one row from an equipment by row number.',
  args: {
    rowNumber:     { type: 'number', description: '1-based row number.', required: true },
    equipmentName: { type: 'string', description: 'Optional — defaults to the selected equipment.', required: false },
  },
  execute: ({ rowNumber, equipmentName }, ctx) => {
    const eq = findEquipment(ctx, equipmentName);
    if (!eq) return { ok: false, summary: 'Equipment not found.' };
    const before = eq.devices.length;
    const next = (eq.devices || []).filter(r => r.rowNumber !== Number(rowNumber))
      .map((r, i) => ({ ...r, rowNumber: i + 1 }));
    if (next.length === before) return { ok: false, summary: `Row #${rowNumber} not found.` };
    ctx.updateEquipment(eq.id, { devices: next });
    return { ok: true, summary: `Deleted row #${rowNumber} from ${eq.name}.` };
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Templates (Create Template tab)
// ──────────────────────────────────────────────────────────────────────────
const search_templates: ChatTool = {
  name: 'search_templates',
  description: 'Substring-search templates by name and/or hierarchy path. Optionally restrict to a tier.',
  args: {
    query: { type: 'string',  description: 'Substring (case-insensitive).', required: false },
    type:  { type: 'string',  description: 'LV | MV | HV (optional filter).', required: false },
    limit: { type: 'number',  description: 'Max results (default 10).', required: false },
  },
  execute: ({ query, type, limit }, ctx) => {
    const q = String(query || '').toLowerCase().trim();
    const tiers: ('LV'|'MV'|'HV')[] = type ? [String(type).toUpperCase() as any] : ['LV', 'MV', 'HV'];
    const out: any[] = [];
    for (const tier of tiers) {
      for (const t of (ctx.projectData.templates?.[tier] ?? [])) {
        const hayName = (t.name || '').toLowerCase();
        const hayPath = (t.hierarchy?.path || []).join('/').toLowerCase();
        if (!q || hayName.includes(q) || hayPath.includes(q)) {
          out.push({
            id: t.id, name: t.name, type: t.type,
            hierarchy: t.hierarchy || null,
          });
        }
      }
    }
    const trimmed = out.slice(0, Number(limit) || 10);
    return { ok: true, summary: `${trimmed.length} of ${out.length} matching template(s).`, data: trimmed };
  },
};

const delete_template: ChatTool = {
  name: 'delete_template',
  description: 'Delete a template by id OR by name within a tier (case-insensitive).',
  args: {
    id:   { type: 'string', description: 'Template id (preferred).', required: false },
    type: { type: 'string', description: 'LV | MV | HV (required if using name).', required: false },
    name: { type: 'string', description: 'Template name (case-insensitive). Used if id is missing.', required: false },
  },
  execute: ({ id, type, name }, ctx) => {
    let templateId = id;
    if (!templateId) {
      const tier = String(type || '').toUpperCase() as 'LV'|'MV'|'HV';
      if (!['LV','MV','HV'].includes(tier)) return { ok: false, summary: 'type is required when looking up by name.' };
      const t = (ctx.projectData.templates?.[tier] ?? []).find(t => t.name?.toLowerCase() === String(name || '').toLowerCase());
      if (!t) return { ok: false, summary: `Template "${name}" not found in ${tier}.` };
      templateId = t.id;
    }
    ctx.deleteTemplate(templateId);
    return { ok: true, summary: `Deleted template ${templateId}.` };
  },
};

const set_template_property_parts: ChatTool = {
  name: 'set_template_property_parts',
  description: "Set or replace the `parts` list of one property on a template (e.g. CB ORDER, AMMETER, …). Use this to record which Siemens/EPLAN parts a template's slot uses.",
  args: {
    templateId: { type: 'string', description: 'Target template id.', required: true },
    property:   { type: 'string', description: "Property name (e.g. 'CB ORDER').", required: true },
    parts:      { type: 'array',  description: 'Array of {partNumber, label?, quantity?, priority?} objects.', required: true },
  },
  execute: ({ templateId, property, parts }, ctx) => {
    if (!Array.isArray(parts)) return { ok: false, summary: 'parts must be an array.' };
    const templates = ctx.projectData.templates || { LV: [], MV: [], HV: [] };
    let found: TemplateItem | null = null;
    let foundTier: 'LV' | 'MV' | 'HV' | null = null;
    for (const tier of ['LV','MV','HV'] as const) {
      const t = templates[tier].find(x => x.id === templateId);
      if (t) { found = t; foundTier = tier; break; }
    }
    if (!found || !foundTier) return { ok: false, summary: `Template ${templateId} not found.` };
    const props = JSON.parse(JSON.stringify(found.properties || {}));
    props[property] = {
      parts: parts.map((p: any, i: number) => ({
        partNumber: String(p.partNumber || ''),
        label:      String(p.label || ''),
        quantity:   typeof p.quantity === 'number' ? p.quantity : 1,
        priority:   typeof p.priority === 'number' ? p.priority : (i + 1),
      })),
    };
    const nextList = templates[foundTier].map(t =>
      t.id === templateId ? ({ ...t, properties: props } as TemplateItem) : t
    );
    ctx.updateProjectData({
      templates: { ...templates, [foundTier]: nextList },
    });
    return { ok: true, summary: `Set ${parts.length} part(s) on "${found.name}" → "${property}".` };
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Registry
// ──────────────────────────────────────────────────────────────────────────
const TOOLS: ChatTool[] = [
  // Navigation
  set_active_tab,
  // Project metadata + persistence
  set_project_fields, set_tech_setting, save_project,
  // Device library
  add_library_device, update_library_device, delete_library_device,
  // Equipment
  add_equipment, delete_equipment, select_equipment,
  // Templates
  create_template, delete_template, search_templates,
  find_similar_templates, set_template_property_parts,
  // Rows
  list_equipments, list_rows, update_row, bulk_update, add_row, delete_row,
  set_cell_color, set_row_color, apply_excel,
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
