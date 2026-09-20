// Connecting two points with a wire.
//
// The line tool draws whatever you point at, diagonals included. A schematic
// is not drawn that way: a connection runs square, turning once, because a
// diagonal wire on a control drawing reads as a mistake rather than a choice.
// This is the geometry behind the connect tool — kept out of the canvas so the
// routing can be reasoned about (and tested) on its own.

import { Pt, Shape, Pen } from './shapes';

/** How near two coordinates have to be to count as the same, in drawing units. */
const EPS = 0.01;

/** Radius of the dot marking a join, relative to the wire's own width. */
const JUNCTION_R = 1.6;

const near = (a: number, b: number) => Math.abs(a - b) < EPS;

/**
 * The corner an L-shaped run turns through, or null when the two points
 * already line up and the run is straight.
 *
 * Which way it turns is not arbitrary: the run leaves along whichever axis it
 * travels furthest, so the turn lands near the far end. Going the other way
 * puts a long stub on the wrong device and reads as though the wire belongs to
 * it.
 *
 * This is the answer when nothing better is known. Where an end is a terminal
 * whose symbol says which way the wire leaves it, `routeBetween` uses that
 * instead — the draughtsman's answer beats the geometry's guess.
 */
export function elbow(a: Pt, b: Pt): Pt | null {
  if (near(a[0], b[0]) || near(a[1], b[1])) return null;
  return Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1])
    ? [b[0], a[1]]      // out horizontally first, then up or down into b
    : [a[0], b[1]];     // out vertically first, then across
}

/** Which way a wire leaves a terminal, where the symbol was drawn with one. */
export type PinDir = 'up' | 'down' | 'left' | 'right';

const upright = (d?: PinDir) => d === 'up' || d === 'down';

/**
 * The run from `a` to `b` as a list of points, obeying the way each end says
 * its wire leaves it.
 *
 * A terminal knows which way its wire goes — that is what the arrow on the
 * symbol page means — and a wire that ignores it comes back *through* the
 * device it was drawn to. That is the connection that "does not work": it
 * looks joined, it reports as joined, and on the sheet it crosses the symbol
 * it belongs to, so nobody believes it.
 *
 * Four shapes come out of this, and which one is arithmetic rather than taste:
 *
 *   * **straight**, when the two already line up along the axis both ends are
 *     happy to leave on.
 *   * **one corner**, when one end wants to go up or down and the other across
 *     — the ordinary L, turning once.
 *   * **two corners**, when both ends want the same axis: out of `a`, along,
 *     and into `b`. A breaker fed from above and a terminal fed from above are
 *     joined by a Z, not by a diagonal and not by a line through both of them.
 *   * **the old guess**, when neither end says anything, which is every
 *     connection drawn before symbols carried directions.
 */
export function routeBetween(a: Pt, b: Pt, dirA?: PinDir, dirB?: PinDir): Pt[] {
  if (near(a[0], b[0]) && near(a[1], b[1])) return [a];

  // Nothing said: the old behaviour, unchanged.
  if (!dirA && !dirB) {
    const corner = elbow(a, b);
    return corner ? [a, corner, b] : [a, b];
  }

  // Which axis each end insists on. An end that said nothing takes the
  // opposite of the one that did, so the pair makes an L rather than a Z for
  // no reason.
  const outUp = dirA ? upright(dirA) : !upright(dirB);
  const inUp = dirB ? upright(dirB) : !upright(dirA);

  if (outUp !== inUp) {
    // One up-and-down, one across: a single corner, and it is determined.
    const corner: Pt = outUp ? [a[0], b[1]] : [b[0], a[1]];
    if (near(corner[0], a[0]) && near(corner[1], a[1])) return [a, b];
    if (near(corner[0], b[0]) && near(corner[1], b[1])) return [a, b];
    return [a, corner, b];
  }

  // Both the same axis. Straight where they already line up on it.
  if (outUp && near(a[0], b[0])) return [a, b];
  if (!outUp && near(a[1], b[1])) return [a, b];

  // Otherwise out, along, and in — turning half way, which is where a
  // draughtsman puts it when nothing else decides.
  return outUp
    ? [a, [a[0], (a[1] + b[1]) / 2], [b[0], (a[1] + b[1]) / 2], b]
    : [a, [(a[0] + b[0]) / 2, a[1]], [(a[0] + b[0]) / 2, b[1]], b];
}

/** Distance from `p` to the segment `s`-`e`. */
function distToSegment(p: Pt, s: Pt, e: Pt): number {
  const vx = e[0] - s[0], vy = e[1] - s[1];
  const len2 = vx * vx + vy * vy;
  if (len2 < EPS * EPS) return Math.hypot(p[0] - s[0], p[1] - s[1]);
  let t = ((p[0] - s[0]) * vx + (p[1] - s[1]) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (s[0] + t * vx), p[1] - (s[1] + t * vy));
}

/** Every straight segment already on the sheet, as point pairs. */
function segmentsOf(shapes: Shape[]): [Pt, Pt][] {
  const out: [Pt, Pt][] = [];
  for (const s of shapes) {
    if (s.t === 'line') out.push([[s.x1, s.y1], [s.x2, s.y2]]);
    else if (s.t === 'poly') {
      for (let i = 0; i + 1 < s.pts.length; i++) out.push([s.pts[i], s.pts[i + 1]]);
      if (s.close && s.pts.length > 2) out.push([s.pts[s.pts.length - 1], s.pts[0]]);
    }
  }
  return out;
}

/**
 * Whether a dot belongs at `p`: true when the point lands part-way along an
 * existing run rather than at one of its ends.
 *
 * This is the whole convention a reader relies on. Two wires crossing with no
 * dot are not connected; the same crossing with a dot is. A T-join needs one;
 * two ends meeting do not, because there is nothing there to mistake it for.
 */
export function needsJunction(p: Pt, shapes: Shape[], tolerance = 0.6): boolean {
  for (const [s, e] of segmentsOf(shapes)) {
    const atEnd = (near(p[0], s[0]) && near(p[1], s[1]))
               || (near(p[0], e[0]) && near(p[1], e[1]));
    if (atEnd) continue;
    if (distToSegment(p, s, e) <= tolerance) return true;
  }
  return false;
}

/**
 * The run of geometry a connection from `a` to `b` amounts to: the wire
 * itself, plus a dot at either end that lands on an existing run.
 *
 * `dirA` and `dirB` are the directions the two terminals were drawn with,
 * where the ends are terminals at all. They decide the shape of the run — see
 * `routeBetween` — and leaving them out is the behaviour this always had.
 *
 * `pen` arrives already carrying the layer and line type the bar is set to.
 * Junction dots are drawn solid whatever the wire's line type — a dashed dot
 * is not a thing, and the dot is a symbol rather than part of the run.
 */
export function connectionRun(
  a: Pt, b: Pt, pen: Pen, existing: Shape[] = [],
  dirA?: PinDir, dirB?: PinDir,
): Shape[] {
  if (near(a[0], b[0]) && near(a[1], b[1])) return [];

  const pts = routeBetween(a, b, dirA, dirB);
  const wire: Shape = pts.length > 2
    ? { t: 'poly', pts, ...pen }
    : { t: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1], ...pen };

  const r = JUNCTION_R * (pen.width ?? 1);
  const dots: Shape[] = [];
  for (const end of [a, b]) {
    if (!needsJunction(end, existing)) continue;
    dots.push({
      t: 'circle', cx: end[0], cy: end[1], r,
      ...pen, dash: undefined, fill: pen.color ?? 'currentColor',
    });
  }
  return [wire, ...dots];
}
