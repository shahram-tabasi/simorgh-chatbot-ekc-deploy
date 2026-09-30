// src/utils/cad/projectSymbols.ts
//
// The project's own drawings of symbols, in the shape the library wants them.
//
// A symbol redrawn on the graphic page is kept with the project as geometry
// (see SymbolArtOverride). The library draws an overriding symbol from a
// SymbolOverride. This is the one line between the two, so no screen has to
// know the shape of both.
import { SymbolArtOverride } from '../../types/project';
import { SymbolId, SymbolOverride } from '../iecSymbols';

export function toSymbolOverrides(
  stored?: Record<string, SymbolArtOverride>,
): Partial<Record<SymbolId, SymbolOverride>> {
  const out: Partial<Record<SymbolId, SymbolOverride>> = {};
  for (const [id, art] of Object.entries(stored ?? {})) {
    if (!art?.art) continue;
    out[id as SymbolId] = {
      url: '',
      art: art.art,
      width: art.width,
      height: art.height,
      pinX: art.pinX,
      cells: art.cells,
      // The connection points travel with the drawing they were placed on.
      // Left behind, the library falls back to inventing two on the conductor
      // — which is the drawing the office has just finished correcting.
      terminals: art.terminals,
      title: 'Redrawn for this project',
    };
  }
  return out;
}
