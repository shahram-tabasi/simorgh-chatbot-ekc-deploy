// src/utils/cad/ema.ts
//
// A Drawing as an EPLAN window macro (.ema) — inserted in EPLAN with
// Insert → Window macro, the way the office's own cell macros are.
//
// An .ema is XML, but EPLAN's own object model written out: every object a
// type number and an id ("31/1001"), every property a numbered attribute.
// Nothing here is guessed at: the frame is one of the office's macros
// (`EMA_SKELETON`), and each object is written the way the office's macros
// write it —
//
//   O31  a line             A531 start, A532 end
//   O34  a polyline         A621 "x/y;x/y;…"
//   O89  a rectangle        A1651 and A1652 its corners
//   O30  a text             A501 where, A511 what; S54x505 its height (A961),
//                           angle in radians (A962) and alignment (A966,
//                           1–9 from the top left, row by row)
//
// A dashed line carries the pen of the office's interlock lines (line type 1,
// 0.13 mm, pattern -3); everything else takes its layer's pen ("L"). Circles,
// ellipses, arcs and curves go as polylines.
//
// Millimetres, y upwards, as EPLAN measures a page; the macro's insertion
// point is the drawing's top left corner.
import { Drawing, Pt, Shape } from './shapes';
import { EMA_SKELETON } from './emaSkeleton';

export interface EmaOptions {
  /** The macro's name, as EPLAN lists it. */
  name?: string;
  /** Millimetres per drawing unit. 0.25 draws a cell the size the office's
   *  cell macros are. */
  mmPerUnit?: number;
}

/** Where the drawing's top left corner lands, in mm. */
const ORIGIN = { x: 10, y: 10 };

export const num = (v: number) => {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 1e4) / 1e4;
  return String(Object.is(r, -0) ? 0 : r);
};

export const xml = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/\r?\n/g, '&#10;');

/** A text in EPLAN's own multi-language form, for every language. A `;`
 *  would end it early, so it is written as a comma. */
export const multi = (s: string) => `??_??@${xml(s.replace(/;/g, ','))};`;

/** The common head of every graphic object the office's macros write. */
export const HEAD = 'A3="0" A13="0" A14="0" A404="1" A405="64" A406="0" A407="0"';
/** Its pen: the layer's, or the office's dashed interlock line. */
const pen = (s: Shape) => (s.dash
  ? 'A411="100" A412="1" A413="L" A414="0.13" A415="-3" A416="0"'
  : 'A411="100" A412="L" A413="L" A414="L" A415="L" A416="0"');

/** Sheet text alignment → EPLAN's, on the baseline. */
const ALIGN = { start: 7, middle: 8, end: 9 } as const;

function ring(cx: number, cy: number, rx: number, ry: number, a0 = 0, a1 = 360): Pt[] {
  let end = a1;
  while (end <= a0) end += 360;
  const steps = Math.max(8, Math.ceil(((end - a0) / 360) * 72));
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((a0 + ((end - a0) * i) / steps) * Math.PI) / 180;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

function quad(x1: number, y1: number, cx: number, cy: number, x2: number, y2: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const u = 1 - t;
    pts.push([u * u * x1 + 2 * u * t * cx + t * t * x2, u * u * y1 + 2 * u * t * cy + t * t * y2]);
  }
  return pts;
}

export function renderEma(d: Drawing, opts: EmaOptions = {}): string {
  const s = opts.mmPerUnit ?? 0.25;
  const top = ORIGIN.y + d.height * s;
  const X = (v: number) => ORIGIN.x + v * s;
  const Y = (v: number) => top - v * s;
  const P = (x: number, y: number) => `${num(X(x))}/${num(Y(y))}`;

  let id = 100000;
  const next = (type: number) => `${type}/${id++}`;
  const out: string[] = [];
  const obj = (type: number, rest: string) => `  <O${type} Build="15117" A1="${next(type)}" ${HEAD} ${rest}`;

  const poly = (sh: Shape, pts: Pt[], close: boolean) => {
    if (pts.length < 2) return;
    const all = close ? [...pts, pts[0]] : pts;
    out.push(obj(34, `${pen(sh)} A621="${all.map(p => P(p[0], p[1])).join(';')}" A623="0" A624="0"/>`));
  };

  for (const sh of d.shapes) {
    // Connection point marks are the editor's, not the drawing's.
    if (sh.layer === 'PIN') continue;
    switch (sh.t) {
      case 'line':
        out.push(obj(31, `${pen(sh)} A531="${P(sh.x1, sh.y1)}" A532="${P(sh.x2, sh.y2)}"/>`));
        break;
      case 'rect': {
        // A white patch under a text is paper, not a box.
        const white = /^(#fff(fff)?|white)$/i.test(String(sh.fill ?? '')) && !sh.color;
        if (white) break;
        out.push(obj(89, `${pen(sh)} A1651="${P(sh.x, sh.y + sh.h)}" A1652="${P(sh.x + sh.w, sh.y)}" ` +
          'A1653="0" A1654="0" A1655="0" A1656="0" A1657="0"/>'));
        break;
      }
      case 'circle':
        poly(sh, ring(sh.cx, sh.cy, sh.r, sh.r), false);
        break;
      case 'ellipse':
        poly(sh, ring(sh.cx, sh.cy, sh.rx, sh.ry), false);
        break;
      case 'arc':
        poly(sh, ring(sh.cx, sh.cy, sh.r, sh.r, sh.a0, sh.a1), false);
        break;
      case 'curve':
        poly(sh, quad(sh.x1, sh.y1, sh.cx, sh.cy, sh.x2, sh.y2), false);
        break;
      case 'poly':
        poly(sh, sh.pts, sh.close ?? Boolean(sh.fill && sh.fill !== 'none'));
        break;
      case 'text': {
        const value = String(sh.s ?? '').trim();
        if (!value) break;
        const rad = ((sh.rot ?? 0) * Math.PI) / 180;
        out.push(obj(30, 'A411="108" A412="L" A413="L" A414="L" A415="L" A416="0" ' +
          `A501="${P(sh.x, sh.y)}" A503="0" A506="0" A511="${multi(value)}">`));
        out.push(`  <S54x505 A961="${num(Math.max(1, sh.size * s * 0.8))}" A962="${num(rad)}" A963="0" ` +
          `A964="L" A965="0" A966="${ALIGN[sh.anchor ?? 'start']}" A967="0" A968="0" A969="0" ` +
          'A4000="L" A4001="L" A4013="0"/>');
        out.push('  </O30>');
        break;
      }
      case 'image':
        // A window macro has nowhere to keep a picture.
        break;
    }
  }

  const name = (opts.name || d.name || 'SIMORGH').trim();
  return emaDocument(name, out, { left: ORIGIN.x, top, right: ORIGIN.x + d.width * s, bottom: ORIGIN.y },
    { x: ORIGIN.x, y: top });
}

/** A window macro around a page's objects: its name, the box it covers and
 *  its insertion point, all in mm. */
export function emaDocument(
  name: string, objects: string[],
  area: { left: number; top: number; right: number; bottom: number },
  ref: { x: number; y: number },
): string {
  return EMA_SKELETON
    .split('{{NAME}}').join(xml(name))
    .split('{{REF}}').join(`${num(ref.x)}/${num(ref.y)}/0`)
    .split('{{AREA}}').join(`${num(area.left)}/${num(area.top)}/${num(area.right)}/${num(area.bottom)}`)
    .split('{{OBJECTS}}').join(objects.length ? `${objects.join('\r\n')}\r\n` : '');
}
