// src/utils/cad/dxfSymbols.ts
//
// The office's own DXF schematics, as symbols on the single line.
//
// A device drawn once in AutoCAD and saved as DXF becomes a symbol here. It
// arrives as geometry, not as a picture, so it goes back out to DXF and PDF as
// lines and arcs — editable, and sharp at any plot scale.
//
// The wiring is automatic, and this is where that is decided. EPLAN knows
// where a symbol's conductor enters and leaves because its symbols say so; a
// plain DXF does not, so the convention is a layer named CONN, CONNECTION, PIN
// or TERMINAL carrying a point at each terminal. The symbol is then normalised
// so its top terminal sits at the top of its box and its bottom terminal at
// the bottom, with the conductor running through both — which is exactly what
// the library already does with `pinX` and `cells`, so the device lands on the
// branch and the line joins it with nothing to place by hand.
//
// Without that layer the geometry's own outline is used instead: middle of the
// box, top to bottom. It draws correctly; it is just a guess about where the
// terminals are, and the file can say so instead.
import { Drawing, Pt, Shape, translateShape } from './shapes';
import { renderFragment } from './svg';
import { readDxf } from './readDxf';
import { LibraryKind } from './symbolLibraries';

/** How many cells of the branch a symbol may take. */
const MAX_CELLS = 4;

export interface DxfSymbol {
  /** The library symbol this replaces, from the file's name. */
  id: string;
  fileName: string;
  /**
   * Which of the three libraries it belongs to, and which shelf inside it.
   *
   * Absent on everything filed before there were three: `readKind` reads that
   * as the single line, which is what those symbols are — they were added to
   * replace symbols on the single-line branch and nothing else existed.
   */
  kind?: LibraryKind;
  group?: string;
  /** What the office calls it, where that is not just the file name. */
  title?: string;
  /** The geometry, as markup with no `<svg>` around it. */
  art: string;
  /** The box the geometry is placed by — the terminal span, when there is one. */
  width: number;
  height: number;
  /** Where the conductor runs inside that box. */
  pinX: number;
  /** How many cells down the branch it takes. */
  cells: number;
  /** What was read, for the panel that lists them. */
  entities: number;
  terminals: number;
  /**
   * Where those terminals are, in the box's own coordinates — the points a
   * wire is allowed to land on, shifted with the geometry.
   *
   * `terminals` above has always been the count, which is what the panel
   * listing the pack shows. The count is enough to say a file declared its
   * connection points; it is not enough to connect anything to them.
   */
  terminalPoints?: Pt[];
  skipped: Record<string, number>;
  /** How the box was decided, in a sentence the user can act on. */
  note: string;
  /**
   * The file itself, so the symbol can be sent to the pack later without
   * asking for it again. Dropped first if the browser runs out of room to
   * keep these — the symbol still draws; it just cannot be sent on.
   */
  source?: string;
}

/** Shapes moved so the geometry sits where the box says it does. */
const shift = (shapes: Shape[], dx: number, dy: number): Shape[] =>
  shapes.map(s => translateShape(s, dx, dy));

/**
 * One DXF file as a symbol.
 *
 * Returns null when the file holds no geometry at all — an empty drawing, or
 * one whose entities are all of kinds this reader passes over.
 */
export function symbolFromDxf(text: string, fileName: string, id: string): DxfSymbol | null {
  const read = readDxf(text, fileName);
  if (read.drawing.shapes.length === 0) return null;

  const width = Math.max(1, read.drawing.width);
  let height = Math.max(1, read.drawing.height);
  let pinX = width / 2;
  let dy = 0;
  let note: string;

  // Terminals top and bottom: the conductor's own ends, so use them.
  const top = read.connections[0];
  const bottom = read.connections[read.connections.length - 1];
  const span = top && bottom ? bottom[1] - top[1] : 0;

  if (read.connections.length >= 2 && span > 1) {
    height = span;
    dy = -top[1];
    pinX = (top[0] + bottom[0]) / 2;
    const skew = Math.abs(top[0] - bottom[0]);
    note = skew > 1
      ? `${read.connections.length} terminals; the top and bottom are ${skew.toFixed(1)} units apart across, so the conductor is drawn between them.`
      : `${read.connections.length} terminals, in line — the conductor runs through them.`;
  } else if (read.connections.length === 1) {
    pinX = top[0];
    note = 'One terminal: it sets where the conductor runs, and the outline sets the height.';
  } else {
    note = 'No CONN layer in the file — the conductor is put through the middle of the outline. Add points on a layer named CONN to place it exactly.';
  }

  const cells = Math.max(1, Math.min(MAX_CELLS, Math.round(height / width) || 1));
  const placed = shift(read.drawing.shapes, 0, dy);
  const framed = new Drawing(width, height, fileName);
  for (const s of placed) framed.add(s);

  return {
    id,
    fileName,
    source: text,
    art: renderFragment(framed),
    width,
    height,
    pinX,
    cells,
    entities: read.entities,
    terminals: read.connections.length,
    // Shifted by the same dy as the ink, so they sit where they are drawn.
    terminalPoints: read.connections.map(([x, y]) => [x, y + dy] as Pt),
    skipped: read.skipped,
    note,
  };
}

/** The terminals a file declared, for drawing them on a preview. */
export function terminalsOf(text: string): Pt[] {
  return readDxf(text).connections;
}

// ── Keeping them ────────────────────────────────────────────────────────────

const STORE = 'simorgh-draw:dxf-symbols';

/** The symbols loaded so far. Empty when the browser will not say. */
export function loadDxfSymbols(): DxfSymbol[] {
  try {
    const raw = localStorage.getItem(STORE);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(s => s && s.id && s.art) : [];
  } catch {
    return [];
  }
}

/**
 * Keep them for next time.
 *
 * The file each symbol came from is the bulky part and the one that can be
 * done without, so a browser that will not hold everything is given the
 * symbols without their sources rather than nothing at all. Silent either way:
 * a symbol that cannot be stored still draws for the rest of the session.
 */
// ── Who else is looking at the pack ─────────────────────────────────────────
// The pack is edited in one place — the symbol library panel — and read in
// another: the Simorgh Draw tab merges it into the overrides that decide which
// symbol a generated drawing uses. The two used to be the same screen and one
// could tell the other directly. They are not any more, so the store says so
// itself rather than each reader polling or guessing.

const watchers = new Set<() => void>();

/** Called whenever the pack changes. Returns the unsubscribe. */
export function onDxfSymbols(fn: () => void): () => void {
  watchers.add(fn);
  return () => { watchers.delete(fn); };
}

export function saveDxfSymbols(symbols: DxfSymbol[]): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(symbols));
  } catch {
    /* Out of room, most likely. Try again with the sources left out. */
    try {
      localStorage.setItem(STORE, JSON.stringify(
        symbols.map(({ source, ...rest }) => rest)));
    } catch {
      /* A private window, or still no room — this session is unaffected. */
    }
  }
  // Always, and last: whether or not the browser agreed to keep it, the pack
  // in this session has changed and everything reading it has to know. The
  // first version of this returned early on the path that works, so the
  // watchers only ever fired when the write had gone wrong.
  for (const fn of watchers) fn();
}
