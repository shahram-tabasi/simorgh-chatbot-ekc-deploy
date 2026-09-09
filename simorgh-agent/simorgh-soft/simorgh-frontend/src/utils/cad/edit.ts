// src/utils/cad/edit.ts
//
// Editing a drawing: what the canvas needs and the file formats do not.
//
// Everything here is pure — a shape in, a shape out — so the editor's state is
// an array of shapes and nothing else. Undo is then a stack of arrays, which
// for a sheet of a few hundred shapes is both simpler and faster than tracking
// what each command changed.
import { Drawing, Pt, Shape, translateShape } from './shapes';
import { onArc } from './svg';

export interface Box { x: number; y: number; w: number; h: number }

const box = (xs: number[], ys: number[]): Box => ({
  x: Math.min(...xs), y: Math.min(...ys),
  w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
});

/** What a text of this size and length covers, near enough to click it. */
function textBox(s: Extract<Shape, { t: 'text' }>): Box {
  // 0.55 em per character is close for the sans the sheets are set in.
  const w = s.s.length * s.size * 0.55;
  const x = s.anchor === 'middle' ? s.x - w / 2 : s.anchor === 'end' ? s.x - w : s.x;
  return { x, y: s.y - s.size * 0.8, w, h: s.size * 1.05 };
}

/** The rectangle a shape occupies. */
export function boundsOf(s: Shape): Box {
  switch (s.t) {
    case 'line':    return box([s.x1, s.x2], [s.y1, s.y2]);
    case 'rect':    return { x: s.x, y: s.y, w: s.w, h: s.h };
    case 'circle':  return { x: s.cx - s.r, y: s.cy - s.r, w: s.r * 2, h: s.r * 2 };
    case 'ellipse': return { x: s.cx - s.rx, y: s.cy - s.ry, w: s.rx * 2, h: s.ry * 2 };
    case 'arc': {
      // The ends plus whichever quadrant points the sweep actually passes.
      const pts: Pt[] = [onArc(s.cx, s.cy, s.r, s.a0), onArc(s.cx, s.cy, s.r, s.a1)];
      for (let a = Math.ceil(s.a0 / 90) * 90; a <= s.a1; a += 90) {
        pts.push(onArc(s.cx, s.cy, s.r, a));
      }
      return box(pts.map(p => p[0]), pts.map(p => p[1]));
    }
    case 'curve':   return box([s.x1, s.cx, s.x2], [s.y1, s.cy, s.y2]);
    case 'poly':    return box(s.pts.map(p => p[0]), s.pts.map(p => p[1]));
    case 'text':    return textBox(s);
  }
}

/** The rectangle a set of shapes occupies, or null when there are none. */
export function boundsOfAll(shapes: Shape[]): Box | null {
  if (shapes.length === 0) return null;
  const boxes = shapes.map(boundsOf);
  return box(
    boxes.flatMap(b => [b.x, b.x + b.w]),
    boxes.flatMap(b => [b.y, b.y + b.h]),
  );
}

const inBox = (b: Box, x: number, y: number) =>
  x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;

const contains = (outer: Box, inner: Box) =>
  inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

/** Distance from a point to a segment — how a thin line is clicked. */
function toSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

const toPolyline = (px: number, py: number, pts: Pt[]) => {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    best = Math.min(best, toSegment(px, py, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  }
  return best;
};

/** How far a point is from a shape's ink. Infinity when it is nowhere near. */
export function distanceTo(s: Shape, x: number, y: number): number {
  const filled = Boolean(s.fill && s.fill !== 'none' && s.fill !== '#fff' && s.fill !== '#ffffff');
  switch (s.t) {
    case 'line':
      return toSegment(x, y, s.x1, s.y1, s.x2, s.y2);
    case 'rect': {
      const b = boundsOf(s);
      if (filled && inBox(b, x, y)) return 0;
      return toPolyline(x, y, [
        [s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h], [s.x, s.y],
      ]);
    }
    case 'circle': {
      const d = Math.hypot(x - s.cx, y - s.cy);
      return filled && d <= s.r ? 0 : Math.abs(d - s.r);
    }
    case 'ellipse': {
      // Near enough for picking: the radial distance on the scaled circle.
      const dx = (x - s.cx) / (s.rx || 1), dy = (y - s.cy) / (s.ry || 1);
      const d = Math.hypot(dx, dy);
      if (filled && d <= 1) return 0;
      return Math.abs(d - 1) * Math.min(s.rx, s.ry);
    }
    case 'arc': {
      const steps = 24;
      const pts: Pt[] = [];
      for (let i = 0; i <= steps; i++) {
        pts.push(onArc(s.cx, s.cy, s.r, s.a0 + ((s.a1 - s.a0) * i) / steps));
      }
      return toPolyline(x, y, pts);
    }
    case 'curve': {
      const steps = 16;
      const pts: Pt[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        pts.push([
          u * u * s.x1 + 2 * u * t * s.cx + t * t * s.x2,
          u * u * s.y1 + 2 * u * t * s.cy + t * t * s.y2,
        ]);
      }
      return toPolyline(x, y, pts);
    }
    case 'poly': {
      if (filled && inBox(boundsOf(s), x, y)) return 0;
      const pts = s.close && s.pts.length > 2 ? [...s.pts, s.pts[0]] : s.pts;
      return toPolyline(x, y, pts);
    }
    case 'text':
      return inBox(textBox(s), x, y) ? 0 : Infinity;
  }
}

/**
 * The shape under the cursor: the nearest one within `tolerance`, and among
 * equals the one drawn last, which is the one the eye sees on top.
 */
export function hitTest(
  shapes: Shape[], x: number, y: number, tolerance: number, skip?: ReadonlySet<string>,
): number | null {
  let best: number | null = null;
  let bestDistance = tolerance;
  shapes.forEach((s, i) => {
    if (skip?.has(s.layer)) return;
    const d = distanceTo(s, x, y);
    if (d <= bestDistance) { best = i; bestDistance = d; }
  });
  return best;
}

/** Everything a rubber band completely encloses. */
export function shapesInBox(
  shapes: Shape[], area: Box, skip?: ReadonlySet<string>,
): number[] {
  const out: number[] = [];
  shapes.forEach((s, i) => {
    if (skip?.has(s.layer)) return;
    if (contains(area, boundsOf(s))) out.push(i);
  });
  return out;
}

/** A copy of the shapes with `indices` moved. */
export function moveShapes(shapes: Shape[], indices: Iterable<number>, dx: number, dy: number): Shape[] {
  const set = new Set(indices);
  return shapes.map((s, i) => (set.has(i) ? translateShape(s, dx, dy) : s));
}

/** A copy with `indices` removed. */
export function deleteShapes(shapes: Shape[], indices: Iterable<number>): Shape[] {
  const set = new Set(indices);
  return shapes.filter((_, i) => !set.has(i));
}

/** A copy with one text's wording replaced. */
export function setText(shapes: Shape[], index: number, value: string): Shape[] {
  const target = shapes[index];
  if (!target || target.t !== 'text') return shapes;
  return shapes.map((s, i) => (i === index ? { ...s, s: value } : s));
}

/** A copy with `indices` duplicated, offset so the copies are visible. */
export function duplicateShapes(shapes: Shape[], indices: Iterable<number>, offset = 12): {
  shapes: Shape[]; selection: number[];
} {
  const list = [...new Set(indices)].sort((a, b) => a - b);
  const copies = list.map(i => translateShape(shapes[i], offset, offset));
  return {
    shapes: [...shapes, ...copies],
    selection: copies.map((_, k) => shapes.length + k),
  };
}

/** The same drawing carrying a different set of shapes. */
export function withShapes(d: Drawing, shapes: Shape[]): Drawing {
  const next = new Drawing(d.width, d.height, d.name);
  for (const s of shapes) next.add(s);
  return next;
}

/**
 * Undo and redo.
 *
 * A step is a whole array of shapes. They are shared structurally — a move
 * rebuilds the array but not the shapes it did not touch — so a hundred steps
 * of a 700-shape sheet costs a hundred arrays of pointers, not a hundred
 * sheets.
 */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];

  constructor(private limit = 100) {}

  /** Record the state being replaced, before applying the new one. */
  push(previous: T): void {
    this.past.push(previous);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current: T): T | null {
    const previous = this.past.pop();
    if (previous === undefined) return null;
    this.future.push(current);
    return previous;
  }

  redo(current: T): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(current);
    return next;
  }

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  clear(): void { this.past = []; this.future = []; }
}
