// src/utils/cad/ioPages.ts
//
// I/O list in, wiring diagram out.
//
// This is the week of work the list was always going to cost: the same four
// symbols down the same path, forty times a page, with the same four numbers
// typed beside them. It is exactly the kind of work a machine should do, and
// exactly the kind a person doing it by hand gets wrong in the last hour of a
// Thursday — which is when the drawing starts disagreeing with the list.
//
// What comes out is a real wiring diagram, not a diagram-shaped picture:
//
//   · potential rails top and bottom, L+ and M, drawn across the page
//   · one path per signal, numbered along the top the way EPLAN numbers them
//   · the field device, the terminal on its strip, and the PLC channel, each
//     tagged with what the list called it
//   · every device a block with its terminals, so the connection list, the
//     terminal diagram and the checks all read off it afterwards
//
// The order of a path is not decoration either. An input is fed from the field:
// rail, device, terminal, channel, rail. An output drives the field: rail,
// channel, terminal, load, rail. Drawing an output the way round of an input
// puts the load upstream of the card, which is a panel that does not work.

import { Drawing, Layer, Pt, Shape } from './shapes';
import { LibraryItem, placeSymbolAt } from './symbolSource';
import { newBlockId } from './geom';
import { wdItems } from './wdSymbols';
import { IoPoint } from '../ioList';

export interface PageOptions {
  /** Sheet size in millimetres. A3 landscape unless something says otherwise. */
  width?: number;
  height?: number;
  /** Paths to a page. Eight is what an A3 holds and stays readable. */
  perPage?: number;
  /** The rails' names, as the panel's own drawings write them. */
  positive?: string;
  negative?: string;
}

export interface IoPage {
  /** 1-based, for the page name. */
  index: number;
  of: number;
  shapes: Shape[];
  width: number;
  height: number;
  /** The points drawn on it, for the note under the page name. */
  points: IoPoint[];
}

const DEFAULTS = {
  width: 420, height: 297, perPage: 8, positive: 'L+', negative: 'M',
};

/** Where the two rails sit, and the band the devices are drawn in between. */
const RAIL_TOP = 34;
const RAIL_BOTTOM = 210;
/**
 * How far above the bottom of the sheet the function text starts.
 *
 * It is written up the page, so this is where it *begins* and it grows
 * upwards from here — which is why it is measured off the bottom edge rather
 * than off the rail. Starting it at the rail and letting it grow upward, as
 * the first attempt did, ran it back through the circuit.
 */
const FOOT = 12;
/** As many characters as fit between the bottom edge and the lower rail. */
const TEXT_LIMIT = 30;
/** The left margin the rails start at, and the pitch between paths. */
const LEFT = 30;
const PITCH = 45;

const line = (x1: number, y1: number, x2: number, y2: number,
  layer: Layer, width = 1): Shape => ({ t: 'line', x1, y1, x2, y2, layer, width });

const text = (x: number, y: number, s: string, size: number,
  layer: Layer, anchor: 'start' | 'middle' | 'end' = 'start', rot?: number): Shape =>
  ({ t: 'text', x, y, s, size, anchor, layer, ...(rot ? { rot } : {}) });

/** The library, by id, built once per run. */
function byId(): Map<string, LibraryItem> {
  const m = new Map<string, LibraryItem>();
  for (const item of wdItems()) if (item.id) m.set(item.id, item);
  return m;
}

/**
 * One device on a path: placed at `y`, wired into the path, tagged beside it.
 *
 * Returns where the next thing down the path should start — the bottom of what
 * was just placed — so a path is built by handing that on rather than by each
 * step knowing where the one before it ended.
 */
function device(
  item: LibraryItem, x: number, y: number, tag: string, note: string,
  pins?: Record<string, string>,
): { shapes: Shape[]; bottom: number } {
  const block = newBlockId();
  let placed = placeSymbolAt(item, { x, y }, undefined, block);
  const bottom = y + item.height;

  // The list's own names for this device's connection points, in the order the
  // symbol declares them.
  //
  // A terminal out of the library is called `1` because that is what the
  // symbol is drawn with; the one on this path is terminal 7 of strip -X1, and
  // if the drawing does not say so then neither does the connection list, and
  // the panel is wired off a list that says `-X1:1` twelve times.
  if (pins) {
    // By the symbol's own name for the point, not by position: an output's
    // signal is its second terminal and an input's is its first, and renaming
    // by counting would put the address on the common of every output on the
    // page.
    placed = placed.map(s => (s.pin && pins[s.pin] ? { ...s, pin: pins[s.pin] } : s));
  }

  const shapes: Shape[] = [...placed];

  // Clear of the symbol's own right edge, whatever that edge is.
  //
  // A symbol is placed by its first terminal, and how much ink sits either
  // side of that terminal is the symbol's business: a contact is ten units
  // wide about it, a PLC channel reaches twenty-eight units to the right
  // because the card's edge is drawn there. A fixed offset put the card's tag
  // and the address inside the box they belong beside.
  // A library item without terminals is placed by the middle of its ink, so
  // that is the offset to measure from when one turns up.
  const anchor = item.terminals?.[0]?.x ?? item.width / 2;
  const right = x - anchor + item.width + 2;

  if (tag) shapes.push(text(right, y + 5, tag, 3.6, 'TAG'));
  if (note) shapes.push(text(right, y + 10.5, note, 3.2, 'TEXT'));
  return { shapes, bottom };
}

/**
 * A page of paths.
 *
 * The rails are drawn once, across everything; each path hangs between them.
 */
function drawPage(
  points: IoPoint[], index: number, of: number, o: Required<PageOptions>,
): IoPage {
  const lib = byId();
  const shapes: Shape[] = [];
  const right = LEFT + Math.max(points.length, 1) * PITCH;

  // The two potentials, with their names at the left where the eye starts.
  shapes.push(line(LEFT - 12, RAIL_TOP, right, RAIL_TOP, 'BUS', 1.6));
  shapes.push(line(LEFT - 12, RAIL_BOTTOM, right, RAIL_BOTTOM, 'BUS', 1.6));
  shapes.push(text(LEFT - 12, RAIL_TOP - 3, o.positive, 5, 'TAG'));
  shapes.push(text(LEFT - 12, RAIL_BOTTOM - 3, o.negative, 5, 'TAG'));

  points.forEach((p, i) => {
    const x = LEFT + i * PITCH;

    // The path number, along the top. Per page, the way a draughtsman counts
    // them when looking at one sheet.
    shapes.push(text(x, RAIL_TOP - 10, String(i + 1), 5, 'TITLE', 'middle'));
    shapes.push(line(x, RAIL_TOP - 7, x, RAIL_TOP, 'FRAME', 0.4));

    // What goes on the path, top to bottom.
    //
    // The tags and the pin names together are the device tag the connection
    // list will print. A terminal is strip `-X1` with connection point `7`, so
    // it reads `-X1:7`; a PLC point is card `-A1` with connection point
    // `I0.0`, so it reads `-A1:I0.0`. That is EPLAN's own way round, and it is
    // the right one: the address *is* where the wire lands on the card.
    const field = { id: p.symbol, tag: p.tag, note: '' };
    // Both sides of the terminal carry its number.
    const terminal = {
      id: 'terminal', tag: p.strip, note: '',
      pins: { '1': p.terminal || '1' },
    };
    // The signal side is the address; the common keeps whatever the symbol
    // called it — M on a digital card, `-` on an analogue one.
    const channel = {
      id: channelOf(p.kind), tag: p.card, note: p.address,
      pins: { [signalPin(p.kind)]: p.address },
    };

    const chain = p.kind === 'DI' || p.kind === 'AI'
      // Fed from the field: the device closes, the signal arrives at the card.
      ? [field, terminal, channel]
      // Driving the field: the card switches, the load is downstream of it.
      : [channel, terminal, field];

    // Spread the chain evenly down the band, so paths line up across the page
    // and a reader's eye can run along a row of terminals.
    const band = RAIL_BOTTOM - RAIL_TOP;
    const step = band / (chain.length + 1);
    let from: Pt = [x, RAIL_TOP];

    chain.forEach((link, n) => {
      const item = lib.get(link.id) ?? lib.get('terminal')!;
      const y = RAIL_TOP + step * (n + 1) - item.height / 2;
      const { shapes: drawn, bottom } = device(
        item, x, y, link.tag, link.note,
        (link as { pins?: Record<string, string> }).pins);
      shapes.push(line(from[0], from[1], x, y, 'WIRE', 1));
      shapes.push(...drawn);
      from = [x, bottom];
    });

    shapes.push(line(from[0], from[1], x, RAIL_BOTTOM, 'WIRE', 1));

    // What the signal does, written up the page under it — the path function
    // text. Turned because a description is longer than a path is wide, and
    // shrinking it until it fits is how a drawing becomes unreadable.
    if (p.description) {
      shapes.push(text(
        x, o.height - FOOT, p.description.slice(0, TEXT_LIMIT), 3.6, 'TEXT', 'start', -90));
    }
  });

  return {
    index, of, shapes, points,
    width: o.width, height: o.height,
  };
}

/** What the card's own symbol calls the point the signal lands on. */
const signalPin = (kind: IoPoint['kind']): string =>
  kind === 'DI' ? 'I' : kind === 'DO' ? 'Q' : '+';

const channelOf = (kind: IoPoint['kind']): string =>
  kind === 'DI' ? 'plc-di' : kind === 'DO' ? 'plc-do'
  : kind === 'AI' ? 'plc-ai' : 'plc-ao';

/**
 * The whole set of pages for a list.
 *
 * Grouped by card first, then split into pages, because a panel is built card
 * by card and a sheet with two cards' signals on it is a sheet somebody has to
 * read twice. Within a card the list's own order is kept — it is usually the
 * address order, and where it is not, it is the order the process runs in,
 * which is better.
 */
export function buildIoPages(points: IoPoint[], options: PageOptions = {}): IoPage[] {
  const o = { ...DEFAULTS, ...options };
  if (points.length === 0) return [];

  const byCard = new Map<string, IoPoint[]>();
  for (const p of points) {
    const card = p.card || '';
    if (!byCard.has(card)) byCard.set(card, []);
    byCard.get(card)!.push(p);
  }

  const groups: IoPoint[][] = [];
  for (const list of byCard.values()) {
    for (let i = 0; i < list.length; i += o.perPage) {
      groups.push(list.slice(i, i + o.perPage));
    }
  }

  return groups.map((group, i) => drawPage(group, i + 1, groups.length, o));
}

/** A page's shapes as a Drawing, for anything that wants one. */
export function drawingOf(page: IoPage, name: string): Drawing {
  const d = new Drawing(page.width, page.height, name);
  for (const s of page.shapes) d.add(s);
  return d;
}
