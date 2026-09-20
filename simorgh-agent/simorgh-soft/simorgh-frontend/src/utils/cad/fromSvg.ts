// src/utils/cad/fromSvg.ts
//
// A finished sheet, read back as geometry.
//
// The single line is drawn as SVG — by the symbol library, by the branch
// layout, by the sheet code — and that drawing is being worked on. Rather than
// fork it into a second geometry pass that would go stale, the CAD export
// reads the SVG the sheet already produced and turns it back into a `Drawing`.
// Every symbol the library gains reaches DXF the day it is drawn, with nothing
// to keep in step.
//
// The subset parsed is the one the sheets emit: line, rect, circle, ellipse,
// path (M L H V C Q A Z, absolute and relative), text, image, and groups with
// translate/scale transforms.
import { Drawing, Layer, Pen, Pt } from './shapes';

const num = (v: string | null, fallback = 0) => {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : fallback;
};

// ── Transforms ──────────────────────────────────────────────────────────────
// Only what the sheets use: translate and scale, so a 2×3 matrix is enough.

interface Matrix { a: number; d: number; e: number; f: number }
const UNIT: Matrix = { a: 1, d: 1, e: 0, f: 0 };

const apply = (m: Matrix, x: number, y: number): Pt => [m.a * x + m.e, m.d * y + m.f];
const compose = (m: Matrix, n: Matrix): Matrix => ({
  a: m.a * n.a, d: m.d * n.d, e: m.a * n.e + m.e, f: m.d * n.f + m.f,
});

function parseTransform(value: string | null): Matrix {
  if (!value) return UNIT;
  let m = UNIT;
  const re = /(translate|scale|matrix)\s*\(([^)]*)\)/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(value))) {
    const args = hit[2].split(/[\s,]+/).filter(Boolean).map(Number);
    if (hit[1] === 'translate') m = compose(m, { a: 1, d: 1, e: args[0] || 0, f: args[1] || 0 });
    else if (hit[1] === 'scale') m = compose(m, { a: args[0] ?? 1, d: args[1] ?? args[0] ?? 1, e: 0, f: 0 });
    else if (hit[1] === 'matrix') m = compose(m, { a: args[0] ?? 1, d: args[3] ?? 1, e: args[4] ?? 0, f: args[5] ?? 0 });
  }
  return m;
}

/** Uniform scale, for radii and text heights. */
const scaleOf = (m: Matrix) => Math.sqrt(Math.abs(m.a * m.d)) || 1;

// ── Layers ──────────────────────────────────────────────────────────────────

/**
 * Which CAD layer a piece of a sheet belongs on.
 *
 * `data-layer` wins when the drawing code says so; otherwise it is read off
 * how the shape is drawn, which is enough for the thing a drawing office
 * actually does with layers — switch a class of geometry off.
 */
function layerFor(el: Element, kind: 'geometry' | 'text', width: number, dashed: boolean): Layer {
  const declared = el.getAttribute('data-layer');
  if (declared) return declared as Layer;
  if (kind === 'text') {
    const weight = el.getAttribute('font-weight');
    return weight === '700' || weight === '600' || weight === 'bold' ? 'TAG' : 'TEXT';
  }
  if (dashed) return 'FREE';
  if (width >= 4) return 'BUS';        // only the busbar is drawn that heavy
  if (width >= 2.2) return 'WIRE';
  return 'SYMBOL';
}

// ── Blocks ──────────────────────────────────────────────────────────────────

/**
 * What a `<g>` can say about the geometry inside it.
 *
 * A sheet drawn by this app is written as SVG and read back here, and until
 * now everything about *what* a piece of geometry was got lost in that round
 * trip. A breaker went out as eleven lines and an arc and came back as eleven
 * lines and an arc — near each other, on the right layer, and no longer a
 * breaker. So nothing on a generated sheet could be picked as one object, and
 * nothing could be found again when the office redrew that symbol: the command
 * to put the new drawing in its place searched every sheet in the project and
 * reported, truthfully, that the symbol was drawn nowhere.
 *
 * Three attributes fix that, and they cost nothing to write:
 *
 *   `data-block`   this geometry is one object, and this is which one
 *   `data-symbol`  the library symbol it was drawn from — `vcb`, `contactor`
 *   `data-name`    what to call it, for the layer list and the DXF block table
 *
 * They nest: a `<g>` inside a block belongs to the block. The outermost one
 * wins, because that is the object a draughtsman means when they click on it.
 */
interface BlockRef {
  block: string;
  blockName: string;
  symbol?: string;
}

function blockOf(el: Element, parent?: BlockRef): BlockRef | undefined {
  // Already inside one: the outer block is the object, and a group drawn
  // inside it is part of that object rather than a smaller one.
  if (parent) return parent;
  const block = el.getAttribute('data-block');
  if (!block) return undefined;
  return {
    block,
    blockName: el.getAttribute('data-name') ?? '',
    symbol: el.getAttribute('data-symbol') ?? undefined,
  };
}

/** A pen, with whatever block the geometry sits inside. */
const inBlock = <T extends Pen>(pen: T, group?: BlockRef): T => (group
  ? { ...pen, block: group.block, blockName: group.blockName,
      ...(group.symbol ? { symbol: group.symbol } : {}) }
  : pen);

function penOf(el: Element, m: Matrix): Pen & { widthRaw: number } {
  const stroke = el.getAttribute('stroke');
  const fill = el.getAttribute('fill');
  const dash = el.getAttribute('stroke-dasharray');
  const width = num(el.getAttribute('stroke-width'), stroke ? 1 : 0);
  return {
    layer: layerFor(el, 'geometry', width, Boolean(dash)),
    color: stroke ?? undefined,
    width: width * scaleOf(m),
    fill: fill ?? undefined,
    dash: dash ?? undefined,
    widthRaw: width,
  };
}

// ── Path data ───────────────────────────────────────────────────────────────

/** `d` split into commands and their numbers. */
function tokenize(d: string): { op: string; args: number[] }[] {
  const out: { op: string; args: number[] }[] = [];
  const re = /([MmLlHhVvCcQqAaZz])([^MmLlHhVvCcQqAaZz]*)/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(d))) {
    const args = (hit[2].match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    out.push({ op: hit[1], args });
  }
  return out;
}

/**
 * SVG states an arc by where it ends; CAD states it by where its centre is.
 * This is the conversion the SVG specification sets out in its implementation
 * notes, reduced to the circular case the symbols draw.
 */
function arcToCentre(
  x1: number, y1: number, rx: number, ry: number, rotation: number,
  largeArc: boolean, sweep: boolean, x2: number, y2: number,
): { cx: number; cy: number; r: number; a0: number; a1: number } | null {
  if (rx === 0 || ry === 0) return null;
  const phi = (rotation * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx2 = (x1 - x2) / 2, dy2 = (y1 - y2) / 2;
  const x1p = cos * dx2 + sin * dy2;
  const y1p = -sin * dx2 + cos * dy2;

  let rxa = Math.abs(rx), rya = Math.abs(ry);
  // An arc too small to reach its endpoint is scaled up until it just does.
  const lambda = (x1p * x1p) / (rxa * rxa) + (y1p * y1p) / (rya * rya);
  if (lambda > 1) { const s = Math.sqrt(lambda); rxa *= s; rya *= s; }

  const sign = largeArc === sweep ? -1 : 1;
  const numerator = rxa * rxa * rya * rya - rxa * rxa * y1p * y1p - rya * rya * x1p * x1p;
  const denominator = rxa * rxa * y1p * y1p + rya * rya * x1p * x1p;
  const coef = sign * Math.sqrt(Math.max(0, numerator / denominator));
  const cxp = (coef * rxa * y1p) / rya;
  const cyp = (-coef * rya * x1p) / rxa;

  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;

  const angle = (ux: number, uy: number) => (Math.atan2(uy, ux) * 180) / Math.PI;
  const a0 = angle((x1p - cxp) / rxa, (y1p - cyp) / rya);
  let delta = angle((-x1p - cxp) / rxa, (-y1p - cyp) / rya) - a0;
  if (!sweep && delta > 0) delta -= 360;
  if (sweep && delta < 0) delta += 360;

  return { cx, cy, r: (rxa + rya) / 2, a0: delta >= 0 ? a0 : a0 + delta, a1: delta >= 0 ? a0 + delta : a0 };
}

const cubic = (p0: Pt, p1: Pt, p2: Pt, p3: Pt, n = 14): Pt[] => {
  const pts: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return pts;
};

/** One `<path>` as shapes: straight runs become polylines, arcs stay arcs. */
function readPath(d: Drawing, el: Element, m: Matrix, group?: BlockRef) {
  const pen = inBlock(penOf(el, m), group);
  const data = el.getAttribute('d') ?? '';
  let cx = 0, cy = 0, startX = 0, startY = 0;
  let run: Pt[] = [];

  const flushRun = (close = false) => {
    if (run.length > 1) {
      d.poly(run.map(p => apply(m, p[0], p[1])), { ...pen, close });
    } else if (run.length === 1 && close) {
      // A single point that closes is nothing to draw.
    }
    run = [];
  };

  for (const { op, args } of tokenize(data)) {
    const rel = op === op.toLowerCase();
    switch (op.toUpperCase()) {
      case 'M':
        flushRun();
        for (let i = 0; i + 1 < args.length; i += 2) {
          cx = rel ? cx + args[i] : args[i];
          cy = rel ? cy + args[i + 1] : args[i + 1];
          if (i === 0) { startX = cx; startY = cy; run = [[cx, cy]]; } else run.push([cx, cy]);
        }
        break;
      case 'L':
        for (let i = 0; i + 1 < args.length; i += 2) {
          cx = rel ? cx + args[i] : args[i];
          cy = rel ? cy + args[i + 1] : args[i + 1];
          run.push([cx, cy]);
        }
        break;
      case 'H':
        for (const a of args) { cx = rel ? cx + a : a; run.push([cx, cy]); }
        break;
      case 'V':
        for (const a of args) { cy = rel ? cy + a : a; run.push([cx, cy]); }
        break;
      case 'C':
        for (let i = 0; i + 5 < args.length; i += 6) {
          const p0: Pt = [cx, cy];
          const p1: Pt = [rel ? cx + args[i] : args[i], rel ? cy + args[i + 1] : args[i + 1]];
          const p2: Pt = [rel ? cx + args[i + 2] : args[i + 2], rel ? cy + args[i + 3] : args[i + 3]];
          const p3: Pt = [rel ? cx + args[i + 4] : args[i + 4], rel ? cy + args[i + 5] : args[i + 5]];
          run.push(...cubic(p0, p1, p2, p3));
          [cx, cy] = p3;
        }
        break;
      case 'Q':
        for (let i = 0; i + 3 < args.length; i += 4) {
          const qx = rel ? cx + args[i] : args[i];
          const qy = rel ? cy + args[i + 1] : args[i + 1];
          const ex = rel ? cx + args[i + 2] : args[i + 2];
          const ey = rel ? cy + args[i + 3] : args[i + 3];
          flushRun();
          const [ax, ay] = apply(m, cx, cy);
          const [bx, by] = apply(m, qx, qy);
          const [ex2, ey2] = apply(m, ex, ey);
          d.curve(ax, ay, bx, by, ex2, ey2, pen);
          cx = ex; cy = ey;
          run = [[cx, cy]];
        }
        break;
      case 'A':
        for (let i = 0; i + 6 < args.length; i += 7) {
          const [rx, ry, rot, large, sweep] = args.slice(i, i + 5);
          const ex = rel ? cx + args[i + 5] : args[i + 5];
          const ey = rel ? cy + args[i + 6] : args[i + 6];
          const arc = arcToCentre(cx, cy, rx, ry, rot, large !== 0, sweep !== 0, ex, ey);
          if (arc && Math.abs(rx) === Math.abs(ry)) {
            flushRun();
            const [acx, acy] = apply(m, arc.cx, arc.cy);
            d.arc(acx, acy, arc.r * scaleOf(m), arc.a0, arc.a1, pen);
            run = [[ex, ey]];
          } else {
            // An elliptical arc has no R12 entity; walk it instead.
            const steps = 18;
            for (let k = 1; k <= steps; k++) {
              const t = k / steps;
              run.push([cx + (ex - cx) * t, cy + (ey - cy) * t]);
            }
          }
          cx = ex; cy = ey;
        }
        break;
      case 'Z':
        run.push([startX, startY]);
        flushRun(true);
        cx = startX; cy = startY;
        break;
    }
  }
  flushRun();
}

// ── Elements ────────────────────────────────────────────────────────────────

function readElement(d: Drawing, el: Element, m: Matrix, parent?: BlockRef) {
  const here = compose(m, parseTransform(el.getAttribute('transform')));
  const tag = el.tagName.toLowerCase();
  const group = blockOf(el, parent);

  switch (tag) {
    case 'g':
    case 'svg':
      for (const child of Array.from(el.children)) readElement(d, child, here, group);
      return;

    case 'line': {
      const pen = inBlock(penOf(el, here), group);
      const [x1, y1] = apply(here, num(el.getAttribute('x1')), num(el.getAttribute('y1')));
      const [x2, y2] = apply(here, num(el.getAttribute('x2')), num(el.getAttribute('y2')));
      d.line(x1, y1, x2, y2, pen);
      return;
    }

    case 'rect': {
      const pen = inBlock(penOf(el, here), group);
      const x = num(el.getAttribute('x')), y = num(el.getAttribute('y'));
      const w = num(el.getAttribute('width')), h = num(el.getAttribute('height'));
      const [px1, py1] = apply(here, x, y);
      const [px2, py2] = apply(here, x + w, y + h);
      // The sheet background is a full-bleed white rect; it is paper, not geometry.
      if (!el.getAttribute('stroke') && (el.getAttribute('fill') ?? '').match(/^#f{3,6}$/i)) return;
      d.rect(Math.min(px1, px2), Math.min(py1, py2),
        Math.abs(px2 - px1), Math.abs(py2 - py1), pen);
      return;
    }

    case 'circle': {
      const pen = inBlock(penOf(el, here), group);
      const [cx, cy] = apply(here, num(el.getAttribute('cx')), num(el.getAttribute('cy')));
      d.circle(cx, cy, num(el.getAttribute('r')) * scaleOf(here), pen);
      return;
    }

    case 'ellipse': {
      const pen = inBlock(penOf(el, here), group);
      const [cx, cy] = apply(here, num(el.getAttribute('cx')), num(el.getAttribute('cy')));
      d.ellipse(cx, cy, num(el.getAttribute('rx')) * Math.abs(here.a),
        num(el.getAttribute('ry')) * Math.abs(here.d), pen);
      return;
    }

    case 'path':
      readPath(d, el, here, group);
      return;

    case 'text': {
      const size = num(el.getAttribute('font-size'), 10) * scaleOf(here);
      const [x, y] = apply(here, num(el.getAttribute('x')), num(el.getAttribute('y')));
      const anchor = el.getAttribute('text-anchor');
      const weight = el.getAttribute('font-weight');
      // A <title> child is the tooltip, not part of the line.
      const title = el.querySelector('title')?.textContent ?? undefined;
      const shown = Array.from(el.childNodes)
        .filter(node => node.nodeType === 3)
        .map(node => node.textContent ?? '').join('').trim();
      d.text(x, y, shown, size, inBlock({
        layer: layerFor(el, 'text', 0, false),
        color: el.getAttribute('fill') ?? undefined,
        anchor: anchor === 'middle' ? 'middle' : anchor === 'end' ? 'end' : 'start',
        bold: weight === '700' || weight === '600' || weight === 'bold',
        title,
      }, group));
      return;
    }

    case 'image': {
      // A symbol supplied as a picture has no CAD equivalent. Mark its cell
      // rather than dropping it, so the drawing says something is there.
      const x = num(el.getAttribute('x')), y = num(el.getAttribute('y'));
      const w = num(el.getAttribute('width')), h = num(el.getAttribute('height'));
      const [px1, py1] = apply(here, x, y);
      const [px2, py2] = apply(here, x + w, y + h);
      d.rect(Math.min(px1, px2), Math.min(py1, py2), Math.abs(px2 - px1), Math.abs(py2 - py1),
        inBlock({ layer: 'FREE', color: '#111', width: 0.8, dash: '3 2' }, group));
      return;
    }

    default:
      for (const child of Array.from(el.children)) readElement(d, child, here, group);
  }
}

/** Where the sheet says it is, in its own units. */
function sizeOf(svg: Element): { width: number; height: number } {
  const box = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  if (box.length === 4 && box.every(Number.isFinite)) return { width: box[2], height: box[3] };
  return { width: num(svg.getAttribute('width'), 1000), height: num(svg.getAttribute('height'), 700) };
}

/**
 * How big a sheet says it is, read straight off the markup.
 *
 * Cheap enough to call while a menu is open, where parsing the whole sheet to
 * learn two numbers would not be.
 */
export function svgSize(svg: string): { width: number; height: number } {
  const box = /viewBox="([^"]+)"/.exec(svg);
  const parts = box ? box[1].trim().split(/[\s,]+/).map(Number) : [];
  if (parts.length === 4 && parts.every(Number.isFinite)) {
    return { width: parts[2], height: parts[3] };
  }
  return { width: 1000, height: 700 };
}

/**
 * An SVG sheet read back as a `Drawing`, ready for `renderDxf`.
 *
 * Runs in the browser — it uses `DOMParser`, so the sheet is parsed by the
 * same engine that displays it, not by a regular expression.
 */
export function drawingFromSvg(svg: string, name = ''): Drawing {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() === 'parsererror') {
    throw new Error('The sheet could not be read back as SVG.');
  }
  const { width, height } = sizeOf(root);
  const drawing = new Drawing(width, height, name);
  for (const child of Array.from(root.children)) readElement(drawing, child, UNIT);
  return drawing;
}
