// src/utils/plc/ladderEdit.ts
//
// Changing a rung, without ever leaving it in a shape that cannot be drawn.
//
// The ladder model is a grid on purpose (see `utils/ladder/model.ts`): groups
// in series, branches in parallel inside a group, elements in series inside a
// branch. That shape is what lets a rung be drawn with no layout engine and
// checked with no solver — and it is also a shape that is easy to break by
// hand. An empty group, a branch with no parent, a group holding zero
// branches: each of those draws as a hole in the rail or throws while
// rendering.
//
// So every edit goes through a function here, each of which takes a rung and
// gives back a rung that is still legal. They are pure — nothing is mutated —
// because the editor keeps history by keeping old rungs, and a mutation would
// quietly rewrite what somebody is about to undo to.
//
// A **position** is where the cursor is: which group, which branch, which slot
// between elements. Slot `n` means "before element n", and slot `elements
// .length` means "at the end", which is the one convention that makes insert
// and append the same operation.

import { Block, Branch, Coil, Contact, Element, Group, Rung } from '../ladder/model';
import { Instruction } from './instructions';
import { PlcNetwork } from './model';

/** Where the cursor is in a rung. */
export interface LadderPos {
  group: number;
  branch: number;
  /** Before which element. `elements.length` is the end of the branch. */
  slot: number;
}

export const samePos = (a: LadderPos | null, b: LadderPos | null): boolean =>
  !!a && !!b && a.group === b.group && a.branch === b.branch && a.slot === b.slot;

/** A rung with no groups still has one place to put something. */
export const firstPos = (): LadderPos => ({ group: 0, branch: 0, slot: 0 });

const clone = (rung: Rung): Rung => ({
  ...rung,
  groups: rung.groups.map(g => ({ branches: g.branches.map(b => ({ elements: [...b.elements] })) })),
  outputs: [...rung.outputs],
});

/** An empty group with one empty branch — the smallest legal group. */
const emptyGroup = (): Group => ({ branches: [{ elements: [] }] });

/**
 * The rung, with every group that holds nothing taken out.
 *
 * Run after every removal. A group whose branches are all empty is not a
 * "blank column" an engineer left deliberately — it is the leftover of
 * deleting the last contact in it, and leaving it there means the rung drifts
 * wider every time something is deleted and re-added.
 *
 * The exception is a group with more than one branch: two empty branches side
 * by side are a parallel path being built, and emptying one of them while
 * typing the other must not collapse it.
 */
function tidy(rung: Rung): Rung {
  const groups = rung.groups.filter(g =>
    g.branches.length > 1 || g.branches.some(b => b.elements.length > 0));
  return { ...rung, groups };
}

// ── What goes on a rung ─────────────────────────────────────────────────────

/** A new element for this instruction, with its pins already named. */
export function elementFor(instr: Instruction, operand = ''): Element | null {
  if (instr.form === 'contact' && instr.contactKind) {
    return { k: instr.contactKind, at: operand, label: undefined };
  }
  if (instr.form === 'box' || (instr.form === 'contact' && !instr.contactKind)) {
    const block: Block = {
      k: 'block',
      type: instr.name,
      name: instr.instance ? '' : undefined,
      pins: (instr.pins ?? []).map(p => ({ name: p.name, value: '', out: p.out })),
      label: instr.title,
    };
    return block;
  }
  return null;
}

/** A new output for this instruction, where it is one. */
export function coilFor(instr: Instruction, operand = ''): Coil | null {
  if (instr.form !== 'coil') return null;
  return { k: instr.coilKind ?? 'coil', at: operand, label: undefined };
}

// ── Inserting ───────────────────────────────────────────────────────────────

/**
 * An element put in at a position.
 *
 * Every element is its own group. That is not a simplification — it is what
 * series means: two contacts side by side on the rail are two groups of one
 * branch each, and only a deliberate parallel makes a group with two. Putting
 * them in the same group would draw them stacked, which is the opposite of
 * what was asked for.
 *
 * The exception is inserting into a branch that already has elements, where
 * the new one joins that branch in series — because that branch is a path, and
 * a path is a series.
 */
export function insertElement(rung: Rung, pos: LadderPos, element: Element): Rung {
  const next = clone(rung);

  // Into a rung with nothing on it, or past the last group: a new group.
  if (pos.group >= next.groups.length) {
    next.groups.push({ branches: [{ elements: [element] }] });
    return next;
  }

  const group = next.groups[pos.group];
  const branch = group.branches[pos.branch] ?? group.branches[0];
  if (!branch) {
    group.branches.push({ elements: [element] });
    return next;
  }

  // An empty branch takes it; a branch with something in it takes it in
  // series at the slot.
  const at = Math.max(0, Math.min(pos.slot, branch.elements.length));
  branch.elements.splice(at, 0, element);
  return next;
}

/** A whole new group, in series, before the given one. */
export function insertGroup(rung: Rung, at: number, element?: Element): Rung {
  const next = clone(rung);
  const group: Group = element
    ? { branches: [{ elements: [element] }] }
    : emptyGroup();
  next.groups.splice(Math.max(0, Math.min(at, next.groups.length)), 0, group);
  return next;
}

/**
 * A branch in parallel with the one the cursor is in.
 *
 * This is the open-branch command, and it is the one edit that changes what a
 * rung *means* rather than what is on it: everything in the group is now an
 * OR. So it adds an empty branch and leaves the cursor free to fill it, rather
 * than guessing at a contact to put there.
 */
export function addParallelBranch(rung: Rung, group: number): Rung {
  const next = clone(rung);
  if (group >= next.groups.length) {
    next.groups.push({ branches: [{ elements: [] }, { elements: [] }] });
    return next;
  }
  next.groups[group].branches.push({ elements: [] });
  return next;
}

/** The element at a position taken out. */
export function removeElement(rung: Rung, pos: LadderPos): Rung {
  const next = clone(rung);
  const group = next.groups[pos.group];
  if (!group) return rung;
  const branch = group.branches[pos.branch];
  if (!branch) return rung;
  if (pos.slot < 0 || pos.slot >= branch.elements.length) return rung;
  branch.elements.splice(pos.slot, 1);

  // A branch emptied out of a group that has others goes with it — an empty
  // parallel path is a wire straight through, which changes the logic to
  // "always true" without anybody asking for that.
  if (branch.elements.length === 0 && group.branches.length > 1) {
    group.branches.splice(pos.branch, 1);
  }
  return tidy(next);
}

/** A whole parallel branch taken out. */
export function removeBranch(rung: Rung, group: number, branch: number): Rung {
  const next = clone(rung);
  const g = next.groups[group];
  if (!g || g.branches.length <= 1) return removeGroup(rung, group);
  g.branches.splice(branch, 1);
  return tidy(next);
}

/** A whole group taken out — everything in that column of the rung. */
export function removeGroup(rung: Rung, group: number): Rung {
  const next = clone(rung);
  if (group < 0 || group >= next.groups.length) return rung;
  next.groups.splice(group, 1);
  return next;
}

/** One element replaced in place, keeping its position. */
export function replaceElement(rung: Rung, pos: LadderPos, element: Element): Rung {
  const next = clone(rung);
  const branch = next.groups[pos.group]?.branches[pos.branch];
  if (!branch || pos.slot >= branch.elements.length) return rung;
  branch.elements[pos.slot] = element;
  return next;
}

/**
 * What may be changed about an element in place.
 *
 * `k` is left out on purpose: a contact turned into a box by patching one
 * field would keep the contact's `at` and grow a `pins` array beside it, which
 * is neither thing. Changing what an element *is* replaces it — that is what
 * `replaceElement` is for.
 */
export type ElementPatch = Partial<Omit<Contact, 'k'>> & Partial<Omit<Block, 'k'>>;

/** One field of the element at a position. */
export function patchElement(rung: Rung, pos: LadderPos, patch: ElementPatch): Rung {
  const next = clone(rung);
  const branch = next.groups[pos.group]?.branches[pos.branch];
  const el = branch?.elements[pos.slot];
  if (!branch || !el) return rung;
  branch.elements[pos.slot] = { ...el, ...patch } as Element;
  return next;
}

/** One pin of a box on the rung. */
export function patchPin(rung: Rung, pos: LadderPos, pin: string, value: string): Rung {
  const next = clone(rung);
  const branch = next.groups[pos.group]?.branches[pos.branch];
  const el = branch?.elements[pos.slot];
  if (!branch || !el || el.k !== 'block') return rung;
  branch.elements[pos.slot] = {
    ...el,
    pins: el.pins.map(p => (p.name === pin ? { ...p, value } : p)),
  };
  return next;
}

// ── The right-hand end ──────────────────────────────────────────────────────

export function addOutput(rung: Rung, coil: Coil, at?: number): Rung {
  const next = clone(rung);
  const index = at === undefined ? next.outputs.length : Math.max(0, Math.min(at, next.outputs.length));
  next.outputs.splice(index, 0, coil);
  return next;
}

export function patchOutput(rung: Rung, at: number, patch: Partial<Coil>): Rung {
  const next = clone(rung);
  if (at < 0 || at >= next.outputs.length) return rung;
  next.outputs[at] = { ...next.outputs[at], ...patch };
  return next;
}

export function removeOutput(rung: Rung, at: number): Rung {
  const next = clone(rung);
  if (at < 0 || at >= next.outputs.length) return rung;
  next.outputs.splice(at, 1);
  return next;
}

// ── Moving around ───────────────────────────────────────────────────────────

/** Every slot on the rung, left to right and top to bottom. */
export function positions(rung: Rung): LadderPos[] {
  const out: LadderPos[] = [];
  rung.groups.forEach((g, gi) => {
    g.branches.forEach((b, bi) => {
      for (let s = 0; s <= b.elements.length; s += 1) out.push({ group: gi, branch: bi, slot: s });
    });
  });
  if (out.length === 0) out.push(firstPos());
  return out;
}

/** The element a position points at, if it points at one. */
export function elementAt(rung: Rung, pos: LadderPos): Element | null {
  return rung.groups[pos.group]?.branches[pos.branch]?.elements[pos.slot] ?? null;
}

/** How wide the rung is, in element columns — what the sheet has to hold. */
export function rungWidth(rung: Rung): number {
  return rung.groups.reduce(
    (sum, g) => sum + Math.max(1, ...g.branches.map(b => b.elements.length)), 0);
}

/**
 * A rung is a grid this app can draw, or it is not.
 *
 * The one shape that genuinely cannot be written as groups-of-branches is a
 * bridged network — current flowing sideways through the middle of two
 * parallel paths. Nothing in this editor can make one, so this is here for
 * what arrives from elsewhere: a saved file, an assistant, an import.
 */
export function fitsGrid(rung: Rung): boolean {
  return rung.groups.every(g => g.branches.length > 0);
}

/** A deep copy, for the clipboard. */
export const copyRung = (rung: Rung): Rung => clone(rung);

/** A branch copied out of a rung, for pasting into another. */
export function copyBranch(rung: Rung, group: number, branch: number): Branch | null {
  const b = rung.groups[group]?.branches[branch];
  return b ? { elements: b.elements.map(e => ({ ...e })) } : null;
}

// ── Putting an instruction on a rung ────────────────────────────────────────

/** Where the ladder cursor is: which network, and where in its rung. */
export interface LadderCursor {
  netId: string;
  pos: LadderPos;
}

/**
 * The networks, with the instruction put where the cursor is.
 *
 * It lives here rather than in the editor because two things do it: the
 * editor, when a slot is clicked with something armed, and the page, when an
 * instruction is double-clicked in the catalogue. Two copies of this would be
 * two sets of rules about where a coil goes, and the second one to be changed
 * would be the one somebody is using.
 *
 * Three rules, and each of them is about what the rung can actually hold:
 *
 *   * a **coil** goes to the right-hand end whatever is selected, because
 *     that is the only place a coil can be;
 *   * a slot that points at an existing **branch** goes into that branch —
 *     including an empty one, which is a parallel path waiting to be filled;
 *   * anything else is a **new column** at the end.
 */
export function placeInstruction(
  networks: PlcNetwork[], cursor: LadderCursor | null, instr: Instruction,
): { networks: PlcNetwork[]; cursor: LadderCursor | null } | null {
  if (networks.length === 0) return null;
  const netId = cursor?.netId ?? networks[0].id;
  const index = networks.findIndex(n => n.id === netId);
  if (index < 0) return null;
  const net = networks[index];
  const pos = cursor?.pos ?? { group: net.rung.groups.length, branch: 0, slot: 0 };

  const replace = (rung: Rung, next: LadderCursor | null) => ({
    networks: networks.map((n, i) => (i === index ? { ...n, rung } : n)),
    cursor: next,
  });

  if (instr.form === 'coil') {
    const coil = coilFor(instr);
    return coil ? replace(addOutput(net.rung, coil), cursor) : null;
  }
  if (instr.id === 'gen.branch.open') {
    const branches = net.rung.groups[pos.group]?.branches.length ?? 1;
    return replace(addParallelBranch(net.rung, pos.group), {
      netId, pos: { group: pos.group, branch: branches, slot: 0 },
    });
  }
  if (instr.form === 'editor') return null;

  const element = elementFor(instr);
  if (!element) return null;
  const branch = net.rung.groups[pos.group]?.branches[pos.branch];
  const rung = branch
    ? insertElement(net.rung, pos, element)
    : insertGroup(net.rung, pos.group, element);
  const after: LadderCursor = branch
    ? { netId, pos: { ...pos, slot: pos.slot + 1 } }
    : { netId, pos: { group: pos.group, branch: 0, slot: 1 } };
  return replace(rung, after);
}
