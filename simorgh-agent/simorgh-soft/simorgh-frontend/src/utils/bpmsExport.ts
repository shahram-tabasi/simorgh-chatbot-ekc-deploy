// src/utils/bpmsExport.ts
//
// BPMS export — the sheet BPMS takes in, laid out exactly as the .xls EPLAN
// used to produce for it (the "D.L" sheet for LV, "D.M" for MV):
//
//   row 1   "Switchgear name:    <name>                         Date:    <m/d/yyyy>"
//           merged across A–T
//   row 2   empty
//   row 3   the headings
//   row 4…  one row per part
//
//   NO. | BUS | Line |  Lable | Type | Power | Nominal Current (A) | Position |
//   Size | Tag | Feeder description | Cable size | Order number | Designation |
//   Specification | Part description |  Manufacturer | Qty | Part Placement |
//   EKC CODE
//
// The headings are spelled as EPLAN spells them, leading spaces and line
// break included, because BPMS reads them. LV and MV have the same twenty
// columns; a MV cell simply has nothing under Position and Size. Every value
// is text. The left-hand block comes from Device Selection (one device row =
// one line), the right-hand block from the parts on that line's template; a
// line with several parts repeats across that many rows.
//
// The workbook itself — fonts, borders, fills, widths — is written by
// utils/xlsWriter.ts; `bpmsXlsSheet` below says what goes where.
import { ProjectData, DeviceTableRow, TemplateItem } from '../types/project';
import {
  LV_TEMPLATE_PROPERTIES, MV_TEMPLATE_PROPERTIES, getEplanixValue, stripLocaleTags,
} from './tierEquipmentMatrix';
import { LAYOUT_OF, TIERS } from './tiers';
import { LINE, type XlsSheet, type XlsStyle, type XlsCell } from './xlsWriter';

/** The voltage levels this report is drawn for. */
export type BpmsTier = 'LV' | 'MV';

export const BPMS_HEADERS = [
  'NO.',
  'BUS',
  'Line',
  ' Lable',
  'Type',
  'Power',
  'Nominal Current\n(A)',
  'Position',
  'Size',
  'Tag',
  'Feeder description',
  'Cable size',
  'Order number',
  'Designation',
  'Specification',
  'Part description',
  ' Manufacturer',
  'Qty',
  'Part Placement',
  'EKC CODE',
];

/** Index of the first part column — everything left of it describes the line. */
export const BPMS_FIRST_PART_COL = 12;

/**
 * Where a part sits in the drawing, when nothing says otherwise.
 *
 * EPLAN's location for a part on the single line. Every part has one and
 * almost every part has this one, so the column is filled rather than left
 * for somebody to type the same thing down a page — a part that carries its
 * own placement keeps it.
 */
export const DEFAULT_PART_PLACEMENT = '=SLD+SLD';

/**
 * The pushbutton every SFD feeder carries, which is on no template.
 *
 * It is not a part of the cell, it is a part of the door, and the office has
 * always added it by hand to the BPMS sheet of every SFD line. It is the same
 * part every time, so it is added here instead.
 */
const START_STOP_PART = {
  label: 'Start/Stop',
  partNumber: 'Start/Stop/3SU1200-0FB10-0AA0',
  quantity: 1,
  fullData: {
    OrderNumber: '3SU1200-0FB10-0AA0',
    TypeNumber: '101-SH11-AA034',
    Designation1: 'Start/Stop',
    Designation2: '22 mm Round Plastic Black Pushbutton Raised Momentary '
      + 'Contact Type With Holder',
    Designation3: 'Pushbutton , 22 mm¶Black',
    Manufacturer: 'Siemens',
  },
};

/** True for a line the office marks SFD — the ones that carry the pushbutton. */
const isSfd = (row: DeviceTableRow): boolean =>
  /^\s*SFD\b/i.test(String(row.sfdHfd ?? ''));

/** Everything a part says about itself, as one string to search. */
const partText = (part: any): string => {
  const d = part?.fullData ?? {};
  return [part?.label, part?.partNumber, d.OrderNumber, d.TypeNumber, d.Designation1,
    d.Designation2, d.Designation3, d.Description]
    .map(v => stripLocaleTags(v)).join(' | ');
};

/**
 * A Siemens 3SU part (pushbutton, lamp, selector) already on the line.
 *
 * A project that came from BPMS may carry one the engineer put there; the
 * line then gets no second one — one per line is the rule.
 */
const has3su = (parts: any[]): boolean => parts.some(p => /\b3SU/i.test(partText(p)));

/**
 * What a GIS cell carries that is not ordered with it.
 *
 * The 3AH4 breaker, the current and voltage transformers, the capacitive
 * voltage indicator and the two- and three-position disconnectors all come
 * inside the GIS panel from its maker, so they stay off its BPMS sheet. A part
 * is known by the template slot it sits in, or by what it says it is.
 */
const GIS_BUILT_IN_SLOTS = new Set(['CT RATING', 'COREBALANCE CT', 'PT RATING', 'VOLTAGE INDICATOR']);
function isGisBuiltIn(slot: string, part: any): boolean {
  if (GIS_BUILT_IN_SLOTS.has(slot.trim().toUpperCase())) return true;
  const t = partText(part);
  return /\b3AH4/i.test(t)
    || /current\s*transformer|core[\s-]*balance/i.test(t)
    || /(voltage|potential)\s*transformer/i.test(t)
    || /capacitive[^|]*(voltage|indicat)|voltage\s*(detecting|presence)\s*(system|indicat)/i.test(t)
    || /\b(2|3|two|three)[\s-]*pos(ition)?s?\b[^|]*discon/i.test(t);
}

/** Rows above the table, and the row the headings are on. */
export const BPMS_HEADER_ROW = 2;

const text = (v: any): string => (v == null ? '' : String(v));

// Every part on a template, in the order the properties are laid out on the
// Create Template screen (so two exports of the same project always agree).
// Properties the tier list doesn't name are appended afterwards, alphabetically.
export function templatePartsInOrder(
  template: TemplateItem | undefined,
  properties: string[] = LV_TEMPLATE_PROPERTIES,
  /** Parts to leave out, by the slot they sit in and the part itself. */
  skip?: (slot: string, part: any) => boolean,
): any[] {
  if (!template) return [];
  const props = (template.properties ?? {}) as Record<string, any>;
  const named = properties.filter(p => props[p]);
  const extra = Object.keys(props)
    .filter(k => k !== '__displayNames' && k !== '__locked' && !properties.includes(k))
    .sort();

  const out: any[] = [];
  for (const key of [...named, ...extra]) {
    const parts = props[key]?.parts;
    if (Array.isArray(parts)) out.push(...(skip ? parts.filter(p => !skip(key, p)) : parts));
  }
  return out;
}

// The seven part columns for one part. Every text field goes through
// stripLocaleTags, so EPLAN's "en_US@…@" runs never reach the sheet.
// `Description` falls back to Designation 3 — the EPLAN record carries no
// separate description field, and Designation 3 is what the Create Template
// screen shows as the part's rating.
function partColumns(part: any): string[] {
  const d = part?.fullData ?? {};
  return [
    getEplanixValue(d),
    stripLocaleTags(d.Designation2),
    stripLocaleTags(d.Designation1),
    stripLocaleTags(d.Description ?? d.Designation3),
    stripLocaleTags(d.Manufacturer),
    text(part?.quantity ?? 1),
    // Part Placement: whatever the part says it is, and where it says
    // nothing, the one every part on a single line has.
    stripLocaleTags(part?.partPlacement ?? d.PartPlacement) || DEFAULT_PART_PLACEMENT,
    stripLocaleTags(d.TypeNumber),
  ];
}

/** How many part columns there are — used to pad a line that has no parts. */
const PART_COLS = 8;

// The eleven line columns for one device row (the NO. column is added by the
// caller, which numbers rows sequentially down the sheet). Tag and Feeder
// description are written the way EPLAN writes them — the tag and an empty
// second line, the description over three lines — since that is what BPMS
// has always been given.
function lineColumns(row: DeviceTableRow): string[] {
  const description = text(row.description).split(/\r?\n/);
  while (description.length < 3) description.push('');
  return [
    text(row.busSection),
    text(row.feederNo),
    text(row.sfdHfd),
    text(row.wiringType),
    text(row.ratingPower),
    text(row.flc),
    text(row.moduleNo),
    text(row.size),
    `${text(row.tag)}\n`,
    description.join('\n'),
    text(row.cableSize),
  ];
}

/** The template property order each tier's parts are read in. */
const PROPERTIES: Record<BpmsTier, string[]> = {
  LV: LV_TEMPLATE_PROPERTIES,
  MV: MV_TEMPLATE_PROPERTIES,
};

export interface BpmsMeta {
  /** Revision the report was taken from, e.g. "2". */
  revisionNumber?: string;
  /** Overrides "now" in tests. */
  generatedAt?: Date;
  /** Which voltage level's sheet to draw. LV when not said. */
  tier?: BpmsTier;
  /**
   * The one switchgear to report on.
   *
   * The report is taken for a switchgear, not for a project: a BPMS sheet is
   * read and checked against one panel's own drawing set, and a workbook of
   * every switchgear in the project is not what anybody asked for. Left out,
   * every switchgear of the tier is drawn, which is what a caller that has
   * nothing selected can still do.
   */
  equipmentId?: string;
}

export interface CellSpan { s: { r: number; c: number }; e: { r: number; c: number } }

export interface BpmsSheet {
  /** Which layout this sheet was drawn with. */
  tier: BpmsTier;
  /** Equipment name, used as the sheet name and in the header block. */
  name: string;
  rows: (string | number)[][];
  merges: CellSpan[];
  /** 0-based index of the header row inside `rows`. */
  headerRow: number;
  /** Device rows on this switchgear. */
  lineCount: number;
  /** Table rows produced for them (one per part). */
  partRowCount: number;
}

// Build one sheet per LV equipment. Equipment with no device rows still gets a
// sheet, so nothing silently disappears from the report.
export function buildBpmsSheets(data: ProjectData, meta: BpmsMeta = {}): BpmsSheet[] {
  const tier: BpmsTier = meta.tier ?? 'LV';
  // GIS switchgears are reported with MV and OTHER with LV — they carry those
  // tiers' columns (LAYOUT_OF) — each with its own group's templates.
  const templates = new Map(TIERS.filter(t => LAYOUT_OF[t] === tier)
    .flatMap(t => data.templates?.[t] ?? []).map(t => [t.id, t]));
  const equipments = (data.equipments ?? [])
    .filter(e => LAYOUT_OF[e.type] === tier)
    .filter(e => !meta.equipmentId || e.id === meta.equipmentId);
  const when = meta.generatedAt ?? new Date();
  const date = `${when.getMonth() + 1}/${when.getDate()}/${when.getFullYear()}`;

  return equipments.map(eq => {
    const body: (string | number)[][] = [];
    let no = 1;
    for (const row of eq.devices ?? []) {
      const line = lineColumns(row);
      const onTemplate = templatePartsInOrder(
        row.templateId ? templates.get(row.templateId) : undefined, PROPERTIES[tier],
        eq.type === 'GIS' ? isGisBuiltIn : undefined);
      const parts = [
        ...onTemplate,
        // The door's pushbutton, on every SFD line and on no template — unless
        // the line already has its 3SU part.
        ...(tier === 'LV' && isSfd(row) && !has3su(onTemplate) ? [START_STOP_PART] : []),
      ];
      if (parts.length === 0) {
        // A line without parts is still a line — keep it, with the part
        // columns empty, rather than dropping it from the report.
        body.push([String(no++), ...line, ...new Array(PART_COLS).fill('')]);
        continue;
      }
      for (const part of parts) {
        body.push([String(no++), ...line, ...partColumns(part)]);
      }
    }

    const lineCount = (eq.devices ?? []).length;
    // The title EPLAN writes, spaces and all.
    const title = `Switchgear name:    ${eq.name}${' '.repeat(25)}Date:    ${date}${' '.repeat(12)}`;
    const rows: (string | number)[][] = [[title], [], [...BPMS_HEADERS], ...body];
    const merges: CellSpan[] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: BPMS_HEADERS.length - 1 } }];

    return {
      tier,
      name: eq.name,
      rows,
      merges,
      headerRow: BPMS_HEADER_ROW,
      lineCount,
      partRowCount: body.length,
    };
  });
}

// Excel limits sheet names to 31 characters and forbids : \ / ? * [ ].
// Duplicates get a numeric suffix so two equipments named alike both survive.
export function sheetName(name: string, taken: Set<string>): string {
  const base = (name || 'Switchgear').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Switchgear';
  if (!taken.has(base)) { taken.add(base); return base; }
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
    if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
  }
  return base;
}

// ─── The .xls, as EPLAN laid it out ──────────────────────────────────────────
// Every number below is read off the .xls files BPMS was given (widths in
// 1/256 of a character, heights in twips, colours from Excel's palette):
// Arial 10; a bold title with a double rule under it; bold headings on
// lavender (46); centred, wrapped, thin-bordered cells, the part block on
// white; the top three rows frozen. The table ends at column T: EPLAN's files
// had a gold column U after it, which the software reading this sheet takes
// for data, so it is left out.

/** Sheet names EPLAN used. */
export const BPMS_SHEET_NAME: Record<BpmsTier, string> = { LV: 'D.L', MV: 'D.M' };

const WIDTHS = [
  1316, 1462, 1462, 1865, 1792, 2486, 2669, 2157, 1901, 4864, 7131, 3584,
  7387, 7241, 7241, 7241, 4022, 1609, 4608, 5229,
];

const ALL: [number, number, number, number] = [LINE.thin, LINE.thin, LINE.thin, LINE.thin];
const NO_RIGHT: [number, number, number, number] = [LINE.thin, LINE.none, LINE.thin, LINE.thin];

export const BPMS_XLS_STYLES: XlsStyle[] = [
  /* 0 title, A1 */ { bold: true, h: 1, v: 1, border: [LINE.thin, 0, 0, LINE.double], fill: 9, text: true },
  /* 1 title    */ { bold: true, h: 1, v: 1, border: [0, 0, 0, LINE.double], fill: 9, text: true },
  /* 2 gap row  */ { bold: true, fontColor: 10, h: 1, v: 1, fill: 9, text: true },
  /* 3 heading, wrapped */ { bold: true, fontColor: 8, h: 2, v: 1, wrap: true, border: NO_RIGHT, fill: 46, text: true },
  /* 4 heading  */ { bold: true, fontColor: 8, h: 2, v: 1, border: ALL, fill: 46, text: true },
  /* 5 cell, boxed */ { h: 2, v: 1, wrap: true, border: ALL, text: true },
  /* 6 line cell */ { h: 2, v: 1, wrap: true, border: NO_RIGHT },
  /* 7 part cell */ { h: 2, v: 1, wrap: true, border: ALL, fill: 9, text: true },
];

/** The BPMS sheet as the .xls writer takes it. */
export function bpmsXlsSheet(sheet: BpmsSheet): XlsSheet {
  const cols = BPMS_HEADERS.length;      // 20: A–T, and nothing after T
  const cells: XlsCell[] = [];
  const put = (r: number, c: number, v: string | number | undefined, s: number) =>
    cells.push({ r, c, v: v === undefined || v === '' ? undefined : String(v), s });

  // Title across A–T.
  for (let c = 0; c < cols; c++) put(0, c, c === 0 ? sheet.rows[0][0] : undefined, c === 0 ? 0 : 1);
  for (let c = 0; c < cols; c++) put(1, c, undefined, 2);

  const wrappedHeading = new Set([0, 1, 2, 4, 5, 6, 7, 8, 9, 10]);
  for (let c = 0; c < cols; c++) put(2, c, BPMS_HEADERS[c], wrappedHeading.has(c) ? 3 : 4);

  const rowHeights: Record<number, number> = { 0: 600, 1: 180, 2: 1185 };
  for (let r = BPMS_HEADER_ROW + 1; r < sheet.rows.length; r++) {
    const values = sheet.rows[r];
    for (let c = 0; c < cols; c++) {
      const style = c >= BPMS_FIRST_PART_COL ? 7 : (c === 0 || c === 3) ? 5 : 6;
      put(r, c, values[c], style);
    }
    rowHeights[r] = 1020;
  }

  return {
    name: BPMS_SHEET_NAME[sheet.tier],
    cells,
    colWidths: WIDTHS,
    restWidth: 2925,
    rowHeights,
    merges: sheet.merges.map(m => [m.s.r, m.e.r, m.s.c, m.e.c] as [number, number, number, number]),
    freezeRows: 3,
    zoom: 85,
    pageBreakPreview: true,
  };
}
