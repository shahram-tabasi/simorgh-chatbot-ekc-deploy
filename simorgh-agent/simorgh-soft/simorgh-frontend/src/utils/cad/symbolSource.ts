// src/utils/cad/symbolSource.ts
//
// The symbol library, as one list, for everything that places a symbol.
//
// The library panel built this list for itself and the drawing assistant knew
// nothing about it, which is why a schematic it drew came back as boxes and a
// circle: the model had never been told there *was* a contactor symbol, so it
// drew what a contactor looks like from memory. Both now read the same list
// from here — a symbol added to the office's DXF pack is in the assistant's
// vocabulary the moment it is in the panel.
//
// Three sources, in the order they win:
//
//   **IEC**  — the single-line library the app draws its own sheets from.
//   **Pack** — the office's own DXF symbols, loaded on the Symbols screen.
//   **File** — anything read off the person's machine for a one-off; those
//              belong to the panel that read them and are passed in.
//
// What leaves here is always `Shape[]` for `placeAsBlock`: a contactor is one
// object, not fourteen lines that happen to be near each other.

import { Pt, Shape } from './shapes';
import { drawingFromSvg } from './fromSvg';
import { mapShape, newBlockId, scaling, translation } from './geom';
import { boundsOfAll } from './edit';
import { DxfSymbol, loadDxfSymbols } from './dxfSymbols';
import {
  CELL, IEC_SYMBOLS, SymbolId, drawIecSymbol, symbolHeight, symbolTerminals,
} from '../iecSymbols';
import { LibraryKind, defaultGroup, readKind } from './symbolLibraries';
import { terminalMarks } from './terminals';
import { wdItems } from './wdSymbols';
import { officeItems } from './officeSymbols';

export interface LibraryItem {
  key: string;
  name: string;
  /**
   * Where it came from, for the badge and the grouping.
   *
   *   IEC     built in — the single-line legend and the wiring-diagram set
   *   Office  added by this office and kept on the server
   *   Pack    a DXF pack loaded into this browser
   *   File    read off this computer for one drawing, kept nowhere
   */
  source: 'IEC' | 'Office' | 'Pack' | 'File';
  /**
   * Which of the three libraries it belongs to — single line, wiring diagram
   * or layout. A symbol drawn for one is wrong on the others, so nothing that
   * offers symbols offers all three at once.
   */
  kind: LibraryKind;
  group: string;
  /** Markup with no `<svg>` round it — what the preview draws and what is read. */
  art: string;
  width: number;
  height: number;
  /**
   * The name the assistant asks for it by. Short, lowercase and stable —
   * `contactor`, not `Contactor (vacuum, fused)`.
   */
  id?: string;
  /**
   * Where the branch line enters the symbol, in the art's own coordinates,
   * and how far down it leaves again.
   *
   * This is what lets a symbol be placed *on a wire* rather than merely near
   * one. Without it the only honest anchor is the middle of the ink, and the
   * ink is not centred on the conductor: a meter box reaches to the right, a
   * withdrawable breaker to the left, and both would hang off the branch.
   */
  pin?: { x: number; y: number; span: number };
  /**
   * The points a wire is allowed to land on, in the art's own coordinates,
   * each with the designation the device prints beside it.
   *
   * Absent means the symbol has not been given any, and it is placed exactly as
   * it always was — geometry with no terminals, joined by coordinate. Present
   * means a connection to it is a connection to the *device*, which is what
   * the connection list and the terminal diagram are read from.
   */
  terminals?: { x: number; y: number; name: string; dir?: string }[];
  /**
   * The geometry, where it is already known.
   *
   * A file read by the panel has been parsed once; re-serialising it to markup
   * only to parse it back would be work for nothing, and every round trip
   * through SVG is a chance to lose a layer or a dash.
   */
  shapes?: Shape[];
  /**
   * The family this symbol belongs to — itself, or the symbol it is a face of.
   *
   * A breaker's LSI, LSIG and LI are one device drawn three ways, and a
   * draughtsman reaching for "the breaker" wants to see the three together and
   * turn between them rather than hunt three entries in a list. Everything
   * with the same family is one symbol as far as the library and the placing
   * cursor are concerned.
   *
   * Absent means the symbol is its own family, which is true of every built-in
   * one: nothing was made from anything.
   */
  family?: string;
}

/**
 * Every face of one symbol, the original first.
 *
 * The original first because that is the one somebody picked, and a list that
 * starts somewhere else makes Tab feel like it skipped a turn. Ordered after
 * that by name, so the set is the same every time it is opened.
 */
export function variantsOf(item: LibraryItem, all: LibraryItem[]): LibraryItem[] {
  const family = item.family ?? item.key;
  const kin = all.filter(o => (o.family ?? o.key) === family);
  if (kin.length < 2) return [item];
  return [
    ...kin.filter(o => o.key === family),
    ...kin.filter(o => o.key !== family).sort((a, b) => a.name.localeCompare(b.name)),
  ];
}

/** One item's geometry, as shapes. */
export function shapesOf(item: LibraryItem): Shape[] {
  if (item.shapes) return item.shapes;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${item.width} ${item.height}" ` +
    `width="${item.width}" height="${item.height}">${item.art}</svg>`;
  return drawingFromSvg(svg, item.name).shapes;
}

/** The IEC library, drawn the way a sheet draws it so it matches what is there. */
export function iecItems(): LibraryItem[] {
  return Object.values(IEC_SYMBOLS).map(sym => {
    const h = symbolHeight(sym.id as SymbolId);
    return {
      key: `iec:${sym.id}`,
      id: sym.id,
      name: sym.title,
      source: 'IEC' as const,
      // Every one of these is a single-line symbol: the set was drawn from the
      // office's own SLD legend sheet, and nothing else existed when it was.
      kind: 'sld' as const,
      group: sym.group,
      // Drawn at the origin, so what is read back starts where it is placed.
      art: drawIecSymbol(sym.id as SymbolId, CELL / 2, 4),
      width: CELL,
      height: h + 8,
      // `drawIecSymbol` runs the conductor down x and spans one cell from y:
      // that line, not the bounding box, is where a wire meets this symbol.
      pin: { x: CELL / 2, y: 4, span: h },
      // A single-line device stands in the branch: current in at the top, out
      // at the bottom. `1` and `2` are what IEC numbers those, and they are
      // the two ends of the conductor the symbol is drawn around — not the
      // corners of its box, which is why they are taken off the pin axis.
      //
      // That is the *rule*, and it holds until somebody redraws the symbol and
      // says otherwise. A CT the office draws with its tap at the side has its
      // terminals where the office put them, and `symbolTerminals` answers
      // from the same override and the same transform the art is drawn with —
      // so the points and the ink cannot drift apart.
      terminals: symbolTerminals(sym.id as SymbolId, CELL / 2, 4),
    };
  });
}

export const packItems = (packs: DxfSymbol[]): LibraryItem[] => packs.map(p => ({
  key: `pack:${p.id}:${p.fileName}`,
  id: p.id,
  name: p.title || p.fileName.replace(/\.[^.]+$/, ''),
  source: 'Pack' as const,
  kind: readKind(p.kind),
  group: p.group || defaultGroup(readKind(p.kind)),
  art: p.art,
  width: p.width,
  height: p.height,
  // The pack reads the terminal span out of the file itself; where it found
  // one, that is exactly the pin, and where it did not it has already fallen
  // back to the middle of the box.
  pin: { x: p.pinX, y: 0, span: p.height },
  // A file in the pack says where its own terminals are, on its CONN layer;
  // where it said nothing, the two ends of the conductor the reader settled
  // on. Numbered in the order the file declared them, which is the order the
  // person who drew it put them in.
  terminals: (p.terminalPoints?.length
    ? p.terminalPoints
    : [[p.pinX, 0], [p.pinX, p.height]] as Pt[]
  ).map(([x, y], i) => ({ x, y, name: String(i + 1) })),
}));

/** Everything in the library right now, the office's own pack included. */
export const libraryItems = (): LibraryItem[] =>
  [...iecItems(), ...wdItems(), ...officeItems(), ...packItems(loadDxfSymbols())];

// ── The assistant's vocabulary ─────────────────────────────────────────────

export interface CatalogueEntry {
  /** What the model writes in `"id"`. */
  id: string;
  /** What it is, in the words the library uses. */
  name: string;
  group: string;
}

/** Ids compared the way a model writes them: case and punctuation forgiven. */
const key = (s: string) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

/**
 * The symbols the assistant may ask for, newest source last.
 *
 * A pack symbol carrying an IEC id replaces the IEC one here exactly as it
 * replaces it on a sheet — one name, one symbol, whichever the office has
 * decided that name means.
 */
export function symbolCatalogue(
  items: LibraryItem[] = libraryItems(), kind: LibraryKind = 'sld',
): CatalogueEntry[] {
  const by = new Map<string, CatalogueEntry>();
  for (const item of items) {
    // One library at a time. Handing the assistant all three is handing it a
    // coil to put on a single line, and it will use one.
    if (item.kind !== kind) continue;
    const id = key(item.id ?? item.name);
    if (!id) continue;
    by.set(id, { id, name: item.name, group: item.group });
  }
  return [...by.values()];
}

/** A symbol the model asked for, by whatever it called it. */
export function findSymbol(
  id: string, items: LibraryItem[] = libraryItems(), kind?: LibraryKind,
): LibraryItem | null {
  const want = key(id);
  if (!want) return null;
  // Last wins, so the pack overrides the IEC symbol of the same name — the
  // same precedence `symbolCatalogue` advertised.
  let found: LibraryItem | null = null;
  for (const item of items) {
    if (kind && item.kind !== kind) continue;
    if (key(item.id ?? '') === want || key(item.name) === want) found = item;
  }
  return found;
}

/**
 * The line every symbol carries down its own cell, and what it is for.
 *
 * A meter in the library is drawn as a box tapped off a conductor that runs
 * the full height of the cell. On a branch that conductor is the branch. Off
 * one — a single ammeter fed from a CT — it is a stub attached to nothing,
 * which is exactly what it looked like: a vertical line in front of the
 * ammeter with no meaning.
 *
 * It does have a meaning, but only in the plural: stack three instruments on
 * one x and those conductors join end to end into the little bus that parallels
 * them, fed by the one line from the CT. So it is kept when instruments are
 * stacked and dropped when there is one, rather than removed from the symbol.
 */
const throughConductor = (s: Shape, pin: { x: number; span: number }) =>
  s.t === 'line'
  && Math.abs(s.x1 - pin.x) < 0.5 && Math.abs(s.x2 - pin.x) < 0.5
  && Math.abs(s.y2 - s.y1) >= pin.span * 0.9;

/**
 * A symbol placed at a point, as one block.
 *
 * `at` is where the line meets it and `span` how far down it should reach, so
 * the caller can say "an isolator in this 30-unit gap" without knowing how the
 * symbol happens to be drawn. The pin stays put while the geometry is scaled
 * about it, which is why a symbol that reaches sideways still hangs off the
 * same conductor after scaling.
 *
 * `tap` is the difference between a device **on** the line and one **fed from**
 * it. On the line, `at` is the top terminal and the current passes through.
 * Tapped, `at` is where the single line from the CT arrives at its side, and
 * the conductor it would have carried down the branch is dropped — there is no
 * branch there to be part of.
 */
export function placeSymbolAt(
  item: LibraryItem, at: { x: number; y: number }, span?: number, block?: string,
  tap = false,
): Shape[] {
  let run = shapesOf(item);
  if (run.length === 0) return [];
  const box = boundsOfAll(run);
  let pin = item.pin ?? {
    x: box ? box.x + box.w / 2 : 0,
    y: box ? box.y : 0,
    span: box ? box.h : 1,
  };
  if (tap) {
    run = run.filter(s => !throughConductor(s, pin));
    if (run.length === 0) return [];
    // Joined at its side, half way down, which is where the symbol's own tap
    // into the box leaves the conductor that is no longer drawn.
    pin = { ...pin, y: pin.y + pin.span / 2 };
  }
  // The terminals join the run *before* it is transformed, so they are scaled,
  // moved and blocked by exactly the same arithmetic as the ink. Working them
  // out afterwards would be the same sum written twice, and the second copy
  // would be the one that went wrong.
  if (item.terminals?.length && !tap) {
    run = [...run, ...terminalMarks(item.terminals)];
  }

  const k = span && span > 0 && pin.span > 0 ? span / pin.span : 1;
  const scaled = k === 1 ? run : run.map(s => mapShape(s, scaling(pin.x, pin.y, k)));
  const moved = scaled.map(s => mapShape(s, translation(at.x - pin.x, at.y - pin.y)));
  // `symbol` is the library's own id for it, carried on every shape so a
  // symbol redrawn for the project can be put in the place of the ones the
  // assistant has already drawn — see cad/replaceSymbol.
  return block
    ? moved.map(s => ({
      ...s, block, blockName: item.name.slice(0, 64), symbol: item.id,
    }))
    : moved;
}

/**
 * What the assistant sends instead of drawing a symbol itself.
 *
 * The model names a symbol and says where the wire meets it; the geometry
 * comes from the library here, on this machine, where the library actually
 * lives. The backend never sees a line of it — it only checks that the name is
 * one the browser said it had.
 */
export interface SymPlacement {
  t: 'sym';
  id: string;
  x: number;
  y: number;
  /** How far down the branch it reaches. One cell when it is not said. */
  h?: number;
  /**
   * Fed from the side rather than standing on the line — an ammeter off a CT.
   * `x,y` is then where that line arrives, and the symbol keeps no conductor
   * of its own. See `placeSymbolAt`.
   */
  tap?: boolean;
  /** What to call the block — the device, where the model knows it. */
  name?: string;
}

export const isSymPlacement = (s: unknown): s is SymPlacement =>
  !!s && typeof s === 'object' && (s as { t?: unknown }).t === 'sym';

/**
 * Every `sym` in a generated drawing, swapped for the real symbol.
 *
 * A name the library does not have is dropped rather than drawn as something
 * else: a schematic with a missing device is obviously wrong, and one with a
 * plausible substitute is wrong where nobody will notice.
 */
export function expandSymbols(
  run: (Shape | SymPlacement)[], items: LibraryItem[] = libraryItems(),
  kind: LibraryKind = 'sld',
): { shapes: Shape[]; missing: string[] } {
  const shapes: Shape[] = [];
  const missing: string[] = [];
  for (const s of run) {
    if (!isSymPlacement(s)) { shapes.push(s as Shape); continue; }
    const item = findSymbol(s.id, items, kind);
    if (!item) { missing.push(s.id); continue; }
    const placed = placeSymbolAt(
      item, { x: s.x, y: s.y }, s.h, newBlockId(), s.tap === true,
    );
    if (placed.length === 0) { missing.push(s.id); continue; }
    if (s.name) {
      const label = s.name.slice(0, 64);
      for (const p of placed) p.blockName = label;
    }
    shapes.push(...placed);
  }
  return { shapes, missing };
}
