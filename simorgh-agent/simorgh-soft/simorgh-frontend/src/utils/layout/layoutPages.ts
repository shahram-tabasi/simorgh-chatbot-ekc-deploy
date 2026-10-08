// src/utils/layout/layoutPages.ts
//
// Layout (OLD) pages for Simorgh Draw, built from the project.
//
// Two drawings, the two the office issues for an LV switchgear:
//
//   · SIVACON S8 front view — the withdrawable (OFW) sections, every feeder a
//     drawer as tall as its size, under the main busbar compartment and beside
//     the cable compartment. The size is the line's own SIZE when it has one,
//     else the drawer the FEEDER ASSEMBLY LIST gives it (s8Drawers).
//   · Fixed (CCS) internal view — the door and the mounting plates behind it:
//     rows of MCBs and relays between 40 ducts, breakers and contactors
//     between 60 ducts, the terminal plates at the bottom, the ducts of the
//     office's standard (layoutStandard).
//
// The pages are geometry like any other page and are drawn on afterwards: a
// starting point that already obeys the standard, not a finished drawing.
// Each device is a box of its catalogue size until the office has a layout
// symbol for it — a layout symbol whose name carries the device's order code
// ("3RT2027", "3VA21") is drawn in its place.
import type { DeviceTableRow, Equipment, ProjectData } from '../../types/project';
import type { Shape } from '../cad/shapes';
import type { LibraryItem } from '../cad/symbolSource';
import { placeSymbolAt } from '../cad/symbolSource';
import { newBlockId } from '../cad/geom';
import { TIERS } from '../tiers';
import { familyOf } from '../templateFamilies';
import { partKeys, partDescription } from '../eplanSingleLine';
import { stripLocaleTags } from '../tierEquipmentMatrix';
import { buildPanelLayout } from '../panelLayout';
import { drawerOfFeeder, type DrawerChoice } from './s8Drawers';
import { CCS, faceOf, isPowerRow, type DeviceFace } from './layoutStandard';
import { acbFront, waFrameFor } from './acbFront';
import {
  DEFAULT_SYSTEM, UNIVERSAL, acbCubicleWidth, catalogueModules, cubicleDepth, feederRatingAt, mainBusbarFor,
  verticalRating, type S8System,
} from './s8Catalogue';

export interface LayoutPage {
  name: string;
  description: string;
  /** What the layout could not meet, or chose — shown beside the pages. */
  notes?: string[];
  width: number;
  height: number;
  shapes: Shape[];
}

const SHEET = { w: 420, h: 297 };
/** The band a page draws in, clear of the frame and the title block. */
const AREA = { x: 22, y: 26, w: 380, h: 214 };

const text = (x: number, y: number, s: string, size: number, layer: Shape['layer'] = 'TEXT',
  anchor: 'start' | 'middle' | 'end' = 'start', bold = false, rot?: number): Shape =>
  ({ t: 'text', x, y, s, size, anchor, layer, ...(bold ? { bold } : {}), ...(rot ? { rot } : {}) });
const rect = (x: number, y: number, w: number, h: number, layer: Shape['layer'], fill?: string, dash?: string,
  width = 0.25): Shape => ({ t: 'rect', x, y, w, h, layer, color: '#111', width, ...(fill ? { fill } : {}), ...(dash ? { dash } : {}) });
const line = (x1: number, y1: number, x2: number, y2: number, layer: Shape['layer'] = 'PANEL', width = 0.25): Shape =>
  ({ t: 'line', x1, y1, x2, y2, layer, color: '#111', width });

/** A height scale up the left, 0 at the floor, like the office's sheets. */
function heightScale(x: number, floorY: number, k: number, height: number): Shape[] {
  const out: Shape[] = [line(x, floorY, x, floorY - height * k)];
  for (let mm = 0; mm <= height; mm += 100) {
    const y = floorY - mm * k;
    const major = mm % 200 === 0;
    out.push(line(x, y, x + (major ? 3 : 1.5), y));
    if (major) out.push(text(x - 1.5, y + 1, mm.toFixed(1), 2.4, 'TEXT', 'end'));
  }
  return out;
}

/** A dimension under a width. */
function widthDim(x: number, y: number, w: number, label: string): Shape[] {
  return [
    line(x, y - 2, x, y + 2), line(x + w, y - 2, x + w, y + 2), line(x, y, x + w, y),
    text(x + w / 2, y - 1, label, 2.4, 'TEXT', 'middle'),
  ];
}

/** The office's layout symbol for a device, by its order code in the symbol's name. */
function symbolFor(code: string, symbols: LibraryItem[]): LibraryItem | undefined {
  const c = code.toUpperCase().replace(/\s/g, '');
  if (!c) return undefined;
  const words = (n: string) => n.toUpperCase().split(/[^A-Z0-9-]+/).filter(Boolean);
  // The longest order-code prefix any symbol names wins: "3RT2027" over "3RT2".
  let best: { item: LibraryItem; len: number } | undefined;
  for (const item of symbols) {
    for (const w of words(item.name)) {
      if (w.length >= 4 && c.startsWith(w) && (!best || w.length > best.len)) best = { item, len: w.length };
    }
  }
  return best?.item;
}

// ── SIVACON S8 front view ─────────────────────────────────────────────────
//
// Drawn the way SIMARIS draws an S8 switchboard: the cubicles side by side,
// CELL 1, CELL 2…, each as wide as it is; a drawer cubicle's drawers stacked
// under its busbar compartment and numbered cell.position; the position list
// beside them; the floor plan underneath. What goes where follows the
// catalogue (s8Catalogue): an incomer or coupler with an air breaker is a
// cubicle of its own, as wide as its breaker; a drawer cubicle holds 36M
// (1,800 mm) and only as much current as its distribution busbar carries at
// the room's temperature.

export interface S8Feeder {
  row: DeviceTableRow;
  modules: number;
  /** 'line' the line's SIZE, 'list' the office's assembly list, 'catalogue'
   *  Siemens' minimum height, 'acb' an air breaker's own cubicle, 'none' guessed. */
  from: 'line' | 'list' | 'catalogue' | 'acb' | 'none';
  drawer?: DrawerChoice;
  amps?: number;
  /** The main breaker's order code, as the template has it. */
  code?: string;
  poles?: 3 | 4;
  /** Cubicle number, and where in it (modules from the top of the drawers). */
  column: number;
  offset: number;
  /** cell.position, as SIMARIS numbers it. */
  pos: string;
}

export interface S8Cubicle {
  column: number;
  kind: 'drawers' | 'incoming' | 'coupler' | 'outgoing';
  width: number;
  busSection: string;
  feeders: S8Feeder[];
  /** Modules taken (drawer cubicles). */
  used: number;
  /** Σ feeder current × RDF, against what the distribution busbar carries. */
  load: number;
  rating: number;
}

export interface S8Plan {
  /** Every cubicle in order — kept as `sections` for the screens that list them. */
  sections: S8Cubicle[];
  capacity: number;
  unknown: S8Feeder[];
  system: S8System;
  mainBusbar: { rated: number; at: number; icw: number } | null;
  mainAmps: number;
  depth: number;
  warnings: string[];
}

const INCOMER = /incom|main|supply|source|\bINC\b/i;
const COUPLER = /coupl|bus.?sec|\btie\b|\bBT\b|sectionali/i;
const text_ = (r: DeviceTableRow) => `${r.wiringType ?? ''} ${r.description ?? ''} ${r.templateName ?? ''} ${r.tag ?? ''} ${r.feederNo ?? ''}`;

/** What the room and the board are, from the switchgear's scope where it says. */
export function systemOf(data: ProjectData, equipment: Equipment): S8System {
  const library = data.deviceLibrary?.[equipment.type] ?? [];
  const spec: any = library.find(d => d.id === equipment.properties?.deviceLibraryItemId)?.properties
    ?? library.find(d => d.name === equipment.name)?.properties ?? {};
  const ambient = Number(spec.designTemperature) || Number(data.techSettings?.general?.designTemperature) || 35;
  const ip = Number(String(spec.ip ?? '').match(/(\d{2})/)?.[1]);
  return {
    ...DEFAULT_SYSTEM,
    ambient,
    ventilated: !(ip >= 54),
    doubleBusbar: /double|dual|2\s*[x×]|two/i.test(String(spec.mainBusbarConfiguration ?? '')),
  };
}

/**
 * The cubicles. MODULE NO. (column.position) is kept where the lines have it.
 * Otherwise, bus section by bus section: its incomers, its drawer cubicles —
 * a new one when the next drawer would not fit its height or its current —
 * then the coupler to the next section.
 */
export function planS8(data: ProjectData, equipment: Equipment, overrides: Partial<S8System> = {},
  fallbackModules = 4): S8Plan {
  const system: S8System = { ...systemOf(data, equipment), ...overrides };
  const capacity = Math.floor(UNIVERSAL.deviceCompartment(system.frame) / UNIVERSAL.grid);
  const vRating = verticalRating(system);
  const warnings: string[] = [];
  const rows = equipment.devices ?? [];

  const sized = rows.map(row => {
    const d = drawerOfFeeder(data, row);
    const acb = d.facts.breaker === 'ACB' && d.from !== 'line';
    let modules = d.modules;
    let from: S8Feeder['from'] = acb ? 'acb' : d.from;
    if (!acb && modules == null) {
      const c = catalogueModules({
        frame: d.facts.breaker, poles: d.facts.poles,
        motorKw: Number(String(row.ratingPower ?? '').replace(/[^\d.]/g, '')) || undefined,
        contactors: d.facts.contactors,
      });
      if (c) { modules = c; from = 'catalogue'; }
    }
    const amps = d.facts.amps;
    const can = feederRatingAt(d.facts.breaker, system);
    if (!acb && can != null && amps != null && amps > can) {
      warnings.push(`${row.feederNo || row.templateName}: ${amps} A is more than a ${d.facts.breaker} drawer carries at ${system.ambient} °C (${can} A)`);
    }
    return { row, d, acb, modules: modules ?? fallbackModules, from: modules == null && !acb ? 'none' as const : from, amps };
  });

  const cubicles: S8Cubicle[] = [];
  const newCubicle = (kind: S8Cubicle['kind'], width: number, busSection: string): S8Cubicle => {
    const c: S8Cubicle = { column: cubicles.length + 1, kind, width, busSection, feeders: [], used: 0, load: 0, rating: kind === 'drawers' ? vRating : 0 };
    cubicles.push(c);
    return c;
  };
  const put = (c: S8Cubicle, s: typeof sized[number], modules: number) => {
    c.feeders.push({
      row: s.row, modules, from: s.from, drawer: s.d.choices[0], amps: s.amps,
      code: s.d.facts.breakerCode, poles: s.d.facts.poles,
      column: c.column, offset: c.used, pos: `${c.column}.${c.feeders.length + 1}`,
    });
    c.used += modules;
    c.load += (s.amps ?? 0) * UNIVERSAL.rdf;
  };

  const stated = rows.some(r => String(r.moduleNo ?? '').trim());
  if (stated) {
    const layout = buildPanelLayout(data, equipment);
    for (const col of layout.columns) {
      const items = col.slots.map(slot => sized.find(s => s.row === slot.row)!).filter(Boolean);
      const lone = items.length === 1 && items[0].acb ? items[0] : null;
      const c = lone
        ? newCubicle(COUPLER.test(text_(lone.row)) ? 'coupler' : INCOMER.test(text_(lone.row)) ? 'incoming' : 'outgoing',
          acbCubicleWidth(lone.amps ?? 1600, COUPLER.test(text_(lone.row)) ? 'coupler' : 'incoming', lone.d.facts.poles ?? 3),
          String(lone.row.busSection ?? ''))
        : newCubicle('drawers', UNIVERSAL.widths[0], String(items[0]?.row.busSection ?? ''));
      let cur = c;
      for (const s of items) {
        const m = s.acb ? capacity : s.modules;
        // MODULE NO. puts more in a column than it holds: carry on in the
        // next cubicle rather than stacking drawers below the floor.
        if (!lone && cur.used > 0 && cur.used + m > capacity) {
          warnings.push(`Column ${col.column} of MODULE NO. holds more than ${capacity}M — continued in CELL ${cubicles.length + 1}`);
          cur = newCubicle('drawers', UNIVERSAL.widths[0], String(s.row.busSection ?? ''));
        }
        put(cur, s, m);
      }
    }
  } else {
    const order = [...new Set(rows.map(r => String(r.busSection ?? '').trim()))];
    const inSection = (b: string) => sized.filter(s => String(s.row.busSection ?? '').trim() === b);
    const couplers = sized.filter(s => s.acb && COUPLER.test(text_(s.row)));
    order.forEach((b, i) => {
      const here = inSection(b).filter(s => !couplers.includes(s));
      for (const s of here.filter(x => x.acb && INCOMER.test(text_(x.row)))) {
        put(newCubicle('incoming', acbCubicleWidth(s.amps ?? 1600, 'incoming', s.d.facts.poles ?? 3), b), s, capacity);
      }
      let cur: S8Cubicle | null = null;
      for (const s of here.filter(x => !(x.acb && INCOMER.test(text_(x.row))))) {
        if (s.acb) { put(newCubicle('outgoing', acbCubicleWidth(s.amps ?? 1600, 'outgoing', s.d.facts.poles ?? 3), b), s, capacity); cur = null; continue; }
        const load = (s.amps ?? 0) * UNIVERSAL.rdf;
        if (!cur || cur.used + s.modules > capacity || (cur.used > 0 && cur.load + load > vRating)) {
          cur = newCubicle('drawers', UNIVERSAL.widths[0], b);
        }
        put(cur, s, s.modules);
      }
      // The coupler to the next section, between the two.
      const tie = couplers.filter(c => String(c.row.busSection ?? '').trim() === b || (i === 0 && !order.includes(String(c.row.busSection ?? '').trim())));
      for (const s of i < order.length - 1 || tie.length ? tie : []) {
        put(newCubicle('coupler', acbCubicleWidth(s.amps ?? 1600, 'coupler', s.d.facts.poles ?? 3), b), s, capacity);
      }
    });
  }

  for (const c of cubicles) {
    if (c.kind === 'drawers' && c.load > c.rating) {
      warnings.push(`CELL ${c.column}: ${Math.round(c.load)} A (× RDF ${UNIVERSAL.rdf}) is more than its distribution busbar carries at ${system.ambient} °C (${c.rating} A)`);
    }
    if (c.kind === 'drawers' && c.used > capacity) warnings.push(`CELL ${c.column}: ${c.used}M in ${capacity}M`);
  }

  // The main busbar carries what the biggest bus section is fed with.
  const byBus = new Map<string, number>();
  for (const s of sized) {
    if (s.acb && INCOMER.test(text_(s.row))) {
      const b = String(s.row.busSection ?? '').trim();
      byBus.set(b, Math.max(byBus.get(b) ?? 0, s.amps ?? 0));
    }
  }
  const mainAmps = Math.max(0, ...byBus.values()) || sized.reduce((t, s) => t + (s.amps ?? 0), 0) * UNIVERSAL.rdf;
  const mainBusbar = mainBusbarFor(mainAmps, system);
  if (!mainBusbar && mainAmps > 0) warnings.push(`No main busbar carries ${Math.round(mainAmps)} A at ${system.ambient} °C`);

  const all = cubicles.flatMap(c => c.feeders);
  return {
    sections: cubicles, capacity, unknown: all.filter(f => f.from === 'none'), system,
    mainBusbar, mainAmps: Math.round(mainAmps), depth: cubicleDepth(system, mainAmps), warnings,
  };
}

/** Front view pages: cubicles, the position list beside them, the floor plan under. */
export function s8FrontPages(equipment: Equipment, plan: S8Plan, symbols: LibraryItem[] = []): LayoutPage[] {
  const sys = plan.system;
  const H = sys.frame + sys.base;
  const busTop = sys.frame - UNIVERSAL.deviceCompartment(sys.frame);
  const LIST_W = 74;
  const k = Math.min(1 / 20, (AREA.h - 30) / (H + plan.depth + 260));
  const drawW = AREA.w - 26 - LIST_W;
  const lineH = 3.1;
  const listLines = (c: S8Cubicle) => 2 + (c.kind === 'drawers' ? c.feeders.length + 1 : 1);
  const maxLines = Math.floor((AREA.h - 8) / lineH);

  // As many cubicles to a page as its width and its position list allow.
  const chunks: S8Cubicle[][] = [];
  let cur: S8Cubicle[] = [];
  let w = 0, lines = 0;
  for (const c of plan.sections) {
    if (cur.length && (w + c.width * k > drawW || lines + listLines(c) > maxLines)) { chunks.push(cur); cur = []; w = 0; lines = 0; }
    cur.push(c); w += c.width * k; lines += listLines(c);
  }
  if (cur.length || chunks.length === 0) chunks.push(cur);

  return chunks.map((chunk, pi) => {
    const s: Shape[] = [];
    const left = AREA.x + 22;
    const top = AREA.y + 12;
    const floor = top + H * k;
    const y0 = top + busTop * k;
    s.push(text(AREA.x, AREA.y, `${equipment.name} — OUTLINE DIAGRAM · SIVACON S8${chunks.length > 1 ? ` (${pi + 1}/${chunks.length})` : ''}`, 4, 'TITLE', 'start', true));
    s.push(text(AREA.x, AREA.y + 5, [
      `${sys.ambient} °C`, sys.ventilated ? 'ventilated (≤ IP43)' : 'non-ventilated (IP54)',
      plan.mainBusbar ? `main busbar ${sys.busbar} ${plan.mainBusbar.rated} A (${plan.mainBusbar.at} A at ${sys.ambient} °C, ${plan.mainBusbar.icw} kA)` : '',
      sys.doubleBusbar ? 'double busbar' : '', `depth ${plan.depth}`, `1M = ${UNIVERSAL.grid} mm`, `scale 1:${Math.round(1 / k)}`,
    ].filter(Boolean).join(' · '), 2.4));
    s.push(...heightScale(AREA.x + 12, floor, k, H));

    let x = left;
    for (const c of chunk) {
      const cw = c.width * k;
      s.push(rect(x, top, cw, H * k, 'PANEL', undefined, undefined, 0.5));
      s.push(text(x + cw / 2, top - 2, `CELL ${c.column}`, 3, 'TAG', 'middle', true));
      // The main busbar across every cubicle.
      s.push(rect(x, top, cw, busTop * k, 'PANEL', '#e5e7eb'));
      if (sys.base) s.push(rect(x, floor - sys.base * k, cw, sys.base * k, 'PANEL', '#f3f4f6'));
      if (c.kind === 'drawers') {
        const dw = UNIVERSAL.deviceWidth * k;
        s.push(rect(x + dw, top + busTop * k, cw - dw, UNIVERSAL.deviceCompartment(sys.frame) * k, 'PANEL', undefined, '3 2'));
        for (const f of c.feeders) {
          const y = y0 + f.offset * UNIVERSAL.grid * k;
          const h = f.modules * UNIVERSAL.grid * k;
          s.push(rect(x + 0.6, y + 0.3, dw - 1.2, h - 0.6, 'SLOT', f.from === 'none' ? '#fef3c7' : '#ffffff'));
          s.push(text(x + 1.6, y + Math.min(h - 0.8, 2.8), f.pos, 2.1, 'TAG'));
          s.push(rect(x + dw * 0.25, y + Math.min(h / 2 - 1, 2), dw * 0.12, Math.min(2.4, h - 1.5), 'SYMBOL', '#111'));
          s.push(rect(x + dw * 0.45, y + Math.min(h / 2 - 1.5, 1.4), dw * 0.42, Math.min(3.4, h - 1), 'SYMBOL'));
          s.push(text(x + dw - 1.6, y + h - 1, `${f.modules}M`, 1.8, 'TEXT', 'end'));
        }
        const free = plan.capacity - c.used;
        if (free > 0) {
          const y = y0 + c.used * UNIVERSAL.grid * k;
          s.push(rect(x + 0.6, y + 0.3, dw - 1.2, free * UNIVERSAL.grid * k - 0.6, 'FREE', undefined, '2 1.5'));
          // Written only where it fits; a 1M space is in the list beside.
          if (free * UNIVERSAL.grid * k >= 4.5) s.push(text(x + dw / 2, y + Math.min(4, free * UNIVERSAL.grid * k - 1), `SPACE ${free}M`, 2, 'FREE', 'middle'));
        }
      } else {
        // An air circuit-breaker cubicle: the 3WA seen through its door, the
        // top of the breaker 1,450 above the floor as SIMARIS places it — the
        // office's own 3WA layout symbol when the library has one.
        const f = c.feeders[0];
        const role = c.kind === 'coupler' ? 'COUPLING' : c.kind === 'incoming' ? 'INCOMING' : 'OUTGOING';
        const by = floor - (sys.base + 1450) * k;
        const sym = f?.code ? symbolFor(f.code, symbols) ?? symbolFor('3WA', symbols) : symbolFor('3WA', symbols);
        if (sym) {
          s.push(...placeSymbolAt(sym, { x: x + cw / 2, y: by }, waFrameFor(f?.amps).h * k, newBlockId()));
          s.push(text(x + cw / 2, by - 1.2, role, 2.2, 'TAG', 'middle', true));
        } else {
          s.push(...acbFront(x + cw / 2, by, k, { amps: f?.amps, poles: f?.poles, label: role }));
        }
        // The door's instrument panel above it, and the cubicle's handle.
        s.push(rect(x + cw * 0.15, by - 330 * k, cw * 0.7, 220 * k, 'PANEL', undefined, '1.5 1'));
        s.push(text(x + cw / 2, by - 330 * k + 3, 'INSTRUMENT PLATE', 1.6, 'TEXT', 'middle'));
        s.push(rect(x + cw - 4, top + (busTop + 700) * k, 1.4, 260 * k, 'PANEL', '#111'));
      }
      s.push(...widthDim(x, floor + 5, cw, `${c.width}`));
      // The floor plan under it.
      const fy = floor + 14;
      s.push(rect(x, fy, cw, plan.depth * k, 'PANEL'));
      s.push(rect(x + 0.08 * cw, fy + 0.07 * plan.depth * k, cw * 0.84, plan.depth * k * 0.75, 'FREE', '#f3f4f6'));
      x += cw;
    }
    const fy = floor + 14;
    s.push(...heightScale(AREA.x + 12, fy + plan.depth * k, k, plan.depth).filter(sh => sh.t !== 'text' || /^(0|[2-9]00|1[0-9]00)\.0$/.test((sh as any).s)));
    s.push(text(left, fy + plan.depth * k + 4, `Plant depth [mm]: ${plan.depth}   Plant width [mm]: ${chunk.reduce((t, c) => t + c.width, 0)}`, 2.4));

    // The position list, as SIMARIS writes it.
    let ly = AREA.y + 4;
    const lx = AREA.x + AREA.w - LIST_W;
    s.push(text(lx, ly, 'Pos.', 2.6, 'TITLE', 'start', true));
    s.push(text(lx + 14, ly, 'Feeder', 2.6, 'TITLE', 'start', true));
    ly += lineH * 1.4;
    for (const c of chunk) {
      ly += lineH * 0.4;
      if (c.kind !== 'drawers') {
        const f = c.feeders[0];
        s.push(text(lx, ly, `${c.column}.1`, 2.2, 'TEXT'));
        s.push(text(lx + 14, ly, `${c.kind === 'coupler' ? 'COUPLING ' : c.kind === 'incoming' ? 'INCOMING ' : ''}${f ? [f.row.feederNo, f.row.tag].filter(Boolean).join(',') : ''}`.slice(0, 34), 2.2, 'TEXT'));
        ly += lineH;
        continue;
      }
      for (const f of c.feeders) {
        s.push(text(lx, ly, f.pos, 2.2, 'TEXT'));
        const name = [f.row.feederNo, f.row.tag || f.row.description].filter(Boolean).join(',') || f.row.templateName;
        s.push(text(lx + 14, ly, `${String(name).slice(0, 26)}${f.amps ? `,${f.amps}A` : ''}`, 2.2, 'TEXT'));
        ly += lineH;
      }
      const free = plan.capacity - c.used;
      if (free > 0) {
        s.push(text(lx, ly, `${c.column}.${c.feeders.length + 1}`, 2.2, 'TEXT'));
        s.push(text(lx + 14, ly, `SPACE ${free}M`, 2.2, 'FREE'));
        ly += lineH;
      }
    }

    return {
      name: `${equipment.name} outline`,
      description: chunk.length ? `CELL ${chunk[0].column}…${chunk[chunk.length - 1].column}` : 'S8 outline',
      width: SHEET.w, height: SHEET.h, shapes: s,
    };
  });
}

// ── Fixed (CCS) internal view ─────────────────────────────────────────────

export interface CcsDevice {
  tag: string;
  code: string;
  face: DeviceFace;
  amps?: number;
  /** The switchgear's own incoming breaker: at the top, beside the busbar. */
  incoming?: boolean;
}

const LETTER: Record<DeviceFace['kind'], string> = {
  mcb: 'Q', mpcb: 'Q', mccb: 'Q', contactor: 'K', overload: 'F', relay: 'KC', meter: 'P',
  supply: 'PS', terminal: 'X', other: 'A',
};

/** Every device of a fixed switchgear, numbered the way the office tags them. */
export function ccsDevices(data: ProjectData, equipment: Equipment): CcsDevice[] {
  const out: CcsDevice[] = [];
  const count: Record<string, number> = {};
  for (const row of equipment.devices ?? []) {
    const template = TIERS.flatMap(t => data.templates?.[t] ?? []).find(t => t.id === row.templateId);
    const props = (template?.properties ?? {}) as Record<string, any>;
    const parts = [
      ...Object.entries(props).flatMap(([slot, v]) => (Array.isArray(v?.parts) ? v.parts : []).map((p: any) => ({ slot, p }))),
      ...(row.selectedParts ?? []).map(e => ({ slot: e.propertyName, p: e.part })),
    ];
    for (const { slot, p } of parts) {
      const code = partKeys(p).find(k => /^(3|5S|6EP|7K)/i.test(k)) ?? partKeys(p)[0] ?? '';
      const desc = `${slot} ${stripLocaleTags(p?.label) || ''} ${partDescription(p)}`;
      const poles = Number(String(p?.sld?.poles ?? '').match(/\d/)?.[0]) || 3;
      const face = faceOf(code, desc, poles);
      if (face.kind === 'terminal') continue;
      const qty = Math.max(1, Math.min(12, Number(p?.quantity) || 1));
      const incoming = INCOMER.test(text_(row)) && (face.kind === 'mccb' || face.kind === 'mcb' || face.kind === 'mpcb')
        && /CB ORDER|BREAKER/i.test(slot);
      for (let i = 0; i < qty; i++) {
        const letter = LETTER[face.kind];
        count[letter] = (count[letter] ?? 0) + 1;
        out.push({ tag: `${letter}${count[letter]}`, code, face, amps: Number(row.flc) || undefined, ...(incoming ? { incoming } : {}) });
      }
    }
  }
  return out;
}

/** Terminals a fixed switchgear needs, as a first estimate. */
export function ccsTerminals(devices: CcsDevice[]): { power: number; control: number } {
  let power = 0, control = 0;
  for (const d of devices) {
    if (d.face.kind === 'mcb' || d.face.kind === 'mccb' || d.face.kind === 'mpcb') power += d.face.kind === 'mcb' ? Math.max(2, Math.round(d.face.w / 18)) : 4;
    if (d.face.kind === 'contactor') control += 4;
    if (d.face.kind === 'relay') control += 2;
    if (d.face.kind === 'meter') control += 4;
  }
  return { power, control };
}

interface Row { devices: CcsDevice[]; power: boolean; h: number; used: number }

/** Devices into rows of a plate `usable` wide: small devices first, power after,
 *  each row filled to `fill` of the plate. */
function intoRows(devices: CcsDevice[], usable: number, fill = 1): Row[] {
  const rows: Row[] = [];
  const groups: [boolean, CcsDevice[]][] = [
    [false, devices.filter(d => !isPowerRow(d.face.kind) && d.face.kind !== 'relay')],
    [false, devices.filter(d => d.face.kind === 'relay')],
    [true, devices.filter(d => isPowerRow(d.face.kind))],
  ];
  for (const [power, list] of groups) {
    let cur: CcsDevice[] = [], w = 0;
    const flush = () => {
      if (!cur.length) return;
      const tallest = Math.max(...cur.map(d => d.face.h));
      const pitch = power ? 0 : (cur.every(d => d.face.kind === 'relay') ? CCS.relayRowPitch : CCS.mcbRowPitch);
      rows.push({ devices: cur, power, h: Math.max(tallest + 2 * CCS.wireNumbers, pitch), used: w });
      cur = []; w = 0;
    };
    for (const d of list) {
      if (w + d.face.w > usable * fill && cur.length) flush();
      cur.push(d); w += d.face.w + CCS.gap;
    }
    flush();
  }
  return rows;
}

/** How the devices fall into panels of a width, filling rows to `fill`. */
function packCcs(devices: CcsDevice[], width: number, fill: number) {
  const usable = width - 2 * CCS.ductSide - 2 * CCS.pastDuct;
  const rows = intoRows(devices.filter(d => !d.incoming), usable, fill);
  const terminals = ccsTerminals(devices);
  const termPitch = 6.2;
  const STRIP = 50;
  // One strip per kind, wrapped when it is wider than the plate.
  const strips: [string, number][] = [];
  for (const [name, n] of [['XP', terminals.control], ['X2', terminals.power]] as [string, number][]) {
    const per = Math.max(1, Math.floor(usable / termPitch));
    for (let left = n, i = 0; left > 0; left -= per, i++) strips.push([i ? `${name} (${i + 1})` : name, Math.min(per, left)]);
  }
  // Duct above, the strips with a duct between each, and the lowest strip
  // ending 300 off the floor (cable bottom).
  const terminalZone = CCS.ductAboveTerminals + strips.length * STRIP + Math.max(0, strips.length - 1) * CCS.ductBelowTerminals;
  const bottomLimit = CCS.height - CCS.terminalsOffFloor;
  const panels: Row[][] = [[]];
  let y = CCS.busbarCompartment;
  for (const r of rows) {
    const duct = r.power ? CCS.ductPowerRow : CCS.ductMcbRow;
    const need = duct + r.h;
    if (y + need + CCS.ductPowerRow + terminalZone > bottomLimit && panels[panels.length - 1].length) {
      panels.push([]); y = CCS.busbarCompartment;
    }
    panels[panels.length - 1].push(r); y += need;
  }
  // The spare (B20): what of the mounting plate between the busbar
  // compartment and the terminals no device row takes — the space under the
  // last row and what each row leaves at its end.
  const plate = (bottomLimit - terminalZone - CCS.busbarCompartment) * usable * panels.length;
  const taken = rows.reduce((t, r) => t + ((r.power ? CCS.ductPowerRow : CCS.ductMcbRow) + r.h) * Math.min(usable, r.used), 0);
  const spare = plate > 0 ? Math.max(0, 1 - taken / plate) : 0;
  return { usable, rows, terminals, termPitch, STRIP, strips, terminalZone, bottomLimit, panels, spare };
}

/** Panel widths a fixed panel is tried at, narrowest first (B5; 1000 only when
 *  needed — B9: an S8 door that wide sags under its equipment). */
export const CCS_WIDTHS = [600, 800, 1000] as const;

/**
 * The internal view of a fixed panel, with the door beside it.
 *
 * `auto` picks the narrowest width that holds everything in one panel with
 * the guide's 20 % of the mounting plate left spare (B20); failing that, 1000
 * — and says so when the spare is short, for the Clarification form. What
 * still does not fit goes on into a twin panel, as the guide allows. The
 * switchgear's own incoming breaker sits at the top, beside the busbar, 80 mm
 * from the side up to 250 A and 105 mm from 315 A (B29).
 */
export function ccsInternalPages(equipment: Equipment, devices: CcsDevice[], width: number | 'auto' = 'auto',
  symbols: LibraryItem[] = []): LayoutPage[] {
  const notes: string[] = [];
  let chosen = typeof width === 'number' ? width : 1000;
  if (width === 'auto') {
    const one = CCS_WIDTHS.find(w => {
      const p = packCcs(devices, w, 1);
      return p.panels.length === 1 && p.spare >= CCS.spare;
    });
    if (one) chosen = one;
    else if (packCcs(devices, 1000, 1).panels.length > 1) {
      notes.push('Too much for one panel: a twin panel follows (B26 / wall-mounted: two panels side by side).');
    }
  }
  const packed = packCcs(devices, chosen, 1);
  if (packed.spare < CCS.spare) {
    notes.push(`Spare ${Math.round(packed.spare * 100)} % — under the 20 % of the guide: tell the client on the Clarification form (B20).`);
  }
  const { usable, termPitch, STRIP, strips, terminalZone, bottomLimit, panels, spare } = packed;
  width = chosen;
  const incomers = devices.filter(d => d.incoming);
  const k = (AREA.h - 14) / CCS.height;
  return panels.map((panelRows, pi) => {
    const s: Shape[] = [];
    const top = AREA.y + 10;
    const floor = top + CCS.height * k;
    const doorX = AREA.x + 22;
    const x0 = doorX + width * k + 20;
    s.push(text(AREA.x, AREA.y, `${equipment.name} — INTERNAL VIEW${panels.length > 1 ? ` (${pi + 1}/${panels.length})` : ''}`, 4, 'TITLE', 'start', true));
    s.push(text(AREA.x, AREA.y + 5, `ducts: side ${CCS.ductSide} · MCB rows ${CCS.ductMcbRow} · breaker/contactor rows ${CCS.ductPowerRow} · terminals ${CCS.ductAboveTerminals}/${CCS.ductBelowTerminals} · scale N.T.S`, 2.6));
    s.push(...heightScale(AREA.x + 12, floor, k, CCS.height));

    // The door.
    s.push(rect(doorX, top, width * k, CCS.height * k, 'PANEL', undefined, undefined, 0.5));
    for (const hy of [0.12, 0.55, 0.92]) s.push(rect(doorX + 0.5, top + CCS.height * k * hy, 2, 2, 'PANEL', '#111'));
    s.push(...widthDim(doorX, floor + 5, width * k, `${width} mm`));

    // The cabinet, its busbar compartment and the side ducts.
    s.push(rect(x0, top, width * k, CCS.height * k, 'PANEL', undefined, undefined, 0.5));
    s.push(rect(x0, top, width * k, CCS.busbarCompartment * k, 'PANEL'));
    s.push(rect(x0, top + CCS.busbarCompartment * k, CCS.ductSide * k, (CCS.height - CCS.busbarCompartment) * k, 'PANEL', '#e5e7eb'));
    s.push(rect(x0 + (width - CCS.ductSide) * k, top + CCS.busbarCompartment * k, CCS.ductSide * k, (CCS.height - CCS.busbarCompartment) * k, 'PANEL', '#e5e7eb'));
    // Busbar R S T N, right half of the compartment, on the first panel only.
    if (pi === 0) {
      ['R', 'S', 'T', 'N'].forEach((ph, i) => {
        const by = top + (120 + i * 60) * k;
        s.push(line(x0 + width * 0.45 * k, by, x0 + (width - 40) * k, by, 'BUS', 0.8));
        s.push(text(x0 + width * 0.45 * k - 2, by + 1, ph, 2.4, 'TAG', 'end'));
      });
      // The incoming breaker, top left, the guide's distance in from the side.
      let ix = CCS.breakerFromSide(Math.max(0, ...incomers.map(d => d.amps ?? 0)));
      for (const dev of incomers) {
        const dx = x0 + ix * k;
        const dy = top + 60 * k;
        const sym = symbolFor(dev.code, symbols);
        if (sym) s.push(...placeSymbolAt(sym, { x: dx + dev.face.w * k / 2, y: dy }, dev.face.h * k, newBlockId()));
        else s.push(rect(dx, dy, dev.face.w * k, Math.min(dev.face.h, CCS.busbarCompartment - 80) * k, 'SYMBOL', '#ffffff'));
        s.push(text(dx + dev.face.w * k / 2, dy - 0.8, dev.tag, 1.8, 'TAG', 'middle'));
        ix += dev.face.w + CCS.gap;
      }
    }

    const inner = x0 + (CCS.ductSide + CCS.pastDuct) * k;
    let yy = CCS.busbarCompartment;
    const duct = (at: number, h: number) =>
      s.push(rect(x0 + CCS.ductSide * k, top + at * k, (width - 2 * CCS.ductSide) * k, h * k, 'PANEL', '#e5e7eb'));
    for (const r of panelRows) {
      const d = r.power ? CCS.ductPowerRow : CCS.ductMcbRow;
      duct(yy, d);
      yy += d;
      let xx = 0;
      for (const dev of r.devices) {
        const dx = inner + xx * k;
        const dy = top + (yy + (r.h - dev.face.h) / 2) * k;
        const sym = symbolFor(dev.code, symbols);
        if (sym) {
          s.push(...placeSymbolAt(sym, { x: dx + dev.face.w * k / 2, y: dy }, dev.face.h * k, newBlockId()));
        } else {
          s.push(rect(dx, dy, dev.face.w * k, dev.face.h * k, 'SYMBOL', '#ffffff'));
        }
        s.push(text(dx + dev.face.w * k / 2, dy - 0.8, dev.tag, 1.8, 'TAG', 'middle'));
        xx += dev.face.w + CCS.gap;
      }
      yy += r.h;
    }
    // The duct under the last row.
    const last = panelRows[panelRows.length - 1];
    if (last) { const d = last.power ? CCS.ductPowerRow : CCS.ductMcbRow; duct(yy, d); yy += d; }

    // Terminal plates: control above, power below (guide B15, way 1).
    if (pi === panels.length - 1 && strips.length) {
      let ty = bottomLimit - terminalZone;
      if (ty < yy) {
        s.push(text(x0 + width * k / 2, floor + 9, 'NO ROOM FOR THE TERMINALS 300 mm OFF THE FLOOR — CHECK', 2.4, 'TEXT', 'middle', true));
        ty = yy;
      }
      duct(ty, CCS.ductAboveTerminals);
      ty += CCS.ductAboveTerminals;
      strips.forEach(([name, n], i) => {
        if (i) { duct(ty, CCS.ductBelowTerminals); ty += CCS.ductBelowTerminals; }
        s.push(rect(inner, top + (ty + 8) * k, Math.min(usable, n * termPitch) * k, (STRIP - 10) * k, 'SYMBOL', '#f3f4f6'));
        s.push(text(inner, top + (ty + 6) * k, `-${name} · ${n} terminals (estimate)`, 1.8, 'TAG'));
        ty += STRIP;
      });
    }
    // PE bar along the floor.
    s.push(line(x0 + CCS.ductSide * k, floor - 60 * k, x0 + (width - CCS.ductSide) * k, floor - 60 * k, 'BUS', 0.8));
    s.push(text(x0 + CCS.ductSide * k + 1, floor - 62 * k, 'PE', 2.2, 'TAG'));
    s.push(...widthDim(x0, floor + 5, width * k, `${width} mm`));
    s.push(text(x0 + width * k / 2, floor + 13, 'INTERNAL VIEW', 3.2, 'TITLE', 'middle'));

    return {
      name: `${equipment.name} internal view${panels.length > 1 ? ` ${pi + 1}` : ''}`,
      description: `${panelRows.reduce((n, r) => n + r.devices.length, 0)} devices · ${width} wide · spare ${Math.round(spare * 100)} %`,
      notes,
      width: SHEET.w, height: SHEET.h, shapes: s,
    };
  });
}

/** Which layout a switchgear takes: fixed (CCS, OFF…) when most of its
 *  feeders' templates are FIX, else S8 drawers. */
export function layoutKindOf(data: ProjectData, equipment: Equipment): 's8' | 'ccs' {
  const all = TIERS.flatMap(t => data.templates?.[t] ?? []);
  const rows = equipment.devices ?? [];
  const fixed = rows.filter(r => familyOf('LV', all.find(t => t.id === r.templateId)?.hierarchy)?.id === 'FIX').length;
  return fixed > rows.length / 2 ? 'ccs' : 's8';
}

/** The layout pages of a switchgear, as its kind draws them. */
export function layoutPagesOf(data: ProjectData, equipment: Equipment, symbols: LibraryItem[] = []): LayoutPage[] {
  return layoutKindOf(data, equipment) === 'ccs'
    ? ccsInternalPages(equipment, ccsDevices(data, equipment), 'auto', symbols)
    : s8FrontPages(equipment, planS8(data, equipment), symbols);
}
