// src/utils/cad/readDxf.ts
//
// A DXF file read back into geometry — the other direction from `dxf.ts`.
//
// This is what lets the office bring its own schematics in. A device drawn
// once in AutoCAD and saved as DXF becomes a symbol here: real lines and arcs,
// not a picture of them, so it goes back out to DXF and PDF as editable
// geometry and prints at any scale.
//
// Connection points are the other half of it. EPLAN knows where a symbol's
// conductor enters and leaves; a plain DXF does not, so the convention is a
// layer — anything named CONN, CONNECTION, PIN or TERMINAL — carrying a point
// or a small circle at each terminal. Those are read, not drawn, and the sheet
// uses them to run the branch line through the device and wire it in.
//
// The dialects DXF has been through are wide; what is read here is what CAD
// packages actually write for a symbol: lines, circles, arcs, ellipses,
// polylines (with bulges), text, solids, points, and blocks placed by INSERT.
import { Drawing, Layer, Pt, Shape } from './shapes';

/** A group code and its value, which is all a DXF file is. */
interface Pair { code: number; value: string }

/** One entity: its type and the pairs that describe it. */
interface Entity {
  type: string;
  pairs: Pair[];
  /** POLYLINE keeps its points in the VERTEX entities that follow it. */
  vertices?: Entity[];
}

export interface DxfImport {
  /** The geometry, in sheet space: y downwards, origin at the top left. */
  drawing: Drawing;
  /** Terminals, in the same space, ordered top to bottom. */
  connections: Pt[];
  /** Entity types the reader passed over, and how many of each. */
  skipped: Record<string, number>;
  /** How many entities were read, blocks included. */
  entities: number;
}

const CONNECTION_LAYER = /^(conn|connection|conn_?pt|pin|pins|terminal|terminals)$/i;

// ── Reading the file ────────────────────────────────────────────────────────

function tokenize(text: string): Pair[] {
  // A DXF is strictly two lines per pair: the code, then the value.
  const lines = text.split(/\r\n|\r|\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isFinite(code)) {
      // A stray line would put every following pair out of step; resync on the
      // next line that reads as a group code.
      i -= 1;
      continue;
    }
    out.push({ code, value: lines[i + 1] });
  }
  return out;
}

const num = (e: Entity, code: number, fallback = 0): number => {
  const hit = e.pairs.find(p => p.code === code);
  const v = hit ? parseFloat(hit.value) : NaN;
  return Number.isFinite(v) ? v : fallback;
};
const str = (e: Entity, code: number, fallback = ''): string =>
  e.pairs.find(p => p.code === code)?.value.trim() ?? fallback;
const all = (e: Entity, code: number): number[] =>
  e.pairs.filter(p => p.code === code).map(p => parseFloat(p.value))
    .filter(v => Number.isFinite(v));

/** Split a run of pairs into entities, keeping POLYLINE's vertices with it. */
function readEntities(pairs: Pair[], from: number, to: number): Entity[] {
  const flat: Entity[] = [];
  let current: Entity | null = null;
  for (let i = from; i < to; i++) {
    const p = pairs[i];
    if (p.code === 0) {
      current = { type: p.value.trim().toUpperCase(), pairs: [] };
      flat.push(current);
    } else if (current) {
      current.pairs.push(p);
    }
  }

  // VERTEX entities belong to the POLYLINE before them, up to SEQEND.
  const out: Entity[] = [];
  for (const e of flat) {
    if (e.type === 'VERTEX' && out.length && out[out.length - 1].type === 'POLYLINE') {
      (out[out.length - 1].vertices ??= []).push(e);
    } else if (e.type === 'SEQEND') {
      continue;
    } else {
      out.push(e);
    }
  }
  return out;
}

/** The named sections of the file, as spans into the pair list. */
function sections(pairs: Pair[]): Map<string, [number, number]> {
  const found = new Map<string, [number, number]>();
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].code !== 0 || pairs[i].value.trim().toUpperCase() !== 'SECTION') continue;
    const name = pairs[i + 1]?.code === 2 ? pairs[i + 1].value.trim().toUpperCase() : '';
    let end = i + 2;
    while (end < pairs.length &&
           !(pairs[end].code === 0 && pairs[end].value.trim().toUpperCase() === 'ENDSEC')) end++;
    if (name) found.set(name, [i + 2, end]);
    i = end;
  }
  return found;
}

/** Blocks, by name, so INSERT can place them. */
function readBlocks(pairs: Pair[], span: [number, number]): Map<string, Entity[]> {
  const blocks = new Map<string, Entity[]>();
  let i = span[0];
  while (i < span[1]) {
    if (pairs[i].code === 0 && pairs[i].value.trim().toUpperCase() === 'BLOCK') {
      let end = i + 1;
      while (end < span[1] &&
             !(pairs[end].code === 0 && pairs[end].value.trim().toUpperCase() === 'ENDBLK')) end++;
      const header = readEntities(pairs, i, Math.min(i + 40, end))[0];
      const name = header ? str(header, 2) : '';
      // A block's own base point is subtracted, so INSERT places it by that point.
      const bx = header ? num(header, 10) : 0;
      const by = header ? num(header, 20) : 0;
      let body = readEntities(pairs, i, end);
      body = body.slice(1);                       // drop the BLOCK header itself
      if (name) blocks.set(name.toUpperCase(), body.map(e => ({
        ...e,
        pairs: [...e.pairs, { code: -1, value: `${bx},${by}` }],   // remembered below
      })));
      i = end + 1;
    } else {
      i++;
    }
  }
  return blocks;
}

// ── Turning entities into shapes ────────────────────────────────────────────

/**
 * Where an entity ends up: scaled, turned and moved.
 *
 * Angles are in degrees and follow DXF's own convention here — counter
 * clockwise in a y-up world. They are converted to sheet space once, at the
 * end, when the whole drawing is flipped.
 */
interface Placement { ox: number; oy: number; sx: number; sy: number; rot: number }
const PLAIN: Placement = { ox: 0, oy: 0, sx: 1, sy: 1, rot: 0 };

function place(t: Placement, x: number, y: number): Pt {
  const a = (t.rot * Math.PI) / 180;
  const px = x * t.sx, py = y * t.sy;
  return [t.ox + px * Math.cos(a) - py * Math.sin(a), t.oy + px * Math.sin(a) + py * Math.cos(a)];
}
const uniform = (t: Placement) => Math.abs(Math.abs(t.sx) - Math.abs(t.sy)) < 1e-9;
const scaleOf = (t: Placement) => Math.sqrt(Math.abs(t.sx * t.sy)) || 1;

const SYMBOL_PEN = { layer: 'SYMBOL' as Layer, color: '#111', width: 1.2 };
const TEXT_PEN = { layer: 'TEXT' as Layer, color: '#111', width: 0 };

/** A circle or arc under a non-uniform scale is no longer either. */
function ovalPoints(
  t: Placement, cx: number, cy: number, r: number, a0 = 0, a1 = 360, steps = 48,
): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    pts.push(place(t, cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  return pts;
}

/**
 * A polyline segment's bulge, as the arc it stands for.
 *
 * The bulge is the tangent of a quarter of the included angle — the compact
 * way DXF stores "this segment is really an arc" — so the angle, the radius
 * and the centre all come back out of it.
 */
function bulgeArc(p1: Pt, p2: Pt, bulge: number) {
  const theta = 4 * Math.atan(bulge);
  const chord = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  if (chord === 0 || theta === 0) return null;
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const mid: Pt = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  const h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
  // The centre sits off the chord, on the side the bulge's sign chooses.
  const nx = -(p2[1] - p1[1]) / chord, ny = (p2[0] - p1[0]) / chord;
  const away = Math.abs(theta) > Math.PI ? -1 : 1;
  const sign = (bulge > 0 ? 1 : -1) * away;
  const c: Pt = [mid[0] + nx * h * sign, mid[1] + ny * h * sign];
  const deg = (p: Pt) => (Math.atan2(p[1] - c[1], p[0] - c[0]) * 180) / Math.PI;
  let a0 = deg(p1), a1 = deg(p2);
  if (bulge < 0) [a0, a1] = [a1, a0];              // DXF arcs are always CCW
  if (a1 <= a0) a1 += 360;
  return { cx: c[0], cy: c[1], r, a0, a1 };
}

/** Vertices of a polyline, with each one's bulge. */
function polyPoints(e: Entity): { pts: Pt[]; bulges: number[]; closed: boolean } {
  if (e.type === 'LWPOLYLINE') {
    const xs = all(e, 10), ys = all(e, 20);
    // Bulges are sparse — only the vertices that have one carry a 42.
    const bulges: number[] = new Array(xs.length).fill(0);
    let vertex = -1;
    for (const p of e.pairs) {
      if (p.code === 10) vertex += 1;
      else if (p.code === 42 && vertex >= 0) bulges[vertex] = parseFloat(p.value) || 0;
    }
    return {
      pts: xs.map((x, i) => [x, ys[i] ?? 0] as Pt),
      bulges,
      closed: (num(e, 70) & 1) === 1,
    };
  }
  const vs = e.vertices ?? [];
  return {
    pts: vs.map(v => [num(v, 10), num(v, 20)] as Pt),
    bulges: vs.map(v => num(v, 42)),
    closed: (num(e, 70) & 1) === 1,
  };
}

interface Sink {
  shapes: Shape[];
  connections: Pt[];
  skipped: Record<string, number>;
  entities: number;
}

function convert(
  e: Entity, t: Placement, blocks: Map<string, Entity[]>, sink: Sink, depth = 0,
): void {
  const layer = str(e, 8);
  const isConnection = CONNECTION_LAYER.test(layer);
  const pen = SYMBOL_PEN;
  sink.entities += 1;

  switch (e.type) {
    case 'LINE': {
      const a = place(t, num(e, 10), num(e, 20));
      const b = place(t, num(e, 11), num(e, 21));
      if (isConnection) { sink.connections.push(a, b); return; }
      sink.shapes.push({ t: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1], ...pen });
      return;
    }

    case 'POINT': {
      const p = place(t, num(e, 10), num(e, 20));
      if (isConnection) { sink.connections.push(p); return; }
      // A bare point has no ink of its own; a tick keeps it visible.
      const r = 0.6 * scaleOf(t);
      sink.shapes.push({ t: 'line', x1: p[0] - r, y1: p[1], x2: p[0] + r, y2: p[1], ...pen });
      return;
    }

    case 'CIRCLE': {
      const c = place(t, num(e, 10), num(e, 20));
      const r = num(e, 40) * scaleOf(t);
      if (isConnection) { sink.connections.push(c); return; }
      if (uniform(t)) sink.shapes.push({ t: 'circle', cx: c[0], cy: c[1], r, ...pen });
      else sink.shapes.push({ t: 'poly', pts: ovalPoints(t, num(e, 10), num(e, 20), num(e, 40)), close: true, ...pen });
      return;
    }

    case 'ARC': {
      const cx = num(e, 10), cy = num(e, 20), r = num(e, 40);
      let a0 = num(e, 50), a1 = num(e, 51);
      if (a1 <= a0) a1 += 360;
      if (isConnection) return;
      if (uniform(t)) {
        const c = place(t, cx, cy);
        sink.shapes.push({
          t: 'arc', cx: c[0], cy: c[1], r: r * scaleOf(t),
          a0: a0 + t.rot, a1: a1 + t.rot, ...pen,
        });
      } else {
        sink.shapes.push({ t: 'poly', pts: ovalPoints(t, cx, cy, r, a0, a1, 32), ...pen });
      }
      return;
    }

    case 'ELLIPSE': {
      // The major axis is stored as a vector from the centre, the minor as a
      // ratio of it, so an ellipse turned on the page is still an ellipse.
      const cx = num(e, 10), cy = num(e, 20);
      const mx = num(e, 11), my = num(e, 21);
      const ratio = num(e, 40, 1);
      const major = Math.hypot(mx, my);
      const tilt = (Math.atan2(my, mx) * 180) / Math.PI;
      const pts: Pt[] = [];
      for (let i = 0; i <= 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        const px = major * Math.cos(a), py = major * ratio * Math.sin(a);
        const rad = (tilt * Math.PI) / 180;
        pts.push(place(t, cx + px * Math.cos(rad) - py * Math.sin(rad),
                          cy + px * Math.sin(rad) + py * Math.cos(rad)));
      }
      if (isConnection) return;
      sink.shapes.push({ t: 'poly', pts, close: true, ...pen });
      return;
    }

    case 'LWPOLYLINE':
    case 'POLYLINE': {
      const { pts, bulges, closed } = polyPoints(e);
      if (pts.length === 0) return;
      if (isConnection) { pts.forEach(p => sink.connections.push(place(t, p[0], p[1]))); return; }

      const ring = closed ? [...pts, pts[0]] : pts;
      let run: Pt[] = [];
      const flush = () => {
        if (run.length > 1) sink.shapes.push({ t: 'poly', pts: run.map(p => place(t, p[0], p[1])), ...pen });
        run = [];
      };
      for (let i = 0; i < ring.length - 1; i++) {
        const b = bulges[i] ?? 0;
        if (Math.abs(b) < 1e-9) {
          if (run.length === 0) run.push(ring[i]);
          run.push(ring[i + 1]);
          continue;
        }
        const arc = bulgeArc(ring[i], ring[i + 1], b);
        if (!arc) { if (run.length === 0) run.push(ring[i]); run.push(ring[i + 1]); continue; }
        flush();
        if (uniform(t)) {
          const c = place(t, arc.cx, arc.cy);
          sink.shapes.push({
            t: 'arc', cx: c[0], cy: c[1], r: arc.r * scaleOf(t),
            a0: arc.a0 + t.rot, a1: arc.a1 + t.rot, ...pen,
          });
        } else {
          sink.shapes.push({ t: 'poly', pts: ovalPoints(t, arc.cx, arc.cy, arc.r, arc.a0, arc.a1, 24), ...pen });
        }
        run = [ring[i + 1]];
      }
      flush();
      return;
    }

    case 'SOLID':
    case '3DFACE': {
      // SOLID keeps its last two corners the other way round.
      const q = [
        place(t, num(e, 10), num(e, 20)), place(t, num(e, 11), num(e, 21)),
        place(t, num(e, 13), num(e, 23)), place(t, num(e, 12), num(e, 22)),
      ];
      if (isConnection) return;
      sink.shapes.push({ t: 'poly', pts: q, close: true, ...pen, fill: '#111', width: 0 });
      return;
    }

    case 'TEXT':
    case 'MTEXT': {
      if (isConnection) return;
      const justify = num(e, 72);
      const useAlign = justify !== 0 || e.pairs.some(p => p.code === 11);
      const p = place(t, num(e, useAlign ? 11 : 10), num(e, useAlign ? 21 : 20));
      // DXF states the cap height; a font size is the em that produces it.
      const size = (num(e, 40, 2.5) / 0.72) * scaleOf(t);
      const raw = e.type === 'MTEXT'
        ? e.pairs.filter(x => x.code === 3 || x.code === 1).map(x => x.value).join('')
        : str(e, 1);
      // MTEXT carries its formatting inline; the words are what matter here.
      const body = raw.replace(/\\[A-Za-z][^;\\]*;?/g, '').replace(/[{}]/g, '').trim();
      if (!body) return;
      sink.shapes.push({
        t: 'text', x: p[0], y: p[1], s: body, size, ...TEXT_PEN,
        anchor: justify === 1 ? 'middle' : justify === 2 ? 'end' : 'start',
      });
      return;
    }

    case 'INSERT': {
      if (depth > 8) return;                       // a block that contains itself
      const body = blocks.get(str(e, 2).toUpperCase());
      if (!body) { sink.skipped.INSERT = (sink.skipped.INSERT ?? 0) + 1; return; }
      const base = str(body[0] ?? { type: '', pairs: [] } as Entity, -1).split(',').map(Number);
      const bx = Number.isFinite(base[0]) ? base[0] : 0;
      const by = Number.isFinite(base[1]) ? base[1] : 0;
      const at = place(t, num(e, 10), num(e, 20));
      const inner: Placement = {
        ox: at[0], oy: at[1],
        sx: t.sx * num(e, 41, 1), sy: t.sy * num(e, 42, 1),
        rot: t.rot + num(e, 50),
      };
      // The block's own base point is its origin, so shift it out of the way.
      const shifted: Placement = {
        ...inner,
        ox: inner.ox - bx * inner.sx * Math.cos((inner.rot * Math.PI) / 180),
        oy: inner.oy - by * inner.sy,
      };
      for (const child of body) convert(child, shifted, blocks, sink, depth + 1);
      return;
    }

    case 'ATTDEF': case 'ATTRIB': case 'VIEWPORT': case 'DIMENSION':
      sink.skipped[e.type] = (sink.skipped[e.type] ?? 0) + 1;
      return;

    default:
      if (e.type) sink.skipped[e.type] = (sink.skipped[e.type] ?? 0) + 1;
  }
}

// ── World to sheet ──────────────────────────────────────────────────────────

const bounds = (shapes: Shape[], connections: Pt[]) => {
  const xs: number[] = [], ys: number[] = [];
  const add = (x: number, y: number) => { xs.push(x); ys.push(y); };
  for (const s of shapes) {
    switch (s.t) {
      case 'line': add(s.x1, s.y1); add(s.x2, s.y2); break;
      case 'rect': add(s.x, s.y); add(s.x + s.w, s.y + s.h); break;
      case 'circle': add(s.cx - s.r, s.cy - s.r); add(s.cx + s.r, s.cy + s.r); break;
      case 'ellipse': add(s.cx - s.rx, s.cy - s.ry); add(s.cx + s.rx, s.cy + s.ry); break;
      case 'arc': add(s.cx - s.r, s.cy - s.r); add(s.cx + s.r, s.cy + s.r); break;
      case 'curve': add(s.x1, s.y1); add(s.x2, s.y2); add(s.cx, s.cy); break;
      case 'poly': s.pts.forEach(p => add(p[0], p[1])); break;
      case 'text': add(s.x, s.y); add(s.x + s.s.length * s.size * 0.55, s.y - s.size); break;
    }
  }
  connections.forEach(p => add(p[0], p[1]));
  return xs.length
    ? { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
    : { minX: 0, maxX: 1, minY: 0, maxY: 1 };
};

/** World (y up, anywhere) → sheet (y down, origin at the top left). */
function toSheet(s: Shape, minX: number, maxY: number): Shape {
  const X = (x: number) => x - minX;
  const Y = (y: number) => maxY - y;
  switch (s.t) {
    case 'line':    return { ...s, x1: X(s.x1), y1: Y(s.y1), x2: X(s.x2), y2: Y(s.y2) };
    case 'rect':    return { ...s, x: X(s.x), y: Y(s.y + s.h) };
    case 'circle':  return { ...s, cx: X(s.cx), cy: Y(s.cy) };
    case 'ellipse': return { ...s, cx: X(s.cx), cy: Y(s.cy) };
    // Flipping y turns the sweep around: what ran counter clockwise in the
    // world runs the other way on the sheet, so the ends swap and negate.
    case 'arc':     return { ...s, cx: X(s.cx), cy: Y(s.cy), a0: -s.a1, a1: -s.a0 };
    case 'curve':   return { ...s, x1: X(s.x1), y1: Y(s.y1), cx: X(s.cx), cy: Y(s.cy), x2: X(s.x2), y2: Y(s.y2) };
    case 'poly':    return { ...s, pts: s.pts.map(p => [X(p[0]), Y(p[1])] as Pt) };
    case 'text':    return { ...s, x: X(s.x), y: Y(s.y) };
  }
}

/**
 * A DXF file as a drawing.
 *
 * The result is in sheet space — y downwards, origin at the top left of the
 * geometry's own extent — which is what everything else here works in.
 */
export function readDxf(text: string, name = ''): DxfImport {
  const pairs = tokenize(text);
  const found = sections(pairs);
  const blocks = found.has('BLOCKS') ? readBlocks(pairs, found.get('BLOCKS')!) : new Map();
  const span = found.get('ENTITIES');

  const sink: Sink = { shapes: [], connections: [], skipped: {}, entities: 0 };
  if (span) {
    for (const e of readEntities(pairs, span[0], span[1])) convert(e, PLAIN, blocks, sink);
  }

  const { minX, maxX, minY, maxY } = bounds(sink.shapes, sink.connections);
  const drawing = new Drawing(
    Math.max(1, maxX - minX), Math.max(1, maxY - minY), name);
  for (const s of sink.shapes) drawing.add(toSheet(s, minX, maxY));

  const connections = sink.connections
    .map(p => [p[0] - minX, maxY - p[1]] as Pt)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);

  return { drawing, connections, skipped: sink.skipped, entities: sink.entities };
}
