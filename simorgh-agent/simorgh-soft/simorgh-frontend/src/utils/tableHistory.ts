// src/utils/tableHistory.ts
//
// Undo for a table, as a few rules with no React in them.
//
// The Device Selection grid is the one place in this app where a single action
// changes or removes a hundred rows at once — an import, a paste, a delete of
// everything that is selected. Ctrl+Z there is not a convenience, it is the
// difference between a mistake that costs a second and one that costs an
// afternoon.
//
// Two rules make the difference between five useful steps and five useless
// ones:
//
//   **A step is the shape of the table changing** — a row added, removed or
//   reordered — and those are always recorded.
//
//   **Typing coalesces.** Every keystroke in a cell is a new rows array, so
//   recording each one would fill all five steps with the letters of one word
//   and undo would reach no further back than that word. Within the quiet
//   window, edits that leave the table the same size are one step.

export interface History<T> {
  /** Older states, oldest first. The last one is what undo goes back to. */
  past: T[][];
  /** States undone out of, newest first. */
  future: T[][];
  /** When the newest step was recorded, for the coalescing window. */
  at: number;
}

export const emptyHistory = <T>(): History<T> => ({ past: [], future: [], at: 0 });

/** How long a run of edits of the same shape counts as one step. */
export const COALESCE_MS = 800;

/**
 * The history after a change, or the same history when the change is not a
 * step of its own.
 *
 * `before` is compared by identity as well as by length: React may run a state
 * updater twice for the same change, and that is one edit, not two.
 */
export function record<T>(
  history: History<T>, before: T[], after: T[], depth: number, now: number,
): History<T> {
  if (before === after) return history;
  if (history.past[history.past.length - 1] === before) return history;

  const structural = before.length !== after.length;
  if (!structural && now - history.at < COALESCE_MS) return history;

  return {
    past: [...history.past, before].slice(-depth),
    future: [],                       // a new edit is a new branch
    at: now,
  };
}

/** One step back, or null when there is nowhere to go. */
export function undo<T>(
  history: History<T>, current: T[], depth: number,
): { history: History<T>; value: T[] } | null {
  const previous = history.past[history.past.length - 1];
  if (!previous) return null;
  return {
    value: previous,
    history: {
      past: history.past.slice(0, -1),
      future: [current, ...history.future].slice(0, depth),
      // The next edit starts a step of its own rather than joining the one
      // that was just undone.
      at: 0,
    },
  };
}

/** One step forward, for an undo that went one too far. */
export function redo<T>(
  history: History<T>, current: T[], depth: number,
): { history: History<T>; value: T[] } | null {
  const next = history.future[0];
  if (!next) return null;
  return {
    value: next,
    history: {
      past: [...history.past, current].slice(-depth),
      future: history.future.slice(1),
      at: 0,
    },
  };
}
