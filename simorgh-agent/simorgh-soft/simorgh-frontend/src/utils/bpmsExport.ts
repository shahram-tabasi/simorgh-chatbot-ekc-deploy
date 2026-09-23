// src/utils/bpmsExport.ts
//
// BPMS export — the workbook that used to be typed up by hand for every LV
// switchgear (see the "D.L" sample sheet). One sheet per LV equipment:
//
//   a title bar, then a block naming the project and the switchgear,
//   then the table:
//
//   NO. | BUS | Line | Lable | Type | Power | Nominal Current (A) | Position |
//   Size | Tag | Feeder description | Cable size |
//   Order number | Designation 2 | Designation 1 | Description | Manufacturer |
//   Qty | Type number
//
// The left-hand block comes from Device Selection (one device row = one line),
// the right-hand block from the parts on that line's template in Create
// Template. A line with several parts repeats across that many rows — one row
// per part, the line columns repeated — exactly like the hand-made sheet.
//
// MV switchgears get the same sheet without the two columns that mean nothing
// to them: a MV cell has no module position and no module size, those being
// the LV modular frame's own. Everything else is the same report, so it is the
// same code with two layouts rather than a second one that drifts.
import { ProjectData, DeviceTableRow, TemplateItem } from '../types/project';
import { COPYRIGHT_SHORT, PRODUCT_NAME } from '../branding';
import {
  LV_TEMPLATE_PROPERTIES, MV_TEMPLATE_PROPERTIES, getEplanixValue, stripLocaleTags,
} from './tierEquipmentMatrix';
import { LAYOUT_OF, TIERS } from './tiers';

/** The voltage levels this report is drawn for. */
export type BpmsTier = 'LV' | 'MV';

export const BPMS_HEADERS = [
  'NO.',
  'BUS',
  'Line',
  'Lable',
  'Type',
  'Power',
  'Nominal Current (A)',
  'Position',
  'Size',
  'Tag',
  'Feeder description',
  'Cable size',
  'Order number',
  'Designation 2',
  'Designation 1',
  'Description',
  'Manufacturer',
  'Qty',
  'Part Placement',
  'Type number',
];

// Column widths, in characters, matching the header list above.
export const BPMS_COL_WIDTHS = [
  5, 8, 9, 9, 9, 10, 13, 10, 8, 14, 26, 12, 20, 30, 22, 26, 16, 6, 12, 24,
];

/** Index of the first part column — everything left of it describes the line. */
export const BPMS_FIRST_PART_COL = 12;

/** MV: the LV sheet without Position and Size, which are the LV frame's own. */
export const BPMS_MV_HEADERS = [
  'NO.', 'BUS', 'Line', 'Lable', 'Type', 'Power', 'Nominal Current (A)',
  'Tag', 'Feeder description', 'Cable size',
  'Order number', 'Designation 2', 'Designation 1', 'Description',
  'Manufacturer', 'Qty', 'Part Placement', 'Type number',
];

export const BPMS_MV_COL_WIDTHS = [
  5, 8, 9, 9, 9, 10, 13, 14, 26, 12, 20, 30, 22, 26, 16, 6, 12, 24,
];

export const BPMS_MV_FIRST_PART_COL = 10;

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

interface BpmsLayout {
  headers: string[];
  widths: number[];
  firstPartCol: number;
  /** The template property order this tier's parts are read in. */
  properties: string[];
  /** Columns whose text is long enough to want wrapping. */
  wrapCols: number[];
  /** The line columns, left of the part block. */
  line: (row: DeviceTableRow) => string[];
}

// Rows in the block above the table, and where the table starts.
const TITLE_ROW = 0;
const INFO_FIRST_ROW = 1;
const INFO_ROWS = 6;
/** Column the right-hand label of the project block sits in. */
const INFO_RIGHT_LABEL = 7;
export const BPMS_HEADER_ROW = INFO_FIRST_ROW + INFO_ROWS + 1; // one blank row between

const text = (v: any): string => (v == null ? '' : String(v));

// Every part on a template, in the order the properties are laid out on the
// Create Template screen (so two exports of the same project always agree).
// Properties the tier list doesn't name are appended afterwards, alphabetically.
export function templatePartsInOrder(
  template: TemplateItem | undefined,
  properties: string[] = LV_TEMPLATE_PROPERTIES,
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
    if (Array.isArray(parts)) out.push(...parts);
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
// caller, which numbers rows sequentially down the sheet).
function lineColumns(row: DeviceTableRow): string[] {
  return [
    text(row.busSection),
    text(row.feederNo),
    text(row.sfdHfd),
    text(row.wiringType),
    text(row.ratingPower),
    text(row.flc),
    text(row.moduleNo),
    text(row.size),
    text(row.tag),
    text(row.description),
    text(row.cableSize),
  ];
}

/** The same line, without the two columns a MV cell has no use for. */
function mvLineColumns(row: DeviceTableRow): string[] {
  const lv = lineColumns(row);
  return [...lv.slice(0, 6), ...lv.slice(8)];
}

const LAYOUTS: Record<BpmsTier, BpmsLayout> = {
  LV: {
    headers: BPMS_HEADERS,
    widths: BPMS_COL_WIDTHS,
    firstPartCol: BPMS_FIRST_PART_COL,
    properties: LV_TEMPLATE_PROPERTIES,
    wrapCols: [10, 13, 15],
    line: lineColumns,
  },
  MV: {
    headers: BPMS_MV_HEADERS,
    widths: BPMS_MV_COL_WIDTHS,
    firstPartCol: BPMS_MV_FIRST_PART_COL,
    properties: MV_TEMPLATE_PROPERTIES,
    wrapCols: [8, 11, 13],
    line: mvLineColumns,
  },
};

export const bpmsLayout = (tier: BpmsTier): BpmsLayout => LAYOUTS[tier] ?? LAYOUTS.LV;

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
  const layout = bpmsLayout(tier);
  // GIS switchgears are reported with MV and OTHER with LV — they carry those
  // tiers' columns (LAYOUT_OF) — each with its own group's templates.
  const templates = new Map(TIERS.filter(t => LAYOUT_OF[t] === tier)
    .flatMap(t => data.templates?.[t] ?? []).map(t => [t.id, t]));
  const equipments = (data.equipments ?? [])
    .filter(e => LAYOUT_OF[e.type] === tier)
    .filter(e => !meta.equipmentId || e.id === meta.equipmentId);
  const generated = (meta.generatedAt ?? new Date()).toLocaleString();

  return equipments.map(eq => {
    const body: (string | number)[][] = [];
    let no = 1;
    for (const row of eq.devices ?? []) {
      const line = layout.line(row);
      const parts = [
        ...templatePartsInOrder(
          row.templateId ? templates.get(row.templateId) : undefined, layout.properties),
        // The door's pushbutton, on every SFD line and on no template.
        ...(tier === 'LV' && isSfd(row) ? [START_STOP_PART] : []),
      ];
      if (parts.length === 0) {
        // A line without parts is still a line — keep it, with the part
        // columns empty, rather than dropping it from the report.
        body.push([no++, ...line, ...new Array(PART_COLS).fill('')]);
        continue;
      }
      for (const part of parts) {
        body.push([no++, ...line, ...partColumns(part)]);
      }
    }

    const lineCount = (eq.devices ?? []).length;
    const info: [string, string, string, string][] = [
      ['Project',          text(data.projectName),   'Switchgear',    eq.name],
      ['Project ID (PID)', text(data.projectId),     'Voltage level', tier],
      ['Project No. (OE)', text(data.projectNumber), 'Lines',         String(lineCount)],
      ['Client',           text(data.client),        'Rows',          String(body.length)],
      ['Location',         text(data.location),      'Standard',      text(data.standard)],
      ['Revision',         meta.revisionNumber ? `REV ${meta.revisionNumber}` : '', 'Generated', generated],
    ];

    // A sheet that leaves the building says whose it is.
    const signature: (string | number)[] = new Array(layout.headers.length).fill('');
    signature[0] = COPYRIGHT_SHORT;

    const rows: (string | number)[][] = [
      [`${PRODUCT_NAME.toUpperCase()} — BPMS REPORT`],
      ...info.map(([l1, v1, l2, v2]) => {
        const r: (string | number)[] = new Array(layout.headers.length).fill('');
        r[0] = l1; r[1] = v1; r[INFO_RIGHT_LABEL] = l2; r[INFO_RIGHT_LABEL + 1] = v2;
        return r;
      }),
      [],
      [...layout.headers],
      ...body,
      [],
      signature,
    ];

    // Title across the sheet, and each info value across the columns after
    // its label, so long project names aren't clipped by the next cell.
    const merges: CellSpan[] = [
      { s: { r: TITLE_ROW, c: 0 }, e: { r: TITLE_ROW, c: layout.headers.length - 1 } },
    ];
    for (let i = 0; i < INFO_ROWS; i++) {
      const r = INFO_FIRST_ROW + i;
      merges.push({ s: { r, c: 1 }, e: { r, c: INFO_RIGHT_LABEL - 1 } });
      merges.push({ s: { r, c: INFO_RIGHT_LABEL + 1 }, e: { r, c: layout.headers.length - 1 } });
    }

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

// ─── Styling ─────────────────────────────────────────────────────────────────
// Applied to the worksheet object after it is built, so the sheet reads like a
// report rather than a data dump: a title bar, a labelled header block, a
// coloured table head, banded rows, and the line block tinted apart from the
// part block.
const TEAL = 'FF0F766E';
const TEAL_DARK = 'FF115E59';
const LINE_TINT = 'FFEFF6FF';
const BAND = 'FFF8FAFC';
const BORDER = 'FFCBD5E1';

const thin = { style: 'thin', color: { rgb: BORDER } };
const boxed = { top: thin, bottom: thin, left: thin, right: thin };

const colName = (c: number): string => {
  let s = '';
  for (let n = c; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
};
export const cellRef = (r: number, c: number): string => `${colName(c)}${r + 1}`;

// Applies the look to a worksheet built from one BpmsSheet. `ws` is a SheetJS
// worksheet; styles ride along on each cell's `s` property (xlsx-js-style).
export function styleBpmsSheet(ws: any, sheet: BpmsSheet): void {
  const layout = bpmsLayout(sheet.tier ?? 'LV');
  const cols = layout.headers.length;
  const at = (r: number, c: number) => {
    const ref = cellRef(r, c);
    if (!ws[ref]) ws[ref] = { t: 's', v: '' };
    return ws[ref];
  };

  // Title bar
  for (let c = 0; c < cols; c++) {
    at(TITLE_ROW, c).s = {
      font: { bold: true, sz: 14, color: { rgb: 'FFFFFFFF' } },
      fill: { patternType: 'solid', fgColor: { rgb: TEAL_DARK } },
      alignment: { horizontal: 'center', vertical: 'center' },
    };
  }

  // Project / switchgear block
  for (let i = 0; i < INFO_ROWS; i++) {
    const r = INFO_FIRST_ROW + i;
    for (const labelCol of [0, INFO_RIGHT_LABEL]) {
      at(r, labelCol).s = {
        font: { bold: true, sz: 10, color: { rgb: 'FF334155' } },
        fill: { patternType: 'solid', fgColor: { rgb: 'FFF1F5F9' } },
        alignment: { horizontal: 'left', vertical: 'center' },
        border: boxed,
      };
    }
    for (const valueCol of [1, INFO_RIGHT_LABEL + 1]) {
      const span = valueCol === 1
        ? [1, INFO_RIGHT_LABEL - 1]
        : [INFO_RIGHT_LABEL + 1, cols - 1];
      for (let c = span[0]; c <= span[1]; c++) {
        at(r, c).s = {
          font: { sz: 10, color: { rgb: 'FF0F172A' } },
          alignment: { horizontal: 'left', vertical: 'center' },
          border: boxed,
        };
      }
    }
  }

  // Table head
  for (let c = 0; c < cols; c++) {
    at(sheet.headerRow, c).s = {
      font: { bold: true, sz: 10, color: { rgb: 'FFFFFFFF' } },
      fill: { patternType: 'solid', fgColor: { rgb: TEAL } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      border: boxed,
    };
  }

  // Body — the line block tinted, the part block plain, every other row banded.
  for (let r = sheet.headerRow + 1; r < sheet.rows.length; r++) {
    const banded = (r - sheet.headerRow) % 2 === 0;
    for (let c = 0; c < cols; c++) {
      const isLineBlock = c < layout.firstPartCol;
      const fill = isLineBlock ? LINE_TINT : (banded ? BAND : 'FFFFFFFF');
      at(r, c).s = {
        font: { sz: 10 },
        fill: { patternType: 'solid', fgColor: { rgb: fill } },
        alignment: {
          horizontal: c === 0 ? 'center' : 'left',
          vertical: 'top',
          wrapText: layout.wrapCols.includes(c),
        },
        border: boxed,
      };
    }
  }

  ws['!cols'] = layout.widths.map(wch => ({ wch }));
  ws['!merges'] = sheet.merges;
  ws['!rows'] = [{ hpt: 26 }];
  ws['!autofilter'] = {
    ref: `${cellRef(sheet.headerRow, 0)}:${cellRef(sheet.rows.length - 1, cols - 1)}`,
  };
}
