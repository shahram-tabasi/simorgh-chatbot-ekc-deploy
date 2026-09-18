import React, { useMemo, useRef, useState } from 'react';
import { ArrowLeftIcon, RotateCcwIcon, SaveIcon, XIcon } from 'lucide-react';
import { SymbolArtOverride } from '../../types/project';
import { CELL, IEC_SYMBOLS, SymbolId } from '../../utils/iecSymbols';
import { symbolDrawing } from '../../utils/cad/symbolArt';
import { renderFragment } from '../../utils/cad/svg';
import { fingerprint, withShapes } from '../../utils/cad/edit';
import { DrawingEditor, EditorSheet } from './DrawingEditor';

// The graphic page for one symbol.
//
// The same canvas the sheets are edited on, opened on a single symbol: move a
// line, retype a label, delete what the office does not draw. What comes out is
// kept with the project and takes the place of the library's symbol wherever
// that symbol is used — the same thing a file in the symbol pack does, from the
// other end.
//
// The conductor's place across the symbol does not move. It is what puts the
// device on the branch, and a symbol whose conductor wandered while it was
// being tidied would land beside the line instead of on it.
//
// Its own bar carries the two commands this page is for — Save and back — and
// carries them at the top where they can be seen. They were in the drawing
// editor's ribbon, as a disc among thirty other pictures, at the top of a
// canvas that was 620 pixels tall inside a panel a third of that: the lower
// half of the symbol could not be reached to draw on and the way out was
// below the window. That is what `embedded` fixes on the editor's side; this
// bar is the other half of it.

interface Props {
  symbolId: SymbolId;
  /** The project's own drawing of it, when there is one. */
  override?: SymbolArtOverride;
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

export const SymbolGraphicEditor: React.FC<Props> = ({
  symbolId, override, onSave, onReset, onClose, inline,
}) => {
  const { drawing, pinX, markup } = useMemo(
    () => symbolDrawing(symbolId, override), [symbolId, override]);

  // The editor's own Save, and whether pressing it would do anything. Both
  // come from the editor; this panel only puts them somewhere visible.
  const save = useRef<(() => void) | null>(null);
  const [dirty, setDirty] = useState(false);

  const sheets = useMemo<EditorSheet[]>(() => [{
    name: IEC_SYMBOLS[symbolId]?.title ?? symbolId,
    drawing,
    key: 'symbol',
    drawnAs: fingerprint(markup),
  }], [drawing, markup, symbolId]);

  const box = (
      <div
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
            title="Back to the symbol library"
          >
            <ArrowLeftIcon className="w-3.5 h-3.5" /> Symbols
          </button>

          <div className="min-w-0">
            <h2 className="text-sm font-semibold truncate">
              {IEC_SYMBOLS[symbolId]?.title ?? symbolId}
            </h2>
            <p className="text-[11px] text-slate-200 truncate">
              One cell is {CELL} units · the conductor stays at {pinX.toFixed(0)}
              {override ? ' · this project has its own drawing of it' : ''}
            </p>
          </div>

          <div className="ms-auto flex items-center gap-2 shrink-0">
            {override && (
              <button
                onClick={onReset}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-white/15 text-white text-xs font-medium hover:bg-white/25"
                title="Put the library's own drawing back for this project"
              >
                <RotateCcwIcon className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Library symbol</span>
              </button>
            )}
            <button
              onClick={() => save.current?.()}
              disabled={!dirty}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-500 text-white text-xs font-semibold hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-default"
              title={dirty
                ? 'Keep this drawing with the project, and put it on every sheet that uses the symbol'
                : 'Nothing drawn since the last save'}
            >
              <SaveIcon className="w-3.5 h-3.5" /> Save
            </button>
            {!inline && (
              <button onClick={onClose} className="p-1 rounded hover:bg-white/20">
                <XIcon className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 bg-gray-100">
          <DrawingEditor
            embedded
            lean
            saveHandle={save}
            onDirty={setDirty}
            sheets={sheets}
            fileBase={`symbol_${symbolId}`}
            titleBlock={[IEC_SYMBOLS[symbolId]?.title ?? symbolId, 'Simorgh Draw — symbol']}
            mmPerUnit={2}
            // The editor's own Save hands back the sheet it holds; here that
            // sheet is the symbol, so it becomes the project's drawing of it.
            onSaveEdits={next => {
              const edited = next.symbol;
              if (!edited) { onReset(); return; }
              const shaped = withShapes(drawing, edited.shapes);
              onSave({
                art: renderFragment(shaped),
                width: drawing.width,
                height: drawing.height,
                pinX,
                cells: Math.max(1, Math.min(4, Math.round(drawing.height / CELL) || 1)),
                editedAt: new Date().toISOString(),
              });
            }}
          />
        </div>

        <div className="px-4 py-2 border-t bg-gray-50 text-[11px] text-gray-500 shrink-0">
          Save keeps this drawing with the project — every sheet that uses this symbol
          picks it up, and the ones already drawn are offered the new one. The library's
          own symbol is never changed.
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
