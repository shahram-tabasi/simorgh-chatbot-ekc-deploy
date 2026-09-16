// src/utils/mechanical/index.ts
//
// The estimate sheets, and this project's way in to them.
//
// `catalog.ts` is the mechanism; `ek36.ts` and `simoprimeA4.ts` are the two
// sheets. What is here is the join: turning one feeder of a Simorgh project
// into the context those rules read, which is the one part that could not be
// ported because the two apps hold their facts in different places.
//
// Where Eplanix queries TPMS per draft id — CB type, CT current, Ronis
// labels, pole centre — this project already states the same facts in Device
// Selection and the Device Library, and that is where they are read from. A
// fact the project does not hold is left null rather than guessed: a null
// simply fails the conditions that name it, which is the sheets' own
// behaviour for a cell whose current nobody stated.

import { ProjectData, Equipment, DeviceTableRow, TemplateItem } from '../../types/project';
import {
  MechanicalCatalog, MechanicalCellContext, MechanicalEquipment,
  buildFromCatalog, cellContext,
} from './catalog';
import { EK36_CATALOG } from './ek36';
import { SIMOPRIMEA4_CATALOG } from './simoprimeA4';
import { templateFacts } from './template';

export * from './catalog';
export * from './template';
export { MECHANICAL_PARTS } from './parts';

const CATALOGS: MechanicalCatalog[] = [EK36_CATALOG, SIMOPRIMEA4_CATALOG];


/** A protection degree the sheets can test: IP41, IP42 — two digits, or null. */
function ipOf(value: unknown): number | null {
  const m = /IP\s*(\d{2})\b/i.exec(String(value ?? ''));
  return m ? Number(m[1]) : null;
}
const text = (v: unknown) => String(v ?? '').trim();

/**
 * Which sheet covers a panel type.
 *
 * Matched on the family name inside the text rather than on equality, because
 * nobody writes the panel type on its own: it arrives as a switchgear name
 * ("B.B.1 Switchgear, 36KV, 2000A, 25KA/3S, EK36"), as a TPMS switchgear type,
 * or as a Device Library entry's name.
 *
 * On word boundaries, and never on stripped text. "A4" is a real product name
 * and also what "400A" and "4 cells" collapse to when the punctuation between
 * them is thrown away — matching that would hand a switchgear the wrong
 * estimate sheet and fill a bill of materials with the wrong parts.
 */
export function catalogFor(panelType: string): MechanicalCatalog | null {
  const s = String(panelType ?? '');
  if (!s.trim()) return null;
  if (/\bEK\s*-?\s*36\b/i.test(s)) return EK36_CATALOG;
  if (/SIMOPRIME/i.test(s) || /\bA4\b/i.test(s)) return SIMOPRIMEA4_CATALOG;
  return null;
}

/**
 * Everything this project says about what kind of panel a switchgear is.
 *
 * There is no one field for it — `DeviceLibraryProperties` has no panel type
 * at all — so every place it is actually written gets a look: TPMS's own
 * switchgear type first, because that is the field TPMS fills for exactly
 * this, then the description it is copied to, then the names, which in this
 * office's naming carry the family at the end.
 */
export function panelTypeOf(data: ProjectData, equipment: Equipment): string {
  const library = data.deviceLibrary?.[equipment.type] ?? [];
  const entry = library.find(d => d.id === equipment.properties?.deviceLibraryItemId)
    ?? library.find(d => d.name === equipment.name);
  const candidates = [
    text(equipment.properties?.tpms?.switchgearType),
    text(equipment.description),
    text(equipment.name),
    text(entry?.name),
  ].filter(Boolean);
  // The first one a sheet recognises, so a name that happens to mention a
  // family the office does not have a sheet for does not win over one it does.
  return candidates.find(c => catalogFor(c)) ?? candidates[0] ?? '';
}

/** Every panel type an estimate sheet covers, for telling someone what is missing. */
export const CATALOG_PANEL_TYPES = CATALOGS.map(c => c.panelType);

/**
 * The cell type of a feeder — what selects its basket.
 *
 * It is the first node of the template's own hierarchy path, which this app
 * already asks for when a template is authored and which uses the same words
 * the sheets do: Feeder Truck, Riser Connection, Metering, Incoming VT Cell.
 * The one place the two part company is the disconnector link, where the
 * sheet names the fuse in the cell type and this app keeps it as a sub-type,
 * so the two nodes are joined back together here.
 */
export function cellTypeOf(template: TemplateItem | undefined): string {
  const path = template?.hierarchy?.path ?? [];
  const head = text(path[0]);
  if (!head) return '';
  const sub = text(path[1]);
  if (/^disconnector link$/i.test(head)) {
    if (/without fuse/i.test(sub)) return 'Disconnector Link wo Fuse';
    if (/with fuse/i.test(sub)) return 'Disconnector Link w Fuse';
    return head;
  }
  return head;
}

/** The context one feeder is read with. */
export function contextOf(
  data: ProjectData, equipment: Equipment, row: DeviceTableRow,
  template: TemplateItem | undefined,
): MechanicalCellContext {
  const library = data.deviceLibrary?.[equipment.type] ?? [];
  const spec = (library.find(d => d.id === equipment.properties?.deviceLibraryItemId)?.properties
    ?? library.find(d => d.name === equipment.name)?.properties ?? {}) as Record<string, unknown>;

  const parts = Object.entries((template?.properties ?? {}) as Record<string, unknown>)
    .filter(([k]) => k !== '__displayNames' && k !== '__locked')
    .flatMap(([property, value]) => {
      const list = (value as { parts?: unknown[] })?.parts;
      return Array.isArray(list) ? list.map(p => ({ property, part: p as Record<string, unknown> })) : [];
    });

  // Breaker, VT and CT are read from the template's own columns rather than
  // guessed from property names — the column for each is named per tier in
  // `template.ts`, and an empty column means the cell has not got one. The
  // guess this replaces could not work on LV, where the breaker column is
  // "CB ORDER": nothing in it says "breaker", and the only property that did
  // say so was the contactor.
  const facts = templateFacts(template, template?.type ?? equipment.type ?? 'MV');

  const labels = [
    text(row.tag), text(row.feederNo), text(row.sfdHfd),
    ...parts.map(p => text(p.property)),
  ].filter(Boolean);

  return cellContext({
    panelType: panelTypeOf(data, equipment),
    size: cellTypeOf(template),
    cbType: facts.hasBreaker.value ? facts.breakerType.value : '',
    cableSize: text(row.cableSize),
    // The magnet label is answered on the template, because no column states
    // it; until one is answered the feeder's own SFD/HFD stands in, which is
    // where this office writes it today.
    magnetLabel: facts.magnetLabel || text(row.sfdHfd),
    ptStatus: facts.hasVt.value ? 'YES' : 'NO',
    description: text(row.description),
    // Rated current: the feeder's own FLC, else the rating in its power column.
    cbCurrent: Number(String(row.flc).replace(/[^\d.]/g, '')) > 0
      ? Number(String(row.flc).replace(/[^\d.]/g, ''))
      : Number(String(row.ratingPower).replace(/[^\d.]/g, '')) || null,
    panelWidth: Number(String(spec.width ?? '').replace(/[^\d.]/g, '')) || null,
    // Two digits or nothing. "IP4X" is a real entry and it is not IP41: the
    // sheets' rules name IP41 and IP42 exactly, and reading the 4 out of IP4X
    // would fire a rule the panel never satisfied.
    ip: ipOf(spec.ip),
    // QC1 / QC2 are the cable and bus earth switches. Answered on the
    // template, because no column states them; a QC1 or QC2 written on the
    // feeder still counts, so a project that labels them the old way keeps
    // working without anybody re-answering it.
    qc1: facts.cableEarthSwitch || labels.some(l => /\bQC1\b/i.test(l)),
    qc2: facts.busEarthSwitch || labels.some(l => /\bQC2\b/i.test(l)),
    earthSwitch: facts.cableEarthSwitch || facts.busEarthSwitch
      || labels.some(l => /earth/i.test(l)),
    labels,
  });
}

/** What one feeder needs, and why it needs nothing when it needs nothing. */
export interface CellEstimate {
  context: MechanicalCellContext;
  equipment: MechanicalEquipment[];
  /** Absent when items were produced; otherwise what stopped them. */
  note?: string;
}

/** The estimate for one feeder, read through the sheet its panel type has. */
export function estimateFor(
  data: ProjectData, equipment: Equipment, row: DeviceTableRow,
  template: TemplateItem | undefined,
): CellEstimate {
  const context = contextOf(data, equipment, row, template);
  if (!context.panelType) {
    return {
      context, equipment: [],
      note: 'no panel type on this switchgear — it is read from the TPMS switchgear '
          + 'type, the description, or the name',
    };
  }
  const catalog = catalogFor(context.panelType);
  if (!catalog) {
    return {
      context, equipment: [],
      note: `no estimate sheet for "${context.panelType}" — there are sheets for `
          + CATALOG_PANEL_TYPES.join(' and '),
    };
  }
  if (!context.size) {
    return { context, equipment: [], note: 'the template has no cell type' };
  }
  const built = buildFromCatalog(catalog, context);
  return built.length > 0
    ? { context, equipment: built }
    : { context, equipment: [], note: `the ${catalog.panelType} sheet has no basket for cell type "${context.size}"` };
}
