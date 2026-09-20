// src/utils/cad/useSymbols.ts
//
// Keeping every screen's idea of a symbol the same as every other screen's.
//
// The symbol library is not React state. It cannot be: `drawIecSymbol` is
// called from the single-line generator, from the DXF and PDF back-ends and
// from three panels, and threading a context through all of that would mean
// every one of them became a component. So it is module-level, in
// `iecSymbols`, and that is the right shape for it.
//
// What was wrong was everything around it:
//
//   * **each tab loaded the layers itself**, from its own effect. A tab that
//     was not mounted never ran its effect, so what a symbol looked like
//     depended on which screens had been opened and in what order.
//   * **nothing re-rendered when they changed.** A panel that draws from a
//     module-level variable has no idea it has moved. One screen kept a
//     version counter of its own and bumped it by hand; the others did not,
//     and simply went on showing the drawing they had rendered first.
//
// Both are fixed here rather than in each screen. `useSymbolLibrary` is
// mounted once, at the top, and owns the loading. `useSymbolVersion` is what a
// screen calls to be redrawn when a symbol changes — it is the whole of what
// the screens have to know.

import { useEffect, useSyncExternalStore } from 'react';
import {
  SymbolId, SymbolOverride, onSymbols, setPackSymbolOverrides,
  setProjectSymbolOverrides, symbolsVersion,
} from '../iecSymbols';
import { loadDxfSymbols, onDxfSymbols } from './dxfSymbols';
import { toSymbolOverrides } from './projectSymbols';
import { SymbolArtOverride } from '../../types/project';

/**
 * Redraw this component whenever any symbol changes.
 *
 * The number it returns is not interesting in itself; reading it is what
 * subscribes. Anything that calls `drawIecSymbol`, `symbolDrawing`,
 * `iecItems` or builds a sheet needs this, or it will keep showing the symbol
 * as it was when the component first rendered.
 */
export function useSymbolVersion(): number {
  return useSyncExternalStore(onSymbols, symbolsVersion, symbolsVersion);
}

/** The office's DXF pack, as the library wants it. */
function packLayer(): Partial<Record<SymbolId, SymbolOverride>> {
  const out: Partial<Record<SymbolId, SymbolOverride>> = {};
  for (const s of loadDxfSymbols()) {
    out[s.id as SymbolId] = {
      url: '', art: s.art, width: s.width, height: s.height,
      pinX: s.pinX, cells: s.cells, title: s.fileName,
    };
  }
  return out;
}

/**
 * Load the symbol layers, once, for the whole app.
 *
 * Called at the top rather than in each tab. The office's pack is in this
 * browser and is the same on every screen, so a screen that has it and a
 * screen that does not is a bug however it came about — and it came about
 * because only the drawing tab loaded it, which meant the template previews
 * drew from the built-in library until somebody happened to open the drawings.
 */
export function useSymbolLibrary(
  projectOverrides?: Record<string, SymbolArtOverride>,
): void {
  // The office's pack, and again whenever the symbol library changes it.
  useEffect(() => {
    setPackSymbolOverrides(packLayer());
    return onDxfSymbols(() => setPackSymbolOverrides(packLayer()));
  }, []);

  // This job's own drawings.
  useEffect(() => {
    setProjectSymbolOverrides(toSymbolOverrides(projectOverrides));
  }, [projectOverrides]);
}
