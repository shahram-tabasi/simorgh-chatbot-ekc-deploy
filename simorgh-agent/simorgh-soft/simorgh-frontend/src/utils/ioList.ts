// src/utils/ioList.ts
//
// Reading an I/O list.
//
// Every PLC panel starts as a spreadsheet somebody else wrote: an address, a
// tag, a description, and — if you are lucky — which card and which terminal.
// Drawing the panel from it is a week of moving the same four symbols down a
// page and typing the same four numbers beside them, and it is a week spent
// copying, which is to say a week in which the drawing can disagree with the
// list.
//
// So the list is read rather than retyped. What this file does is turn
// whatever arrangement of columns arrived into points this app understands;
// `cad/ioPages.ts` turns those into pages.
//
// The column names are matched loosely on purpose. Nobody is going to rename
// their headings to suit us, and the same column is called ADDRESS, Address,
// I/O Address, ADDR, آدرس and PLC ADDRESS in five lists from five customers.
// What is not guessed is the *meaning*: an address that cannot be read as an
// address is reported, not assumed.

/** What one point on a card is, and what hangs off it. */
export interface IoPoint {
  /** As written in the list — `I0.0`, `%Q1.3`, `IW64`. */
  address: string;
  /** Digital in, digital out, analogue in, analogue out. */
  kind: 'DI' | 'DO' | 'AI' | 'AO';
  /** The field device's designation — `-S11`, `-H4`. */
  tag: string;
  /** What it does, in the list's own words. */
  description: string;
  /** The card this point is on — `-A1`. */
  card: string;
  /** The terminal strip and terminal it lands on — `-X1`, `5`. */
  strip: string;
  terminal: string;
  /** Which library symbol to draw for the field device, where the list says. */
  symbol: string;
  /** Which row of the file this came from, so a complaint can name it. */
  row: number;
}

export interface ReadResult {
  points: IoPoint[];
  /** Rows that could not be read, and why — shown, never silently dropped. */
  skipped: { row: number; why: string; text: string }[];
  /** Which column each field was taken from, so the user can check. */
  columns: Record<string, string>;
}

const clean = (v: unknown) => String(v ?? '').trim();
const key = (v: unknown) => clean(v).toUpperCase().replace(/[^A-Z0-9]+/g, '');

/**
 * The headings each field answers to.
 *
 * Longest match wins, so `PLCADDRESS` is read as the address and not mistaken
 * for a card; and a heading is only matched whole, so a column called
 * `DESCRIPTION` is never taken for `CARD` because the letters happen to be in
 * it.
 */
const HEADINGS: Record<keyof Omit<IoPoint, 'kind' | 'row'>, string[]> = {
  address: ['ADDRESS', 'IOADDRESS', 'PLCADDRESS', 'ADDR', 'SIGNAL', 'IO', 'TAGADDRESS', 'ADRESS', 'آدرس'],
  tag: ['TAG', 'DEVICE', 'DEVICETAG', 'DT', 'DESIGNATION', 'ITEM', 'EQUIPMENT', 'تگ'],
  description: ['DESCRIPTION', 'FUNCTION', 'SERVICE', 'TEXT', 'REMARK', 'NAME', 'شرح', 'توضیحات'],
  card: ['CARD', 'MODULE', 'RACK', 'PLC', 'SLOT', 'CARDTAG', 'کارت'],
  strip: ['STRIP', 'TERMINALSTRIP', 'TB', 'TERMINALBLOCK', 'XSTRIP'],
  terminal: ['TERMINAL', 'TERMINALNO', 'TERM', 'TB NO', 'TBNO', 'TERMINALNUMBER'],
  symbol: ['SYMBOL', 'DEVICETYPE', 'TYPE', 'FIELDDEVICE', 'SYMBOLID'],
};

/**
 * What kind of point an address is.
 *
 * Siemens, Allen-Bradley and everyone else write these differently, and all of
 * them are in the lists this office receives. A `W` or a `D` in the middle is
 * a word or a double word, and a word on a digital card does not exist — so
 * that is what tells an analogue point from a digital one, ahead of the
 * letter, which only says which direction it goes.
 */
export function kindOf(address: string): IoPoint['kind'] | null {
  const a = key(address);
  if (!a) return null;
  // Strip the leading % of an IEC address, and PI/PQ of a Siemens peripheral.
  const body = a.replace(/^(PERCENT)?/, '').replace(/^P(?=[IQ])/, '');
  const letter = body[0];
  const analogue = /^[IQEA](W|D)/.test(body);
  if (letter === 'I' || letter === 'E') return analogue ? 'AI' : 'DI';
  if (letter === 'Q' || letter === 'A') return analogue ? 'AO' : 'DO';
  // A list that spells it out rather than encoding it.
  if (body.startsWith('DI')) return 'DI';
  if (body.startsWith('DO')) return 'DO';
  if (body.startsWith('AI')) return 'AI';
  if (body.startsWith('AO')) return 'AO';
  return null;
}

/** The default field symbol for a point nobody named one for. */
export function defaultSymbol(kind: IoPoint['kind']): string {
  switch (kind) {
    // A make contact: the commonest thing on an input, and the one that reads
    // as "something out there closes" whatever it actually is.
    case 'DI': return 'pb-no';
    // A lamp: likewise the commonest load, and unmistakable on the page.
    case 'DO': return 'lamp';
    // A transmitter, two wire, which is what almost every analogue input is.
    case 'AI': return 'sensor-pnp';
    case 'AO': return 'sensor-pnp';
  }
}

/** Which row of the sheet is the heading, and which column is which field. */
function findHeader(rows: unknown[][]): { at: number; map: Record<string, number> } | null {
  const limit = Math.min(rows.length, 30);
  let best: { at: number; map: Record<string, number>; score: number } | null = null;

  for (let r = 0; r < limit; r++) {
    const cells = rows[r] ?? [];
    const map: Record<string, number> = {};
    for (const [field, names] of Object.entries(HEADINGS)) {
      // Longest heading first, so `TERMINALSTRIP` is not eaten by `TERMINAL`.
      const wanted = [...names].sort((a, b) => b.length - a.length);
      for (let c = 0; c < cells.length; c++) {
        const k = key(cells[c]);
        if (!k) continue;
        if (wanted.includes(k) && map[field] === undefined) { map[field] = c; break; }
      }
    }
    // A heading row without an address column is not a heading row: the
    // address is the one thing a point cannot be drawn without.
    if (map.address === undefined) continue;
    const score = Object.keys(map).length;
    if (!best || score > best.score) best = { at: r, map, score };
  }
  return best ? { at: best.at, map: best.map } : null;
}

/**
 * An I/O list as points this app can draw.
 *
 * Rows that cannot be read come back in `skipped` with the reason. They are
 * never quietly dropped: a list of 240 points that draws 236 pages and says
 * nothing is a list somebody will hand to a panel shop with four signals
 * missing.
 */
export function readIoList(rows: unknown[][]): ReadResult {
  const header = findHeader(rows);
  if (!header) {
    return {
      points: [], columns: {},
      skipped: [{
        row: 0, text: '',
        why: 'No heading row found — this file needs a column headed Address (or Signal, or I/O Address).',
      }],
    };
  }

  const { at, map } = header;
  const cell = (row: unknown[], field: string) =>
    (map[field] === undefined ? '' : clean(row[map[field]]));

  const points: IoPoint[] = [];
  const skipped: ReadResult['skipped'] = [];

  for (let r = at + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const line = row.map(clean).filter(Boolean).join(' ');
    if (!line) continue;

    const address = cell(row, 'address');
    if (!address) {
      skipped.push({ row: r + 1, why: 'No address in this row.', text: line });
      continue;
    }
    const kind = kindOf(address);
    if (!kind) {
      skipped.push({
        row: r + 1, text: line,
        why: `"${address}" is not an address this reads — expected something like I0.0, Q1.3, IW64, DI 12.`,
      });
      continue;
    }

    // A terminal written as `-X1:5` in one column, rather than split in two.
    const rawTerminal = cell(row, 'terminal');
    const rawStrip = cell(row, 'strip');
    let strip = rawStrip;
    let terminal = rawTerminal;
    const together = /^(.+?)\s*[:.]\s*(\w+)$/.exec(rawTerminal);
    if (!strip && together) { strip = together[1]; terminal = together[2]; }

    points.push({
      address,
      kind,
      tag: cell(row, 'tag'),
      description: cell(row, 'description'),
      card: cell(row, 'card'),
      strip,
      terminal,
      symbol: cell(row, 'symbol') || defaultSymbol(kind),
      row: r + 1,
    });
  }

  const columns: Record<string, string> = {};
  const heading = rows[at] ?? [];
  for (const [field, c] of Object.entries(map)) columns[field] = clean(heading[c]) || `column ${c + 1}`;

  return { points, skipped, columns };
}

/**
 * Terminal numbers for points that arrived without any.
 *
 * A panel is wired off the terminal strip, so every field wire has to land on
 * a numbered terminal whether or not the list bothered to say which. Numbering
 * runs per strip in the order the points appear, which is the order they will
 * be drawn and therefore the order somebody will find them on the rail.
 *
 * Numbers already in the list are kept exactly as they are — this fills gaps,
 * it does not renumber somebody else's strip.
 */
export function numberTerminals(points: IoPoint[], defaultStrip = '-X1'): IoPoint[] {
  const next = new Map<string, number>();
  const taken = new Map<string, Set<string>>();

  for (const p of points) {
    const strip = p.strip || defaultStrip;
    if (!taken.has(strip)) taken.set(strip, new Set());
    if (p.terminal) taken.get(strip)!.add(p.terminal);
  }

  return points.map(p => {
    const strip = p.strip || defaultStrip;
    if (p.terminal) return { ...p, strip };
    let n = next.get(strip) ?? 1;
    const used = taken.get(strip)!;
    while (used.has(String(n))) n += 1;
    used.add(String(n));
    next.set(strip, n + 1);
    return { ...p, strip, terminal: String(n) };
  });
}
