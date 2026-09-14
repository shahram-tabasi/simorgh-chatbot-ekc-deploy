// A spreadsheet, drawn on the sheet.
//
// Importing an Excel file into a drawing means one thing here: the rows become
// a real table of lines and text on the TABLE layer, in drawing units, so it
// prints, exports to DXF and gets edited like anything else on the sheet. It is
// not an embedded object — there is nothing in a DXF to embed it into.
//
// Everything a re-import needs to find the table again rides on the shapes
// themselves, in `blockName`: one import is one block, so Update can lift the
// old one out and put the new one down in its place without touching the rest
// of the drawing.

import { Pt, Shape } from './shapes';

export interface TableStyle {
  /** Height of the text, in drawing units. Everything else is sized off it. */
  textSize: number;
  /** Stroke width for the rules. */
  width: number;
  /** Row height. Defaults to comfortable padding around the text. */
  rowHeight?: number;
  /** Column widths, in drawing units. Measured from the content when absent. */
  columnWidths?: number[];
  /** Draw the first row as headings. */
  header?: boolean;
}

/** Marks every shape belonging to one imported table. */
export const tableBlockName = (id: string) => `XLSX:${id}`;

/** Is this shape part of an imported table, and if so which one. */
export function tableIdOf(s: Shape): string | null {
  const name = (s as { blockName?: string }).blockName;
  return name && name.startsWith('XLSX:') ? name.slice(5) : null;
}

/**
 * Column widths from the content, when none were given.
 *
 * Character-count times a width factor rather than real font metrics: the
 * drawing is vector and the font is whatever the CAD system has, so measuring
 * in the browser would be measuring the wrong font. Erring wide keeps text
 * inside its cell, which is what matters.
 */
const CHAR_W = 0.62;
function measureColumns(rows: string[][], textSize: number): number[] {
  const columns = Math.max(0, ...rows.map(r => r.length));
  const widths: number[] = [];
  for (let c = 0; c < columns; c++) {
    const longest = Math.max(1, ...rows.map(r => (r[c] ?? '').length));
    widths.push(Math.max(textSize * 3, longest * textSize * CHAR_W + textSize));
  }
  return widths;
}

/**
 * The geometry for one table, with its top-left corner at `at`.
 *
 * Rows are drawn downwards — sheet space has y increasing down, the same way
 * the rest of this drawing code works, so a table reads top to bottom without
 * anything having to be flipped.
 */
export function tableShapes(
  rows: string[][],
  at: Pt,
  style: TableStyle,
  id: string,
): Shape[] {
  const clean = rows.filter(r => r.some(c => String(c ?? '').trim() !== ''));
  if (clean.length === 0) return [];

  const textSize = style.textSize;
  const rowH = style.rowHeight ?? textSize * 2;
  const widths = style.columnWidths ?? measureColumns(clean, textSize);
  const total = widths.reduce((a, b) => a + b, 0);
  const height = clean.length * rowH;
  const [x0, y0] = at;

  const pen = {
    layer: 'TABLE' as const,
    width: style.width,
    block: id,
    blockName: tableBlockName(id),
  };
  const out: Shape[] = [];

  // Rules first, so the text draws over them rather than under.
  for (let r = 0; r <= clean.length; r++) {
    const y = y0 + r * rowH;
    out.push({ t: 'line', x1: x0, y1: y, x2: x0 + total, y2: y, ...pen });
  }
  let x = x0;
  for (let c = 0; c <= widths.length; c++) {
    out.push({ t: 'line', x1: x, y1: y0, x2: x, y2: y0 + height, ...pen });
    x += widths[c] ?? 0;
  }

  clean.forEach((row, r) => {
    let cx = x0;
    row.forEach((cell, c) => {
      const w = widths[c] ?? 0;
      const value = String(cell ?? '').trim();
      if (value) {
        out.push({
          t: 'text',
          // Left-padded by a third of the text height, and sat on the row's
          // baseline rather than its top edge, so the glyphs sit inside the
          // cell instead of straddling the rule above it.
          x: cx + textSize * 0.35,
          y: y0 + r * rowH + rowH * 0.5 + textSize * 0.35,
          s: value,
          size: textSize,
          bold: style.header === true && r === 0,
          ...pen,
        });
      }
      cx += w;
    });
  });

  return out;
}

/** Where a table currently sits, so a re-import can land in the same place. */
export function tableOrigin(shapes: Shape[], id: string): Pt | null {
  let x = Infinity, y = Infinity;
  for (const s of shapes) {
    if (tableIdOf(s) !== id) continue;
    if (s.t === 'line') { x = Math.min(x, s.x1, s.x2); y = Math.min(y, s.y1, s.y2); }
    else if (s.t === 'text') { x = Math.min(x, s.x); y = Math.min(y, s.y); }
  }
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

/**
 * Put a freshly read table where the old one was.
 *
 * Replacing in place rather than appending is the whole point of Update: the
 * spreadsheet is the source, the table on the sheet is a view of it, and a
 * second copy landing beside the first would be the opposite of what was asked
 * for. Anything drawn since that is not part of this table is untouched.
 */
export function replaceTable(shapes: Shape[], id: string, next: Shape[]): Shape[] {
  const kept = shapes.filter(s => tableIdOf(s) !== id);
  return [...kept, ...next];
}
