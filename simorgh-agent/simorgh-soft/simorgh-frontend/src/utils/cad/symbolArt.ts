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
): { drawing: Drawing; pinX: number; markup: string } {
  if (!override && plain) {
    const own = librarySymbol(symbolId);
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${own.width} ${own.height}">${own.markup}</svg>`;
    return { drawing: drawingFromSvg(markup, symbolId), pinX: own.left, markup };
  }
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
