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
import { LibraryItem } from './symbolSource';

let cache: OfficeSymbol[] = [];
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
    cache = list;
    changed();
  }).finally(() => { reading = null; });
  return reading;
}

/** What has been read so far. Empty until the first read lands. */
export const officeSymbols = (): OfficeSymbol[] => cache;

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
