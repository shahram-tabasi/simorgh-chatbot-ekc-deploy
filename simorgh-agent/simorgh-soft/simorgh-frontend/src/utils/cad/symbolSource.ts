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

import { Shape } from './shapes';
import { drawingFromSvg } from './fromSvg';
import { mapShape, newBlockId, scaling, translation } from './geom';
import { boundsOfAll } from './edit';
import { DxfSymbol, loadDxfSymbols } from './dxfSymbols';
import { CELL, IEC_SYMBOLS, SymbolId, drawIecSymbol, symbolHeight } from '../iecSymbols';

export interface LibraryItem {
  key: string;
  name: string;
  /** Where it came from, for the badge and the grouping. */
  source: 'IEC' | 'Pack' | 'File';
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
   * The geometry, where it is already known.
   *
   * A file read by the panel has been parsed once; re-serialising it to markup
   * only to parse it back would be work for nothing, and every round trip
   * through SVG is a chance to lose a layer or a dash.
   */
  shapes?: Shape[];
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
      group: sym.group,
      // Drawn at the origin, so what is read back starts where it is placed.
      art: drawIecSymbol(sym.id as SymbolId, CELL / 2, 4),
      width: CELL,
      height: h + 8,
      // `drawIecSymbol` runs the conductor down x and spans one cell from y:
      // that line, not the bounding box, is where a wire meets this symbol.
      pin: { x: CELL / 2, y: 4, span: h },
    };
  });
}

export const packItems = (packs: DxfSymbol[]): LibraryItem[] => packs.map(p => ({
  key: `pack:${p.id}:${p.fileName}`,
  id: p.id,
  name: p.fileName.replace(/\.[^.]+$/, ''),
  source: 'Pack' as const,
  group: 'Office DXF',
  art: p.art,
  width: p.width,
  height: p.height,
  // The pack reads the terminal span out of the file itself; where it found
  // one, that is exactly the pin, and where it did not it has already fallen
  // back to the middle of the box.
  pin: { x: p.pinX, y: 0, span: p.height },
}));

/** Everything in the library right now, the office's own pack included. */
export const libraryItems = (): LibraryItem[] => [...iecItems(), ...packItems(loadDxfSymbols())];

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
export function symbolCatalogue(items: LibraryItem[] = libraryItems()): CatalogueEntry[] {
  const by = new Map<string, CatalogueEntry>();
  for (const item of items) {
    const id = key(item.id ?? item.name);
    if (!id) continue;
    by.set(id, { id, name: item.name, group: item.group });
  }
  return [...by.values()];
}

/** A symbol the model asked for, by whatever it called it. */
export function findSymbol(id: string, items: LibraryItem[] = libraryItems()): LibraryItem | null {
  const want = key(id);
  if (!want) return null;
  // Last wins, so the pack overrides the IEC symbol of the same name — the
  // same precedence `symbolCatalogue` advertised.
  let found: LibraryItem | null = null;
  for (const item of items) {
    if (key(item.id ?? '') === want || key(item.name) === want) found = item;
  }
  return found;
}

/**
 * A symbol placed on the branch at a point, as one block.
 *
 * `at` is where the wire meets it — the top connection — and `span` how far
 * down the branch it should reach, so the caller can say "an isolator in this
 * 30-unit gap" without knowing how the symbol happens to be drawn. The pin
 * stays put while the geometry is scaled about it, which is why a symbol that
 * reaches sideways still hangs off the same conductor after scaling.
 */
export function placeSymbolAt(
  item: LibraryItem, at: { x: number; y: number }, span?: number, block?: string,
): Shape[] {
  const run = shapesOf(item);
  if (run.length === 0) return [];
  const box = boundsOfAll(run);
  const pin = item.pin ?? {
    x: box ? box.x + box.w / 2 : 0,
    y: box ? box.y : 0,
    span: box ? box.h : 1,
  };
  const k = span && span > 0 && pin.span > 0 ? span / pin.span : 1;
  const scaled = k === 1 ? run : run.map(s => mapShape(s, scaling(pin.x, pin.y, k)));
  const moved = scaled.map(s => mapShape(s, translation(at.x - pin.x, at.y - pin.y)));
  return block
    ? moved.map(s => ({ ...s, block, blockName: item.name.slice(0, 64) }))
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
): { shapes: Shape[]; missing: string[] } {
  const shapes: Shape[] = [];
  const missing: string[] = [];
  for (const s of run) {
    if (!isSymPlacement(s)) { shapes.push(s as Shape); continue; }
    const item = findSymbol(s.id, items);
    if (!item) { missing.push(s.id); continue; }
    const placed = placeSymbolAt(
      item, { x: s.x, y: s.y }, s.h, newBlockId(),
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
