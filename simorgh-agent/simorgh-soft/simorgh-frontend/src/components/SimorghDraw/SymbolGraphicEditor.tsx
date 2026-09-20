import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftIcon, ArrowDownIcon, ArrowRightIcon, ArrowUpIcon, FileInputIcon,
  PlusIcon, RotateCcwIcon, SaveIcon, Trash2Icon, XIcon,
} from 'lucide-react';
import { SymbolArtOverride } from '../../types/project';
import { CELL, IEC_SYMBOLS, SymbolId } from '../../utils/iecSymbols';
import { symbolDrawing } from '../../utils/cad/symbolArt';
import { renderFragment } from '../../utils/cad/svg';
import { boundsOfAll, fingerprint, withShapes } from '../../utils/cad/edit';
import { Drawing, Shape } from '../../utils/cad/shapes';
import { drawingFromSvg } from '../../utils/cad/fromSvg';
import { readDxf } from '../../utils/cad/readDxf';
import { terminalMarks } from '../../utils/cad/terminals';
import {
  PinDir, SymbolPin, cellsOf, defaultPins, fitIntoFrame, frameGuides, symbolFrame,
} from '../../utils/cad/symbolFrame';
import { DrawingEditor, EditorSheet } from './DrawingEditor';
import { Strings, dirOf, Lang } from './lang';

// The graphic page for one symbol.
//
// The same canvas the sheets are edited on, opened on a single symbol: move a
// line, retype a label, bring in the office's own drawing of the device,
// delete what the office does not draw. What comes out is kept with the
// project and takes the place of the library's symbol wherever that symbol is
// used — the same thing a file in the symbol pack does, from the other end.
//
// It used to be that canvas and nothing else, and that was the whole trouble.
// A symbol is not a picture: it is a picture **placed by arithmetic**, and the
// arithmetic reads three things off the drawing — how tall it is, where its
// conductor runs, and which points a wire may land on. None of the three were
// on the screen. So:
//
//   * **the frame is drawn.** The box the symbol has to fit, the conductor it
//     hangs on, and where the current enters and leaves it. Under the ink,
//     out of reach: it cannot be picked up, dragged or deleted, because a
//     boundary that can be deleted is gone the first time somebody selects all
//     and presses Delete. See `utils/cad/symbolFrame`.
//   * **a DXF replaces the drawing rather than joining it.** The editor's own
//     ribbon has an Import DXF that drops geometry where the view happens to
//     be — right for a supplier's terminal rail on a sheet, wrong here, where
//     the file *is* the symbol. Brought in through the ribbon it landed beside
//     the old drawing at whatever offset the pan had, both were saved, and the
//     device came out drawn twice. That button is taken away on this page and
//     this one put in its place: read the file, fit it to the frame, and put
//     it where the old drawing was.
//   * **the terminals are the draughtsman's.** They used to be worked out —
//     two, on the conductor, at the top and bottom of whatever box the art
//     had. Right for a breaker, wrong for everything fed from the side, and a
//     wire drawn to one of those joined nothing. They are placed, named and
//     turned here, and the direction is carried onto the sheet so the wire
//     leaves the way the device is wired rather than back through itself.
//
// Its own bar carries the commands the page is for — Save and back — at the
// top where they can be seen. They were in the drawing editor's ribbon, as a
// disc among thirty other pictures, at the top of a canvas 620 pixels tall
// inside a panel a third of that: the lower half of the symbol could not be
// reached and the way out was below the window. That is what `embedded` fixes
// on the editor's side; this bar is the other half of it.

interface Props {
  symbolId: SymbolId;
  /** The project's own drawing of it, when there is one. */
  override?: SymbolArtOverride;
  t: Strings;
  lang: Lang;
  onSave: (art: SymbolArtOverride) => void;
  /** Put the library's own symbol back. */
  onReset: () => void;
  onClose: () => void;
  /**
   * Draw it into the panel it was opened from instead of over everything.
   *
   * A window on top hides the list the symbol was picked out of, and the row
   * of its variants beside it — which is half of what somebody redrawing a
   * symbol is looking at.
   */
  inline?: boolean;
}

/** The ink and the connection points, told apart the way a sheet keeps them. */
const inkOf = (run: Shape[]) => run.filter(s => !s.pin);
const pinsOf = (run: Shape[]): SymbolPin[] => run
  .filter(s => s.pin)
  .map(s => {
    const at = s.t === 'circle' ? [s.cx, s.cy]
      : s.t === 'rect' ? [s.x + s.w / 2, s.y + s.h / 2]
      : s.t === 'text' ? [s.x, s.y]
      : s.t === 'line' ? [(s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2]
      : [0, 0];
    return {
      x: Math.round(at[0] * 100) / 100,
      y: Math.round(at[1] * 100) / 100,
      name: String(s.pin ?? ''),
      dir: (s.pinDir ?? 'down') as PinDir,
    };
  });

const DIR_ICON: Record<PinDir, React.FC<{ className?: string }>> = {
  up: ArrowUpIcon, down: ArrowDownIcon, left: ArrowLeftIcon, right: ArrowRightIcon,
};
const DIRS: PinDir[] = ['up', 'down', 'left', 'right'];

export const SymbolGraphicEditor: React.FC<Props> = ({
  symbolId, override, t, lang, onSave, onReset, onClose, inline,
}) => {
  const { drawing, pinX, markup } = useMemo(
    () => symbolDrawing(symbolId, override), [symbolId, override]);

  /**
   * The box the symbol has to be drawn inside, and where its conductor runs.
   *
   * Taken from the drawing the page actually opened on rather than from the
   * library, so a symbol already redrawn once keeps the frame it was redrawn
   * in. Opening it again in a different box would move the conductor, and the
   * conductor is the one thing that must not move.
   */
  const frame = useMemo(() => symbolFrame(symbolId, {
    width: drawing.width, height: drawing.height, pinX,
  }), [symbolId, drawing.width, drawing.height, pinX]);

  /**
   * Two views of the same sheet, and they are not the same job.
   *
   * `seed` is what the canvas is *started* from. It changes only when the
   * whole drawing is replaced — a DXF imported over it, a terminal added,
   * renamed or turned — because that is how the editor is told to start
   * again, and `rev` is the count that says it happened.
   *
   * `live` is what the canvas holds right now, reported back on every stroke.
   * The terminal list is read off it, so a point dragged with the mouse is the
   * point this panel renames rather than the copy handed in at the top.
   *
   * They must not be the same value. Feeding every stroke back in as a new
   * seed would restart the editor under the pencil and throw away its undo
   * stack on each line drawn.
   */
  const [seed, setSeed] = useState<Shape[]>(() => [
    ...inkOf(drawing.shapes),
    ...terminalMarks(
      override?.terminals?.length
        ? override.terminals
        : defaultPins(symbolFrame(symbolId, override && {
          width: override.width, height: override.height, pinX: override.pinX,
        }))),
  ]);
  const [live, setLive] = useState<Shape[]>(seed);
  const [rev, setRev] = useState(0);
  /**
   * The `rev` that has been saved.
   *
   * The canvas's own "something has been drawn" flag is not enough here, and
   * getting that wrong cost the page its whole purpose: replacing the drawing
   * hands the editor a new sheet, a new sheet is one nobody has drawn on yet,
   * and so Save went grey the instant a DXF was imported. The one thing the
   * page is for could not be saved.
   */
  const [savedRev, setSavedRev] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  const onSheetChange = useCallback((_key: string, run: Shape[]) => {
    setLive(run);
  }, []);

  /** Replace the whole drawing, and tell the canvas to start again from it. */
  const replace = (run: Shape[], said: string | null) => {
    setLive(run);
    setSeed(run);
    setRev(r => r + 1);
    setNote(said);
  };

  const pins = useMemo(() => pinsOf(live), [live]);

  const patchPin = (at: number, change: Partial<SymbolPin>) => {
    const run = live;
    const next = [...run];
    let seen = -1;
    for (let i = 0; i < next.length; i++) {
      if (!next[i].pin) continue;
      seen += 1;
      if (seen !== at) continue;
      next[i] = {
        ...next[i],
        ...(change.name !== undefined ? { pin: change.name } : {}),
        ...(change.dir !== undefined ? { pinDir: change.dir } : {}),
      };
      break;
    }
    replace(next, null);
  };

  const removePin = (at: number) => {
    const run = live;
    const next: Shape[] = [];
    let seen = -1;
    for (const s of run) {
      if (s.pin) {
        seen += 1;
        if (seen === at) continue;
      }
      next.push(s);
    }
    replace(next, null);
  };

  const addPin = () => {
    const run = live;
    const used = new Set(run.map(s => s.pin).filter(Boolean) as string[]);
    let n = 1;
    while (used.has(String(n))) n += 1;
    replace([...run, ...terminalMarks([{
      x: frame.pinX, y: frame.height / 2, name: String(n), dir: 'right',
    }])], t.symPinAdded(String(n)));
  };

  /** The two the library would give it, back — for a symbol whose points went. */
  const restorePins = () => {
    replace([...inkOf(live), ...terminalMarks(defaultPins(frame))],
      t.symPinsRestored);
  };

  // ── A drawing from a file ────────────────────────────────────────────────

  const file = useRef<HTMLInputElement>(null);

  /**
   * A DXF or SVG, as this symbol's drawing.
   *
   * It replaces. That is not a default that could have gone the other way: the
   * page exists to say what this device is drawn as, and a file brought onto
   * it is that drawing. Adding it would leave the old one underneath, which is
   * how a breaker came out drawn twice — once as the library draws it and once
   * as the office does, a few units apart, on every sheet in the project.
   *
   * The connection points are kept where they were. They belong to the frame
   * rather than to the ink: the conductor has not moved, so the two ends of it
   * have not either, and asking for them again after every import would be
   * asking somebody to retype what is already right.
   */
  const readFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const text = await f.text();
      let run: Shape[] = [];
      let found: [number, number][] = [];
      if (/\.dxf$/i.test(f.name)) {
        const read = readDxf(text, f.name);
        run = read.drawing.shapes;
        found = read.connections;
      } else if (/\.svg$/i.test(f.name)) {
        run = drawingFromSvg(text, f.name).shapes;
      } else {
        setNote(t.symImportUnreadable(f.name));
        return;
      }
      if (run.length === 0) { setNote(t.symImportEmpty(f.name)); return; }

      const fitted = fitIntoFrame(inkOf(run), frame);
      // A DXF that declared a CONN layer has already said where a wire lands on
      // this device. That is the file's own answer and it beats both the two
      // this page starts with and whatever is on the canvas — but it has to
      // come through the same fit as the ink, or the points land where the
      // drawing used to be.
      const kept = found.length
        ? (() => {
          const all = fitIntoFrame([...inkOf(run), ...terminalMarks(
            found.map(([x, y], i) => ({ x, y, name: String(i + 1) })))], frame);
          return pinsOf(all.shapes).map(p => ({ ...p, dir: p.dir }));
        })()
        : pins.length ? pins : defaultPins(frame);

      replace(
        [...fitted.shapes, ...terminalMarks(kept)],
        t.symImported(f.name, Math.round(fitted.scale * 100), kept.length,
          fitted.onAxis),
      );
    } catch {
      setNote(t.symImportUnreadable(f.name));
    } finally {
      if (file.current) file.current.value = '';
    }
  };

  // ── What is on the screen ────────────────────────────────────────────────

  // The frame's own marks — the box, the conductor, and the two ends the
  // library would put a wire on. Always the *default* pair, whatever the
  // draughtsman has since placed: it is the page saying where the branch
  // enters and leaves, which stays true however the terminals are moved.
  const guides = useMemo(
    () => frameGuides(frame, defaultPins(frame)), [frame]);

  // **Only `rev`.** The sheet is rebuilt when the page replaces the drawing and
  // at no other time: rebuilding it re-seeds the canvas, which throws away
  // everything drawn since. Saving changes `override`, and with the frame or
  // the markup in here that alone would wipe the canvas the moment Save was
  // pressed.
  const sheets = useMemo<EditorSheet[]>(() => {
    const d = new Drawing(frame.width, frame.height, 'symbol');
    for (const s of seed) d.add(s);
    return [{
      name: IEC_SYMBOLS[symbolId]?.title ?? symbolId,
      drawing: d,
      key: 'symbol',
      drawnAs: `${fingerprint(markup)}.${rev}`,
    }];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);

  // The editor's own Save, and whether pressing it would do anything. Both
  // come from the editor; this panel only puts them somewhere visible.
  const save = useRef<(() => void) | null>(null);
  const [dirty, setDirty] = useState(false);
  /** Drawn on since the last save, or replaced since the last save. */
  const unsaved = dirty || rev !== savedRev;

  /** Ink drawn outside the frame, which will be scaled down when it is placed. */
  const overflow = useMemo(() => {
    const box = boundsOfAll(inkOf(live));
    if (!box) return false;
    return box.x < -0.5 || box.y < -0.5
      || box.x + box.w > frame.width + 0.5
      || box.y + box.h > frame.height + 0.5;
  }, [live, frame]);

  const dir = dirOf(lang);

  const terminalPanel = (
    <div className="w-full lg:w-[15rem] shrink-0 border-t lg:border-t-0 lg:border-s
                    border-gray-200 bg-gray-50 flex flex-col min-h-0">
      <div className="px-3 py-2 border-b border-gray-200 flex items-center gap-2">
        <h4 className="text-xs font-semibold text-gray-700 flex-1 min-w-0 truncate">
          {t.symPins}
        </h4>
        <button
          onClick={addPin}
          className="p-1 rounded hover:bg-gray-200 text-gray-600"
          title={t.symPinAdd}
        >
          <PlusIcon className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={restorePins}
          className="p-1 rounded hover:bg-gray-200 text-gray-600"
          title={t.symPinsRestore}
        >
          <RotateCcwIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-2 space-y-1.5">
        {pins.length === 0 && (
          <p className="px-1 py-2 text-[11px] text-amber-800 bg-amber-50 rounded">
            {t.symPinsNone}
          </p>
        )}
        {pins.map((p, i) => (
          <div key={`${i}.${p.name}`} className="bg-white border border-gray-200 rounded p-1.5">
            <div className="flex items-center gap-1.5">
              <input
                dir="ltr"
                value={p.name}
                onChange={e => patchPin(i, { name: e.target.value })}
                className="w-16 px-1.5 py-1 text-[12px] font-mono border border-gray-300 rounded"
                title={t.symPinName}
              />
              <span className="text-[10px] text-gray-500 font-mono flex-1 min-w-0 truncate" dir="ltr">
                {p.x.toFixed(0)}, {p.y.toFixed(0)}
              </span>
              <button
                onClick={() => removePin(i)}
                className="p-1 rounded hover:bg-rose-50 text-gray-400 hover:text-rose-600"
                title={t.symPinRemove}
              >
                <Trash2Icon className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-1 mt-1.5" dir="ltr">
              {DIRS.map(d => {
                const Icon = DIR_ICON[d];
                return (
                  <button
                    key={d}
                    onClick={() => patchPin(i, { dir: d })}
                    title={t.symPinDir(d)}
                    className={`flex-1 flex items-center justify-center py-1 rounded border text-[11px]
                      ${p.dir === d
                        ? 'bg-blue-600 border-blue-600 text-white'
                        : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-100'}`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <p className="px-3 py-2 border-t border-gray-200 text-[10.5px] text-gray-500">
        {t.symPinsHelp}
      </p>
    </div>
  );

  const box = (
      <div
        dir={dir}
        className={inline
          ? 'bg-white flex-1 min-h-0 flex flex-col overflow-hidden'
          : 'bg-white rounded-lg shadow-2xl w-[1180px] max-w-[96vw] h-[94vh] flex flex-col overflow-hidden'}
        onClick={e => e.stopPropagation()}
      >
        <div className="bg-slate-700 text-white px-4 py-2.5 flex items-center gap-3 shrink-0">
          {/* Back before anything else, and in words. A symbol page opened
              from the library is a detour, and the way out of a detour is the
              first thing to look for — not an X in the far corner that may be
              off the edge of a narrow panel. */}
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-white/15 text-white text-xs font-medium hover:bg-white/25 shrink-0"
            title={t.symBack}
          >
            <ArrowLeftIcon className="w-3.5 h-3.5 rtl:rotate-180" /> {t.symBackShort}
          </button>

          <div className="min-w-0">
            <h2 className="text-sm font-semibold truncate">
              {IEC_SYMBOLS[symbolId]?.title ?? symbolId}
            </h2>
            <p className="text-[11px] text-slate-200 truncate">
              {t.symFrameNote(
                frame.width.toFixed(0), frame.height.toFixed(0),
                cellsOf(frame.height), CELL, frame.pinX.toFixed(0))}
              {override ? ` · ${t.symOwnDrawing}` : ''}
            </p>
          </div>

          <div className="ms-auto flex items-center gap-2 shrink-0">
            <button
              onClick={() => file.current?.click()}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-white/15 text-white text-xs font-medium hover:bg-white/25"
              title={t.symImportTip}
            >
              <FileInputIcon className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t.symImport}</span>
            </button>
            {override && (
              <button
                onClick={onReset}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-white/15 text-white text-xs font-medium hover:bg-white/25"
                title={t.symLibraryTip}
              >
                <RotateCcwIcon className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t.symLibrary}</span>
              </button>
            )}
            <button
              onClick={() => save.current?.()}
              disabled={!unsaved}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-500 text-white text-xs font-semibold hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-default"
              title={unsaved ? t.symSaveTip : t.symSaveNothing}
            >
              <SaveIcon className="w-3.5 h-3.5" /> {t.symSave}
            </button>
            {!inline && (
              <button onClick={onClose} className="p-1 rounded hover:bg-white/20">
                <XIcon className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* What the last command did, and the one warning worth interrupting
            for: ink outside the frame comes back scaled down on the sheet,
            which reads as the symbol having shrunk for no reason. */}
        {(note || overflow) && (
          <div className={`px-4 py-1.5 text-[11px] shrink-0 border-b ${
            overflow ? 'bg-amber-50 text-amber-900 border-amber-200'
              : 'bg-blue-50 text-blue-900 border-blue-200'}`}>
            {overflow ? t.symOverflow : note}
          </div>
        )}

        <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
          <div className="flex-1 min-h-0 bg-gray-100">
            <DrawingEditor
              embedded
              lean
              ownDxfImport
              fitPad={0.2}
              guides={guides}
              onSheetChange={onSheetChange}
              saveHandle={save}
              onDirty={setDirty}
              sheets={sheets}
              fileBase={`symbol_${symbolId}`}
              titleBlock={[IEC_SYMBOLS[symbolId]?.title ?? symbolId, 'Simorgh Draw — symbol']}
              mmPerUnit={2}
              // The editor's own Save hands back the sheet it holds; here that
              // sheet is the symbol, so it becomes the project's drawing of it.
              //
              // The box does not come from the ink. It is the frame the page
              // was opened in, and it stays the frame however the drawing was
              // changed — that is what keeps a redrawn symbol the same height
              // on the branch and its conductor in the same place. Reading the
              // box back off the geometry instead would move the conductor
              // every time somebody rubbed something out near an edge.
              onSaveEdits={next => {
                // The editor reports only the sheets *it* was drawn on. A
                // drawing this page replaced wholesale — an imported DXF, a
                // terminal added — is not one of them, so a save straight
                // after an import comes back empty. That is not "undone back
                // to nothing"; it is the page's own change, and `live` is it.
                const edited = next.symbol?.shapes;
                if (!edited && rev === 0) { onReset(); return; }
                const run = edited ?? live;
                const shaped = withShapes(drawing, inkOf(run));
                onSave({
                  art: renderFragment(shaped),
                  // The box is the frame the page was opened in, not the
                  // extent of the ink. That is what keeps a redrawn symbol
                  // the same height on the branch with its conductor in the
                  // same place; measuring the ink instead would move the
                  // conductor every time something was rubbed out near an edge.
                  width: frame.width,
                  height: frame.height,
                  pinX: frame.pinX,
                  cells: cellsOf(frame.height),
                  terminals: pinsOf(run),
                  editedAt: new Date().toISOString(),
                });
                // What is on the canvas is now what was saved, so the sheet
                // does not have to be rebuilt to agree with it.
                setSeed(run);
                setSavedRev(rev);
              }}
            />
          </div>
          {terminalPanel}
        </div>

        <input
          ref={file}
          type="file"
          accept=".dxf,.svg"
          className="hidden"
          onChange={e => readFile(e.target.files?.[0])}
        />

        <div className="px-4 py-2 border-t bg-gray-50 text-[11px] text-gray-500 shrink-0">
          {t.symFooter}
        </div>
      </div>
  );

  return inline ? box : (
    <div
      className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-[210] p-4"
      onClick={onClose}
    >
      {box}
    </div>
  );
};
