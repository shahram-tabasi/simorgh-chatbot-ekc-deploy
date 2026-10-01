// src/utils/cad/pinLabels.ts
//
// Connection point designations, written beside the points.
//
// A connection point has carried its designation — 1, 2, A1, 13 — since the
// points were introduced, and it could be renamed with a double click, but the
// name was nowhere on the sheet: what a wire was landed on could be read in
// the connection list and not on the drawing. EPLAN writes it beside the
// point, and so does this.
//
// The labels are worked out from the points every time rather than kept as
// text of their own. A kept label would have to be renamed when the point is,
// moved when the device is and deleted when the device is, and the first of
// those it missed would put a wrong number on a customer's drawing. Worked
// out, it cannot disagree with the point it names.
//
// A device whose own drawing already prints the number beside the point —
// the wiring-diagram symbols do — is not labelled twice.

import { Shape } from './shapes';
import { terminals } from './terminals';

/** The colour the points themselves are drawn in on screen. */
export const PIN_LABEL_COLOR = '#db2777';

/**
 * The designations as text shapes on the PIN layer, for the canvas to draw
 * and for an export to print. `size` is the text height in drawing units.
 */
export function pinLabels(shapes: Shape[], size = 4): Shape[] {
  const texts = shapes.filter(s => s.t === 'text');
  const out: Shape[] = [];
  const gap = size * 0.45;
  for (const t of terminals(shapes)) {
    if (!t.block) continue;
    // Already printed by the device's own drawing, near enough to be its.
    const printed = texts.some(s => s.t === 'text' && s.block === t.block
      && String(s.s).trim() === t.name
      && Math.hypot(s.x - t.at[0], s.y - t.at[1]) <= size * 3);
    if (printed) continue;
    const [x, y] = t.at;
    // Beside the point, on the device's side of it, clear of the wire: to the
    // left of a point fed from above or below, above one fed from the side.
    const dir = t.dir ?? 'down';
    const upright = dir === 'up' || dir === 'down';
    const inward = dir === 'up' ? 1 : dir === 'down' ? -1 : dir === 'left' ? 1 : -1;
    out.push(upright
      ? {
        t: 'text', x: x - gap, y: y + inward * (size * 0.9) + (inward > 0 ? size * 0.35 : 0),
        s: t.name, size, anchor: 'end',
        layer: 'PIN', color: PIN_LABEL_COLOR,
      }
      : {
        t: 'text', x: x + inward * gap, y: y - gap,
        s: t.name, size, anchor: inward > 0 ? 'start' : 'end',
        layer: 'PIN', color: PIN_LABEL_COLOR,
      });
  }
  return out;
}
