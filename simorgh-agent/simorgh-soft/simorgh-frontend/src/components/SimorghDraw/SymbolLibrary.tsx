import React, { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  XIcon, SearchIcon, UploadIcon, Maximize2Icon, Minimize2Icon, PlusIcon,
} from 'lucide-react';
import { SYMBOL_GROUPS } from '../../utils/iecSymbols';
import { Shape } from '../../utils/cad/shapes';
import { drawingFromSvg } from '../../utils/cad/fromSvg';
import { renderFragment } from '../../utils/cad/svg';
import { readDxf } from '../../utils/cad/readDxf';
import { loadDxfSymbols } from '../../utils/cad/dxfSymbols';
import { LibraryItem, iecItems, packItems, shapesOf } from '../../utils/cad/symbolSource';
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
}

export const SymbolLibrary: React.FC<Props> = ({ t, lang, theme, onImport, onClose }) => {
  const [query, setQuery] = useState('');
  const [big, setBig] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [fromFile, setFromFile] = useState<LibraryItem[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const items = useMemo(
    () => [...iecItems(), ...packItems(loadDxfSymbols()), ...fromFile],
    [fromFile]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = q
      ? items.filter(i => i.name.toLowerCase().includes(q) || i.group.toLowerCase().includes(q))
      : items;
    // Grouped the way the Symbols screen groups them, so the two read alike.
    const by = new Map<string, LibraryItem[]>();
    for (const i of hit) {
      const list = by.get(i.group);
      if (list) list.push(i); else by.set(i.group, [i]);
    }
    return [...by.entries()].sort((a, b) => {
      const ai = SYMBOL_GROUPS.indexOf(a[0] as never);
      const bi = SYMBOL_GROUPS.indexOf(b[0] as never);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  }, [items, query]);

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
            name, source: 'File', group: 'From this computer',
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
            name, source: 'File', group: 'From this computer',
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

  // Through a portal, like the cell editor: the editor can be inside a window
  // that is itself positioned, and `fixed` inside a positioned ancestor is not
  // fixed to the viewport at all. Drawn on the body it always fills the screen.
  return createPortal(
    <div className="fixed inset-0 z-[250] bg-black/50 flex items-center justify-center p-4">
      <div
        data-sd-theme={theme}
        dir={dirOf(lang)}
        data-symbol-library
        className={`bg-white rounded-lg shadow-2xl flex flex-col overflow-hidden ${
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

        {/* ── The list, and what is picked ─────────────────────────────── */}
        <div className="flex-1 flex min-h-0">
          <div className="flex-1 min-w-0 overflow-y-auto p-4 space-y-5 bg-white">
            {shown.length === 0 && (
              <p className="text-sm text-gray-500">{t.libNoneFound}</p>
            )}
            {shown.map(([group, list]) => (
              <div key={group}>
                <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  {group} <span className="text-gray-400">· {list.length}</span>
                </p>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2.5">
                  {list.map(item => (
                    <button
                      key={item.key}
                      data-lib-item={item.name}
                      onClick={() => setPicked(item.key)}
                      onDoubleClick={() => place(item)}
                      title={`${item.name} — ${t.libDoubleClick}`}
                      className={`text-start border rounded-md p-2 bg-white transition ${
                        picked === item.key
                          ? 'border-blue-500 ring-2 ring-blue-200'
                          : 'border-gray-200 hover:border-blue-400 hover:shadow-sm'}`}
                    >
                      <Preview item={item} size={58} />
                      <p className="text-[11px] text-gray-800 leading-tight mt-1 line-clamp-2">
                        {item.name}
                      </p>
                      <p className="text-[10px] text-gray-400">{item.source}</p>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <aside className="w-72 shrink-0 border-s bg-white flex flex-col">
            <div className="px-3 py-2 border-b bg-gray-50">
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                {t.selection}
              </h4>
            </div>
            {chosen ? (
              <div className="p-3 space-y-3 flex-1 overflow-y-auto">
                <div className="border border-gray-200 rounded p-3 bg-white">
                  <Preview item={chosen} size={150} />
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-800">{chosen.name}</p>
                  <p className="text-[11px] text-gray-500">
                    {chosen.source} · {chosen.group} · {Math.round(chosen.width)} × {Math.round(chosen.height)}
                  </p>
                </div>
                <button
                  onClick={() => place(chosen)}
                  data-lib-import
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
                >
                  <PlusIcon className="w-4 h-4" /> {t.libImport}
                </button>
                <p className="text-[11px] text-gray-500 leading-relaxed">{t.libAsBlock}</p>
              </div>
            ) : (
              <p className="p-4 text-[13px] text-gray-400 leading-relaxed">{t.libPickOne}</p>
            )}
            {note && (
              <p className="px-3 py-2 border-t text-[11px] text-blue-700 bg-gray-50">{note}</p>
            )}
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  );
};
