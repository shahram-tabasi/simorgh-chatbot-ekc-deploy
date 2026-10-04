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
  setProjectSymbolOverrides, symbolsVersion, setOfficeSymbolSource, symbolsChanged,
} from '../iecSymbols';
import { loadOfficeSymbols, officeSymbols, onOfficeSymbols } from './officeSymbols';
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

/** Which edge of its box a connection point is nearest — the way its wire
 *  leaves. */
function edgeOf(x: number, y: number, w: number, h: number): string {
  const d = [
    ['up', y], ['down', h - y], ['left', x], ['right', w - x],
  ] as [string, number][];
  return d.sort((a, b) => a[1] - b[1])[0][0];
}

/**
 * A file's points carry no names, so they are given the ones the single line
 * reads: the topmost is 1 and the bottommost 2 — where the line comes in and
 * goes out — and any others 3, 4… in the order the file has them.
 */
function namePackPoints(points: [number, number][]): { x: number; y: number; name: string }[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [{ x: points[0][0], y: points[0][1], name: '1' }];
  const byY = points.map((p, i) => ({ p, i })).sort((a, b) => a.p[1] - b.p[1]);
  const top = byY[0].i;
  const bottom = byY[byY.length - 1].i;
  let next = 3;
  return points.map(([x, y], i) => ({
    x, y, name: i === top ? '1' : i === bottom ? '2' : String(next++),
  }));
}

/** The office's DXF pack, as the library wants it. */
function packLayer(): Partial<Record<SymbolId, SymbolOverride>> {
  const out: Partial<Record<SymbolId, SymbolOverride>> = {};
  for (const s of loadDxfSymbols()) {
    out[s.id as SymbolId] = {
      url: '', art: s.art, width: s.width, height: s.height,
      pinX: s.pinX, cells: s.cells, title: s.fileName,
      // The connection points placed on the file travel with it — left
      // behind, a symbol from the pack fell back to two invented points on
      // its conductor whatever the office had marked. Each faces the edge it
      // sits on.
      terminals: namePackPoints(s.terminalPoints ?? []).map(({ x, y, name }) => ({
        x, y, name, dir: edgeOf(x, y, s.width, s.height),
      })),
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

  // The office's new symbols, for a part drawn with one of them.
  useEffect(() => {
    setOfficeSymbolSource(id => {
      const s = officeSymbols().find(o => o.id === id);
      if (!s) return undefined;
      const t1 = s.terminals.find(t => t.name === '1') ?? s.terminals[0];
      return {
        url: '', art: s.art, width: s.width, height: s.height,
        pinX: t1 && (t1.dir === 'up' || t1.dir === 'down' || !t1.dir) ? t1.x : s.width / 2,
        terminals: s.terminals, title: s.name,
      };
    });
    loadOfficeSymbols().catch(() => { /* the library draws without them */ });
    return onOfficeSymbols(() => symbolsChanged());
  }, []);
}
