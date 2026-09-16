// src/utils/cad/drawingReports.ts
//
// What the drawing says, as lists.
//
// The reports this app already produces — mechanical items, BPMS, the parts
// matrix — are read from the project's tables. These are read from the pages,
// which is a different thing and the thing that was missing: after somebody has
// opened a wiring page and moved a wire, the tables do not know and the drawing
// does. A report off the drawing is the only one that can be trusted the day
// after the drawing was edited.
//
// Four of them, because four is what a panel shop asks for:
//
//   Connection list   every wire, as `-K1:A1 → -X1:3`, page by page
//   Terminal diagram  every strip, terminal by terminal, and what is on each
//   Device list       every device, what it is, and where it was drawn
//   I/O list          the card's channels as *drawn*, which is the list that
//                     went in, plus whatever was changed since
//
// Nothing here invents. A device with no designation is reported as having
// none, in its own row, rather than left out to keep the list tidy — the whole
// value of a list off the drawing is that it says what is there.

import { Shape } from './shapes';
import { Device, devices } from './schematic';
import { Connection, REACH, Terminal, connections, terminals } from './terminals';
import { nets } from './schematic';

/** One page, as these reports take it. */
export interface ReportPage {
  name: string;
  shapes: Shape[];
}

const UNTAGGED = '(no designation)';

const tagOf = (d: Device | undefined): string =>
  d?.tag?.trim() || d?.blockName || UNTAGGED;

// ── Connection list ────────────────────────────────────────────────────────

export interface ConnectionRow {
  page: string;
  from: string;
  to: string;
}

export function connectionRows(pages: ReportPage[]): ConnectionRow[] {
  const out: ConnectionRow[] = [];
  for (const page of pages) {
    for (const c of connections(page.shapes)) {
      out.push({
        page: page.name,
        from: `${c.from.device}:${c.from.pin}`,
        to: `${c.to.device}:${c.to.pin}`,
      });
    }
  }
  return out;
}

// ── Terminal diagram ───────────────────────────────────────────────────────

export interface TerminalRow {
  strip: string;
  terminal: string;
  /** What the upper side of the terminal is wired to. */
  upper: string;
  /** What the lower side is wired to. */
  lower: string;
  page: string;
}

/**
 * Every terminal strip, terminal by terminal.
 *
 * Which side is "field" and which "internal" is a convention this app does not
 * impose — an input path has the field device above the terminal and an output
 * path has the card above it — so the two sides are reported as what they are,
 * upper and lower, and the reader can see for themselves. Claiming a side is
 * external when the drawing does not say so would be inventing.
 */
export function terminalRows(pages: ReportPage[]): TerminalRow[] {
  const out: TerminalRow[] = [];

  for (const page of pages) {
    const byBlock = new Map<string, Device>();
    for (const d of devices(page.shapes)) byBlock.set(d.block, d);
    const marks = terminals(page.shapes);
    const links = connections(page.shapes);

    // A terminal block is a symbol whose connection points all carry one name:
    // that is what makes it a terminal rather than a device with a 1 and a 2.
    const blocks = new Map<string, Terminal[]>();
    for (const m of marks) {
      if (!m.block) continue;
      if (!blocks.has(m.block)) blocks.set(m.block, []);
      blocks.get(m.block)!.push(m);
    }

    for (const [block, group] of blocks) {
      const names = new Set(group.map(m => m.name));
      if (group.length < 2 || names.size !== 1) continue;
      const device = byBlock.get(block);
      const sorted = [...group].sort((a, b) => a.at[1] - b.at[1]);
      out.push({
        strip: tagOf(device),
        terminal: group[0].name,
        upper: wiredTo(sorted[0], page, links, block),
        lower: wiredTo(sorted[sorted.length - 1], page, links, block),
        page: page.name,
      });
    }
  }

  return out.sort((a, b) =>
    a.strip.localeCompare(b.strip, undefined, { numeric: true })
    || a.terminal.localeCompare(b.terminal, undefined, { numeric: true }));
}

/** What this one side of a terminal is wired to, as `-K1:A1`. */
function wiredTo(
  mark: Terminal, page: ReportPage, links: Connection[], block: string,
): string {
  // The net this side is on, and then whichever connection of this terminal
  // has its other end on that same net.
  const all = nets(page.shapes);
  const index = all.findIndex(n => n.points.some(
    p => Math.hypot(p[0] - mark.at[0], p[1] - mark.at[1]) <= REACH));
  if (index < 0) return '';

  const mine = links.filter(c => c.net === index
    && (c.from.pin === mark.name || c.to.pin === mark.name));
  const others = mine.map(c => {
    // The end that is not this terminal.
    const a = `${c.from.device}:${c.from.pin}`;
    const b = `${c.to.device}:${c.to.pin}`;
    const here = `${tagOf(devicesOf(page).get(block))}:${mark.name}`;
    return a === here ? b : a;
  });
  return [...new Set(others)].join(', ');
}

/** Devices of a page, worked out once per page rather than once per terminal. */
const deviceCache = new WeakMap<Shape[], Map<string, Device>>();
function devicesOf(page: ReportPage): Map<string, Device> {
  const got = deviceCache.get(page.shapes);
  if (got) return got;
  const m = new Map<string, Device>();
  for (const d of devices(page.shapes)) m.set(d.block, d);
  deviceCache.set(page.shapes, m);
  return m;
}

// ── Device list ────────────────────────────────────────────────────────────

export interface DeviceRow {
  tag: string;
  what: string;
  pins: string;
  page: string;
}

export function deviceRows(pages: ReportPage[]): DeviceRow[] {
  const out: DeviceRow[] = [];
  for (const page of pages) {
    for (const d of devices(page.shapes)) {
      out.push({
        tag: d.tag?.trim() || UNTAGGED,
        what: d.blockName || '',
        pins: [...new Set(d.pins)].join(' '),
        page: page.name,
      });
    }
  }
  return out.sort((a, b) => a.tag.localeCompare(b.tag, undefined, { numeric: true }));
}

// ── The I/O list, as drawn ─────────────────────────────────────────────────

export interface IoRow {
  address: string;
  kind: string;
  card: string;
  terminal: string;
  device: string;
  page: string;
}

/** What each PLC channel symbol is, by the name its block carries. */
const CHANNEL_KINDS: Record<string, string> = {
  'PLC digital input': 'DI',
  'PLC digital output': 'DO',
  'PLC analogue input': 'AI',
  'PLC analogue output': 'AO',
};

/** The connection points on a channel that are supply, not signal. */
const COMMON = new Set(['M', 'L+', 'L-', '-', 'N', 'PE']);

/**
 * The I/O list read back off the pages.
 *
 * This is the loop closed: a list went in, pages were drawn from it, somebody
 * moved a wire, and this is the list as the drawing now stands. Where a
 * channel is wired through a terminal to a field device, all three are on the
 * row — because the question a commissioning engineer asks is not "what is
 * I0.3" but "what is on I0.3 and which terminal is it".
 */
export function ioRows(pages: ReportPage[]): IoRow[] {
  const out: IoRow[] = [];

  for (const page of pages) {
    const byBlock = devicesOf(page);
    const links = connections(page.shapes);

    for (const d of byBlock.values()) {
      const kind = CHANNEL_KINDS[d.blockName];
      if (!kind) continue;

      const card = d.tag?.trim() || d.blockName;
      for (const pin of new Set(d.pins)) {
        if (COMMON.has(pin)) continue;
        const ref = `${card}:${pin}`;

        // What the signal lands on, and what is on the other side of that.
        const first = links.filter(
          c => `${c.from.device}:${c.from.pin}` === ref || `${c.to.device}:${c.to.pin}` === ref);
        const terminal = first
          .map(c => (`${c.from.device}:${c.from.pin}` === ref
            ? `${c.to.device}:${c.to.pin}` : `${c.from.device}:${c.from.pin}`))
          .join(', ');

        const beyond = new Set<string>();
        for (const t of terminal.split(', ').filter(Boolean)) {
          for (const c of links) {
            const a = `${c.from.device}:${c.from.pin}`;
            const b = `${c.to.device}:${c.to.pin}`;
            if (a === t && b !== ref) beyond.add(b);
            if (b === t && a !== ref) beyond.add(a);
          }
        }

        out.push({
          address: pin,
          kind,
          card,
          terminal,
          device: [...beyond].join(', '),
          page: page.name,
        });
      }
    }
  }

  return out.sort((a, b) =>
    a.card.localeCompare(b.card, undefined, { numeric: true })
    || a.address.localeCompare(b.address, undefined, { numeric: true }));
}

// ── The four of them together ──────────────────────────────────────────────

export interface DrawingReports {
  connections: ConnectionRow[];
  terminals: TerminalRow[];
  devices: DeviceRow[];
  io: IoRow[];
}

export function buildDrawingReports(pages: ReportPage[]): DrawingReports {
  return {
    connections: connectionRows(pages),
    terminals: terminalRows(pages),
    devices: deviceRows(pages),
    io: ioRows(pages),
  };
}

/** Headings for each report, in the order the columns come out. */
export const REPORT_HEADERS = {
  connections: ['Page', 'From', 'To'],
  terminals: ['Strip', 'Terminal', 'Upper', 'Lower', 'Page'],
  devices: ['Designation', 'What it is', 'Connection points', 'Page'],
  io: ['Address', 'Kind', 'Card', 'Terminal', 'Field device', 'Page'],
} as const;

/** One report as rows of cells, ready for a sheet. */
export function reportRows(
  reports: DrawingReports, which: keyof DrawingReports,
): (string | number)[][] {
  switch (which) {
    case 'connections':
      return reports.connections.map(r => [r.page, r.from, r.to]);
    case 'terminals':
      return reports.terminals.map(r => [r.strip, r.terminal, r.upper, r.lower, r.page]);
    case 'devices':
      return reports.devices.map(r => [r.tag, r.what, r.pins, r.page]);
    case 'io':
      return reports.io.map(r => [r.address, r.kind, r.card, r.terminal, r.device, r.page]);
  }
}
