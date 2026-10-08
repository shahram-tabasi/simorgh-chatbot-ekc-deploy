// src/utils/layout/s8Catalogue.ts
//
// SIVACON S8, from Siemens' own planning manual: "SIVACON S8 Technical
// Planning Information 10/2015" (IC1000-G320-A220-V3-7600). Each table names
// the table it was read from, so a figure can be checked against the book.
//
// The office's FEEDER ASSEMBLY LIST (s8DrawerTable) stays what a drawer is
// built as; this is the system around it — how tall a section is, how much
// current its distribution busbar and the main busbar carry at the room's
// temperature, how wide an incomer or a coupler is — and the catalogue's own
// minimum drawer heights, for a feeder the office list has no row for.

/** Tab. 4/1, Fig. 4/3: universal mounting design (drawers). */
export const UNIVERSAL = {
  /** Device compartment height by frame height: 2,200 → 1,800, 2,000 → 1,600. */
  deviceCompartment: (frame: 2000 | 2200) => (frame === 2200 ? 1800 : 1600),
  /** Drawers on a 50 mm grid (4.3.1). */
  grid: 50,
  deviceWidth: 600,
  /** Cubicle width with the cable compartment beside it (front connection). */
  widths: [1000, 1200] as const,
  /** Rear connection: the device compartment alone. */
  rearWidth: 600,
  /** Rated diversity factor for the feeders of one cubicle (4.3.5). */
  rdf: 0.8,
};

/** Tab. 2/4: frame heights and bases. */
export const FRAME_HEIGHTS = [2000, 2200] as const;
export const BASES = [0, 100, 200] as const;

/**
 * Tab. 5/6 (and 5/12): conversion factors for the ambient temperature of the
 * switchgear (24 h mean), against the catalogue's 35 °C.
 */
const TEMP_FACTORS: [number, number][] = [
  [20, 1.10], [25, 1.07], [30, 1.04], [35, 1.0], [40, 0.95], [45, 0.90], [50, 0.85], [55, 0.80],
];

/** The factor for an ambient temperature, read between the table's points. */
export function tempFactor(ambient: number): number {
  const t = Math.max(20, Math.min(55, ambient));
  for (let i = 0; i < TEMP_FACTORS.length - 1; i++) {
    const [t0, f0] = TEMP_FACTORS[i];
    const [t1, f1] = TEMP_FACTORS[i + 1];
    if (t >= t0 && t <= t1) return f0 + ((t - t0) / (t1 - t0)) * (f1 - f0);
  }
  return 1;
}

/**
 * 10.2: a busbar's rating at another ambient — I₂ = I₁ · √((130 − T) / 95),
 * from a permissible busbar temperature of 130 °C.
 */
export const busbarAt = (rated35: number, ambient: number) =>
  Math.round(rated35 * Math.sqrt(Math.max(0, 130 - ambient) / (130 - 35)));

export interface BusbarRating { ventilated: number; nonVentilated: number; icw: number }

/** Tab. 2/7: main busbar, top position, at 35 °C. Above 3,270 A frame 2,200 and depth ≥ 800. */
export const MAIN_BUSBAR_TOP: BusbarRating[] = [
  { ventilated: 1190, nonVentilated: 965, icw: 35 },
  { ventilated: 1630, nonVentilated: 1310, icw: 50 },
  { ventilated: 1920, nonVentilated: 1480, icw: 65 },
  { ventilated: 2470, nonVentilated: 1870, icw: 85 },
  { ventilated: 3010, nonVentilated: 2250, icw: 100 },
  { ventilated: 3270, nonVentilated: 2450, icw: 100 },
  { ventilated: 3700, nonVentilated: 3000, icw: 100 },
  { ventilated: 4660, nonVentilated: 3680, icw: 100 },
  { ventilated: 5620, nonVentilated: 4360, icw: 150 },
  { ventilated: 6300, nonVentilated: 4980, icw: 150 },
];

/** Tab. 2/7: main busbar, rear position, at 35 °C. Two systems in a cubicle: × 0.94 / 0.98. */
export const MAIN_BUSBAR_REAR: BusbarRating[] = [
  { ventilated: 1280, nonVentilated: 1160, icw: 50 },
  { ventilated: 1630, nonVentilated: 1400, icw: 65 },
  { ventilated: 2200, nonVentilated: 1800, icw: 65 },
  { ventilated: 2520, nonVentilated: 2010, icw: 85 },
  { ventilated: 2830, nonVentilated: 2210, icw: 100 },
  { ventilated: 3170, nonVentilated: 2490, icw: 100 },
  { ventilated: 4000, nonVentilated: 3160, icw: 100 },
  { ventilated: 4910, nonVentilated: 3730, icw: 100 },
  { ventilated: 5340, nonVentilated: 4080, icw: 100 },
  { ventilated: 5780, nonVentilated: 4440, icw: 100 },
  { ventilated: 7010, nonVentilated: 5440, icw: 150 },
];

/** Tab. 4/2: vertical distribution busbar of a drawer cubicle, at 35 °C. */
export const VERTICAL_BUSBAR = [
  { name: 'Profile bar 400 mm²', ventilated: 905, nonVentilated: 830 },
  { name: 'Profile bar 650 mm²', ventilated: 1100, nonVentilated: 1000 },
  { name: 'Flat copper 1 × 40×10', ventilated: 865, nonVentilated: 820 },
  { name: 'Flat copper 2 × 40×10', ventilated: 1120, nonVentilated: 1000 },
];

export interface S8System {
  frame: 2000 | 2200;
  base: 0 | 100 | 200;
  busbar: 'top' | 'rear';
  /** Two main busbar systems (rear top and rear bottom, or top double). */
  doubleBusbar: boolean;
  /** Up to IP43 ventilated, IP54 non-ventilated. */
  ventilated: boolean;
  /** 24 h mean of the switchgear room, °C. */
  ambient: number;
  /** Index into VERTICAL_BUSBAR. */
  verticalBusbar: number;
}

export const DEFAULT_SYSTEM: S8System = {
  frame: 2200, base: 0, busbar: 'top', doubleBusbar: false, ventilated: true, ambient: 35, verticalBusbar: 1,
};

/** The distribution busbar of one drawer cubicle, at the room's temperature. */
export function verticalRating(s: S8System): number {
  const v = VERTICAL_BUSBAR[s.verticalBusbar] ?? VERTICAL_BUSBAR[1];
  return busbarAt(s.ventilated ? v.ventilated : v.nonVentilated, s.ambient);
}

/** The smallest main busbar that carries `amps` at the room's temperature. */
export function mainBusbarFor(amps: number, s: S8System): { rated: number; at: number; icw: number } | null {
  const table = s.busbar === 'top' ? MAIN_BUSBAR_TOP : MAIN_BUSBAR_REAR;
  const twoSystems = s.busbar === 'rear' && s.doubleBusbar ? (s.ventilated ? 0.94 : 0.98) : 1;
  for (const r of table) {
    const rated = s.ventilated ? r.ventilated : r.nonVentilated;
    const at = Math.round(busbarAt(rated, s.ambient) * twoSystems);
    if (at >= amps) return { rated, at, icw: r.icw };
  }
  return null;
}

/** Tab. 2/4: cubicle depth by busbar position and rating. */
export function cubicleDepth(s: S8System, mainAmps: number): number {
  if (s.busbar === 'top') return mainAmps > 3270 || s.doubleBusbar ? 1200 : 600;
  if (s.doubleBusbar) return 1200;
  return mainAmps > 4000 ? 800 : 600;
}

/**
 * Tab. 3/2: width of a cubicle with one 3WL, top busbar — incoming or
 * outgoing unit (cable connection) and longitudinal coupler, 3- and 4-pole.
 */
const ACB_WIDTHS: { rating: number; feeder3: number; feeder4: number; coupler3: number; coupler4: number }[] = [
  { rating: 2000, feeder3: 600, feeder4: 600, coupler3: 600, coupler4: 800 },   // 3WL11 630…2,000 A
  { rating: 3200, feeder3: 800, feeder4: 800, coupler3: 800, coupler4: 1000 },  // 3WL12 2,000…3,200 A
  { rating: 4000, feeder3: 800, feeder4: 1000, coupler3: 1000, coupler4: 1200 }, // 3WL1340
  { rating: 6300, feeder3: 1000, feeder4: 1000, coupler3: 1200, coupler4: 1200 }, // 3WL1350/63
];

export function acbCubicleWidth(amps: number, role: 'incoming' | 'coupler' | 'outgoing', poles: 3 | 4 = 3): number {
  const row = ACB_WIDTHS.find(r => amps <= r.rating) ?? ACB_WIDTHS[ACB_WIDTHS.length - 1];
  if (role === 'coupler') return poles === 4 ? row.coupler4 : row.coupler3;
  return poles === 4 ? row.feeder4 : row.feeder3;
}

/** Tab. 4/17: minimum normal withdrawable unit height for a cable feeder, mm. */
const CABLE_FEEDER_MIN: Record<string, [number, number]> = {
  // frame: [3-pole, 4-pole]
  '3RV S00': [100, 0], '3RV S0': [100, 0], '3RV S2': [150, 0], '3RV S3': [150, 0],
  '3VA10': [150, 200], '3VA11': [150, 200], '3VA12': [200, 250],
  '3VA20': [200, 200], '3VA21': [200, 200], '3VA22': [200, 250],
  '3VA23': [300, 300], '3VA24': [300, 400],
};

/** Tab. 4/21: fuseless motor feeder with overload relay, minimum height by kW: [direct, reversing, star-delta]. */
const MOTOR_MIN: [number, [number, number, number]][] = [
  [15, [100, 100, 150]], [22, [150, 150, 200]], [45, [150, 250, 250]], [90, [300, 400, 400]],
  [110, [400, 500, 500]], [160, [500, 500, 700]], [250, [700, 700, 700]],
];

/**
 * The catalogue's own minimum drawer, in modules — for a feeder the office's
 * list has no row for. A motor by its power and starter, else a cable feeder
 * by its breaker frame and poles.
 */
export function catalogueModules(o: {
  frame?: string; poles?: 3 | 4; motorKw?: number; contactors: number;
}): number | null {
  const toM = (mm: number) => Math.ceil(mm / UNIVERSAL.grid);
  if (o.contactors > 0 && o.motorKw != null && o.motorKw > 0) {
    const row = MOTOR_MIN.find(([kw]) => o.motorKw! <= kw);
    if (!row) return null;
    const k = o.contactors >= 3 ? 2 : o.contactors === 2 ? 1 : 0;
    return toM(row[1][k]);
  }
  const r = o.frame ? CABLE_FEEDER_MIN[o.frame] : undefined;
  if (!r) return null;
  const mm = o.poles === 4 ? r[1] || r[0] : r[0];
  return toM(mm);
}

/** Tab. 4/17: rated current of a cable feeder drawer at 35 °C — [non-vent, vent], 3-pole. */
const FEEDER_INC: Record<string, [number, number]> = {
  '3RV S00': [14.6, 15.2], '3RV S0': [32, 33.5], '3RV S2': [40, 41], '3RV S3': [50, 51.5],
  '3VA10': [92, 97], '3VA11': [128, 133], '3VA12': [218, 226],
  '3VA20': [100, 100], '3VA21': [155, 160], '3VA22': [189, 203],
  '3VA23': [320, 350], '3VA24': [365, 405],
};

/** What a drawer of that frame carries in this room: Inc × temperature factor. */
export function feederRatingAt(frame: string | undefined, s: S8System): number | null {
  const r = frame ? FEEDER_INC[frame] : undefined;
  if (!r) return null;
  return Math.round((s.ventilated ? r[1] : r[0]) * tempFactor(s.ambient));
}
