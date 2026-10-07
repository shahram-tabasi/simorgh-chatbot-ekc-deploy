// src/utils/sion3ae5/simoprimeA4.ts
//
// SIMOPRIME A4: from a cell's required current, the switchgear's ratings and
// the site's ambient temperature, the panel the design catalogue (version
// 1.4, 04/2007) gives it — busbar run, width, ventilation — and the breaker
// inside. The catalogue's breaker is the 3AH5; the office orders the SION
// 3AE5 of the same rating in its place, at the panel's phase centres.
//
//   2.1.2  Rated nominal panel current      800 / 1250 / 2000 / 2500 A;
//                                           LBS 630 A, fused LBS 200 A
//   2.2    Rated feeder current by ambient  the selection: each row is a
//                                           busbar run, breaker and
//                                           ventilation, and what it may carry
//                                           at 25–55 °C, 50 / 60 Hz
//   2.2.1  Panel dimensions                 800 mm ≤ 1250 A, 1000 mm above;
//                                           LBS / fused LBS 500 mm
//   2.3.2  Circuit breaker                  800 mm → 210 mm phase centres,
//                                           1000 mm → 275 mm
//   2.3.10 Voltage transformer              on the VCB truck in every VCB
//                                           panel, on its own truck in a
//                                           metering panel
import { DATA } from './data';
import type { PanelChoice, PanelKind, Ventilation, WorldPanel, WorldSite } from './simoprimeWorld';

// [busbar run, breaker A, ventilation, width mm, 50 Hz at 25…55 °C, 60 Hz]
type Row22 = [string, number, Ventilation, number, number[], number[]];

/** 2.2, in the catalogue's order — narrowest, least ventilated first. */
const TABLE_22: Row22[] = [
  ['1x80x10', 800, 'Without', 800, [1065, 953, 867, 800, 745, 698, 658], [1058, 945, 860, 795, 738, 693, 650]],
  ['1x100x10', 1250, 'Without', 800, [1400, 1250, 1138, 1050, 981, 916, 864], [1360, 1205, 1095, 1000, 930, 860, 815]],
  ['1x80x10', 1250, 'Natural', 800, [1665, 1490, 1356, 1250, 1163, 1090, 1030], [1598, 1430, 1300, 1200, 1116, 1047, 988]],
  ['2x80x10', 2000, 'Natural', 1000, [2245, 2120, 1979, 1850, 1705, 1554, 1387], [2595, 2320, 2115, 1950, 1814, 1700, 1605]],
  ['2x100x10', 2500, 'Forced', 1000, [3320, 2980, 2712, 2500, 2330, 2180, 2055], [3263, 2919, 2657, 2450, 2279, 2138, 2017]],
];

/** 2.3.2: phase centres by panel width. */
const PCD: Record<number, number> = { 800: 210, 1000: 275 };
const KA_STEPS = [16, 20, 25];
const tempColumn = (t: number) => Math.min(6, Math.max(0, Math.ceil((t - 25) / 5)));

/** The panel widths a cell may be set to. */
export const A4_WIDTHS = [500, 800, 1000];

export function a4Panel(kind: PanelKind, feederA: number | null, site: WorldSite, choice: PanelChoice = {}): WorldPanel {
  const p = a4PanelAuto(kind, feederA, site, choice);
  // A panel without a breaker simply takes what the engineer set.
  if (kind !== 'circuit-breaker') {
    if (choice.width) { p.width = choice.width; p.manual = { ...p.manual, width: true }; }
    if (choice.ventilation) { p.ventilation = choice.ventilation; p.manual = { ...p.manual, ventilation: true }; }
  }
  return p;
}

function a4PanelAuto(kind: PanelKind, feederA: number | null, site: WorldSite, choice: PanelChoice): WorldPanel {
  const notes: string[] = [];
  const p: WorldPanel = {
    kind, feederA, typicalA: null, width: null, ventilation: 'Without',
    breakerA: null, breaker: null, permissibleA: null, withdrawableVT: null, notes,
  };
  if (site.kv != null && site.kv > 24) notes.push(`${site.kv} kV is above SIMOPRIME A4's 24 kV.`);
  const ka = site.ka != null ? KA_STEPS.find(s => s >= site.ka! - 1e-9) ?? null : null;
  if (site.ka != null && ka == null) notes.push(`${site.ka} kA is above SIMOPRIME A4's 25 kA.`);

  switch (kind) {
    case 'metering':
      p.width = 800; p.withdrawableVT = true;
      notes.push('VT on its own truck, with or without primary fuse (2.3.10).');
      return p;
    case 'bus-riser':
    case 'bus-connection':
      p.width = 800; p.typicalA = feederA;
      return p;
    case 'load-break':
      p.width = 500; p.typicalA = 630;
      notes.push('Load-break switch panel: 630 A, only in a 20 kA / 3 s system (2.1.2).');
      if (ka != null && ka > 20) notes.push(`The switchgear is ${ka} kA — the load-break switch panel is rated 20 kA.`);
      return p;
    case 'fused-load-break':
      p.width = 500; p.typicalA = 200;
      notes.push('Fused load-break switch panel: 200 A; the feeder current is limited by the 3GD fuse (2.3.7).');
      return p;
    case 'contactor':
      notes.push('SIMOPRIME A4 has no contactor panel — width as the layout needs.');
      return p;
    case 'dummy':
      notes.push('Dummy panel: not in the design catalogue — width as the layout needs.');
      return p;
  }
  if (feederA == null) { notes.push('No current for this cell — enter it, or the row’s power.'); return p; }
  if (site.busbarA && feederA > site.busbarA) {
    notes.push(`${feederA} A is more than the main busbar's ${site.busbarA} A — a feeder cannot carry more than the busbar (2.1.2).`);
  }

  // A withdrawable panel or bus sectionaliser with circuit-breaker: 2.2.
  const t = site.ambientC ?? 40;
  if (site.ambientC == null) notes.push('No design temperature — 40 °C assumed.');
  if (t > 55) notes.push(`${t} °C is above the table's 55 °C.`);
  const sixty = site.frequencyHz === 60;
  const col = tempColumn(t);
  // The engineer's width or ventilation narrows the rows the table may pick from.
  const allowed = TABLE_22.filter(r => (!choice.width || r[3] === choice.width) && (!choice.ventilation || r[2] === choice.ventilation));
  if (choice.width || choice.ventilation) p.manual = { width: !!choice.width, ventilation: !!choice.ventilation };
  const amps = (r: Row22) => (sixty ? r[5] : r[4])[col];
  let fit = allowed.find(r => amps(r) >= feederA);
  if (!fit && allowed.length) {
    fit = allowed[allowed.length - 1];
    notes.push(`${choice.width || choice.ventilation ? 'Set by hand: no' : 'No'} panel ${[choice.width && `of ${choice.width} mm`, choice.ventilation?.toLowerCase()].filter(Boolean).join(' ')} carries ${feederA} A at ${t} °C — the largest one takes ${amps(fit)} A.`);
  }
  if (!fit) {
    notes.push(`Set by hand: the catalogue has no ${[choice.width && `${choice.width} mm`, choice.ventilation?.toLowerCase()].filter(Boolean).join(' ')} circuit-breaker panel.`);
    if (choice.width) p.width = choice.width;
    if (choice.ventilation) p.ventilation = choice.ventilation;
    return p;
  }
  const [run, breakerA, vent, width, a50, a60] = fit;
  Object.assign(p, { typicalA: breakerA, width, ventilation: vent, permissibleA: (sixty ? a60 : a50)[col] });
  // The SION 3AE5 in place of the catalogue's 3AH5: 24 kV, the panel's phase
  // centres, the breaker's current; 800 A is a 16 kA breaker in the catalogue,
  // but the 3AE5 offers it at the switchgear's rating.
  const pcd = PCD[width];
  p.breaker = DATA.find(r => r[6] === 0 && r[1] === 24 && r[2] === (ka ?? 25) && r[3] === pcd && r[5] === breakerA) ?? null;
  p.breakerA = p.breaker?.[5] ?? null;
  if (!p.breaker) notes.push(`No 3AE5 of 24 kV / ${ka ?? 25} kA / ${breakerA} A with ${pcd} mm phase centres.`);
  p.withdrawableVT = true;
  if (breakerA === 1250 && vent === 'Natural') notes.push('1250 A naturally ventilated: type tested locally (1050 A type tested at 40 °C).');
  if (breakerA === 2000) notes.push('2000 A panel: 1850 A type tested at 40 °C.');
  if (vent === 'Forced') notes.push('2500 A forced ventilation: 2nd development stage; supply AC 220–240 V or 110 V.');
  if (width === 800) notes.push('800 mm panel: at most 2 cables per phase (2.3.8).');
  notes.unshift(`Table 2.2: busbar ${run}, ${breakerA} A breaker, ${vent.toLowerCase()} ventilation, ${p.permissibleA} A permissible at ${t} °C / ${sixty ? 60 : 50} Hz; ${width} mm panel with ${pcd} mm phase centres.`);
  return p;
}
