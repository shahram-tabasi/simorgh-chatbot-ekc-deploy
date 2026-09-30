// src/utils/cad/header.ts
//
// The sheet header: the frame round the drawing, the zone references down its
// edges, the band of path texts across the top, and the title block in the
// corner.
//
// Every schematic in the world carries these four things, and they are not a
// decoration — they are how a drawing is referred to. "The contactor in 4/C"
// is meaningless without a zone grid; "issue B of 21-0417 sheet 3 of 12" is
// meaningless without a title block. A sheet that leaves this office without
// them is not a drawing yet, it is a picture of one.
//
// **On where the layout comes from.** The field names and the way the sheet is
// divided follow the published drawing standards — ISO 7200 for what a title
// block has to state, ISO 5457 for the grid reference system, IEC 61082 for
// how a circuit diagram is laid out in numbered paths. Those are conventions,
// and conventions are what make one office's drawing readable in another's.
// The arrangement here, the proportions, the wording and the code are our own,
// written from the standards and from what these sheets actually need. No
// other package's frame, macro, artwork or text has been copied or reproduced,
// and nothing here is derived from a competitor's file or handbook.
//
// It is geometry, like everything else on the sheet: plain shapes on the FRAME
// and TITLE layers. So it appears on screen, it goes out in the DXF as real
// lines a customer can edit, it prints, and any field in it can be retyped
// with the text tool — which is the point of a title block whose "drawn by"
// cell is empty until somebody signs it.

import { Anchor, Layer, Shape } from './shapes';
import { PRODUCT_AND_OWNER } from '../../branding';

/** Marks every shape the header put down, so it can be found and replaced. */
export const HEADER = 'SHEET-HEADER';

const marked = (s: Shape) => (s as { blockName?: string }).blockName === HEADER;

/** Is this shape part of a sheet header? */
export const isHeader = (s: Shape): boolean => marked(s);

/** Does this sheet already carry one? */
export const hasHeader = (shapes: Shape[]): boolean => shapes.some(marked);

/** The sheet without its header, so a fresh one can take its place. */
export const stripHeader = (shapes: Shape[]): Shape[] => shapes.filter(s => !marked(s));

/**
 * What the title block states.
 *
 * Every field is optional and an absent one leaves its cell ruled but empty,
 * which is deliberate: a printed sheet with an empty DRAWN box is a sheet
 * waiting for a signature, and that is a real state a drawing office is in.
 */
export interface HeaderFields {
  /** What this sheet is. The big line. */
  title?: string;
  /** The job it belongs to. */
  project?: string;
  /** Document number, however this office numbers them. */
  number?: string;
  /** Issue letter or number. */
  revision?: string;
  drawnBy?: string;
  checkedBy?: string;
  /** Written as given — no locale guessing about what a date looks like. */
  date?: string;
  /** A schematic is normally NTS; a layout is not. */
  scale?: string;
  /** Sheet size, as the paper is named. */
  size?: string;
  /** "3 / 12". */
  sheet?: string;
  /** Whose drawing this is. */
  owner?: string;
  /**
   * One line per column, written into the band under the top frame edge.
   *
   * This is the header in the sense a wiring diagram means it: over each
   * numbered path, what that path is *for* — "supply", "motor 1 start",
   * "alarm" — so the sheet can be read down a column without tracing a wire.
   */
  paths?: string[];
}

export interface HeaderStyle {
  /**
   * Millimetres per drawing unit, when the caller knows it.
   *
   * With it, the frame is built in real millimetres and comes out of the
   * plotter at the sizes a drawing standard actually names: 3.5 mm lettering
   * in the title block, 2.5 mm captions, a block 180 mm wide. Without it the
   * proportional fallback below is used, which is right in shape and only
   * accidentally right in size.
   */
  mmPerUnit?: number;
  /** Height of the smallest lettering, in drawing units. Overrides the above. */
  textSize?: number;
  /** Stroke width for the frame rules. */
  width?: number;
  /** How many paths the sheet is divided into across. */
  columns?: number;
  /** How many rows the zone grid has down the sides. */
  rows?: number;
  /** Rule the path band. Defaults to on when there are path texts to put in it. */
  pathBand?: boolean;
}

/** The captions, in the order they are read. Latin, as a drawing number is. */
const CAPTIONS = {
  project: 'PROJECT',
  number: 'DOCUMENT No.',
  revision: 'REV',
  drawnBy: 'DRAWN',
  checkedBy: 'CHECKED',
  date: 'DATE',
  scale: 'SCALE',
  size: 'SIZE',
  sheet: 'SHEET',
  owner: 'OWNER',
};

/** Ours unless the job says otherwise — see src/branding.ts. */
const SIGNATURE = PRODUCT_AND_OWNER;

/** Zone letters, skipping the two that are misread as digits. */
const ZONE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * The lettering height a sheet of this size gets. Everything sizes off it.
 *
 * 3.5 mm where the scale is known — the height a drawing standard names for a
 * title block, and the height a drawing office's eye is calibrated to. Where
 * it is not known, a fraction of the sheet, which keeps the shape right and
 * leaves the absolute size to luck.
 */
const unitOf = (width: number, height: number, style: HeaderStyle) =>
  style.textSize
  ?? (style.mmPerUnit ? 3.5 / style.mmPerUnit
                      : Math.max(2, Math.round(Math.min(width, height) / 44)));

/** How far the zone strip reaches in from the trimmed edge. */
const stripOf = (u: number) => u * 1.8;

/**
 * Where the title block lands, without drawing it.
 *
 * Asked twice: once to draw the thing, and once to find out what is already
 * sitting in that corner. A title block over a wire is the one way this
 * command can quietly damage a drawing, so it is worth being able to count.
 */
export function titleBlockArea(
  width: number, height: number, style: HeaderStyle = {},
): { x: number; y: number; w: number; h: number } | null {
  const u = unitOf(width, height, style);
  const strip = stripOf(u);
  if (!(width > 0) || !(height > 0) || width < strip * 6 || height < strip * 6) return null;
  const iw = width - 2 * strip, ih = height - 2 * strip;
  const h = u * 2.5 * 4;
  // 180 mm is the width a title block is drawn at, on every sheet from A4 up.
  // On a sheet narrower than that it runs the full width, which is what an A4
  // does too — the block is a fixed thing and the paper is what varies.
  const w = clamp(style.mmPerUnit ? 180 / style.mmPerUnit : u * 34, u * 20, iw);
  return { x: strip + iw - w, y: strip + ih - h, w, h };
}

/** The height of the path band, when there is one. */
const bandOf = (u: number, fields: HeaderFields, style: HeaderStyle) =>
  (style.pathBand ?? (fields.paths ?? []).some(p => p && p.trim() !== '')) ? u * 2.6 : 0;

/**
 * The parts of the sheet a drawing may occupy, largest first to try.
 *
 * Two of them, because the space a title block leaves is L-shaped and fitting
 * a drawing into an L is a worse idea than fitting it into the better of the
 * two rectangles the L is made of: everything **above** the block, full width,
 * or everything **beside** it, full height. A tall single line takes the
 * second; a wide layout takes the first. Which one is a question about the
 * drawing, so the caller picks.
 */
export function drawingAreas(
  width: number, height: number, fields: HeaderFields = {}, style: HeaderStyle = {},
): { x: number; y: number; w: number; h: number }[] {
  const tb = titleBlockArea(width, height, style);
  if (!tb) return [];
  const u = unitOf(width, height, style);
  const strip = stripOf(u);
  const pad = u * 0.8;
  const x = strip + pad, y = strip + bandOf(u, fields, style) + pad;
  const right = width - strip - pad, bottom = height - strip - pad;
  return [
    { x, y, w: right - x, h: tb.y - pad - y },
    { x, y, w: tb.x - pad - x, h: bottom - y },
  ].filter(a => a.w > u * 4 && a.h > u * 4);
}

/**
 * The header for a sheet of `width` × `height` drawing units.
 *
 * Sized off the sheet rather than off millimetres on purpose: the drawing is
 * in its own units and the plot scale is not decided until somebody picks a
 * paper, so a frame fixed in millimetres would be the wrong size on every
 * sheet but one. Proportions hold; absolute sizes do not.
 */
export function sheetHeader(
  width: number,
  height: number,
  fields: HeaderFields = {},
  style: HeaderStyle = {},
): Shape[] {
  const out: Shape[] = [];
  // Too small to carry a frame is not an error, it is a sheet that should not
  // have one — a symbol being edited on its own, for instance.
  if (!(width > 0) || !(height > 0)) return out;

  const u = unitOf(width, height, style);
  const strip = stripOf(u);
  if (width < strip * 6 || height < strip * 6) return out;

  const line = { layer: 'FRAME' as Layer, width: style.width ?? 1, blockName: HEADER };
  const thin = { ...line, width: (style.width ?? 1) * 0.6 };
  const ink = { layer: 'TITLE' as Layer, blockName: HEADER };

  const rule = (x1: number, y1: number, x2: number, y2: number, pen = line) =>
    out.push({ t: 'line', x1, y1, x2, y2, ...pen });
  const say = (
    x: number, y: number, s: string, size: number,
    anchor: Anchor = 'start', bold = false,
  ) => {
    if (!s) return;
    out.push({ t: 'text', x, y, s, size, anchor, bold, ...ink });
  };

  // ── Frame ────────────────────────────────────────────────────────────────
  // Two rectangles: the sheet's trimmed edge, and the drawing area inside it.
  // The gap between them is the strip the zone references live in.
  out.push({ t: 'rect', x: 0, y: 0, w: width, h: height, ...thin });
  const ix = strip, iy = strip, iw = width - 2 * strip, ih = height - 2 * strip;
  out.push({ t: 'rect', x: ix, y: iy, w: iw, h: ih, ...line });

  // ── Zone references ──────────────────────────────────────────────────────
  // Numbers across, letters down, on all four edges, so a reference can be
  // read from whichever corner the sheet happens to be folded to.
  // Zones about 50 mm apart, which is the pitch a grid reference is designed
  // around: close enough to point at one device, wide enough to be countable.
  const pitch = style.mmPerUnit ? 50 / style.mmPerUnit : u * 13;
  const columns = style.columns ?? clamp(Math.round(iw / pitch), 4, 24);
  const rows = style.rows ?? clamp(Math.round(ih / pitch), 3, 16);
  const pitchX = iw / columns;
  const pitchY = ih / rows;

  for (let c = 0; c < columns; c++) {
    const x0 = ix + c * pitchX;
    if (c > 0) {
      rule(x0, 0, x0, iy, thin);
      rule(x0, iy + ih, x0, height, thin);
    }
    const mid = x0 + pitchX / 2;
    say(mid, iy - u * 0.6, String(c + 1), u, 'middle');
    say(mid, iy + ih + u * 1.4, String(c + 1), u, 'middle');
  }
  for (let r = 0; r < rows; r++) {
    const y0 = iy + r * pitchY;
    if (r > 0) {
      rule(0, y0, ix, y0, thin);
      rule(ix + iw, y0, width, y0, thin);
    }
    const mid = y0 + pitchY / 2 + u * 0.4;
    const letter = ZONE_LETTERS[r % ZONE_LETTERS.length];
    say(ix - u, mid, letter, u, 'middle');
    say(ix + iw + u, mid, letter, u, 'middle');
  }

  // ── Path band ────────────────────────────────────────────────────────────
  // What each column is for, written once at the top so the sheet reads down.
  const paths = fields.paths ?? [];
  const bandH = bandOf(u, fields, style);
  if (bandH > 0) {
    rule(ix, iy + bandH, ix + iw, iy + bandH);
    for (let c = 1; c < columns; c++) rule(ix + c * pitchX, iy, ix + c * pitchX, iy + bandH, thin);
    for (let c = 0; c < columns; c++) {
      const value = (paths[c] ?? '').trim();
      // Clipped to the column rather than spilling into its neighbour: a path
      // text that runs over the next one describes neither.
      const fits = Math.max(1, Math.floor(pitchX / (u * 0.62)));
      const shown = value.length > fits ? `${value.slice(0, fits - 1)}…` : value;
      say(ix + c * pitchX + pitchX / 2, iy + bandH - u * 0.9, shown, u, 'middle');
    }
  }

  // ── Title block ──────────────────────────────────────────────────────────
  // Bottom right, where every drawing office looks first, and where it stays
  // visible when a big sheet is folded.
  const { x: tx, y: ty, w: tbW, h: tbH } = titleBlockArea(width, height, style)!;
  const rowH = tbH / 4;

  out.push({ t: 'rect', x: tx, y: ty, w: tbW, h: tbH, ...line });
  for (let r = 1; r < 4; r++) rule(tx, ty + r * rowH, tx + tbW, ty + r * rowH);

  /**
   * One field of the block: its caption above, its value below.
   *
   * The two are set close, because a title block cell is a tight space and a
   * caption that floats is a caption that could belong to either row. Close is
   * not touching, though: the value's ascenders have to clear the caption's
   * baseline or the cell reads as one smudged line.
   *
   * The title is the exception — it is set large, it fills the row on its own,
   * and a cell captioned TITLE holding something obviously a title is a word
   * spent saying nothing.
   */
  const cell = (
    x: number, y: number, w: number, caption: string, value: string,
    big = false,
  ) => {
    const pad = u * 0.45;
    const size = big ? u * 1.5 : u;
    const fits = Math.max(1, Math.floor((w - pad * 2) / (size * 0.62)));
    const shown = value.length > fits ? `${value.slice(0, fits - 1)}…` : value;
    if (big) {
      say(x + pad, y + rowH * 0.5 + size * 0.36, shown, size, 'start', true);
      return;
    }
    say(x + pad, y + u * 0.95, caption, u * 0.72);
    say(x + pad, y + rowH - u * 0.5, shown, size);
  };

  /** A row split into cells by their share of the width. */
  const split = (y: number, parts: [number, string, string][]) => {
    let x = tx;
    parts.forEach(([share, caption, value], i) => {
      const w = tbW * share;
      if (i > 0) rule(x, y, x, y + rowH, thin);
      cell(x, y, w, caption, value);
      x += w;
    });
  };

  cell(tx, ty, tbW, '', fields.title ?? '', true);
  split(ty + rowH, [
    [0.50, CAPTIONS.project, fields.project ?? ''],
    [0.32, CAPTIONS.number, fields.number ?? ''],
    [0.18, CAPTIONS.revision, fields.revision ?? ''],
  ]);
  split(ty + rowH * 2, [
    [0.34, CAPTIONS.drawnBy, fields.drawnBy ?? ''],
    [0.33, CAPTIONS.checkedBy, fields.checkedBy ?? ''],
    [0.33, CAPTIONS.date, fields.date ?? ''],
  ]);
  // The owner cell gets the widest share of the row: the three beside it hold
  // a word each, and this one holds a company's name, which is longer than a
  // company expects to see abbreviated on its own drawing.
  split(ty + rowH * 3, [
    [0.20, CAPTIONS.scale, fields.scale ?? 'NTS'],
    [0.16, CAPTIONS.size, fields.size ?? ''],
    [0.20, CAPTIONS.sheet, fields.sheet ?? ''],
    [0.44, CAPTIONS.owner, fields.owner ?? SIGNATURE],
  ]);

  return out;
}

/**
 * The sheet with a header on it, replacing any header already there.
 *
 * The header goes in front of the rest so it draws underneath: a frame that
 * sits over the geometry is a frame that hides a wire.
 */
export function withHeader(
  shapes: Shape[],
  width: number,
  height: number,
  fields?: HeaderFields,
  style?: HeaderStyle,
): Shape[] {
  return [...sheetHeader(width, height, fields, style), ...stripHeader(shapes)];
}
