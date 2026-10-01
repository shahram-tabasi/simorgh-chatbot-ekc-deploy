// src/utils/cad/connectors.ts
//
// Connection symbols — EPLAN's connectors: the angle, the T-node and the
// interruption point.
//
// A wire only autoconnects in a straight line between two points that face
// each other. That is the rule, and it is why a horizontal contact and a
// vertical one could not be joined: their points never face. EPLAN's answer is
// a connector — a symbol that is nothing but connection points at one spot,
// facing two or three ways. Put an angle where the row of the one meets the
// column of the other and both legs autoconnect to it; put a T-node on a run
// and the branch leaves from it. They carry the connection through them: the
// connection list reads device to device across an angle, not device to angle.
//
// An interruption point is the other kind: where a wire stops on this page
// and carries on elsewhere. It is named — L1, 24V, -X1:3 — and the name is
// what it is joined by. It is listed as an end ("-K1:14 → ⇢L1"), so the list
// says where to look next instead of losing the wire.
//
// Each comes in the four ways it can face, which the placing cursor walks with
// Tab, and in one to four poles for a multi-line diagram: parallel wires turn
// a corner together, nested so they do not cross, one pole pitch apart — the
// same pitch the three-pole devices are drawn at, so they line up with them.
//
// The drawings are our own: a dot for a T-node, nothing but the points for an
// angle, a chevron and the name for an interruption point.

import { Pt, Shape } from './shapes';
import { terminalMarks } from './terminals';

type Dir = 'up' | 'down' | 'left' | 'right';
export type ConnectorKind = 'angle' | 'tee' | 'break';

/** What a connector's shapes carry as `symbol`, so the rest can tell. */
export const CONNECTOR = 'conn:';
export const connectorKind = (s: Shape): ConnectorKind | null =>
  (s.symbol?.startsWith(CONNECTOR) ? s.symbol.slice(CONNECTOR.length) as ConnectorKind : null);
/** Angles and T-nodes join what is either side of them and are nothing themselves. */
export const isPassThrough = (s: Shape) => {
  const k = connectorKind(s);
  return k === 'angle' || k === 'tee';
};

/** Pole pitch — the three-pole wiring symbols' (`wdSymbols` POLE). */
export const POLE_PITCH = 15;

const VEC: Record<Dir, Pt> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/** The four faces of each kind, in the order Tab walks them. */
const FACES: Record<ConnectorKind, { name: string; dirs: Dir[] }[]> = {
  angle: [
    { name: '┌', dirs: ['down', 'right'] },
    { name: '┐', dirs: ['down', 'left'] },
    { name: '┘', dirs: ['up', 'left'] },
    { name: '└', dirs: ['up', 'right'] },
  ],
  tee: [
    { name: '├', dirs: ['up', 'down', 'right'] },
    { name: '┬', dirs: ['left', 'right', 'down'] },
    { name: '┤', dirs: ['up', 'down', 'left'] },
    { name: '┴', dirs: ['left', 'right', 'up'] },
  ],
  break: [
    { name: '↓', dirs: ['up'] },
    { name: '↑', dirs: ['down'] },
    { name: '→', dirs: ['left'] },
    { name: '←', dirs: ['right'] },
  ],
};

/**
 * Where pole `i` of a multi-pole connector stands.
 *
 * An angle's poles are nested along the diagonal away from where the wires
 * go, so the outer wire turns outermost and nothing crosses. A T-node's poles
 * stand side by side across the run, each branch a pitch further along it.
 * An interruption point's poles stand side by side across its wire.
 */
function poleOffset(kind: ConnectorKind, dirs: Dir[], i: number, pitch: number): Pt {
  if (i === 0) return [0, 0];
  if (kind === 'angle') {
    const [a, b] = dirs.map(d => VEC[d]);
    return [-(a[0] + b[0]) * i * pitch, -(a[1] + b[1]) * i * pitch];
  }
  if (kind === 'tee') {
    const branch = VEC[dirs[2]];
    // Across the run, away from the branch; along the run, one pitch a pole.
    const along: Pt = [Math.abs(branch[1]), Math.abs(branch[0])];
    return [
      -branch[0] * i * pitch + along[0] * i * pitch,
      -branch[1] * i * pitch + along[1] * i * pitch,
    ];
  }
  const v = VEC[dirs[0]];
  return [Math.abs(v[1]) * i * pitch, Math.abs(v[0]) * i * pitch];
}

/** The drawing of one face of a connector, at the origin. */
function face(
  kind: ConnectorKind, dirs: Dir[], poles: number, names: string[], textSize: number,
): Shape[] {
  const out: Shape[] = [];
  for (let i = 0; i < poles; i++) {
    const [x, y] = poleOffset(kind, dirs, i, POLE_PITCH);
    if (kind === 'tee') {
      out.push({ t: 'circle', cx: x, cy: y, r: 1.4, layer: 'WIRE', fill: 'currentColor', width: 0.3 });
    }
    if (kind === 'break') {
      // A chevron pointing on, away from the wire, and the name past it.
      const name = names[i] ?? names[0] ?? '?';
      const on = VEC[dirs[0]].map(c => -c) as Pt;
      const side: Pt = [Math.abs(on[1]), Math.abs(on[0])];
      const tip: Pt = [x + on[0] * 4, y + on[1] * 4];
      // On the symbol's layer, not the wire's: a conductor touching the point
      // would read as a wire already landed on it, and nothing would join.
      out.push({
        t: 'poly', layer: 'SYMBOL', width: 0.5,
        pts: [
          [tip[0] - on[0] * 2.5 + side[0] * 2, tip[1] - on[1] * 2.5 + side[1] * 2],
          tip,
          [tip[0] - on[0] * 2.5 - side[0] * 2, tip[1] - on[1] * 2.5 - side[1] * 2],
        ],
      });
      out.push({ t: 'line', x1: x, y1: y, x2: tip[0], y2: tip[1], layer: 'SYMBOL', width: 0.5 });
      const upright = on[1] !== 0;
      out.push({
        t: 'text',
        x: upright ? tip[0] : tip[0] + on[0] * 1.5,
        y: upright ? tip[1] + (on[1] > 0 ? textSize : -1.5) : tip[1] + textSize * 0.35,
        s: name, size: textSize,
        anchor: upright ? 'middle' : on[0] > 0 ? 'start' : 'end',
        layer: 'TAG',
      });
    }
    out.push(...terminalMarks(dirs.map((dir, k) => ({
      x, y, dir,
      name: kind === 'break' ? (names[i] ?? names[0] ?? '?') : `${i + 1}.${k + 1}`,
    }))));
  }
  return out;
}

/**
 * A connector as the placing cursor takes it: its faces, each one a variant,
 * each shape marked as what it is.
 */
export function connectorVariants(
  kind: ConnectorKind, poles: number, names: string[] = [], textSize = 4,
): { name: string; shapes: Shape[]; id: string }[] {
  const n = Math.max(1, Math.min(4, Math.round(poles) || 1));
  const id = `${CONNECTOR}${kind}`;
  return FACES[kind].map(f => ({
    name: kind === 'break' ? `⇢${names.join(',') || '?'}` : `${f.name}${n > 1 ? ` ×${n}` : ''}`,
    id,
    shapes: face(kind, f.dirs, n, names, textSize).map(s => ({ ...s, symbol: id })),
  }));
}
