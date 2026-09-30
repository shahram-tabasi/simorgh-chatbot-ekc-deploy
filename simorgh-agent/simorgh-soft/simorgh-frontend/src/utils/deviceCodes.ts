// src/utils/deviceCodes.ts
//
// FEEDER NO. and SFD/HFD are codes, not prose.
//
// They are typed by a dozen people over the life of a job, pasted out of
// spreadsheets written by a dozen more, and read back by everything
// downstream: the single line looks a feeder up by its number, the mechanical
// take-off groups by SFD/HFD, the BPMS export keys on both. "F 12", "f12" and
// "F12" are one feeder to a person and three to every one of those, which is
// how a drawing ends up with a feeder that appears twice and a take-off that
// counts it once.
//
// So they are folded to one spelling on the way in, wherever they come from:
// upper case, no spaces. Nothing else is touched — a dash, a slash or a dot is
// part of the code and stays.

/** A code as it is stored: upper case, no spaces. */
export function codeCase(value: unknown): string {
  return String(value ?? '')
    // Every kind of space, including the non-breaking one a paste from Excel
    // or a Persian keyboard leaves behind, which looks like nothing at all.
    .replace(/[\s ​-‏⁠]+/g, '')
    .toUpperCase();
}

/** A row, as far as this file cares: the two fields that are codes. */
export interface HasCodes {
  feederNo?: string;
  sfdHfd?: string;
}

/** The fields that are codes rather than words. */
const CODE_FIELDS = ['feederNo', 'sfdHfd'] as const;

/**
 * One row with its codes folded.
 *
 * Returns the row untouched when nothing changed, so React sees the same
 * object and a table of five hundred rows does not re-render because somebody
 * typed in one of them.
 */
export function withCodeCase<T extends HasCodes>(row: T): T {
  let next: T | null = null;
  for (const field of CODE_FIELDS) {
    const current = row[field];
    if (current === undefined) continue;
    const folded = codeCase(current);
    if (folded === current) continue;
    next = next ?? { ...row };
    next[field] = folded;
  }
  return next ?? row;
}

/** Every row with its codes folded, and the same array when none changed. */
export function withCodeCaseAll<T extends HasCodes>(rows: T[]): T[] {
  let changed = false;
  const next = rows.map(row => {
    const folded = withCodeCase(row);
    if (folded !== row) changed = true;
    return folded;
  });
  return changed ? next : rows;
}
