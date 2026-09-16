// src/utils/outline/poleCenter.ts
//
// What a 3AE5 order code says about the breaker inside it.
//
// A SION order number is not a name, it is a specification: position 5 is the
// rated voltage, 6 the pole centre distance, 7 the short-circuit breaking
// current, and 6 and 8 together the vertical distance and the rated current.
// The outline needs the pole centre — it is what sets the cell width — and the
// estimate sheets need the rated current, which for a 3AE5 cell is the
// breaker's own rather than the CT's.
//
// Ported position for position from `GetPoleCenter` in
// `Eplanix/Services/OutlineService.cs`, including its exceptions: 24 kV admits
// only two pole centres, and the 275 mm case that would otherwise read 210.

export interface PoleCenter {
  valid: boolean;
  /** Why not, when it is not — "this feeder don't have cb" and so on. */
  error: string;
  ratedVoltage: number;
  shortCircuitCurrent: number;
  poleCenterDistance: number;
  verticalDistance: number;
  ratedCurrent: number;
}

const blank = (error: string): PoleCenter => ({
  valid: false, error,
  ratedVoltage: 0, shortCircuitCurrent: 0,
  poleCenterDistance: 0, verticalDistance: 0, ratedCurrent: 0,
});

/** Vertical distance and rated current, by pole-centre digit and current digit. */
const VDT_AND_CURRENT: Record<string, [number, number]> = {
  // PCD = 150
  '0|1': [205, 800],  '0|2': [205, 1250],
  // PCD = 160
  '1|1': [205, 800],  '1|2': [205, 1250],
  '3|1': [205, 800],  '3|2': [205, 1250],
  '4|1': [205, 800],  '4|2': [205, 1250],
  // PCD = 210
  '2|1': [310, 800],  '2|2': [310, 1250], '2|3': [310, 1600], '2|4': [310, 2000],
  '2|6': [310, 2500], '2|7': [310, 3150], '2|8': [310, 4000],

  '5|1': [205, 800],  '5|2': [205, 1250],

  '6|1': [205, 800],  '6|2': [205, 1250], '6|3': [275, 1600], '6|4': [310, 2000],
  '6|6': [275, 2500], '6|7': [275, 3150], '6|8': [275, 4000],

  '8|1': [310, 800],  '8|2': [310, 1250], '8|3': [310, 1600], '8|4': [310, 2000],
  '8|6': [310, 2500], '8|7': [310, 3150], '8|8': [310, 4000],
  // PCD = 275
  '7|1': [275, 800],  '7|2': [275, 1250], '7|3': [275, 1600], '7|4': [310, 2000],
  '7|6': [310, 2500],
};

/**
 * Decode a breaker's order code.
 *
 * `code` is the maker's code for the part on the feeder that is the breaker —
 * TPMS's Scode, and for a part added by hand its order number. Anything that
 * is not a 3AE5 code comes back invalid with the reason, which is what the
 * callers test: a cell whose breaker is a 3AH5 has no pole centre to read here.
 */
export function decodePoleCenter(rawCode: string | null | undefined): PoleCenter {
  const raw = String(rawCode ?? '');
  if (!raw.trim()) return blank("this feeder don't have cb");

  const code = raw.replace(/-/g, '').replace(/ /g, '').trim();
  if (code.length < 8) return blank('Code is too short. Minimum 8 characters required.');
  if (!code.startsWith('3AE5')) return blank("Code must start with '3AE5'");

  const pos5 = code[4];
  const pos6 = code[5];
  const pos7 = code[6];
  const pos8 = code[7];

  const ratedVoltage = ({
    '0': 7.2, '1': 12.0, '2': 17.5, '3': 24.0,
    '5': 12.0, '6': 17.5, '7': 24.0,
  } as Record<string, number>)[pos5] ?? 0;

  let poleCenterDistance: number;
  if (pos5 === '3') {
    // 24 kV: only these two exist, and nothing else is a valid combination.
    poleCenterDistance = pos6 === '2' ? 210 : pos6 === '5' ? 275 : 0;
  } else if (pos6 === '8' && pos5 === '5') {
    poleCenterDistance = 275;
  } else {
    poleCenterDistance = '012'.includes(pos6) ? 150
      : '345'.includes(pos6) ? 160
      : '678'.includes(pos6) ? 210
      : 0;
  }

  const shortCircuitCurrent = ({
    '2': 16, '3': 20, '4': 25, '5': 31, '6': 40,
  } as Record<string, number>)[pos7] ?? 0;

  const [verticalDistance, ratedCurrent] = VDT_AND_CURRENT[`${pos6}|${pos8}`] ?? [0, 0];

  const valid = poleCenterDistance > 0 && ratedVoltage > 0
    && shortCircuitCurrent > 0 && ratedCurrent > 0;

  return {
    valid,
    error: valid ? '' : 'Invalid code combination. Please check the product code.',
    ratedVoltage, shortCircuitCurrent, poleCenterDistance, verticalDistance, ratedCurrent,
  };
}
