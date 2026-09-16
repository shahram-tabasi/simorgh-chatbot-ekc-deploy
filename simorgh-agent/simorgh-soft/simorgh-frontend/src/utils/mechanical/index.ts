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

export * from './catalog';
export { MECHANICAL_PARTS } from './parts';

const CATALOGS: MechanicalCatalog[] = [EK36_CATALOG, SIMOPRIMEA4_CATALOG];

const up = (v: unknown) => String(v ?? '').trim().toUpperCase();

/** A protection degree the sheets can test: IP41, IP42 — two digits, or null. */
function ipOf(value: unknown): number | null {
  const m = /IP\s*(\d{2})\b/i.exec(String(value ?? ''));
  return m ? Number(m[1]) : null;
}
const text = (v: unknown) => String(v ?? '').trim();

/**
 * Which sheet covers a panel type.
 *
 * Matched on a contained token rather than on equality, because a panel type
 * is written out in full on a project ("EK36 — 36 kV metal-clad", "AIS
 * SIMOPRIME A4 24kV") and the sheets are named for the family.
 */
export function catalogFor(panelType: string): MechanicalCatalog | null {
  const key = up(panelType).replace(/[^A-Z0-9]+/g, '');
  if (!key) return null;
  if (key.includes('EK36')) return EK36_CATALOG;
  if (key.includes('SIMOPRIME') || key.includes('A4')) return SIMOPRIMEA4_CATALOG;
  return CATALOGS.find(c => key.includes(up(c.panelType).replace(/[^A-Z0-9]+/g, ''))) ?? null;
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

  // The breaker on the cell, as the sheets read it: the order number of
  // whatever sits under a property whose name says breaker or contactor.
  const cb = parts.find(p => /breaker|vcb|contactor/i.test(p.property));
  const cbType = cb ? text(cb.part.partNumber) || text(cb.part.label) : '';

  // A VT is a property naming one, the same test the single line makes.
  const hasVt = parts.some(p => /voltage transformer|\bvt\b|\bpt\b/i.test(p.property));

  const labels = [
    text(row.tag), text(row.feederNo), text(row.sfdHfd),
    ...parts.map(p => text(p.property)),
  ].filter(Boolean);

  return cellContext({
    panelType: text(spec.type) || text(spec.panelType),
    size: cellTypeOf(template),
    cbType,
    cableSize: text(row.cableSize),
    magnetLabel: text(row.sfdHfd),
    ptStatus: hasVt ? 'YES' : 'NO',
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
    // QC1 / QC2 are earth-switch labels on the feeder in TPMS; here they are
    // whatever the project wrote as a tag or a template property.
    qc1: labels.some(l => /\bQC1\b/i.test(l)),
    qc2: labels.some(l => /\bQC2\b/i.test(l)),
    earthSwitch: labels.some(l => /earth/i.test(l)),
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
    return { context, equipment: [], note: 'no panel type on the Device Library entry' };
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
