// src/utils/cad/svg.ts
//
// A Drawing as SVG — the screen and print back-end. This is what the Eplanix
// previews render and what the print window turns into a PDF, so it keeps the
// colours and weights the sheets were designed with; the layers are carried
// through as `data-layer` so the markup can still be read back per layer.
import { Drawing, Shape, flattenCurve } from './shapes';

const esc = (s: string) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Trim floating-point noise: 12.100000000000001 → 12.1 */
const n = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

const DEG = Math.PI / 180;
const onArc = (cx: number, cy: number, r: number, deg: number): [number, number] =>
  [cx + r * Math.cos(deg * DEG), cy + r * Math.sin(deg * DEG)];

/** stroke / fill / dash, as SVG attributes. */
function paint(s: Shape, defaultStroke: string): string {
  const stroke = s.color ?? defaultStroke;
  const bits = [`stroke="${stroke}"`, `stroke-width="${n(s.width ?? 1)}"`,
    `fill="${s.fill ?? 'none'}"`];
  if (s.dash) bits.push(`stroke-dasharray="${s.dash}"`);
  return bits.join(' ');
}

function shapeToSvg(s: Shape): string {
  const layer = ` data-layer="${s.layer}"`;
  switch (s.t) {
    case 'line':
      return `<line x1="${n(s.x1)}" y1="${n(s.y1)}" x2="${n(s.x2)}" y2="${n(s.y2)}" ` +
        `${paint(s, '#111')}${layer}/>`;

    case 'rect':
      return `<rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}" ` +
        `${paint(s, '#111')}${layer}/>`;

    case 'circle':
      return `<circle cx="${n(s.cx)}" cy="${n(s.cy)}" r="${n(s.r)}" ` +
        `${paint(s, '#111')}${layer}/>`;

    case 'arc': {
      const [x1, y1] = onArc(s.cx, s.cy, s.r, s.a0);
      const [x2, y2] = onArc(s.cx, s.cy, s.r, s.a1);
      // Angles run the positive way, which in a y-down space is SVG's sweep 1.
      const large = Math.abs(s.a1 - s.a0) > 180 ? 1 : 0;
      return `<path d="M ${n(x1)} ${n(y1)} A ${n(s.r)} ${n(s.r)} 0 ${large} 1 ${n(x2)} ${n(y2)}" ` +
        `${paint(s, '#111')}${layer}/>`;
    }

    case 'curve':
      return `<path d="M ${n(s.x1)} ${n(s.y1)} Q ${n(s.cx)} ${n(s.cy)} ${n(s.x2)} ${n(s.y2)}" ` +
        `${paint(s, '#111')}${layer}/>`;

    case 'poly': {
      if (s.pts.length === 0) return '';
      const [head, ...rest] = s.pts;
      const d = `M ${n(head[0])} ${n(head[1])}` +
        rest.map(p => ` L ${n(p[0])} ${n(p[1])}`).join('') + (s.close ? ' Z' : '');
      return `<path d="${d}" ${paint(s, '#111')}${layer}/>`;
    }

    case 'text': {
      const attrs = [
        `x="${n(s.x)}"`, `y="${n(s.y)}"`, `font-size="${n(s.size)}"`,
        s.bold ? 'font-weight="700"' : '',
        s.anchor && s.anchor !== 'start' ? `text-anchor="${s.anchor}"` : '',
        `fill="${s.color ?? '#111'}"`,
      ].filter(Boolean).join(' ');
      const title = s.title ? `<title>${esc(s.title)}</title>` : '';
      return `<text ${attrs}${layer}>${title}${esc(s.s)}</text>`;
    }
  }
}

export interface SvgOptions {
  /** Paper colour behind the geometry. Pass '' for a transparent sheet. */
  background?: string;
  fontFamily?: string;
}

/** The drawing as a standalone `<svg>` element. */
export function renderSvg(d: Drawing, options: SvgOptions = {}): string {
  const { background = '#fff', fontFamily = 'Segoe UI, Arial, sans-serif' } = options;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(d.width)} ${n(d.height)}" ` +
    `width="${n(d.width)}" height="${n(d.height)}" font-family="${fontFamily}">`);
  if (d.name) out.push(`<title>${esc(d.name)}</title>`);
  if (background) out.push(`<rect width="${n(d.width)}" height="${n(d.height)}" fill="${background}"/>`);
  for (const s of d.shapes) out.push(shapeToSvg(s));
  out.push('</svg>');
  return out.join('\n');
}

/** Curves flattened to points — shared with the CAD back-ends, kept here so
 *  a caller that only imports the SVG side still gets the same geometry. */
export { flattenCurve };
