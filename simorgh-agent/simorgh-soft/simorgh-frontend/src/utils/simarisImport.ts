// Reading a SIMARIS feeder list, to fill in MODULE NO.
//
// SIMARIS exports a feeder list per switchboard. One file can hold several —
// each is a title row, a blank line, a header row, then its rows, so the
// header is found rather than assumed to be line 1. Of its nine columns only
// three matter here:
//
//   Feeder name    what this app calls FEEDER NO.  (L01/A, L18A …)
//   Cubicle name   "CELL 1A-L01/A", "CELL 2A" …
//   Location       ".BA001", ".FA001" …
//
// MODULE NO. is the cubicle name with the word CELL removed, then the
// location appended:
//
//   CELL 1A-L01/A + .BA001  ->  "1A-L01/A .BA001"
//   CELL 2A       + .BA001  ->  "2A .BA001"
//
// Rows with no feeder name are not feeders — SIMARIS uses them for empty
// compartments (SPACE 3M) and for the device entries it appends after the
// feeder list (3WA, 3VA molded-case circuit breaker) — and are skipped.

export interface SimarisFeeder {
  /** Matched against the table's FEEDER NO. */
  feederNo: string;
  cubicleName: string;
  location: string;
  /** What goes into MODULE NO. */
  moduleNo: string;
  /** 1-based row in the source file, for reporting. */
  sourceRow: number;
}

export interface SimarisParseResult {
  feeders: SimarisFeeder[];
  /** Feeder names appearing more than once in the file itself. */
  duplicates: string[];
  /** How many switchboard sections the file held. */
  sections: number;
}

const HEADER_KEYS = ['feeder name', 'cubicle name', 'location'] as const;

/** The word CELL removed, the location appended. Exported so the rule can be
 *  checked on its own, since it is the whole point of the import. */
export function buildModuleNo(cubicleName: string, location: string): string {
  const base = String(cubicleName || '').replace(/^\s*CELL\s*/i, '').trim();
  const loc = String(location || '').trim();
  if (!base) return loc;
  if (!loc) return base;
  return `${base} ${loc}`;
}

/**
 * Parse a SIMARIS export that has already been read into rows (by SheetJS for
 * .xlsx, or a CSV reader). Header positions are read per section, because a
 * file with two switchboards has two header rows and nothing guarantees the
 * columns sit at the same index in both.
 */
export function parseSimarisRows(rows: string[][]): SimarisParseResult {
  const feeders: SimarisFeeder[] = [];
  let index: Record<string, number> | null = null;
  let sections = 0;

  rows.forEach((row, i) => {
    const cells = (row || []).map(c => String(c ?? '').trim());
    const lower = cells.map(c => c.toLowerCase());

    if (HEADER_KEYS.every(k => lower.includes(k))) {
      index = Object.fromEntries(HEADER_KEYS.map(k => [k, lower.indexOf(k)]));
      sections += 1;
      return;
    }
    if (!index) return;
    if (!cells.some(c => c)) { index = null; return; }   // blank line ends a section

    const at = (k: string) => {
      const col = index![k];
      return col !== undefined && col < cells.length ? cells[col] : '';
    };
    const feederNo = at('feeder name');
    if (!feederNo) return;                                // not a feeder row

    const cubicleName = at('cubicle name');
    const location = at('location');
    feeders.push({
      feederNo,
      cubicleName,
      location,
      moduleNo: buildModuleNo(cubicleName, location),
      sourceRow: i + 1,
    });
  });

  const seen = new Map<string, number>();
  for (const f of feeders) {
    const key = f.feederNo.toUpperCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);

  return { feeders, duplicates, sections };
}

export interface SimarisMatch {
  /** Rows that will be changed: the table row id and the new MODULE NO. */
  updates: { rowId: string; feederNo: string; moduleNo: string; previous: string }[];
  /** In the file and in the table, but MODULE NO. already holds that value. */
  unchanged: number;
  /** In the file, with no FEEDER NO. in the table to put it on. */
  onlyInSimaris: SimarisFeeder[];
  /** In the table, absent from the file — left alone, reported for information. */
  onlyInTable: string[];
  /** FEEDER NO. appearing on more than one table row: which value to take is
   *  ambiguous, so nothing is written for these until they are made unique. */
  duplicateInTable: string[];
  /** Feeder names repeated inside the SIMARIS file itself. */
  duplicateInSimaris: string[];
}

/**
 * Work out what a SIMARIS file would change, without changing anything.
 *
 * Matching is on FEEDER NO., case-insensitively and ignoring surrounding
 * space — SIMARIS writes " L18A" with a leading space in its own export.
 * A feeder that is in the table but not in the file is not a problem and is
 * only reported; a duplicate on either side is, because there is then no one
 * answer for which cubicle a feeder belongs to.
 */
export function matchSimarisToRows(
  parsed: SimarisParseResult,
  rows: { id: string; feederNo?: string; moduleNo?: string }[],
): SimarisMatch {
  const norm = (v: string | undefined) => String(v ?? '').trim().toUpperCase();

  const byFeeder = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = norm(r.feederNo);
    if (!key) continue;
    if (!byFeeder.has(key)) byFeeder.set(key, []);
    byFeeder.get(key)!.push(r);
  }

  const duplicateInTable = [...byFeeder.entries()]
    .filter(([, rs]) => rs.length > 1)
    .map(([k]) => k);

  const updates: SimarisMatch['updates'] = [];
  const onlyInSimaris: SimarisFeeder[] = [];
  const matched = new Set<string>();
  let unchanged = 0;

  for (const feeder of parsed.feeders) {
    const key = norm(feeder.feederNo);
    const candidates = byFeeder.get(key);
    if (!candidates || candidates.length === 0) { onlyInSimaris.push(feeder); continue; }
    matched.add(key);
    if (candidates.length > 1) continue;          // ambiguous — reported, not written
    const row = candidates[0];
    if (String(row.moduleNo ?? '') === feeder.moduleNo) { unchanged += 1; continue; }
    updates.push({
      rowId: row.id,
      feederNo: row.feederNo ?? feeder.feederNo,
      moduleNo: feeder.moduleNo,
      previous: String(row.moduleNo ?? ''),
    });
  }

  const onlyInTable = [...byFeeder.keys()].filter(k => !matched.has(k));

  return {
    updates,
    unchanged,
    onlyInSimaris,
    onlyInTable,
    duplicateInTable,
    duplicateInSimaris: parsed.duplicates,
  };
}
