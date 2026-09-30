// src/utils/cad/pdf.ts
//
// A Drawing as PDF — vector, one page per sheet, no print dialog.
//
// The sheets could always be turned into a PDF by opening the print window and
// choosing "Save as PDF", and that still works. This writes the file directly:
// the same geometry, at a known scale on a known sheet size, with the frame and
// title block the DXF gets, produced by a click rather than a dialog.
//
// PDF's y axis runs down the page, the same way the sheets are drawn, so unlike
// DXF there is nothing to flip — only to scale and centre.
import { jsPDF } from 'jspdf';
import { Drawing, Shape, flattenCurve } from './shapes';
import { onArc } from './svg';
import { MARGIN, Paper, PaperChoice, fitToNamedPaper, titleBlockBox } from './paper';
import { hasHeader } from './header';

export interface PdfOptions {
  /** Millimetres per drawing unit. 0.5 puts a 1600-unit sheet on an A1. */
  mmPerUnit?: number;
  /** Name a sheet and the scale is whatever fits it; 'auto' keeps mmPerUnit. */
  paper?: PaperChoice;
  /** Draw the sheet border and title block. */
  frame?: boolean;
  /** Lines for the title block: project, switchgear, sheet number… */
  titleBlock?: string[];
}

/** '#111' and '#e5e7eb' alike, as the three channels jsPDF wants. */
function rgb(color: string | undefined, fallback: [number, number, number]): [number, number, number] {
  const hex = (color ?? '').trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  if (short) return [parseInt(short[1] + short[1], 16), parseInt(short[2] + short[2], 16), parseInt(short[3] + short[3], 16)];
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (long) return [parseInt(long[1], 16), parseInt(long[2], 16), parseInt(long[3], 16)];
  return fallback;
}

const isPainted = (fill: string | undefined) =>
  Boolean(fill && fill !== 'none' && fill !== 'transparent');

/** Points per millimetre, for turning a drawing size into a font size. */
const PT_PER_MM = 72 / 25.4;

/**
 * Text the standard PDF fonts can actually set.
 *
 * A PDF's built-in Helvetica is encoded WinAnsi, which covers Latin-1 — ç, ö,
 * ü, é all set correctly. Turkish reaches past it for ğ, ş, ı and İ, and jsPDF
 * answers a single such letter by switching the whole string to a two-byte
 * encoding the font has no map for, so one `ğ` turns a project name into
 * nonsense. Folding those letters to their base keeps the name readable and
 * everything around it correct.
 *
 * Scripts with no Latin form — Persian above all — cannot be set this way at
 * all: they need the letters joined and run right to left, which is shaping,
 * and a PDF writer does not shape. They are marked rather than mangled, and
 * Print / PDF, which renders through the browser, stays the exact route for a
 * drawing that carries them.
 */
export function winAnsiSafe(text: string): string {
  let out = '';
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0)!;
    if (code <= 0xff || code === 0x2013 || code === 0x2014 || code === 0x2018 ||
        code === 0x2019 || code === 0x201c || code === 0x201d || code === 0x2022 ||
        code === 0x2026 || code === 0x20ac || code === 0x2122) {
      out += ch;
      continue;
    }
    // ğ → g, İ → I, ş → s: the letter without its mark, when there is one.
    const stripped = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const usable = [...stripped].every(c => c.codePointAt(0)! <= 0xff);
    out += usable && stripped ? stripped : '?';
  }
  // ı (dotless i) and ﬁ-style ligatures carry no combining mark to strip.
  return out
    .replace(/\u0131/g, 'i').replace(/\u0130/g, 'I')
    .replace(/\u0141/g, 'L').replace(/\u0142/g, 'l');
}

interface Place { s: number; ox: number; oy: number }
const px = (p: Place, x: number) => p.ox + x * p.s;
const py = (p: Place, y: number) => p.oy + y * p.s;

/** Set up stroke, fill and dash for one shape; say which jsPDF style to use. */
function style(doc: jsPDF, s: Shape, place: Place): 'S' | 'F' | 'DF' | null {
  const stroked = (s.width ?? 1) > 0;
  const filled = isPainted(s.fill);
  if (!stroked && !filled) return null;

  if (stroked) {
    doc.setDrawColor(...rgb(s.color, [17, 17, 17]));
    // A hairline still has to be visible; below 0.05 mm plotters drop it.
    doc.setLineWidth(Math.max(0.05, (s.width ?? 1) * place.s));
    const dash = s.dash?.split(/[\s,]+/).map(Number).filter(n => Number.isFinite(n) && n > 0);
    doc.setLineDashPattern(dash && dash.length ? dash.map(v => v * place.s) : [], 0);
  }
  if (filled) doc.setFillColor(...rgb(s.fill, [17, 17, 17]));

  return stroked && filled ? 'DF' : filled ? 'F' : 'S';
}

/** A run of points as one path — jsPDF takes them as steps from the first. */
function polyline(doc: jsPDF, pts: [number, number][], mode: 'S' | 'F' | 'DF', close: boolean) {
  if (pts.length < 2) return;
  const steps: [number, number][] = [];
  for (let i = 1; i < pts.length; i++) {
    steps.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
  }
  doc.lines(steps, pts[0][0], pts[0][1], [1, 1], mode, close);
}

function drawShape(doc: jsPDF, s: Shape, place: Place) {
  const mode = style(doc, s, place);
  if (!mode) return;
  const X = (v: number) => px(place, v);
  const Y = (v: number) => py(place, v);

  switch (s.t) {
    case 'line':
      doc.line(X(s.x1), Y(s.y1), X(s.x2), Y(s.y2));
      break;

    case 'rect':
      doc.rect(X(s.x), Y(s.y), s.w * place.s, s.h * place.s, mode);
      break;

    case 'circle':
      doc.circle(X(s.cx), Y(s.cy), s.r * place.s, mode);
      break;

    case 'ellipse':
      doc.ellipse(X(s.cx), Y(s.cy), s.rx * place.s, s.ry * place.s, mode);
      break;

    case 'arc': {
      const steps = Math.max(8, Math.ceil(Math.abs(s.a1 - s.a0) / 6));
      const pts: [number, number][] = [];
      for (let i = 0; i <= steps; i++) {
        const [ax, ay] = onArc(s.cx, s.cy, s.r, s.a0 + ((s.a1 - s.a0) * i) / steps);
        pts.push([X(ax), Y(ay)]);
      }
      polyline(doc, pts, mode, false);
      break;
    }

    case 'curve':
      polyline(doc,
        flattenCurve(s.x1, s.y1, s.cx, s.cy, s.x2, s.y2).map(p => [X(p[0]), Y(p[1])] as [number, number]),
        mode, false);
      break;

    case 'poly':
      polyline(doc, s.pts.map(p => [X(p[0]), Y(p[1])] as [number, number]), mode,
        s.close ?? isPainted(s.fill));
      break;

    case 'text': {
      doc.setTextColor(...rgb(s.color, [17, 17, 17]));
      doc.setFont('helvetica', s.bold ? 'bold' : 'normal');
      doc.setFontSize(s.size * place.s * PT_PER_MM);
      doc.text(winAnsiSafe(s.s), X(s.x), Y(s.y), {
        align: s.anchor === 'middle' ? 'center' : s.anchor === 'end' ? 'right' : 'left',
        baseline: 'alphabetic',
        // jsPDF turns text anticlockwise about the point it is placed at, the
        // same sense as `rot`.
        ...(s.rot ? { angle: s.rot } : {}),
      });
      break;
    }
  }
}

function drawFrame(doc: jsPDF, paper: Paper, lines: string[]) {
  doc.setDrawColor(17, 17, 17);
  doc.setLineWidth(0.3);
  doc.setLineDashPattern([], 0);
  doc.rect(MARGIN, MARGIN, paper.w - 2 * MARGIN, paper.h - 2 * MARGIN, 'S');

  if (lines.length === 0) return;
  const rows = Math.min(lines.length, 5);
  const b = titleBlockBox(paper, lines.length);
  // PDF measures down the page, so the block sits at the foot, not at y = MARGIN.
  const top = paper.h - MARGIN - b.h;
  doc.rect(b.x, top, b.w, b.h, 'S');
  doc.setTextColor(17, 17, 17);
  lines.slice(0, rows).forEach((row, i) => {
    const y = top + 6 + i * 6;
    if (i > 0) {
      doc.setLineWidth(0.15);
      doc.line(b.x, y - 4.5, b.x + b.w, y - 4.5);
    }
    doc.setFont('helvetica', i === 0 ? 'bold' : 'normal');
    doc.setFontSize((i === 0 ? 3.5 : 2.5) * PT_PER_MM);
    doc.text(winAnsiSafe(row), b.x + 3, y);
  });
}

/**
 * The sheets as one PDF, a page each.
 *
 * Text is set in the standard PDF Helvetica, which covers Latin-1. A name in
 * Turkish or Persian that reaches beyond it will not set correctly here — for
 * those, Print / PDF renders the sheet through the browser's own fonts and is
 * exact. Everything geometric is identical either way.
 */
export function renderPdf(sheets: Drawing[], options: PdfOptions = {}): Blob {
  const { mmPerUnit = 0.5, paper: choice = 'auto', frame = true, titleBlock = [] } = options;
  const pages = sheets.length > 0 ? sheets : [new Drawing(297 / mmPerUnit, 210 / mmPerUnit)];

  let doc: jsPDF | null = null;
  pages.forEach((sheet, index) => {
    const { paper, scale, ox, oy } = fitToNamedPaper(sheet.width, sheet.height, choice, mmPerUnit);
    const format: [number, number] = [paper.w, paper.h];
    if (index === 0) doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format });
    else doc!.addPage(format, 'landscape');

    // As in the DXF: a sheet with its own header does not want a second frame.
    if (frame && !hasHeader(sheet.shapes)) drawFrame(doc!, paper, titleBlock);
    const place: Place = { s: scale, ox, oy };
    for (const s of sheet.shapes) drawShape(doc!, s, place);
  });

  doc!.setProperties({ title: pages[0].name || 'Drawing' });
  return doc!.output('blob');
}
