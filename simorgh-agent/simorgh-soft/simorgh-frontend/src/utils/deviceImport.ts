// src/utils/deviceImport.ts
//
// Reading a Device Selection table back out of a spreadsheet.
//
// The bug this exists to end: the exporter wrote the table's own column
// headers, and the importer matched a hand-written list of guesses at what
// those headers might be. The two drifted, silently. `RATING POWER (kW/KVA)`
// is the header the export writes; the import looked for `RATING POWER` and
// `RATING POWER(KW OR KVA)` and neither is it, so every rating imported as
// empty and nobody was told. A file this app wrote could not be read back by
// this app.
//
// So the mapping is derived from the same column definitions the export uses,
// rather than written out a second time. A header matches its column when the
// two agree ignoring case, spaces and punctuation — which is what makes
// "FEEDER NO.", "Feeder No" and "feeder_no" one column and keeps them one
// column when somebody renames the header.
//
// Two things are deliberately never imported:
//
//   **The template.** It is assigned inside the table, by right-click or by
//   dropping one on the row, because a template is a reference to something
//   that has to exist — a name in a spreadsheet is not one.
//
//   **Anything the file does not have a column for.** A missing column leaves
//   the existing value alone rather than clearing it, so a file exported with
//   fewer columns does not quietly empty the rest of the table.

import { DeviceTableRow } from '../types/project';
import { codeCase } from './deviceCodes';

/** One column of the Device Selection table, as the table itself declares it. */
export interface ImportColumn {
  key: string;
  header: string;
  isTemplate?: boolean;
}

/** A header as it is compared: no case, no spaces, no punctuation. */
export const headerKey = (value: unknown): string =>
  String(value ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '');

/**
 * Spellings that are not the header but mean it.
 *
 * Only for what people and other tools actually write — an older export, a
 * SIMARIS sheet, a hand-typed column. Every one of these is a header this app
 * has itself written at some point, which is why they are worth keeping;
 * inventing more would be guessing at a file nobody has.
 */
const ALIASES: Record<string, string> = {
  RATINGPOWER: 'ratingPower',
  RATINGPOWERKW: 'ratingPower',
  RATINGPOWERKWORKVA: 'ratingPower',
  RATINGKW: 'ratingPower',
  POWER: 'ratingPower',
  FEEDERNUMBER: 'feederNo',
  FEEDER: 'feederNo',
  FLC: 'flc',
  FLCA: 'flc',
  NOMINALCURRENTA: 'flc',
  BUS: 'busSection',
  CABELSIZE: 'cableSize',      // the typo the app itself used to accept
  SFDHFD: 'sfdHfd',
  MODULENO: 'moduleNo',
  SAIZE: 'size',               // likewise
};

/** Header → row field, for one table's columns. */
export function columnIndex(columns: ImportColumn[]): Map<string, string> {
  const by = new Map<string, string>();
  for (const [alias, key] of Object.entries(ALIASES)) by.set(alias, key);
  // The table's own headers win over any alias of them.
  for (const col of columns) {
    if (col.isTemplate) continue;
    by.set(headerKey(col.header), col.key);
  }
  return by;
}

/** What one row of the file turned into. */
export interface ParsedRow {
  /** Only the fields the file actually had a column for. */
  values: Record<string, string>;
  /** 1-based row number in the sheet, for saying where something came from. */
  sheetRow: number;
}

/**
 * The rows of a sheet, as fields of this table.
 *
 * `grid` is the sheet as an array of arrays — the header row first. Read that
 * way rather than as objects so two columns with the same header cannot
 * silently collapse into one, and so a file whose header row is not the first
 * row can be handled by slicing before calling.
 */
export function parseSheet(
  grid: unknown[][], columns: ImportColumn[],
): { rows: ParsedRow[]; matched: string[]; unknown: string[] } {
  const index = columnIndex(columns);
  const header = (grid[0] ?? []).map(h => String(h ?? '').trim());
  const fieldOf = header.map(h => index.get(headerKey(h)) ?? '');

  const matched: string[] = [];
  const unknown: string[] = [];
  header.forEach((h, i) => {
    if (!h) return;
    if (fieldOf[i]) matched.push(h); else unknown.push(h);
  });

  const rows: ParsedRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const line = grid[r] ?? [];
    const values: Record<string, string> = {};
    let any = false;
    fieldOf.forEach((field, c) => {
      if (!field) return;
      const raw = line[c];
      const text = raw == null ? '' : String(raw).trim();
      // A column that exists in the file but is blank on this row is still a
      // column: it clears the field, which is how somebody deletes a value in
      // Excel and expects it gone here too.
      values[field] = text;
      if (text) any = true;
    });
    if (any) rows.push({ values, sheetRow: r + 1 });
  }
  return { rows, matched, unknown };
}

// ── What the file would do to the table ────────────────────────────────────

export interface FieldChange {
  field: string;
  from: string;
  to: string;
}

export interface RowPlan {
  kind: 'add' | 'change' | 'same';
  sheetRow: number;
  /** The row it lines up with, when it lines up with one. */
  rowId?: string;
  /** How it was matched, for the dialog to say so. */
  matchedBy: 'feeder' | 'position' | 'new';
  feederNo: string;
  changes: FieldChange[];
  /** The row as it will be after applying. */
  next: DeviceTableRow;
}

export interface ImportPlan {
  plans: RowPlan[];
  added: number;
  changed: number;
  unchanged: number;
  /** Rows in the table the file says nothing about. They are left alone. */
  untouched: number;
  matchedColumns: string[];
  unknownColumns: string[];
}

const CODE_FIELDS = new Set(['feederNo', 'sfdHfd']);

/** A value as it will be stored — codes folded, everything else as typed. */
const store = (field: string, value: string) =>
  (CODE_FIELDS.has(field) ? codeCase(value) : value);

/**
 * What importing this file would do, without doing it.
 *
 * Rows are matched on FEEDER NO. first, because that is the one thing about a
 * feeder that survives being re-ordered in a spreadsheet, and only then by
 * position. A file whose feeders are all new adds rows — which is the whole
 * point of importing into an empty table, and why a table with no rows is not
 * a special case here.
 */
export function planImport(
  grid: unknown[][], columns: ImportColumn[], current: DeviceTableRow[],
  equipmentId: string,
): ImportPlan {
  const { rows, matched, unknown } = parseSheet(grid, columns);

  const byFeeder = new Map<string, DeviceTableRow>();
  for (const row of current) {
    const key = codeCase(row.feederNo);
    if (key && !byFeeder.has(key)) byFeeder.set(key, row);
  }

  const used = new Set<string>();
  const plans: RowPlan[] = [];

  rows.forEach((parsed, i) => {
    const feederNo = codeCase(parsed.values.feederNo ?? '');
    let existing = feederNo ? byFeeder.get(feederNo) : undefined;
    let matchedBy: RowPlan['matchedBy'] = existing ? 'feeder' : 'new';
    // No feeder number to go on: fall back to the row in the same place, but
    // only if it has not already been claimed by a feeder match.
    if (!existing && !feederNo && current[i] && !used.has(current[i].id)) {
      existing = current[i];
      matchedBy = 'position';
    }
    if (existing) used.add(existing.id);

    const base: DeviceTableRow = existing ?? {
      id: `device-${Date.now()}-${i}`,
      rowNumber: current.length + plans.filter(p => p.kind === 'add').length + 1,
      templateId: '', templateName: '',
      busSection: '', feederNo: '', wiringType: '', ratingPower: '', flc: '',
      equipmentId,
    };

    const changes: FieldChange[] = [];
    const next = { ...base } as DeviceTableRow & Record<string, unknown>;
    for (const [field, value] of Object.entries(parsed.values)) {
      const to = store(field, value);
      const from = String((base as unknown as Record<string, unknown>)[field] ?? '');
      if (from === to) continue;
      changes.push({ field, from, to });
      next[field] = to;
    }

    plans.push({
      kind: existing ? (changes.length > 0 ? 'change' : 'same') : 'add',
      sheetRow: parsed.sheetRow,
      rowId: existing?.id,
      matchedBy,
      feederNo: feederNo || String(parsed.values.feederNo ?? ''),
      changes,
      next: next as DeviceTableRow,
    });
  });

  return {
    plans,
    added: plans.filter(p => p.kind === 'add').length,
    changed: plans.filter(p => p.kind === 'change').length,
    unchanged: plans.filter(p => p.kind === 'same').length,
    untouched: current.filter(r => !used.has(r.id)).length,
    matchedColumns: matched,
    unknownColumns: unknown,
  };
}

/**
 * The table after a plan is applied.
 *
 * Rows the file did not mention keep their place and their values: an import
 * is a merge, not a replacement. Rows it adds go on the end, and the row
 * numbers are renumbered once at the end so they read 1..n whatever order the
 * file was in.
 */
export function applyPlan(plan: ImportPlan, current: DeviceTableRow[]): DeviceTableRow[] {
  const replacement = new Map<string, DeviceTableRow>();
  const added: DeviceTableRow[] = [];
  for (const p of plan.plans) {
    if (p.kind === 'add') added.push(p.next);
    else if (p.kind === 'change' && p.rowId) replacement.set(p.rowId, p.next);
  }
  return [...current.map(r => replacement.get(r.id) ?? r), ...added]
    .map((r, i) => (r.rowNumber === i + 1 ? r : { ...r, rowNumber: i + 1 }));
}
