// src/utils/cad/terminals.ts
//
// Connection points, and what a wire landing on one means.
//
// Up to here a connection in this editor joined two *coordinates*. It routed
// squarely, it put a dot where it crossed, and it looked exactly right — but
// nothing in the file said which device either end belonged to, so nothing
// could be reported off it. A drawing that cannot be reported off is a picture.
//
// A connection point fixes that, and it is a small thing: a marker on the PIN
// layer, carrying the designation the manufacturer prints on the device — A1
// and A2 on a coil, 13 and 14 on an auxiliary contact, I0.0 on a PLC input.
// The marker belongs to the symbol's block, so it moves, scales and mirrors
// with it and needs no upkeep. A wire ending within reach of one is on that
// terminal, and the connection list can then say `-K1:A1 → -X1:3` and mean it.
//
// Nothing here changes how a drawing looks. Every rule in this file is about
// what a drawing *says*.

import { Pt, Shape } from './shapes';
import { Device, Message, devices, nets } from './schematic';

/** How near a wire end must come to a marker to be on that terminal. */
export const REACH = 1.2;

/** Radius of the marker drawn at a connection point, in drawing units. */
export const MARK_R = 1.1;

/**
 * How coarsely a point is rounded when the wire is walked as a graph.
 *
 * The same figure `nets` joins its segments at. Coarser and two nearby
 * junctions merge into one; finer and a run that visibly meets another is
 * walked as though it did not.
 */
const NODE = 0.35;

export interface Terminal {
  /** Index of the marker shape, so a message can point back at it. */
  index: number;
  at: Pt;
  /** What the device calls this point — A1, 13, I0.0. */
  name: string;
  /** Which way its wire leaves, where the symbol was drawn with one. */
  dir?: 'up' | 'down' | 'left' | 'right';
  /** The block it belongs to, or '' for a loose marker somebody drew. */
  block: string;
  blockName: string;
}

/** Every connection point on the sheet. */
export function terminals(shapes: Shape[]): Terminal[] {
  const out: Terminal[] = [];
  shapes.forEach((s, index) => {
    const name = String(s.pin ?? '').trim();
    if (!name) return;
    out.push({
      index,
      at: centreOf(s),
      name,
      ...(isDir(s.pinDir) ? { dir: s.pinDir } : {}),
      block: s.block ?? '',
      blockName: s.blockName ?? '',
    });
  });
  return out;
}

function centreOf(s: Shape): Pt {
  switch (s.t) {
    case 'circle':
    case 'ellipse':
    case 'arc': return [s.cx, s.cy];
    case 'rect': return [s.x + s.w / 2, s.y + s.h / 2];
    case 'line': return [(s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2];
    case 'curve': return [(s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2];
    case 'text': return [s.x, s.y];
    case 'poly': {
      const xs = s.pts.map(p => p[0]);
      const ys = s.pts.map(p => p[1]);
      return [(Math.min(...xs) + Math.max(...xs)) / 2,
              (Math.min(...ys) + Math.max(...ys)) / 2];
    }
  }
}

/**
 * The marker shapes for a symbol's connection points.
 *
 * Drawn as a small open circle so that a draughtsman can see where a wire is
 * meant to land, which is also why they are on their own layer: switch PIN off
 * and the sheet is the sheet, switch it on and the sheet shows its terminals.
 */
export function terminalMarks(
  points: { x: number; y: number; name: string; dir?: string }[],
  block?: string, blockName?: string,
): Shape[] {
  return points.map(p => ({
    t: 'circle' as const,
    cx: p.x, cy: p.y, r: MARK_R,
    layer: 'PIN' as const,
    width: 0.4,
    pin: p.name,
    // The way the wire leaves, where the symbol was drawn with one. It rides
    // on the marker rather than in a table beside it so that moving, scaling,
    // mirroring and exporting the block carry it without knowing it is there.
    ...(isDir(p.dir) ? { pinDir: p.dir } : {}),
    ...(block ? { block, blockName: blockName ?? '' } : {}),
  }));
}

const DIRS = ['up', 'down', 'left', 'right'] as const;

/** A direction the drawing understands, or nothing. Strings arrive from JSON. */
export const isDir = (d: unknown): d is 'up' | 'down' | 'left' | 'right' =>
  typeof d === 'string' && (DIRS as readonly string[]).includes(d);

/** The terminal nearest (x, y) within `tolerance`, or null. */
export function nearestTerminal(
  list: Terminal[], x: number, y: number, tolerance: number,
): Terminal | null {
  let best: Terminal | null = null;
  let bestDistance = tolerance;
  for (const t of list) {
    const d = Math.hypot(t.at[0] - x, t.at[1] - y);
    if (d <= bestDistance) { best = t; bestDistance = d; }
  }
  return best;
}

// ── What is connected to what ──────────────────────────────────────────────

export interface TerminalRef {
  /** The device's designation, or its block name when it has not been tagged. */
  device: string;
  /** The connection point on it. */
  pin: string;
  tagged: boolean;
}

export interface Connection {
  /** Which net of the sheet this belongs to, by index. */
  net: number;
  from: TerminalRef;
  to: TerminalRef;
}

const refOf = (t: Terminal, byBlock: Map<string, Device>): TerminalRef => {
  const device = byBlock.get(t.block);
  const tag = device?.tag?.trim();
  return {
    device: tag || t.blockName || '?',
    pin: t.name,
    tagged: Boolean(tag),
  };
};

const sortKey = (r: TerminalRef) => `${r.device}:${r.pin}`;

/**
 * The connection list: which terminal is wired to which, as drawn.
 *
 * Not every pair on a net. A net joining four terminals is not six
 * connections — it is the three the draughtsman actually drew, and which three
 * is written in the geometry. So the conductor is walked: from a terminal,
 * along the wire, until another terminal is reached, and that pair is one
 * connection. A run passing straight through a junction keeps going; a run
 * arriving at a terminal stops there, because the next length of wire leaving
 * that terminal is the next connection and the next ferrule.
 *
 * This is the difference between a list somebody can wire a panel from and a
 * list of everything that happens to share a potential.
 */
export function connections(shapes: Shape[]): Connection[] {
  const marks = terminals(shapes);
  if (marks.length === 0) return [];

  const byBlock = new Map<string, Device>();
  for (const d of devices(shapes)) byBlock.set(d.block, d);

  const out: Connection[] = [];
  const seen = new Set<string>();

  nets(shapes).forEach((net, index) => {
    // The net as a graph of points, at the same tolerance the net was found
    // with, so a node here is a node there.
    const node = (p: Pt) => `${Math.round(p[0] / NODE)}:${Math.round(p[1] / NODE)}`;
    const links = new Map<string, Set<string>>();
    const place = new Map<string, Pt>();
    const link = (a: Pt, b: Pt) => {
      const ka = node(a), kb = node(b);
      place.set(ka, a); place.set(kb, b);
      if (ka === kb) return;
      if (!links.has(ka)) links.set(ka, new Set());
      if (!links.has(kb)) links.set(kb, new Set());
      links.get(ka)!.add(kb);
      links.get(kb)!.add(ka);
    };
    for (const seg of net.segments) link(seg.a, seg.b);

    // Which node each terminal sits on. A terminal that no wire reaches has
    // none, and takes no part.
    const at = new Map<string, Terminal[]>();
    for (const m of marks) {
      const on = net.points.find(
        p => Math.hypot(p[0] - m.at[0], p[1] - m.at[1]) <= REACH);
      if (!on) continue;
      const k = node(on);
      if (!at.has(k)) at.set(k, []);
      at.get(k)!.push(m);
    }
    if (at.size === 0) return;

    // From each terminal node, walk the wire until the next terminal node.
    for (const start of at.keys()) {
      const stack: string[] = [...(links.get(start) ?? [])];
      const visited = new Set<string>([start]);
      while (stack.length) {
        const here = stack.pop()!;
        if (visited.has(here)) continue;
        visited.add(here);
        if (at.has(here)) { record(start, here); continue; }
        for (const next of links.get(here) ?? []) {
          if (!visited.has(next)) stack.push(next);
        }
      }
      // Two terminals landing on the same node are wired to each other with no
      // wire between them — a link, a bridge, two ferrules in one hole. Real,
      // and invisible to a walk, so it is taken here.
      const together = at.get(start)!;
      for (let i = 0; i < together.length; i++) {
        for (let j = i + 1; j < together.length; j++) {
          pair(together[i], together[j]);
        }
      }
    }

    function record(fromNode: string, toNode: string) {
      for (const a of at.get(fromNode) ?? []) {
        for (const b of at.get(toNode) ?? []) pair(a, b);
      }
    }

    function pair(a: Terminal, b: Terminal) {
      // A device wired to itself is a short across it — real on a link, noise
      // everywhere else, and reported by the sheet check rather than listed.
      if (a.block && a.block === b.block) return;
      const ra = refOf(a, byBlock);
      const rb = refOf(b, byBlock);
      const [from, to] = sortKey(ra) <= sortKey(rb) ? [ra, rb] : [rb, ra];
      // Walked from both ends, so every connection is found twice.
      const id = `${index}|${sortKey(from)}|${sortKey(to)}`;
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ net: index, from, to });
    }
  });

  return out.sort((x, y) =>
    sortKey(x.from).localeCompare(sortKey(y.from), undefined, { numeric: true })
    || sortKey(x.to).localeCompare(sortKey(y.to), undefined, { numeric: true }));
}

/** Terminals with nothing wired to them — a gap, reported as one. */
export function looseTerminals(shapes: Shape[]): Terminal[] {
  const marks = terminals(shapes);
  if (marks.length === 0) return [];
  const points = nets(shapes).flatMap(n => n.points);
  return marks.filter(m => !points.some(
    p => Math.hypot(p[0] - m.at[0], p[1] - m.at[1]) <= REACH));
}

/**
 * What the terminals say is wrong with the sheet.
 *
 * Kept here rather than in `checkSheet` so that `schematic.ts` — which every
 * one of these functions reads from — does not have to read back from this
 * one. The editor runs both and shows one list.
 */
export function checkTerminals(shapes: Shape[]): Message[] {
  return [...openPins(shapes), ...splitPotentials(shapes)];
}

/**
 * The same terminal shown on two different potentials.
 *
 * On a wiring diagram one terminal is drawn in as many places as it is wired
 * in: -X1:7 appears on the path it belongs to, the card's common M appears on
 * every channel of the card. Those are the same physical point, drawn twice,
 * and that is not a fault.
 *
 * What cannot be true is the same point being at two different potentials at
 * once. That is either two terminals wrongly given one number, or a wire on
 * the wrong one — and either way it is a panel that does not work, found here
 * rather than by an electrician with a meter.
 */
function splitPotentials(shapes: Shape[]): Message[] {
  const marks = terminals(shapes);
  if (marks.length === 0) return [];

  const byBlock = new Map<string, Device>();
  for (const d of devices(shapes)) byBlock.set(d.block, d);

  const all = nets(shapes);
  const netOf = (t: Terminal): number => all.findIndex(
    n => n.points.some(p => Math.hypot(p[0] - t.at[0], p[1] - t.at[1]) <= REACH));

  // Every drawn occurrence of a device:pin, which net it is on, and which
  // symbol it came off.
  const seen = new Map<string, { nets: Set<number>; blocks: Set<string>; marks: Terminal[] }>();
  for (const m of marks) {
    const net = netOf(m);
    if (net < 0) continue;              // unwired; `openPins` has that one
    const ref = refOf(m, byBlock);
    const id = sortKey(ref);
    if (!seen.has(id)) seen.set(id, { nets: new Set(), blocks: new Set(), marks: [] });
    const e = seen.get(id)!;
    e.nets.add(net);
    e.blocks.add(m.block);
    e.marks.push(m);
  }

  const out: Message[] = [];
  for (const [id, e] of seen) {
    if (e.nets.size < 2) continue;
    // One symbol with the same designation on both sides is a terminal, and a
    // terminal separating two nets is the entire job of a terminal. It is only
    // a fault when two *different* symbols claim the point, because then two
    // pieces of metal are wearing one number.
    if (e.blocks.size < 2) continue;
    out.push({
      cls: 'error', code: 'E-SPLIT-PIN', category: 'Connections',
      text: `${id} is drawn on ${e.nets.size} different potentials — one terminal cannot be at two.`,
      shapes: e.marks.map(m => m.index),
      at: e.marks[0].at,
    });
  }
  return out;
}

/** Connection points with nothing wired to them. */
function openPins(shapes: Shape[]): Message[] {
  const loose = looseTerminals(shapes);
  if (loose.length === 0) return [];

  // Grouped by device, because "17 unwired terminals" as seventeen messages is
  // a wall, and the thing somebody acts on is the device, not the pin.
  const byBlock = new Map<string, Terminal[]>();
  for (const t of loose) {
    const k = t.block || `loose:${t.index}`;
    if (!byBlock.has(k)) byBlock.set(k, []);
    byBlock.get(k)!.push(t);
  }

  const tags = new Map<string, Device>();
  for (const d of devices(shapes)) tags.set(d.block, d);

  return [...byBlock.values()].map(group => {
    const first = group[0];
    const device = tags.get(first.block)?.tag || first.blockName || 'A symbol';
    const pins = group.map(t => t.name).join(', ');
    return {
      cls: 'warning' as const,
      code: 'W-OPEN-PIN',
      category: 'Connections',
      text: `${device}: nothing is wired to ${group.length === 1 ? 'terminal' : 'terminals'} ${pins}.`,
      shapes: group.map(t => t.index),
      at: first.at,
    };
  });
}
