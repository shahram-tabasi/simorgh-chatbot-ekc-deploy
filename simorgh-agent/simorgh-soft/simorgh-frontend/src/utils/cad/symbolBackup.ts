// src/utils/cad/symbolBackup.ts
//
// Every symbol the office has, in one file — and back again on another server.
//
// A symbol's drawing lives in three places, and moving the app to another
// server moved none of them by itself:
//
//   * the office library — new symbols and the office's redraws of library
//     symbols — in the server's own database;
//   * the DXF pack, in each browser's localStorage, which belongs to the
//     server's address: on a new address it starts empty, and every symbol it
//     replaced is drawn the old, built-in way again;
//   * the pack folder on the server (eplan-symbols/, SVG and DXF files).
//
// So one file carries all three, and reading it puts each back where it
// belongs. An office library file written before this (format
// `simorgh-draw-library`) is still read, as a backup with only that part.

import {
  ImportResult, LIBRARY_FORMAT, LibraryFile, eplanSymbolService, symbolLibraryService,
} from '../../services/projectService';
import { DxfSymbol, loadDxfSymbols, saveDxfSymbols } from './dxfSymbols';

export const BACKUP_FORMAT = 'simorgh-symbols-backup';

export interface PackFile { name: string; kind: 'svg' | 'dxf'; content: string }

export interface SymbolBackup {
  format: typeof BACKUP_FORMAT;
  version: 1;
  exportedOn: string;
  /** The office library, as the server writes it. */
  library: LibraryFile;
  /** The DXF pack this browser holds. */
  browserPack: DxfSymbol[];
  /** The files in the server's pack folder. */
  serverPack: PackFile[];
}

/** Everything, read from where it lives now. */
export async function writeBackup(): Promise<SymbolBackup> {
  const library = await symbolLibraryService.exportAll();
  const listed = await eplanSymbolService.pack();
  const serverPack: PackFile[] = [];
  for (const entry of listed) {
    const kind = entry.kind === 'dxf' ? 'dxf' : 'svg';
    let content: string | null = null;
    if (kind === 'dxf') {
      content = await eplanSymbolService.dxf(entry.name);
    } else {
      try {
        const r = await fetch(eplanSymbolService.svgUrl(entry.name));
        content = r.ok ? await r.text() : null;
      } catch {
        content = null;
      }
    }
    if (content && content.trim()) serverPack.push({ name: entry.name, kind, content });
  }
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedOn: new Date().toISOString(),
    library,
    browserPack: loadDxfSymbols(),
    serverPack,
  };
}

/** A file read back: a full backup, or an older library-only file. */
export function readBackup(json: unknown): SymbolBackup | null {
  const o = json as { format?: string; exportedOn?: string; symbols?: unknown[] }
    & Partial<Omit<SymbolBackup, 'format'>>;
  if (o?.format === BACKUP_FORMAT && o.library && Array.isArray(o.library.symbols)) {
    return {
      format: BACKUP_FORMAT,
      version: 1,
      exportedOn: String(o.exportedOn ?? ''),
      library: o.library,
      browserPack: Array.isArray(o.browserPack) ? o.browserPack.filter(s => s && s.id && s.art) : [],
      serverPack: Array.isArray(o.serverPack)
        ? o.serverPack.filter(f => f && f.name && (f.kind === 'svg' || f.kind === 'dxf') && typeof f.content === 'string')
        : [],
    };
  }
  if (o?.format === LIBRARY_FORMAT && Array.isArray(o.symbols)) {
    return {
      format: BACKUP_FORMAT,
      version: 1,
      exportedOn: String(o.exportedOn ?? ''),
      library: o as unknown as LibraryFile,
      browserPack: [],
      serverPack: [],
    };
  }
  return null;
}

export interface RestoreResult {
  library: ImportResult | null;
  /** How many DXF pack symbols this browser now holds from the file. */
  browser: number;
  /** Pack files written to the server, and the ones it refused. */
  server: { written: number; failed: string[] };
}

/**
 * Put each part back where it lives.
 *
 * `merge` keeps what is here and lets the file's version of a symbol win;
 * `replace` makes the office library and this browser's pack exactly the
 * file's. The server's pack folder is only ever written to — a file there is
 * taken out by deleting it, by somebody who can see the folder.
 */
export async function restoreBackup(b: SymbolBackup, mode: 'merge' | 'replace'): Promise<RestoreResult> {
  // An empty library part is a file from a server that had none — never a
  // reason to empty this one.
  const library = b.library.symbols.length
    ? await symbolLibraryService.importAll(b.library, mode)
    : null;

  let browser = 0;
  if (b.browserPack.length || mode === 'replace') {
    const here = mode === 'replace' ? [] : loadDxfSymbols();
    const byId = new Map(here.map(s => [s.id, s] as const));
    for (const s of b.browserPack) byId.set(s.id, s);
    saveDxfSymbols([...byId.values()]);
    browser = b.browserPack.length;
  }

  let written = 0;
  const failed: string[] = [];
  for (const f of b.serverPack) {
    const done = await eplanSymbolService.upload(f.name, f.kind, f.content);
    if (done.ok) written += 1; else failed.push(`${f.name}.${f.kind}: ${done.error}`);
  }
  return { library, browser, server: { written, failed } };
}
