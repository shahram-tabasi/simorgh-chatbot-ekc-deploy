// src/utils/tpmsImport.ts
//
// Turns the TPMS payload (everything Eplanix reads out of MySQL) into a patch
// for the open project. Pure — the dialog decides what to apply, this decides
// what each piece becomes:
//
//   payload.project      → project master data (OE number, name, planner…)
//   payload.techSettings → Technical Settings
//   payload.device       → a Device Library entry for the switchgear
//   payload.lines        → the switchgear in Device Selection, one row per line
//   line.parts           → a template per distinct part set, with the parts on it
//
// Nothing is deleted: importing the same switchgear again replaces that
// switchgear's rows and refreshes its library entry, and leaves every other
// piece of the project alone.
import {
  ProjectData, DeviceLibraryItem, Equipment, DeviceTableRow, TemplateItem,
} from '../types/project';
import { codeCase } from './deviceCodes';

export interface TpmsPart {
  slot: number;
  label: string;
  code: string;
  quantity: number;
  priority: number;
  ecode: string;
  /** The maker's code for the part — the order number. */
  scode: string;
  /** The maker itself, from the view's BRAND_DES ("برند"). */
  brand: string;
  secDes: string;
  engDes: string;
  shrDes: string;
}

export interface TpmsLine {
  draftId: number;
  ordering: number;
  busSection: string;
  feederNo: string;
  wiringType: string;
  ratingPower: string;
  flc: string;
  tag: string;
  description: string;
  moduleNo: string;
  size: string;
  sfdHfd: string;
  cableSize: string;
  cbRating: string;
  contactorRating: string;
  overloadRating: string;
  moduleType: string;
  templateName: string;
  parts: Record<string, TpmsPart[]>;
}

export interface TpmsPayload {
  success?: boolean;
  project: {
    projectMainId: number | null;
    oeNumber: string;
    projectName: string;
    projectNameFa: string;
    orderCategory: string;
    oeDate: string;
    projectExpert: string;
    technicalSupervisor: string;
    technicalExpert: string;
  };
  scope: {
    scopeId: number | null;
    scopeName: string;
    switchgearType: string;
    panelType: 'LV' | 'MV';
    cellCount: string;
    revision: number | null;
    tag: string;
  };
  techSettings: ProjectData['techSettings'];
  device: { name: string; type: 'LV' | 'MV' | 'HV'; properties: Record<string, any> };
  columnNames: Record<string, string>;
  slotProperties: Record<string, string>;
  lines: TpmsLine[];
  counts: { lines: number; parts: number; templates: number };
}

export interface TpmsImportOptions {
  projectData: boolean;
  techSettings: boolean;
  deviceLibrary: boolean;
  equipment: boolean;
}

export interface TpmsImportResult {
  patch: Partial<ProjectData>;
  /** Id of the equipment the import created or refreshed, for selecting it. */
  equipmentId?: string;
  summary: {
    templates: number;
    rows: number;
    parts: number;
    replacedEquipment: boolean;
    replacedTemplates: number;
  };
}

// One part as Create Template stores it. `fullData` mirrors an EPLAN record so
// the part reads the same everywhere — the exports and the template screen both
// go through getEplanixValue/formatPartEntry.
/**
 * A TPMS column heading, split into what the row is and who makes it.
 *
 * "VCB OR VC/FUSE (SIEMENS/SIBA)" → name "VCB OR VC/FUSE", brand "SIEMENS/SIBA"
 * "(KRIES)"                       → name "",               brand "KRIES"
 * "ACCESSORY"                     → name "ACCESSORY",      brand ""
 *
 * Only a trailing bracket counts, and only when it holds something that reads
 * as a maker rather than a rating: "CT RATING (5A)" is a column called
 * "CT RATING (5A)" and stripping it would be losing information, not tidying.
 */
export function splitColumnName(raw: string): { name: string; brand: string } {
  const whole = String(raw ?? '').trim();
  const m = /^(.*?)\(([^()]*)\)\s*$/.exec(whole);
  if (!m) return { name: whole, brand: '' };
  const inside = m[2].trim();
  // A maker is letters. Anything with a digit in it is a rating, a size or a
  // count, and belongs to the column's name.
  if (!inside || /\d/.test(inside)) return { name: whole, brand: '' };
  return { name: m[1].trim(), brand: inside };
}

function toTemplatePart(part: TpmsPart, columnBrand = '') {
  const brand = (part.brand || '').trim() || columnBrand.trim();
  const code = (part.code || '').trim();
  // For a good many TPMS parts the only thing recorded is the maker. The
  // EPLAN label that formatScode prefers is then a brand name — "Siemens",
  // "Kries", "Pfiffner" — and it was arriving as the part's order number, so
  // a column headed (SIEMENS/SIBA) read "Siemens" where a type should be.
  //
  // A brand is not an order number and must not read as one. When the code
  // TPMS gives is the brand, it is kept as the manufacturer and the order is
  // left empty; when TPMS has a real code it is untouched, so nothing that
  // does carry an order number loses it.
  const codeIsBrand = Boolean(brand) && code.toLowerCase() === brand.toLowerCase();
  const orderNumber = codeIsBrand ? '' : code;
  return {
    partNumber: orderNumber,
    label: part.label,
    quantity: part.quantity > 0 ? part.quantity : 1,
    priority: part.priority || 1,
    fullData: {
      PartNumber: orderNumber,
      OrderNumber: orderNumber,
      Designation1: part.secDes,
      Designation2: part.engDes,
      Designation3: part.shrDes,
      TypeNumber: part.ecode,
      // The part's maker, from the view's BRAND_DES ("برند"). This was hard
      // coded empty, which put the manufacturer nowhere and left it reading as
      // part of the order instead — CB ORDER showing a brand rather than the
      // order number it is supposed to carry.
      Manufacturer: brand || code,
      __tpms: { ecode: part.ecode, scode: part.scode, slot: part.slot },
    },
  };
}

// The signature of a line's part set — two lines with the same parts in the
// same slots share one template, which is how the drafts are actually drawn.
function templateSignature(line: TpmsLine, slotProperties: Record<string, string>): string {
  return Object.keys(line.parts)
    .map(Number)
    .sort((a, b) => a - b)
    .map(slot => {
      const name = slotProperties[String(slot)] || `SLOT ${slot}`;
      const parts = line.parts[String(slot)]
        .map(p => `${p.label}:${p.code}:${p.quantity}`)
        .join('|');
      return `${name}=${parts}`;
    })
    .join(';');
}

// A readable name for a template built from a line: what TPMS calls it, else
// the wiring type, else a number.
function templateNameFor(line: TpmsLine, index: number): string {
  return line.templateName || line.wiringType || `TPMS Template ${index + 1}`;
}

// Ids are derived from the switchgear rather than the clock, so importing the
// same switchgear twice lands on the same equipment, templates and rows —
// and two switchgears imported in the same millisecond can never collide.
const scopeKey = (scope: TpmsPayload['scope']) =>
  scope.scopeId != null
    ? String(scope.scopeId)
    : (scope.scopeName || 'scope').toLowerCase().replace(/[^a-z0-9]+/g, '-');

export function buildTpmsImport(
  projectData: ProjectData,
  payload: TpmsPayload,
  options: TpmsImportOptions,
): TpmsImportResult {
  const key = scopeKey(payload.scope);
  const tier = payload.scope.panelType;
  const patch: Partial<ProjectData> = {};
  const summary = { templates: 0, rows: 0, parts: 0, replacedEquipment: false, replacedTemplates: 0 };

  // ── Project master data ───────────────────────────────────────────────
  if (options.projectData) {
    patch.projectName = payload.project.projectName || projectData.projectName;
    patch.projectNumber = payload.project.oeNumber || projectData.projectNumber;
    patch.projectId = payload.project.projectMainId != null
      ? String(payload.project.projectMainId)
      : projectData.projectId;
    patch.planner = payload.project.projectExpert || projectData.planner;
    patch.designOffice = payload.project.technicalSupervisor || projectData.designOffice;
    if (payload.project.projectNameFa) {
      patch.projectDescription = payload.project.projectNameFa;
    }
  }

  if (options.techSettings && payload.techSettings) {
    // Merge section by section over what the project already has. TPMS does
    // not carry every field (wire manufacturer, for one), and a section left
    // out of the patch would otherwise arrive as undefined on screens that
    // read straight through it.
    const current = projectData.techSettings;
    const incoming = payload.techSettings as any;
    const merged: any = { ...(current ?? {}) };
    for (const section of Object.keys(incoming)) {
      merged[section] = { ...((current as any)?.[section] ?? {}), ...incoming[section] };
    }
    patch.techSettings = merged;
  }

  // ── Device Library entry for the switchgear ───────────────────────────
  const library = projectData.deviceLibrary ?? { LV: [], MV: [], HV: [] };
  let libraryItemId: string | undefined;

  if (options.deviceLibrary && payload.device?.name) {
    const existing = (library[tier] ?? []).find(d => d.name === payload.device.name);
    libraryItemId = existing?.id ?? `lib-tpms-${key}`;
    const item: DeviceLibraryItem = {
      id: libraryItemId,
      name: payload.device.name,
      type: tier,
      properties: { ...(existing?.properties ?? {}), ...payload.device.properties },
      source: 'tpms',
      ...(payload.scope.scopeId != null ? { tpmsScopeId: payload.scope.scopeId } : {}),
    };
    patch.deviceLibrary = {
      ...library,
      [tier]: existing
        ? (library[tier] ?? []).map(d => (d.id === existing.id ? item : d))
        : [...(library[tier] ?? []), item],
    };
  } else {
    libraryItemId = (library[tier] ?? []).find(d => d.name === payload.device?.name)?.id;
  }

  // ── Templates and the switchgear's rows ───────────────────────────────
  if (options.equipment) {
    const templates = { ...projectData.templates };
    const tierTemplates = [...(templates[tier] ?? [])];

    // Names TPMS gives the part columns for this project ride along as the
    // template's display names — but only the part of them that is a name.
    //
    // TPMS writes the maker into the column heading in brackets, so a project
    // arrives with columns called "VCB OR VC/FUSE (SIEMENS/SIBA)" and, more
    // often, just "(SIEMENS/SIBA)" with the row's real name left implied. Taken
    // at face value that heading *replaced* the row: the panel showed a row
    // headed "(SIEMENS/SIBA)" with "Siemens" underneath it, so the maker was
    // written twice and what the row was for was written nowhere.
    //
    // So the bracket comes off. What is left renames the row when it says
    // something; when nothing is left, the row keeps the name it already has.
    // The maker inside the bracket is not thrown away — it is the fallback for
    // parts that arrived without a brand of their own, which is where a maker
    // belongs.
    const displayNames: Record<string, string> = {};
    const slotBrands: Record<string, string> = {};
    for (const [slot, raw] of Object.entries(payload.columnNames ?? {})) {
      const property = payload.slotProperties[slot];
      if (!property || !raw) continue;
      const { name, brand } = splitColumnName(raw);
      if (name && name !== property) displayNames[property] = name;
      if (brand) slotBrands[slot] = brand;
    }

    // A template is "from TPMS" when it carries the marker, or (for imports
    // made before the marker existed) when it sits under the TPMS path.
    const belongsToScope = (t: TemplateItem) =>
      t.source === 'tpms' || t.hierarchy?.path?.[0] === 'TPMS';
    const isThisScope = (t: TemplateItem) =>
      belongsToScope(t) && (
        (payload.scope.scopeId != null && t.tpmsScopeId === payload.scope.scopeId) ||
        t.hierarchy?.path?.[1] === payload.scope.scopeName
      );

    const bySignature = new Map<string, TemplateItem>();
    const rows: DeviceTableRow[] = [];
    // Two lines can carry the same TPMS name with different parts; each part
    // set is its own template, so the second one onwards gets a suffix rather
    // than a second template with the same name.
    const namesUsed = new Map<string, number>();
    // A previous import's template is reused once, by the template that now
    // carries its name — never claimed twice.
    const claimed = new Set<string>();

    payload.lines.forEach((line, index) => {
      const signature = templateSignature(line, payload.slotProperties);
      let template = bySignature.get(signature);

      if (!template) {
        const properties: Record<string, any> = {};
        for (const [slot, parts] of Object.entries(line.parts)) {
          const property = payload.slotProperties[slot] || `SLOT ${slot}`;
          // The maker off the column heading stands in for a part that has
          // none of its own — that is what the heading was telling us, and it
          // is the one place the information is any use.
          properties[property] = { parts: parts.map(p => toTemplatePart(p, slotBrands[slot])) };
          summary.parts += parts.length;
        }
        if (Object.keys(displayNames).length > 0) properties.__displayNames = displayNames;

        // Another switchgear of the same project can use the same draft name
        // for a different part set; the second one carries its switchgear so
        // the two stay apart in the template list.
        let baseName = templateNameFor(line, bySignature.size);
        const takenByAnother = tierTemplates.some(
          t => t.name === baseName && belongsToScope(t) && !isThisScope(t),
        );
        if (takenByAnother) baseName = `${baseName} (${payload.scope.scopeName})`;
        const seen = namesUsed.get(baseName) ?? 0;
        namesUsed.set(baseName, seen + 1);
        const name = seen === 0 ? baseName : `${baseName} (${seen + 1})`;

        // Re-importing the same switchgear replaces the templates it made
        // before, matched by name within that switchgear, instead of piling up
        // duplicates — and never claims another switchgear's template.
        const previous = tierTemplates.find(
          t => t.name === name && !claimed.has(t.id) && isThisScope(t),
        );
        if (previous) claimed.add(previous.id);
        template = {
          id: previous?.id ?? `${tier}-tpms-${key}-${bySignature.size}`,
          name,
          type: tier,
          properties,
          hierarchy: { path: ['TPMS', payload.scope.scopeName], params: { notes: signature.slice(0, 200) } },
          source: 'tpms',
          ...(payload.scope.scopeId != null ? { tpmsScopeId: payload.scope.scopeId } : {}),
        } as TemplateItem;
        if (previous) summary.replacedTemplates += 1;
        bySignature.set(signature, template);
      }

      rows.push({
        id: `row-tpms-${key}-${index}`,
        rowNumber: index + 1,
        templateId: template.id,
        templateName: template.name,
        busSection: line.busSection,
        feederNo: codeCase(line.feederNo),
        wiringType: line.wiringType,
        ratingPower: line.ratingPower,
        flc: line.flc,
        tag: line.tag,
        description: line.description,
        moduleNo: line.moduleNo,
        size: line.size,
        sfdHfd: codeCase(line.sfdHfd),
        cableSize: line.cableSize,
        equipmentId: '',
      });
    });

    const built = [...bySignature.values()];
    summary.templates = built.length;
    summary.rows = rows.length;

    const keptTemplates = tierTemplates.filter(t => !built.some(b => b.id === t.id));
    templates[tier] = [...keptTemplates, ...built];
    patch.templates = templates;

    // The switchgear itself: refresh the one already imported under this
    // name, otherwise add it.
    const equipments = projectData.equipments ?? [];
    const existingEquipment = equipments.find(
      eq => eq.type === tier && eq.name === payload.scope.scopeName,
    );
    const equipmentId = existingEquipment?.id ?? `eq-tpms-${key}`;
    summary.replacedEquipment = !!existingEquipment;

    const equipment: Equipment = {
      id: equipmentId,
      name: payload.scope.scopeName,
      type: tier,
      power: '',
      description: payload.scope.switchgearType,
      properties: {
        ...(existingEquipment?.properties ?? {}),
        ...(libraryItemId ? { deviceLibraryItemId: libraryItemId } : {}),
        tpms: {
          projectMainId: payload.project.projectMainId,
          scopeId: payload.scope.scopeId,
          revision: payload.scope.revision,
          switchgearType: payload.scope.switchgearType,
          cellCount: payload.scope.cellCount,
          importedAt: new Date().toISOString(),
        },
      },
      devices: rows.map(row => ({ ...row, equipmentId })),
    };

    patch.equipments = existingEquipment
      ? equipments.map(eq => (eq.id === equipmentId ? equipment : eq))
      : [...equipments, equipment];

    return { patch, equipmentId, summary };
  }

  return { patch, summary };
}
