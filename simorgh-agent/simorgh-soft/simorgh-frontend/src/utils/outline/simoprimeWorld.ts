// src/utils/outline/simoprimeWorld.ts
//
// The SIMOPRIME World selection table, as Eplanix holds it.
//
// Ported field for field from `Eplanix/Models/OutlineModels/SimoprimeWorldAnalyzer.cs`
// — the same rows, the same derating table, the same choice rule — so a panel
// picked here is the panel Eplanix picks. It answers one question for the
// outline: what ventilation a SIMOPRIME World cell needs. The rest of the row
// (the width, the breaker, the MLFB) is carried because the row is the answer;
// nothing reads it yet.
//
// Generated from the C# rather than retyped: two numeric tables copied by hand
// is two numeric tables with a typo in them.

export interface PanelConfig {
  voltageKv: number;
  shortCircuitKa: number;
  feederCurrentA: number;
  busbarCurrentA: number;
  panelWidthMm: number;
  /** 'without' | 'natural' | 'forced'. */
  ventilation: string;
  switchType: string;
  mlfb: string;
}

/** The selection table — pages 3 and 4 of the SIMOPRIME World design catalogue. */
export const SIMOPRIME_WORLD_PANELS: PanelConfig[] = [
  { voltageKv: 7.2, shortCircuitKa: 25, feederCurrentA: 630, busbarCurrentA: 1250, panelWidthMm: 600, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5124-1' },
  { voltageKv: 7.2, shortCircuitKa: 25, feederCurrentA: 800, busbarCurrentA: 1250, panelWidthMm: 600, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5124-2' },
  { voltageKv: 7.2, shortCircuitKa: 25, feederCurrentA: 1000, busbarCurrentA: 1600, panelWidthMm: 600, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5125-1' },
  { voltageKv: 7.2, shortCircuitKa: 25, feederCurrentA: 1250, busbarCurrentA: 1600, panelWidthMm: 600, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5125-2' },
  { voltageKv: 7.2, shortCircuitKa: 25, feederCurrentA: 1250, busbarCurrentA: 2500, panelWidthMm: 800, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5185-2' },
  { voltageKv: 7.2, shortCircuitKa: 25, feederCurrentA: 1600, busbarCurrentA: 2500, panelWidthMm: 800, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5185-3' },
  { voltageKv: 7.2, shortCircuitKa: 25, feederCurrentA: 2500, busbarCurrentA: 2500, panelWidthMm: 800, ventilation: 'natural', switchType: 'SION 3AE5', mlfb: '3AE5185-6' },
  { voltageKv: 7.2, shortCircuitKa: 25, feederCurrentA: 2500, busbarCurrentA: 3150, panelWidthMm: 800, ventilation: 'natural', switchType: 'SION 3AE5', mlfb: '3AE5186-2' },
  { voltageKv: 7.2, shortCircuitKa: 25, feederCurrentA: 2500, busbarCurrentA: 3150, panelWidthMm: 800, ventilation: 'forced', switchType: 'SION 3AE5', mlfb: '3AE5186-7' },
  { voltageKv: 7.2, shortCircuitKa: 25, feederCurrentA: 2500, busbarCurrentA: 3600, panelWidthMm: 800, ventilation: 'forced', switchType: 'SION 3AE1', mlfb: '3AE1186-7' },
  { voltageKv: 12, shortCircuitKa: 25, feederCurrentA: 630, busbarCurrentA: 1250, panelWidthMm: 600, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5124-1' },
  { voltageKv: 12, shortCircuitKa: 25, feederCurrentA: 800, busbarCurrentA: 1250, panelWidthMm: 600, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5124-2' },
  { voltageKv: 12, shortCircuitKa: 25, feederCurrentA: 1000, busbarCurrentA: 1600, panelWidthMm: 600, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5125-1' },
  { voltageKv: 12, shortCircuitKa: 25, feederCurrentA: 1250, busbarCurrentA: 1600, panelWidthMm: 600, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5125-2' },
  { voltageKv: 12, shortCircuitKa: 25, feederCurrentA: 1250, busbarCurrentA: 2500, panelWidthMm: 800, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5185-2' },
  { voltageKv: 12, shortCircuitKa: 25, feederCurrentA: 1600, busbarCurrentA: 2500, panelWidthMm: 800, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5185-3' },
  { voltageKv: 12, shortCircuitKa: 25, feederCurrentA: 2500, busbarCurrentA: 2500, panelWidthMm: 800, ventilation: 'natural', switchType: 'SION 3AE5', mlfb: '3AE5185-6' },
  { voltageKv: 12, shortCircuitKa: 25, feederCurrentA: 2500, busbarCurrentA: 3150, panelWidthMm: 800, ventilation: 'natural', switchType: 'SION 3AE5', mlfb: '3AE5186-2' },
  { voltageKv: 12, shortCircuitKa: 25, feederCurrentA: 2500, busbarCurrentA: 3150, panelWidthMm: 800, ventilation: 'forced', switchType: 'SION 3AE5', mlfb: '3AE5186-7' },
  { voltageKv: 12, shortCircuitKa: 25, feederCurrentA: 2500, busbarCurrentA: 3600, panelWidthMm: 800, ventilation: 'forced', switchType: 'SION 3AE1', mlfb: '3AE1186-7' },
  { voltageKv: 7.2, shortCircuitKa: 40, feederCurrentA: 630, busbarCurrentA: 1250, panelWidthMm: 600, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5184-2' },
  { voltageKv: 7.2, shortCircuitKa: 40, feederCurrentA: 800, busbarCurrentA: 1250, panelWidthMm: 600, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5184-3' },
  { voltageKv: 7.2, shortCircuitKa: 40, feederCurrentA: 1000, busbarCurrentA: 1600, panelWidthMm: 600, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5184-6' },
  { voltageKv: 7.2, shortCircuitKa: 40, feederCurrentA: 1250, busbarCurrentA: 1600, panelWidthMm: 600, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5184-6' },
  { voltageKv: 7.2, shortCircuitKa: 40, feederCurrentA: 1250, busbarCurrentA: 2500, panelWidthMm: 800, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5185-2' },
  { voltageKv: 7.2, shortCircuitKa: 40, feederCurrentA: 1600, busbarCurrentA: 2500, panelWidthMm: 800, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5185-3' },
  { voltageKv: 7.2, shortCircuitKa: 40, feederCurrentA: 2500, busbarCurrentA: 2500, panelWidthMm: 800, ventilation: 'natural', switchType: 'SION 3AE5', mlfb: '3AE5185-6' },
  { voltageKv: 7.2, shortCircuitKa: 40, feederCurrentA: 2500, busbarCurrentA: 3150, panelWidthMm: 800, ventilation: 'natural', switchType: 'SION 3AE1', mlfb: '3AE1186-2' },
  { voltageKv: 7.2, shortCircuitKa: 40, feederCurrentA: 2500, busbarCurrentA: 3150, panelWidthMm: 800, ventilation: 'forced', switchType: 'SION 3AE1', mlfb: '3AE1186-7' },
  { voltageKv: 7.2, shortCircuitKa: 40, feederCurrentA: 2500, busbarCurrentA: 3600, panelWidthMm: 800, ventilation: 'forced', switchType: 'SION 3AE1', mlfb: '3AE1186-7' },
  { voltageKv: 12, shortCircuitKa: 40, feederCurrentA: 1000, busbarCurrentA: 1600, panelWidthMm: 800, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5184-6' },
  { voltageKv: 12, shortCircuitKa: 40, feederCurrentA: 1250, busbarCurrentA: 1600, panelWidthMm: 800, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5184-6' },
  { voltageKv: 12, shortCircuitKa: 40, feederCurrentA: 1250, busbarCurrentA: 2500, panelWidthMm: 800, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5185-2' },
  { voltageKv: 12, shortCircuitKa: 40, feederCurrentA: 2500, busbarCurrentA: 2500, panelWidthMm: 800, ventilation: 'natural', switchType: 'SION 3AE5', mlfb: '3AE5185-6' },
  { voltageKv: 12, shortCircuitKa: 40, feederCurrentA: 2500, busbarCurrentA: 3150, panelWidthMm: 800, ventilation: 'natural', switchType: 'SION 3AE1', mlfb: '3AE1186-2' },
  { voltageKv: 12, shortCircuitKa: 40, feederCurrentA: 2500, busbarCurrentA: 3150, panelWidthMm: 800, ventilation: 'forced', switchType: 'SION 3AE1', mlfb: '3AE1186-7' },
  { voltageKv: 12, shortCircuitKa: 40, feederCurrentA: 2500, busbarCurrentA: 3600, panelWidthMm: 800, ventilation: 'forced', switchType: 'SION 3AE1', mlfb: '3AE1186-7' },
  { voltageKv: 12, shortCircuitKa: 40, feederCurrentA: 3600, busbarCurrentA: 3600, panelWidthMm: 800, ventilation: 'forced', switchType: 'SION 3AE1', mlfb: '3AE1186-7' },
  { voltageKv: 17.5, shortCircuitKa: 25, feederCurrentA: 630, busbarCurrentA: 1250, panelWidthMm: 600, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5225-1' },
  { voltageKv: 17.5, shortCircuitKa: 25, feederCurrentA: 1000, busbarCurrentA: 1250, panelWidthMm: 600, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5225-2' },
  { voltageKv: 17.5, shortCircuitKa: 25, feederCurrentA: 1250, busbarCurrentA: 2500, panelWidthMm: 800, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5285-2' },
  { voltageKv: 17.5, shortCircuitKa: 25, feederCurrentA: 2500, busbarCurrentA: 2500, panelWidthMm: 800, ventilation: 'natural', switchType: 'SION 3AE5', mlfb: '3AE5285-6' },
  { voltageKv: 17.5, shortCircuitKa: 25, feederCurrentA: 2500, busbarCurrentA: 2500, panelWidthMm: 800, ventilation: 'forced', switchType: 'SION 3AE5', mlfb: '3AE5285-6' },
  { voltageKv: 17.5, shortCircuitKa: 25, feederCurrentA: 2500, busbarCurrentA: 3150, panelWidthMm: 800, ventilation: 'forced', switchType: 'SION 3AE1', mlfb: '3AE1286-7' },
  { voltageKv: 17.5, shortCircuitKa: 31.5, feederCurrentA: 630, busbarCurrentA: 1250, panelWidthMm: 600, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5225-1' },
  { voltageKv: 17.5, shortCircuitKa: 31.5, feederCurrentA: 1000, busbarCurrentA: 1250, panelWidthMm: 800, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5225-2' },
  { voltageKv: 17.5, shortCircuitKa: 31.5, feederCurrentA: 1250, busbarCurrentA: 1250, panelWidthMm: 800, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5285-2' },
  { voltageKv: 17.5, shortCircuitKa: 31.5, feederCurrentA: 2500, busbarCurrentA: 2500, panelWidthMm: 800, ventilation: 'natural', switchType: 'SION 3AE5', mlfb: '3AE5285-6' },
  { voltageKv: 17.5, shortCircuitKa: 31.5, feederCurrentA: 2500, busbarCurrentA: 2500, panelWidthMm: 800, ventilation: 'forced', switchType: 'SION 3AE15', mlfb: '3AE5285-6' },
  { voltageKv: 17.5, shortCircuitKa: 31.5, feederCurrentA: 2500, busbarCurrentA: 3150, panelWidthMm: 800, ventilation: 'forced', switchType: 'SION 3AE1', mlfb: '3AE1286-7' },
  { voltageKv: 17.5, shortCircuitKa: 31.5, feederCurrentA: 2500, busbarCurrentA: 3600, panelWidthMm: 800, ventilation: 'forced', switchType: 'SION 3AE1', mlfb: '3AE1286-7' },
  { voltageKv: 17.5, shortCircuitKa: 40, feederCurrentA: 1000, busbarCurrentA: 1250, panelWidthMm: 800, ventilation: 'without', switchType: 'SION 3AE5', mlfb: '3AE5286-2' },
  { voltageKv: 17.5, shortCircuitKa: 40, feederCurrentA: 1250, busbarCurrentA: 1250, panelWidthMm: 800, ventilation: 'without', switchType: 'SION 3AE1', mlfb: '3AE1286-2' },
  { voltageKv: 17.5, shortCircuitKa: 40, feederCurrentA: 2500, busbarCurrentA: 2500, panelWidthMm: 800, ventilation: 'natural', switchType: 'SION 3AE5', mlfb: '3AE5286-7' },
  { voltageKv: 17.5, shortCircuitKa: 40, feederCurrentA: 2500, busbarCurrentA: 3150, panelWidthMm: 800, ventilation: 'natural', switchType: 'SION 3AE1', mlfb: '3AE1286-7' },
  { voltageKv: 17.5, shortCircuitKa: 40, feederCurrentA: 2500, busbarCurrentA: 3150, panelWidthMm: 800, ventilation: 'forced', switchType: 'SION 3AE1', mlfb: '3AE1286-7' },
  { voltageKv: 17.5, shortCircuitKa: 40, feederCurrentA: 2500, busbarCurrentA: 3600, panelWidthMm: 800, ventilation: 'forced', switchType: 'SION 3AE1', mlfb: '3AE1286-7' },
];

/**
 * Maximum permissible current, keyed `busbar|ventilation`.
 *
 * Each entry is `[50 Hz, 60 Hz]`, and each of those is the seven ambient
 * temperatures 25 °C to 55 °C in steps of 5.
 */
const MAX_CURRENT: Record<string, [number[], number[]]> = {
  '1250|without': [[900, 865, 830, 790, 750, 705, 660], [900, 865, 830, 790, 750, 705, 660]],
  '1600|without': [[1125, 1090, 1055, 1015, 975, 935, 890], [1125, 1090, 1055, 1015, 975, 935, 890]],
  '2500|without': [[2500, 2500, 2500, 2500, 2415, 2325, 2230], [2500, 2500, 2500, 2500, 2415, 2325, 2230]],
  '2500|natural': [[2500, 2500, 2500, 2500, 2500, 2500, 2500], [2500, 2500, 2500, 2500, 2500, 2500, 2500]],
  '2500|forced': [[2500, 2500, 2500, 2500, 2500, 2500, 2500], [2500, 2500, 2500, 2500, 2500, 2500, 2500]],
  '3150|natural': [[3000, 3000, 3000, 2990, 2890, 2785, 2675], [3000, 3000, 2955, 2860, 2760, 2660, 2555]],
  '3150|forced': [[3000, 3000, 3000, 2990, 2890, 2785, 2675], [3000, 3000, 2955, 2860, 2760, 2660, 2555]],
  '3600|forced': [[3600, 3600, 3600, 3600, 3600, 3585, 3440], [3600, 3600, 3600, 3600, 3600, 3485, 3350]],
};

/** The rated current a busbar may actually carry at this temperature. */
function maxCurrent(busbar: number, vent: string, tempC: number, freqHz: number): number {
  const table = MAX_CURRENT[`${busbar}|${vent}`];
  if (!table) return busbar;                     // the catalogue does not derate it
  const t = Math.min(6, Math.max(0, Math.floor((tempC - 25) / 5)));
  return table[freqHz === 60 ? 1 : 0][t];
}

/**
 * The narrowest, least-ventilated panel that carries this feeder.
 *
 * Exactly the original's rule: the rows at this voltage whose short-circuit
 * rating is at least what is asked, narrowed to the lowest such rating; then
 * the ones whose feeder current and derated busbar both reach the required
 * current; then the smallest feeder, the narrowest panel, and the least
 * ventilation, in that order. Null when nothing in the table will do.
 */
export function selectWorldPanel(
  voltageKv: number | null, shortCircuitKa: number | null,
  requiredFeederA: number | null, ambientTempC: number | null, freqHz: number | null,
): PanelConfig | null {
  const candidates = SIMOPRIME_WORLD_PANELS
    .filter(r => r.voltageKv === voltageKv && r.shortCircuitKa >= (shortCircuitKa ?? 0));
  if (candidates.length === 0) return null;

  const lowest = Math.min(...candidates.map(r => r.shortCircuitKa));
  const rank = (v: string) => (v === 'without' ? 0 : v === 'natural' ? 1 : 2);

  return candidates
    .filter(r => r.shortCircuitKa === lowest)
    .filter(r => {
      const max = maxCurrent(r.busbarCurrentA, r.ventilation, ambientTempC ?? 1, freqHz ?? 1);
      return r.feederCurrentA >= (requiredFeederA ?? 0) && max >= (requiredFeederA ?? 0);
    })
    .sort((a, b) =>
      a.feederCurrentA - b.feederCurrentA
      || a.panelWidthMm - b.panelWidthMm
      || rank(a.ventilation) - rank(b.ventilation))[0] ?? null;
}
