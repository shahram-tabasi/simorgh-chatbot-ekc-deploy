// src/utils/cad/geom.ts
//
// The commands a drawing office reaches for after the geometry is on the sheet:
// turn it, mirror it, line it up, cut a line back to what it crosses, bring two
// lines to a corner, dimension the gap between two points.
//
// Everything here is pure — shapes in, shapes out — like cad/edit.ts, so the
// editor's undo stays a stack of arrays and nothing has to know a command ran.
//
// One convention runs through the file. **Sheet space** has y pointing down,
// and an angle `a` in it means the point `[cx + r·cos a, cy + r·sin a]` — the
// same measure `arc` shapes and `onArc` use. Because y is down, an angle that
// grows looks *clockwise* on the screen. Text is the exception: DXF, jsPDF and
// a draughtsman all measure a label's rotation anticlockwise on the paper, so
// `Shape.rot` runs the other way and every mapping below says which it means.
import { Layer, Pt, Shape } from './shapes';
import { onArc } from './svg';
import { Box, boundsOf, boundsOfAll } from './edit';

const DEG = Math.PI / 180;
const EPS = 1e-9;

/** Degrees into 0…360, so two angles can be compared. */
export const norm360 = (deg: number): number => ((deg % 360) + 360) % 360;

// ── Mapping a shape through a transform ─────────────────────────────────────

/**
 * How one transform acts on each thing a shape is made of.
 *
 * A single 2×3 matrix would be shorter, but it cannot say the two things this
 * has to: which way an arc now sweeps, and which way a label now reads. Those
 * are the parts that go wrong silently, so they are named rather than derived.
 */
interface Mapping {
  /** Where a point goes. */
  pt: (p: Pt) => Pt;
  /** What a radius, a line weight or a text height is multiplied by. */
  k: number;
  /** Where an angle measured in sheet space ends up. */
  angle: (deg: number) => number;
  /** True for a mirror: the sense of an arc's sweep is reversed. */
  reverses: boolean;
  /** Degrees to add to a text's own rotation, anticlockwise on the paper. */
  textRot: number;
  /** True when left and right have swapped, so a text anchor has to follow. */
  swapAnchor: boolean;
}

/** Turn about a point, `deg` in sheet space (positive looks clockwise). */
export function rotation(cx: number, cy: number, deg: number): Mapping {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return {
    pt: ([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c],
    k: 1,
    angle: a => a + deg,
    reverses: false,
    // Sheet space is y-down, so a turn that looks clockwise there is the
    // negative of the anticlockwise angle a label is measured by.
    textRot: -deg,
    swapAnchor: false,
  };
}

/** Mirror across the upright line `x = at`. */
export function mirrorX(at: number): Mapping {
  return {
    pt: ([x, y]) => [2 * at - x, y],
    k: 1,
    angle: a => 180 - a,
    reverses: true,
    textRot: 0,
    swapAnchor: true,
  };
}

/** Mirror across the level line `y = at`. */
export function mirrorY(at: number): Mapping {
  return {
    pt: ([x, y]) => [x, 2 * at - y],
    k: 1,
    angle: a => -a,
    reverses: true,
    textRot: 0,
    swapAnchor: false,
  };
}

/** Scale about a point. */
export function scaling(cx: number, cy: number, k: number): Mapping {
  return {
    pt: ([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k],
    k,
    angle: a => a,
    reverses: false,
    textRot: 0,
    swapAnchor: false,
  };
}

const isRightAngle = (m: Mapping) => {
  // A rect stays a rect and an ellipse stays an ellipse only under a quarter
  // turn; anything else has to become a polygon to stay the shape it was.
  const turned = norm360(m.angle(0));
  return Math.abs(turned % 90) < 1e-6;
};

type Anchor = NonNullable<Extract<Shape, { t: 'text' }>['anchor']>;
const swapAnchorOf = (a: Anchor): Anchor =>
  (a === 'start' ? 'end' : a === 'end' ? 'start' : a);

/** One shape through one transform. */
export function mapShape(s: Shape, m: Mapping): Shape {
  const P = (x: number, y: number) => m.pt([x, y]);
  switch (s.t) {
    case 'line': {
      const [x1, y1] = P(s.x1, s.y1);
      const [x2, y2] = P(s.x2, s.y2);
      return { ...s, x1, y1, x2, y2 };
    }

    case 'rect': {
      const corners: Pt[] = [
        [s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h],
      ].map(p => m.pt(p as Pt));
      if (isRightAngle(m)) {
        // Still upright: the mapped corners bound it exactly.
        const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
        return {
          ...s, x: Math.min(...xs), y: Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
        };
      }
      // Turned off the square, so it is a quadrilateral now and says so.
      return {
        t: 'poly', pts: corners, close: true,
        layer: s.layer, color: s.color, width: s.width, fill: s.fill, dash: s.dash,
      };
    }

    case 'circle': {
      const [cx, cy] = P(s.cx, s.cy);
      return { ...s, cx, cy, r: s.r * m.k };
    }

    case 'ellipse': {
      const [cx, cy] = P(s.cx, s.cy);
      if (isRightAngle(m)) {
        // A quarter turn puts the long axis where the short one was.
        const quarter = Math.abs(norm360(m.angle(0) - 0) % 180) > 1e-6;
        return {
          ...s, cx, cy,
          rx: (quarter ? s.ry : s.rx) * m.k,
          ry: (quarter ? s.rx : s.ry) * m.k,
        };
      }
      // Off the square there is no ellipse shape to hold it, so it is walked.
      const STEPS = 72;
      const pts: Pt[] = [];
      for (let i = 0; i < STEPS; i++) {
        const a = (i / STEPS) * 360;
        pts.push(m.pt([s.cx + s.rx * Math.cos(a * DEG), s.cy + s.ry * Math.sin(a * DEG)]));
      }
      return {
        t: 'poly', pts, close: true,
        layer: s.layer, color: s.color, width: s.width, fill: s.fill, dash: s.dash,
      };
    }

    case 'arc': {
      const [cx, cy] = P(s.cx, s.cy);
      const a = m.angle(s.a0), b = m.angle(s.a1);
      // A mirror turns the sweep round, so the ends change places to keep the
      // arc running the positive way the renderers expect.
      let [a0, a1] = m.reverses ? [b, a] : [a, b];
      if (a1 <= a0) a1 += 360;
      return { ...s, cx, cy, r: s.r * m.k, a0, a1 };
    }

    case 'curve': {
      const [x1, y1] = P(s.x1, s.y1);
      const [cx, cy] = P(s.cx, s.cy);
      const [x2, y2] = P(s.x2, s.y2);
      return { ...s, x1, y1, cx, cy, x2, y2 };
    }

    case 'poly':
      return { ...s, pts: s.pts.map(p => m.pt(p)) };

    case 'text': {
      const [x, y] = P(s.x, s.y);
      const rot = norm360((s.rot ?? 0) + m.textRot);
      return {
        ...s, x, y,
        size: s.size * m.k,
        rot: rot || undefined,
        anchor: m.swapAnchor ? swapAnchorOf(s.anchor ?? 'start') : s.anchor,
      };
    }
  }
}

/** A copy of the shapes with `indices` put through a transform. */
export function transformShapes(
  shapes: Shape[], indices: Iterable<number>, m: Mapping,
): Shape[] {
  const set = new Set(indices);
  return shapes.map((s, i) => (set.has(i) ? mapShape(s, m) : s));
}

/** The middle of what is picked — what a turn or a mirror happens about. */
export function centreOf(shapes: Shape[], indices: Iterable<number>): Pt | null {
  const picked = [...indices].map(i => shapes[i]).filter(Boolean);
  const b = boundsOfAll(picked);
  return b ? [b.x + b.w / 2, b.y + b.h / 2] : null;
}

// ── Stacking order ──────────────────────────────────────────────────────────

/**
 * Bring the picked shapes to the front, or send them to the back.
 *
 * The array is the drawing order — later is nearer the eye — so this is a
 * reordering, and the indices move with it. The new positions come back so the
 * selection can follow what it was pointing at.
 */
export function reorderShapes(
  shapes: Shape[], indices: Iterable<number>, to: 'front' | 'back',
): { shapes: Shape[]; selection: number[] } {
  const set = new Set(indices);
  const moved = shapes.filter((_, i) => set.has(i));
  const rest = shapes.filter((_, i) => !set.has(i));
  if (moved.length === 0) return { shapes, selection: [] };
  return to === 'front'
    ? { shapes: [...rest, ...moved], selection: moved.map((_, k) => rest.length + k) }
    : { shapes: [...moved, ...rest], selection: moved.map((_, k) => k) };
}

// ── Lining up ───────────────────────────────────────────────────────────────

export type AlignTo = 'left' | 'right' | 'top' | 'bottom' | 'centre-x' | 'centre-y';

/** Line the picked shapes up against the edge of what they cover together. */
export function alignShapes(
  shapes: Shape[], indices: Iterable<number>, to: AlignTo,
): Shape[] {
  const list = [...new Set(indices)].filter(i => shapes[i]);
  if (list.length < 2) return shapes;
  const all = boundsOfAll(list.map(i => shapes[i]));
  if (!all) return shapes;

  const shift = (b: Box): [number, number] => {
    switch (to) {
      case 'left':     return [all.x - b.x, 0];
      case 'right':    return [all.x + all.w - (b.x + b.w), 0];
      case 'top':      return [0, all.y - b.y];
      case 'bottom':   return [0, all.y + all.h - (b.y + b.h)];
      case 'centre-x': return [all.x + all.w / 2 - (b.x + b.w / 2), 0];
      case 'centre-y': return [0, all.y + all.h / 2 - (b.y + b.h / 2)];
    }
  };
  const set = new Set(list);
  return shapes.map((s, i) => {
    if (!set.has(i)) return s;
    const [dx, dy] = shift(boundsOf(s));
    return dx === 0 && dy === 0 ? s : mapShape(s, translation(dx, dy));
  });
}

/** Move by an offset — the mapping form, so it composes with the rest. */
export function translation(dx: number, dy: number): Mapping {
  return {
    pt: ([x, y]) => [x + dx, y + dy],
    k: 1, angle: a => a, reverses: false, textRot: 0, swapAnchor: false,
  };
}

/**
 * Even out the gaps between the picked shapes.
 *
 * The two outermost stay where they are — they are what "evenly" is measured
 * between — and the rest are spread between them, which is what a row of
 * feeder blocks or a column of terminals wants.
 */
export function distributeShapes(
  shapes: Shape[], indices: Iterable<number>, axis: 'x' | 'y',
): Shape[] {
  const list = [...new Set(indices)].filter(i => shapes[i]);
  if (list.length < 3) return shapes;
  const centre = (i: number) => {
    const b = boundsOf(shapes[i]);
    return axis === 'x' ? b.x + b.w / 2 : b.y + b.h / 2;
  };
  const order = [...list].sort((a, b) => centre(a) - centre(b));
  const first = centre(order[0]);
  const last = centre(order[order.length - 1]);
  const step = (last - first) / (order.length - 1);

  const shift = new Map<number, number>();
  order.forEach((i, k) => shift.set(i, first + step * k - centre(i)));
  return shapes.map((s, i) => {
    const d = shift.get(i);
    if (!d) return s;
    return mapShape(s, axis === 'x' ? translation(d, 0) : translation(0, d));
  });
}

// ── Where things cross ──────────────────────────────────────────────────────

/** Every straight run a shape is drawn with — what a cut can happen against. */
function segmentsOf(s: Shape): [Pt, Pt][] {
  const seg = (a: Pt, b: Pt): [Pt, Pt] => [a, b];
  switch (s.t) {
    case 'line':
      return [seg([s.x1, s.y1], [s.x2, s.y2])];
    case 'rect': {
      const c: Pt[] = [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]];
      return [seg(c[0], c[1]), seg(c[1], c[2]), seg(c[2], c[3]), seg(c[3], c[0])];
    }
    case 'poly': {
      const pts = s.close && s.pts.length > 2 ? [...s.pts, s.pts[0]] : s.pts;
      return pts.slice(1).map((p, i) => seg(pts[i], p));
    }
    case 'curve': {
      const STEPS = 16;
      const pts: Pt[] = [];
      for (let i = 0; i <= STEPS; i++) {
        const t = i / STEPS, u = 1 - t;
        pts.push([
          u * u * s.x1 + 2 * u * t * s.cx + t * t * s.x2,
          u * u * s.y1 + 2 * u * t * s.cy + t * t * s.y2,
        ]);
      }
      return pts.slice(1).map((p, i) => seg(pts[i], p));
    }
    case 'circle': case 'ellipse': case 'arc': {
      // Walked finely enough that a cut lands where the eye says it should.
      const STEPS = 96;
      const pts: Pt[] = [];
      const a0 = s.t === 'arc' ? s.a0 : 0;
      const a1 = s.t === 'arc' ? s.a1 : 360;
      for (let i = 0; i <= STEPS; i++) {
        const a = a0 + ((a1 - a0) * i) / STEPS;
        pts.push(s.t === 'ellipse'
          ? [s.cx + s.rx * Math.cos(a * DEG), s.cy + s.ry * Math.sin(a * DEG)]
          : onArc(s.cx, s.cy, s.t === 'circle' ? s.r : s.r, a));
      }
      return pts.slice(1).map((p, i) => seg(pts[i], p));
    }
    case 'text':
      return [];
  }
}

/**
 * Where a segment crosses another, as the fraction along the first.
 *
 * `null` when they are parallel or the crossing is off the end of either.
 */
function crossAt(a: [Pt, Pt], b: [Pt, Pt]): number | null {
  const [p, p2] = a, [q, q2] = b;
  const rx = p2[0] - p[0], ry = p2[1] - p[1];
  const sx = q2[0] - q[0], sy = q2[1] - q[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < EPS) return null;
  const t = ((q[0] - p[0]) * sy - (q[1] - p[1]) * sx) / denom;
  const u = ((q[0] - p[0]) * ry - (q[1] - p[1]) * rx) / denom;
  if (u < -EPS || u > 1 + EPS) return null;
  return t;
}

/** The fraction along a segment that is nearest a point. */
function alongAt(a: Pt, b: Pt, at: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  if (len < EPS) return 0;
  return ((at[0] - a[0]) * dx + ((at[1] - a[1]) * dy)) / len;
}

const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Every fraction along `index`'s line where some other shape crosses it. */
function cutsOn(shapes: Shape[], index: number, skip?: ReadonlySet<Layer>): number[] {
  const target = shapes[index];
  if (!target || target.t !== 'line') return [];
  const run: [Pt, Pt] = [[target.x1, target.y1], [target.x2, target.y2]];
  const out: number[] = [];
  shapes.forEach((s, i) => {
    if (i === index || skip?.has(s.layer)) return;
    for (const seg of segmentsOf(s)) {
      const t = crossAt(run, seg);
      if (t !== null) out.push(t);
    }
  });
  return out.sort((a, b) => a - b);
}

/** What a command did, and enough of a reason when it did nothing. */
export interface EditResult {
  shapes: Shape[];
  ok: boolean;
  /** Which key in the editor's own words explains a failure. */
  why?: 'not-a-line' | 'no-crossing' | 'parallel' | 'nothing-there';
  /** Where the selection should be left. */
  selection?: number[];
}

/**
 * Trim — cut a line back to what it crosses.
 *
 * The piece under the cursor goes, bounded by the nearest crossing either side
 * of it. A line crossed in the middle and clicked at one end keeps the other
 * end; clicked between two crossings it keeps both ends and becomes two lines,
 * which is the case that matters when a wire is cut out from between two rails.
 * A line nothing crosses is removed whole — the same as EPLAN, where trimming
 * an unbounded line deletes it.
 */
export function trimLine(
  shapes: Shape[], index: number, at: Pt, skip?: ReadonlySet<Layer>,
): EditResult {
  const target = shapes[index];
  if (!target || target.t !== 'line') return { shapes, ok: false, why: 'not-a-line' };

  const a: Pt = [target.x1, target.y1], b: Pt = [target.x2, target.y2];
  const cuts = cutsOn(shapes, index, skip).filter(t => t > EPS && t < 1 - EPS);
  const t0 = Math.max(0, Math.min(1, alongAt(a, b, at)));

  const lo = cuts.filter(t => t <= t0).pop() ?? 0;
  const hi = cuts.find(t => t > t0) ?? 1;

  const keep: Shape[] = [];
  if (lo > EPS) {
    const [x2, y2] = lerp(a, b, lo);
    keep.push({ ...target, x2, y2 });
  }
  if (hi < 1 - EPS) {
    const [x1, y1] = lerp(a, b, hi);
    keep.push({ ...target, x1, y1 });
  }

  const next = [...shapes.slice(0, index), ...keep, ...shapes.slice(index + 1)];
  return {
    shapes: next,
    ok: true,
    selection: keep.map((_, k) => index + k),
  };
}

/**
 * Extend — run a line on until it meets something.
 *
 * The end nearer the cursor is the one that grows, and it stops at the first
 * thing in its way. Nothing in the way and the line is left alone rather than
 * shot off the sheet.
 */
export function extendLine(
  shapes: Shape[], index: number, at: Pt, skip?: ReadonlySet<Layer>,
): EditResult {
  const target = shapes[index];
  if (!target || target.t !== 'line') return { shapes, ok: false, why: 'not-a-line' };

  const a: Pt = [target.x1, target.y1], b: Pt = [target.x2, target.y2];
  const grow = alongAt(a, b, at) > 0.5 ? 'end' : 'start';

  // The line itself, pointed the way it is growing. `crossAt` does not bound
  // the first segment, so a crossing past the growing end is simply t > 1 —
  // and the nearest such crossing is where the line stops.
  const ray: [Pt, Pt] = grow === 'end' ? [a, b] : [b, a];

  let best: number | null = null;
  shapes.forEach((s, i) => {
    if (i === index || skip?.has(s.layer)) return;
    for (const seg of segmentsOf(s)) {
      const t = crossAt(ray, seg);
      if (t !== null && t > 1 + 1e-6 && (best === null || t < best)) best = t;
    }
  });
  if (best === null) return { shapes, ok: false, why: 'no-crossing' };

  const hit = lerp(ray[0], ray[1], best);
  const next = shapes.map((s, i) => (i === index
    ? (grow === 'end'
        ? { ...target, x2: hit[0], y2: hit[1] }
        : { ...target, x1: hit[0], y1: hit[1] })
    : s));
  return { shapes: next, ok: true, selection: [index] };
}

/**
 * Corner — bring two lines together where they would meet.
 *
 * Each line keeps the side it was clicked on and gives up the rest, so the
 * corner appears where the eye already put it. Both lines are extended or cut
 * as needed, which is one command for what would otherwise be a trim, an
 * extend, and a nudge.
 *
 * With a radius the corner is rounded instead: the lines stop at the tangent
 * points and an arc joins them — EPLAN's rounded corner, and the same command,
 * because "sharp or rounded" is a number rather than a different intention.
 */
export function cornerLines(
  shapes: Shape[], i: number, j: number, atI: Pt, atJ: Pt, radius = 0,
): EditResult {
  const A = shapes[i], B = shapes[j];
  if (!A || A.t !== 'line' || !B || B.t !== 'line' || i === j) {
    return { shapes, ok: false, why: 'not-a-line' };
  }

  const a1: Pt = [A.x1, A.y1], a2: Pt = [A.x2, A.y2];
  const b1: Pt = [B.x1, B.y1], b2: Pt = [B.x2, B.y2];

  // Where the two lines meet if both are run on for ever.
  const rx = a2[0] - a1[0], ry = a2[1] - a1[1];
  const sx = b2[0] - b1[0], sy = b2[1] - b1[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < EPS) return { shapes, ok: false, why: 'parallel' };
  const t = ((b1[0] - a1[0]) * sy - (b1[1] - a1[1]) * sx) / denom;
  const corner = lerp(a1, a2, t);
  const u = ((b1[0] - a1[0]) * ry - (b1[1] - a1[1]) * rx) / denom;

  // The side each line was clicked on is the side that stays.
  const keepA = alongAt(a1, a2, atI) < t ? 'start' : 'end';
  const keepB = alongAt(b1, b2, atJ) < u ? 'start' : 'end';
  // The end that survives, which the corner is measured back from.
  const heelA = keepA === 'start' ? a1 : a2;
  const heelB = keepB === 'start' ? b1 : b2;

  const unit = (from: Pt): Pt => {
    const dx = from[0] - corner[0], dy = from[1] - corner[1];
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  };
  const ua = unit(heelA), ub = unit(heelB);

  // How far back from the corner each line has to stop for an arc of `radius`
  // to touch both. Zero radius leaves them meeting at the corner itself.
  let back = 0;
  if (radius > 0) {
    const cosTheta = Math.max(-1, Math.min(1, ua[0] * ub[0] + ua[1] * ub[1]));
    const theta = Math.acos(cosTheta);
    // Lines folded back on themselves have no corner to round.
    if (theta > EPS && Math.abs(Math.PI - theta) > EPS) back = radius / Math.tan(theta / 2);
  }
  const endA: Pt = [corner[0] + ua[0] * back, corner[1] + ua[1] * back];
  const endB: Pt = [corner[0] + ub[0] * back, corner[1] + ub[1] * back];

  const cutTo = (line: Extract<Shape, { t: 'line' }>, keep: 'start' | 'end', to: Pt): Shape =>
    (keep === 'start'
      ? { ...line, x2: to[0], y2: to[1] }
      : { ...line, x1: to[0], y1: to[1] });

  let next = shapes.map((s, k) => {
    if (k === i) return cutTo(A, keepA, endA);
    if (k === j) return cutTo(B, keepB, endB);
    return s;
  });

  const selection = [i, j];
  if (radius > 0 && back > 0) {
    // The arc's centre sits along the bisector, far enough out that the radius
    // just reaches both lines.
    const bx = ua[0] + ub[0], by = ua[1] + ub[1];
    const blen = Math.hypot(bx, by);
    if (blen > EPS) {
      const cosTheta = Math.max(-1, Math.min(1, ua[0] * ub[0] + ua[1] * ub[1]));
      const away = radius / Math.sin(Math.acos(cosTheta) / 2);
      const cx = corner[0] + (bx / blen) * away;
      const cy = corner[1] + (by / blen) * away;
      const deg = (p: Pt) => norm360((Math.atan2(p[1] - cy, p[0] - cx) * 180) / Math.PI);
      let a0 = deg(endA), a1 = deg(endB);
      // Take the short way round — the fillet, not the rest of the circle.
      if (a1 < a0) a1 += 360;
      if (a1 - a0 > 180) { const swap = a0; a0 = a1 - 360; a1 = swap; }
      next = [...next, {
        t: 'arc', cx, cy, r: radius, a0, a1,
        layer: A.layer, color: A.color, width: A.width, dash: A.dash,
      }];
      selection.push(next.length - 1);
    }
  }

  return { shapes: next, ok: true, selection };
}

// ── Dimensions ──────────────────────────────────────────────────────────────

/** How a dimension is drawn — what the whole run is made of. */
export interface DimensionStyle {
  layer: Layer;
  color?: string;
  width?: number;
  /** Text height in drawing units. */
  textSize: number;
  /** Drawing units to millimetres, so the label reads in real size. */
  mmPerUnit: number;
  /** Arrowhead length in drawing units. */
  arrow?: number;
}

/**
 * A dimension between two points, offset to where the cursor put it.
 *
 * It comes back as ordinary geometry — two extension lines, the dimension line,
 * two filled arrowheads and the label — rather than as a shape of its own. That
 * keeps every back-end working without a new case, and it is how DXF R12 would
 * have to carry it anyway. The cost is that the number does not follow the
 * geometry afterwards, which is why the label is placed as measured, once.
 */
export function dimensionShapes(from: Pt, to: Pt, through: Pt, style: DimensionStyle): Shape[] {
  const { layer, color, width, textSize, mmPerUnit } = style;
  const pen = { layer, color, width };

  const dx = to[0] - from[0], dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len < EPS) return [];

  // Along the measured run, and square to it — the side the cursor is on.
  const ux = dx / len, uy = dy / len;
  const nx = -uy, ny = ux;
  const offset = (through[0] - from[0]) * nx + (through[1] - from[1]) * ny;

  const p1: Pt = [from[0] + nx * offset, from[1] + ny * offset];
  const p2: Pt = [to[0] + nx * offset, to[1] + ny * offset];
  // The extension lines stand off the point they measure and run a little past
  // the dimension line, the way a drawing office draws them.
  const gap = textSize * 0.3;
  const over = textSize * 0.4;
  const stand = (p: Pt, q: Pt): Shape => ({
    t: 'line',
    x1: p[0] + nx * Math.sign(offset) * gap, y1: p[1] + ny * Math.sign(offset) * gap,
    x2: q[0] + nx * Math.sign(offset) * over, y2: q[1] + ny * Math.sign(offset) * over,
    ...pen,
  });

  const head = style.arrow ?? Math.max(textSize * 0.5, len * 0.02);
  const wing = head * 0.35;
  const arrowAt = (tip: Pt, sign: number): Shape => ({
    t: 'poly',
    pts: [
      tip,
      [tip[0] + ux * head * sign + nx * wing, tip[1] + uy * head * sign + ny * wing],
      [tip[0] + ux * head * sign - nx * wing, tip[1] + uy * head * sign - ny * wing],
    ],
    close: true,
    layer, color, width: 0, fill: color ?? '#111',
  });

  // Read along the run, and never upside down — a label past the upright flips
  // so it stays the right way up, which is what every drawing standard asks.
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  let rot = -deg;                       // sheet space is y-down; text is not
  if (rot > 90 || rot <= -90) rot += 180;

  const mid: Pt = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  const label = (len * mmPerUnit).toFixed(len * mmPerUnit < 10 ? 1 : 0);

  return [
    stand(from, p1),
    stand(to, p2),
    { t: 'line', x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], ...pen },
    arrowAt(p1, +1),
    arrowAt(p2, -1),
    {
      t: 'text',
      // Lifted clear of the line it labels, on the side away from the geometry.
      x: mid[0] - nx * Math.sign(offset) * textSize * 0.35,
      y: mid[1] - ny * Math.sign(offset) * textSize * 0.35,
      s: label, size: textSize, anchor: 'middle', rot: norm360(rot) || undefined,
      layer, color: color ?? '#111', width: 0,
    },
  ];
}

// ── Grips ───────────────────────────────────────────────────────────────────
//
// The little squares on a picked shape that drag one point of it rather than
// the whole thing. This is how a line is shortened from the end you took hold
// of, which is the difference between editing a drawing and redrawing it.

/** One draggable point of a shape. */
export interface Grip {
  /** Which point of the shape this is — passed back to `moveGrip`. */
  id: string;
  at: Pt;
  /**
   * `end` moves one point and leaves the rest. `size` changes an extent — a
   * radius, a width — about a fixed centre. `whole` shifts the shape entire.
   * The canvas draws them differently so a hand knows which is which.
   */
  kind: 'end' | 'size' | 'whole';
}

/** The points of a shape a pointer can take hold of. */
export function gripsOf(s: Shape): Grip[] {
  switch (s.t) {
    case 'line':
      return [
        { id: 'a', at: [s.x1, s.y1], kind: 'end' },
        { id: 'b', at: [s.x2, s.y2], kind: 'end' },
        { id: 'mid', at: [(s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2], kind: 'whole' },
      ];

    case 'rect':
      return [
        { id: 'nw', at: [s.x, s.y], kind: 'end' },
        { id: 'ne', at: [s.x + s.w, s.y], kind: 'end' },
        { id: 'se', at: [s.x + s.w, s.y + s.h], kind: 'end' },
        { id: 'sw', at: [s.x, s.y + s.h], kind: 'end' },
        { id: 'mid', at: [s.x + s.w / 2, s.y + s.h / 2], kind: 'whole' },
      ];

    case 'circle':
      return [
        { id: 'centre', at: [s.cx, s.cy], kind: 'whole' },
        { id: 'r', at: [s.cx + s.r, s.cy], kind: 'size' },
      ];

    case 'ellipse':
      return [
        { id: 'centre', at: [s.cx, s.cy], kind: 'whole' },
        { id: 'rx', at: [s.cx + s.rx, s.cy], kind: 'size' },
        { id: 'ry', at: [s.cx, s.cy + s.ry], kind: 'size' },
      ];

    case 'arc':
      return [
        { id: 'centre', at: [s.cx, s.cy], kind: 'whole' },
        { id: 'a0', at: onArc(s.cx, s.cy, s.r, s.a0), kind: 'end' },
        { id: 'a1', at: onArc(s.cx, s.cy, s.r, s.a1), kind: 'end' },
      ];

    case 'curve':
      return [
        { id: 'a', at: [s.x1, s.y1], kind: 'end' },
        { id: 'c', at: [s.cx, s.cy], kind: 'size' },
        { id: 'b', at: [s.x2, s.y2], kind: 'end' },
      ];

    case 'poly':
      return s.pts.map((p, i) => ({ id: `p${i}`, at: p, kind: 'end' as const }));

    case 'text':
      return [{ id: 'at', at: [s.x, s.y], kind: 'whole' }];
  }
}

/**
 * The shape with one of its grips moved to `to`.
 *
 * A `whole` grip carries the shape with it; the others move the one point they
 * name. An unknown id leaves the shape alone rather than guessing, so a stale
 * grip from a shape that has since changed kind cannot deform it.
 */
export function moveGrip(s: Shape, id: string, to: Pt): Shape {
  const [x, y] = to;

  if (id === 'mid' || id === 'at' || (id === 'centre' && s.t !== 'arc')) {
    // The handle that shifts the whole shape, wherever it sits on it.
    const from = gripsOf(s).find(g => g.id === id)?.at;
    if (!from) return s;
    return mapShape(s, translation(x - from[0], y - from[1]));
  }

  switch (s.t) {
    case 'line':
      if (id === 'a') return { ...s, x1: x, y1: y };
      if (id === 'b') return { ...s, x2: x, y2: y };
      return s;

    case 'rect': {
      // The corner opposite the one being dragged stays put, so the rectangle
      // follows the pointer the way every drawing package does it.
      const corners: Record<string, [Pt, Pt]> = {
        nw: [[s.x + s.w, s.y + s.h], [x, y]],
        ne: [[s.x, s.y + s.h], [x, y]],
        se: [[s.x, s.y], [x, y]],
        sw: [[s.x + s.w, s.y], [x, y]],
      };
      const pair = corners[id];
      if (!pair) return s;
      const [fixed, moved] = pair;
      return {
        ...s,
        x: Math.min(fixed[0], moved[0]), y: Math.min(fixed[1], moved[1]),
        w: Math.abs(moved[0] - fixed[0]), h: Math.abs(moved[1] - fixed[1]),
      };
    }

    case 'circle':
      return id === 'r' ? { ...s, r: Math.max(0.1, Math.hypot(x - s.cx, y - s.cy)) } : s;

    case 'ellipse':
      if (id === 'rx') return { ...s, rx: Math.max(0.1, Math.abs(x - s.cx)) };
      if (id === 'ry') return { ...s, ry: Math.max(0.1, Math.abs(y - s.cy)) };
      return s;

    case 'arc': {
      // The radius follows whichever end is dragged, and the other end keeps
      // the angle it had — dragging an end sweeps the arc rather than moving
      // its centre, which is what the handle looks like it should do.
      const deg = norm360((Math.atan2(y - s.cy, x - s.cx) * 180) / Math.PI);
      const r = Math.max(0.1, Math.hypot(x - s.cx, y - s.cy));
      if (id === 'centre') return { ...s, cx: x, cy: y };
      if (id === 'a0') {
        let a0 = deg, a1 = s.a1;
        while (a1 <= a0) a1 += 360;
        return { ...s, r, a0, a1 };
      }
      if (id === 'a1') {
        let a0 = s.a0, a1 = deg;
        while (a1 <= a0) a1 += 360;
        return { ...s, r, a0, a1 };
      }
      return s;
    }

    case 'curve':
      if (id === 'a') return { ...s, x1: x, y1: y };
      if (id === 'b') return { ...s, x2: x, y2: y };
      if (id === 'c') return { ...s, cx: x, cy: y };
      return s;

    case 'poly': {
      const i = Number(id.slice(1));
      if (!Number.isInteger(i) || i < 0 || i >= s.pts.length) return s;
      return { ...s, pts: s.pts.map((p, k) => (k === i ? [x, y] as Pt : p)) };
    }

    case 'text':
      return s;
  }
}

// ── Reading a shape as numbers ──────────────────────────────────────────────

/**
 * How long a line is and which way it points, the way a drawing office says it.
 *
 * The angle runs anticlockwise from horizontal — 0 along the sheet, 90 straight
 * up — which is what EPLAN's own readout shows and the opposite of the y-down
 * sense the geometry is stored in.
 */
export function lineMetrics(s: Extract<Shape, { t: 'line' }>): { length: number; angle: number } {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
  return {
    length: Math.hypot(dx, dy),
    angle: norm360(-(Math.atan2(dy, dx) * 180) / Math.PI),
  };
}

/** The same line at a given length and angle, its first end held fast. */
export function lineFrom(
  s: Extract<Shape, { t: 'line' }>, length: number, angleDeg: number,
): Extract<Shape, { t: 'line' }> {
  const a = -angleDeg * DEG;
  return { ...s, x2: s.x1 + Math.cos(a) * length, y2: s.y1 + Math.sin(a) * length };
}

// ── Blocks ──────────────────────────────────────────────────────────────────
//
// A symbol from the library arrives as a dozen lines and arcs that are one
// *thing*. Picking one line of a contactor is never what anybody meant, so the
// shapes carry a `block` id and the editor treats them as one: picked together,
// moved together, deleted together.
//
// Two copies of the same symbol share a `blockName` and have different `block`
// ids — which is exactly the distinction a CAD system draws between a block
// definition and an insert of it.

/** A short id, unique enough for one drawing. */
export function newBlockId(): string {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** The picked shapes made into one block. */
export function groupShapes(
  shapes: Shape[], indices: Iterable<number>, name = 'GROUP',
): { shapes: Shape[]; selection: number[] } {
  const set = new Set([...indices].filter(i => shapes[i]));
  if (set.size < 2) return { shapes, selection: [...set] };
  const block = newBlockId();
  return {
    shapes: shapes.map((s, i) => (set.has(i) ? { ...s, block, blockName: name } : s)),
    selection: [...set],
  };
}

/** The picked shapes taken out of whatever blocks they were in. */
export function ungroupShapes(
  shapes: Shape[], indices: Iterable<number>,
): { shapes: Shape[]; selection: number[] } {
  // Every shape of a touched block comes apart, not just the ones picked: a
  // block half in and half out of a block is not a thing.
  const blocks = new Set(
    [...indices].map(i => shapes[i]?.block).filter((b): b is string => Boolean(b)));
  if (blocks.size === 0) return { shapes, selection: [...indices] };
  const out: number[] = [];
  const next = shapes.map((s, i) => {
    if (!s.block || !blocks.has(s.block)) return s;
    out.push(i);
    const { block, blockName, ...rest } = s;
    return rest as Shape;
  });
  return { shapes: next, selection: out };
}

/**
 * A selection widened to whole blocks.
 *
 * Run on every pick, so clicking one line of a symbol takes the symbol. A shape
 * in no block is only itself.
 */
export function withWholeBlocks(shapes: Shape[], indices: Iterable<number>): Set<number> {
  const picked = new Set(indices);
  const blocks = new Set(
    [...picked].map(i => shapes[i]?.block).filter((b): b is string => Boolean(b)));
  if (blocks.size === 0) return picked;
  shapes.forEach((s, i) => { if (s.block && blocks.has(s.block)) picked.add(i); });
  return picked;
}

/** Every block on the sheet, with what it is called and how big it is. */
export function blocksOf(shapes: Shape[]): { id: string; name: string; count: number }[] {
  const seen = new Map<string, { id: string; name: string; count: number }>();
  for (const s of shapes) {
    if (!s.block) continue;
    const had = seen.get(s.block);
    if (had) had.count += 1;
    else seen.set(s.block, { id: s.block, name: s.blockName ?? 'GROUP', count: 1 });
  }
  return [...seen.values()];
}

/**
 * A run of shapes placed at a point, as one block.
 *
 * What importing a symbol comes down to: take the geometry, move it so its
 * top-left sits where it was dropped, and tag the lot.
 */
export function placeAsBlock(
  run: Shape[], at: Pt, name: string, scale = 1, symbol?: string,
): Shape[] {
  if (run.length === 0) return [];
  const b = boundsOfAll(run);
  const block = newBlockId();
  const sized = scale === 1 || !b
    ? run
    : run.map(s => mapShape(s, scaling(b.x, b.y, scale)));
  const box = boundsOfAll(sized);
  const dx = box ? at[0] - box.x : 0;
  const dy = box ? at[1] - box.y : 0;
  // `symbol` is what it is in the library, kept on every shape so a symbol
  // redrawn for the project can find the ones already on the sheets.
  return sized.map(s => ({
    ...mapShape(s, translation(dx, dy)), block, blockName: name, symbol,
  }));
}
