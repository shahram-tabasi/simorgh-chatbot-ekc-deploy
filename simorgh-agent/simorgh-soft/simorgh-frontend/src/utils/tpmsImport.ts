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
import { type Tier, emptyTiers } from './tiers';

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
  device: { name: string; type: Tier; properties: Record<string, any> };
  columnNames: Record<string, string>;
  slotProperties: Record<string, string>;
  lines: TpmsLine[];
  counts: { lines: number; parts: number; templates: number };
  /**
   * What TPMS delivered for this switchgear when it was last read — the
   * common ancestor the merge below works against. See TpmsSyncState.baseline.
   */
  baseline?: {
    techSettings?: Record<string, Record<string, unknown>>;
    device?: Record<string, unknown>;
  };
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

// A name as an earlier read wrote it, without what that read added: a number
// — "FEEDER (3)" — or the switchgear's name in brackets. Used only to find the
// one template a name now has among the copies an earlier read made of it.
//
// Only those two: a bracket that is part of the name TPMS gave the line —
// "INCOMING G11&G22 (FROM BATTERY)" — is the name, and is kept.
export function legacyBaseName(name: string, scopeNames: ReadonlySet<string>): string {
  let base = name.replace(/ \(\d+\)$/, '');
  for (;;) {
    const m = / \(([^()]*)\)$/.exec(base);
    if (!m || !scopeNames.has(m[1])) return base;
    base = base.slice(0, m.index);
  }
}

// A template id from its name: stable across reads, one per name. The hash
// keeps two names that read alike once simplified ("A&B", "A B") apart.
const nameKey = (name: string) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'template';
  return `${slug}-${(h >>> 0).toString(36)}`;
};

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

/**
 * Three-way merge of one flat record.
 *
 * `mine` is what the project holds now: TPMS's last word plus whatever the
 * engineer has typed over it. `theirs` is what TPMS says today, `base` what it
 * said when this was last read. A field TPMS has changed since then comes
 * across — that is the whole point of reading again. A field it has *not*
 * changed is left exactly as the engineer left it, because overwriting it with
 * a value that never moved only ever destroys work.
 *
 * With no base — the first read, or a project imported before baselines were
 * kept — TPMS wins outright, which is what this always used to do.
 */
export function mergeOverEdits<T extends Record<string, any>>(mine: T, theirs: T, base?: T): T {
  if (!base) return { ...mine, ...theirs };
  const out: Record<string, any> = { ...mine };
  for (const [key, value] of Object.entries(theirs)) {
    const movedInTpms = JSON.stringify(value ?? null) !== JSON.stringify(base[key] ?? null);
    if (movedInTpms || !(key in out)) out[key] = value;
  }
  return out as T;
}

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
    const settingsBase = payload.baseline?.techSettings;
    for (const section of Object.keys(incoming)) {
      merged[section] = mergeOverEdits(
        ((current as any)?.[section] ?? {}) as Record<string, any>,
        (incoming[section] ?? {}) as Record<string, any>,
        settingsBase?.[section] as Record<string, any> | undefined,
      );
    }
    patch.techSettings = merged;
  }

  // ── Device Library entry for the switchgear ───────────────────────────
  const library = projectData.deviceLibrary ?? emptyTiers();
  let libraryItemId: string | undefined;

  if (options.deviceLibrary && payload.device?.name) {
    // The panel is found by its TPMS id first. By name alone, two panels TPMS
    // keeps apart but calls the same folded into one entry, and every panel
    // after the first overwrote it.
    const scopeId = payload.scope.scopeId;
    const existing =
      (scopeId != null ? (library[tier] ?? []).find(d => d.tpmsScopeId === scopeId) : undefined)
      ?? (library[tier] ?? []).find(d =>
        d.name === payload.device.name && (scopeId == null || d.tpmsScopeId == null));
    libraryItemId = existing?.id ?? `lib-tpms-${key}`;
    const item: DeviceLibraryItem = {
      id: libraryItemId,
      name: payload.device.name,
      type: tier,
      properties: mergeOverEdits(
        (existing?.properties ?? {}) as Record<string, any>,
        (payload.device.properties ?? {}) as Record<string, any>,
        payload.baseline?.device as Record<string, any> | undefined,
      ) as DeviceLibraryItem['properties'],
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
    // The headings exactly as TPMS writes them, brand and all — what Eplanix
    // puts in the EPLAN table's header (FormatHeader / FormatDualInfo).
    const columnNames: Record<string, string> = {};
    for (const [slot, raw] of Object.entries(payload.columnNames ?? {})) {
      const property = payload.slotProperties[slot];
      if (!property || !raw) continue;
      columnNames[property] = String(raw);
      const { name, brand } = splitColumnName(raw);
      if (name && name !== property) displayNames[property] = name;
      if (brand) slotBrands[slot] = brand;
    }

    // A template is "from TPMS" when it carries the marker, or (for imports
    // made before the marker existed) when it sits under the TPMS path.
    const fromTpms = (t: TemplateItem) =>
      t.source === 'tpms' || t.hierarchy?.path?.[0] === 'TPMS';

    // One name, one template. TPMS names a line after the kind of cell it is,
    // and the same kind of cell in two switchgears is the same template: it is
    // listed once, and the rows of every switchgear that uses it point at it.
    // Nothing is numbered and nothing carries a switchgear's name.
    const byName = new Map<string, TemplateItem>();
    const rows: DeviceTableRow[] = [];
    const scopeId = payload.scope.scopeId;

    payload.lines.forEach((line, index) => {
      const name = templateNameFor(line, byName.size);
      let template = byName.get(name);

      if (!template) {
        const signature = templateSignature(line, payload.slotProperties);
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
        if (Object.keys(columnNames).length > 0) properties.__columnNames = columnNames;

        // The template this name already has, from this switchgear or any
        // other: by the TPMS name it carries (it survives the engineer
        // renaming it), then by its own name, then — for a project read before
        // names were kept — by its name without the number or switchgear an
        // earlier read added to it.
        const previous =
          tierTemplates.find(t => fromTpms(t) && t.tpmsName === name)
          ?? tierTemplates.find(t => fromTpms(t) && t.name === name)
          ?? tierTemplates.find(t => fromTpms(t) && !t.tpmsName
            && legacyBaseName(t.name, new Set([payload.scope.scopeName])) === name);

        // A template the engineer has filed somewhere — moved out of BPMS
        // into OFW, FIX or an MV section — keeps its place and its name. Only
        // its parts are TPMS's to refresh.
        const filed = !!previous && previous.hierarchy?.path?.[0] !== undefined
          && previous.hierarchy.path[0] !== 'TPMS';

        // Every switchgear that uses it, so it goes only when all of them have.
        const usedBy = new Set<number>([
          ...(previous?.tpmsScopeIds ?? (previous?.tpmsScopeId != null ? [previous.tpmsScopeId] : [])),
          ...(scopeId != null ? [scopeId] : []),
        ]);

        const { tpmsScopeId: _single, ...kept } = (previous ?? {}) as TemplateItem;
        template = {
          ...kept,
          id: previous?.id ?? `${tier}-tpms-${nameKey(name)}`,
          name: filed ? previous!.name : name,
          type: tier,
          properties,
          hierarchy: filed ? previous!.hierarchy : { path: ['TPMS'] },
          source: 'tpms',
          tpmsName: name,
          tpmsSignature: signature,
          tpmsScopeIds: [...usedBy],
        } as TemplateItem;
        if (previous) summary.replacedTemplates += 1;
        byName.set(name, template);
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
        cbRating: line.cbRating,
        contactorRating: line.contactorRating,
        overloadRating: line.overloadRating,
        equipmentId: '',
      });
    });

    const built = [...byName.values()];
    summary.templates = built.length;
    summary.rows = rows.length;

    const keptTemplates = tierTemplates.filter(t => !built.some(b => b.id === t.id));
    templates[tier] = [...keptTemplates, ...built];
    patch.templates = templates;

    // The switchgear itself: refresh the one already imported under this
    // name, otherwise add it.
    const equipments = projectData.equipments ?? [];
    // By TPMS id first, for the same reason as the library entry above; by
    // name for a switchgear imported before the id was kept.
    const tpmsIdOf = (eq: Equipment) => (eq.properties as any)?.tpms?.scopeId;
    const existingEquipment =
      (payload.scope.scopeId != null
        ? equipments.find(eq => tpmsIdOf(eq) === payload.scope.scopeId)
        : undefined)
      ?? equipments.find(eq =>
        eq.type === tier && eq.name === payload.scope.scopeName
        && (payload.scope.scopeId == null || tpmsIdOf(eq) == null));
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
      // The rows TPMS owns are replaced wholesale — that is how a line
      // changed there arrives here. Rows the engineer added in Device
      // Selection carry no TPMS id, are nobody's business but theirs, and
      // stay.
      devices: [
        ...rows.map(row => ({ ...row, equipmentId })),
        ...(existingEquipment?.devices ?? []).filter(d => !String(d.id).startsWith('row-tpms-')),
      ],
    };

    patch.equipments = existingEquipment
      ? equipments.map(eq => (eq.id === equipmentId ? equipment : eq))
      : [...equipments, equipment];

    return { patch, equipmentId, summary };
  }

  return { patch, summary };
}
