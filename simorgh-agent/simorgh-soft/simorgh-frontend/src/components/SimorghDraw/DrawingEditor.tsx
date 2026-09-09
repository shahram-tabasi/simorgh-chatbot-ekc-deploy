import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ZoomInIcon, ZoomOutIcon, MaximizeIcon, MousePointer2Icon, HandIcon,
  UndoIcon, RedoIcon, CopyIcon, Trash2Icon, GridIcon, RotateCcwIcon,
  EyeIcon, EyeOffIcon, LockIcon, UnlockIcon, DownloadIcon, ScanSearchIcon,
} from 'lucide-react';
import { Drawing, Layer, LAYER_NOTES, Shape, layerColor } from '../../utils/cad/shapes';
import { renderSvg } from '../../utils/cad/svg';
import { renderDxf } from '../../utils/cad/dxf';
import { LEGIBLE_MM, PaperChoice, textHeightOn } from '../../utils/cad/paper';
import { renderPdf } from '../../utils/cad/pdf';
import {
  History, boundsOfAll, deleteShapes, duplicateShapes, moveShapes, setText, withShapes,
} from '../../utils/cad/edit';
import { downloadBlob, downloadText, fileSafe } from '../../utils/download';
import { DrawingCanvas, Viewport, fitView, viewOn } from './DrawingCanvas';

// Simorgh Draw — the drawing, open for editing.
//
// The sheet arrives as geometry (see cad/shapes.ts), so editing it is editing
// an array of shapes: move, delete, duplicate, retype a label, switch a layer
// off. Every export then goes through the same array, which means what leaves
// as DXF or PDF is what is on the screen, edits and all — the thing that was
// impossible while the sheet was a string of SVG.

export interface EditorSheet { name: string; drawing: Drawing }

interface Props {
  sheets: EditorSheet[];
  /** Stem for downloaded file names. */
  fileBase: string;
  /** Lines for the title block on exported sheets. */
  titleBlock: string[];
  mmPerUnit?: number;
  /** The sheet exports are put on; 'auto' keeps `mmPerUnit` and grows the sheet. */
  paper?: PaperChoice;
}

const SNAPS = [0, 1, 5, 10, 25];

export const DrawingEditor: React.FC<Props> = ({
  sheets, fileBase, titleBlock, mmPerUnit = 0.5, paper: initialPaper = 'auto',
}) => {
  const [index, setIndex] = useState(0);
  const sheet = sheets[Math.min(index, Math.max(0, sheets.length - 1))];

  // Edits live per sheet, so paging through a set does not lose them.
  const [edits, setEdits] = useState<Record<number, Shape[]>>({});
  const histories = useRef(new Map<number, History<Shape[]>>());
  const historyFor = (i: number) => {
    if (!histories.current.has(i)) histories.current.set(i, new History<Shape[]>());
    return histories.current.get(i)!;
  };

  const shapes = edits[index] ?? sheet?.drawing.shapes ?? [];
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [hidden, setHidden] = useState<Set<Layer>>(new Set());
  const [locked, setLocked] = useState<Set<Layer>>(new Set());
  const [tool, setTool] = useState<'select' | 'pan'>('select');
  const [snap, setSnap] = useState(5);
  const [showGrid, setShowGrid] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [paper, setPaper] = useState<PaperChoice>(initialPaper);
  const [view, setView] = useState<Viewport>({ x: 0, y: 0, w: 1000, h: 600 });
  const [, forceRender] = useState(0);

  /** Replace the shapes, recording the step that got us here. */
  const commit = useCallback((next: Shape[], nextSelection?: Set<number>) => {
    historyFor(index).push(shapes);
    setEdits(e => ({ ...e, [index]: next }));
    if (nextSelection) setSelection(nextSelection);
    forceRender(n => n + 1);
  }, [index, shapes]);

  const fit = useCallback(() => {
    if (sheet) setView(fitView(sheet.drawing));
  }, [sheet]);

  // A new sheet starts fitted, with nothing picked.
  useEffect(() => { setSelection(new Set()); fit(); }, [index, sheets, fit]);

  const undo = () => {
    const h = historyFor(index);
    const previous = h.undo(shapes);
    if (previous) { setEdits(e => ({ ...e, [index]: previous })); setSelection(new Set()); forceRender(n => n + 1); }
  };
  const redo = () => {
    const h = historyFor(index);
    const next = h.redo(shapes);
    if (next) { setEdits(e => ({ ...e, [index]: next })); setSelection(new Set()); forceRender(n => n + 1); }
  };

  const remove = () => {
    if (selection.size === 0) return;
    commit(deleteShapes(shapes, selection), new Set());
  };
  const duplicate = () => {
    if (selection.size === 0) return;
    const { shapes: next, selection: picked } = duplicateShapes(shapes, selection);
    commit(next, new Set(picked));
  };
  const nudge = (dx: number, dy: number) => {
    if (selection.size === 0) return;
    commit(moveShapes(shapes, selection, dx, dy));
  };
  const revert = () => {
    historyFor(index).clear();
    setEdits(e => { const next = { ...e }; delete next[index]; return next; });
    setSelection(new Set());
    forceRender(n => n + 1);
  };

  const zoom = (factor: number) => setView(v => {
    const w = Math.min((sheet?.drawing.width ?? 1000) * 8, Math.max((sheet?.drawing.width ?? 1000) / 400, v.w * factor));
    const h = w * (v.h / v.w);
    return { x: v.x + (v.w - w) / 2, y: v.y + (v.h - h) / 2, w, h };
  });

  const zoomToSelection = () => {
    const box = boundsOfAll([...selection].map(i => shapes[i]).filter(Boolean));
    if (box) setView(viewOn(box));
  };

  // Keyboard, as a drawing office expects it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const step = e.shiftKey ? 10 : snap || 1;
      switch (e.key) {
        case 'Delete': case 'Backspace': e.preventDefault(); remove(); break;
        case 'Escape': setSelection(new Set()); break;
        case 'ArrowLeft':  e.preventDefault(); nudge(-step, 0); break;
        case 'ArrowRight': e.preventDefault(); nudge(step, 0); break;
        case 'ArrowUp':    e.preventDefault(); nudge(0, -step); break;
        case 'ArrowDown':  e.preventDefault(); nudge(0, step); break;
        case 'f': case 'F': fit(); break;
        case 'z': case 'Z':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
          break;
        case 'y': case 'Y':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); redo(); }
          break;
        case 'd': case 'D':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); duplicate(); }
          break;
        case 'a': case 'A':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            setSelection(new Set(shapes.map((s, i) => (hidden.has(s.layer) || locked.has(s.layer) ? -1 : i))
              .filter(i => i >= 0)));
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── Exports ───────────────────────────────────────────────────────────────
  // Every sheet goes out with its own edits applied, not just the one on show.
  const editedDrawing = (i: number) => {
    const s = sheets[i];
    const current = edits[i];
    return current ? withShapes(s.drawing, current) : s.drawing;
  };

  const exportDxf = () => {
    const drawing = editedDrawing(index);
    downloadText(`${fileSafe(fileBase)}_${fileSafe(sheet.name)}.dxf`,
      renderDxf(drawing, { mmPerUnit, paper, titleBlock: [...titleBlock, sheet.name] }), 'image/vnd.dxf');
  };
  const exportPdf = () => {
    downloadBlob(`${fileSafe(fileBase)}.pdf`,
      renderPdf(sheets.map((_, i) => editedDrawing(i)), { mmPerUnit, paper, titleBlock }));
  };
  const exportSvg = () => {
    downloadText(`${fileSafe(fileBase)}_${fileSafe(sheet.name)}.svg`,
      renderSvg(editedDrawing(index), { hidden }), 'image/svg+xml');
  };

  // ── Layers ────────────────────────────────────────────────────────────────
  const layers = useMemo(() => {
    const counts = new Map<Layer, number>();
    for (const s of shapes) counts.set(s.layer, (counts.get(s.layer) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [shapes]);

  const toggle = <T,>(set: Set<T>, value: T, apply: (s: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value); else next.add(value);
    apply(next);
  };

  // What the smallest label on this sheet comes out as, on the chosen paper.
  const smallest = useMemo(() => {
    const sizes = shapes.filter(s => s.t === 'text').map(s => (s as { size: number }).size);
    if (!sheet || sizes.length === 0) return null;
    return textHeightOn(sheet.drawing.width, sheet.drawing.height, paper, mmPerUnit, Math.min(...sizes));
  }, [shapes, sheet, paper, mmPerUnit]);

  const picked = [...selection].map(i => shapes[i]).filter(Boolean);
  const onlyText = picked.length === 1 && picked[0].t === 'text'
    ? (picked[0] as Extract<Shape, { t: 'text' }>) : null;
  const history = historyFor(index);
  // Undoing all the way back leaves the original array in place, not none of
  // it, so "edited" is a question of identity rather than of presence.
  const isEdited = (i: number) => {
    const current = edits[i];
    return Boolean(current) && current !== sheets[i]?.drawing.shapes;
  };
  const edited = isEdited(index);
  const mm = (v: number) => (v * mmPerUnit).toFixed(1);

  if (!sheet) {
    return <p className="p-6 text-sm text-gray-500">Nothing to draw yet.</p>;
  }

  const Tool: React.FC<{
    on?: () => void; active?: boolean; disabled?: boolean; title: string; children: React.ReactNode;
  }> = ({ on, active, disabled, title, children }) => (
    <button
      onClick={on} disabled={disabled} title={title}
      className={`p-1.5 rounded-md border text-sm transition-colors disabled:opacity-30 disabled:cursor-default ${
        active ? 'bg-slate-700 border-slate-700 text-white'
               : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-100'}`}
    >
      {children}
    </button>
  );

  const Divider = () => <span className="w-px h-6 bg-gray-300 mx-1" />;

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden bg-white select-none">
      {/* ── Toolbar ────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 flex-wrap px-3 py-2 bg-gray-50 border-b">
        {sheets.length > 1 && (
          <>
            <select
              className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
              value={index}
              onChange={e => setIndex(Number(e.target.value))}
            >
              {sheets.map((s, i) => (
                <option key={i} value={i}>{s.name}{isEdited(i) ? ' •' : ''}</option>
              ))}
            </select>
            <Divider />
          </>
        )}

        <Tool title="Select (Esc clears)" active={tool === 'select'} on={() => setTool('select')}>
          <MousePointer2Icon className="w-4 h-4" />
        </Tool>
        <Tool title="Pan (or hold Space)" active={tool === 'pan'} on={() => setTool('pan')}>
          <HandIcon className="w-4 h-4" />
        </Tool>
        <Divider />

        <Tool title="Zoom in" on={() => zoom(1 / 1.3)}><ZoomInIcon className="w-4 h-4" /></Tool>
        <Tool title="Zoom out" on={() => zoom(1.3)}><ZoomOutIcon className="w-4 h-4" /></Tool>
        <Tool title="Fit the sheet (F)" on={fit}><MaximizeIcon className="w-4 h-4" /></Tool>
        <Tool title="Zoom to selection" disabled={selection.size === 0} on={zoomToSelection}>
          <ScanSearchIcon className="w-4 h-4" />
        </Tool>
        <Divider />

        <Tool title="Undo (Ctrl+Z)" disabled={!history.canUndo} on={undo}><UndoIcon className="w-4 h-4" /></Tool>
        <Tool title="Redo (Ctrl+Shift+Z)" disabled={!history.canRedo} on={redo}><RedoIcon className="w-4 h-4" /></Tool>
        <Tool title="Duplicate (Ctrl+D)" disabled={selection.size === 0} on={duplicate}>
          <CopyIcon className="w-4 h-4" />
        </Tool>
        <Tool title="Delete (Del)" disabled={selection.size === 0} on={remove}>
          <Trash2Icon className="w-4 h-4" />
        </Tool>
        <Tool title="Revert this sheet to as drawn" disabled={!edited} on={revert}>
          <RotateCcwIcon className="w-4 h-4" />
        </Tool>
        <Divider />

        <Tool title="Show the grid" active={showGrid} on={() => setShowGrid(g => !g)}>
          <GridIcon className="w-4 h-4" />
        </Tool>
        <select
          className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
          value={snap}
          onChange={e => setSnap(Number(e.target.value))}
          title="Snap moves to this step"
        >
          {SNAPS.map(v => <option key={v} value={v}>{v === 0 ? 'no snap' : `snap ${v}`}</option>)}
        </select>

        <div className="ml-auto flex items-center gap-2">
          <select
            className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
            value={paper}
            onChange={e => setPaper(e.target.value as PaperChoice)}
            title="The sheet DXF and PDF are put on. 'Fit the drawing' keeps the scale and lets the sheet grow."
          >
            <option value="auto">fit the drawing</option>
            {(['A4', 'A3', 'A2', 'A1', 'A0'] as const).map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          {smallest != null && (
            <span
              className={`text-[11px] tabular-nums ${
                smallest < LEGIBLE_MM ? 'text-amber-700 font-medium' : 'text-gray-500'}`}
              title={smallest < LEGIBLE_MM
                ? `The smallest label plots at ${smallest.toFixed(2)} mm, under the ${LEGIBLE_MM} mm a drawing stays readable at. Fewer feeders to a sheet, or a bigger sheet.`
                : `The smallest label plots at ${smallest.toFixed(2)} mm.`}
            >
              text {smallest.toFixed(1)} mm
            </span>
          )}
          <button
            onClick={exportDxf}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-teal-700 text-white text-sm font-medium hover:bg-teal-800"
          >
            <DownloadIcon className="w-4 h-4" /> DXF
          </button>
          <button
            onClick={exportPdf}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-rose-700 text-white text-sm font-medium hover:bg-rose-800"
            title="Vector PDF, one page per sheet. Latin text only — use Print / PDF for Persian."
          >
            <DownloadIcon className="w-4 h-4" /> PDF
          </button>
          <button
            onClick={exportSvg}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-300 bg-white text-gray-700 text-sm font-medium hover:bg-gray-100"
          >
            <DownloadIcon className="w-4 h-4" /> SVG
          </button>
        </div>
      </div>

      {/* ── Canvas and panels ──────────────────────────────────────────── */}
      <div className="flex" style={{ height: 620 }}>
        <div className="flex-1 min-w-0 bg-slate-100">
          <DrawingCanvas
            drawing={sheet.drawing}
            shapes={shapes}
            selection={selection}
            hidden={hidden}
            locked={locked}
            view={view}
            grid={snap}
            showGrid={showGrid}
            tool={tool}
            onView={setView}
            onSelection={setSelection}
            onMove={(dx, dy) => nudge(dx, dy)}
            onCursor={setCursor}
            onEditText={i => {
              const current = shapes[i];
              if (current.t !== 'text') return;
              const value = window.prompt('Text', current.s);
              if (value !== null && value !== current.s) commit(setText(shapes, i, value));
            }}
          />
        </div>

        <aside className="w-64 shrink-0 border-l bg-white overflow-y-auto">
          <div className="px-3 py-2 border-b">
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Layers</h4>
          </div>
          <ul className="divide-y">
            {layers.map(([layer, count]) => (
              <li key={layer} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50">
                <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: layerColor(layer) }} />
                <span className="flex-1 min-w-0 truncate" title={LAYER_NOTES[layer] ?? layer}>{layer}</span>
                <span className="text-[11px] text-gray-400 tabular-nums">{count}</span>
                <button
                  onClick={() => toggle(hidden, layer, setHidden)}
                  title={hidden.has(layer) ? 'Show this layer' : 'Hide this layer'}
                  className="p-0.5 text-gray-500 hover:text-gray-900"
                >
                  {hidden.has(layer) ? <EyeOffIcon className="w-3.5 h-3.5" /> : <EyeIcon className="w-3.5 h-3.5" />}
                </button>
                <button
                  onClick={() => toggle(locked, layer, setLocked)}
                  title={locked.has(layer) ? 'Unlock this layer' : 'Lock this layer'}
                  className="p-0.5 text-gray-500 hover:text-gray-900"
                >
                  {locked.has(layer) ? <LockIcon className="w-3.5 h-3.5" /> : <UnlockIcon className="w-3.5 h-3.5" />}
                </button>
              </li>
            ))}
          </ul>

          <div className="px-3 py-2 border-y bg-gray-50">
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Selection</h4>
          </div>
          <div className="px-3 py-2 text-sm text-gray-700 space-y-2">
            {picked.length === 0 && (
              <p className="text-gray-400 text-[13px] leading-relaxed">
                Click something to pick it, or drag a box around several.
                Double-click a label to retype it.
              </p>
            )}
            {picked.length === 1 && (
              <>
                <Row label="Type" value={picked[0].t} />
                <Row label="Layer" value={picked[0].layer} />
                {onlyText ? (
                  <label className="block">
                    <span className="text-[11px] text-gray-500">Text</span>
                    <input
                      className="w-full mt-0.5 border border-gray-300 rounded px-2 py-1 text-sm"
                      value={onlyText.s}
                      onChange={e => {
                        const value = e.target.value;
                        setEdits(prev => ({ ...prev, [index]: setText(shapes, [...selection][0], value) }));
                      }}
                      onFocus={() => historyFor(index).push(shapes)}
                    />
                  </label>
                ) : null}
              </>
            )}
            {picked.length > 1 && <Row label="Picked" value={`${picked.length} shapes`} />}
          </div>
        </aside>
      </div>

      {/* ── Status bar ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 px-3 py-1.5 border-t bg-gray-50 text-[11px] text-gray-500 tabular-nums">
        <span>{sheet.name}</span>
        <span>{mm(sheet.drawing.width)} × {mm(sheet.drawing.height)} mm</span>
        <span>{cursor ? `X ${mm(cursor.x)}  Y ${mm(cursor.y)} mm` : '—'}</span>
        <span>zoom {Math.round((sheet.drawing.width / view.w) * 100)}%</span>
        <span>{shapes.length} shapes</span>
        {selection.size > 0 && <span className="text-blue-700">{selection.size} picked</span>}
        {edited && <span className="text-amber-700">edited</span>}
        <span className="ml-auto">Space pans · wheel zooms · F fits · Ctrl+Z undoes</span>
      </div>
    </div>
  );
};

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex justify-between gap-2">
    <span className="text-[11px] text-gray-500">{label}</span>
    <span className="text-[13px] text-gray-800 truncate">{value}</span>
  </div>
);
