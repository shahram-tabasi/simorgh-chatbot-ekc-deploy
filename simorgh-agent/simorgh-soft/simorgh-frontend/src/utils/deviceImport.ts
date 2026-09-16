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
  /** The colours this row carries, when the file carries any. */
  highlight?: RowHighlight;
}

/**
 * The cell fills of a sheet, `[rowIndex][columnIndex]`, as `#rrggbb` or ''.
 *
 * Indexed the same way as the grid, so a row of one is the same row of the
 * other. Built by the caller, which is the only place that has the worksheet
 * the styles live on.
 */
export type SheetFills = string[][];

/** Column index to its spreadsheet letter: 0 → A, 26 → AA. */
const colLetter = (c: number): string => {
  let out = '';
  for (let n = c; n >= 0; n = Math.floor(n / 26) - 1) out = String.fromCharCode(65 + (n % 26)) + out;
  return out;
};

/**
 * The fills of a worksheet, as `#rrggbb` per cell.
 *
 * Only solid fills with a colour of their own are read. A theme colour has no
 * rgb to read and a pure white one is what an uncoloured cell looks like, so
 * neither becomes a highlight — the table's own "no colour" is white.
 *
 * `sheet` is a SheetJS worksheet read with `cellStyles: true`; without that
 * option the styles are not parsed at all and every cell comes back plain.
 *
 * The two shapes are both looked at on purpose. A style written by this app
 * is `s.fill.fgColor`, but the same file read back comes out flattened —
 * xlsx-js-style's reader puts the fill's own fields straight on `s`, so a
 * sheet this app wrote would read as having no colour if only the written
 * shape were looked for.
 */
export function readFills(sheet: any, rows: number, cols: number): SheetFills {
  const out: SheetFills = [];
  for (let r = 0; r < rows; r++) {
    const line: string[] = [];
    for (let c = 0; c < cols; c++) {
      const cell = sheet?.[`${colLetter(c)}${r + 1}`];
      const fill = cell?.s?.fill ?? cell?.s;
      const rgb = String(fill?.fgColor?.rgb ?? '');
      const hex = /^[0-9A-Fa-f]{6,8}$/.test(rgb) ? rgb.slice(-6).toLowerCase() : '';
      line.push(hex && hex !== 'ffffff' ? `#${hex}` : '');
    }
    out.push(line);
  }
  return out;
}

/** A row's colours, in the two forms the table stores them. */
export interface RowHighlight {
  rowColor?: string;
  cellColors?: Record<string, string>;
}

/**
 * The colours of one sheet row, read as the table stores them.
 *
 * A row whose cells are all one colour is a coloured row; anything else is a
 * set of coloured cells. That is the inverse of how the table paints — the
 * row colour underneath, cell colours over it — so a colour that came out of
 * this table goes back into it looking the same.
 */
function rowHighlight(
  fills: string[], fieldOf: string[],
): RowHighlight {
  const seen: { field: string; color: string }[] = [];
  fieldOf.forEach((field, c) => {
    if (field) seen.push({ field, color: fills[c] ?? '' });
  });
  if (seen.length === 0) return {};
  const first = seen[0].color;
  if (first && seen.every(x => x.color === first)) return { rowColor: first };
  const cellColors: Record<string, string> = {};
  for (const x of seen) if (x.color) cellColors[x.field] = x.color;
  return Object.keys(cellColors).length > 0 ? { cellColors } : {};
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
  grid: unknown[][], columns: ImportColumn[], fills?: SheetFills,
): { rows: ParsedRow[]; matched: string[]; unknown: string[]; colored: boolean } {
  const index = columnIndex(columns);
  const header = (grid[0] ?? []).map(h => String(h ?? '').trim());
  const fieldOf = header.map(h => index.get(headerKey(h)) ?? '');

  const matched: string[] = [];
  const unknown: string[] = [];
  header.forEach((h, i) => {
    if (!h) return;
    if (fieldOf[i]) matched.push(h); else unknown.push(h);
  });

  // A file with no fill anywhere says nothing about colour, and a file that
  // says nothing cannot repaint the table. Only a file that actually carries
  // colour replaces what the table has.
  const colored = !!fills?.some((line, r) => r > 0 && line?.some(Boolean));

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
    if (any) {
      rows.push({
        values,
        sheetRow: r + 1,
        ...(colored ? { highlight: rowHighlight(fills?.[r] ?? [], fieldOf) } : {}),
      });
    }
  }
  return { rows, matched, unknown, colored };
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
  /** Rows whose colours the file changes. */
  recolored: number;
  /** True when the file carried any colour at all. */
  colored: boolean;
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
/** Two sets of colours, compared the way the table would draw them. */
const sameHighlight = (a: RowHighlight, b: RowHighlight): boolean =>
  (a.rowColor ?? '') === (b.rowColor ?? '')
  && JSON.stringify(Object.entries(a.cellColors ?? {}).sort())
     === JSON.stringify(Object.entries(b.cellColors ?? {}).sort());

/** The pseudo-field a colour change is listed under in the dialog. */
export const HIGHLIGHT_FIELD = '__highlight';

const describeHighlight = (h: RowHighlight): string => {
  if (h.rowColor) return h.rowColor;
  const n = Object.keys(h.cellColors ?? {}).length;
  return n > 0 ? `${n} cell${n === 1 ? '' : 's'}` : 'none';
};

export function planImport(
  grid: unknown[][], columns: ImportColumn[], current: DeviceTableRow[],
  equipmentId: string, fills?: SheetFills,
): ImportPlan {
  const { rows, matched, unknown, colored } = parseSheet(grid, columns, fills);

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

    // Colour. A file that carries colour carries all of it: a cell it leaves
    // white is a cell with no colour, so an old highlight goes rather than
    // surviving under a file that plainly does not have it.
    if (parsed.highlight) {
      const was: RowHighlight = {
        rowColor: base.rowColor,
        cellColors: base.cellColors,
      };
      if (!sameHighlight(was, parsed.highlight)) {
        changes.push({
          field: HIGHLIGHT_FIELD,
          from: describeHighlight(was),
          to: describeHighlight(parsed.highlight),
        });
        next.rowColor = parsed.highlight.rowColor;
        next.cellColors = parsed.highlight.cellColors;
      }
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
    recolored: plans.filter(p => p.changes.some(c => c.field === HIGHLIGHT_FIELD)).length,
    colored,
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
