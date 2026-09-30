// src/utils/cad/svg.ts
//
// A Drawing as SVG — the screen and print back-end.
//
// Shapes become SVG nodes once, in `shapeToNode`, and two things consume that:
// `renderSvg`, which serialises a whole sheet to markup, and the editor, which
// renders the same nodes as React elements so each one can be clicked. Neither
// carries its own copy of the geometry.
import { Drawing, Shape, flattenCurve } from './shapes';

const esc = (s: string) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Trim floating-point noise: 12.100000000000001 → 12.1 */
const n = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};

const DEG = Math.PI / 180;
export const onArc = (cx: number, cy: number, r: number, deg: number): [number, number] =>
  [cx + r * Math.cos(deg * DEG), cy + r * Math.sin(deg * DEG)];

/** One shape as the SVG element that draws it. */
export interface SvgNode {
  tag: 'line' | 'rect' | 'circle' | 'ellipse' | 'path' | 'text';
  attrs: Record<string, string | number>;
  /** Text content, for `text` nodes. */
  body?: string;
  /** The `<title>` tooltip, for `text` nodes that carry one. */
  title?: string;
}

/** stroke / fill / dash, shared by every geometric node. */
function paint(s: Shape, defaultStroke: string): Record<string, string | number> {
  const attrs: Record<string, string | number> = {
    stroke: s.color ?? defaultStroke,
    'stroke-width': n(s.width ?? 1),
    fill: s.fill ?? 'none',
  };
  if (s.dash) attrs['stroke-dasharray'] = s.dash;
  return attrs;
}

export function shapeToNode(s: Shape): SvgNode | null {
  switch (s.t) {
    case 'line':
      return { tag: 'line', attrs: { x1: n(s.x1), y1: n(s.y1), x2: n(s.x2), y2: n(s.y2), ...paint(s, '#111') } };

    case 'rect':
      return { tag: 'rect', attrs: { x: n(s.x), y: n(s.y), width: n(s.w), height: n(s.h), ...paint(s, '#111') } };

    case 'circle':
      return { tag: 'circle', attrs: { cx: n(s.cx), cy: n(s.cy), r: n(s.r), ...paint(s, '#111') } };

    case 'ellipse':
      return { tag: 'ellipse', attrs: { cx: n(s.cx), cy: n(s.cy), rx: n(s.rx), ry: n(s.ry), ...paint(s, '#111') } };

    case 'arc': {
      const [x1, y1] = onArc(s.cx, s.cy, s.r, s.a0);
      const [x2, y2] = onArc(s.cx, s.cy, s.r, s.a1);
      // Angles run the positive way, which in a y-down space is SVG's sweep 1.
      const large = Math.abs(s.a1 - s.a0) > 180 ? 1 : 0;
      return {
        tag: 'path',
        attrs: { d: `M ${n(x1)} ${n(y1)} A ${n(s.r)} ${n(s.r)} 0 ${large} 1 ${n(x2)} ${n(y2)}`, ...paint(s, '#111') },
      };
    }

    case 'curve':
      return {
        tag: 'path',
        attrs: { d: `M ${n(s.x1)} ${n(s.y1)} Q ${n(s.cx)} ${n(s.cy)} ${n(s.x2)} ${n(s.y2)}`, ...paint(s, '#111') },
      };

    case 'poly': {
      if (s.pts.length === 0) return null;
      const [head, ...rest] = s.pts;
      const d = `M ${n(head[0])} ${n(head[1])}` +
        rest.map(p => ` L ${n(p[0])} ${n(p[1])}`).join('') + (s.close ? ' Z' : '');
      return { tag: 'path', attrs: { d, ...paint(s, '#111') } };
    }

    case 'text': {
      const attrs: Record<string, string | number> = {
        x: n(s.x), y: n(s.y), 'font-size': n(s.size), fill: s.color ?? '#111',
      };
      if (s.bold) attrs['font-weight'] = 700;
      if (s.anchor && s.anchor !== 'start') attrs['text-anchor'] = s.anchor;
      // `rot` is anticlockwise on the page, SVG's rotate() is clockwise, so it
      // is negated. About the anchor, which is where the text is placed from.
      if (s.rot) attrs.transform = `rotate(${n(-s.rot)} ${n(s.x)} ${n(s.y)})`;
      return { tag: 'text', attrs, body: s.s, title: s.title };
    }
  }
}

function serialise(node: SvgNode, layer: string): string {
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => `${k}="${v}"`).join(' ');
  if (node.tag === 'text') {
    const title = node.title ? `<title>${esc(node.title)}</title>` : '';
    return `<text ${attrs} data-layer="${layer}">${title}${esc(node.body ?? '')}</text>`;
  }
  return `<${node.tag} ${attrs} data-layer="${layer}"/>`;
}

export interface SvgOptions {
  /** Paper colour behind the geometry. Pass '' for a transparent sheet. */
  background?: string;
  fontFamily?: string;
  /** Layers to leave out — what the editor's layer switches turn off. */
  hidden?: ReadonlySet<string>;
}

/** The drawing as a standalone `<svg>` element. */
export function renderSvg(d: Drawing, options: SvgOptions = {}): string {
  const { background = '#fff', fontFamily = 'Segoe UI, Arial, sans-serif', hidden } = options;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(d.width)} ${n(d.height)}" ` +
    `width="${n(d.width)}" height="${n(d.height)}" font-family="${fontFamily}">`);
  if (d.name) out.push(`<title>${esc(d.name)}</title>`);
  if (background) out.push(`<rect width="${n(d.width)}" height="${n(d.height)}" fill="${background}"/>`);
  for (const s of d.shapes) {
    if (hidden?.has(s.layer)) continue;
    const node = shapeToNode(s);
    if (node) out.push(serialise(node, s.layer));
  }
  out.push('</svg>');
  return out.join('\n');
}

/**
 * The shapes alone, with no `<svg>` around them.
 *
 * A symbol read out of a DXF has to be dropped inside a sheet that is already
 * being drawn, so what it needs is the markup for its geometry and nothing
 * else — no viewBox of its own to fight with the one it lands in.
 */
export function renderFragment(d: Drawing, hidden?: ReadonlySet<string>): string {
  const out: string[] = [];
  for (const s of d.shapes) {
    if (hidden?.has(s.layer)) continue;
    const node = shapeToNode(s);
    if (node) out.push(serialise(node, s.layer));
  }
  return out.join('');
}

export { flattenCurve };
