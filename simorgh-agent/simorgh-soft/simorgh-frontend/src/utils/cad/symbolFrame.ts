// src/utils/cad/symbolFrame.ts
//
// The box a symbol has to be drawn inside, and the two points a wire lands on.
//
// Up to here the symbol page was a blank canvas with the old drawing on it. You
// could draw anywhere, at any size, and nothing on the screen said where the
// conductor ran or how tall a cell was — so a symbol redrawn to match the
// office's own sheets came back the right shape and the wrong size, sitting
// beside the branch instead of on it. "There is no defined place and no defined
// spacing to help the new symbol match the old one" is exactly that, and it is
// not a preference: a single-line symbol is placed by its conductor and scaled
// by its height, and a drawing that does not say where either of those are
// cannot be placed at all.
//
// So the frame is drawn, and it is drawn as guides rather than as geometry:
// under the ink, never picked, never moved, never deleted, never saved. It is
// the *paper*, not the drawing. What it shows is the whole of what the
// placement arithmetic reads later:
//
//   * **the box** — one cell tall for an ordinary device, more for a breaker
//     with its racking. Draw outside it and the symbol will be scaled down to
//     fit when it is placed, which is how a device ends up smaller than the
//     one beside it.
//   * **the conductor** — the vertical the branch line runs down. A symbol is
//     hung on this, not on the middle of its ink: a meter reaches right and a
//     withdrawable breaker reaches left, and both sit on the same wire.
//   * **the two terminals** — where the current comes in and where it leaves.
//     These are what a connection is made *to*; without them a wire drawn to
//     the symbol is a line that happens to touch it, and the connection list
//     has nothing to report.
//
// Everything here is in the symbol's own units, the same ones `symbolDrawing`
// hands the editor, so nothing has to convert between two ideas of a cell.

import { Pt, Shape } from './shapes';
import { boundsOfAll } from './edit';
import { mapShape, scaling, translation } from './geom';
import { CELL, SymbolId, symbolHeight, symbolLeft, symbolRight } from '../iecSymbols';

/** Which way a wire leaves a terminal. */
export type PinDir = 'up' | 'down' | 'left' | 'right';

/**
 * One connection point on a symbol, as the engineer places it.
 *
 * `dir` is the half of this the software used to guess. A terminal at the top
 * of a breaker is fed from above and one at the side of a CT is fed from the
 * side, and which it is decides where the wire is drawn to and which way the
 * stub leaves — so it is the draughtsman's to say, not the library's to infer
 * from whichever edge of the bounding box the point happens to be nearest.
 */
export interface SymbolPin {
  x: number;
  y: number;
  /** What the device prints beside it — 1, 2, A1, 13. */
  name: string;
  dir: PinDir;
}

export interface SymbolFrame {
  /** The box, in the symbol's own units. */
  width: number;
  height: number;
  /** Where the branch conductor runs down it. */
  pinX: number;
  /** How many cells down the line the symbol takes. */
  cells: number;
  /** Where the conductor enters the box, and where it leaves. */
  start: Pt;
  end: Pt;
}

/** How many cells a symbol of this height takes, clamped to what can be placed. */
export const cellsOf = (height: number): number =>
  Math.max(1, Math.min(4, Math.round(height / CELL) || 1));

/**
 * The frame for one symbol: its box, its conductor and its two ends.
 *
 * Read through the same accessors the rest of the app places symbols with, so
 * the guides on the page are the arithmetic that will be used, rather than a
 * second opinion about it drawn beside it.
 *
 * `override` is the project's own drawing of the symbol where there is one,
 * taken by its three numbers rather than by its type: the project's types
 * carry a `SymbolPin` from this file, and a module that imports the thing
 * importing it is a load order waiting to go wrong.
 */
export function symbolFrame(
  symbolId: SymbolId,
  override?: { width: number; height: number; pinX: number },
): SymbolFrame {
  const width = override
    ? Math.max(1, override.width)
    : symbolLeft(symbolId) + symbolRight(symbolId);
  const height = override ? Math.max(1, override.height) : symbolHeight(symbolId);
  const pinX = override ? override.pinX : symbolLeft(symbolId);
  return {
    width,
    height,
    pinX,
    cells: override ? cellsOf(override.height) : cellsOf(height),
    start: [pinX, 0],
    end: [pinX, height],
  };
}

/** The two terminals a single-line symbol has when nobody has said otherwise. */
export const defaultPins = (f: SymbolFrame): SymbolPin[] => [
  { x: f.start[0], y: f.start[1], name: '1', dir: 'up' },
  { x: f.end[0], y: f.end[1], name: '2', dir: 'down' },
];

// ── What is drawn ──────────────────────────────────────────────────────────

/** The guides' own colours. Not a layer colour: these are not on the sheet. */
const EDGE = '#0ea5e9';
const AXIS = '#f59e0b';
const PIN = '#db2777';

/** How long the arrow off a terminal is, in the symbol's units. */
const ARROW = 5;

const arrowFrom = (p: SymbolPin): Pt => {
  switch (p.dir) {
    case 'up': return [p.x, p.y - ARROW];
    case 'down': return [p.x, p.y + ARROW];
    case 'left': return [p.x - ARROW, p.y];
    case 'right': return [p.x + ARROW, p.y];
  }
};

/**
 * The frame as geometry, for the canvas to draw under the symbol.
 *
 * Shapes rather than markup so the canvas draws them through the same path as
 * everything else and they land in the same coordinate space without a second
 * transform to get wrong. They never reach the shape list, so nothing here can
 * be picked up, moved, deleted or saved — which is the point: a boundary the
 * draughtsman can delete is a boundary that will be gone the first time
 * somebody presses Ctrl+A.
 */
export function frameGuides(f: SymbolFrame, pins: SymbolPin[]): Shape[] {
  const out: Shape[] = [];

  // The box. Dashed, because it is not drawn on the sheet — it is the extent
  // the drawing is read back at.
  out.push({
    t: 'rect', x: 0, y: 0, w: f.width, h: f.height,
    layer: 'FREE', color: EDGE, width: 0.5, dash: '3 2', fill: 'none',
  });

  // One rule per cell boundary, so "this device is two cells tall" is a thing
  // that can be seen rather than a number in a caption.
  for (let c = 1; c < f.cells; c++) {
    const y = (f.height / f.cells) * c;
    out.push({
      t: 'line', x1: 0, y1: y, x2: f.width, y2: y,
      layer: 'FREE', color: EDGE, width: 0.3, dash: '1 3',
    });
  }

  // The conductor. Dash-dot, which is what a centre line is in every drawing
  // office, and the reason this one is a centre line: the symbol is built
  // about it.
  out.push({
    t: 'line', x1: f.pinX, y1: -ARROW, x2: f.pinX, y2: f.height + ARROW,
    layer: 'FREE', color: AXIS, width: 0.5, dash: '6 2 1 2',
  });

  // Where the conductor enters and leaves, and which way.
  //
  // Drawn as a cross rather than as a ring, and the difference is the point:
  // the ring belongs to a *terminal*, which is a thing on the drawing that can
  // be moved and renamed. This is the frame saying where the branch meets the
  // symbol, which is true whatever the draughtsman does with the terminals.
  // Drawn as a ring it sat exactly under the real one and read as the canvas
  // having drawn everything twice.
  for (const p of pins) {
    const tip = arrowFrom(p);
    const c = 1.9;
    out.push({
      t: 'line', x1: p.x - c, y1: p.y - c, x2: p.x + c, y2: p.y + c,
      layer: 'FREE', color: PIN, width: 0.5,
    });
    out.push({
      t: 'line', x1: p.x - c, y1: p.y + c, x2: p.x + c, y2: p.y - c,
      layer: 'FREE', color: PIN, width: 0.5,
    });
    out.push({
      t: 'line', x1: p.x, y1: p.y, x2: tip[0], y2: tip[1],
      layer: 'FREE', color: PIN, width: 0.6,
    });
    // The head, as two strokes back from the tip — a polyline rather than a
    // filled marker so it survives the DXF and PDF back-ends unchanged.
    const back = 1.8;
    const across = 1.1;
    const head: Pt[] = p.dir === 'up' || p.dir === 'down'
      ? (() => {
        const s = p.dir === 'up' ? 1 : -1;
        return [[tip[0] - across, tip[1] + back * s], tip, [tip[0] + across, tip[1] + back * s]];
      })()
      : (() => {
        const s = p.dir === 'left' ? 1 : -1;
        return [[tip[0] + back * s, tip[1] - across], tip, [tip[0] + back * s, tip[1] + across]];
      })();
    out.push({ t: 'poly', pts: head, layer: 'FREE', color: PIN, width: 0.6 });
    out.push({
      t: 'text',
      x: p.dir === 'left' ? tip[0] - 1.5 : tip[0] + 1.5,
      y: tip[1] - 1,
      s: p.name, size: 4,
      layer: 'FREE', color: PIN,
      anchor: p.dir === 'left' ? 'end' : 'start',
    });
  }

  return out;
}

// ── Geometry arriving from somewhere else ──────────────────────────────────

/**
 * Where the conductor runs through a piece of geometry, read from the geometry
 * itself when it can be.
 *
 * A single-line symbol is drawn around a vertical that reaches the top and the
 * bottom of it, and that vertical is the conductor. Where an imported drawing
 * has one, using it beats centring the ink — a withdrawable breaker's ink is
 * not centred on its wire and never was. Where it has none, the caller falls
 * back to the middle, and the guides show what was assumed.
 */
export function conductorIn(run: Shape[]): number | null {
  const box = boundsOfAll(run);
  if (!box || box.h <= 0) return null;
  const full = box.h * 0.7;
  const verticals: { x: number; len: number }[] = [];
  for (const s of run) {
    if (s.t !== 'line') continue;
    if (Math.abs(s.x1 - s.x2) > box.w * 0.01) continue;
    const len = Math.abs(s.y2 - s.y1);
    if (len >= full) verticals.push({ x: (s.x1 + s.x2) / 2, len });
  }
  if (verticals.length === 0) return null;
  verticals.sort((a, b) => b.len - a.len);
  return verticals[0].x;
}

/**
 * Imported geometry, put inside the frame.
 *
 * This is the whole of what "import a DXF into the symbol page" has to do, and
 * it is the opposite of what the sheet's own DXF import does. On a sheet, a
 * supplier's DXF is *more* geometry and it belongs wherever the draughtsman is
 * looking. Here it **is** the symbol: it replaces what was there, and where it
 * lands is not a preference — it has to be the frame, or the symbol is drawn
 * to one size and placed at another.
 *
 * Two things are settled here and both are settled the same way every time:
 *
 *   * **the size.** Scaled about its own box so it fills the frame, keeping its
 *     proportions. A symbol imported at the scale of the sheet it was cut from
 *     is a hundred cells tall, and one cut from a detail is a tenth of a cell;
 *     neither can be placed on a branch and neither is the draughtsman's
 *     mistake to fix by hand.
 *   * **the conductor.** The ink is centred on the frame's own conductor,
 *     because a single-line symbol is drawn about the line it sits on and the
 *     middle of its ink is the best available guess at where that line is. It
 *     is a guess, which is why the conductor is drawn: what the guess got
 *     wrong is visible, and nudging the ink onto the line is a drag.
 *
 * `margin` leaves a little of the frame clear so a symbol that just touches its
 * own box does not read as one that overflows it.
 *
 * Connection points the file declared are passed **in with the ink**, not
 * fitted afterwards. They are part of what the file says the symbol is —
 * where a wire lands on it — so they are measured, scaled and moved by the
 * same sum, and they come inside the cell with the drawing. Fitted in a
 * second call they were scaled by a box of their own and landed beside the
 * device, which is a wire joined to nothing.
 */
export function fitIntoFrame(
  run: Shape[], f: SymbolFrame, margin = 0.06,
): { shapes: Shape[]; scale: number; onAxis: boolean } {
  const box = boundsOfAll(run);
  if (!box || box.w <= 0 || box.h <= 0) return { shapes: run, scale: 1, onAxis: false };

  const room = 1 - Math.max(0, Math.min(0.4, margin)) * 2;
  const k = Math.min((f.width * room) / box.w, (f.height * room) / box.h);
  const scaled = k === 1 ? run : run.map(s => mapShape(s, scaling(box.x, box.y, k)));

  const after = boundsOfAll(scaled);
  if (!after) return { shapes: scaled, scale: k, onAxis: false };

  // Where the drawing's own conductor is, if it has one. A file cut from a
  // single line almost always does, and using it beats centring the ink: a
  // withdrawable breaker's ink is not centred on its wire and never was.
  const axis = conductorIn(scaled);
  const dx = (axis ?? after.x + after.w / 2) * -1 + f.pinX;
  const dy = (f.height - after.h) / 2 - after.y;
  return {
    shapes: scaled.map(s => mapShape(s, translation(dx, dy))),
    scale: k,
    onAxis: axis !== null,
  };
}
