// What the geometry on a sheet *means*, as against how it looks.
//
// Everything here reads shapes and works out the schematic underneath them:
// which wires are the same electrical net, which symbols are devices, what is
// tagged and what is not, and what looks wrong. The drawing stays the only
// state — nothing is stored alongside it that could drift out of step with
// what is actually on the page.
//
// The shape of the checking follows EPLAN's, because it is what the office
// already knows: a run of checks produces *messages*, each with a class
// (error, warning, note) and a category, and the list is something you work
// through rather than a popup you dismiss. The wording and the rules are ours.

import { Layer, Pt, Shape } from './shapes';

/** How near two coordinates must be to count as the same point, in units. */
const EPS = 0.35;

const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
const key = (p: Pt) => `${Math.round(p[0] / EPS)}:${Math.round(p[1] / EPS)}`;

/** Layers whose geometry carries current, and so forms nets. */
const CONDUCTIVE: ReadonlySet<Layer> = new Set<Layer>(['WIRE', 'BUS']);

export interface Segment {
  /** Index of the shape this came from, so a message can point back at it. */
  index: number;
  a: Pt;
  b: Pt;
  layer: Layer;
}

/** Every straight run of conductor on the sheet. */
export function conductors(shapes: Shape[]): Segment[] {
  const out: Segment[] = [];
  shapes.forEach((s, index) => {
    const layer = (s as { layer?: Layer }).layer;
    if (!layer || !CONDUCTIVE.has(layer)) return;
    if (s.t === 'line') out.push({ index, a: [s.x1, s.y1], b: [s.x2, s.y2], layer });
    else if (s.t === 'poly') {
      for (let i = 0; i + 1 < s.pts.length; i++) {
        out.push({ index, a: s.pts[i], b: s.pts[i + 1], layer });
      }
    }
  });
  return out;
}

/** Disjoint-set over point keys — the usual way to grow nets from segments. */
class Union {
  private parent = new Map<string, string>();
  find(k: string): string {
    const p = this.parent.get(k);
    if (p === undefined) { this.parent.set(k, k); return k; }
    if (p === k) return k;
    const root = this.find(p);
    this.parent.set(k, root);
    return root;
  }
  join(a: string, b: string) { this.parent.set(this.find(a), this.find(b)); }
}

export interface Net {
  /** Stable, drawing-order name: 1 is the topmost-leftmost net on the sheet. */
  id: number;
  segments: Segment[];
  /** Every distinct point on the net. */
  points: Pt[];
}

/**
 * The nets on a sheet: runs of conductor joined where they touch.
 *
 * Touching is endpoint-to-endpoint, or an endpoint landing part-way along
 * another run — which is the T-join the connect tool marks with a dot. Two
 * runs *crossing* are not joined, which is the same rule a reader applies and
 * the reason `wiresCrossing` below is a check rather than a connection.
 *
 * Numbered top-to-bottom then left-to-right so the answer does not move about
 * when unrelated geometry is added: a wire number that changes because
 * something was drawn elsewhere is worse than no wire number.
 */
export function nets(shapes: Shape[]): Net[] {
  const segs = conductors(shapes);
  const u = new Union();

  for (const s of segs) u.join(key(s.a), key(s.b));

  // A T-join: one run's end sitting on another run's body.
  for (const s of segs) {
    for (const other of segs) {
      if (other === s) continue;
      for (const end of [s.a, s.b]) {
        if (same(end, other.a) || same(end, other.b)) continue;
        if (onSegment(end, other.a, other.b)) u.join(key(end), key(other.a));
      }
    }
  }

  const groups = new Map<string, Segment[]>();
  for (const s of segs) {
    const root = u.find(key(s.a));
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(s);
  }

  const list = [...groups.values()].map(segments => {
    const points: Pt[] = [];
    for (const s of segments) {
      for (const p of [s.a, s.b]) if (!points.some(q => same(p, q))) points.push(p);
    }
    return { id: 0, segments, points };
  });

  list.sort((p, q) => {
    const top = (n: typeof p) => Math.min(...n.points.map(x => x[1]));
    const left = (n: typeof p) => Math.min(...n.points.map(x => x[0]));
    return (top(p) - top(q)) || (left(p) - left(q));
  });
  list.forEach((n, i) => { n.id = i + 1; });
  return list;
}

function onSegment(p: Pt, a: Pt, b: Pt): boolean {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 < EPS * EPS) return false;
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  if (t <= 0 || t >= 1) return false;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy)) < EPS;
}

// ── Devices ────────────────────────────────────────────────────────────────

export interface Device {
  /** The block id every shape of this symbol carries. */
  block: string;
  /** What the symbol is called, which is where a tag prefix comes from. */
  blockName: string;
  /** Indices of every shape making up the symbol. */
  shapes: number[];
  /** Top-left of the symbol's extent, for placing a tag beside it. */
  at: Pt;
  /** Its designation, if one has been written on the TAG layer near it. */
  tag: string | null;
  /** Index of the text carrying that tag. */
  tagIndex: number | null;
  /** What its connection points are called. Empty for a symbol with none. */
  pins: string[];
}

/** How far from a symbol a TAG text can sit and still belong to it. */
const TAG_REACH = 28;

/**
 * The devices on a sheet: symbols, each with whatever designation is written
 * near it.
 *
 * A device is a block — the thing the symbol library puts down as one object.
 * Loose geometry is not a device, which is deliberate: a line somebody drew by
 * hand is not something to hand a designation to.
 */
export function devices(shapes: Shape[]): Device[] {
  const byBlock = new Map<string, { name: string; idx: number[]; xs: number[]; ys: number[] }>();
  shapes.forEach((s, i) => {
    const p = s as { block?: string; blockName?: string; layer?: Layer };
    if (!p.block || p.layer === 'TABLE') return;
    if (!byBlock.has(p.block)) {
      byBlock.set(p.block, { name: p.blockName ?? '', idx: [], xs: [], ys: [] });
    }
    const e = byBlock.get(p.block)!;
    e.idx.push(i);
    for (const [x, y] of pointsOf(s)) { e.xs.push(x); e.ys.push(y); }
  });

  const tags = tagTexts(shapes);
  const used = new Set<number>();

  return [...byBlock.entries()].map(([block, e]) => {
    const x0 = Math.min(...e.xs), y0 = Math.min(...e.ys);
    const x1 = Math.max(...e.xs), y1 = Math.max(...e.ys);
    const at: Pt = [x0, y0];
    // The nearest unclaimed tag within reach of the symbol's *box*, not of its
    // top-left corner. The corner is where a symbol is placed from, not where
    // it is: a PLC channel reaches thirty units to the right of the conductor
    // it stands on, so its own designation, written beside it, was further
    // from that corner than the reach allowed and the symbol came back
    // untagged. Nearest rather than first, so two symbols side by side do not
    // both take the same label.
    let best: { i: number; s: string; d: number } | null = null;
    for (const t of tags) {
      if (used.has(t.index)) continue;
      const dx = Math.max(x0 - t.at[0], 0, t.at[0] - x1);
      const dy = Math.max(y0 - t.at[1], 0, t.at[1] - y1);
      const d = Math.hypot(dx, dy);
      if (d <= TAG_REACH && (!best || d < best.d)) best = { i: t.index, s: t.text, d };
    }
    if (best) used.add(best.i);
    return {
      block, blockName: e.name, shapes: e.idx, at,
      tag: best?.s ?? null, tagIndex: best?.i ?? null,
      pins: e.idx.map(i => String((shapes[i] as { pin?: string }).pin ?? ''))
        .filter(Boolean),
    };
  }).sort((a, b) => (a.at[1] - b.at[1]) || (a.at[0] - b.at[0]));
}

function pointsOf(s: Shape): Pt[] {
  switch (s.t) {
    case 'line': return [[s.x1, s.y1], [s.x2, s.y2]];
    case 'rect': return [[s.x, s.y], [s.x + s.w, s.y + s.h]];
    case 'circle': return [[s.cx - s.r, s.cy - s.r], [s.cx + s.r, s.cy + s.r]];
    case 'ellipse': return [[s.cx - s.rx, s.cy - s.ry], [s.cx + s.rx, s.cy + s.ry]];
    case 'arc': return [[s.cx - s.r, s.cy - s.r], [s.cx + s.r, s.cy + s.r]];
    case 'curve': return [[s.x1, s.y1], [s.x2, s.y2]];
    case 'poly': return s.pts;
    case 'text': return [[s.x, s.y]];
    default: return [];
  }
}

interface TagText { index: number; text: string; at: Pt; }

function tagTexts(shapes: Shape[]): TagText[] {
  const out: TagText[] = [];
  shapes.forEach((s, index) => {
    if (s.t !== 'text') return;
    if ((s as { layer?: Layer }).layer !== 'TAG') return;
    const text = s.s.trim();
    if (text) out.push({ index, text, at: [s.x, s.y] });
  });
  return out;
}

// ── Messages ───────────────────────────────────────────────────────────────

export type MessageClass = 'error' | 'warning' | 'note';

export interface Message {
  cls: MessageClass;
  /** A short, stable code, so a message can be recognised across runs. */
  code: string;
  category: string;
  text: string;
  /** Shape indices the message is about — selecting them shows the reader. */
  shapes: number[];
  /** Where to look, for a view that jumps to it. */
  at?: Pt;
}

/**
 * Check a sheet and say what looks wrong.
 *
 * Every rule here earns its place by catching something that costs money at
 * the panel rather than something that merely offends. A dangling wire is a
 * wire somebody meant to land somewhere; two devices sharing a designation is
 * two things that will be wired as one.
 */
export function checkSheet(shapes: Shape[]): Message[] {
  const out: Message[] = [];
  const segs = conductors(shapes);

  // 1. A conductor end touching nothing at all.
  const ends = new Map<string, { p: Pt; count: number; index: number }>();
  for (const s of segs) {
    // A busbar or a potential rail is *meant* to end in space — it runs past
    // the last path on the page and stops. Reporting both ends of every rail
    // as a dangling wire is four warnings a page that are never once right,
    // and a check list that is never once empty is a check list nobody reads.
    if (s.layer === 'BUS') continue;
    for (const p of [s.a, s.b]) {
      const k = key(p);
      const e = ends.get(k);
      if (e) e.count += 1;
      else ends.set(k, { p, count: 1, index: s.index });
    }
  }
  for (const { p, count, index } of ends.values()) {
    if (count > 1) continue;
    const onAnother = segs.some(s => onSegment(p, s.a, s.b));
    const atDevice = shapes.some((s, i) => {
      const layer = (s as { layer?: Layer }).layer;
      // PIN as well as SYMBOL and LOAD: a wire that ends exactly on a
      // connection point is the most connected a wire gets, and reporting it
      // as ending in mid-air would train people to ignore this check.
      if (layer !== 'SYMBOL' && layer !== 'LOAD' && layer !== 'PIN') return false;
      return i !== index && pointsOf(s).some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < TAG_REACH / 3);
    });
    if (!onAnother && !atDevice) {
      out.push({
        cls: 'warning', code: 'W-OPEN-END', category: 'Connections',
        text: 'A wire ends in mid-air — it touches no other wire and no symbol.',
        shapes: [index], at: p,
      });
    }
  }

  // 2. Two devices carrying the same designation.
  const devs = devices(shapes);
  const byTag = new Map<string, Device[]>();
  for (const d of devs) {
    if (!d.tag) continue;
    if (!byTag.has(d.tag)) byTag.set(d.tag, []);
    byTag.get(d.tag)!.push(d);
  }
  for (const [tag, group] of byTag) {
    if (group.length < 2) continue;
    // One designation shown in several places is not a fault — it is how a
    // wiring diagram works. Terminal strip -X1 appears once per path, card -A1
    // once per channel, and the card's own common on every one of them. A page
    // that reported those as errors would report forty of them and be switched
    // off by lunchtime.
    //
    // So a device with connection points is left to `checkTerminals`, which
    // has the nets in hand and can ask the question that actually matters:
    // is the same terminal sitting on two different potentials. Here the older
    // rule stands only for symbols with no connection points, where the
    // designation is all there is to go on.
    if (group.every(d => d.pins.length > 0)) continue;
    out.push({
      cls: 'error', code: 'E-DUP-TAG', category: 'Designations',
      text: `${group.length} devices are all designated ${tag}.`,
      shapes: group.flatMap(d => d.shapes), at: group[0].at,
    });
  }

  // 3. A symbol with no designation at all.
  for (const d of devs) {
    if (d.tag) continue;
    out.push({
      cls: 'warning', code: 'W-NO-TAG', category: 'Designations',
      text: `${d.blockName || 'A symbol'} has no designation.`,
      shapes: d.shapes, at: d.at,
    });
  }

  // 4. Wires crossing with nothing to say whether they join.
  //
  // Not an error: a crossing without a dot is perfectly legal and means "not
  // connected". It is worth pointing at because it is equally often a dot
  // somebody forgot, and only the person drawing it knows which.
  for (const x of wiresCrossing(shapes)) {
    out.push({
      cls: 'note', code: 'N-CROSS', category: 'Connections',
      text: 'Two wires cross with no junction dot — they read as not connected.',
      shapes: x.shapes, at: x.at,
    });
  }

  return out.sort((a, b) => rank(a.cls) - rank(b.cls));
}

const rank = (c: MessageClass) => (c === 'error' ? 0 : c === 'warning' ? 1 : 2);

/** Crossings with no dot on them. */
export function wiresCrossing(shapes: Shape[]): { at: Pt; shapes: number[] }[] {
  const segs = conductors(shapes);
  const dots = shapes.filter(s => s.t === 'circle' && (s as { fill?: string }).fill)
    .map(s => [(s as Extract<Shape, { t: 'circle' }>).cx, (s as Extract<Shape, { t: 'circle' }>).cy] as Pt);
  const found: { at: Pt; shapes: number[] }[] = [];

  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      if (segs[i].index === segs[j].index) continue;
      const at = properCrossing(segs[i], segs[j]);
      if (!at) continue;
      if (dots.some(d => same(d, at))) continue;
      if (found.some(f => same(f.at, at))) continue;
      found.push({ at, shapes: [segs[i].index, segs[j].index] });
    }
  }
  return found;
}

/** Where two segments cross in their interiors, or null. */
function properCrossing(s: Segment, t: Segment): Pt | null {
  const [x1, y1] = s.a, [x2, y2] = s.b, [x3, y3] = t.a, [x4, y4] = t.b;
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (Math.abs(d) < 1e-9) return null;
  const ua = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
  const ub = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  // Strictly inside both: touching at an end is a join, not a crossing.
  if (ua <= 0.001 || ua >= 0.999 || ub <= 0.001 || ub >= 0.999) return null;
  return [x1 + ua * (x2 - x1), y1 + ua * (y2 - y1)];
}
