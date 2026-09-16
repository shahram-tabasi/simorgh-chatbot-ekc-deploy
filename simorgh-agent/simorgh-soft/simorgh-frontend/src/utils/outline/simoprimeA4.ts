// src/utils/outline/simoprimeA4.ts
//
// The SIMOPRIME A4 busbar table, as Eplanix holds it.
//
// Ported from `Eplanix/Models/OutlineModels/SimoprimeA4CurrentAnalyzer.cs`,
// generated from the C# rather than retyped. It answers the same one question
// the original is asked by the outline: which busbar arrangement carries this
// current at this temperature and frequency, and therefore what ventilation
// the cell needs.

export interface BusbarConfiguration {
  mainBusbar: string;
  /** 'Without' | 'Natural' | 'Forced Ventilation'. */
  ventilation: string;
  frequency: number;
  /** Rated current by ambient temperature in °C — 25 to 55 in steps of 5. */
  currentByTemperature: Record<number, number>;
}

export const SIMOPRIME_A4_BUSBARS: BusbarConfiguration[] = [
  { mainBusbar: '80 X 10 X1', ventilation: 'Without', frequency: 50, currentByTemperature: { 25: 1065, 30: 953, 35: 867, 40: 800, 45: 745, 50: 698, 55: 658 } },
  { mainBusbar: '100 X 10 X 1', ventilation: 'Without', frequency: 50, currentByTemperature: { 25: 1400, 30: 1250, 35: 1138, 40: 1050, 45: 981, 50: 916, 55: 864 } },
  { mainBusbar: '80 X 10 X 1', ventilation: 'Natural', frequency: 50, currentByTemperature: { 25: 1665, 30: 1490, 35: 1356, 40: 1250, 45: 1163, 50: 1090, 55: 1030 } },
  { mainBusbar: '80 X 10 X 2', ventilation: 'Natural', frequency: 50, currentByTemperature: { 25: 2245, 30: 2120, 35: 1979, 40: 1850, 45: 1705, 50: 1554, 55: 1387 } },
  { mainBusbar: '100 X 10 X 2', ventilation: 'Forced Ventilation', frequency: 50, currentByTemperature: { 25: 3320, 30: 2980, 35: 2712, 40: 2500, 45: 2330, 50: 2180, 55: 2055 } },
  { mainBusbar: '80 X 10 X 1', ventilation: 'Without', frequency: 60, currentByTemperature: { 25: 1058, 30: 945, 35: 860, 40: 795, 45: 738, 50: 693, 55: 650 } },
  { mainBusbar: '100 X 10 X 1', ventilation: 'Without', frequency: 60, currentByTemperature: { 25: 1360, 30: 1205, 35: 1095, 40: 1000, 45: 930, 50: 860, 55: 815 } },
  { mainBusbar: '80 X 10 X 1', ventilation: 'Natural', frequency: 60, currentByTemperature: { 25: 1598, 30: 1430, 35: 1300, 40: 1200, 45: 1116, 50: 1047, 55: 988 } },
  { mainBusbar: '80 X 10 X 2', ventilation: 'Natural', frequency: 60, currentByTemperature: { 25: 2595, 30: 2320, 35: 2115, 40: 1950, 45: 1814, 50: 1700, 55: 1605 } },
  { mainBusbar: '100 X 10 X 2', ventilation: 'Forced Ventilation', frequency: 60, currentByTemperature: { 25: 3263, 30: 2919, 35: 2657, 40: 2450, 45: 2279, 50: 2138, 55: 2017 } },
];

/**
 * The tightest arrangement that still carries the current.
 *
 * The original's rule exactly: among the rows of this frequency that state a
 * rating at this temperature, the ones rated at or above the current, and of
 * those the one with the least headroom. Null when the current is above
 * everything the table holds, which is the original's answer too.
 */
export function findBestA4Configuration(
  temperature: number, frequency: number, current: number,
): BusbarConfiguration | null {
  let best: BusbarConfiguration | null = null;
  let closest = Number.POSITIVE_INFINITY;
  for (const config of SIMOPRIME_A4_BUSBARS) {
    if (config.frequency !== frequency) continue;
    const rated = config.currentByTemperature[temperature];
    if (rated == null || current > rated) continue;
    if (rated - current < closest) {
      closest = rated - current;
      best = config;
    }
  }
  return best;
}
