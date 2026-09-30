// src/utils/xlsWriter.ts
//
// A small writer for Excel 97-2003 workbooks (.xls, BIFF8), with formatting.
//
// BPMS takes the BPMS sheet as the .xls EPLAN used to produce — its fonts,
// borders, fills, widths, row heights, merged title and frozen heading
// included. The spreadsheet library in this app writes .xls, but writes it
// plain: every style is dropped. This writes the records that sheet needs and
// nothing else — fonts, cell formats, shared strings, column widths, row
// heights, text and blank cells, merged cells, frozen panes and zoom, with the
// row index and page setup Excel writes — and packs them into the compound
// file an .xls is.
//
// Cells are text (or blank): every value in the BPMS sheet is text, and that
// is all this has to write.

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
  /**
   * Open in Page Break Preview. The EPLAN files are saved that way, and BPMS
   * reads a sheet only when it is.
   */
  pageBreakPreview?: boolean;
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
// Text is written 8-bit whenever every character of it fits in a byte, and
// 16-bit only when it does not — which is what Excel does. The format allows
// 16-bit throughout, but BPMS reads the file as Excel writes it: given the
// sheet name and the cell texts in 16-bit, it turned the file down until
// Excel had opened and saved it again (compared on the same export, before
// and after Ctrl+S — the text encoding was the difference).
const isNarrow = (s: string) => { for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0xff) return false; return true; };
function textBytes(out: Bytes, s: string, narrow: boolean) {
  if (narrow) for (let i = 0; i < s.length; i++) out.u8(s.charCodeAt(i));
  else out.utf16(s);
}

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
    // 8-bit when every character fits, as Excel writes it (see textBytes).
    const narrow = isNarrow(s);
    const flag = narrow ? 0x00 : 0x01;
    const size = narrow ? 1 : 2;
    current.u16(s.length).u8(flag);
    let i = 0;
    while (i < s.length) {
      const fit = Math.floor(room() / size);
      if (fit === 0) { current = new Bytes().u8(flag); chunks.push(current); continue; }
      const n = Math.min(fit, s.length - i);
      textBytes(current, s.slice(i, i + n), narrow);
      i += n;
      if (i < s.length) { current = new Bytes().u8(flag); chunks.push(current); }
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
    const narrow = isNarrow(name);
    const sheetRecord = new Bytes().u32(sheetOffsets[i]).u16(0).u8(name.length).u8(narrow ? 0x00 : 0x01);
    textBytes(sheetRecord, name, narrow);
    record(out, 0x0085, sheetRecord);                           // BOUNDSHEET
  });
  record(out, 0x008c, new Bytes().u16(1).u16(1));                // COUNTRY
  sstRecords(out, strings, total);
  record(out, 0x000a, new Bytes());                              // EOF
  return out.array();
}

/** First style index a sheet's own XFs get. */
const FIRST_XF = 16;

/**
 * A worksheet, laid out the way Excel lays one out.
 *
 * Excel itself reads a sheet without most of what follows, but stricter
 * readers — BPMS among them — do not: they want the row index (INDEX, and a
 * DBCELL after every block of up to 32 rows) and the page setup Excel always
 * writes. Without them BPMS turned the file down until it had been opened in
 * Excel and saved again. `base` is where the sheet starts in the Workbook
 * stream; INDEX holds absolute positions.
 */
function worksheet(sheet: XlsSheet, sst: Map<string, number>, base: number): Uint8Array {
  const head = new Bytes();
  record(head, 0x0809, new Bytes().u16(0x0600).u16(0x0010).u16(0x4f5a).u16(0x07cd).u32(0x000200c9).u32(0x0806));

  const cells = [...sheet.cells].sort((a, b) => a.r - b.r || a.c - b.c);
  const byRow = new Map<number, XlsCell[]>();
  for (const cell of cells) {
    if (!byRow.has(cell.r)) byRow.set(cell.r, []);
    byRow.get(cell.r)!.push(cell);
  }
  const rows = [...new Set([...byRow.keys(), ...Object.keys(sheet.rowHeights).map(Number)])].sort((a, b) => a - b);
  const blocks: number[][] = [];
  for (let i = 0; i < rows.length; i += 32) blocks.push(rows.slice(i, i + 32));

  const mid = new Bytes();
  record(mid, 0x000d, new Bytes().u16(1));                       // CALCMODE
  record(mid, 0x000c, new Bytes().u16(100));                     // CALCCOUNT
  record(mid, 0x000f, new Bytes().u16(1));                       // REFMODE
  record(mid, 0x0011, new Bytes().u16(0));                       // ITERATION
  record(mid, 0x0010, new Bytes().f64(0.001));                   // DELTA
  record(mid, 0x005f, new Bytes().u16(1));                       // SAVERECALC
  record(mid, 0x002a, new Bytes().u16(0));                       // PRINTHEADERS
  record(mid, 0x002b, new Bytes().u16(0));                       // PRINTGRIDLINES
  record(mid, 0x0082, new Bytes().u16(1));                       // GRIDSET
  record(mid, 0x0080, new Bytes().u16(0).u16(0).u16(0).u16(0));  // GUTS
  record(mid, 0x0225, new Bytes().u16(0).u16(255));              // DEFAULTROWHEIGHT
  record(mid, 0x0081, new Bytes().u16(0x04c1));                  // WSBOOL
  record(mid, 0x0014, new Bytes());                              // HEADER
  record(mid, 0x0015, new Bytes());                              // FOOTER
  record(mid, 0x0083, new Bytes().u16(1));                       // HCENTER
  record(mid, 0x0084, new Bytes().u16(0));                       // VCENTER
  for (const id of [0x0026, 0x0027, 0x0028, 0x0029]) {
    record(mid, id, new Bytes().f64(0.25));                      // LEFT/RIGHT/TOP/BOTTOMMARGIN
  }
  // SETUP: A4, 70 %, landscape, 600 dpi, header and footer 0.25" — as EPLAN's.
  record(mid, 0x00a1, new Bytes().u16(9).u16(70).u16(1).u16(1).u16(1).u16(0)
    .u16(600).u16(600).f64(0.25).f64(0.25).u16(1));

  const indexLength = 4 + 16 + 4 * blocks.length;
  const bodyStart = base + head.length + indexLength + mid.length;
  const body = new Bytes();
  const at = () => bodyStart + body.length;

  const defColWidthAt = at();
  record(body, 0x0055, new Bytes().u16(8));                      // DEFCOLWIDTH
  sheet.colWidths.forEach((w, c) =>
    record(body, 0x007d, new Bytes().u16(c).u16(c).u16(w).u16(15).u16(0).u16(0)));
  if (sheet.restWidth && sheet.colWidths.length < 256) {
    record(body, 0x007d, new Bytes().u16(sheet.colWidths.length).u16(255)
      .u16(sheet.restWidth).u16(15).u16(0).u16(0));
  }

  // Folded, not spread: a big project has more cells than a call has room for.
  const lastRow = rows.reduce((m, r) => Math.max(m, r), 0);
  const lastCol = cells.reduce((m, c) => Math.max(m, c.c), 0);
  record(body, 0x0200, new Bytes().u32(0).u32(lastRow + 1).u16(0).u16(lastCol + 1).u16(0)); // DIMENSIONS

  const dbCells: number[] = [];
  for (const block of blocks) {
    const rowAt: number[] = [];
    for (const r of block) {
      const inRow = byRow.get(r) ?? [];
      const height = sheet.rowHeights[r];
      rowAt.push(at());
      record(body, 0x0208, new Bytes().u16(r)
        .u16(inRow.length ? inRow[0].c : 0).u16(inRow.length ? inRow[inRow.length - 1].c + 1 : 0)
        .u16(height ?? 255).u16(0).u16(0)
        .u32(0x00000100 | (height !== undefined ? 0x40 : 0)));  // ROW
    }
    // Each row's first cell, the first measured from the second ROW record
    // and the rest from the row before — as DBCELL counts them.
    const offsets: number[] = [];
    let from = rowAt.length > 1 ? rowAt[1] : at();
    for (const r of block) {
      const inRow = byRow.get(r) ?? [];
      if (inRow.length === 0) { offsets.push(0); continue; }
      const first = at();
      offsets.push(first - from);
      from = first;
      for (const cell of inRow) {
        const xf = FIRST_XF + cell.s;
        if (cell.v !== undefined && cell.v !== '') {
          record(body, 0x00fd, new Bytes().u16(cell.r).u16(cell.c).u16(xf).u32(sst.get(cell.v)!)); // LABELSST
        } else {
          record(body, 0x0201, new Bytes().u16(cell.r).u16(cell.c).u16(xf));                        // BLANK
        }
      }
    }
    const dbCellAt = at();
    dbCells.push(dbCellAt);
    const db = new Bytes().u32(dbCellAt - rowAt[0]);
    offsets.forEach(o => db.u16(o));
    record(body, 0x00d7, db);                                    // DBCELL
  }

  const index = new Bytes().u32(0).u32(rows.length ? rows[0] : 0).u32(rows.length ? lastRow + 1 : 0)
    .u32(defColWidthAt);
  dbCells.forEach(p => index.u32(p));
  const out = new Bytes();
  out.bytes(head.array());
  record(out, 0x020b, index);                                    // INDEX
  out.bytes(mid.array());
  out.bytes(body.array());

  const frozen = (sheet.freezeRows ?? 0) > 0;
  record(out, 0x023e, new Bytes()
    .u16(0x02 | 0x04 | 0x10 | 0x20 | 0x80 | 0x200 | (frozen ? 0x08 | 0x100 : 0) | 0x400
      | (sheet.pageBreakPreview ? 0x800 : 0))
    .u16(0).u16(0).u16(64).u16(0)
    .u16(sheet.pageBreakPreview ? sheet.zoom ?? 0 : 0).u16(sheet.zoom ?? 0).u32(0)); // WINDOW2
  if (sheet.zoom) record(out, 0x00a0, new Bytes().u16(sheet.zoom).u16(100)); // SCL
  if (frozen) {
    const n = sheet.freezeRows!;
    record(out, 0x0041, new Bytes().u16(0).u16(n).u16(n).u16(0).u8(2).u8(0)); // PANE
    record(out, 0x001d, new Bytes().u8(3).u16(0).u16(0).u16(0).u16(1)
      .u16(0).u16(0).u8(0).u8(0));                                            // SELECTION, top
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
  // The globals hold each sheet's offset, and their own length decides it:
  // written once to measure, then again with the offsets in place. A sheet's
  // length does not depend on where it starts, only its INDEX does.
  const measure = globals(styles, sheets, strings, total, sheets.map(() => 0)).length;
  const offsets: number[] = [];
  let at = measure;
  for (const sheet of sheets) { offsets.push(at); at += worksheet(sheet, sst, 0).length; }
  const head = globals(styles, sheets, strings, total, offsets);
  const bodies = sheets.map((sheet, i) => worksheet(sheet, sst, offsets[i]));

  // Excel never keeps the Workbook stream in the compound file's mini stream:
  // one shorter than 4096 bytes is padded out to it.
  const length = head.length + bodies.reduce((n, b) => n + b.length, 0);
  const stream = new Uint8Array(Math.max(length, 4096));
  stream.set(head, 0);
  let pos = head.length;
  for (const body of bodies) { stream.set(body, pos); pos += body.length; }
  return compoundFile(stream);
}

// ── Compound file ────────────────────────────────────────────────────────────

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const NOSTREAM = 0xffffffff;
/** Excel's class id, 00020820-0000-0000-C000-000000000046, as stored. */
const EXCEL_CLSID = [0x20, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0, 0, 0, 0, 0, 0, 0x46];

/**
 * The compound file (version 3, 512-byte sectors) around the Workbook stream,
 * as Excel writes it: a root entry carrying Excel's class id and the one
 * stream, kept in ordinary sectors. The library's writer added a placeholder
 * entry of its own and left the root without a class id.
 */
function compoundFile(workbook: Uint8Array): Uint8Array {
  const SECTOR = 512;
  const dataSectors = Math.ceil(workbook.length / SECTOR);
  const dirSectors = 1;
  let fatSectors = 1;
  let difatSectors = 0;
  for (;;) {
    const total = dataSectors + dirSectors + fatSectors + difatSectors;
    const needFat = Math.ceil(total / 128);
    const needDifat = needFat > 109 ? Math.ceil((needFat - 109) / 127) : 0;
    if (needFat === fatSectors && needDifat === difatSectors) break;
    fatSectors = needFat;
    difatSectors = needDifat;
  }
  const dirStart = dataSectors;
  const fatStart = dirStart + dirSectors;
  const difatStart = fatStart + fatSectors;
  const sectors = difatStart + difatSectors;

  const file = new Uint8Array(SECTOR * (1 + sectors));
  const view = new DataView(file.buffer);
  const sectorAt = (n: number) => SECTOR * (1 + n);

  // Header.
  file.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  view.setUint16(0x18, 0x003e, true);          // minor version
  view.setUint16(0x1a, 0x0003, true);          // major version 3
  view.setUint16(0x1c, 0xfffe, true);          // little-endian
  view.setUint16(0x1e, 9, true);               // 512-byte sectors
  view.setUint16(0x20, 6, true);               // 64-byte mini sectors
  view.setUint32(0x2c, fatSectors, true);
  view.setUint32(0x30, dirStart, true);
  view.setUint32(0x38, 4096, true);            // mini stream cutoff
  view.setUint32(0x3c, ENDOFCHAIN, true);      // no mini FAT
  view.setUint32(0x40, 0, true);
  view.setUint32(0x44, difatSectors ? difatStart : ENDOFCHAIN, true);
  view.setUint32(0x48, difatSectors, true);
  for (let i = 0; i < 109; i++) {
    view.setUint32(0x4c + 4 * i, i < fatSectors ? fatStart + i : FREESECT, true);
  }

  // The rest of the FAT sector list, 127 to a DIFAT sector and a link on.
  for (let d = 0; d < difatSectors; d++) {
    const base = sectorAt(difatStart + d);
    for (let k = 0; k < 127; k++) {
      const i = 109 + d * 127 + k;
      view.setUint32(base + 4 * k, i < fatSectors ? fatStart + i : FREESECT, true);
    }
    view.setUint32(base + 508, d + 1 < difatSectors ? difatStart + d + 1 : ENDOFCHAIN, true);
  }

  // FAT.
  const fat = new Uint32Array(fatSectors * 128).fill(FREESECT);
  for (let i = 0; i < dataSectors; i++) fat[i] = i + 1 < dataSectors ? i + 1 : ENDOFCHAIN;
  fat[dirStart] = ENDOFCHAIN;
  for (let i = 0; i < fatSectors; i++) fat[fatStart + i] = FATSECT;
  for (let i = 0; i < difatSectors; i++) fat[difatStart + i] = DIFSECT;
  fat.forEach((v, i) => view.setUint32(sectorAt(fatStart) + 4 * i, v, true));

  // Directory: the root, then the Workbook stream as its only child.
  const entry = (n: number, name: string, type: number, child: number, start: number, size: number, clsid?: number[]) => {
    const at = sectorAt(dirStart) + 128 * n;
    for (let i = 0; i < name.length; i++) view.setUint16(at + 2 * i, name.charCodeAt(i), true);
    view.setUint16(at + 0x40, 2 * (name.length + 1), true);
    file[at + 0x42] = type;
    file[at + 0x43] = 1;                        // black
    view.setUint32(at + 0x44, NOSTREAM, true);  // left sibling
    view.setUint32(at + 0x48, NOSTREAM, true);  // right sibling
    view.setUint32(at + 0x4c, child, true);
    if (clsid) file.set(clsid, at + 0x50);
    view.setUint32(at + 0x74, start, true);
    view.setUint32(at + 0x78, size, true);
  };
  entry(0, 'Root Entry', 5, 1, ENDOFCHAIN, 0, EXCEL_CLSID);
  entry(1, 'Workbook', 2, NOSTREAM, 0, workbook.length);
  for (const n of [2, 3]) {
    const at = sectorAt(dirStart) + 128 * n;
    view.setUint32(at + 0x44, NOSTREAM, true);
    view.setUint32(at + 0x48, NOSTREAM, true);
    view.setUint32(at + 0x4c, NOSTREAM, true);
  }

  file.set(workbook, sectorAt(0));
  return file;
}
