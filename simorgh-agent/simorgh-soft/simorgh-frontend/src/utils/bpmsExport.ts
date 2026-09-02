// src/utils/bpmsExport.ts
//
// BPMS export — the workbook that used to be typed up by hand for every LV
// switchgear (see the "D.L" sample sheet). One sheet per LV equipment:
//
//   Switchgear name: <equipment>
//   <blank>
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
import { LV_TEMPLATE_PROPERTIES, getEplanixValue } from './tierEquipmentMatrix';

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

// The seven part columns for one part. `Description` falls back to
// Designation 3 — the EPLAN record carries no separate description field, and
// Designation 3 is what the Create Template screen shows as the part's rating.
function partColumns(part: any): string[] {
  const d = part?.fullData ?? {};
  return [
    getEplanixValue(d),
    text(d.Designation2),
    text(d.Designation1),
    text(d.Description ?? d.Designation3),
    text(d.Manufacturer),
    text(part?.quantity ?? 1),
    text(d.TypeNumber),
  ];
}

// The twelve line columns for one device row (the NO. column is added by the
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

export interface BpmsSheet {
  /** Equipment name, used as the sheet name and in the title row. */
  name: string;
  rows: (string | number)[][];
  /** Device rows on this switchgear, for the summary shown in the UI. */
  lineCount: number;
}

// Build one sheet per LV equipment. Equipment with no device rows still gets a
// sheet, so nothing silently disappears from the report.
export function buildBpmsSheets(data: ProjectData): BpmsSheet[] {
  const templates = new Map((data.templates?.LV ?? []).map(t => [t.id, t]));
  const equipments = (data.equipments ?? []).filter(e => e.type === 'LV');

  return equipments.map(eq => {
    const rows: (string | number)[][] = [
      [`Switchgear name:    ${eq.name}`],
      [],
      [...BPMS_HEADERS],
    ];

    let no = 1;
    for (const row of eq.devices ?? []) {
      const line = lineColumns(row);
      const parts = templatePartsInOrder(row.templateId ? templates.get(row.templateId) : undefined);
      if (parts.length === 0) {
        // A line without parts is still a line — keep it, with the part
        // columns empty, rather than dropping it from the report.
        rows.push([no++, ...line, '', '', '', '', '', '', '']);
        continue;
      }
      for (const part of parts) {
        rows.push([no++, ...line, ...partColumns(part)]);
      }
    }

    return { name: eq.name, rows, lineCount: (eq.devices ?? []).length };
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
