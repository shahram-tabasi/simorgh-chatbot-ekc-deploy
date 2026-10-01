// Putting the numbers and designations on.
//
// These are the jobs that take an afternoon by hand and a second by machine —
// the ones every schematic package automates because the work is entirely
// mechanical and entirely error-prone. Each returns a *new* shape list rather
// than mutating, so the editor's undo takes one step back over the lot.
//
// Two rules run through all of it. Nothing already written by hand is
// overwritten unless it is asked for, and the order things are numbered in is
// the order they sit on the page — top to bottom, then left to right — so
// running it twice gives the same answer, and running it after drawing one
// more wire does not renumber the drawing.

import { Layer, Pt, Shape } from './shapes';
import { Net, devices, nets } from './schematic';

export interface NumberOptions {
  /** Text height for the labels, in drawing units. */
  textSize: number;
  /** What to put in front of the number. Empty for bare numerals. */
  prefix?: string;
  /** Start from here. */
  start?: number;
  /** Renumber wires that already carry a number. */
  overwrite?: boolean;
}

/** Marks a label this tool placed, so it can be found and replaced later. */
export const WIRE_LABEL = 'WIRE-NO';
export const isWireLabel = (s: Shape) =>
  s.t === 'text' && (s as { blockName?: string }).blockName === WIRE_LABEL;

/**
 * A connection's description, written under its name — EPLAN's connection
 * definition point carries both. Its own mark, so renumbering the wires
 * (which replaces names) never takes a description with it.
 */
export const WIRE_DESC = 'WIRE-DESC';
const isWireDesc = (s: Shape) =>
  s.t === 'text' && (s as { blockName?: string }).blockName === WIRE_DESC;
/** A name or a description written on a connection. */
export const isConnectionText = (s: Shape) => isWireLabel(s) || isWireDesc(s);

export interface NumberResult {
  shapes: Shape[];
  /** How many nets got a number. */
  numbered: number;
  /** Nets skipped because they already had one. */
  kept: number;
}

/**
 * Give every net a number, and write it on the wire.
 *
 * The label goes at the midpoint of the net's longest run, lifted just clear
 * of the line, which is where a draughtsman puts it — on the wire, readable,
 * and not on top of whatever the wire is going to.
 */
export function numberWires(shapes: Shape[], options: NumberOptions): NumberResult {
  const { textSize, prefix = '', start = 1, overwrite = false } = options;
  const all = nets(shapes);

  const existing = new Map<number, number>();  // net id -> index of its label
  if (!overwrite) {
    shapes.forEach((s, i) => {
      if (!isWireLabel(s) || s.t !== 'text') return;
      // Nearest by distance to the *wire*, not to its ends. A label sits at
      // the midpoint of a run, which on a long wire is nowhere near either
      // end — matching on endpoints missed every label it had just placed,
      // so a second pass numbered the whole sheet again.
      const net = nearestNet(all, [s.x, s.y], textSize * 4);
      if (net) existing.set(net.id, i);
    });
  }

  const cleared = overwrite ? shapes.filter(s => !isWireLabel(s)) : [...shapes];
  const added: Shape[] = [];
  let next = start;
  let numbered = 0;

  for (const net of all) {
    if (!overwrite && existing.has(net.id)) continue;
    const at = labelPoint(net);
    if (!at) continue;
    added.push({
      t: 'text',
      x: at[0], y: at[1],
      s: `${prefix}${next}`,
      size: textSize,
      layer: 'TAG' as Layer,
      blockName: WIRE_LABEL,
    });
    next += 1;
    numbered += 1;
  }

  return { shapes: [...cleared, ...added], numbered, kept: existing.size };
}

/**
 * Name a connection, and describe it — EPLAN's connection definition point.
 *
 * The connection is the whole net the picked wire belongs to, so a name
 * given on one leg of a run is the run's name. It is written the way the wire
 * numbers are, which makes the two one system: numbering skips a connection
 * that has a name, and a name written here replaces the number that was on
 * it rather than sitting beside it. An empty description takes the old one
 * off; an empty name leaves the connection as it was.
 */
export function nameConnection(
  shapes: Shape[], wireIndex: number, name: string, description: string, textSize: number,
): Shape[] | null {
  const all = nets(shapes);
  const net = all.find(n => n.segments.some(seg => seg.index === wireIndex));
  if (!net) return null;
  const reach = textSize * 4;
  const onNet = (s: Shape) => s.t === 'text' && nearestNet(all, [s.x, s.y], reach) === net;

  const out = [...shapes];
  let at = out.findIndex(s => isWireLabel(s) && onNet(s));
  if (at >= 0) {
    out[at] = { ...out[at], s: name } as Shape;
  } else {
    const p = labelPoint(net);
    if (!p) return null;
    out.push({
      t: 'text', x: p[0], y: p[1], s: name, size: textSize,
      layer: 'TAG' as Layer, blockName: WIRE_LABEL,
    });
    at = out.length - 1;
  }
  const label = out[at];
  if (label.t !== 'text') return null;

  const descAt = out.findIndex(s => isWireDesc(s) && onNet(s));
  const text = description.trim();
  if (!text) {
    return descAt >= 0 ? out.filter((_, i) => i !== descAt) : out;
  }
  const desc: Shape = {
    t: 'text', x: label.x, y: label.y + textSize * 1.1, s: text, size: textSize * 0.75,
    anchor: label.anchor, layer: 'TAG' as Layer, blockName: WIRE_DESC,
  };
  if (descAt >= 0) out[descAt] = { ...out[descAt], s: text } as Shape;
  else out.push(desc);
  return out;
}

/** The name and description a connection carries now, for the prompts. */
export function connectionText(
  shapes: Shape[], wireIndex: number, textSize: number,
): { name: string; description: string } {
  const all = nets(shapes);
  const net = all.find(n => n.segments.some(seg => seg.index === wireIndex));
  if (!net) return { name: '', description: '' };
  const reach = textSize * 4;
  const find = (is: (s: Shape) => boolean) => {
    const hit = shapes.find(s => is(s) && s.t === 'text' && nearestNet(all, [s.x, s.y], reach) === net);
    return hit && hit.t === 'text' ? hit.s : '';
  };
  return { name: find(isWireLabel), description: find(isWireDesc) };
}

/** The net whose conductor passes nearest `p`, within `reach`. */
function nearestNet(all: Net[], p: Pt, reach: number): Net | undefined {
  let best: { net: Net; d: number } | undefined;
  for (const net of all) {
    for (const seg of net.segments) {
      const d = distToSegment(p, seg.a, seg.b);
      if (d <= reach && (!best || d < best.d)) best = { net, d };
    }
  }
  return best?.net;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

/** Midpoint of the net's longest segment, lifted clear of the wire. */
function labelPoint(net: Net): Pt | null {
  let best: { mid: Pt; len: number; horizontal: boolean } | null = null;
  for (const s of net.segments) {
    const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    if (!best || len > best.len) {
      best = {
        mid: [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2],
        len,
        horizontal: Math.abs(s.b[0] - s.a[0]) >= Math.abs(s.b[1] - s.a[1]),
      };
    }
  }
  if (!best) return null;
  // Above a horizontal run, to the right of a vertical one.
  return best.horizontal ? [best.mid[0], best.mid[1] - 2] : [best.mid[0] + 2, best.mid[1]];
}

// ── Device designations ────────────────────────────────────────────────────

/**
 * The letter a device is designated by, from what the symbol is called.
 *
 * IEC 81346 letters, matched on the symbol's own name. Unknown symbols get
 * "A", which the standard keeps for an assembly — honest about not knowing,
 * rather than guessing at a letter that means something specific.
 */
export function deviceLetter(blockName: string): string {
  const n = blockName.toUpperCase();
  const rules: [RegExp, string][] = [
    [/\b(MOTOR|MOTEUR|FAN|PUMP)\b|^M\d*$/, 'M'],
    [/CONTACTOR|RELAY|COIL/, 'K'],
    [/\b(CB|MCB|MCCB|BREAKER|DISCONNECT|SWITCH-FUSE)\b/, 'Q'],
    [/FUSE/, 'F'],
    [/OVERLOAD|THERMAL/, 'F'],
    [/\bCT\b|CURRENT.?TRANSFORMER/, 'T'],
    [/\bPT\b|\bVT\b|VOLTAGE.?TRANSFORMER|TRANSFORMER/, 'T'],
    [/METER|AMMETER|VOLTMETER|MULTIMETER/, 'P'],
    [/LAMP|INDICATOR|LED/, 'H'],
    [/PUSH|BUTTON|SELECTOR/, 'S'],
    [/TERMINAL/, 'X'],
    [/SURGE|ARRESTER/, 'F'],
    [/SUPPLY|PSU|RECTIFIER|CONVERTER|VFD|DRIVE/, 'T'],
  ];
  for (const [re, letter] of rules) if (re.test(n)) return letter;
  return 'A';
}

export interface TagResult {
  shapes: Shape[];
  tagged: number;
  /** Devices left alone because they already carried a designation. */
  kept: number;
}

/**
 * Give every untagged device a designation.
 *
 * Numbering runs per letter, and continues from the highest number already in
 * use for that letter — so adding a contactor to a finished sheet gives -K4
 * next to the existing -K3 rather than starting again at -K1 and colliding
 * with all of them.
 */
export function autoTagDevices(
  shapes: Shape[],
  options: { textSize: number; separator?: string },
): TagResult {
  const { textSize, separator = '-' } = options;
  const devs = devices(shapes);

  const highest = new Map<string, number>();
  for (const d of devs) {
    if (!d.tag) continue;
    const m = /^[-=+]?([A-Z]+)(\d+)/.exec(d.tag.toUpperCase());
    if (!m) continue;
    highest.set(m[1], Math.max(highest.get(m[1]) ?? 0, Number(m[2])));
  }

  const added: Shape[] = [];
  let tagged = 0, kept = 0;
  for (const d of devs) {
    if (d.tag) { kept += 1; continue; }
    const letter = deviceLetter(d.blockName);
    const n = (highest.get(letter) ?? 0) + 1;
    highest.set(letter, n);
    added.push({
      t: 'text',
      // Above the symbol's top-left, which is where a designation goes.
      x: d.at[0], y: d.at[1] - textSize * 0.6,
      s: `${separator}${letter}${n}`,
      size: textSize,
      layer: 'TAG' as Layer,
    });
    tagged += 1;
  }
  return { shapes: [...shapes, ...added], tagged, kept };
}

// ── Cross-references ───────────────────────────────────────────────────────

export interface SheetDevices { name: string; shapes: Shape[]; }

export interface CrossReference {
  tag: string;
  /** Sheets it appears on, in sheet order, with where on each. */
  places: { sheet: string; at: Pt }[];
}

/**
 * Devices that appear on more than one sheet.
 *
 * A coil on one page and its contacts on another are the same device, and the
 * only thing tying them together is that somebody wrote the same designation
 * on both. Finding them is what lets a sheet say "also on 4" instead of the
 * reader having to remember.
 *
 * Within one sheet a repeated designation is a mistake, and checkSheet says
 * so; across sheets it is the normal way a schematic is drawn.
 */
export function crossReferences(sheets: SheetDevices[]): CrossReference[] {
  const seen = new Map<string, { sheet: string; at: Pt }[]>();
  for (const sheet of sheets) {
    const onThis = new Set<string>();
    for (const d of devices(sheet.shapes)) {
      if (!d.tag) continue;
      const tag = d.tag.toUpperCase();
      if (onThis.has(tag)) continue;   // counted once per sheet
      onThis.add(tag);
      if (!seen.has(tag)) seen.set(tag, []);
      seen.get(tag)!.push({ sheet: sheet.name, at: d.at });
    }
  }
  return [...seen.entries()]
    .filter(([, places]) => places.length > 1)
    .map(([tag, places]) => ({ tag, places }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}
