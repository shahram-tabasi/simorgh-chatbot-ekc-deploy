// src/utils/cad/officeSymbols.ts
//
// The office's own symbols, held where the rest of the app can reach them
// without waiting.
//
// They live on the server, and everything that asks for a symbol — the panel,
// the drawing assistant, the page generator — asks synchronously, because the
// two built-in libraries are right here in the bundle and always have been.
// Rather than make all of that asynchronous for the sake of one source, the
// office's symbols are read once into a cache and served from it. A caller
// that asks before the read has finished gets the built-in libraries, which is
// the truthful answer to "what is available right now".
//
// The version counter is how a panel knows to draw again after the read lands,
// or after somebody adds a symbol. Without it the list would be correct and
// the screen would not.

import { OfficeSymbol, symbolLibraryService } from '../../services/projectService';
import type { SymbolArtOverride } from '../../types/project';
import { LibraryItem } from './symbolSource';
import { IEC_SYMBOLS } from '../iecSymbols';

let cache: OfficeSymbol[] = [];
/**
 * The office's redraws of library symbols (`redraw:<symbol>`), kept apart:
 * they are not new symbols to be listed and placed, they are what a library
 * symbol looks like in every project.
 */
let redraws: OfficeSymbol[] = [];
export const REDRAW_PREFIX = 'redraw:';
const isRedraw = (s: OfficeSymbol) => s.id.startsWith(REDRAW_PREFIX);
let version = 0;
let reading: Promise<void> | null = null;

const listeners = new Set<() => void>();

function changed() {
  version += 1;
  for (const fn of listeners) fn();
}

/** Called whenever the office library changes. Returns the unsubscribe. */
export function onOfficeSymbols(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Bumped on every change, so a memo can depend on it. */
export const officeVersion = (): number => version;

/**
 * Read them, once.
 *
 * Repeated calls while a read is in flight join that read rather than starting
 * another — several panels opening at once is normal and should not be several
 * requests.
 */
export function loadOfficeSymbols(force = false): Promise<void> {
  if (reading && !force) return reading;
  reading = symbolLibraryService.all().then(list => {
    cache = list.filter(s => !isRedraw(s));
    redraws = list.filter(isRedraw);
    changed();
  }).finally(() => { reading = null; });
  return reading;
}

/** What has been read so far. Empty until the first read lands. */
export const officeSymbols = (): OfficeSymbol[] => cache;

/**
 * The library symbol an office symbol stands in for, when it is the office's
 * own drawing of it: a variant of a built-in single-line symbol that kept that
 * symbol's name ("Ammeter" made from Ammeter). Renamed variants — "CB LSIG
 * 4P" from Circuit breaker — are faces of their own, picked per part.
 */
function standsFor(s: OfficeSymbol): string | null {
  if (s.kind !== 'sld' || !s.variantOf?.startsWith('iec:')) return null;
  const id = s.variantOf.slice(4);
  const sym = IEC_SYMBOLS[id as keyof typeof IEC_SYMBOLS];
  if (!sym) return null;
  const n = (v: string) => v.trim().toLowerCase();
  return n(s.name) === n(sym.title) || n(s.name) === n(id) ? id : null;
}

/** The office's redraws of library symbols, by the symbol they redraw. */
export function officeRedraws(): Record<string, SymbolArtOverride> {
  const out: Record<string, SymbolArtOverride> = {};
  // The office's own drawings of library symbols made as same-name variants,
  // then the explicit redraws; of two for one symbol, the newer save wins.
  for (const s of cache) {
    const id = standsFor(s);
    if (!id || !s.art) continue;
    const t1 = s.terminals.find(t => t.name === '1') ?? s.terminals[0];
    const art: SymbolArtOverride = {
      art: s.art, width: s.width, height: s.height,
      pinX: t1 && (t1.dir === 'up' || t1.dir === 'down' || !t1.dir) ? t1.x : s.width / 2,
      cells: undefined as unknown as number,
      terminals: s.terminals.map(t => ({ x: t.x, y: t.y, name: t.name, dir: t.dir })) as SymbolArtOverride['terminals'],
      savedAt: (s as { changedOn?: string }).changedOn,
      editedAt: (s as { changedOn?: string }).changedOn ?? '',
    };
    const had = out[id];
    if (!had || (art.savedAt ?? '') > (had.savedAt ?? '')) out[id] = art;
  }
  // Its save time: stamped on the drawing, else when the server last changed
  // it — so a redraw saved before stamping still counts as the newer one.
  for (const s of redraws) {
    if (!s.override?.art) continue;
    const id = s.id.slice(REDRAW_PREFIX.length);
    const art = { ...s.override, savedAt: s.override.savedAt ?? (s as { changedOn?: string }).changedOn };
    const had = out[id];
    if (!had || (art.savedAt ?? '') >= (had.savedAt ?? '')) out[id] = art;
  }
  return out;
}

/** Keep a library symbol's redraw for the whole office: every project draws
 *  it so unless it has redrawn it itself. */
export async function saveOfficeRedraw(symbolId: string, art: SymbolArtOverride, title = symbolId): Promise<void> {
  const saved = await symbolLibraryService.save({
    id: `${REDRAW_PREFIX}${symbolId}`, name: `Redraw of ${title}`, kind: 'sld', group: 'Redrawn library symbols',
    art: art.art, width: art.width, height: art.height,
    terminals: (art.terminals ?? []).map(t => ({ x: t.x, y: t.y, name: t.name, dir: t.dir })),
    override: art,
  });
  redraws = [...redraws.filter(s => s.id !== saved.id), saved];
  changed();
}

/** Put a library symbol back to the library's own drawing, for the office. */
export async function forgetOfficeRedraw(symbolId: string): Promise<void> {
  const id = `${REDRAW_PREFIX}${symbolId}`;
  if (!redraws.some(s => s.id === id)) return;
  await symbolLibraryService.remove(id);
  redraws = redraws.filter(s => s.id !== id);
  changed();
}

/** Put one in the cache without re-reading everything. */
export function rememberOfficeSymbol(symbol: OfficeSymbol): void {
  const at = cache.findIndex(s => s.id === symbol.id);
  cache = at < 0 ? [...cache, symbol] : cache.map((s, i) => (i === at ? symbol : s));
  changed();
}

/** Take one out of the cache. */
export function forgetOfficeSymbol(id: string): void {
  cache = cache.filter(s => s.id !== id);
  changed();
}

/** The office's symbols as library items, alongside the built-in ones. */
export function officeItems(): LibraryItem[] {
  return cache.map(s => ({
    key: `office:${s.id}`,
    id: s.id,
    name: s.name,
    source: 'Office' as const,
    kind: s.kind,
    group: s.group,
    art: s.art,
    width: s.width,
    height: s.height,
    // Where a wire lands, and the axis it runs down — the first terminal, as
    // for every other source.
    pin: { x: s.terminals[0]?.x ?? s.width / 2, y: 0, span: s.height },
    terminals: s.terminals,
    // A variant belongs to the family of whatever it was made from; anything
    // else is its own family. `variantOf` holds a library key, so the two sit
    // in the same namespace and a variant of a built-in symbol works exactly
    // like a variant of one of the office's own.
    family: s.variantOf || `office:${s.id}`,
  }));
}

/** An id for a new symbol: readable, and unique enough to be a key. */
export function newSymbolId(name: string): string {
  const stem = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${stem || 'symbol'}-${Date.now().toString(36)}`;
}
