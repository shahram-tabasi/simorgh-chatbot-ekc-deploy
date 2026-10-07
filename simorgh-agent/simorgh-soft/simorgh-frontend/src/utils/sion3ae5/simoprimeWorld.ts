// src/utils/sion3ae5/simoprimeWorld.ts
//
// SIMOPRIME World: from a cell's required current, the switchgear's ratings
// and the site's ambient temperature, the panel the design catalogue (issue
// 23, 06/2026) gives it — typical, width, ventilation — and the SION 3AE5
// inside.
//
//   3.7      Maximum permissible feeder operating currents — the selection:
//            each row is a typical with its width, ventilation and breaker,
//            and what it may carry at 25–55 °C, 50 / 60 Hz
//   2.2      Configuration of panels — metering, riser, bus connection
//   2.2.3.3  Withdrawable VTs by typical and ventilation
//
// The rule is the catalogue's own reading of 3.7: at this voltage and
// short-circuit rating, the first typical — narrowest, least ventilated —
// whose permissible current at the site's temperature and frequency reaches
// what the cell has to carry.
import { DATA, type PrimaryRow } from './data';

export type Ventilation = 'Without' | 'Natural' | 'Forced';
export type PanelKind =
  | 'circuit-breaker' | 'contactor' | 'metering' | 'bus-riser' | 'bus-connection'
  | 'load-break' | 'fused-load-break' | 'dummy';

export interface WorldPanel {
  kind: PanelKind;
  /** The current the cell has to carry. */
  feederA: number | null;
  /** The typical the catalogue projects for it. */
  typicalA: number | null;
  width: number | null;
  ventilation: Ventilation;
  /** The breaker's rated current, when the panel has one. */
  breakerA: number | null;
  /** The 3AE5 type, when one fits. */
  breaker: PrimaryRow | null;
  /** What the chosen typical may carry here (3.7). */
  permissibleA: number | null;
  withdrawableVT: boolean | null;
  notes: string[];
  /** Width / ventilation the engineer set by hand rather than the table. */
  manual?: { width?: boolean; ventilation?: boolean };
}

/** What the engineer chose for one cell, where it differs from the rules. */
export interface PanelChoice { width?: number; ventilation?: Ventilation }

const KIND_LABEL: Record<PanelKind, string> = {
  'circuit-breaker': 'Switching device panel with circuit-breaker',
  contactor: 'Switching device panel with contactor',
  metering: 'Metering panel',
  'bus-riser': 'Bus riser panel',
  'bus-connection': 'Bus connection panel',
  'load-break': 'Load-break switch panel',
  'fused-load-break': 'Fused load-break switch panel',
  dummy: 'Dummy panel',
};
export const panelKindLabel = (k: PanelKind) => KIND_LABEL[k];

// ── 3.7 ─────────────────────────────────────────────────────────────────
// [typical A, width mm, ventilation, breaker MLFB, 50 Hz at 25…55 °C, 60 Hz]
type Row37 = [number, number, Ventilation, string, number[], number[]];

const A630 = [900, 865, 830, 790, 750, 705, 660];
const A1000 = [1125, 1090, 1055, 1015, 975, 935, 890];
const A1250 = [1480, 1440, 1395, 1350, 1305, 1230, 1150];
const A1600 = [1740, 1685, 1630, 1570, 1510, 1445, 1375];
const W2500_50 = [1950, 1895, 1840, 1780, 1720, 1660, 1590];
const W2500_60 = [1835, 1780, 1730, 1675, 1615, 1560, 1495];
const N2500_50 = [2280, 2215, 2150, 2080, 2010, 1935, 1845];
const N2500_60 = [2240, 2175, 2110, 2045, 1975, 1900, 1810];
const N3150_50 = [2960, 2880, 2790, 2705, 2610, 2515, 2420];
const N3150_60 = [2851, 2774, 2687, 2606, 2514, 2423, 2331];
const F2500_50 = [3000, 3000, 3000, 3000, 3000, 2935, 2785];
const F2500_60 = [3000, 3000, 3000, 3000, 3000, 2935, 2820];
const F4000_50 = [4000, 4000, 4000, 4000, 4000, 3960, 3755];
const F4000_60 = [4000, 4000, 4000, 4000, 3970, 3785, 3590];

/** One rating's rows, from its nine breakers in table order. */
const standard = (b: string[]): Row37[] => [
  [630, 600, 'Without', b[0], A630, A630],
  [1000, 600, 'Without', b[1], A1000, A1000],
  [1250, 800, 'Without', b[2], A1250, A1250],
  [1600, 800, 'Without', b[3], A1600, A1600],
  [2500, 800, 'Without', b[4], W2500_50, W2500_60],
  [2500, 800, 'Natural', b[5], N2500_50, N2500_60],
  [2500, 800, 'Natural', b[6], N3150_50, N3150_60],
  [2500, 800, 'Forced', b[7], F2500_50, F2500_60],
  [4000, 800, 'Forced', b[8], F4000_50, F4000_60],
];

/** Keyed "kV group / kA": ≤12 kV (7.2 and 12) and 17.5 kV. */
const TABLE_37: Record<string, Row37[]> = {
  '12/25': standard(['3AE5124-1', '3AE5124-2', '3AE5184-2', '3AE5184-3', '3AE5184-6', '3AE5184-6', '3AE5186-7', '3AE5184-6', '3AE5186-8']),
  '12/31.5': standard(['3AE5125-1', '3AE5125-2', '3AE5185-2', '3AE5185-3', '3AE5185-6', '3AE5185-6', '3AE5186-7', '3AE5185-6', '3AE5186-8']),
  '12/40': [
    [1250, 800, 'Without', '3AE5186-2', [1410, 1370, 1325, 1285, 1240, 1195, 1150], [1395, 1355, 1315, 1275, 1230, 1185, 1140]],
    [2500, 800, 'Without', '3AE5186-6', [2120, 2060, 2000, 1935, 1870, 1800, 1730], [2050, 1995, 1935, 1870, 1810, 1740, 1675]],
    [2500, 800, 'Natural', '3AE5186-6', [2400, 2380, 2295, 2205, 2110, 2010, 1910], [2330, 2310, 2230, 2140, 2050, 1950, 1855]],
    [2500, 800, 'Natural', '3AE5186-7', N3150_50, N3150_60],
    [2500, 800, 'Forced', '3AE5186-6', [3000, 3000, 3000, 3000, 3000, 2885, 2735], [3000, 3000, 3000, 3000, 2890, 2755, 2615]],
    [4000, 800, 'Forced', '3AE5186-8', F4000_50, F4000_60],
  ],
  '17.5/25': standard(['3AE5224-1', '3AE5224-2', '3AE5284-2', '3AE5284-3', '3AE5284-6', '3AE5284-6', '3AE5286-7', '3AE5284-6', '3AE5286-8']),
  '17.5/31.5': [
    [630, 600, 'Without', '3AE5225-1', [756, 756, 756, 756, 756, 756, 750], [756, 756, 756, 756, 756, 756, 750]],
    [1000, 600, 'Without', '3AE5225-2', [1200, 1180, 1145, 1100, 1055, 1005, 950], [1200, 1170, 1135, 1095, 1055, 1005, 955]],
    [1250, 800, 'Without', '3AE5285-2', [1500, 1500, 1485, 1440, 1390, 1340, 1285], [1500, 1500, 1480, 1435, 1385, 1335, 1280]],
    [1600, 800, 'Without', '3AE5285-3', [1765, 1715, 1665, 1615, 1560, 1500, 1445], [1750, 1700, 1650, 1600, 1545, 1485, 1430]],
    [2500, 800, 'Without', '3AE5285-6', W2500_50, W2500_60],
    [2500, 800, 'Natural', '3AE5285-6', N2500_50, N2500_60],
    [2500, 800, 'Natural', '3AE5286-7', N3150_50, N3150_60],
    [2500, 800, 'Forced', '3AE5285-6', F2500_50, F2500_60],
    [4000, 800, 'Forced', '3AE5286-8', F4000_50, F4000_60],
  ],
  // 17.5 kV / 40 kA is cut off in the catalogue ("…"): not offered here.
};

/** 2.2.3.3 — withdrawable VTs by rating, typical and ventilation. */
const VT_POSSIBLE: Record<string, boolean> = {
  'le31.5/630/Without': false, 'le31.5/1000/Without': false, 'le31.5/1250/Without': true,
  'le31.5/1600/Without': true, 'le31.5/2500/Without': true, 'le31.5/2500/Natural': false,
  'le31.5/2500/Forced': false, 'le31.5/4000/Forced': true,
  '40/1250/Without': true, '40/2500/Without': true, '40/2500/Natural': false,
  '40/2500/Forced': true, '40/4000/Forced': true,
};

const KA_STEPS = [25, 31.5, 40];
/** The 25…55 °C column a temperature reads in (rounded up to the next 5). */
const tempColumn = (t: number) => Math.min(6, Math.max(0, Math.ceil((t - 25) / 5)));

export interface WorldSite {
  kv: number | null;
  ka: number | null;
  /** Ambient (design) temperature, °C. */
  ambientC: number | null;
  frequencyHz: number | null;
  /** Front cable access — withdrawable VTs are not possible then (2.1.1, fn 2). */
  frontAccess?: boolean;
  /** The main busbar's rated current — no feeder may carry more (A4 2.1.2). */
  busbarA?: number | null;
}

export function worldPanel(kind: PanelKind, feederA: number | null, site: WorldSite, choice: PanelChoice = {}): WorldPanel {
  const p = worldPanelAuto(kind, feederA, site, choice);
  // A panel without a breaker simply takes what the engineer set.
  if (kind !== 'circuit-breaker') {
    if (choice.width) { p.width = choice.width; p.manual = { ...p.manual, width: true }; }
    if (choice.ventilation) { p.ventilation = choice.ventilation; p.manual = { ...p.manual, ventilation: true }; }
  }
  return p;
}

function worldPanelAuto(kind: PanelKind, feederA: number | null, site: WorldSite, choice: PanelChoice): WorldPanel {
  const notes: string[] = [];
  const p: WorldPanel = {
    kind, feederA, typicalA: null, width: null, ventilation: 'Without',
    breakerA: null, breaker: null, permissibleA: null, withdrawableVT: null, notes,
  };
  const ka = site.ka != null ? KA_STEPS.find(s => s >= site.ka! - 1e-9) ?? null : null;
  const forty = ka === 40;
  if (site.ka != null && ka == null) notes.push(`${site.ka} kA is above SIMOPRIME World's 40 kA.`);

  if (kind === 'metering') { p.width = forty ? 800 : 600; return p; }
  if (kind === 'contactor') { p.width = 600; p.typicalA = 400; return p; }
  if (kind === 'dummy') { notes.push('Dummy panel: not in the design catalogue — width as the layout needs.'); return p; }
  if (kind === 'load-break' || kind === 'fused-load-break') {
    notes.push(`${KIND_LABEL[kind]}: not in the SIMOPRIME World catalogue — width as the layout needs.`);
    return p;
  }
  if (kind === 'bus-riser') {
    // 600 mm, except beside a 2500 A sectionalizer or at 4000 A (2.2, fn 11).
    p.width = (feederA ?? 0) > 1600 ? 800 : 600;
    p.typicalA = feederA;
    return p;
  }
  if (feederA == null) { notes.push('No current for this cell — enter it, or the row’s power.'); return p; }
  if (kind === 'bus-connection') {
    p.width = 800;
    p.typicalA = feederA <= 1250 ? 1250 : feederA <= 2500 ? 2500 : 4000;
    if (p.typicalA === 4000) { p.ventilation = 'Forced'; notes.push('Forced ventilation is mandatory for a 4000 A busbar.'); }
    return p;
  }

  // A switching-device panel with circuit-breaker (also a bus sectionalizer's
  // breaker panel): 3.7.
  if (site.kv == null || ka == null) { notes.push('Rated voltage and short-circuit current are needed (Scope Library).'); return p; }
  const group = site.kv <= 12 ? 12 : 17.5;
  const rows = TABLE_37[`${group}/${ka}`];
  if (!rows) { notes.push(`${group} kV / ${ka} kA is not in the catalogue's table 3.7.`); return p; }
  const t = site.ambientC ?? 40;
  if (site.ambientC == null) notes.push('No design temperature in Technical Settings — 40 °C assumed.');
  if (t > 55) notes.push(`${t} °C is above the table's 55 °C.`);
  const sixty = site.frequencyHz === 60;
  const col = tempColumn(t);
  // The engineer's width or ventilation narrows the typicals the table may
  // pick from; the breaker then follows the typical, as the catalogue pairs them.
  const allowed = rows.filter(r => (!choice.width || r[1] === choice.width) && (!choice.ventilation || r[2] === choice.ventilation));
  if (choice.width || choice.ventilation) p.manual = { width: !!choice.width, ventilation: !!choice.ventilation };
  const amps = (r: Row37) => (sixty ? r[5] : r[4])[col];
  let fit = allowed.find(r => amps(r) >= feederA);
  if (!fit && allowed.length) {
    fit = allowed[allowed.length - 1];
    notes.push(`Set by hand: no ${[choice.width && `${choice.width} mm`, choice.ventilation?.toLowerCase()].filter(Boolean).join(' ')} typical carries ${feederA} A at ${t} °C — the largest one takes ${amps(fit)} A.`);
  }
  if (!fit) {
    notes.push(choice.width || choice.ventilation
      ? `Set by hand: the catalogue has no ${[choice.width && `${choice.width} mm`, choice.ventilation?.toLowerCase()].filter(Boolean).join(' ')} typical at ${group} kV / ${ka} kA.`
      : `No typical carries ${feederA} A at ${t} °C.`);
    if (choice.width) p.width = choice.width;
    if (choice.ventilation) p.ventilation = choice.ventilation;
    return p;
  }
  const [typ, width, vent, mlfb, a50, a60] = fit;
  Object.assign(p, { typicalA: typ, width, ventilation: vent, permissibleA: (sixty ? a60 : a50)[col] });
  p.breaker = DATA.find(r => r[0] === mlfb) ?? null;
  p.breakerA = p.breaker?.[5] ?? null;
  p.withdrawableVT = VT_POSSIBLE[`${forty ? '40' : 'le31.5'}/${typ}/${vent}`] ?? null;
  // 2.1.1 fn 2: only in a withdrawable-type switchgear, 800 mm, cable access from the back.
  if (p.withdrawableVT && site.frontAccess) { p.withdrawableVT = false; notes.push('Withdrawable VT: not with front cable access.'); }
  if (p.breakerA === 3150) notes.push('3150 A breaker in the naturally ventilated 2500 A typical: the CTs must carry 1.2 × In.');
  if (vent === 'Forced') notes.push('Forced ventilation: supply AC 220–240 V.');
  if (width === 800) notes.push('800 mm panel with breaker on truck: a separate ramp is needed.');
  notes.unshift(`Table 3.7: ${typ} A typical, ${vent.toLowerCase()} ventilation, ${p.permissibleA} A permissible at ${t} °C / ${sixty ? 60 : 50} Hz.`);
  return p;
}
