// src/utils/mechanical/index.ts
//
// The estimate sheets, and this project's way in to them.
//
// `catalog.ts` is the mechanism; `ek36.ts` and `simoprimeA4.ts` are the two
// sheets. What is here is the join: turning one feeder of a Simorgh project
// into the context those rules read.
//
// That description of a feeder is not built here. It is built in
// `utils/outline`, which is the port of Eplanix's `OutlineService` — the same
// routine that produces the outline drawing's own fields. Both halves of Send
// to EPLAN are answers about the same cell, and in Eplanix they come from one
// `BuildFeederDataAsync`; they come from one `buildOutline` here for the same
// reason. Reading the breaker off the part labelled Q while the outline reads
// it off another is how a mechanical report and a drawing of the same panel
// come to disagree.
//
// So this file is now the mapping and nothing else: `MechanicalItemContext.Create`,
// argument for argument, from a feeder the outline has already described.

import { ProjectData, Equipment, DeviceTableRow, TemplateItem } from '../../types/project';
import {
  MechanicalCatalog, MechanicalCellContext, MechanicalEquipment,
  buildFromCatalog, cellContext,
} from './catalog';
import { EK36_CATALOG } from './ek36';
import { SIMOPRIMEA4_CATALOG } from './simoprimeA4';
import { templateFacts } from './template';
import {
  FeederOutline, buildOutline, cellTypeOf, panelTypeOf, extractInt,
} from '../outline';

export * from './catalog';
export * from './template';
export { MECHANICAL_PARTS } from './parts';
// The outline is where a feeder is described; these are re-exported so a
// caller that only wants the estimate does not have to know that.
export { cellTypeOf, panelTypeOf };
export type { FeederOutline };

const CATALOGS: MechanicalCatalog[] = [EK36_CATALOG, SIMOPRIMEA4_CATALOG];

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

/** Every panel type an estimate sheet covers, for telling someone what is missing. */
export const CATALOG_PANEL_TYPES = CATALOGS.map(c => c.panelType);

/**
 * The context one feeder is read with — `MechanicalItemContext.Create`.
 *
 * Every argument comes from the same place the original takes it from, and
 * the two that are not simply read are the two that are not simply written
 * down anywhere:
 *
 *   **The cell's rated current.** For a 3AE5 it is the breaker's own, decoded
 *   out of its order code; otherwise the CT's primary current, and only then
 *   the FLC. The contact-finger quantities are counted against it.
 *
 *   **The panel width.** Not the cabinet's width from the library — the cell's
 *   own, which the outline works out from the pole centre, the wiring type and
 *   the panel family. The A4 sheet's quantities are written against it.
 *
 * The earth switch and the magnet label are read from the parts on the feeder,
 * as the original reads them off its equipment list; a template that answers
 * them by hand (see `template.ts`) still overrules that, because a project
 * built here rather than imported has no such parts to read.
 */
export function contextFor(feeder: FeederOutline, template?: TemplateItem): MechanicalCellContext {
  const answered = templateFacts(template, (template?.type ?? 'MV'));
  return cellContext({
    panelType: feeder.planeType,
    size: feeder.size,
    cbType: feeder.cbType === 'N/A' ? '' : feeder.cbType,
    cableSize: feeder.cableSize,
    magnetLabel: feeder.magnetLabel !== 'N/A' ? feeder.magnetLabel
      : (answered.magnetLabel || text(feeder.row.sfdHfd)),
    ptStatus: feeder.ptStatus,
    description: feeder.designation,
    cbCurrent: feeder.cellCurrent,
    panelWidth: extractInt(feeder.panelWidth),
    // "IP4X" is a real entry and it is not IP41: the sheets name IP41 and
    // IP42 exactly, and reading the 4 out of IP4X fires a rule the panel
    // never satisfied.
    ip: (() => {
      const m = /IP\s*(\d{2})\b/i.exec(feeder.panelIp);
      return m ? Number(m[1]) : null;
    })(),
    qc1: feeder.qc1 || answered.cableEarthSwitch,
    qc2: feeder.qc2 || answered.busEarthSwitch,
    earthSwitch: feeder.earthSwitch || answered.cableEarthSwitch || answered.busEarthSwitch,
    labels: feeder.labels,
  });
}

/**
 * The same, for a caller that has a row rather than a described feeder.
 *
 * It describes the whole switchgear to answer for one row of it — the width
 * rules ask a riser what the coupling of the same panel carries — so a caller
 * with more than one row to read should call `estimatesFor` instead and get
 * them all from one pass.
 */
export function contextOf(
  data: ProjectData, equipment: Equipment, row: DeviceTableRow,
  template: TemplateItem | undefined,
): MechanicalCellContext {
  const outline = buildOutline(data, equipment);
  const feeder = outline.feeders.find(f => f.row.id === row.id) ?? outline.feeders[0];
  return feeder
    ? contextFor(feeder, template)
    : cellContext({ panelType: panelTypeOf(data, equipment) });
}

/** What one feeder needs, and why it needs nothing when it needs nothing. */
export interface CellEstimate {
  context: MechanicalCellContext;
  equipment: MechanicalEquipment[];
  /** Absent when items were produced; otherwise what stopped them. */
  note?: string;
}

/** The estimate a context produces, or why it produces nothing. */
export function estimateFromContext(context: MechanicalCellContext): CellEstimate {
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
    : {
        context, equipment: [],
        note: `the ${catalog.panelType} sheet has no basket for cell type "${context.size}"`,
      };
}

/** One feeder's estimate, and the description it was read from. */
export interface FeederEstimate extends CellEstimate {
  feeder: FeederOutline;
}

/**
 * Every feeder of a switchgear, described once and estimated from that.
 *
 * This is the call a report wants: the width rules ask a riser what the
 * coupling of the same panel carries, so describing the switchgear once and
 * reading every cell off it is both cheaper and the only way the answers agree
 * with each other.
 */
export function estimatesFor(
  data: ProjectData, equipment: Equipment, options: { lvCompartmentHeight?: string } = {},
): FeederEstimate[] {
  const templates = new Map(
    (data.templates?.[equipment.type] ?? []).map(t => [t.id, t as TemplateItem]));
  return buildOutline(data, equipment, options).feeders.map(feeder => ({
    feeder,
    ...estimateFromContext(contextFor(feeder, templates.get(feeder.row.templateId ?? ''))),
  }));
}

/** The estimate for one feeder, read through the sheet its panel type has. */
export function estimateFor(
  data: ProjectData, equipment: Equipment, row: DeviceTableRow,
  template: TemplateItem | undefined,
): CellEstimate {
  return estimateFromContext(contextOf(data, equipment, row, template));
}
