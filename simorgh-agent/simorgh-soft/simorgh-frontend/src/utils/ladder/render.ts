// src/utils/ladder/render.ts
//
// Drawing a ladder program.
//
// Onto the same shape model as everything else in this app, which is the whole
// reason it is worth doing here rather than in a picture: a rendered rung goes
// out as DXF and PDF, opens in the editor, and sits on a page beside the wiring
// diagram it belongs to. A screenshot of somebody's programming software does
// none of that.
//
// The layout is measured before anything is drawn. A rung's height depends on
// how many branches its widest group has, its width on how many elements sit in
// series, and a block is taller than a contact — so the geometry is worked out
// first and committed second. Drawing and measuring in one pass is how a rung
// ends up overlapping the one below it.

import { Drawing, Layer, Pt, Shape } from '../cad/shapes';
import { Dialect, dialectOf } from './dialects';
import { Block, Coil, Contact, Element, LadderProgram, Rung } from './model';

// ── The grid ───────────────────────────────────────────────────────────────

/** Width of one element cell along a rung. */
const COL = 46;
/** Vertical pitch between parallel branches. */
const BRANCH = 26;
/**
 * Vertical pitch between stacked outputs.
 *
 * More than a branch needs, because two coils carry four lines of text between
 * them — address above each and function below — and at the branch pitch the
 * lower coil's address landed on the upper one's description.
 */
const OUTPUT_PITCH = 30;
/**
 * Gap under a rung before the next one's comment.
 *
 * Wide enough for the description written under the last branch and under the
 * last coil: the measured height covers where the wires are, and the text hangs
 * below them. Without the allowance the next rung's comment landed on the
 * previous rung's labels.
 */
const RUNG_GAP = 24;
/** Height of the comment line above a rung. */
const COMMENT = 9;
/** Where the left rail stands, and how far the rung number sits from it. */
const RAIL_LEFT = 26;
const NUMBER_X = 8;
/** How much of the sheet the outputs keep on the right. */
const OUTPUT_COL = 52;

const TEXT = 3.4;
const SMALL = 2.9;

const line = (x1: number, y1: number, x2: number, y2: number,
  layer: Layer = 'WIRE', width = 1): Shape => ({ t: 'line', x1, y1, x2, y2, layer, width });

const text = (x: number, y: number, s: string, size = TEXT,
  layer: Layer = 'TEXT', anchor: 'start' | 'middle' | 'end' = 'middle'): Shape =>
  ({ t: 'text', x, y, s, size, anchor, layer });

const rect = (x: number, y: number, w: number, h: number,
  layer: Layer = 'SYMBOL'): Shape => ({ t: 'rect', x, y, w, h, layer, width: 1 });

// ── Measuring ──────────────────────────────────────────────────────────────

/** The strip of box above the first pin, holding the block's name. */
const BLOCK_HEAD = 11;

/** How tall a block has to be to show all its pins. */
function blockHeight(block: Block): number {
  const ins = block.pins.filter(p => !p.out).length;
  const outs = block.pins.filter(p => p.out).length;
  return BLOCK_HEAD + Math.max(1, Math.max(ins, outs)) * 8 + 5;
}

/** How wide an element is, in cells. A block takes two; everything else one. */
const cellsOf = (el: Element): number => (el.k === 'block' ? 2 : 1);

/** A branch's width in cells, never less than one so an empty branch has a wire. */
const branchCells = (elements: Element[]): number =>
  Math.max(1, elements.reduce((n, el) => n + cellsOf(el), 0));

interface RungBox {
  /** Cells across, not counting the outputs. */
  cells: number;
  /** Height of the rung's body — the branches, and the tallest block in them. */
  height: number;
  /** Room needed *above* the rung's wire, for a block's name strip. */
  head: number;
}

function measureRung(rung: Rung): RungBox {
  let cells = 0;
  let branches = 1;
  let tallestBlock = 0;

  for (const group of rung.groups) {
    cells += Math.max(1, ...group.branches.map(b => branchCells(b.elements)));
    branches = Math.max(branches, group.branches.length);
    for (const branch of group.branches) {
      for (const el of branch.elements) {
        if (el.k === 'block') tallestBlock = Math.max(tallestBlock, blockHeight(el));
      }
    }
  }

  // Outputs stack down the right-hand side, so they can be what sets the height.
  const outputs = Math.max(1, rung.outputs.length);
  const body = Math.max(
    (branches - 1) * BRANCH,
    (outputs - 1) * OUTPUT_PITCH,
    // A block hangs below the rung it sits on — only its name strip is above —
    // so what it adds to the rung's height is everything under that strip.
    tallestBlock > 0 ? tallestBlock - BLOCK_HEAD : 0,
  );
  return { cells: Math.max(1, cells), height: body, head: tallestBlock > 0 ? BLOCK_HEAD : 0 };
}

/** The whole height a rung occupies, comment and block headroom included. */
const rungHeight = (rung: Rung): number => {
  const box = measureRung(rung);
  return (rung.comment ? COMMENT : 0) + box.head + box.height + RUNG_GAP;
};

// ── Drawing the pieces ─────────────────────────────────────────────────────

/**
 * A contact, centred in its cell.
 *
 * The two bars are the contact; the diagonal makes it normally closed; a P or
 * an N in the middle makes it an edge. The address goes above and whatever it
 * means goes below, which is the arrangement every programming tool uses and
 * therefore the one an electrician already reads without being told.
 */
function drawContact(c: Contact, x: number, y: number, out: Shape[]): void {
  const half = 4;
  out.push(line(x - COL / 2, y, x - half, y));
  out.push(line(x + half, y, x + COL / 2, y));
  out.push(line(x - half, y - 5, x - half, y + 5, 'SYMBOL', 1.2));
  out.push(line(x + half, y - 5, x + half, y + 5, 'SYMBOL', 1.2));

  if (c.k === 'nc') out.push(line(x - half - 1.5, y + 6, x + half + 1.5, y - 6, 'SYMBOL', 1.2));
  if (c.k === 'p' || c.k === 'n') {
    out.push(text(x, y + 1.6, c.k.toUpperCase(), 4, 'SYMBOL'));
  }

  out.push(text(x, y - 8, c.at, TEXT, 'TAG'));
  if (c.label) out.push(text(x, y + 11, c.label, SMALL, 'TEXT'));
}

/** A coil, with S or R inside it where the vendor's is a latch. */
function drawCoil(c: Coil, x: number, y: number, out: Shape[]): void {
  const half = 5;
  out.push(line(x - COL / 2, y, x - half, y));
  // `(` and then `)`. The left bracket is the right-hand side of a circle
  // centred to its right, and the right bracket the left-hand side of one
  // centred to its left. Drawn the other way round — which is the obvious
  // reading of the two numbers — they bulge towards each other and the coil
  // comes out as an hourglass.
  out.push({ t: 'arc', cx: x + half, cy: y, r: 7.5, a0: 140, a1: 220, layer: 'SYMBOL', width: 1.2 });
  out.push({ t: 'arc', cx: x - half, cy: y, r: 7.5, a0: -40, a1: 40, layer: 'SYMBOL', width: 1.2 });

  const inside = c.k === 'set' ? 'S' : c.k === 'reset' ? 'R'
    : c.k === 'pulse-p' ? 'P' : c.k === 'pulse-n' ? 'N' : '';
  if (inside) out.push(text(x, y + 1.6, inside, 4, 'SYMBOL'));

  out.push(text(x, y - 9, c.at, TEXT, 'TAG'));
  if (c.label) out.push(text(x, y + 12, c.label, SMALL, 'TEXT'));
}

/**
 * A function block, with the vendor's own pin names inside it.
 *
 * The names are the point. A box labelled "timer" with "5 s" beside it is a
 * picture of a timer; a box labelled TON with IN, PT, Q and ET on its pins is
 * the thing somebody types into TIA Portal. Which names those are comes from
 * the dialect, which is why this takes one.
 */
function drawBlock(b: Block, x: number, y: number, out: Shape[]): void {
  const w = COL * 2 - 16;
  const h = blockHeight(b);
  const left = x - w / 2;
  // The rung enters at the block's first pin, so that pin is *on* the wire and
  // the box hangs below it. Centring the box on the wire instead pushed its top
  // into the rung comment above, which is where this was first noticed.
  const top = y - BLOCK_HEAD;

  out.push(rect(left, top, w, h));
  out.push(text(x, top + 5, b.type, 4, 'SYMBOL'));
  if (b.name) out.push(text(x, top + 9.5, b.name, SMALL, 'TAG'));

  const ins = b.pins.filter(p => !p.out);
  const outs = b.pins.filter(p => p.out);
  // Pins march down from the rung at a fixed pitch, inputs and outputs in
  // step, so a block's first input and first output are both on the wire.
  const spread = (_count: number, i: number) => y + i * 8;

  ins.forEach((pin, i) => {
    const py = spread(ins.length, i);
    out.push(line(left - 8, py, left, py));
    out.push(text(left + 2, py + 1, pin.name, SMALL, 'SYMBOL', 'start'));
    if (pin.value) out.push(text(left - 9, py - 1.5, pin.value, SMALL, 'TAG', 'end'));
  });

  outs.forEach((pin, i) => {
    const py = spread(outs.length, i);
    out.push(line(left + w, py, left + w + 8, py));
    out.push(text(left + w - 2, py + 1, pin.name, SMALL, 'SYMBOL', 'end'));
    if (pin.value) out.push(text(left + w + 9, py - 1.5, pin.value, SMALL, 'TAG', 'start'));
  });

  // The rung passes through the block: in at its first input, on from its
  // first output. Which pin that is differs by vendor, and on every dialect
  // here it is the first of each.
  out.push(line(x - COL, y, left - 8, y));
  out.push(line(left + w + 8, y, x + COL, y));
}

// ── Drawing a rung ─────────────────────────────────────────────────────────

/**
 * One branch, left to right, returning where it ended.
 *
 * A branch shorter than its group is padded with wire so every branch in a
 * group meets the vertical at the same x — otherwise the parallel bar joins
 * nothing at one end.
 */
function drawBranch(
  elements: Element[], startX: number, y: number, cells: number, out: Shape[],
): void {
  let x = startX;
  for (const el of elements) {
    const span = cellsOf(el) * COL;
    const centre = x + span / 2;
    if (el.k === 'block') drawBlock(el, centre, y, out);
    else drawContact(el, centre, y, out);
    x += span;
  }
  const end = startX + cells * COL;
  if (x < end) out.push(line(x, y, end, y));
}

function drawRung(rung: Rung, top: number, right: number, out: Shape[]): number {
  const box = measureRung(rung);
  let y = top;

  if (rung.comment) {
    out.push(text(RAIL_LEFT, y + 4, rung.comment, SMALL, 'TEXT', 'start'));
    y += COMMENT;
  }

  // Room above the wire for a block's name strip, where the rung has one.
  const wire = y + 6 + box.head;
  out.push(text(NUMBER_X, wire + 1.5, String(rung.number), TEXT, 'TITLE', 'start'));

  let x = RAIL_LEFT;
  for (const group of rung.groups) {
    const cells = Math.max(1, ...group.branches.map(b => branchCells(b.elements)));
    const span = cells * COL;

    group.branches.forEach((branch, i) => {
      drawBranch(branch.elements, x, wire + i * BRANCH, cells, out);
    });

    // The two verticals that make the branches parallel.
    if (group.branches.length > 1) {
      const bottom = wire + (group.branches.length - 1) * BRANCH;
      out.push(line(x, wire, x, bottom));
      out.push(line(x + span, wire, x + span, bottom));
    }
    x += span;
  }

  // Wire on to the outputs, which stack down the right.
  const outX = right - OUTPUT_COL / 2;
  out.push(line(x, wire, outX - COL / 2, wire));
  // Stacked coils hang off one drop wire on the left and one on the right, the
  // way a rung with two outputs is actually drawn.
  const lastY = wire + (rung.outputs.length - 1) * OUTPUT_PITCH;
  if (rung.outputs.length > 1) {
    out.push(line(outX - COL / 2, wire, outX - COL / 2, lastY));
    out.push(line(right, wire, right, lastY));
  }
  rung.outputs.forEach((coil, i) => {
    const cy = wire + i * OUTPUT_PITCH;
    drawCoil(coil, outX, cy, out);
    out.push(line(outX + 5, cy, right, cy));
  });

  return top + (rung.comment ? COMMENT : 0) + box.head + box.height + RUNG_GAP;
}

// ── The pages ──────────────────────────────────────────────────────────────

export interface RenderOptions {
  width?: number;
  height?: number;
  /** Room left at the bottom for the title block. */
  footer?: number;
  /**
   * Write the model's own explanation under the circuit.
   *
   * The steps are already on the screen beside the drawing, and the screen is
   * not what gets printed, filed or sent to the customer. A rung comment says
   * what a rung does; it does not say why the overload holds the seal-in
   * instead of dropping it, and that is the part somebody reads the page for
   * six months later. So it goes on the page, under the rails, where it
   * travels with the DXF and the PDF.
   */
  explain?: boolean;
}

export interface LadderPage {
  index: number;
  of: number;
  drawing: Drawing;
  /** Which rungs are on it, by number. */
  rungs: number[];
  /**
   * How far down the page the drawing actually reaches.
   *
   * The drawing is a full sheet, because that is what gets printed and what
   * goes out as DXF. On screen a three-rung program on an A3 sheet is three
   * rungs in the top corner and two thirds of nothing, so a view can crop to
   * this instead. The sheet is not changed — only what is looked at.
   */
  used: number;
}

/** Height of one line of explanation, and the size it is written at. */
const NOTE = 3.1;
const NOTE_LINE = NOTE * 1.7;

/**
 * `s` broken into lines that fit `width`, at `size`.
 *
 * By the usual width guess rather than by measuring — there is no canvas here
 * and the shape model carries no font metrics. 0.55 of the size per character
 * is wide enough for the sans the sheet is drawn in, which means a line is
 * more often a little short than a little long: text that runs past the rail
 * is a fault, text that stops early is a margin.
 *
 * A word longer than the whole width is not broken — an address or a tag name
 * is worth more whole and slightly over than cut in half.
 */
function wrapText(s: string, width: number, size: number): string[] {
  const perChar = size * 0.55;
  const fits = Math.max(8, Math.floor(width / perChar));
  const lines: string[] = [];
  for (const paragraph of s.split(/\n+/)) {
    let line = '';
    for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (next.length <= fits) { line = next; continue; }
      if (line) lines.push(line);
      line = word;
    }
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * The explanation for the rungs on this page, written under them.
 *
 * Only the steps that touch a rung on this page: a note about rung 9 under a
 * page that stops at rung 6 is a note in the wrong place. Each is headed by
 * the step's own title and cites its rungs, so the paragraph can be matched to
 * the circuit above it without counting.
 *
 * It stops at the footer rather than running into the title block. What does
 * not fit is left out — the whole of it is in Simorgh Logic, and half a
 * sentence overprinted on a drawing frame helps nobody.
 */
function drawNotes(
  program: LadderProgram, here: number[], from: number,
  left: number, right: number, floor: number, shapes: Shape[],
): number {
  const steps = (program.steps ?? []).filter(
    s => s.explain && (s.rungs.length === 0 || s.rungs.some(n => here.includes(n))));
  if (steps.length === 0) return from;

  const width = right - left;
  let y = from + NOTE_LINE * 2;
  if (y + NOTE_LINE > floor) return from;

  shapes.push(line(left, from + NOTE_LINE, right, from + NOTE_LINE, 'TEXT', 0.4));

  for (const step of steps) {
    const head = step.rungs.length
      ? `${step.title}  (${step.rungs.map(n => `#${n}`).join(' ')})`
      : step.title;
    const lines: { words: string; heading: boolean }[] = [
      ...wrapText(head, width, NOTE).map(words => ({ words, heading: true })),
      ...wrapText(step.explain, width, NOTE).map(words => ({ words, heading: false })),
    ];
    for (const { words, heading } of lines) {
      const size = heading ? NOTE * 1.15 : NOTE;
      if (y + size * 1.7 > floor) return y;
      shapes.push(text(left, y, words, size, 'TEXT', 'start'));
      y += size * 1.7;
    }
    // A blank line between one note and the next, so two paragraphs do not
    // read as one.
    y += NOTE_LINE * 0.6;
  }
  return y;
}

/**
 * The program as pages of ladder.
 *
 * Paginated by measuring, because a rung is not a fixed height: one with four
 * parallel branches and a timer is three times the one under it. A rung is
 * never split across a page — half a rung is not a rung.
 */
export function renderProgram(
  program: LadderProgram, options: RenderOptions = {},
): LadderPage[] {
  const width = options.width ?? 420;
  const height = options.height ?? 297;
  const footer = options.footer ?? 34;
  const top = 22;
  const right = width - 18;
  const usable = height - footer - top;

  // Split first, so every page knows how many there are before any is drawn.
  const groups: Rung[][] = [];
  let current: Rung[] = [];
  let used = 0;
  for (const rung of program.rungs) {
    const h = rungHeight(rung);
    if (current.length > 0 && used + h > usable) {
      groups.push(current);
      current = [];
      used = 0;
    }
    current.push(rung);
    used += h;
  }
  if (current.length > 0) groups.push(current);
  if (groups.length === 0) groups.push([]);

  return groups.map((rungs, i) => {
    const shapes: Shape[] = [];

    let y = top;
    for (const rung of rungs) y = drawRung(rung, y, right, shapes);

    // The two rails, drawn last because they run from the top of the page to
    // the foot of the last rung — which is not known until the rungs are laid
    // out. They are the page's own frame as much as the circuit's: everything
    // hangs between them and nothing crosses them.
    const foot = Math.min(height - footer + 2, y + 2);
    shapes.unshift(line(RAIL_LEFT, top - 6, RAIL_LEFT, foot, 'BUS', 1.6));
    shapes.unshift(line(right, top - 6, right, foot, 'BUS', 1.6));

    // Under the rails, never between them: the explanation is about the
    // circuit, it is not part of it.
    const end = options.explain
      ? drawNotes(program, rungs.map(r => r.number), foot, RAIL_LEFT, right,
          height - footer, shapes)
      : y;

    const d = new Drawing(width, height, `${program.title} ${i + 1}`);
    for (const s of shapes) d.add(s);
    return {
      index: i + 1,
      of: groups.length,
      drawing: d,
      rungs: rungs.map(r => r.number),
      // A little past the last rung, so the rails do not end flush with the edge.
      used: Math.min(height, Math.max(y, end) + 8),
    };
  });
}

/** The dialect a program was written in, for anything that needs to ask. */
export const programDialect = (program: LadderProgram): Dialect => dialectOf(program.dialect);

/** Every point a rung's wire passes through, for tests that walk it. */
export function railsOf(page: LadderPage): { left: number; right: number } {
  const buses = page.drawing.shapes.filter(
    (s): s is Extract<Shape, { t: 'line' }> => s.t === 'line' && s.layer === 'BUS');
  const xs = buses.map(b => b.x1);
  return { left: Math.min(...xs), right: Math.max(...xs) };
}

/** Unused, but exported so a caller can place a program beside something. */
export const LADDER_GRID = { COL, BRANCH, RAIL_LEFT } as const;

/** A point on the page, for tests. */
export type LadderPoint = Pt;
