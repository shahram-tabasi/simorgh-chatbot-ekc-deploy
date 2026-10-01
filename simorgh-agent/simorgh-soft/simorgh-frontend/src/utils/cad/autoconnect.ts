// src/utils/cad/autoconnect.ts
//
// Autoconnecting lines, the way EPLAN draws them.
//
// In EPLAN a wire between two devices standing in line is not drawn: as soon
// as a connection point of one faces a connection point of another — the same
// column, one fed from above and one from below, or the same row, one from the
// left and one from the right — they are joined. Only those lines count as
// connections; a line that merely touches a device is a picture of one. Move
// a device and its lines follow, move it out of line and they are gone.
//
// Here the same rule, kept as plain geometry: an autoconnecting line is a wire
// on the WIRE layer carrying `auto` (see `Pen.auto`). Being ordinary geometry
// it is drawn, exported, numbered and reported by everything that already
// reads wires. Being derived it is never kept as somebody's edit: every change
// to a sheet takes the old lines off and works them out again from where the
// connection points now are.
//
// Two things stop it inventing a wire:
//   * a connection point that already has a wire drawn to it by hand is
//     wired, and is left alone — so a generated sheet, or a run somebody
//     routed themselves, is never doubled;
//   * the partner has to be the *nearest* connection point in that direction,
//     and has to face back. A device in between, or one facing the other way,
//     is not jumped over.
//
// Only connection points that belong to a placed device take part. A loose
// point is somebody's construction, and the symbol page — where the points
// are the drawing — must not wire a symbol to itself.

import { Pt, Shape } from './shapes';
import { REACH, Terminal, terminals } from './terminals';
import { boundsOfAll } from './edit';
import { isConnectionText } from './annotate';

type Dir = 'up' | 'down' | 'left' | 'right';

/** How near two coordinates must be to count as one line — the snap's worth of slack. */
const TOL = 0.35;

/** Shown in a colour of its own, so a line nobody drew is seen to be one. */
export const AUTO_COLOR = '#0891b2';

const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' };

export const isAuto = (s: Shape) => !!s.auto;

interface Point extends Terminal { dir: Dir }

/**
 * Which way a connection point's wire leaves, where the symbol did not say.
 *
 * The wiring-diagram symbols say nothing, so this has to be right for them.
 * Two points of one device on one upright line are its top and bottom — the
 * upper fed from above, the lower from below — and two on one level line are
 * its left and right. Only a point with no partner like that falls back to
 * the edge of the device it is nearest, measured on the device's lines, not
 * its printed numbers: a "13" beside the top terminal made the box wider than
 * the device and turned every contact's top point to face left.
 */
function inferDir(
  t: Terminal, kin: Terminal[], ink: Map<string, ReturnType<typeof boundsOfAll>>,
): Dir | null {
  const [x, y] = t.at;
  const column = kin.filter(o => o !== t && Math.abs(o.at[0] - x) <= TOL);
  if (column.length) {
    if (column.every(o => o.at[1] > y)) return 'up';
    if (column.every(o => o.at[1] < y)) return 'down';
  }
  const row = kin.filter(o => o !== t && Math.abs(o.at[1] - y) <= TOL);
  if (row.length) {
    if (row.every(o => o.at[0] > x)) return 'left';
    if (row.every(o => o.at[0] < x)) return 'right';
  }
  const box = ink.get(t.block);
  if (!box) return null;
  const d: [Dir, number][] = [
    ['up', Math.abs(y - box.y)],
    ['down', Math.abs(box.y + box.h - y)],
    ['left', Math.abs(x - box.x)],
    ['right', Math.abs(box.x + box.w - x)],
  ];
  // Stable, so a tie goes to up or down — what an in-line device is.
  d.sort((p, q) => p[1] - q[1]);
  return d[0][0];
}

/** The key a pair of points is known by, the same whichever end is first. */
const pairKey = (a: Terminal, b: Terminal) =>
  [`${a.block}:${a.name}`, `${b.block}:${b.name}`].sort().join('|');

/** Does a hand-drawn wire end on this point? */
function wired(t: Terminal, wires: Shape[]): boolean {
  const near = (p: Pt) => Math.hypot(p[0] - t.at[0], p[1] - t.at[1]) <= REACH;
  for (const s of wires) {
    if (s.t === 'line' && (near([s.x1, s.y1]) || near([s.x2, s.y2]))) return true;
    if (s.t === 'poly' && s.pts.length > 1
      && (near(s.pts[0]) || near(s.pts[s.pts.length - 1]))) return true;
  }
  return false;
}

/** The autoconnecting lines a sheet should have, worked out from its points. */
export function autoconnectLines(shapes: Shape[], width = 0.5): Shape[] {
  const drawn = shapes.filter(s => !s.auto);
  const wires = drawn.filter(s => (s.layer === 'WIRE' || s.layer === 'BUS') && !s.pin);

  // Each device's own ink, for the points that did not say which way.
  const ink = new Map<string, ReturnType<typeof boundsOfAll>>();
  const byBlock = new Map<string, Shape[]>();
  for (const s of drawn) {
    if (!s.block || s.pin || s.t === 'text') continue;
    if (!byBlock.has(s.block)) byBlock.set(s.block, []);
    byBlock.get(s.block)!.push(s);
  }
  for (const [block, run] of byBlock) ink.set(block, boundsOfAll(run));

  const all = terminals(drawn, true).filter(t => t.block);
  const points: Point[] = [];
  for (const t of all) {
    const dir = t.dir ?? inferDir(t, all.filter(o => o.block === t.block), ink);
    if (dir) points.push({ ...t, dir });
  }

  const out: Shape[] = [];
  const seen = new Set<string>();
  for (const a of points) {
    // The nearest point straight out along the way this one's wire leaves.
    // A connector has several points on one spot, facing different ways, so
    // at the nearest distance the one facing back is the one meant.
    let best: { p: Point; d: number } | null = null;
    const better = (b: Point, d: number) => {
      if (!best || d < best.d - TOL) return true;
      return Math.abs(d - best.d) <= TOL && best.p.dir !== OPPOSITE[a.dir]
        && b.dir === OPPOSITE[a.dir];
    };
    for (const b of points) {
      if (b === a) continue;
      const dx = b.at[0] - a.at[0], dy = b.at[1] - a.at[1];
      let d: number;
      switch (a.dir) {
        case 'up': if (Math.abs(dx) > TOL || dy >= -TOL) continue; d = -dy; break;
        case 'down': if (Math.abs(dx) > TOL || dy <= TOL) continue; d = dy; break;
        case 'left': if (Math.abs(dy) > TOL || dx >= -TOL) continue; d = -dx; break;
        case 'right': if (Math.abs(dy) > TOL || dx <= TOL) continue; d = dx; break;
      }
      if (better(b, d)) best = { p: b, d };
    }
    if (!best) continue;
    const b = best.p;
    // It has to face back, and it has to be somebody else.
    if (b.dir !== OPPOSITE[a.dir] || b.block === a.block) continue;
    const key = pairKey(a, b);
    if (seen.has(key)) continue;
    seen.add(key);
    if (wired(a, wires) || wired(b, wires)) continue;
    // Squared onto the line both share, so a point a hair off the snap still
    // gives a straight wire rather than a sliver of a diagonal.
    const upright = a.dir === 'up' || a.dir === 'down';
    const x2 = upright ? a.at[0] : b.at[0];
    const y2 = upright ? b.at[1] : a.at[1];
    out.push({
      t: 'line', x1: a.at[0], y1: a.at[1], x2, y2,
      layer: 'WIRE', color: AUTO_COLOR, width, auto: key,
    });
  }
  return out;
}

const mid = (s: Shape): Pt | null =>
  s.t === 'line' ? [(s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2] : null;

function distToLine(p: Pt, s: Shape): number {
  if (s.t !== 'line') return Infinity;
  const vx = s.x2 - s.x1, vy = s.y2 - s.y1;
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-9) return Math.hypot(p[0] - s.x1, p[1] - s.y1);
  let t = ((p[0] - s.x1) * vx + (p[1] - s.y1) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (s.x1 + t * vx), p[1] - (s.y1 + t * vy));
}

/**
 * The sheet with its autoconnecting lines worked out again.
 *
 * The old lines come off and the new ones go on the end, so the shapes
 * somebody drew keep their order. A connection's name and description — the
 * labels written on it — move with the line they name: a device moved down a grid step takes
 * its wire with it, and the wire takes its name.
 *
 * `index` maps a position in the list handed in to its position in the list
 * handed back, for a selection that pointed into the old one; -1 for an
 * autoconnecting line, which is not the same line any more.
 */
export function refreshAutoconnect(
  shapes: Shape[], width = 0.5,
): { shapes: Shape[]; index: (i: number) => number; changed: boolean } {
  const old = shapes.filter(isAuto);
  const next = autoconnectLines(shapes, width);

  const same = old.length === next.length && old.every((s, i) => {
    const n = next[i];
    return s.t === 'line' && n.t === 'line' && s.auto === n.auto
      && s.x1 === n.x1 && s.y1 === n.y1 && s.x2 === n.x2 && s.y2 === n.y2;
  });
  // Already where they belong, and already at the end: nothing to do.
  const tail = shapes.slice(shapes.length - old.length);
  if (same && tail.every(isAuto)) {
    return { shapes, index: i => i, changed: false };
  }

  // Names follow their line.
  const moves = new Map<number, Pt>();
  for (const was of old) {
    const now = next.find(n => n.auto === was.auto);
    const a = mid(was), b = now && mid(now);
    if (!a || !b || (a[0] === b[0] && a[1] === b[1])) continue;
    shapes.forEach((s, i) => {
      if (!isConnectionText(s) || s.t !== 'text' || moves.has(i)) return;
      if (distToLine([s.x, s.y], was) <= 6) moves.set(i, [b[0] - a[0], b[1] - a[1]]);
    });
  }

  const map = new Map<number, number>();
  const kept: Shape[] = [];
  shapes.forEach((s, i) => {
    if (isAuto(s)) return;
    map.set(i, kept.length);
    const d = moves.get(i);
    kept.push(d && s.t === 'text' ? { ...s, x: s.x + d[0], y: s.y + d[1] } : s);
  });
  return {
    shapes: [...kept, ...next],
    index: i => map.get(i) ?? -1,
    changed: true,
  };
}
