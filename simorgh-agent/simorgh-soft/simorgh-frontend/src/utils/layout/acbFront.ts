// src/utils/layout/acbFront.ts
//
// The front of a Siemens 3WA air circuit-breaker, as a layout drawing shows it
// through the cubicle door: the withdrawable breaker in its guide frame, the
// trip unit (ETU) with its display, the ON and OFF push buttons, the
// indicator windows (contacts open/closed, spring charged/discharged), the
// spring-charging hand lever, the racking crank opening with the position
// indicator, and the padlock hasp.
//
// To scale by frame size. The sizes are 3WA's three frames — FS1 to 2,000 A,
// FS2 to 4,000 A, FS3 to 6,300 A — with the withdrawable unit's front in mm,
// rounded; the office's own 3WA layout symbol (a Layout symbol whose name
// carries "3WA") is drawn in place of this when there is one.
import type { Shape } from '../cad/shapes';
import { newBlockId } from '../cad/geom';

export interface AcbFrame { name: string; amps: number; w3: number; w4: number; h: number }

/** 3WA frame sizes: width 3-pole / 4-pole and height of the withdrawable front, mm. */
export const WA_FRAMES: AcbFrame[] = [
  { name: 'FS1', amps: 2000, w3: 320, w4: 410, h: 465 },
  { name: 'FS2', amps: 4000, w3: 460, w4: 590, h: 465 },
  { name: 'FS3', amps: 6300, w3: 704, w4: 914, h: 465 },
];

export const waFrameFor = (amps = 1600): AcbFrame =>
  WA_FRAMES.find(f => amps <= f.amps) ?? WA_FRAMES[WA_FRAMES.length - 1];

/**
 * The breaker's front, centred on `cx`, its top at `y`, at `k` sheet mm per
 * real mm. One block, so it is picked and moved as one thing.
 */
export function acbFront(cx: number, y: number, k: number, o: { amps?: number; poles?: 3 | 4; label?: string } = {}): Shape[] {
  const fr = waFrameFor(o.amps);
  const W = (o.poles === 4 ? fr.w4 : fr.w3) * k;
  const H = fr.h * k;
  const x = cx - W / 2;
  const block = newBlockId();
  const pen = { layer: 'SYMBOL' as const, color: '#111', block, blockName: `3WA ${fr.name}` };
  const out: Shape[] = [];
  const r = (rx: number, ry: number, rw: number, rh: number, width = 0.2, fill?: string) =>
    out.push({ t: 'rect', x: rx, y: ry, w: rw, h: rh, width, ...(fill ? { fill } : {}), ...pen });
  const l = (x1: number, y1: number, x2: number, y2: number, width = 0.2) =>
    out.push({ t: 'line', x1, y1, x2, y2, width, ...pen });
  const c = (ccx: number, ccy: number, rr: number, width = 0.2, fill?: string) =>
    out.push({ t: 'circle', cx: ccx, cy: ccy, r: rr, width, ...(fill ? { fill } : {}), ...pen });
  const t = (tx: number, ty: number, s: string, size: number, anchor: 'start' | 'middle' | 'end' = 'middle', bold = false) =>
    out.push({ t: 'text', x: tx, y: ty, s, size, anchor, ...(bold ? { bold } : {}), ...pen, layer: 'TEXT' });

  // The guide frame, and the breaker's front panel inside it.
  r(x, y, W, H, 0.35, '#ffffff');
  const fx = x + W * 0.06, fy = y + H * 0.05, fw = W * 0.88, fh = H * 0.9;
  r(fx, fy, fw, fh, 0.3, '#f9fafb');
  // Arc chute vents across the top.
  const slots = Math.max(6, Math.round(fw / (14 * k)));
  for (let i = 0; i < slots; i++) {
    const sx = fx + fw * 0.06 + (i * fw * 0.88) / slots;
    r(sx, fy + fh * 0.03, fw * 0.88 / slots * 0.55, fh * 0.05, 0.15, '#d1d5db');
  }
  // Name strip: SIEMENS, 3WA and the rating.
  // Sized to the front, so a small frame on a small sheet stays legible and
  // apart: SIEMENS on the strip, the type and rating under the guide frame.
  t(fx + fw * 0.04, fy + fh * 0.155, 'SIEMENS', fw * 0.085, 'start', true);
  t(cx, y + H + Math.max(2, fw * 0.08), `3WA ${fr.name}${o.amps ? ` · ${o.amps} A` : ''}${o.poles === 4 ? ' · 4P' : ''}`, Math.max(1.4, fw * 0.075), 'middle');
  l(fx, fy + fh * 0.19, fx + fw, fy + fh * 0.19, 0.15);

  // The electronic trip unit, upper middle: display and keys.
  const ex = fx + fw * 0.36, ey = fy + fh * 0.23, ew = fw * 0.4, eh = fh * 0.3;
  r(ex, ey, ew, eh, 0.25, '#ffffff');
  r(ex + ew * 0.1, ey + eh * 0.12, ew * 0.8, eh * 0.38, 0.2, '#e5e7eb');
  t(ex + ew / 2, ey + eh * 0.36, 'ETU', Math.max(1.1, 11 * k));
  for (let i = 0; i < 4; i++) c(ex + ew * (0.2 + i * 0.2), ey + eh * 0.72, Math.max(0.4, ew * 0.05), 0.15);

  // ON (I) and OFF (O) push buttons, left.
  const bx = fx + fw * 0.15;
  const br = Math.max(0.8, Math.min(fw * 0.07, 22 * k));
  c(bx, fy + fh * 0.32, br, 0.3, '#ffffff'); t(bx, fy + fh * 0.32 + br * 0.4, 'I', br * 1.1, 'middle', true);
  c(bx, fy + fh * 0.47, br, 0.3, '#ffffff'); t(bx, fy + fh * 0.47 + br * 0.4, 'O', br * 1.1, 'middle', true);
  t(bx, fy + fh * 0.32 - br - 0.5, 'ON', Math.max(0.9, 8 * k));
  t(bx, fy + fh * 0.47 + br + 1.4, 'OFF', Math.max(0.9, 8 * k));

  // Indicator windows, right: contacts I/O, spring charged.
  const wx = fx + fw * 0.82, ww = fw * 0.12, wh = fh * 0.07;
  r(wx, fy + fh * 0.25, ww, wh, 0.2, '#ffffff'); t(wx + ww / 2, fy + fh * 0.25 + wh * 0.72, 'I/O', ww * 0.3);
  r(wx, fy + fh * 0.36, ww, wh, 0.2, '#ffffff'); t(wx + ww / 2, fy + fh * 0.36 + wh * 0.72, 'SPR', ww * 0.3);
  r(wx, fy + fh * 0.47, ww, wh, 0.2, '#ffffff'); t(wx + ww / 2, fy + fh * 0.47 + wh * 0.72, 'RDY', ww * 0.3);

  // Spring-charging hand lever, lower middle: the recess and the lever on its pivot.
  const lx = fx + fw * 0.38, ly = fy + fh * 0.6, lw = fw * 0.24, lh = fh * 0.24;
  r(lx, ly, lw, lh, 0.25, '#ffffff');
  c(lx + lw / 2, ly + lh * 0.82, Math.max(0.5, lw * 0.08), 0.25, '#111');
  r(lx + lw * 0.4, ly + lh * 0.12, lw * 0.2, lh * 0.66, 0.25, '#e5e7eb');
  t(lx + lw / 2, ly - 0.6, 'CHARGE', Math.max(0.9, 7 * k));

  // Padlock hasp, lower left.
  r(fx + fw * 0.1, fy + fh * 0.66, fw * 0.1, fh * 0.1, 0.2);
  c(fx + fw * 0.15, fy + fh * 0.66, fw * 0.035, 0.2);

  // Racking: the crank opening and the position indicator under the breaker.
  const rx = fx + fw * 0.7, ry = fy + fh * 0.88;
  c(rx, ry, Math.max(0.6, fw * 0.03), 0.25, '#ffffff');
  // Position indicator: connected / test / disconnected, as three fields.
  const pw = fw * 0.18, px = rx + fw * 0.06, ph = fh * 0.05;
  r(px, ry - ph / 2, pw, ph, 0.2, '#ffffff');
  l(px + pw / 3, ry - ph / 2, px + pw / 3, ry + ph / 2, 0.15);
  l(px + 2 * pw / 3, ry - ph / 2, px + 2 * pw / 3, ry + ph / 2, 0.15);
  r(px + 0.3, ry - ph / 2 + 0.3, pw / 3 - 0.6, ph - 0.6, 0.1, '#111');

  if (o.label) t(cx, y - 1.2, o.label, Math.max(1.6, 2.2), 'middle', true);
  return out;
}
