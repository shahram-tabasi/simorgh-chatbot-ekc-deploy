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
import { partKeys, partDescription } from '../eplanSingleLine';
import { stripLocaleTags } from '../tierEquipmentMatrix';
import { buildPanelLayout } from '../panelLayout';
import { drawerOfFeeder, type DrawerChoice } from './s8Drawers';
import { CCS, S8_SECTION, faceOf, isPowerRow, sectionModules, type DeviceFace, type S8Section } from './layoutStandard';

export interface LayoutPage {
  name: string;
  description: string;
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

export interface S8Feeder {
  row: DeviceTableRow;
  modules: number;
  /** 'line' when the line states its size, 'list' from the assembly list,
   *  'acb' an air breaker taking the whole section, 'none' guessed. */
  from: 'line' | 'list' | 'acb' | 'none';
  drawer?: DrawerChoice;
  column: number;
  offset: number;
}

export interface S8Plan {
  sections: { column: number; feeders: S8Feeder[]; used: number }[];
  capacity: number;
  /** Feeders with no drawer in the list — drawn at the default, to be chosen. */
  unknown: S8Feeder[];
}

/**
 * The feeders in sections. MODULE NO. (column.position) is kept where the
 * lines have it; otherwise the feeders are filled in line order, a section
 * at a time, and a feeder that does not fit starts the next one.
 */
export function planS8(data: ProjectData, equipment: Equipment, section: S8Section = S8_SECTION,
  fallbackModules = 4): S8Plan {
  const capacity = sectionModules(section);
  const stated = (equipment.devices ?? []).some(r => String(r.moduleNo ?? '').trim());
  const feeders: S8Feeder[] = [];
  if (stated) {
    const layout = buildPanelLayout(data, equipment);
    for (const col of layout.columns) {
      for (const slot of col.slots) {
        const d = drawerOfFeeder(data, slot.row);
        const acb = d.facts.breaker === 'ACB' && d.from !== 'line';
        feeders.push({ row: slot.row, modules: acb ? capacity : d.modules ?? slot.modules, from: acb ? 'acb' : d.from, drawer: d.choices[0],
          column: col.column, offset: slot.offset });
      }
    }
    // Restack each column: the size may have come from the list, not the line.
    const by = new Map<number, S8Feeder[]>();
    for (const f of feeders) by.set(f.column, [...(by.get(f.column) ?? []), f]);
    for (const list of by.values()) { let o = 0; for (const f of list) { f.offset = o; o += f.modules; } }
  } else {
    let column = 1, used = 0;
    for (const row of equipment.devices ?? []) {
      const d = drawerOfFeeder(data, row);
      const acb = d.facts.breaker === 'ACB' && d.from !== 'line';
      const modules = acb ? capacity : d.modules ?? fallbackModules;
      if (used > 0 && used + modules > capacity) { column++; used = 0; }
      feeders.push({ row, modules, from: acb ? 'acb' : d.from, drawer: d.choices[0], column, offset: used });
      used += modules;
    }
  }
  const columns = [...new Set(feeders.map(f => f.column))].sort((a, b) => a - b);
  return {
    sections: columns.map(column => {
      const list = feeders.filter(f => f.column === column);
      return { column, feeders: list, used: list.reduce((s, f) => s + f.modules, 0) };
    }),
    capacity,
    unknown: feeders.filter(f => f.from === 'none'),
  };
}

/** Front view pages: as many sections to a sheet as stay readable. */
export function s8FrontPages(equipment: Equipment, plan: S8Plan, section: S8Section = S8_SECTION): LayoutPage[] {
  const secW = section.deviceWidth + section.cableWidth;
  const k = Math.min((AREA.h - 18) / section.height, 1 / 20);
  const perPage = Math.max(1, Math.floor((AREA.w - 26) / (secW * k)));
  const pages: LayoutPage[] = [];
  for (let start = 0; start < plan.sections.length || start === 0; start += perPage) {
    const chunk = plan.sections.slice(start, start + perPage);
    const s: Shape[] = [];
    const left = AREA.x + 22;
    const top = AREA.y + 10;
    const floor = top + section.height * k;
    s.push(text(AREA.x, AREA.y, `${equipment.name} — SIVACON S8 FRONT VIEW`, 4, 'TITLE', 'start', true));
    s.push(text(AREA.x, AREA.y + 5, `1M = ${section.moduleMm} mm · ${plan.capacity}M per section · scale 1:${Math.round(1 / k)}`, 2.6));
    s.push(...heightScale(AREA.x + 12, floor, k, section.height));

    chunk.forEach((sec, i) => {
      const x = left + i * secW * k;
      const dw = section.deviceWidth * k;
      const cw = section.cableWidth * k;
      s.push(rect(x, top, secW * k, section.height * k, 'PANEL', undefined, undefined, 0.5));
      // Main busbar compartment, across the device compartment.
      s.push(rect(x, top, dw, section.busbarTop * k, 'PANEL', '#e5e7eb'));
      s.push(text(x + dw / 2, top + section.busbarTop * k / 2 + 1, 'MAIN BUSBAR', 2.2, 'TEXT', 'middle'));
      // Cable compartment.
      s.push(rect(x + dw, top, cw, section.height * k, 'PANEL', undefined, '3 2'));
      s.push(text(x + dw + cw / 2, top + section.height * k / 2, 'CABLE COMPARTMENT', 2.2, 'TEXT', 'middle', false, 90));
      s.push(text(x + secW * k / 2, top - 2, `+${sec.column}`, 3.2, 'TAG', 'middle', true));

      const y0 = top + section.busbarTop * k;
      for (const f of sec.feeders) {
        const y = y0 + f.offset * section.moduleMm * k;
        const h = f.modules * section.moduleMm * k;
        const fill = f.from === 'none' ? '#fef3c7' : '#ffffff';
        s.push(rect(x + 0.6, y + 0.3, dw - 1.2, h - 0.6, 'SLOT', fill));
        const no = String(f.row.feederNo ?? '').trim() || '—';
        s.push(text(x + 2, y + Math.min(h - 1, 3.2), no, 2.6, 'TAG', 'start', true));
        s.push(text(x + dw - 2, y + Math.min(h - 1, 3.2), `${f.modules}M`, 2.4, 'TEXT', 'end'));
        if (h > 6.5) {
          const second = f.from === 'acb' ? 'ACB' : [f.drawer?.row.code, f.row.sfdHfd].filter(Boolean).join(' · ')
            || String(f.row.templateName ?? '');
          s.push(text(x + 2, y + 6.2, second.slice(0, 22), 2, 'TEXT'));
        }
      }
      const free = plan.capacity - sec.used;
      if (free > 0) {
        const y = y0 + sec.used * section.moduleMm * k;
        s.push(rect(x + 0.6, y + 0.3, dw - 1.2, free * section.moduleMm * k - 0.6, 'FREE', undefined, '2 1.5'));
        s.push(text(x + dw / 2, y + Math.min(4, free * section.moduleMm * k - 1), `SPARE ${free}M`, 2.2, 'FREE', 'middle'));
      } else if (free < 0) {
        s.push(text(x + dw / 2, floor + 9, `OVER BY ${-free}M`, 2.4, 'TEXT', 'middle', true));
      }
      s.push(...widthDim(x, floor + 5, secW * k, `${secW}`));
    });
    pages.push({
      name: `${equipment.name} front view`,
      description: chunk.length
        ? `S8 sections +${chunk[0].column}…+${chunk[chunk.length - 1].column}`
        : 'S8 front view',
      width: SHEET.w, height: SHEET.h, shapes: s,
    });
    if (plan.sections.length === 0) break;
  }
  return pages;
}

// ── Fixed (CCS) internal view ─────────────────────────────────────────────

export interface CcsDevice {
  tag: string;
  code: string;
  face: DeviceFace;
  amps?: number;
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
      for (let i = 0; i < qty; i++) {
        const letter = LETTER[face.kind];
        count[letter] = (count[letter] ?? 0) + 1;
        out.push({ tag: `${letter}${count[letter]}`, code, face, amps: Number(row.flc) || undefined });
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

interface Row { devices: CcsDevice[]; power: boolean; h: number }

/** Devices into rows of a plate `usable` wide: small devices first, power after. */
function intoRows(devices: CcsDevice[], usable: number): Row[] {
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
      rows.push({ devices: cur, power, h: Math.max(tallest + 2 * CCS.wireNumbers, pitch) });
      cur = []; w = 0;
    };
    for (const d of list) {
      if (w + d.face.w > usable && cur.length) flush();
      cur.push(d); w += d.face.w + CCS.gap;
    }
    flush();
  }
  return rows;
}

/**
 * The internal view of a fixed panel, with the door beside it. Devices that do
 * not fit the panel go on into a second panel — the twin the guide allows.
 */
export function ccsInternalPages(equipment: Equipment, devices: CcsDevice[], width = 1000,
  symbols: LibraryItem[] = []): LayoutPage[] {
  const usable = width - 2 * CCS.ductSide - 2 * CCS.pastDuct;
  const rows = intoRows(devices, usable);
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

  // Rows into panels.
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
      description: `${panelRows.reduce((n, r) => n + r.devices.length, 0)} devices · ${width} wide`,
      width: SHEET.w, height: SHEET.h, shapes: s,
    };
  });
}
