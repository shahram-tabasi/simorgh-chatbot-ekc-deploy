// src/utils/cad/symbolArt.ts
//
// One library symbol as a drawing: its own box, with the conductor where it
// belongs.
//
// Out here rather than on the panel that draws it, because two screens want it
// for different reasons — the symbol page, to put the symbol on a canvas, and
// the editor, to work out what the sheets are holding before a redrawn symbol
// takes its place — and a component importing a component that imports it back
// is a cycle waiting to be loaded in the wrong order.

import { SymbolArtOverride } from '../../types/project';
import {
  SymbolId, drawIecSymbol, librarySymbol, symbolHeight, symbolLeft, symbolRight,
} from '../iecSymbols';
import { Drawing } from './shapes';
import { drawingFromSvg } from './fromSvg';
import { SymbolPin, defaultPins, symbolFrame } from './symbolFrame';

/**
 * A symbol as a drawing: its own box, with the conductor where it belongs.
 *
 * With no override handed in it is whatever the app currently draws for that
 * id — the office's pack symbol where there is one — because that is what a
 * page would get. `plain` asks for the library's own instead, which is the one
 * question the overrides cannot answer: what to put back.
 */
export function symbolDrawing(
  symbolId: SymbolId, override?: SymbolArtOverride, plain = false,
): {
  drawing: Drawing; pinX: number; markup: string;
  /**
   * Where a wire may land on it, in the drawing's own coordinates.
   *
   * Handed back beside the geometry because the two travel together and the
   * one place they must not be worked out separately is the one that matters:
   * replacing the instances already on the sheets. A new drawing put down
   * without its terminals is a device that looks right and cannot be wired,
   * and that is worse than the old drawing it replaced.
   */
  terminals: SymbolPin[];
} {
  if (!override && plain) {
    const own = librarySymbol(symbolId);
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${own.width} ${own.height}">${own.markup}</svg>`;
    const d = drawingFromSvg(markup, symbolId);
    // The library's own symbol: a conductor with something on it, entered at
    // the top and left at the bottom.
    return {
      drawing: d, pinX: own.left, markup,
      terminals: defaultPins(symbolFrame(symbolId, {
        width: own.width, height: own.height, pinX: own.left,
      })),
    };
  }
  if (override) {
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${override.width} ${override.height}">${override.art}</svg>`;
    const d = drawingFromSvg(markup, symbolId);
    return {
      drawing: d, pinX: override.pinX, markup,
      // The draughtsman's own points where the drawing carries them, and the
      // two the library would give it where it does not — which is every
      // symbol redrawn before the page could place them.
      terminals: override.terminals?.length
        ? override.terminals.map(p => ({ ...p, dir: (p.dir ?? 'down') }))
        : defaultPins(symbolFrame(symbolId, {
          width: override.width, height: override.height, pinX: override.pinX,
        })),
    };
  }
  const left = symbolLeft(symbolId);
  const width = left + symbolRight(symbolId);
  const height = symbolHeight(symbolId);
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${drawIecSymbol(symbolId, left, 0)}</svg>`;
  return {
    drawing: drawingFromSvg(markup, symbolId), pinX: left, markup,
    terminals: defaultPins(symbolFrame(symbolId, { width, height, pinX: left })),
  };
}
