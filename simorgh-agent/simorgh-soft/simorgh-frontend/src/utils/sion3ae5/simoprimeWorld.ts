// src/utils/sion3ae5/simoprimeWorld.ts
//
// SIMOPRIME World: from a cell's feeder current and the switchgear's
// short-circuit rating, the panel the design catalogue (issue 23, 06/2026)
// gives it — typical, width, ventilation — and the SION 3AE5 inside.
//
//   2.2      Configuration of panels      feeder current → typical, width
//   2.2.3.3  Panel width / ventilation    ventilation, withdrawable VTs
//   2.2.2.9  Circuit-breaker SION 3AE5    the types the panel takes
//
// The 600 mm panels carry the 150 mm pole-centre breakers, the 800 mm panels
// the 210 mm ones, which is how the catalogue's own type list reads.
import { DATA, type PrimaryRow } from './data';
import { SIMOPRIME_WORLD } from './engine';

export type Ventilation = 'Without' | 'Natural' | 'Forced';
export type PanelKind = 'circuit-breaker' | 'contactor' | 'metering' | 'bus-riser' | 'bus-connection';

export interface WorldPanel {
  kind: PanelKind;
  /** The current the cell has to carry. */
  feederA: number | null;
  /** The panel the catalogue projects for it, e.g. 2500 for an 1800 A feeder. */
  typicalA: number | null;
  width: number | null;
  ventilation: Ventilation;
  /** The breaker's rated current, when the panel has one. */
  breakerA: number | null;
  pcd: number | null;
  /** The 3AE5 type, when one fits. */
  breaker: PrimaryRow | null;
  withdrawableVT: boolean | null;
  notes: string[];
}

const KIND_LABEL: Record<PanelKind, string> = {
  'circuit-breaker': 'Switching device panel with circuit-breaker',
  contactor: 'Switching device panel with contactor',
  metering: 'Metering panel',
  'bus-riser': 'Bus riser panel',
  'bus-connection': 'Bus connection panel',
};
export const panelKindLabel = (k: PanelKind) => KIND_LABEL[k];

/** What a template's name says the cell is. */
export function panelKindOf(templateName = ''): PanelKind {
  const t = templateName.toUpperCase();
  if (/METER/.test(t)) return 'metering';
  if (/RISER/.test(t)) return 'bus-riser';
  if (/BUS\s*-?\s*CONNECTION|BUSBAR\s*CONNECTION/.test(t)) return 'bus-connection';
  if (/CONTACTOR|\bCFC\b|FUSE/.test(t)) return 'contactor';
  return 'circuit-breaker';
}

/**
 * 2.2.3.3 — ventilation and withdrawable VTs by short-circuit rating, panel
 * current and ventilation.
 */
const VT_POSSIBLE: Record<string, boolean> = {
  'le31.5/630/Without': false, 'le31.5/1000/Without': false, 'le31.5/1250/Without': true,
  'le31.5/1600/Without': true, 'le31.5/2500/Without': true, 'le31.5/2500/Natural': false,
  'le31.5/2500/Forced': false, 'le31.5/4000/Forced': true,
  '40/1250/Without': true, '40/2500/Without': true, '40/2500/Natural': false,
  '40/2500/Forced': true, '40/4000/Forced': true,
};

/** The 3AE5 types the panel takes, for a voltage, current and pole-centre
 *  distance — the lowest short-circuit rating at or above the switchgear's. */
function worldBreaker(kv: number, ka: number, ir: number, pcd: number): PrimaryRow | null {
  // The panel's breakers are 12 kV and 17.5 kV types.
  const level = kv <= 12 ? 12 : 17.5;
  const fits = DATA.filter(r => r[0] in SIMOPRIME_WORLD && r[1] === level && r[5] === ir && r[3] === pcd && r[2] >= ka)
    .sort((a, b) => a[2] - b[2]);
  return fits[0] ?? null;
}

export function worldPanel(kind: PanelKind, feederA: number | null, kv: number | null, ka: number | null): WorldPanel {
  const notes: string[] = [];
  const p: WorldPanel = {
    kind, feederA, typicalA: null, width: null, ventilation: 'Without',
    breakerA: null, pcd: null, breaker: null, withdrawableVT: null, notes,
  };
  const forty = (ka ?? 0) > 31.5;
  if (forty && (ka ?? 0) > 40) notes.push(`${ka} kA is above SIMOPRIME World's 40 kA.`);

  if (kind === 'metering') { p.width = forty ? 800 : 600; return p; }
  if (kind === 'contactor') { p.width = 600; p.typicalA = 400; return p; }
  if (kind === 'bus-riser') { p.width = 600; notes.push('Bus riser: 800 mm when the sectionalizer is 2500 A, 800 + 800 at 4000 A.'); return p; }

  const I = feederA;
  if (I == null) { notes.push('No feeder current — enter FLC in Scope Selection.'); return p; }
  if (kind === 'bus-connection') {
    p.width = 800;
    p.typicalA = I <= 1250 ? 1250 : I <= 2500 ? 2500 : 4000;
    if (p.typicalA === 4000) { p.ventilation = 'Forced'; notes.push('Forced ventilation is mandatory for a 4000 A busbar.'); }
    return p;
  }

  // Switching device panel with circuit-breaker (2.2 and footnotes 5–10).
  if (!forty && I <= 630) { Object.assign(p, { typicalA: 630, width: 600, breakerA: 800, pcd: 150 }); }
  else if (!forty && I <= 1000) { Object.assign(p, { typicalA: 1000, width: 600, breakerA: 1250, pcd: 150 }); }
  else if (I <= 1250) { Object.assign(p, { typicalA: 1250, width: 800, breakerA: 1250, pcd: 210 }); }
  else if (!forty && I <= 1600) { Object.assign(p, { typicalA: 1600, width: 800, breakerA: 1600, pcd: 210 }); }
  else if (I <= 1800) {
    Object.assign(p, { typicalA: 2500, width: 800, breakerA: 2500, pcd: 210 });
    notes.push('2500 A typical without ventilation, rated 1800 A.');
  } else if (I <= 2000) {
    Object.assign(p, { typicalA: 2500, width: 800, breakerA: 2500, pcd: 210, ventilation: 'Natural' });
    notes.push('2500 A typical rated 2000 A (catalogue row “2500 nv”; its footnote 7 says without ventilation — confirm).');
  } else if (I <= 2500 && !forty) {
    Object.assign(p, { typicalA: 2500, width: 800, breakerA: 3150, pcd: 210, ventilation: 'Natural' });
    notes.push('2500 A with natural ventilation takes a 3150 A breaker; its CTs must carry 1.2 × In.');
  } else if (I <= 3000) {
    Object.assign(p, { typicalA: 2500, width: 800, breakerA: 3150, pcd: 210, ventilation: 'Forced' });
    notes.push('2500 A typical with forced ventilation, rated 3000 A — the catalogue offers the 3150 A breaker only with natural ventilation: confirm the breaker with Siemens.');
  } else if (I <= 4000) {
    Object.assign(p, { typicalA: 4000, width: 800, breakerA: 4000, pcd: 210, ventilation: 'Forced' });
    notes.push('4000 A uses the 40 kA 4000 A SION 3AE5; forced ventilation.');
  } else {
    notes.push(`${I} A is above SIMOPRIME World's 4000 A.`);
    return p;
  }
  const key = `${forty ? '40' : 'le31.5'}/${p.typicalA}/${p.ventilation}`;
  p.withdrawableVT = VT_POSSIBLE[key] ?? null;
  if (p.width === 800) notes.push('800 mm panel with breaker on truck: a separate ramp is needed.');

  if (kv != null && ka != null && p.breakerA && p.pcd) {
    p.breaker = worldBreaker(kv, ka, p.breakerA, p.pcd);
    if (!p.breaker) notes.push(`No 3AE5 in the SIMOPRIME World list for ${kv} kV / ${ka} kA / ${p.breakerA} A.`);
    else if (p.breaker[1] !== kv) notes.push(`${kv} kV switchgear: the ${p.breaker[1]} kV breaker type.`);
    if (p.breaker && p.breaker[2] > ka) notes.push(`The ${p.breakerA} A breaker comes at ${p.breaker[2]} kA in this panel (switchgear ${ka} kA).`);
  }
  return p;
}
