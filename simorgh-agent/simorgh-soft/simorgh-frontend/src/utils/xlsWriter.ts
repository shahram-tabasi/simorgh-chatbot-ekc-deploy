// src/utils/xlsWriter.ts
//
// A small writer for Excel 97-2003 workbooks (.xls, BIFF8), with formatting.
//
// BPMS takes the BPMS sheet as the .xls EPLAN used to produce — its fonts,
// borders, fills, widths, row heights, merged title and frozen heading
// included. The spreadsheet library in this app writes .xls, but writes it
// plain: every style is dropped. This writes the records that sheet needs and
// nothing else — fonts, cell formats, shared strings, column widths, row
// heights, text and blank cells, merged cells, frozen panes and zoom — and
// packs them into the compound file an .xls is, with the compound-file writer
// that library already ships.
//
// Cells are text (or blank): every value in the BPMS sheet is text, and that
// is all this has to write.

import * as XLSX from 'xlsx-js-style';

/** Line styles, as BIFF8 numbers them. */
export const LINE = { none: 0, thin: 1, double: 6 } as const;

/** A cell format. Colours are indices into Excel's default palette. */
export interface XlsStyle {
  bold?: boolean;
  /** Font colour; left out it is "automatic". */
  fontColor?: number;
  /** 0 general, 1 left, 2 centre, 3 right. */
  h?: 0 | 1 | 2 | 3;
  /** 0 top, 1 centre, 2 bottom. */
  v?: 0 | 1 | 2;
  wrap?: boolean;
  /** Left, right, top, bottom line styles. */
  border?: [number, number, number, number];
  /** Solid fill in this palette colour; left out, no fill. */
  fill?: number;
  /** Number format "@" (text) rather than General. */
  text?: boolean;
}

export interface XlsCell { r: number; c: number; v?: string; s: number }

export interface XlsSheet {
  name: string;
  cells: XlsCell[];
  /** Column widths in 1/256 of a character, from column 0. */
  colWidths: number[];
  /** Width of every column after `colWidths`, to column 255. */
  restWidth?: number;
  /** Row heights in twips (1/20 pt). */
  rowHeights: Record<number, number>;
  /** Merged ranges, [firstRow, lastRow, firstCol, lastCol], inclusive. */
  merges: [number, number, number, number][];
  /** Rows frozen at the top. */
  freezeRows?: number;
  /** Zoom, percent. */
  zoom?: number;
}

// ── Bytes ────────────────────────────────────────────────────────────────────

class Bytes {
  private parts: number[] = [];
  get length() { return this.parts.length; }
  u8(v: number) { this.parts.push(v & 0xff); return this; }
  u16(v: number) { return this.u8(v).u8(v >>> 8); }
  u32(v: number) { return this.u16(v & 0xffff).u16((v >>> 16) & 0xffff); }
  f64(v: number) {
    const b = new Uint8Array(new Float64Array([v]).buffer);
    b.forEach(x => this.u8(x));
    return this;
  }
  utf16(s: string) { for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i)); return this; }
  bytes(b: ArrayLike<number>) { for (let i = 0; i < b.length; i++) this.u8(b[i]); return this; }
  array() { return Uint8Array.from(this.parts); }
}

const MAX_RECORD = 8224;

/** One record, split into CONTINUE records when it is too long. */
function record(out: Bytes, id: number, body: Bytes | Uint8Array) {
  const data = body instanceof Bytes ? body.array() : body;
  out.u16(id).u16(data.length).bytes(data);
}

// ── Workbook ─────────────────────────────────────────────────────────────────

/** Default fonts Excel expects before any of its own (index 4 is never used). */
const BASE_FONTS = 4;

function fontRecord(bold: boolean, color: number): Bytes {
  const name = 'Arial';
  return new Bytes()
    .u16(200)                    // 10 pt
    .u16(bold ? 0x0001 : 0)      // bold flag (older readers go by it), not italic
    .u16(color)                  // colour index, 0x7FFF automatic
    .u16(bold ? 700 : 400)       // weight
    .u16(0)                      // not super/subscript
    .u8(0)                       // no underline
    .u8(2)                       // family: swiss
    .u8(0)                       // character set: ANSI
    .u8(0)
    .u8(name.length).u8(0)       // 8-bit name
    .bytes([...name].map(ch => ch.charCodeAt(0)));
}

function xfRecord(font: number, fmt: number, style: boolean, s: XlsStyle = {}): Bytes {
  const [l, r, t, b] = s.border ?? [0, 0, 0, 0];
  const auto = 0x40;
  const fill = s.fill !== undefined;
  const align = (s.h ?? 0) | (s.wrap ? 0x08 : 0) | ((s.v ?? 2) << 4);
  return new Bytes()
    .u16(font)
    .u16(fmt)
    // locked; a style XF has no parent (0xFFF), a cell XF has the Normal style
    .u16(0x0001 | (style ? 0x0004 | 0xfff0 : 0))
    .u8(align)
    .u8(0)                                         // no rotation
    .u8(0)                                         // no indent
    .u8(style ? 0xf4 : 0xfc)                       // which attributes this XF sets
    .u32(l | (r << 4) | (t << 8) | (b << 12) | (auto << 16) | (auto << 23))
    .u32(auto | (auto << 7) | ((fill ? 1 : 0) << 26))
    .u16(fill ? (s.fill! | (auto << 7)) : (auto | (0x41 << 7)));
}

/**
 * The shared string table, in as many CONTINUE records as it needs. A string
 * that does not fit in what is left of a record is carried on in the next one,
 * behind the one-byte header BIFF8 asks for there.
 */
function sstRecords(out: Bytes, strings: string[], total: number) {
  const chunks: Bytes[] = [new Bytes().u32(total).u32(strings.length)];
  let current = chunks[0];
  const room = () => MAX_RECORD - current.length;
  // Where every `bucket`th string starts, for EXTSST: [chunk, offset in it].
  const bucket = Math.max(8, Math.ceil(strings.length / 128));
  const marks: [number, number][] = [];
  strings.forEach((s, index) => {
    // The 3-byte header and at least one character stay together.
    if (room() < 5) { current = new Bytes(); chunks.push(current); }
    if (index % bucket === 0) marks.push([chunks.length - 1, current.length]);
    current.u16(s.length).u8(0x01);
    let i = 0;
    while (i < s.length) {
      const fit = Math.floor(room() / 2);
      if (fit === 0) { current = new Bytes().u8(0x01); chunks.push(current); continue; }
      const n = Math.min(fit, s.length - i);
      current.utf16(s.slice(i, i + n));
      i += n;
      if (i < s.length) { current = new Bytes().u8(0x01); chunks.push(current); }
    }
  });
  const starts: number[] = [];
  chunks.forEach((chunk, i) => { starts.push(out.length); record(out, i === 0 ? 0x00fc : 0x003c, chunk); });
  // EXTSST: the stream offset of each bucket's first string, so a reader can
  // find a string without walking the table. The globals start the stream, so
  // an offset in them is an offset in the stream.
  const ext = new Bytes().u16(bucket);
  for (const [chunk, offset] of marks) ext.u32(starts[chunk] + 4 + offset).u16(4 + offset).u16(0);
  record(out, 0x00ff, ext);
}

function globals(styles: XlsStyle[], sheets: XlsSheet[], strings: string[], total: number, sheetOffsets: number[]): Uint8Array {
  const out = new Bytes();
  record(out, 0x0809, new Bytes().u16(0x0600).u16(0x0005).u16(0x0dbb).u16(0x07cc).u32(0x00000000).u32(0x00000006));
  record(out, 0x00e1, new Bytes().u16(0x04b0));             // INTERFACEHDR
  record(out, 0x00c1, new Bytes().u16(0));                  // MMS
  record(out, 0x00e2, new Bytes());                         // INTERFACEEND
  const who = new Bytes().u16(7).u8(0).bytes([...'Simorgh'].map(c => c.charCodeAt(0)));
  while (who.length < 112) who.u8(0x20);
  record(out, 0x005c, who);                                 // WRITEACCESS
  record(out, 0x0042, new Bytes().u16(0x04b0));             // CODEPAGE: UTF-16
  record(out, 0x0161, new Bytes().u16(0));                  // DSF
  const tabs = new Bytes(); sheets.forEach((_, i) => tabs.u16(i + 1));
  record(out, 0x013d, tabs);                                // TABID
  record(out, 0x009c, new Bytes().u16(0x000e));             // FNGROUPCOUNT
  record(out, 0x0019, new Bytes().u16(0));                  // WINDOWPROTECT
  record(out, 0x0012, new Bytes().u16(0));                  // PROTECT
  record(out, 0x0013, new Bytes().u16(0));                  // PASSWORD
  record(out, 0x01af, new Bytes().u16(0));                  // PROT4REV
  record(out, 0x01bc, new Bytes().u16(0));                  // PROT4REVPASS
  record(out, 0x0040, new Bytes().u16(0));                  // BACKUP
  record(out, 0x008d, new Bytes().u16(0));                  // HIDEOBJ
  record(out, 0x003d, new Bytes().u16(0x0168).u16(0x001e).u16(0x3fcf).u16(0x2a4e)
    .u16(0x0038).u16(0).u16(0).u16(1).u16(0x0258));        // WINDOW1
  record(out, 0x0022, new Bytes().u16(0));                  // DATEMODE 1900
  record(out, 0x000e, new Bytes().u16(1));                  // PRECISION
  record(out, 0x01b7, new Bytes().u16(0));                  // REFRESHALL
  record(out, 0x00da, new Bytes().u16(0));                  // BOOKBOOL

  // Fonts: four defaults, then regular / bold / bold in each colour a style asks for.
  for (let i = 0; i < BASE_FONTS; i++) record(out, 0x0031, fontRecord(false, 0x7fff));
  const fontKeys: string[] = [];
  const fontOf = (s: XlsStyle) => {
    const key = `${s.bold ? 1 : 0}:${s.fontColor ?? 0x7fff}`;
    let i = fontKeys.indexOf(key);
    if (i < 0) { i = fontKeys.length; fontKeys.push(key); }
    return BASE_FONTS + 1 + i;                              // index 4 does not exist
  };
  const fontIndex = styles.map(fontOf);
  fontKeys.forEach(key => {
    const [bold, color] = key.split(':').map(Number);
    record(out, 0x0031, fontRecord(bold === 1, color));
  });

  // XFs: the fifteen style XFs and the default cell XF Excel expects, then ours.
  for (let i = 0; i < 15; i++) record(out, 0x00e0, xfRecord(0, 0, true));
  record(out, 0x00e0, xfRecord(0, 0, false));
  styles.forEach((s, i) => record(out, 0x00e0, xfRecord(fontIndex[i], s.text ? 49 : 0, false, s)));
  record(out, 0x0293, new Bytes().u16(0x8000).u8(0).u8(0xff));   // STYLE: Normal
  record(out, 0x0160, new Bytes().u16(1));                       // USESELFS

  sheets.forEach((sheet, i) => {
    const name = sheet.name.slice(0, 31);
    record(out, 0x0085, new Bytes().u32(sheetOffsets[i]).u16(0)
      .u8(name.length).u8(0x01).utf16(name));                   // BOUNDSHEET
  });
  record(out, 0x008c, new Bytes().u16(1).u16(1));                // COUNTRY
  sstRecords(out, strings, total);
  record(out, 0x000a, new Bytes());                              // EOF
  return out.array();
}

/** First style index a sheet's own XFs get. */
const FIRST_XF = 16;

function worksheet(sheet: XlsSheet, sst: Map<string, number>): Uint8Array {
  const out = new Bytes();
  record(out, 0x0809, new Bytes().u16(0x0600).u16(0x0010).u16(0x0dbb).u16(0x07cc).u32(0).u32(6));
  record(out, 0x000d, new Bytes().u16(1));                       // CALCMODE
  record(out, 0x000c, new Bytes().u16(100));                     // CALCCOUNT
  record(out, 0x000f, new Bytes().u16(1));                       // REFMODE
  record(out, 0x0011, new Bytes().u16(0));                       // ITERATION
  record(out, 0x0010, new Bytes().f64(0.001));                   // DELTA
  record(out, 0x005f, new Bytes().u16(1));                       // SAVERECALC
  record(out, 0x002a, new Bytes().u16(0));                       // PRINTHEADERS
  record(out, 0x002b, new Bytes().u16(0));                       // PRINTGRIDLINES
  record(out, 0x0082, new Bytes().u16(1));                       // GRIDSET
  record(out, 0x0080, new Bytes().u16(0).u16(0).u16(0).u16(0));  // GUTS
  record(out, 0x0225, new Bytes().u16(0).u16(255));              // DEFAULTROWHEIGHT
  record(out, 0x0081, new Bytes().u16(0x04c1));                  // WSBOOL
  record(out, 0x0055, new Bytes().u16(8));                       // DEFCOLWIDTH

  sheet.colWidths.forEach((w, c) =>
    record(out, 0x007d, new Bytes().u16(c).u16(c).u16(w).u16(15).u16(0).u16(0)));
  if (sheet.restWidth && sheet.colWidths.length < 256) {
    record(out, 0x007d, new Bytes().u16(sheet.colWidths.length).u16(255)
      .u16(sheet.restWidth).u16(15).u16(0).u16(0));
  }

  const cells = [...sheet.cells].sort((a, b) => a.r - b.r || a.c - b.c);
  const lastRow = Math.max(0, ...cells.map(c => c.r), ...Object.keys(sheet.rowHeights).map(Number));
  const lastCol = Math.max(0, ...cells.map(c => c.c));
  record(out, 0x0200, new Bytes().u32(0).u32(lastRow + 1).u16(0).u16(lastCol + 1).u16(0)); // DIMENSIONS

  const byRow = new Map<number, XlsCell[]>();
  for (const cell of cells) {
    if (!byRow.has(cell.r)) byRow.set(cell.r, []);
    byRow.get(cell.r)!.push(cell);
  }
  const rows = [...new Set([...byRow.keys(), ...Object.keys(sheet.rowHeights).map(Number)])].sort((a, b) => a - b);
  for (const r of rows) {
    const inRow = byRow.get(r) ?? [];
    const height = sheet.rowHeights[r];
    record(out, 0x0208, new Bytes().u16(r)
      .u16(inRow.length ? inRow[0].c : 0).u16(inRow.length ? inRow[inRow.length - 1].c + 1 : 0)
      .u16(height ?? 255).u16(0).u16(0)
      .u32(0x00000100 | (height !== undefined ? 0x40 : 0)));
  }
  for (const cell of cells) {
    const xf = FIRST_XF + cell.s;
    if (cell.v !== undefined && cell.v !== '') {
      record(out, 0x00fd, new Bytes().u16(cell.r).u16(cell.c).u16(xf).u32(sst.get(cell.v)!));
    } else {
      record(out, 0x0201, new Bytes().u16(cell.r).u16(cell.c).u16(xf));
    }
  }

  const frozen = (sheet.freezeRows ?? 0) > 0;
  record(out, 0x023e, new Bytes()
    .u16(0x02 | 0x04 | 0x10 | 0x20 | 0x80 | 0x200 | (frozen ? 0x08 | 0x100 : 0) | 0x400)
    .u16(0).u16(0).u16(64).u16(0).u16(0).u16(sheet.zoom ?? 0).u32(0));   // WINDOW2
  if (sheet.zoom) record(out, 0x00a0, new Bytes().u16(sheet.zoom).u16(100)); // SCL
  if (frozen) {
    const n = sheet.freezeRows!;
    record(out, 0x0041, new Bytes().u16(0).u16(n).u16(n).u16(0).u8(2).u8(0)); // PANE
    record(out, 0x001d, new Bytes().u8(2).u16(n).u16(0).u16(0).u16(1)
      .u16(n).u16(n).u8(0).u8(0));                                            // SELECTION
  } else {
    record(out, 0x001d, new Bytes().u8(3).u16(0).u16(0).u16(0).u16(1).u16(0).u16(0).u8(0).u8(0));
  }
  if (sheet.merges.length) {
    const m = new Bytes().u16(sheet.merges.length);
    for (const [r1, r2, c1, c2] of sheet.merges) m.u16(r1).u16(r2).u16(c1).u16(c2);
    record(out, 0x00e5, m);                                      // MERGEDCELLS
  }
  record(out, 0x000a, new Bytes());                              // EOF
  return out.array();
}

/** The workbook, as the bytes of an .xls file. */
export function writeXls(styles: XlsStyle[], sheets: XlsSheet[]): Uint8Array {
  // Shared strings, in first-use order.
  const sst = new Map<string, number>();
  let total = 0;
  for (const sheet of sheets) {
    for (const cell of sheet.cells) {
      if (cell.v === undefined || cell.v === '') continue;
      total++;
      if (!sst.has(cell.v)) sst.set(cell.v, sst.size);
    }
  }
  const strings = [...sst.keys()];
  const bodies = sheets.map(sheet => worksheet(sheet, sst));

  // The globals hold each sheet's offset, and their own length decides it:
  // written once to measure, then again with the offsets in place.
  const measure = globals(styles, sheets, strings, total, sheets.map(() => 0)).length;
  const offsets: number[] = [];
  let at = measure;
  for (const body of bodies) { offsets.push(at); at += body.length; }
  const head = globals(styles, sheets, strings, total, offsets);

  const stream = new Uint8Array(head.length + bodies.reduce((n, b) => n + b.length, 0));
  stream.set(head, 0);
  let pos = head.length;
  for (const body of bodies) { stream.set(body, pos); pos += body.length; }

  const CFB = (XLSX as unknown as { CFB: any }).CFB;
  const doc = CFB.utils.cfb_new();
  CFB.utils.cfb_add(doc, 'Workbook', stream);
  // The writer also adds a tiny placeholder entry of its own beside the
  // Workbook stream, as it does in every .xls this library writes; readers,
  // Excel included, ignore it.
  return new Uint8Array(CFB.write(doc, { fileType: 'cfb', type: 'array' }));
}
