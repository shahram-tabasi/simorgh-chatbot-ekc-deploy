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
// LV only: MV/HV equipment is not part of this report.
import { ProjectData, DeviceTableRow, TemplateItem } from '../types/project';
import { LV_TEMPLATE_PROPERTIES, getEplanixValue, stripLocaleTags } from './tierEquipmentMatrix';

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
  'Type number',
];

// Column widths, in characters, matching the header list above.
export const BPMS_COL_WIDTHS = [
  5, 8, 9, 9, 9, 10, 13, 10, 8, 14, 26, 12, 20, 30, 22, 26, 16, 6, 24,
];

/** Index of the first part column — everything left of it describes the line. */
export const BPMS_FIRST_PART_COL = 12;

// Rows in the block above the table, and where the table starts.
const TITLE_ROW = 0;
const INFO_FIRST_ROW = 1;
const INFO_ROWS = 6;
export const BPMS_HEADER_ROW = INFO_FIRST_ROW + INFO_ROWS + 1; // one blank row between

const text = (v: any): string => (v == null ? '' : String(v));

// Every part on a template, in the order the properties are laid out on the
// Create Template screen (so two exports of the same project always agree).
// Properties the tier list doesn't name are appended afterwards, alphabetically.
export function templatePartsInOrder(template: TemplateItem | undefined): any[] {
  if (!template) return [];
  const props = (template.properties ?? {}) as Record<string, any>;
  const named = LV_TEMPLATE_PROPERTIES.filter(p => props[p]);
  const extra = Object.keys(props)
    .filter(k => k !== '__displayNames' && k !== '__locked' && !LV_TEMPLATE_PROPERTIES.includes(k))
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
    stripLocaleTags(d.TypeNumber),
  ];
}

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

export interface BpmsMeta {
  /** Revision the report was taken from, e.g. "2". */
  revisionNumber?: string;
  /** Overrides "now" in tests. */
  generatedAt?: Date;
}

export interface CellSpan { s: { r: number; c: number }; e: { r: number; c: number } }

export interface BpmsSheet {
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
  const templates = new Map((data.templates?.LV ?? []).map(t => [t.id, t]));
  const equipments = (data.equipments ?? []).filter(e => e.type === 'LV');
  const generated = (meta.generatedAt ?? new Date()).toLocaleString();

  return equipments.map(eq => {
    const body: (string | number)[][] = [];
    let no = 1;
    for (const row of eq.devices ?? []) {
      const line = lineColumns(row);
      const parts = templatePartsInOrder(row.templateId ? templates.get(row.templateId) : undefined);
      if (parts.length === 0) {
        // A line without parts is still a line — keep it, with the part
        // columns empty, rather than dropping it from the report.
        body.push([no++, ...line, '', '', '', '', '', '', '']);
        continue;
      }
      for (const part of parts) {
        body.push([no++, ...line, ...partColumns(part)]);
      }
    }

    const lineCount = (eq.devices ?? []).length;
    const info: [string, string, string, string][] = [
      ['Project',          text(data.projectName),   'Switchgear',    eq.name],
      ['Project ID (PID)', text(data.projectId),     'Voltage level', 'LV'],
      ['Project No. (OE)', text(data.projectNumber), 'Lines',         String(lineCount)],
      ['Client',           text(data.client),        'Rows',          String(body.length)],
      ['Location',         text(data.location),      'Standard',      text(data.standard)],
      ['Revision',         meta.revisionNumber ? `REV ${meta.revisionNumber}` : '', 'Generated', generated],
    ];

    const rows: (string | number)[][] = [
      ['SIMORGH DESIGN SUITE — BPMS REPORT'],
      ...info.map(([l1, v1, l2, v2]) => {
        const r: (string | number)[] = new Array(BPMS_HEADERS.length).fill('');
        r[0] = l1; r[1] = v1; r[7] = l2; r[8] = v2;
        return r;
      }),
      [],
      [...BPMS_HEADERS],
      ...body,
    ];

    // Title across the sheet, and each info value across the columns after
    // its label, so long project names aren't clipped by the next cell.
    const merges: CellSpan[] = [
      { s: { r: TITLE_ROW, c: 0 }, e: { r: TITLE_ROW, c: BPMS_HEADERS.length - 1 } },
    ];
    for (let i = 0; i < INFO_ROWS; i++) {
      const r = INFO_FIRST_ROW + i;
      merges.push({ s: { r, c: 1 }, e: { r, c: 6 } });
      merges.push({ s: { r, c: 8 }, e: { r, c: BPMS_HEADERS.length - 1 } });
    }

    return {
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
  const cols = BPMS_HEADERS.length;
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
    for (const labelCol of [0, 7]) {
      at(r, labelCol).s = {
        font: { bold: true, sz: 10, color: { rgb: 'FF334155' } },
        fill: { patternType: 'solid', fgColor: { rgb: 'FFF1F5F9' } },
        alignment: { horizontal: 'left', vertical: 'center' },
        border: boxed,
      };
    }
    for (const valueCol of [1, 8]) {
      const span = valueCol === 1 ? [1, 6] : [8, cols - 1];
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
      const isLineBlock = c < BPMS_FIRST_PART_COL;
      const fill = isLineBlock ? LINE_TINT : (banded ? BAND : 'FFFFFFFF');
      at(r, c).s = {
        font: { sz: 10 },
        fill: { patternType: 'solid', fgColor: { rgb: fill } },
        alignment: {
          horizontal: c === 0 ? 'center' : 'left',
          vertical: 'top',
          wrapText: c === 10 || c === 13 || c === 15,
        },
        border: boxed,
      };
    }
  }

  ws['!cols'] = BPMS_COL_WIDTHS.map(wch => ({ wch }));
  ws['!merges'] = sheet.merges;
  ws['!rows'] = [{ hpt: 26 }];
  ws['!autofilter'] = {
    ref: `${cellRef(sheet.headerRow, 0)}:${cellRef(sheet.rows.length - 1, cols - 1)}`,
  };
}
