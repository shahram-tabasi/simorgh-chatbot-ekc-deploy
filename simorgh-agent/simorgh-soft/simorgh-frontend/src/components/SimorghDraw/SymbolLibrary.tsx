import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  XIcon, SearchIcon, UploadIcon, Maximize2Icon, Minimize2Icon, PlusIcon,
  ChevronDownIcon, ChevronRightIcon, PencilIcon, Trash2Icon, FilePlusIcon,
  DownloadIcon, LibraryIcon,
} from 'lucide-react';

import { Shape } from '../../utils/cad/shapes';
import { drawingFromSvg } from '../../utils/cad/fromSvg';
import { renderFragment } from '../../utils/cad/svg';
import { readDxf } from '../../utils/cad/readDxf';
import { loadDxfSymbols } from '../../utils/cad/dxfSymbols';
import { LibraryItem, iecItems, packItems, shapesOf } from '../../utils/cad/symbolSource';
import { wdItems } from '../../utils/cad/wdSymbols';
import {
  LibraryKind, SYMBOL_LIBRARIES, defaultGroup, libraryOf,
} from '../../utils/cad/symbolLibraries';
import {
  forgetOfficeSymbol, loadOfficeSymbols, officeItems, officeSymbols, onOfficeSymbols,
} from '../../utils/cad/officeSymbols';
import {
  LIBRARY_FORMAT, LibraryFile, OfficeSymbol, symbolLibraryService,
} from '../../services/projectService';
import { downloadText } from '../../utils/download';
import { SymbolMaker } from './SymbolMaker';
import { Strings, dirOf, Lang } from './lang';
import { ThemeId } from './theme';

// The symbol library, and everything that can come into a drawing through it.
//
// Three sources, one list:
//
//   **IEC** — the library the single line itself is drawn from, so a symbol
//             added by hand matches the ones the software placed.
//   **Pack** — the office's own DXF symbols, already loaded into the browser
//             by the DXF symbol pack on the Symbols screen.
//   **A file** — any DXF or SVG off the person's own machine, read here and
//             placed without being kept anywhere. For the one-off.
//
// Whatever the source, what lands on the sheet is **one block**: a contactor
// is a contactor, not fourteen lines that happen to be near each other. That
// is the whole point of importing rather than drawing, and it is why this
// returns `Shape[]` for the editor to place with `placeAsBlock` rather than
// dropping loose geometry on the canvas.

// `LibraryItem` and the three sources live in `utils/cad/symbolSource`, so the
// drawing assistant asks for symbols out of the same list this panel shows.
export type { LibraryItem };

interface Props {
  t: Strings;
  lang: Lang;
  theme: ThemeId;
  /** Chosen geometry, ready to be placed as one block. */
  onImport: (shapes: Shape[], name: string) => void;
  onClose: () => void;
  /**
   * Which library to open on — the kind of page being drawn.
   *
   * A wiring diagram page offering single-line symbols is two thirds wrong
   * before anybody clicks anything, so the page says which shelf it wants.
   * All three stay reachable: this is where it opens, not where it is locked.
   */
  kind?: LibraryKind;
  /**
   * What is picked on the sheet, so a symbol can be made out of it.
   *
   * This is the step the separate symbol editors do not have: draw the thing,
   * select it, and it is in the library. Absent means the button says so
   * rather than disappearing.
   */
  selection?: Shape[];
}

/**
 * The thickest line in a piece of symbol art, in the symbol's own units.
 *
 * Read out of the markup because that is where it is: these symbols come from
 * three sources and nothing else records how heavily they are drawn. One unit
 * when nothing says otherwise, which is what the wiring-diagram set uses.
 */
function heaviestStroke(art: string): number {
  let most = 0;
  for (const m of art.matchAll(/stroke-width="([\d.]+)"/g)) {
    const w = Number(m[1]);
    if (Number.isFinite(w) && w > most) most = w;
  }
  return most > 0 ? most : 1;
}

export const SymbolLibrary: React.FC<Props> = ({
  t, lang, theme, onImport, onClose, kind: openOn, selection,
}) => {
  const [query, setQuery] = useState('');
  const [big, setBig] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [fromFile, setFromFile] = useState<LibraryItem[]>([]);
  const [note, setNote] = useState<string | null>(null);
  // Which of the three libraries is open. The page being drawn decides; with
  // no page to ask, the single line, which is where the app's own drawings
  // come from.
  const [kind, setKind] = useState<LibraryKind>(openOn ?? 'sld');
  const file = useRef<HTMLInputElement>(null);
  const [making, setMaking] = useState(false);
  const [editing, setEditing] = useState<OfficeSymbol | null>(null);
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set());
  const libraryFile = useRef<HTMLInputElement>(null);
  const [incoming, setIncoming] = useState<LibraryFile | null>(null);
  const [busy, setBusy] = useState(false);

  // The office's library comes off the server, so it arrives after the first
  // draw. `beat` is what says "it is here now" — without it the list would be
  // right and the screen would not.
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    const off = onOfficeSymbols(() => setBeat(b => b + 1));
    loadOfficeSymbols();
    return off;
  }, []);

  const items = useMemo(
    () => [...iecItems(), ...wdItems(), ...officeItems(), ...packItems(loadDxfSymbols()), ...fromFile],
    [fromFile, beat]);

  /** How many symbols each library holds, for the tab that opens it. */
  const counts = useMemo(() => {
    const by = new Map<LibraryKind, number>();
    for (const i of items) by.set(i.kind, (by.get(i.kind) ?? 0) + 1);
    return by;
  }, [items]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const inLibrary = items.filter(i => i.kind === kind);
    const hit = q
      ? inLibrary.filter(i => i.name.toLowerCase().includes(q) || i.group.toLowerCase().includes(q))
      : inLibrary;
    // Grouped the way the Symbols screen groups them, so the two read alike.
    const by = new Map<string, LibraryItem[]>();
    for (const i of hit) {
      const list = by.get(i.group);
      if (list) list.push(i); else by.set(i.group, [i]);
    }
    // In the order this library declares its shelves; anything filed under a
    // name of the office's own goes after them rather than being hidden.
    const order = libraryOf(kind).groups;
    return [...by.entries()].sort((a, b) => {
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  }, [items, query, kind]);

  const chosen = items.find(i => i.key === picked) ?? null;

  /** A DXF or SVG off the person's own machine, read and put in the list. */
  const readFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    const added: LibraryItem[] = [];
    const failed: string[] = [];
    for (const f of Array.from(list)) {
      try {
        const text = await f.text();
        const name = f.name.replace(/\.[^.]+$/, '');
        if (/\.dxf$/i.test(f.name)) {
          const read = readDxf(text, f.name);
          if (read.drawing.shapes.length === 0) { failed.push(f.name); continue; }
          added.push({
            key: `file:${f.name}:${added.length}`,
            name, source: 'File', kind, group: defaultGroup(kind),
            // The preview is drawn through the same back-end as everything
            // else, and the shapes themselves are kept so importing does not
            // have to parse the markup back out again.
            art: renderFragment(read.drawing),
            width: Math.max(1, read.drawing.width),
            height: Math.max(1, read.drawing.height),
            shapes: read.drawing.shapes,
          });
        } else if (/\.svg$/i.test(f.name)) {
          const d = drawingFromSvg(text, name);
          if (d.shapes.length === 0) { failed.push(f.name); continue; }
          added.push({
            key: `file:${f.name}:${added.length}`,
            name, source: 'File', kind, group: defaultGroup(kind),
            art: text.replace(/^[\s\S]*?<svg[^>]*>/i, '').replace(/<\/svg>\s*$/i, ''),
            width: Math.max(1, d.width), height: Math.max(1, d.height),
          });
        } else {
          failed.push(f.name);
        }
      } catch {
        failed.push(f.name);
      }
    }
    if (added.length) {
      setFromFile(prev => [...prev, ...added]);
      setPicked(added[0].key);
    }
    setNote(failed.length
      ? `${added.length} read · could not read ${failed.join(', ')}`
      : `${added.length} symbol${added.length === 1 ? '' : 's'} read from this computer`);
    if (file.current) file.current.value = '';
  };

  const place = (item: LibraryItem) => {
    const shapes = item.shapes ?? shapesOf(item);
    if (shapes.length === 0) { setNote(t.libNothingIn(item.name)); return; }
    onImport(shapes, item.name);
  };

  const Preview: React.FC<{ item: LibraryItem; size: number }> = ({ item, size }) => (
    <svg
      width="100%"
      height={size}
      viewBox={`0 0 ${item.width} ${item.height}`}
      preserveAspectRatio="xMidYMid meet"
      className="overflow-visible"
      dangerouslySetInnerHTML={{ __html: item.art }}
    />
  );

  /**
   * The symbol large, with its connection points on it.
   *
   * The points are the thing a catalogue picture leaves out and the thing
   * somebody about to wire this needs: where the wire goes, and what that
   * place is called. Drawn here rather than baked into the art, because on the
   * sheet they belong to the PIN layer and can be switched off — a preview is
   * where you look at them, not where you live with them.
   */
  const BigPreview: React.FC<{ item: LibraryItem }> = ({ item }) => {
    // Enough room round the ink for a terminal ring and its name, in the
    // symbol's own units so it holds at any size.
    const extent = Math.max(item.width, item.height);
    const pad = extent * 0.12 + 2;
    const r = extent / 55 + 0.6;
    const size = extent / 14 + 1.5;

    // How much to magnify it, worked out from the symbol's own line weight
    // rather than stretched to fill the pane.
    //
    // One magnification cannot serve both libraries. A wiring-diagram symbol
    // carries a one-unit line in a twenty-unit box; a single-line one carries a
    // 2.2-unit line in a forty-eight-unit box. At eight pixels to the unit the
    // first reads as a drawing and the second as a row of black blobs — and
    // both are drawn correctly, they are simply issued at different sizes and
    // so drawn at different weights.
    //
    // Two things are wanted at once: a symbol big enough to look at, and a
    // line no thicker than a line. Whichever is the tighter constraint wins.
    const PX = Math.max(2.5, Math.min(260 / extent, 6 / heaviestStroke(item.art)));
    const w = (item.width + pad * 2) * PX;
    const h = (item.height + pad * 2) * PX;

    // The wiring-diagram symbols print their own terminal numbers, and a
    // second copy beside them in orange is the same number twice. So the ring
    // is always drawn — it is what says *where* — and the name only where the
    // drawing does not already say it.
    const named = (name: string) => !item.art.includes(`>${name}<`);

    return (
      <svg
        width={w}
        height={h}
        viewBox={`${-pad} ${-pad} ${item.width + pad * 2} ${item.height + pad * 2}`}
        preserveAspectRatio="xMidYMid meet"
        className="max-w-full max-h-full"
      >
        <g dangerouslySetInnerHTML={{ __html: item.art }} />
        {(item.terminals ?? []).map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r={r} fill="none" stroke="#ea580c" strokeWidth={r / 3} />
            {named(p.name) && (
              <text x={p.x + r * 1.8} y={p.y - r * 0.6} fontSize={size} fill="#ea580c">
                {p.name}
              </text>
            )}
          </g>
        ))}
      </svg>
    );
  };

  // Through a portal, like the cell editor: the editor can be inside a window
  // that is itself positioned, and `fixed` inside a positioned ancestor is not
  // fixed to the viewport at all. Drawn on the body it always fills the screen.
  return createPortal(
    <div className="fixed inset-0 z-[250] bg-black/50 flex items-center justify-center p-4">
      <div
        data-sd-theme={theme}
        dir={dirOf(lang)}
        data-symbol-library
        className={`relative bg-white rounded-lg shadow-2xl flex flex-col overflow-hidden ${
          big ? 'w-full h-full' : 'w-[1100px] max-w-full h-[80vh] max-h-full'}`}
      >
        {/* ── Title bar ────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 px-4 py-2.5 bg-gray-50 border-b">
          <h3 className="text-sm font-semibold text-gray-800">{t.libTitle}</h3>
          <p className="text-[11px] text-gray-500 hidden sm:block">{t.libNote}</p>

          <div className="ms-auto flex items-center gap-2">
            <div className="relative">
              <SearchIcon className="w-3.5 h-3.5 absolute start-2 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                data-lib-search
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t.libSearch}
                className="ps-7 pe-2 py-1.5 text-sm border border-gray-300 rounded w-56 bg-white"
              />
            </div>
            <button
              onClick={() => { setEditing(null); setMaking(true); }}
              data-lib-new
              title={t.libNewNote}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-blue-600 text-sm text-white hover:bg-blue-700"
            >
              <FilePlusIcon className="w-4 h-4" /> {t.libNew}
            </button>
            <button
              onClick={() => file.current?.click()}
              data-lib-file
              title={t.libFromFileNote}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-100"
            >
              <UploadIcon className="w-4 h-4" /> {t.libFromFile}
            </button>
            <input
              ref={file}
              type="file"
              accept=".dxf,.svg"
              multiple
              className="hidden"
              onChange={e => readFiles(e.target.files)}
            />
            <button
              onClick={async () => {
                setBusy(true);
                try {
                  const file = await symbolLibraryService.exportAll();
                  downloadText(
                    `simorgh-library-${new Date().toISOString().slice(0, 10)}.json`,
                    JSON.stringify(file, null, 2),
                    'application/json',
                  );
                  setNote(t.libExported(file.symbols.length));
                } catch (err) {
                  setNote(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
              data-lib-export
              title={t.libExportNote}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-40"
            >
              <DownloadIcon className="w-4 h-4" /> {t.libExport}
            </button>
            <button
              onClick={() => libraryFile.current?.click()}
              disabled={busy}
              data-lib-import-file
              title={t.libImportNote}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-40"
            >
              <LibraryIcon className="w-4 h-4" /> {t.libImportFile}
            </button>
            <input
              ref={libraryFile}
              type="file"
              accept=".json"
              className="hidden"
              onChange={async e => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                try {
                  const read = JSON.parse(await f.text()) as LibraryFile;
                  if (read?.format !== LIBRARY_FORMAT || !Array.isArray(read.symbols)) {
                    setNote(t.libNotALibrary);
                    return;
                  }
                  // Asked before anything happens, because one of the two
                  // answers throws away the library that is here.
                  setIncoming(read);
                } catch {
                  setNote(t.libNotALibrary);
                }
              }}
            />
            <button
              onClick={() => setBig(b => !b)}
              data-lib-full
              title={big ? t.leaveFullscreen : t.fullscreen}
              className="p-1.5 rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-100"
            >
              {big ? <Minimize2Icon className="w-4 h-4" /> : <Maximize2Icon className="w-4 h-4" />}
            </button>
            <button
              onClick={onClose}
              data-lib-close
              title={t.closeHelp}
              className="p-1.5 rounded text-gray-500 hover:bg-gray-200"
            >
              <XIcon className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* ── The three libraries ──────────────────────────────────────────
            Tabs rather than one long list with headings: a symbol drawn for a
            wiring diagram is the wrong answer on a single line, so the two are
            never on screen together and picking one is a deliberate act. */}
        <div className="flex items-stretch gap-1 px-4 pt-2 border-b bg-gray-50">
          {SYMBOL_LIBRARIES.map(lib => {
            const on = lib.kind === kind;
            return (
              <button
                key={lib.kind}
                data-lib-kind={lib.code}
                onClick={() => { setKind(lib.kind); setPicked(null); }}
                title={lang === 'fa' ? lib.noteFa : lib.note}
                className={`px-3 py-1.5 -mb-px border-b-2 text-sm transition ${
                  on
                    ? 'border-blue-500 text-blue-700 font-medium'
                    : 'border-transparent text-gray-500 hover:text-gray-700'}`}
              >
                <span className="font-mono text-[11px] tracking-wide opacity-70">{lib.code}</span>
                <span className="ms-2">{lang === 'fa' ? lib.nameFa : lib.name}</span>
                <span className="ms-1.5 text-[11px] text-gray-400">
                  {counts.get(lib.kind) ?? 0}
                </span>
              </button>
            );
          })}
        </div>

        {/* ── The list, and the shape beside it ────────────────────────────
            A list and not a wall of cards. Somebody looking for a symbol knows
            what it is called — "breaker", "CT" — and types it; what they are
            unsure of is which of the four breakers it is, and that is answered
            by the drawing, large, beside the name. A grid answers the second
            question at thumbnail size and the first not at all. */}
        <div className="flex-1 flex min-h-0">
          <div className="w-[21rem] shrink-0 overflow-y-auto border-e bg-white">
            {shown.length === 0 && (
              <div className="p-4 text-sm text-gray-500 space-y-1">
                <p>{query.trim() ? t.libNoneFound : t.libEmptyLibrary}</p>
                {!query.trim() && (
                  <p className="text-[12px] text-gray-400">
                    {lang === 'fa' ? libraryOf(kind).noteFa : libraryOf(kind).note}
                  </p>
                )}
              </div>
            )}
            {shown.map(([group, list]) => {
              // Searching opens everything: a shelf collapsed over a match is
              // a match nobody can see.
              const open = Boolean(query.trim()) || !shut.has(group);
              return (
                <div key={group}>
                  <button
                    onClick={() => setShut(prev => {
                      const next = new Set(prev);
                      if (next.has(group)) next.delete(group); else next.add(group);
                      return next;
                    })}
                    className="w-full flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 border-y text-[11px] font-semibold text-gray-600 uppercase tracking-wide sticky top-0 z-10 hover:bg-gray-100"
                  >
                    {open
                      ? <ChevronDownIcon className="w-3.5 h-3.5" />
                      : <ChevronRightIcon className="w-3.5 h-3.5" />}
                    <span className="truncate">{group}</span>
                    <span className="ms-auto text-gray-400">{list.length}</span>
                  </button>
                  {open && list.map(item => (
                    <button
                      key={item.key}
                      data-lib-item={item.name}
                      onClick={() => setPicked(item.key)}
                      onDoubleClick={() => place(item)}
                      title={`${item.name} — ${t.libDoubleClick}`}
                      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-start border-s-2 ${
                        picked === item.key
                          ? 'border-s-blue-500 bg-blue-50'
                          : 'border-s-transparent hover:bg-gray-50'}`}
                    >
                      {/* A thumbnail as well as the name, because half of
                          recognising a symbol is recognising its shape. */}
                      <span className="w-8 h-7 shrink-0 flex items-center justify-center">
                        <Preview item={item} size={26} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12.5px] text-gray-800 leading-tight truncate">
                          {item.name}
                        </span>
                        <span className="block text-[10px] text-gray-400">
                          {item.source}
                          {item.terminals?.length ? ` · ${t.libPoints(item.terminals.length)}` : ''}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>

          <aside className="flex-1 min-w-0 flex flex-col bg-gray-50">
            {chosen ? (
              <>
                {/* The white card wraps the drawing rather than filling the
                    pane. A small symbol shown at its proper weight in a large
                    empty box reads as an error; shown on a card its own size,
                    it reads as a symbol. */}
                <div className="flex-1 min-h-0 p-8 flex items-center justify-center overflow-auto">
                  <div className="bg-white rounded border border-gray-200 p-6 flex items-center justify-center max-w-full max-h-full">
                    <BigPreview item={chosen} />
                  </div>
                </div>

                <div className="px-6 py-3 border-t bg-white flex items-center gap-4 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-base font-medium text-gray-900 truncate">{chosen.name}</p>
                    <p className="text-[11px] text-gray-500">
                      {chosen.source} · {chosen.group} · {Math.round(chosen.width)} × {Math.round(chosen.height)}
                      {chosen.terminals?.length ? ` · ${t.libPoints(chosen.terminals.length)}` : ''}
                    </p>
                  </div>

                  <div className="ms-auto flex items-center gap-2">
                    {/* Only the office's own symbols can be changed here. The
                        built-in ones are what the app draws with, and a drawing
                        made last year has to keep meaning what it meant. */}
                    {chosen.source === 'Office' && (
                      <>
                        <button
                          onClick={() => {
                            const own = officeSymbols().find(o => `office:${o.id}` === chosen.key);
                            if (own) { setEditing(own); setMaking(true); }
                          }}
                          className="flex items-center gap-1.5 px-3 py-2 rounded border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-100"
                        >
                          <PencilIcon className="w-4 h-4" /> {t.libEdit}
                        </button>
                        <button
                          onClick={async () => {
                            const own = officeSymbols().find(o => `office:${o.id}` === chosen.key);
                            if (!own || !window.confirm(t.libDeleteAsk(own.name))) return;
                            try {
                              await symbolLibraryService.remove(own.id);
                              forgetOfficeSymbol(own.id);
                              setPicked(null);
                            } catch (err) {
                              setNote(err instanceof Error ? err.message : String(err));
                            }
                          }}
                          className="flex items-center gap-1.5 px-3 py-2 rounded border border-gray-300 bg-white text-sm text-red-700 hover:bg-red-50"
                        >
                          <Trash2Icon className="w-4 h-4" /> {t.libDelete}
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => place(chosen)}
                      data-lib-import
                      className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
                    >
                      <PlusIcon className="w-4 h-4" /> {t.libImport}
                    </button>
                  </div>
                  <p className="w-full text-[11px] text-gray-500 leading-relaxed">{t.libAsBlock}</p>
                </div>
              </>
            ) : (
              <p className="flex-1 flex items-center justify-center p-8 text-[13px] text-gray-400 text-center max-w-md mx-auto leading-relaxed">
                {t.libPickOne}
              </p>
            )}
            {note && (
              <p className="px-6 py-2 border-t text-[11px] text-blue-700 bg-white">{note}</p>
            )}
          </aside>
        </div>

        {incoming && (
          <div className="absolute inset-0 z-[10] bg-black/40 flex items-center justify-center p-6">
            <div className="bg-white rounded-lg shadow-2xl w-[30rem] max-w-full p-5 space-y-4">
              <div>
                <h4 className="text-sm font-semibold text-gray-900">{t.libImportFile}</h4>
                <p className="text-[12px] text-gray-600 mt-1">
                  {t.libImportAsk(incoming.symbols.length)}
                  {incoming.exportedOn && (
                    <span className="text-gray-400"> · {incoming.exportedOn.slice(0, 10)}</span>
                  )}
                </p>
              </div>
              <div className="flex flex-col gap-2">
                {([['merge', t.libImportMerge], ['replace', t.libImportReplace]] as const).map(
                  ([mode, label]) => (
                    <button
                      key={mode}
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          const done = await symbolLibraryService.importAll(incoming, mode);
                          await loadOfficeSymbols(true);
                          setNote(t.libImported(done.added, done.updated));
                          setIncoming(null);
                        } catch (err) {
                          setNote(err instanceof Error ? err.message : String(err));
                        } finally {
                          setBusy(false);
                        }
                      }}
                      className={`px-3 py-2 rounded-md text-sm text-start border disabled:opacity-40 ${
                        mode === 'replace'
                          ? 'border-red-300 text-red-800 bg-red-50 hover:bg-red-100'
                          : 'border-gray-300 text-gray-800 bg-white hover:bg-gray-50'}`}
                    >
                      {label}
                    </button>
                  ))}
              </div>
              <button
                onClick={() => setIncoming(null)}
                className="w-full px-3 py-2 rounded-md text-sm text-gray-600 hover:bg-gray-100"
              >
                {t.closeHelp}
              </button>
            </div>
          </div>
        )}

        {making && (
          <SymbolMaker
            t={t}
            lang={lang}
            theme={theme}
            kind={kind}
            selection={selection}
            editing={editing}
            onSaved={saved => {
              setMaking(false);
              setEditing(null);
              setKind(saved.kind);
              setPicked(`office:${saved.id}`);
              setNote(t.libSaved(saved.name));
            }}
            onClose={() => { setMaking(false); setEditing(null); }}
          />
        )}
      </div>
    </div>,
    document.body,
  );
};
