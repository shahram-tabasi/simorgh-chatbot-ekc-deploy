import React, { useMemo } from 'react';
import { XIcon, RotateCcwIcon } from 'lucide-react';
import { SymbolArtOverride } from '../../types/project';
import {
  CELL, IEC_SYMBOLS, SymbolId, drawIecSymbol, symbolHeight, symbolLeft, symbolRight,
} from '../../utils/iecSymbols';
import { Drawing } from '../../utils/cad/shapes';
import { drawingFromSvg } from '../../utils/cad/fromSvg';
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

interface Props {
  symbolId: SymbolId;
  /** The project's own drawing of it, when there is one. */
  override?: SymbolArtOverride;
  onSave: (art: SymbolArtOverride) => void;
  /** Put the library's own symbol back. */
  onReset: () => void;
  onClose: () => void;
}

/** A symbol as a drawing: its own box, with the conductor where it belongs. */
export function symbolDrawing(symbolId: SymbolId, override?: SymbolArtOverride): {
  drawing: Drawing; pinX: number; markup: string;
} {
  if (override) {
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${override.width} ${override.height}">${override.art}</svg>`;
    return { drawing: drawingFromSvg(markup, symbolId), pinX: override.pinX, markup };
  }
  const left = symbolLeft(symbolId);
  const width = left + symbolRight(symbolId);
  const height = symbolHeight(symbolId);
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${drawIecSymbol(symbolId, left, 0)}</svg>`;
  return { drawing: drawingFromSvg(markup, symbolId), pinX: left, markup };
}

export const SymbolGraphicEditor: React.FC<Props> = ({
  symbolId, override, onSave, onReset, onClose,
}) => {
  const { drawing, pinX, markup } = useMemo(
    () => symbolDrawing(symbolId, override), [symbolId, override]);

  const sheets = useMemo<EditorSheet[]>(() => [{
    name: IEC_SYMBOLS[symbolId]?.title ?? symbolId,
    drawing,
    key: 'symbol',
    drawnAs: fingerprint(markup),
  }], [drawing, markup, symbolId]);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-[210]" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-2xl w-[1180px] max-w-[96vw] max-h-[94vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="bg-slate-700 text-white px-5 py-3 flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-semibold truncate">
              {IEC_SYMBOLS[symbolId]?.title ?? symbolId}
            </h2>
            <p className="text-[11px] text-slate-200">
              {IEC_SYMBOLS[symbolId]?.titleFa} · one cell is {CELL} units ·
              {' '}the conductor stays at {pinX.toFixed(0)}
              {override ? ' · this project has its own drawing of it' : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {override && (
              <button
                onClick={onReset}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-white/15 text-white text-xs font-medium hover:bg-white/25"
                title="Put the library's own drawing back for this project"
              >
                <RotateCcwIcon className="w-3.5 h-3.5" /> Library symbol
              </button>
            )}
            <button onClick={onClose} className="p-1 rounded hover:bg-white/20">
              <XIcon className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-3 bg-gray-100">
          <DrawingEditor
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

        <div className="px-5 py-2 border-t bg-gray-50 text-[11px] text-gray-500">
          Save keeps this drawing with the project — every sheet that uses this symbol
          picks it up. The library's own symbol is never changed.
        </div>
      </div>
    </div>
  );
};
