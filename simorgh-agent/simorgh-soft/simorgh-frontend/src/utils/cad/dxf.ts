// src/utils/cad/dxf.ts
//
// A Drawing as DXF — the CAD back-end.
//
// DXF is Autodesk's published interchange format: every CAD package reads it,
// and it is the answer for a customer who has no EPLAN. The sheets go out as
// real geometry on real layers, so the drawing office opens them in AutoCAD,
// BricsCAD, ZWCAD, LibreCAD, QCAD or EPLAN's DXF import and carries on
// working — not a picture of a drawing, the drawing.
//
// The dialect is R12 (AC1009), the most widely readable one: no handles, no
// object dictionary, entities that every reader since 1990 understands. Curves
// are flattened to line segments and filled triangles become SOLIDs; arcs,
// circles, lines and text stay what they are.
//
// Units are millimetres. The sheet is drawn in pixels, y downwards; here it is
// scaled, flipped, and centred on the smallest ISO sheet it fits.
import { Drawing, LAYERS, Layer, Pt, Shape, flattenCurve, translateShape } from './shapes';
import { MARGIN, Paper, PaperChoice, fitToNamedPaper, titleBlockBox } from './paper';

// DXF text height is the cap height; SVG font-size is the em.
const CAP_HEIGHT = 0.72;    // DXF text height is cap height; SVG font-size is the em

export interface DxfOptions {
  /** Millimetres per drawing unit. 0.5 puts a 1600-unit sheet on an A1. */
  mmPerUnit?: number;
  /** Name a sheet and the scale is whatever fits it; 'auto' keeps mmPerUnit. */
  paper?: PaperChoice;
  /** Draw the sheet border and title block. */
  frame?: boolean;
  /** Lines under the title block: project, switchgear, sheet number… */
  titleBlock?: string[];
  /**
   * Non-ASCII text. 'escape' writes `\U+00E7`, which AutoCAD and BricsCAD
   * render correctly in an R12 file; 'raw' writes UTF-8, which the open-source
   * readers prefer but AutoCAD may mangle.
   */
  unicode?: 'escape' | 'raw';
}

/** DXF is group-code/value pairs, one per line. */
class Tape {
  private out: string[] = [];
  pair(code: number, value: string | number): this {
    this.out.push(String(code), typeof value === 'number' ? fmt(value) : value);
    return this;
  }
  toString(): string { return this.out.join('\r\n') + '\r\n'; }
}

/** DXF reals: fixed notation, no exponent — some readers reject 1e-7. */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return '0.0';
  const r = Math.abs(v) < 1e-9 ? 0 : v;
  return r.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0');
}

/**
 * Typography the sheets use as punctuation, spelled the way CAD prefers.
 * A separator has no business surviving as `\U+00B7` in a drawing — but a
 * letter in a Turkish or Persian name does have to survive, so only these
 * few are folded down.
 */
const PUNCTUATION: Record<string, string> = {
  '\u2014': '-', '\u2013': '-', '\u2212': '-',   // em dash, en dash, minus
  '\u00B7': '-', '\u2022': '-',                  // middle dot, bullet
  '\u00D7': 'x', '\u2026': '...',                // times, ellipsis
  '\u2018': "'", '\u2019': "'",                  // curly quotes
  '\u201C': '"', '\u201D': '"',
  '\u00A0': ' ',                                 // non-breaking space
};

function encode(s: string, mode: 'escape' | 'raw'): string {
  // Newlines and control characters would break the line-per-value framing.
  const flat = String(s ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u2014\u2013\u2212\u00B7\u2022\u00D7\u2026\u2018\u2019\u201C\u201D\u00A0]/g,
      ch => PUNCTUATION[ch]);
  if (mode === 'raw') return flat;
  return flat.replace(/[^\x20-\x7E]/g, ch =>
    `\\U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
}

const norm = (deg: number) => ((deg % 360) + 360) % 360;

/**
 * Which CAD line type draws an SVG dash pattern.
 *
 * A drawing office asks for four: solid, dashed, dash-dot and dotted. SVG says
 * them as a run of lengths, so they are read back by shape rather than matched
 * against the exact numbers the editor happens to write — a dashed line that
 * came in from someone else's DXF or SVG still leaves as a dashed line.
 * Undefined means the entity takes its layer's line type, which is what an
 * unstyled shape should do.
 */
export function lineTypeFor(dash?: string): string | undefined {
  if (!dash) return undefined;
  const run = dash.split(/[\s,]+/).map(Number).filter(n => Number.isFinite(n) && n >= 0);
  if (run.length < 2 || run.every(n => n === 0)) return undefined;
  // A dot is a dash with no length to speak of against the gap after it.
  if (run[0] <= 2 && run[0] * 1.5 <= run[1]) return 'DOT';
  // Long, gap, short, gap — the centre line of a drawing.
  if (run.length >= 4 && run[2] < run[0] / 2) return 'DASHDOT';
  return 'DASHED';
}

/** Sheet space (y down, pixels) → paper space (y up, millimetres). */
interface Frame { s: number; ox: number; oy: number; height: number }
const px = (f: Frame, x: number) => f.ox + x * f.s;
const py = (f: Frame, y: number) => f.oy + (f.height - y) * f.s;

// ── Entities ────────────────────────────────────────────────────────────────

function line(
  t: Tape, layer: Layer, x1: number, y1: number, x2: number, y2: number, lt?: string,
) {
  t.pair(0, 'LINE').pair(8, layer);
  if (lt) t.pair(6, lt);
  t.pair(10, x1).pair(20, y1).pair(30, 0)
    .pair(11, x2).pair(21, y2).pair(31, 0);
}

function polyline(t: Tape, layer: Layer, pts: Pt[], close: boolean, lt?: string) {
  for (let i = 1; i < pts.length; i++) {
    line(t, layer, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], lt);
  }
  if (close && pts.length > 2) {
    const a = pts[pts.length - 1], b = pts[0];
    line(t, layer, a[0], a[1], b[0], b[1], lt);
  }
}

/** A filled triangle or quad. SOLID takes its last two corners swapped. */
function solid(t: Tape, layer: Layer, pts: Pt[]) {
  const [a, b, c] = pts;
  const d = pts.length > 3 ? pts[3] : c;
  t.pair(0, 'SOLID').pair(8, layer)
    .pair(10, a[0]).pair(20, a[1]).pair(30, 0)
    .pair(11, b[0]).pair(21, b[1]).pair(31, 0)
    .pair(12, d[0]).pair(22, d[1]).pair(32, 0)
    .pair(13, c[0]).pair(23, c[1]).pair(33, 0);
}

function text(
  t: Tape, layer: Layer, x: number, y: number, height: number, value: string,
  justify: 0 | 1 | 2, mode: 'escape' | 'raw', rot = 0,
) {
  t.pair(0, 'TEXT').pair(8, layer)
    .pair(10, x).pair(20, y).pair(30, 0)
    .pair(40, height)
    .pair(1, encode(value, mode))
    .pair(7, 'STANDARD');
  // Group 50 is degrees anticlockwise on the paper — the same sense as `rot`,
  // because paper space already has y up.
  if (rot) t.pair(50, norm(rot));
  t.pair(72, justify).pair(73, 0)
    // With a justification other than left, readers take the second point.
    .pair(11, x).pair(21, y).pair(31, 0);
}

function shapeToDxf(t: Tape, s: Shape, f: Frame, mode: 'escape' | 'raw') {
  const X = (v: number) => px(f, v);
  const Y = (v: number) => py(f, v);
  // A shape drawn dashed says so on itself; everything else takes its layer's.
  const lt = lineTypeFor(s.dash);

  switch (s.t) {
    case 'line':
      line(t, s.layer, X(s.x1), Y(s.y1), X(s.x2), Y(s.y2), lt);
      break;

    case 'rect':
      polyline(t, s.layer, [
        [X(s.x), Y(s.y)], [X(s.x + s.w), Y(s.y)],
        [X(s.x + s.w), Y(s.y + s.h)], [X(s.x), Y(s.y + s.h)],
      ], true, lt);
      break;

    case 'circle':
      t.pair(0, 'CIRCLE').pair(8, s.layer);
      if (lt) t.pair(6, lt);
      t.pair(10, X(s.cx)).pair(20, Y(s.cy)).pair(30, 0)
        .pair(40, s.r * f.s);
      break;

    case 'ellipse': {
      // R12 has no ELLIPSE entity, so it is walked. At 72 segments the flat
      // side sits well inside the width of the line that draws it.
      const STEPS = 72;
      const pts: Pt[] = [];
      for (let i = 0; i < STEPS; i++) {
        const a = (i / STEPS) * Math.PI * 2;
        pts.push([X(s.cx + s.rx * Math.cos(a)), Y(s.cy + s.ry * Math.sin(a))]);
      }
      polyline(t, s.layer, pts, true, lt);
      break;
    }

    case 'arc':
      // Sheet angles run clockwise once y is flipped; DXF arcs run the other
      // way, so the ends swap and both are negated.
      t.pair(0, 'ARC').pair(8, s.layer);
      if (lt) t.pair(6, lt);
      t.pair(10, X(s.cx)).pair(20, Y(s.cy)).pair(30, 0)
        .pair(40, s.r * f.s)
        .pair(50, norm(-s.a1)).pair(51, norm(-s.a0));
      break;

    case 'curve':
      polyline(t, s.layer,
        flattenCurve(s.x1, s.y1, s.cx, s.cy, s.x2, s.y2).map(p => [X(p[0]), Y(p[1])] as Pt),
        false, lt);
      break;

    case 'poly': {
      const pts = s.pts.map(p => [X(p[0]), Y(p[1])] as Pt);
      const filled = s.fill && s.fill !== 'none';
      if (filled && (pts.length === 3 || pts.length === 4)) solid(t, s.layer, pts);
      else polyline(t, s.layer, pts, s.close ?? Boolean(filled), lt);
      break;
    }

    case 'text':
      text(t, s.layer, X(s.x), Y(s.y), s.size * CAP_HEIGHT * f.s, s.s,
        s.anchor === 'middle' ? 1 : s.anchor === 'end' ? 2 : 0, mode, s.rot ?? 0);
      break;
  }
}

// ── Tables ──────────────────────────────────────────────────────────────────

function tables(t: Tape, layers: Layer[]) {
  t.pair(0, 'SECTION').pair(2, 'TABLES');

  // The four a drawing office draws with. They are always defined, whether or
  // not this sheet uses them, so a line restyled in the CAD system afterwards
  // has something to be restyled to. Lengths are millimetres of paper.
  t.pair(0, 'TABLE').pair(2, 'LTYPE').pair(70, 4);
  t.pair(0, 'LTYPE').pair(2, 'CONTINUOUS').pair(70, 0).pair(3, 'Solid line')
    .pair(72, 65).pair(73, 0).pair(40, 0);
  t.pair(0, 'LTYPE').pair(2, 'DASHED').pair(70, 0).pair(3, 'Dashed __ __ __')
    .pair(72, 65).pair(73, 2).pair(40, 6).pair(49, 4).pair(49, -2);
  t.pair(0, 'LTYPE').pair(2, 'DASHDOT').pair(70, 0).pair(3, 'Dash dot __ . __ . __')
    .pair(72, 65).pair(73, 4).pair(40, 10).pair(49, 6).pair(49, -2).pair(49, 0).pair(49, -2);
  t.pair(0, 'LTYPE').pair(2, 'DOT').pair(70, 0).pair(3, 'Dotted . . . . . . . .')
    .pair(72, 65).pair(73, 2).pair(40, 2).pair(49, 0).pair(49, -2);
  t.pair(0, 'ENDTAB');

  t.pair(0, 'TABLE').pair(2, 'LAYER').pair(70, layers.length + 1);
  t.pair(0, 'LAYER').pair(2, '0').pair(70, 0).pair(62, 7).pair(6, 'CONTINUOUS');
  for (const l of layers) {
    t.pair(0, 'LAYER').pair(2, l).pair(70, 0)
      .pair(62, LAYERS[l].aci).pair(6, LAYERS[l].linetype);
  }
  t.pair(0, 'ENDTAB');

  t.pair(0, 'TABLE').pair(2, 'STYLE').pair(70, 1);
  t.pair(0, 'STYLE').pair(2, 'STANDARD').pair(70, 0)
    .pair(40, 0).pair(41, 1).pair(50, 0).pair(71, 0).pair(42, 2.5)
    .pair(3, 'txt').pair(4, '');
  t.pair(0, 'ENDTAB');

  t.pair(0, 'ENDSEC');
}

// ── The file ────────────────────────────────────────────────────────────────

function drawFrame(t: Tape, paper: Paper, lines: string[], mode: 'escape' | 'raw') {
  const x0 = MARGIN, y0 = MARGIN, x1 = paper.w - MARGIN, y1 = paper.h - MARGIN;
  polyline(t, 'FRAME', [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true);

  if (lines.length === 0) return;
  // A title block in the corner every drawing office looks at first.
  const rows = Math.min(lines.length, 5);
  const b = titleBlockBox(paper, lines.length);
  polyline(t, 'FRAME', [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]], true);
  lines.slice(0, rows).forEach((row, i) => {
    const y = b.y + b.h - 6 - i * 6;
    if (i > 0) line(t, 'FRAME', b.x, y + 4.5, b.x + b.w, y + 4.5);
    text(t, 'TITLE', b.x + 3, y, i === 0 ? 3.5 : 2.5, row, 0, mode);
  });
}

/**
 * The drawing as a DXF file, ready to be written to disk or downloaded.
 *
 * The geometry is scaled by `mmPerUnit`, flipped so y runs up, and centred on
 * the smallest ISO sheet that holds it.
 */
export function renderDxf(d: Drawing, options: DxfOptions = {}): string {
  const {
    mmPerUnit = 0.5, paper: choice = 'auto', frame = true, titleBlock = [],
    unicode = 'escape',
  } = options;

  const { paper, scale, ox, oy } = fitToNamedPaper(d.width, d.height, choice, mmPerUnit);
  const f: Frame = { s: scale, ox, oy, height: d.height };

  const t = new Tape();

  t.pair(999, encode(d.name || 'drawing', unicode));
  t.pair(0, 'SECTION').pair(2, 'HEADER')
    .pair(9, '$ACADVER').pair(1, 'AC1009')
    .pair(9, '$INSBASE').pair(10, 0).pair(20, 0).pair(30, 0)
    .pair(9, '$EXTMIN').pair(10, 0).pair(20, 0).pair(30, 0)
    .pair(9, '$EXTMAX').pair(10, paper.w).pair(20, paper.h).pair(30, 0)
    .pair(9, '$LIMMIN').pair(10, 0).pair(20, 0)
    .pair(9, '$LIMMAX').pair(10, paper.w).pair(20, paper.h)
    // 4 = millimetres, so a reader knows the drawing is 1:1 in mm.
    .pair(9, '$INSUNITS').pair(70, 4)
    .pair(9, '$LTSCALE').pair(40, 1)
    .pair(9, '$TEXTSTYLE').pair(7, 'STANDARD')
    .pair(0, 'ENDSEC');

  const used = d.usedLayers();
  tables(t, frame && !used.includes('FRAME') ? [...used, 'FRAME'] : used);

  // R12 readers expect the section even when nothing defines a block.
  t.pair(0, 'SECTION').pair(2, 'BLOCKS').pair(0, 'ENDSEC');

  t.pair(0, 'SECTION').pair(2, 'ENTITIES');
  if (frame) drawFrame(t, paper, titleBlock, unicode);
  for (const s of d.shapes) shapeToDxf(t, s, f, unicode);
  t.pair(0, 'ENDSEC');

  t.pair(0, 'EOF');
  return t.toString();
}

/** Several sheets in one file, tiled left to right with a gap between them. */
export function mergeDrawings(sheets: Drawing[], gap = 60, name = ''): Drawing {
  const width = sheets.reduce((w, s) => w + s.width, 0) + gap * Math.max(0, sheets.length - 1);
  const height = Math.max(1, ...sheets.map(s => s.height));
  const merged = new Drawing(width, height, name);
  let x = 0;
  for (const sheet of sheets) {
    for (const s of sheet.shapes) merged.add(translateShape(s, x, 0));
    x += sheet.width + gap;
  }
  return merged;
}
