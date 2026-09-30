// src/utils/mechanical/catalog.ts
//
// How many of what a cell needs — the office's estimate sheets, as rules.
//
// This is the mechanism the Eplanix MVC app runs behind its "Export
// Mechanical Excel" button, and the reason that button goes through a routine
// instead of reading a table: **the items are not stored anywhere.** Nobody
// types "this cell needs 5 post insulators". The sheet says a Riser gets 3
// post insulators and 3 capacitive dividers, that a cell with a breaker also
// picks up the VCB truck basket, and that the contact fingers depend on the
// rated current — and the bill of materials is what falls out of walking
// those rules against one cell's facts.
//
// So there are three pieces, the same three the original has:
//
//   **A context** — the facts about one cell the rules are written against:
//   its cell type, whether it carries a breaker or a VT, its width, its IP,
//   its rated current, its labels.
//
//   **Baskets** — "Subcategory Identification Method" on the sheet. A cell
//   type picks up its own basket unconditionally, and picks up further ones
//   when a condition holds ("Feeder Truck & VCB" → the VCB truck basket).
//
//   **Quantities** — what each basket consists of, some of them conditional
//   ("9 (IP42/W1000), 8 (IP42/W800)" is two entries, one condition each).
//
// Building the bill is walking the baskets in sheet order and emitting the
// quantities whose conditions hold. Nothing here is a guess: a cell type no
// sheet covers produces no items, and says so, rather than being filled in.

import { MECHANICAL_PARTS, MechanicalPartId } from './parts';

/** One "Number of Mechanical Items" column across the estimate sheets. */
export type MechanicalItemGroup =
  | 'FeederTruck' | 'CouplingTruck' | 'Riser' | 'MeteringRiser'
  | 'RiserConnection' | 'MeteringRiserConnection' | 'Metering' | 'IncomingVtCell'
  | 'DisconnectorLinkWithoutFuse' | 'Dummy' | 'CellsWithCapacitiveIsolatorsWithoutCt'
  | 'SupportInsteadOfCt' | 'VcbTruck' | 'MeteringTruck' | 'IncomingVtCellTruck'
  | 'DLinkWithoutFuseTruck' | 'RearVtTruck' | 'CableEarthSwitch'
  | 'BusEarthTruck' | 'BusEarthSwitch' | 'RearFixVt';

/**
 * The facts about one cell the sheets' conditions are written against.
 *
 * Text fields arrive normalised — trimmed and upper-cased — because the sheet
 * rules compare them exactly, and a cell type typed as "feeder truck" is the
 * same cell type.
 */
export interface MechanicalCellContext {
  /** Panel type: EK36, AIS-SIMOPRIME-A4. Chooses the sheet. */
  panelType: string;
  /** Cell type. This is what selects a base basket. */
  size: string;
  cbType: string;
  cableSize: string;
  magnetLabel: string;
  /** "YES" when the cell carries a voltage transformer. */
  ptStatus: string;
  description: string;
  /** Rated current of the cell in A — the contact-finger rules read it. */
  cbCurrent: number | null;
  /** Panel width in mm — the A4 width rules read it. */
  panelWidth: number | null;
  /** Protection degree as a number: 41 for IP41, 42 for IP42. */
  ip: number | null;
  qc1: boolean;
  qc2: boolean;
  earthSwitch: boolean;
  /** Equipment labels on the cell, upper-cased (F01, MB3, QC1…). */
  labels: string[];
}

const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
const firstNumber = (v: unknown): number | null => {
  const m = /\d+/.exec(String(v ?? ''));
  return m ? Number(m[0]) : null;
};

/** A context with every field normalised the way the rules expect. */
export function cellContext(raw: Partial<MechanicalCellContext> & { panelType?: string }): MechanicalCellContext {
  return {
    panelType: up(raw.panelType),
    size: up(raw.size),
    cbType: up(raw.cbType),
    cableSize: up(raw.cableSize),
    magnetLabel: up(raw.magnetLabel),
    ptStatus: up(raw.ptStatus),
    description: String(raw.description ?? '').trim(),
    cbCurrent: raw.cbCurrent ?? null,
    panelWidth: raw.panelWidth ?? firstNumber(raw.panelWidth),
    ip: raw.ip ?? null,
    qc1: raw.qc1 === true,
    qc2: raw.qc2 === true,
    earthSwitch: raw.earthSwitch === true,
    labels: [...new Set((raw.labels ?? []).map(up).filter(Boolean))],
  };
}

const hasVt = (c: MechanicalCellContext) => c.ptStatus === 'YES';
const hasCb = (c: MechanicalCellContext) => c.cbType.length > 0 && c.cbType !== 'N/A';

export type Condition = (context: MechanicalCellContext) => boolean;

/**
 * The conditions the sheets attach to a basket or a quantity, as named
 * predicates — a cell like "6 (W: 800)" is `When.panelWidth(800)`, and an
 * identification method like "(Feeder Truck) & VCB" is a basket over that
 * size guarded by `When.vcb`.
 */
export const When = {
  /** "& VCB" / "& CB": the cell carries a circuit breaker. */
  vcb: hasCb as Condition,
  /** "& VT": the cell carries a voltage transformer. */
  vt: hasVt as Condition,
  /** "& QC1". */
  qc1: ((c) => c.qc1) as Condition,
  /** "& QC2". */
  qc2: ((c) => c.qc2) as Condition,
  /** The sheets' bare "& QC", which is the cable earth switch's QC1. */
  qc: ((c) => c.qc1) as Condition,
  /** Cable earth switch: an earthing switch, or a QC1 label. */
  earthSwitchOrQc: ((c) => c.earthSwitch || c.qc1) as Condition,
  /** The cell carries one of these magnet labels (MB3 / MB4). */
  magnetLabel: (...labels: string[]): Condition =>
    c => labels.some(l => up(l) === c.magnetLabel),
  /** The cell carries any one of these equipment labels. */
  anyLabel: (labels: string[]): Condition =>
    c => labels.some(l => c.labels.includes(up(l))),
  /** "(W: 800)" / "(W: 1000)": the panel is this wide, in mm. */
  panelWidth: (mm: number): Condition => c => c.panelWidth === mm,
  /** "(IP42/W1000)": this protection degree at this panel width. */
  ipAndWidth: (ip: number, mm: number): Condition =>
    c => c.ip === ip && c.panelWidth === mm,
  /** "(3AE5)": the breaker type contains this token. */
  cbType: (token: string): Condition => c => c.cbType.includes(up(token)),
  /** "(3AH5+VT)": this breaker type, and the cell carries a VT. */
  cbTypeWithVt: (token: string): Condition =>
    c => c.cbType.includes(up(token)) && hasVt(c),
  /** "If CB Current <= 1250A". A cell with no known current matches nothing. */
  cbCurrentAtMost: (amperes: number): Condition =>
    c => c.cbCurrent != null && c.cbCurrent > 0 && c.cbCurrent <= amperes,
  /** "If CB Current > 1250A". */
  cbCurrentAbove: (amperes: number): Condition =>
    c => c.cbCurrent != null && c.cbCurrent > amperes,
};

/** One "Subcategory Identification Method": a basket, its cell types, its condition. */
export interface BasketRule {
  group: MechanicalItemGroup;
  /** Cell types that select this basket. */
  sizes: string[];
  /** Absent on a base basket, which needs nothing beyond the cell type. */
  when?: Condition;
}

/** One cell of a sheet: how many of a part a basket needs, and when. */
export interface ItemQuantity {
  part: MechanicalPartId;
  /** May be negative: a delta basket can remove what a base basket added. */
  quantity: number;
  when?: Condition;
}

export interface MechanicalCatalog {
  panelType: string;
  baskets: BasketRule[];
  itemsByGroup: Partial<Record<MechanicalItemGroup, ItemQuantity[]>>;
}

/** One line of the bill of materials. */
export interface MechanicalEquipment {
  /** The office's own HR code. */
  hr: string;
  /** The manufacturer's order number. */
  manufacture: string;
  ekc: string;
  description: string;
  quantity: number;
  /** Which basket emitted it, so the report can say where a number came from. */
  group: MechanicalItemGroup;
}

/**
 * The mechanical items one cell needs, in sheet order.
 *
 * Quantities of the same part from different baskets are added rather than
 * listed twice — a delta basket's negative quantity is how the sheets take
 * something back, and it only works if the two meet.
 */
export function buildFromCatalog(
  catalog: MechanicalCatalog, context: MechanicalCellContext,
): MechanicalEquipment[] {
  const out: MechanicalEquipment[] = [];
  const at = new Map<string, MechanicalEquipment>();

  for (const basket of catalog.baskets) {
    if (!basket.sizes.some(s => up(s) === context.size)) continue;
    if (basket.when && !basket.when(context)) continue;

    for (const item of catalog.itemsByGroup[basket.group] ?? []) {
      if (item.when && !item.when(context)) continue;
      const had = at.get(item.part);
      if (had) { had.quantity += item.quantity; continue; }
      const def = MECHANICAL_PARTS[item.part];
      const line: MechanicalEquipment = {
        hr: def.hr, manufacture: def.manufacture, ekc: def.ekc,
        description: def.description, quantity: item.quantity, group: basket.group,
      };
      at.set(item.part, line);
      out.push(line);
    }
  }
  // A part whose deltas cancelled out is not on the cell.
  return out.filter(e => e.quantity !== 0);
}
