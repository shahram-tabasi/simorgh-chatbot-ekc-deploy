import React, { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PencilRulerIcon, PlusIcon, Trash2Icon, UploadIcon, XIcon } from 'lucide-react';

import { Drawing, Shape } from '../../utils/cad/shapes';
import { drawingFromSvg } from '../../utils/cad/fromSvg';
import { renderFragment } from '../../utils/cad/svg';
import { readDxf } from '../../utils/cad/readDxf';
import { boundsOfAll, fingerprint } from '../../utils/cad/edit';
import { translateShape } from '../../utils/cad/shapes';
import { MARK_R, terminalMarks } from '../../utils/cad/terminals';
import { OfficeSymbol, symbolLibraryService } from '../../services/projectService';
import { newSymbolId, rememberOfficeSymbol } from '../../utils/cad/officeSymbols';
import {
  LibraryKind, SYMBOL_LIBRARIES, defaultGroup, libraryOf,
} from '../../utils/cad/symbolLibraries';
import { DrawingEditor, EditorSheet } from './DrawingEditor';
import { Strings, dirOf, Lang } from './lang';
import { ThemeId } from './theme';

// Adding a symbol to the office's library.
//
// EPLAN does this in a separate application: you leave the drawing, open the
// symbol editor, draw in a different coordinate system, place connection points
// through a dialog, save into a symbol library file, and come back. Every one
// of those steps is a place to give up, and the result is that most offices
// have the symbols they were shipped and a folder of DXFs nobody filed.
//
// Here it is three things on one screen: where the geometry comes from, what
// to call it, and where a wire may land on it. The geometry can come straight
// off the drawing — pick the thing you have just drawn, press New symbol, and
// it is in the library — which is the step EPLAN does not have and the reason
// this is quicker rather than merely prettier.
//
// The connection points are not optional decoration. A symbol without them can
// be placed and can be looked at, and nothing can be wired to it: it will
// never appear in a connection list or a terminal diagram. So they are the
// largest thing on this screen, and the dialog says plainly what is lost by
// leaving them out rather than quietly letting it happen.

interface Props {
  t: Strings;
  lang: Lang;
  theme: ThemeId;
  /** Which library the panel was on, as the starting choice. */
  kind: LibraryKind;
  /** What is picked on the sheet right now, if anything. */
  selection?: Shape[];
  /** The symbol being changed, when this opened on an existing one. */
  editing?: OfficeSymbol | null;
  /** The shelf to start on, when this was opened from one. */
  group?: string;
  /**
   * A symbol to start from, when this was opened as "add a variant".
   *
   * A breaker's LSI, LSIG and LI are the same drawing with a different name —
   * and drawing the same breaker three times is how three slightly different
   * breakers end up in a library. So the geometry and the connection points
   * come across, and what is left to do is the name.
   */
  from?: { art: string; width: number; height: number; terminals?: { x: number; y: number; name: string }[]; name: string };
  onSaved: (symbol: OfficeSymbol) => void;
  onClose: () => void;
}

interface Geometry {
  art: string;
  width: number;
  height: number;
  /** Where it came from, for the line under the preview. */
  from: string;
}

/**
 * Shapes as a symbol's geometry: moved to the origin and measured.
 *
 * A symbol is placed by its own coordinates, so geometry that happens to have
 * been drawn at x=840 on an A1 sheet has to come back to zero first, or the
 * symbol is mostly empty space with the ink in one corner.
 */
function geometryOf(shapes: Shape[], from: string): Geometry | null {
  if (shapes.length === 0) return null;
  const box = boundsOfAll(shapes);
  if (!box) return null;
  const moved = shapes.map(s => translateShape(s, -box.x, -box.y));
  const width = Math.max(1, box.w);
  const height = Math.max(1, box.h);
  const d = new Drawing(width, height, 'symbol');
  for (const s of moved) d.add(s);
  return { art: renderFragment(d), width, height, from };
}

/** A blank symbol's sheet, in the units a single-line symbol is drawn in. */
const BLANK = 40;

/**
 * A sheet of shapes read back as a symbol: its ink, and its terminals.
 *
 * The two are told apart by the connection point's name, which is what a
 * terminal *is* here — the ink is everything that does not carry one. They are
 * measured together but framed on the ink alone: a connection point sits on
 * the very edge of a symbol, and the ring drawn round it is a mark on the
 * screen rather than part of the device, so letting it push the frame out
 * would move the conductor a little further from the symbol every time it was
 * opened and saved.
 */
function symbolFromShapes(shapes: Shape[], from: string): {
  geometry: Geometry; terminals: { x: number; y: number; name: string }[];
} | null {
  const pins = shapes.filter(s => s.pin);
  const ink = shapes.filter(s => !s.pin);
  const box = boundsOfAll(ink.length ? ink : shapes);
  if (!box) return null;
  const geometry = geometryOf(ink, from);
  if (!geometry) return null;
  return {
    geometry,
    terminals: pins.map((s, i) => {
      const p = pointOf(s);
      return {
        x: round(p[0] - box.x),
        y: round(p[1] - box.y),
        name: String(s.pin ?? i + 1),
      };
    }),
  };
}

export const SymbolMaker: React.FC<Props> = ({
  t, lang, theme, kind: openOn, selection, editing, group: openGroup, from,
  onSaved, onClose,
}) => {
  const file = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(editing?.name ?? '');
  const [kind, setKind] = useState<LibraryKind>(editing?.kind ?? openOn);
  const [group, setGroup] = useState(
    editing?.group ?? openGroup ?? defaultGroup(openOn));
  const [geometry, setGeometry] = useState<Geometry | null>(
    editing
      ? { art: editing.art, width: editing.width, height: editing.height, from: t.libEdit }
      : from
        ? { art: from.art, width: from.width, height: from.height, from: from.name }
        : null);
  const [terminals, setTerminals] = useState<{ x: number; y: number; name: string }[]>(
    editing?.terminals ?? from?.terminals ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  /** Whether the drawing page has been saved back since it was opened. */
  const [drawn, setDrawn] = useState(false);

  /**
   * The symbol as a sheet for the drawing page.
   *
   * Nothing here changes while the page is open — it is on top of this dialog
   * — so the sheet is built once on the way in and read back once on the way
   * out, and the editor keeps its own history in between.
   */
  const sheets = useMemo<EditorSheet[]>(() => {
    const w = geometry?.width ?? BLANK;
    const h = geometry?.height ?? BLANK;
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${geometry?.art ?? ''}</svg>`;
    const d = drawingFromSvg(markup, 'symbol');
    // The terminals go on as the PIN shapes they become: placed with the
    // connection-point tool, moved with everything else, read back by name.
    for (const mark of terminalMarks(terminals)) d.add(mark);
    return [{
      name: name.trim() || t.libDrawTitle,
      drawing: d,
      key: 'symbol',
      drawnAs: fingerprint(markup),
      kind,
    }];
  }, [drawing]);  // eslint-disable-line react-hooks/exhaustive-deps

  const takeSelection = () => {
    const got = geometryOf(selection ?? [], t.libFromSelection);
    if (!got) { setError(t.libNoSelection); return; }
    setError(null);
    setGeometry(got);
    // Geometry off the sheet keeps whatever points it already carried — a
    // symbol built out of two library symbols has four terminals, and asking
    // for them again would be asking somebody to retype what is in front of
    // them.
    const box = boundsOfAll(selection ?? []);
    if (box) {
      const carried = (selection ?? [])
        .filter(s => s.pin)
        .map(s => {
          const p = pointOf(s);
          return { x: p[0] - box.x, y: p[1] - box.y, name: String(s.pin) };
        });
      if (carried.length) setTerminals(carried);
    }
  };

  const readFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const text = await f.text();
      const stem = f.name.replace(/\.[^.]+$/, '');
      if (/\.dxf$/i.test(f.name)) {
        const read = readDxf(text, f.name);
        const got = geometryOf(read.drawing.shapes, f.name);
        if (!got) { setError(t.libNeedsArt); return; }
        setGeometry(got);
        // A DXF that declared a CONN layer has already said where its
        // terminals are; that is the file's own answer and better than a guess.
        const box = boundsOfAll(read.drawing.shapes);
        if (box && read.connections.length) {
          setTerminals(read.connections.map(([x, y], i) => ({
            x: x - box.x, y: y - box.y, name: String(i + 1),
          })));
        }
      } else if (/\.svg$/i.test(f.name)) {
        const d = drawingFromSvg(text, stem);
        const got = geometryOf(d.shapes, f.name);
        if (!got) { setError(t.libNeedsArt); return; }
        setGeometry(got);
      } else {
        setError(t.libNeedsArt);
        return;
      }
      setError(null);
      if (!name.trim()) setName(stem);
    } catch {
      setError(t.libNeedsArt);
    }
  };

  /**
   * Margin round the drawing, in its own units.
   *
   * A connection point almost always sits on the very edge of a symbol — that
   * is where a wire reaches it — so a preview drawn edge to edge cuts every
   * ring in half and puts its name outside the picture. The margin is part of
   * the view, not of the symbol: it is added to the viewBox and taken back off
   * again when a click is turned into a coordinate.
   */
  const pad = geometry ? Math.max(geometry.width, geometry.height) * 0.1 + 2 : 0;

  /** A click on the preview puts a connection point where it landed. */
  const addTerminal = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!geometry) return;
    const box = e.currentTarget.getBoundingClientRect();
    // The preview keeps the symbol's aspect ratio inside its box, so the
    // drawing coordinates come back through the same fit rather than through
    // the box's own width — otherwise every point lands offset by the letter-
    // boxing, which looks like the click being ignored.
    const w = geometry.width + pad * 2;
    const h = geometry.height + pad * 2;
    const scale = Math.min(box.width / w, box.height / h);
    const x = (e.clientX - box.left - (box.width - w * scale) / 2) / scale - pad;
    const y = (e.clientY - box.top - (box.height - h * scale) / 2) / scale - pad;
    setTerminals(list => [...list, {
      x: round(x), y: round(y), name: String(list.length + 1),
    }]);
  };

  const save = async () => {
    if (!name.trim()) { setError(t.libNeedsName); return; }
    if (!geometry) { setError(t.libNeedsArt); return; }
    setSaving(true);
    setError(null);
    try {
      const symbol: OfficeSymbol = {
        id: editing?.id ?? newSymbolId(name),
        name: name.trim(),
        kind,
        group: group.trim() || defaultGroup(kind),
        art: geometry.art,
        width: geometry.width,
        height: geometry.height,
        terminals,
      };
      const kept = await symbolLibraryService.save(symbol);
      rememberOfficeSymbol(kept);
      onSaved(kept);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const groups = libraryOf(kind).groups;

  return createPortal(
    <div className="fixed inset-0 z-[260] bg-black/50 flex items-center justify-center p-4">
      <div
        data-sd-theme={theme}
        dir={dirOf(lang)}
        className="bg-white rounded-lg shadow-2xl w-[1000px] max-w-full h-[82vh] max-h-full flex flex-col overflow-hidden"
      >
        <div className="flex items-center gap-3 px-4 py-2.5 bg-gray-50 border-b">
          <h3 className="text-sm font-semibold text-gray-800">
            {editing ? `${t.libEdit} — ${editing.name}` : t.libNew}
          </h3>
          <p className="text-[11px] text-gray-500 hidden sm:block">{t.libNewNote}</p>
          <button
            onClick={onClose}
            className="ms-auto p-1.5 rounded text-gray-500 hover:bg-gray-200"
            title={t.closeHelp}
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* ── The drawing, and the points on it ───────────────────────── */}
          <div className="flex-1 min-w-0 flex flex-col bg-gray-50 border-e">
            <div className="flex items-center gap-2 px-3 py-2 border-b bg-white">
              <button
                onClick={() => file.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-100"
              >
                <UploadIcon className="w-4 h-4" /> {t.libFromFile}
              </button>
              <button
                onClick={takeSelection}
                disabled={!selection?.length}
                title={t.libFromSelectionNote}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-40"
              >
                <PlusIcon className="w-4 h-4" /> {t.libFromSelection}
                {selection?.length ? <span className="text-[11px] text-gray-400">{selection.length}</span> : null}
              </button>
              <button
                onClick={() => { setDrawn(false); setDrawing(true); }}
                title={t.libDrawNote}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-amber-300 bg-amber-50 text-sm text-amber-800 hover:bg-amber-100"
              >
                <PencilRulerIcon className="w-4 h-4" /> {t.libDraw}
              </button>
              <input
                ref={file}
                type="file"
                accept=".dxf,.svg"
                className="hidden"
                onChange={e => { readFile(e.target.files?.[0]); e.target.value = ''; }}
              />
              {geometry && (
                <span className="ms-auto text-[11px] text-gray-500">
                  {Math.round(geometry.width)} × {Math.round(geometry.height)} · {geometry.from}
                </span>
              )}
            </div>

            <div className="flex-1 min-h-0 p-6 flex items-center justify-center">
              {geometry ? (
                <svg
                  viewBox={`${-pad} ${-pad} ${geometry.width + pad * 2} ${geometry.height + pad * 2}`}
                  preserveAspectRatio="xMidYMid meet"
                  onClick={addTerminal}
                  className="w-full h-full cursor-crosshair bg-white rounded border border-gray-200"
                >
                  <g dangerouslySetInnerHTML={{ __html: geometry.art }} />
                  {terminals.map((p, i) => (
                    <g key={i}>
                      <circle
                        cx={p.x} cy={p.y} r={MARK_R * 1.6}
                        fill="none" stroke="#ea580c"
                        strokeWidth={Math.max(0.4, geometry.width / 120)}
                      />
                      <text
                        x={p.x + MARK_R * 2.2} y={p.y - MARK_R}
                        fontSize={Math.max(2.4, geometry.height / 12)}
                        fill="#ea580c"
                      >
                        {p.name}
                      </text>
                    </g>
                  ))}
                </svg>
              ) : (
                <p className="text-sm text-gray-400 text-center max-w-xs">{t.libNeedsArt}</p>
              )}
            </div>
          </div>

          {/* ── What it is called, and where wires land ─────────────────── */}
          <aside className="w-[22rem] shrink-0 flex flex-col bg-white overflow-y-auto">
            <div className="p-4 space-y-3 border-b">
              <label className="block">
                <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{t.libName}</span>
                <input
                  autoFocus
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                />
              </label>

              <div>
                <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{t.libWhichLibrary}</span>
                <div className="mt-1 flex gap-1">
                  {SYMBOL_LIBRARIES.map(lib => (
                    <button
                      key={lib.kind}
                      onClick={() => {
                        setKind(lib.kind);
                        if (!libraryOf(lib.kind).groups.includes(group)) setGroup(defaultGroup(lib.kind));
                      }}
                      className={`flex-1 px-2 py-1.5 rounded border text-sm ${
                        kind === lib.kind
                          ? 'border-blue-500 bg-blue-50 text-blue-800 font-medium'
                          : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'}`}
                    >
                      {lib.code}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{t.libGroup}</span>
                {/* The shelves this library has, and a box for one it does not.
                    An office's own shelf is as legitimate as the ones shipped —
                    the list is a starting point, not a fence — so typing a name
                    nobody has used makes that shelf, and it appears in the panel
                    as soon as something is on it. */}
                <select
                  value={groups.includes(group) ? group : '__new'}
                  onChange={e => setGroup(e.target.value === '__new' ? '' : e.target.value)}
                  className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                >
                  {groups.map(g => <option key={g} value={g}>{g}</option>)}
                  <option value="__new">{t.libNewGroup}</option>
                </select>
                {!groups.includes(group) && (
                  <input
                    autoFocus
                    value={group}
                    onChange={e => setGroup(e.target.value)}
                    placeholder={t.libNewGroupName}
                    className="mt-1.5 w-full border border-violet-300 rounded px-2 py-1.5 text-sm"
                  />
                )}
              </div>
            </div>

            <div className="p-4 space-y-2 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                  {t.libTerminalsTitle}
                </span>
                <span className="text-[11px] text-gray-400">{t.libPoints(terminals.length)}</span>
              </div>
              <p className="text-[11px] text-gray-500 leading-relaxed">{t.libTerminalsNote}</p>

              {terminals.length === 0 ? (
                <p className="text-[12px] text-orange-700 bg-orange-50 border border-orange-200 rounded px-2 py-1.5">
                  {t.libAddTerminal}
                </p>
              ) : (
                <ul className="space-y-1">
                  {terminals.map((p, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full border border-orange-500 text-orange-600 text-[10px] flex items-center justify-center shrink-0">
                        {i + 1}
                      </span>
                      <input
                        value={p.name}
                        onChange={e => setTerminals(list => list.map(
                          (q, j) => (j === i ? { ...q, name: e.target.value } : q)))}
                        className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1 text-sm"
                      />
                      <span className="text-[10px] text-gray-400 font-mono shrink-0">
                        {p.x} , {p.y}
                      </span>
                      <button
                        onClick={() => setTerminals(list => list.filter((_, j) => j !== i))}
                        className="p-1 rounded text-red-600 hover:bg-red-50 shrink-0"
                        title={t.libDelete}
                      >
                        <Trash2Icon className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="p-4 border-t space-y-2">
              {error && (
                <p className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">
                  {error}
                </p>
              )}
              <button
                onClick={save}
                disabled={saving || !geometry || !name.trim()}
                className="w-full px-3 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40"
              >
                {saving ? t.libSaving : t.libSave}
              </button>
            </div>
          </aside>
        </div>
      </div>

      {/* ── The drawing page, on top of all of it ─────────────────────────
          Not a second, smaller editor: the editor. Trim, extend, corner, the
          grips, the symbol library, the layers and the connection-point tool,
          on the symbol — which is the whole of what a symbol editor is and the
          reason EPLAN ships a separate application to do it. Here it is the
          same canvas, so anything learnt on a sheet is already known here. */}
      {drawing && (
        <div className="fixed inset-0 z-[300] bg-slate-900/70 flex flex-col p-3">
          <div className="flex items-center gap-3 px-4 py-2 bg-slate-800 text-white rounded-t-lg">
            <PencilRulerIcon className="w-4 h-4 shrink-0" />
            <span className="text-sm font-semibold truncate">
              {name.trim() || t.libDrawTitle}
            </span>
            <span className="text-[11px] text-slate-300 truncate hidden md:block">
              {t.libDrawNote}
            </span>
            <button
              onClick={() => {
                // Leaving without saving loses the drawing, so it is said out
                // loud rather than found out afterwards.
                if (!drawn && !window.confirm(t.libDrawLose)) return;
                setDrawing(false);
              }}
              className="ms-auto flex items-center gap-1.5 px-3 py-1.5 rounded bg-white/15 text-white text-xs font-medium hover:bg-white/25"
            >
              <XIcon className="w-3.5 h-3.5" /> {t.libDrawDone}
            </button>
          </div>
          <div className="flex-1 min-h-0 bg-white rounded-b-lg overflow-hidden">
            <DrawingEditor
              sheets={sheets}
              fileBase={`symbol_${name.trim() || 'new'}`}
              titleBlock={[name.trim() || t.libDrawTitle, t.libNew]}
              mmPerUnit={1}
              // The editor's Save hands the sheet back; here the sheet is the
              // symbol, so saving it is the symbol taking the new drawing.
              onSaveEdits={next => {
                const edited = next.symbol;
                if (!edited) return;
                const got = symbolFromShapes(edited.shapes, t.libDraw);
                if (!got) { setError(t.libNeedsArt); setDrawing(false); return; }
                setGeometry(got.geometry);
                setTerminals(got.terminals);
                setError(null);
                setDrawn(true);
              }}
            />
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
};

const round = (v: number) => Math.round(v * 10) / 10;

/** A shape's own point, for carrying a connection point across. */
function pointOf(s: Shape): [number, number] {
  switch (s.t) {
    case 'circle':
    case 'ellipse':
    case 'arc': return [s.cx, s.cy];
    case 'rect': return [s.x + s.w / 2, s.y + s.h / 2];
    case 'line': return [(s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2];
    case 'curve': return [(s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2];
    case 'text': return [s.x, s.y];
    case 'poly': {
      const xs = s.pts.map(p => p[0]);
      const ys = s.pts.map(p => p[1]);
      return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    }
  }
}
