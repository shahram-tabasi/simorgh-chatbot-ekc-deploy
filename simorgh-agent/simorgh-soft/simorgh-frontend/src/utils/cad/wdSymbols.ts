// src/utils/cad/wdSymbols.ts
//
// The wiring-diagram library: the multi-line symbols a control panel is drawn
// from.
//
// The single-line library in `iecSymbols.ts` was drawn from this office's own
// SLD legend sheet, and it is right for what it is for — one line for a whole
// feeder. It is the wrong answer on a wiring diagram, where a contactor is not
// a rectangle on a branch but a coil on one path and three main contacts on
// another and an auxiliary on a third. That is what this file draws.
//
// Every symbol here carries its terminals, with the designations the device
// itself is marked with, because on a wiring diagram those numbers are the
// point: A1 and A2 are what the coil's two wires land on, 13 and 14 are what
// the ferrules say, and a drawing that leaves them out is a drawing somebody
// has to look up a datasheet to wire. The numbering follows EN 50005 and
// IEC 60947 — 13/14 for a normally-open auxiliary, 11/12 for a normally
// closed, 1/2 · 3/4 · 5/6 for main poles, 95/96 and 97/98 for an overload,
// A1/A2 for a coil — so that what the drawing says matches what is printed on
// the part in the drawer.
//
// Geometry, not markup: these are built as shapes and handed over as shapes.
// The SVG is rendered once, for the thumbnail in the library panel. Round-
// tripping a symbol through SVG to get it back as geometry is work for nothing
// and a chance to lose a layer every time.

import { Drawing, Layer, Pt, Shape } from './shapes';
import { renderFragment } from './svg';
import type { LibraryItem } from './symbolSource';

/** Distance between the two terminals of an in-line device. */
const H = 20;
/** The box an in-line device is drawn in. */
const W = 20;
/** Centre line of a single-pole device — the conductor runs down it. */
const CX = W / 2;
/** Pole pitch on a three-pole device, and the box it needs. */
const POLE = 15;
const W3 = 45;
/** Height of the little numbers printed beside a terminal. */
const PIN_TEXT = 3.2;

type Term = { x: number; y: number; name: string };

interface Def {
  id: string;
  name: string;
  group: string;
  width: number;
  height: number;
  terminals: Term[];
  draw: () => Shape[];
}

// ── Drawing helpers ────────────────────────────────────────────────────────
// Deliberately terse: the symbols below should read as what they look like,
// not as a wall of object literals.

const line = (x1: number, y1: number, x2: number, y2: number,
  layer: Layer = 'SYMBOL', width = 1, dash?: string): Shape =>
  ({ t: 'line', x1, y1, x2, y2, layer, width, ...(dash ? { dash } : {}) });

const wire = (x1: number, y1: number, x2: number, y2: number): Shape =>
  line(x1, y1, x2, y2, 'SYMBOL', 1);

const circle = (cx: number, cy: number, r: number, fill?: string): Shape =>
  ({ t: 'circle', cx, cy, r, layer: 'SYMBOL', width: 1, ...(fill ? { fill } : {}) });

const rect = (x: number, y: number, w: number, h: number, dash?: string): Shape =>
  ({ t: 'rect', x, y, w, h, layer: 'SYMBOL', width: 1, ...(dash ? { dash } : {}) });

const poly = (pts: Pt[], close = false): Shape =>
  ({ t: 'poly', pts, close, layer: 'SYMBOL', width: 1 });

const label = (x: number, y: number, s: string, size = PIN_TEXT,
  anchor: 'start' | 'middle' | 'end' = 'start'): Shape =>
  ({ t: 'text', x, y, s, size, anchor, layer: 'TEXT' });

/** The numbers printed beside the terminals, where the device prints them. */
const pinLabels = (terms: Term[], height: number): Shape[] =>
  terms.map(t => label(
    t.x + 2.2,
    // Above the line at the top of a symbol, below it at the bottom, so the
    // number never sits on the conductor it belongs to.
    t.y <= height / 2 ? t.y - 1.2 : t.y + PIN_TEXT + 1.2,
    t.name, PIN_TEXT,
  ));

/** The stub of conductor between the box edge and the device itself. */
const stubs = (x: number, top: number, bottom: number, height: number): Shape[] =>
  [wire(x, 0, x, top), wire(x, bottom, x, height)];

// ── The contact family ─────────────────────────────────────────────────────
// One drawing, three states. A normally-open contact is the blade standing
// clear of the fixed contact; normally closed adds the bar across it; the
// changeover is both fixed contacts with the blade resting on one.

/** The moving blade, hinged at the bottom terminal, leaning to the right. */
const blade = (x: number, y0: number, y1: number): Shape =>
  line(x, y1, x + 5, y0, 'SYMBOL', 1.2);

function contactNO(): Shape[] {
  return [...stubs(CX, 6, 14, H), blade(CX, 6, 14)];
}

function contactNC(): Shape[] {
  return [
    ...stubs(CX, 6, 14, H),
    // The blade runs past the fixed contact rather than stopping short of it,
    // and the bar it presses against is drawn across. Both are needed: a break
    // contact whose blade merely leans, like a make contact, is a break
    // contact nobody reads as one, and on a wiring diagram that is a circuit
    // that stops when it should start.
    line(CX, 14, CX + 5, 3, 'SYMBOL', 1.2),
    line(CX + 1.5, 6, CX + 8, 6, 'SYMBOL', 1.2),
  ];
}

function contactCO(): Shape[] {
  return [
    wire(CX, 14, CX, H),
    wire(CX - 6, 0, CX - 6, 6),
    wire(CX + 6, 0, CX + 6, 6),
    line(CX, 14, CX - 6, 6, 'SYMBOL', 1.2),
  ];
}

// ── The definitions ────────────────────────────────────────────────────────

const DEFS: Def[] = [
  {
    id: 'no-contact', name: 'Contact, normally open', group: 'Contacts',
    width: W, height: H,
    terminals: [{ x: CX, y: 0, name: '13' }, { x: CX, y: H, name: '14' }],
    draw: contactNO,
  },
  {
    id: 'nc-contact', name: 'Contact, normally closed', group: 'Contacts',
    width: W, height: H,
    terminals: [{ x: CX, y: 0, name: '11' }, { x: CX, y: H, name: '12' }],
    draw: contactNC,
  },
  {
    id: 'changeover-contact', name: 'Contact, changeover', group: 'Contacts',
    width: W, height: H,
    terminals: [
      { x: CX - 6, y: 0, name: '12' }, { x: CX + 6, y: 0, name: '14' },
      { x: CX, y: H, name: '11' },
    ],
    draw: contactCO,
  },
  {
    id: 'pb-no', name: 'Push button, make', group: 'Control and signalling',
    width: W, height: H,
    terminals: [{ x: CX, y: 0, name: '13' }, { x: CX, y: H, name: '14' }],
    draw: () => [
      ...contactNO(),
      // The plunger: a stem off the blade with the button across the top.
      line(CX + 5, 6, CX + 5, 2.5, 'SYMBOL', 0.8),
      line(CX + 1.5, 2.5, CX + 8.5, 2.5, 'SYMBOL', 1.2),
    ],
  },
  {
    id: 'pb-nc', name: 'Push button, break', group: 'Control and signalling',
    width: W, height: H,
    terminals: [{ x: CX, y: 0, name: '11' }, { x: CX, y: H, name: '12' }],
    draw: () => [
      ...contactNC(),
      line(CX + 4, 4.5, CX + 4, 1, 'SYMBOL', 0.8),
      line(CX + 0.5, 1, CX + 7.5, 1, 'SYMBOL', 1.2),
    ],
  },
  {
    id: 'estop', name: 'Emergency stop', group: 'Control and signalling',
    width: W, height: H,
    terminals: [{ x: CX, y: 0, name: '11' }, { x: CX, y: H, name: '12' }],
    draw: () => [
      ...contactNC(),
      line(CX + 4, 4.5, CX + 4, 2, 'SYMBOL', 0.8),
      // The mushroom head — what makes it an emergency stop rather than a
      // button that happens to be red on somebody's paint schedule.
      { t: 'arc', cx: CX + 4, cy: 2, r: 3.5, a0: 180, a1: 360,
        layer: 'SYMBOL', width: 1.2 } as Shape,
    ],
  },
  {
    id: 'limit-no', name: 'Limit switch, make', group: 'Control and signalling',
    width: W, height: H,
    terminals: [{ x: CX, y: 0, name: '13' }, { x: CX, y: H, name: '14' }],
    draw: () => [...contactNO(), poly([[CX + 5, 6], [CX + 9, 3], [CX + 9, 6]], true)],
  },
  {
    id: 'limit-nc', name: 'Limit switch, break', group: 'Control and signalling',
    width: W, height: H,
    terminals: [{ x: CX, y: 0, name: '11' }, { x: CX, y: H, name: '12' }],
    draw: () => [...contactNC(), poly([[CX + 4, 7.5], [CX + 8, 4.5], [CX + 8, 7.5]], true)],
  },
  {
    id: 'selector-2pos', name: 'Selector switch, two position',
    group: 'Control and signalling', width: W, height: H,
    terminals: [{ x: CX, y: 0, name: '13' }, { x: CX, y: H, name: '14' }],
    draw: () => [...contactNO(), line(CX + 2, 11, CX + 8, 8, 'SYMBOL', 0.8, '2 1.5')],
  },
  {
    id: 'coil', name: 'Coil', group: 'Coils and actuators',
    width: W, height: H,
    terminals: [{ x: CX, y: 0, name: 'A1' }, { x: CX, y: H, name: 'A2' }],
    draw: () => [...stubs(CX, 6, 14, H), rect(CX - 6, 6, 12, 8)],
  },
  {
    id: 'coil-on-delay', name: 'Coil, on delay', group: 'Coils and actuators',
    width: W, height: H,
    terminals: [{ x: CX, y: 0, name: 'A1' }, { x: CX, y: H, name: 'A2' }],
    draw: () => [
      ...stubs(CX, 6, 14, H), rect(CX - 6, 6, 12, 8),
      // The half-filled box: the IEC way of saying the delay is on pick-up.
      poly([[CX - 6, 6], [CX, 6], [CX, 14], [CX - 6, 14]], true),
    ],
  },
  {
    id: 'main-contact-3p', name: 'Main contacts, three pole', group: 'Contacts',
    width: W3, height: H,
    terminals: [
      { x: 7.5, y: 0, name: '1' }, { x: 7.5, y: H, name: '2' },
      { x: 7.5 + POLE, y: 0, name: '3' }, { x: 7.5 + POLE, y: H, name: '4' },
      { x: 7.5 + 2 * POLE, y: 0, name: '5' }, { x: 7.5 + 2 * POLE, y: H, name: '6' },
    ],
    draw: () => [0, 1, 2].flatMap(i => {
      const x = 7.5 + i * POLE;
      return [...stubs(x, 6, 14, H), blade(x, 6, 14)];
    }),
  },
  {
    id: 'overload-3p', name: 'Overload relay, three pole', group: 'Protection',
    width: W3, height: H,
    terminals: [
      { x: 7.5, y: 0, name: '1' }, { x: 7.5, y: H, name: '2' },
      { x: 7.5 + POLE, y: 0, name: '3' }, { x: 7.5 + POLE, y: H, name: '4' },
      { x: 7.5 + 2 * POLE, y: 0, name: '5' }, { x: 7.5 + 2 * POLE, y: H, name: '6' },
    ],
    draw: () => [0, 1, 2].flatMap(i => {
      const x = 7.5 + i * POLE;
      return [...stubs(x, 5, 15, H), rect(x - 4, 5, 8, 10),
        line(x - 4, 12, x + 4, 12, 'SYMBOL', 1.2)];
    }),
  },
  {
    id: 'overload-aux', name: 'Overload contact, break', group: 'Protection',
    width: W, height: H,
    terminals: [{ x: CX, y: 0, name: '95' }, { x: CX, y: H, name: '96' }],
    draw: () => [...contactNC(), line(CX + 2, 12, CX + 8, 12, 'SYMBOL', 0.8, '2 1.5')],
  },
  {
    id: 'fuse-1p', name: 'Fuse', group: 'Protection',
    width: W, height: H,
    terminals: [{ x: CX, y: 0, name: '1' }, { x: CX, y: H, name: '2' }],
    draw: () => [...stubs(CX, 5, 15, H), rect(CX - 3.5, 5, 7, 10),
      line(CX, 5, CX, 15, 'SYMBOL', 1.2)],
  },
  {
    id: 'mcb-1p', name: 'MCB, one pole', group: 'Protection',
    width: W, height: H,
    terminals: [{ x: CX, y: 0, name: '1' }, { x: CX, y: H, name: '2' }],
    draw: () => [
      ...stubs(CX, 6, 14, H), blade(CX, 6, 14),
      // The hook that says the blade is tripped open rather than switched.
      poly([[CX + 5, 6], [CX + 8, 6], [CX + 8, 3.5]]),
    ],
  },
  {
    id: 'mcb-3p', name: 'MCB, three pole', group: 'Protection',
    width: W3, height: H,
    terminals: [
      { x: 7.5, y: 0, name: '1' }, { x: 7.5, y: H, name: '2' },
      { x: 7.5 + POLE, y: 0, name: '3' }, { x: 7.5 + POLE, y: H, name: '4' },
      { x: 7.5 + 2 * POLE, y: 0, name: '5' }, { x: 7.5 + 2 * POLE, y: H, name: '6' },
    ],
    draw: () => [
      ...[0, 1, 2].flatMap(i => {
        const x = 7.5 + i * POLE;
        return [...stubs(x, 6, 14, H), blade(x, 6, 14),
          poly([[x + 5, 6], [x + 8, 6], [x + 8, 3.5]])];
      }),
      // The dashed tie: three poles that trip together.
      line(7.5 + 5, 9, 7.5 + 2 * POLE + 5, 9, 'SYMBOL', 0.8, '2 1.5'),
    ],
  },
  {
    id: 'terminal', name: 'Terminal', group: 'Terminals and plugs',
    width: W, height: H,
    // Both sides, and both called the same thing — because they are. A
    // terminal is one number with a field side and an internal side, and a
    // wire lands on each. Giving it one connection point makes it a dead end:
    // whatever is wired below it is connected to nothing above it, and the
    // connection list quietly loses half the panel.
    terminals: [{ x: CX, y: 0, name: '1' }, { x: CX, y: H, name: '1' }],
    draw: () => [wire(CX, 0, CX, H / 2 - 2.5), wire(CX, H / 2 + 2.5, CX, H),
      circle(CX, H / 2, 2.5, 'none')],
  },
  {
    id: 'lamp', name: 'Indicator lamp', group: 'Control and signalling',
    width: W, height: H,
    terminals: [{ x: CX, y: 0, name: 'X1' }, { x: CX, y: H, name: 'X2' }],
    draw: () => [
      ...stubs(CX, 5, 15, H), circle(CX, H / 2, 5, 'none'),
      line(CX - 3.5, H / 2 - 3.5, CX + 3.5, H / 2 + 3.5),
      line(CX - 3.5, H / 2 + 3.5, CX + 3.5, H / 2 - 3.5),
    ],
  },
  {
    id: 'motor-3ph', name: 'Motor, three phase', group: 'Motors and drives',
    width: W3, height: 30,
    terminals: [
      { x: 7.5, y: 0, name: 'U' },
      { x: 7.5 + POLE, y: 0, name: 'V' },
      { x: 7.5 + 2 * POLE, y: 0, name: 'W' },
      { x: 7.5 + POLE, y: 30, name: 'PE' },
    ],
    draw: () => [
      ...[0, 1, 2].map(i => wire(7.5 + i * POLE, 0, 7.5 + i * POLE, 6)),
      circle(7.5 + POLE, 15, 9, 'none'),
      label(7.5 + POLE, 17.5, 'M', 7, 'middle'),
      wire(7.5 + POLE, 24, 7.5 + POLE, 30),
    ],
  },
  {
    id: 'psu-24v', name: 'Power supply 24 V DC', group: 'Power supply',
    width: 40, height: 30,
    terminals: [
      { x: 8, y: 0, name: 'L' }, { x: 20, y: 0, name: 'N' }, { x: 32, y: 0, name: 'PE' },
      { x: 12, y: 30, name: '+' }, { x: 28, y: 30, name: '-' },
    ],
    draw: () => [
      rect(2, 6, 36, 18),
      wire(8, 0, 8, 6), wire(20, 0, 20, 6), wire(32, 0, 32, 6),
      wire(12, 24, 12, 30), wire(28, 24, 28, 30),
      label(20, 17, '24V DC', 5, 'middle'),
    ],
  },
  {
    id: 'sensor-pnp', name: 'Sensor, PNP three wire', group: 'Control and signalling',
    width: 30, height: 30,
    terminals: [
      { x: 6, y: 0, name: 'BN' }, { x: 15, y: 0, name: 'BK' }, { x: 24, y: 0, name: 'BU' },
    ],
    draw: () => [
      rect(3, 8, 24, 16),
      wire(6, 0, 6, 8), wire(15, 0, 15, 8), wire(24, 0, 24, 8),
      // The arrow through the box: a proximity sensor, not a plain junction.
      poly([[8, 20], [15, 12], [22, 20]]),
      label(15, 22.5, 'PNP', 4, 'middle'),
    ],
  },
  {
    id: 'transmitter', name: 'Transmitter, two wire', group: 'Measuring',
    width: 24, height: 30,
    // Two wires and both in the path: a 4–20 mA loop is powered down the same
    // pair it measures on, which is exactly why it can be drawn in one path
    // and a three-wire sensor cannot.
    terminals: [{ x: 12, y: 0, name: '+' }, { x: 12, y: 30, name: '-' }],
    draw: () => [
      wire(12, 0, 12, 6), wire(12, 24, 12, 30),
      circle(12, 15, 9, 'none'),
      label(12, 17.5, 'T', 7, 'middle'),
    ],
  },
  {
    id: 'relay-module', name: 'Interposing relay', group: 'Coils and actuators',
    width: 30, height: 30,
    terminals: [
      { x: 8, y: 0, name: 'A1' }, { x: 8, y: 30, name: 'A2' },
      { x: 22, y: 0, name: '11' }, { x: 22, y: 30, name: '14' },
    ],
    draw: () => [
      rect(2, 8, 26, 14, '3 2'),
      wire(8, 0, 8, 8), wire(8, 22, 8, 30),
      rect(4, 10, 8, 10),
      wire(22, 0, 22, 11), wire(22, 19, 22, 30),
      line(22, 19, 26, 11, 'SYMBOL', 1.2),
    ],
  },
  {
    id: 'xref', name: 'Cross reference', group: 'Cross references',
    width: W, height: 12,
    terminals: [{ x: CX, y: 0, name: '1' }],
    draw: () => [wire(CX, 0, CX, 5), poly([[CX - 4, 5], [CX + 4, 5], [CX, 11]], true)],
  },

  // ── The PLC channels ─────────────────────────────────────────────────────
  // A channel, not a card: on a wiring diagram a 16-way input module is drawn
  // as sixteen separate paths, each one channel wide, scattered across however
  // many pages the machine needs. The card as a single block belongs on the
  // overview page, and that is a different drawing.
  {
    id: 'plc-di', name: 'PLC digital input', group: 'PLC',
    width: 34, height: 20,
    terminals: [{ x: 6, y: 0, name: 'I' }, { x: 6, y: 20, name: 'M' }],
    draw: () => plcChannel('DI'),
  },
  {
    id: 'plc-do', name: 'PLC digital output', group: 'PLC',
    width: 34, height: 20,
    // The common at the top and the output at the bottom, which is the way
    // round an output is drawn: the card is fed from the positive rail and the
    // load hangs underneath it. An input is the other way round — the field
    // contact is above and the signal arrives from it — so the two symbols are
    // not mirror images by accident.
    // `L+` and not `M`: the supply an output card switches from is not the
    // common an input card returns to, and calling both of them M makes one
    // terminal that is at 24 V on half the pages and at 0 V on the other half.
    terminals: [{ x: 6, y: 0, name: 'L+' }, { x: 6, y: 20, name: 'Q' }],
    draw: () => plcChannel('DO'),
  },
  {
    id: 'plc-ai', name: 'PLC analogue input', group: 'PLC',
    width: 34, height: 20,
    terminals: [{ x: 6, y: 0, name: '+' }, { x: 6, y: 20, name: '-' }],
    draw: () => plcChannel('AI'),
  },
  {
    id: 'plc-ao', name: 'PLC analogue output', group: 'PLC',
    width: 34, height: 20,
    terminals: [{ x: 6, y: 0, name: '-' }, { x: 6, y: 20, name: '+' }],
    draw: () => plcChannel('AO'),
  },
];

/**
 * One channel of a PLC card: the conductor down the left, the card's edge as a
 * box to its right, and room in that box for the address and what the channel
 * does.
 *
 * The box is open on the left on purpose — it is the edge of a card that
 * carries on past this page, not a device that ends here.
 */
function plcChannel(kind: string): Shape[] {
  return [
    wire(6, 0, 6, 20),
    line(12, 0, 34, 0), line(12, 20, 34, 20), line(34, 0, 34, 20),
    line(12, 0, 12, 20, 'SYMBOL', 1, '3 2'),
    label(14, 12, kind, 5),
  ];
}

// ── Handing them over ──────────────────────────────────────────────────────

let cache: LibraryItem[] | null = null;

/**
 * The wiring-diagram library.
 *
 * Built once. Each item's SVG is rendered for the thumbnail, and its geometry
 * handed over as geometry — nothing here goes through markup and back.
 *
 * The terminal markers are not in the thumbnail. At the size the library panel
 * draws these, a ring at every connection point is the loudest thing in the
 * picture and the symbol is what somebody is trying to recognise. They appear
 * when it is placed, which is when they are for.
 */
export function wdItems(): LibraryItem[] {
  if (cache) return cache;
  cache = DEFS.map(def => {
    const shapes = [...def.draw(), ...pinLabels(def.terminals, def.height)];
    const d = new Drawing(def.width, def.height, def.name);
    for (const s of shapes) d.add(s);
    return {
      key: `wd:${def.id}`,
      id: def.id,
      name: def.name,
      source: 'IEC' as const,
      kind: 'wd' as const,
      group: def.group,
      art: renderFragment(d),
      width: def.width,
      height: def.height,
      shapes,
      // A wiring-diagram symbol stands in its path the way a single-line one
      // stands in its branch: in at the top, out at the bottom, down the first
      // terminal's own x.
      pin: { x: def.terminals[0].x, y: 0, span: def.height },
      terminals: def.terminals,
    };
  });
  return cache;
}

/** The ids the assistant may ask for by name. */
export const WD_IDS: string[] = DEFS.map(d => d.id);
