// src/utils/mechanicalReport.ts
//
// The mechanical report, as a workbook.
//
// Reverse-engineered from the routine the Eplanix MVC app runs when its
// Mechanical screen's "Export Mechanical Excel" is pressed: the same six
// sheets in the same reading order, the same palette, the same idea of what a
// mechanical report is for — you open it on Overview, see the switchgear in
// one screen, and drill down from there.
//
//   Cover              what this is, and whose it is
//   Overview           the numbers, the line-up, the breakdowns
//   Equipment Summary  every part, totalled across the switchgear
//   Mechanical Data    every cell, what it was read with, what it produced
//   Cell x Part Matrix which cell needs how many of what
//   Panel Elevation    the line-up drawn, to the cells' own widths
//   Mechanical Items   this app's own derived list — see mechanicalItems.ts
//
// What is deliberately *not* copied:
//
//   **The data.** Eplanix reads a per-cell parts catalogue out of TPMS. This
//   app has its own project — the feeders in Device Selection, the parts on
//   the template behind each one, the Device Library entry for the switchgear
//   — and that is what fills these sheets. Where Eplanix has an HR code and an
//   EKC code, this project has a part number and a manufacturer, so those are
//   the columns: inventing a code the project does not hold would make the
//   report say something nobody entered.
//
//   **The artwork.** Eplanix embeds a PNG of the logo and of a panel. This
//   workbook is written by xlsx-js-style, which has no picture support, and
//   the cover is ours to sign anyway — so it is set rather than drawn.
//
//   **Conditional formatting.** The data bars and colour scales in the
//   original are an Excel feature xlsx-js-style cannot write. Every one of
//   them is computed here instead and baked into the cell's fill, which is
//   the same information and survives being opened by anything.

import * as XLSX from 'xlsx-js-style';
import { ProjectData, Equipment, TemplateItem } from '../types/project';
import { buildPanelLayout, PanelLayout, parseSize } from './panelLayout';
import { buildMechanicalItems, MECHANICAL_HEADERS } from './mechanicalItems';
import {
  CellEstimate, MechanicalCellContext, catalogFor, cellTypeOf, estimateFor,
} from './mechanical';

// ── The palette, as the original mixes it ──────────────────────────────────
const INK = '0F172A';
const NAVY = '1B365D';
const NAVY_SOFT = 'E8EEF6';
const AMBER = 'D97706';
const AMBER_FAINT = 'FFFBEB';
const TEAL = '0F766E';
const TEAL_SOFT = 'CCFBF1';
const SLATE = '475569';
const HAIR = 'CBD5E1';
const ZEBRA = 'F5F8FC';
const CARD = 'F8FAFC';
const WHITE = 'FFFFFF';
const COVER_NAVY = '000F24';
const COVER_BLUE = '357CE8';
const COVER_GREY = '8C97AB';

const text = (v: unknown) => (v == null ? '' : String(v).trim());
const numOf = (v: unknown) => {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/**
 * A colour `t` of the way from white towards `hex`.
 *
 * The stand-in for the data bars and colour scales the original uses: the
 * quantity decides the fill here rather than in the reader, so the shading is
 * in the file itself and does not depend on who opens it.
 */
function shade(hex: string, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const mix = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16);
    return Math.round(255 + (c - 255) * k).toString(16).padStart(2, '0');
  };
  return `${mix(0)}${mix(2)}${mix(4)}`.toUpperCase();
}

/**
 * The fill for a value in a ranked column — the data bar, as a tint.
 *
 * Never the full accent: a bar in Excel is drawn *behind* the number and
 * leaves it on white, and a fill that goes all the way to navy puts dark text
 * on a dark ground. Ranging from a tenth to under a half keeps the ranking
 * visible and every number readable, which is the half of a data bar that
 * matters in a printed report.
 */
const bar = (hex: string, t: number) => shade(hex, 0.10 + 0.35 * Math.max(0, Math.min(1, t)));

// ── Cells ──────────────────────────────────────────────────────────────────

type Edge = 'thin' | 'medium' | 'double';

interface Look {
  bold?: boolean;
  italic?: boolean;
  size?: number;
  color?: string;
  fill?: string;
  h?: 'left' | 'center' | 'right';
  v?: 'top' | 'center' | 'bottom';
  wrap?: boolean;
  indent?: number;
  box?: Edge;
  boxColor?: string;
  left?: Edge;
  leftColor?: string;
  bottom?: Edge;
  bottomColor?: string;
  top?: Edge;
  topColor?: string;
}

function style(l: Look) {
  const s: Record<string, unknown> = {};
  if (l.bold || l.italic || l.size || l.color) {
    s.font = {
      ...(l.bold ? { bold: true } : {}),
      ...(l.italic ? { italic: true } : {}),
      ...(l.size ? { sz: l.size } : {}),
      ...(l.color ? { color: { rgb: l.color } } : {}),
    };
  }
  if (l.fill) s.fill = { patternType: 'solid', fgColor: { rgb: l.fill } };
  if (l.h || l.v || l.wrap || l.indent) {
    s.alignment = {
      ...(l.h ? { horizontal: l.h } : {}),
      ...(l.v ? { vertical: l.v } : {}),
      ...(l.wrap ? { wrapText: true } : {}),
      ...(l.indent ? { indent: l.indent } : {}),
    };
  }
  const edge = (kind?: Edge, colour?: string) =>
    (kind ? { style: kind, color: { rgb: colour ?? HAIR } } : undefined);
  const border: Record<string, unknown> = {};
  if (l.box) {
    const e = edge(l.box, l.boxColor);
    Object.assign(border, { top: e, bottom: e, left: e, right: e });
  }
  if (l.left) border.left = edge(l.left, l.leftColor);
  if (l.bottom) border.bottom = edge(l.bottom, l.bottomColor);
  if (l.top) border.top = edge(l.top, l.topColor);
  if (Object.keys(border).length > 0) s.border = border;
  return s;
}

/**
 * One sheet, written by position rather than by row arrays.
 *
 * These sheets are laid out, not tabulated — merged bands, tiles two cells
 * wide, a drawn elevation — and `aoa_to_sheet` has no way to say any of that.
 * Addressing r,c directly is what lets the code read like the sheet looks.
 */
class Grid {
  private cells = new Map<string, XLSX.CellObject>();
  private merges: XLSX.Range[] = [];
  private cols: { wch: number }[] = [];
  private rows: { hpt: number }[] = [];
  private maxR = 0;
  private maxC = 0;
  private filter?: string;

  set(r: number, c: number, v: string | number | null | undefined, l: Look = {}): void {
    const value = v == null ? '' : v;
    const cell: XLSX.CellObject = typeof value === 'number'
      ? { t: 'n', v: value }
      : { t: 's', v: String(value) };
    (cell as { s?: unknown }).s = style(l);
    this.cells.set(XLSX.utils.encode_cell({ r, c }), cell);
    if (r > this.maxR) this.maxR = r;
    if (c > this.maxC) this.maxC = c;
  }

  /** A merged rectangle carrying one value. */
  block(r1: number, c1: number, r2: number, c2: number,
        v: string | number | null | undefined, l: Look = {}): void {
    this.set(r1, c1, v, l);
    // Every covered cell still needs the style, or the fill stops at the first
    // column in readers that paint merged ranges cell by cell.
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (r === r1 && c === c1) continue;
        this.set(r, c, '', l);
      }
    }
    this.merges.push({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } });
  }

  /** A merged run across one row. */
  band(r: number, c1: number, c2: number,
       v: string | number | null | undefined, l: Look = {}): void {
    this.block(r, c1, r, c2, v, l);
  }

  /** Style a run without changing what is in it. */
  paint(r: number, c1: number, c2: number, l: Look): void {
    for (let c = c1; c <= c2; c++) {
      const key = XLSX.utils.encode_cell({ r, c });
      const had = this.cells.get(key);
      this.set(r, c, had ? (had.v as string | number) : '', l);
    }
  }

  width(c: number, wch: number): void { this.cols[c] = { wch }; }
  height(r: number, hpt: number): void { this.rows[r] = { hpt }; }
  autoFilter(r1: number, c1: number, r2: number, c2: number): void {
    this.filter = `${XLSX.utils.encode_cell({ r: r1, c: c1 })}:${XLSX.utils.encode_cell({ r: r2, c: c2 })}`;
  }

  sheet(): XLSX.WorkSheet {
    const ws: XLSX.WorkSheet = {};
    for (const [ref, cell] of this.cells) ws[ref] = cell;
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: this.maxR, c: this.maxC } });
    ws['!merges'] = this.merges;
    for (let c = 0; c <= this.maxC; c++) if (!this.cols[c]) this.cols[c] = { wch: 10 };
    ws['!cols'] = this.cols;
    ws['!rows'] = this.rows;
    if (this.filter) ws['!autofilter'] = { ref: this.filter };
    return ws;
  }
}

// ── What the report is about ───────────────────────────────────────────────

/** One part on one cell — the row both the summary and the matrix count. */
export interface ReportPart {
  /** The basket of the estimate sheet that emitted it. */
  property: string;
  /** The office's own HR code. */
  hr: string;
  /** The manufacturer's order number. */
  partNumber: string;
  /** The EKC code. */
  ekc: string;
  description: string;
  quantity: number;
}

/** One cell of the switchgear, with everything the report says about it. */
export interface ReportCell {
  index: number;
  feederNo: string;
  tag: string;
  description: string;
  template: string;
  busSection: string;
  size: string;
  /** Modules or cells the size resolves to, for the elevation's widths. */
  modules: number;
  moduleNo: string;
  ratingPower: string;
  flc: string;
  cableSize: string;
  sfdHfd: string;
  parts: ReportPart[];
  /** Everything on this cell, added up. */
  items: number;
  /** The cell type the estimate sheet selects a basket by. */
  cellType: string;
  /** What the sheet was read with — the report shows these as the inputs. */
  context: MechanicalCellContext;
  /** Why this cell produced nothing, when it produced nothing. */
  note?: string;
}

/**
 * The part family, as the original reads it: the first comma-separated token
 * of the description. "Contactor, 3-pole, 25 A" and "Contactor, 4-pole" are
 * one family and two parts, which is the grouping a mechanical estimate is
 * actually made in.
 */
export function familyOf(description: string): string {
  const head = text(description).split(',')[0].trim();
  return head.length === 0 ? 'Other' : head;
}

/**
 * What one feeder needs, from the estimate sheet its panel type has.
 *
 * Not the parts on its template: those are the electrical devices the feeder
 * switches, and a mechanical report is about the sheet metal, the insulators
 * and the contact fingers around them. The sheet decides those from the cell
 * type and a handful of facts — see utils/mechanical/catalog.ts.
 */
function partsOfRow(estimate: CellEstimate): ReportPart[] {
  return estimate.equipment.map(e => ({
    property: e.group,
    hr: e.hr,
    partNumber: e.manufacture,
    ekc: e.ekc,
    description: e.description,
    quantity: e.quantity,
  }));
}

/** The switchgear as the report sees it. */
export function readCells(data: ProjectData, equipment: Equipment): ReportCell[] {
  const templates = new Map<string, TemplateItem>(
    (data.templates?.[equipment.type] ?? []).map((t: TemplateItem) => [text(t.id), t]),
  );
  return (equipment.devices ?? []).map((row, i) => {
    const template = templates.get(text(row.templateId));
    const estimate = estimateFor(data, equipment, row, template);
    const parts = partsOfRow(estimate);
    return {
      index: i + 1,
      feederNo: text(row.feederNo) || String(i + 1),
      tag: text(row.tag),
      description: text(row.description),
      template: text(row.templateName),
      busSection: text(row.busSection),
      size: text(row.size),
      modules: parseSize(row.size).modules,
      moduleNo: text(row.moduleNo),
      ratingPower: text(row.ratingPower),
      flc: text(row.flc),
      cableSize: text(row.cableSize),
      sfdHfd: text(row.sfdHfd),
      parts,
      items: parts.reduce((n, p) => n + p.quantity, 0),
      cellType: cellTypeOf(template),
      context: estimate.context,
      note: estimate.note,
    };
  });
}

/** What the sheets are built from, gathered once. */
interface Facts {
  cells: ReportCell[];
  layout: PanelLayout;
  project: string;
  switchgear: string;
  panelType: string;
  revision: string;
  everyPart: ReportPart[];
  totalQty: number;
  distinctParts: number;
  cellWidthMm: number;
  /** The estimate sheet this switchgear was read with, when one covers it. */
  sheet: string;
  /** Why nothing was produced, when nothing was — the first cell's reason. */
  why?: string;
}

function gather(data: ProjectData, equipment: Equipment, revision: string): Facts {
  const cells = readCells(data, equipment);
  const layout = buildPanelLayout(data, equipment);
  const everyPart = cells.flatMap(c => c.parts);
  const spec = layout.spec as Record<string, unknown>;
  return {
    cells,
    layout,
    project: text(data.projectName) || '-',
    switchgear: text(equipment.name) || '-',
    panelType: text(spec.type) || text(spec.panelType) || text(equipment.type) || '-',
    revision: text(revision) || '-',
    everyPart,
    totalQty: everyPart.reduce((n, p) => n + p.quantity, 0),
    distinctParts: new Set(everyPart.map(p => p.hr || p.description)).size,
    cellWidthMm: numOf(spec.width),
    sheet: catalogFor(text(spec.type) || text(spec.panelType))?.panelType ?? '',
    // Every cell fails for the same reason when the panel type is the problem,
    // so the first one that has a reason is the one worth reporting.
    why: everyPart.length === 0 ? cells.find(c => c.note)?.note : undefined,
  };
}

// ── Sheet 1: Cover ─────────────────────────────────────────────────────────
//
// Ours, and set rather than drawn: this workbook has no picture support, and
// the cover is the one page of a report that should say whose it is.
function coverSheet(f: Facts): XLSX.WorkSheet {
  const g = new Grid();
  const LAST = 11;
  g.width(0, 2);
  for (let c = 1; c <= LAST; c++) g.width(c, 11);
  for (let r = 0; r <= 40; r++) { g.height(r, 15); g.paint(r, 0, LAST + 1, { fill: COVER_NAVY }); }

  g.band(4, 1, LAST, 'SIMORGH', { bold: true, size: 40, color: WHITE, fill: COVER_NAVY, v: 'center' });
  g.height(4, 46);
  g.band(5, 1, LAST, 'DESIGN SUITE', { bold: true, size: 18, color: COVER_BLUE, fill: COVER_NAVY, v: 'center' });
  g.height(5, 26);
  g.band(6, 1, 6, 'Electrical Engineering Design Platform',
    { size: 9, color: COVER_GREY, fill: COVER_NAVY });
  g.band(8, 1, 6, '', { fill: COVER_BLUE });
  g.height(8, 3);

  g.band(12, 1, LAST, 'MECHANICAL ITEMS REPORT',
    { bold: true, size: 20, color: WHITE, fill: COVER_NAVY, v: 'center' });
  g.height(12, 30);
  g.band(13, 1, 8, '', { fill: COVER_NAVY, bottom: 'thin', bottomColor: '1B3A63' });

  g.band(15, 1, LAST, `${f.project}   •   ${f.switchgear}   •   Revision ${f.revision}`,
    { size: 11, color: COVER_GREY, fill: COVER_NAVY });
  g.band(16, 1, LAST, f.panelType, { size: 10, color: COVER_BLUE, fill: COVER_NAVY });

  const facts: [string, string][] = [
    ['CELLS', String(f.cells.length)],
    ['DISTINCT PARTS', String(f.distinctParts)],
    ['TOTAL ITEMS', String(f.totalQty)],
  ];
  facts.forEach(([label, value], i) => {
    const c = 1 + i * 3;
    g.band(19, c, c + 2, label, { bold: true, size: 8, color: COVER_GREY, fill: COVER_NAVY });
    g.band(20, c, c + 2, value, { bold: true, size: 18, color: WHITE, fill: COVER_NAVY });
  });
  g.height(20, 26);

  g.band(23, 1, LAST, `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    { size: 8, color: COVER_GREY, fill: COVER_NAVY });
  return g.sheet();
}

// ── Sheet 2: Overview ──────────────────────────────────────────────────────
function overviewSheet(f: Facts): XLSX.WorkSheet {
  const g = new Grid();
  g.width(0, 2.5);
  for (let c = 1; c <= 10; c++) g.width(c, 15);
  g.width(1, 6);

  g.block(1, 1, 3, 10, 'MECHANICAL ITEMS REPORT',
    { bold: true, size: 22, color: WHITE, fill: NAVY, h: 'center', v: 'center' });
  g.band(4, 1, 10, `${f.project}   •   ${f.switchgear}   •   Revision ${f.revision}`,
    { size: 11, color: SLATE, fill: NAVY_SOFT, h: 'center', v: 'center' });
  g.height(4, 22);

  /** One KPI tile: a coloured cap over a boxed value. */
  const kpi = (r: number, c: number, label: string, value: string | number, accent: string) => {
    g.band(r, c, c + 1, label,
      { bold: true, size: 8, color: WHITE, fill: accent, h: 'center', v: 'center' });
    const shown = String(value);
    g.band(r + 1, c, c + 1, shown, {
      bold: true,
      // A long value gets a smaller point size rather than spilling over the
      // tile beside it — a merged range ignores shrink-to-fit.
      size: shown.length > 12 ? 11 : 16,
      color: INK, fill: CARD, h: 'center', v: 'center', box: 'thin', boxColor: HAIR,
    });
    g.height(r, 15);
    g.height(r + 1, 30);
  };

  const withCable = f.cells.filter(c => c.cableSize).length;
  const withDrawer = f.cells.filter(c => c.sfdHfd).length;
  const noItems = f.cells.filter(c => c.parts.length === 0).length;
  const totalWidth = f.cellWidthMm > 0 ? f.cells.length * f.cellWidthMm : 0;

  kpi(6, 1, 'CELLS', f.cells.length, NAVY);
  kpi(6, 3, 'DISTINCT PARTS', f.distinctParts, NAVY);
  kpi(6, 5, 'TOTAL ITEMS', f.totalQty, AMBER);

  kpi(9, 1, 'PANEL TYPE', f.panelType, TEAL);
  // Which sheet the numbers came from. A report whose items are computed has
  // to say what computed them, or nobody can check it against the sheet.
  kpi(9, 3, 'ESTIMATE SHEET', f.sheet || 'none', f.sheet ? TEAL : AMBER);
  kpi(9, 5, 'TOTAL WIDTH (mm)', totalWidth || '-', TEAL);

  kpi(12, 1, 'CELLS WITH CABLE', withCable, SLATE);
  kpi(12, 3, 'WITHDRAWABLE', withDrawer, SLATE);
  kpi(12, 5, 'CELLS WITH NO ITEMS', noItems, noItems > 0 ? AMBER : SLATE);

  g.set(15, 1, `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    { size: 8, color: SLATE });
  if (f.why) {
    g.band(15, 3, 10, `No items: ${f.why}`, { size: 9, italic: true, color: AMBER });
  }

  // ---- Panel line-up: the cells in the order they stand ------------------
  let r = 17;
  g.band(r, 1, 5, 'PANEL LINE-UP',
    { bold: true, size: 10, color: WHITE, fill: INK, v: 'center', indent: 1 });
  g.height(r, 22);
  r++;

  ['#', 'Feeder', 'Cell type', 'Size', 'Items'].forEach((h, i) => {
    g.set(r, 1 + i, h,
      { bold: true, size: 8.5, color: SLATE, fill: NAVY_SOFT, h: 'center' });
  });
  r++;

  const mostItems = Math.max(1, ...f.cells.map(c => c.items));
  for (const cell of f.cells) {
    const zebraFill = r % 2 === 0 ? ZEBRA : WHITE;
    const line: Look = { size: 9.5, h: 'center', fill: zebraFill, box: 'thin', boxColor: HAIR };
    g.set(r, 1, cell.index, line);
    g.set(r, 2, cell.feederNo, line);
    g.set(r, 3, cell.template || '-', { ...line, h: 'left', indent: 1 });
    g.set(r, 4, cell.size || '-', line);
    // The data bar the original asks Excel for, computed here instead.
    g.set(r, 5, cell.items, { ...line, fill: bar(AMBER, cell.items / mostItems) });
    g.height(r, 18);
    r++;
  }
  r++;

  /** A breakdown table with the same in-cell bar. */
  const breakdown = (caption: string, rows: [string, number][], accent: string) => {
    g.band(r, 1, 4, caption,
      { bold: true, size: 10, color: WHITE, fill: accent, v: 'center', indent: 1 });
    g.height(r, 22);
    r++;
    const most = Math.max(1, ...rows.map(([, v]) => v));
    for (const [label, value] of rows) {
      const fill = r % 2 === 0 ? ZEBRA : WHITE;
      g.band(r, 1, 3, label, { size: 9.5, indent: 1, fill, box: 'thin', boxColor: HAIR });
      g.set(r, 4, value,
        { bold: true, h: 'center', fill: bar(accent, value / most), box: 'thin', boxColor: HAIR });
      g.height(r, 18);
      r++;
    }
    r++;
  };

  const countBy = (pick: (c: ReportCell) => string): [string, number][] => {
    const by = new Map<string, number>();
    for (const c of f.cells) {
      const k = pick(c) || '-';
      by.set(k, (by.get(k) ?? 0) + 1);
    }
    return [...by.entries()].sort((a, b) => b[1] - a[1]);
  };

  breakdown('CELLS BY TEMPLATE', countBy(c => c.template), NAVY);
  breakdown('CELLS BY SIZE', countBy(c => c.size), TEAL);

  const byFamily = new Map<string, number>();
  for (const p of f.everyPart) {
    const k = familyOf(p.description) || '-';
    byFamily.set(k, (byFamily.get(k) ?? 0) + p.quantity);
  }
  breakdown('ITEMS BY PART FAMILY',
    [...byFamily.entries()].sort((a, b) => b[1] - a[1]), AMBER);

  return g.sheet();
}

// ── Sheet 3: Equipment Summary ─────────────────────────────────────────────
function summarySheet(f: Facts): XLSX.WorkSheet {
  const g = new Grid();
  g.width(0, 2.5);

  g.band(0, 1, 8, 'EQUIPMENT SUMMARY  —  every part, totalled across the switchgear',
    { bold: true, size: 14, color: NAVY, v: 'center' });
  g.height(0, 32);

  const headers = ['Family', 'HR Code', 'Manufacture Code', 'EKC Code', 'Description', 'Cells', 'Total qty'];
  const HEAD = 2;
  headers.forEach((h, i) => g.set(HEAD, 1 + i, h, {
    bold: true, size: 10, color: WHITE, fill: AMBER,
    h: 'center', v: 'center', wrap: true, box: 'medium', boxColor: AMBER,
  }));
  g.height(HEAD, 28);

  // Grouped on the part, exactly as the original groups: one row per distinct
  // part, how many cells carry it, how many there are in total.
  const by = new Map<string, {
    family: string; hr: string; partNumber: string; ekc: string; description: string;
    cells: Set<string>; qty: number;
  }>();
  for (const cell of f.cells) {
    for (const p of cell.parts) {
      const key = `${p.hr}|${p.partNumber}|${p.ekc}|${p.description}`;
      const had = by.get(key);
      if (had) { had.cells.add(cell.feederNo); had.qty += p.quantity; continue; }
      by.set(key, {
        family: familyOf(p.description),
        hr: p.hr || '-',
        partNumber: p.partNumber || '-',
        ekc: p.ekc || '-',
        description: p.description || '-',
        cells: new Set([cell.feederNo]),
        qty: p.quantity,
      });
    }
  }
  const summary = [...by.values()].sort((a, b) => b.qty - a.qty);
  const most = Math.max(1, ...summary.map(s => s.qty));

  let r = HEAD + 1;
  for (const item of summary) {
    const fill = r % 2 === 0 ? AMBER_FAINT : WHITE;
    const line: Look = { size: 9.5, h: 'center', v: 'center', fill, box: 'thin', boxColor: HAIR };
    g.set(r, 1, item.family, line);
    g.set(r, 2, item.hr, line);
    g.set(r, 3, item.partNumber, line);
    g.set(r, 4, item.ekc, line);
    g.set(r, 5, item.description, { ...line, h: 'left' });
    g.set(r, 6, item.cells.size, line);
    g.set(r, 7, item.qty, { ...line, fill: bar(AMBER, item.qty / most), bold: true });
    g.height(r, 20);
    r++;
  }

  if (summary.length > 0) {
    g.band(r, 1, 6, 'TOTAL',
      { bold: true, h: 'right', fill: NAVY_SOFT, top: 'double', topColor: NAVY });
    g.set(r, 7, f.totalQty,
      { bold: true, h: 'center', fill: NAVY_SOFT, top: 'double', topColor: NAVY });
    g.height(r, 24);
    g.autoFilter(HEAD, 1, r - 1, 7);
  } else {
    g.band(r, 1, 7, f.why || 'No estimate sheet covers these cells.',
      { italic: true, color: AMBER, size: 10 });
  }

  [16, 14, 20, 16, 50, 10, 12].forEach((w, i) => g.width(1 + i, w));
  return g.sheet();
}

/**
 * The left-hand columns of one cell on the Mechanical Data sheet.
 *
 * In one place because they are written twice — once cell by cell, and again
 * as a merged block when the cell carries more than one part — and two copies
 * of a column order is how a report ends up with a cable size under "IP".
 */
function cellValues(cell: ReportCell, f: Facts): (string | number)[] {
  const c = cell.context;
  return [
    cell.index, cell.feederNo, cell.tag || '-', cell.description || '-',
    cell.template || '-', cell.cellType || '-', cell.busSection || '-',
    c.panelWidth ?? (f.cellWidthMm > 0 ? f.cellWidthMm : '-'),
    c.cbCurrent ?? '-', c.cableSize || '-', c.cbType || '-',
    c.ptStatus === 'YES' ? 'Yes' : 'No',
    c.ip != null ? `IP${c.ip}` : '-',
    c.qc1 ? 'Yes' : 'No', c.qc2 ? 'Yes' : 'No', c.earthSwitch ? 'Yes' : 'No',
  ];
}

// ── Sheet 4: Mechanical Data ───────────────────────────────────────────────
//
// Every cell, the inputs it was read with, and the items it produced — three
// column blocks under three captions, the third divided off by an amber rule,
// exactly as the original lays it out.
function dataSheet(f: Facts): XLSX.WorkSheet {
  const g = new Grid();

  const CELL_COLS = 7;     // 0..6
  const INPUT_COLS = 9;    // 7..15
  const ITEM_COLS = 6;     // 16..21
  const LAST = CELL_COLS + INPUT_COLS + ITEM_COLS - 1;

  g.band(0, 0, LAST, 'MECHANICAL DATA  —  every cell, the inputs it was read with, and the items it produced',
    { bold: true, size: 14, color: NAVY, v: 'center' });
  g.height(0, 32);

  g.band(1, 0, CELL_COLS - 1, 'CELL',
    { bold: true, size: 9, color: WHITE, fill: NAVY, h: 'center', v: 'center' });
  g.band(1, CELL_COLS, CELL_COLS + INPUT_COLS - 1, 'ESTIMATE INPUTS',
    { bold: true, size: 9, color: WHITE, fill: TEAL, h: 'center', v: 'center' });
  g.band(1, CELL_COLS + INPUT_COLS, LAST, 'MECHANICAL ITEM',
    { bold: true, size: 9, color: WHITE, fill: AMBER, h: 'center', v: 'center' });
  g.height(1, 20);

  const headers = [
    // the cell
    '#', 'Feeder no.', 'Tag', 'Description', 'Template', 'Cell type', 'Bus section',
    // what the estimate sheet read it with — the same facts the rules test
    'Panel width (mm)', 'Rated current (A)', 'Cable size', 'CB type', 'VT',
    'IP', 'QC1', 'QC2', 'Earth switch',
    // what the sheet produced
    'Basket', 'HR Code', 'Manufacture Code', 'EKC Code', 'Description', 'Qty',
  ];
  const HEAD = 2;
  headers.forEach((h, i) => {
    const fill = i < CELL_COLS ? NAVY : i < CELL_COLS + INPUT_COLS ? TEAL : AMBER;
    g.set(HEAD, i, h, {
      bold: true, size: 9, color: WHITE, fill,
      h: 'center', v: 'center', wrap: true, box: 'medium', boxColor: fill,
    });
  });
  g.height(HEAD, 34);

  let r = HEAD + 1;
  f.cells.forEach((cell, i) => {
    const span = Math.max(1, cell.parts.length);
    const start = r;
    const even = i % 2 === 0;
    const leftFill = even ? ZEBRA : WHITE;
    const rightFill = even ? AMBER_FAINT : WHITE;
    const left: Look = { size: 9, h: 'center', v: 'center', fill: leftFill, box: 'thin', boxColor: HAIR };

    for (let k = 0; k < span; k++) {
      const row = start + k;
      if (k === 0) {
        cellValues(cell, f).forEach((v, c) =>
          g.set(row, c, v, c === 3 ? { ...left, h: 'left' } : left));
      } else {
        // Left of the divider, a cell speaks once: the remaining rows of its
        // block are blank so the part list reads as belonging to it.
        for (let c = 0; c < CELL_COLS + INPUT_COLS; c++) g.set(row, c, '', left);
      }

      const item: Look = {
        size: 9, h: 'center', v: 'center', fill: rightFill, box: 'thin', boxColor: HAIR,
      };
      const divider: Look = { ...item, left: 'medium', leftColor: AMBER };
      if (cell.parts.length > 0) {
        const p = cell.parts[k];
        g.set(row, 16, p.property || '-', divider);
        g.set(row, 17, p.hr || '-', item);
        g.set(row, 18, p.partNumber || '-', item);
        g.set(row, 19, p.ekc || '-', item);
        g.set(row, 20, p.description || '-', { ...item, h: 'left' });
        g.set(row, 21, p.quantity, item);
      } else {
        // Why, not just nothing: a cell with no items is either a cell type
        // the sheet does not carry or a panel type no sheet covers, and the
        // difference is what somebody has to act on.
        const told: Look = { ...item, italic: true, color: AMBER };
        g.set(row, 16, '-', { ...divider, italic: true, color: AMBER });
        g.set(row, 17, '-', told);
        g.set(row, 18, '-', told);
        g.set(row, 19, '-', told);
        g.set(row, 20, cell.note ?? 'no items', { ...told, h: 'left' });
        g.set(row, 21, 0, told);
      }
      g.height(row, 19);
    }

    if (span > 1) {
      // One cell, one block: the left columns merge down the parts it carries.
      const values = cellValues(cell, f);
      for (let c = 0; c < CELL_COLS + INPUT_COLS; c++) {
        g.block(start, c, start + span - 1, c, values[c],
          c === 3 ? { ...left, h: 'left' } : left);
      }
    }
    r = start + span;
  });

  if (f.cells.length > 0) g.autoFilter(HEAD, 0, r - 1, LAST);

  [5, 14, 12, 24, 20, 20, 12, 15, 15, 12, 16, 7, 8, 7, 7, 12, 22, 14, 20, 16, 40, 8]
    .forEach((w, i) => g.width(i, w));
  return g.sheet();
}

// ── Sheet 5: Cell × Part Matrix ────────────────────────────────────────────
function matrixSheet(f: Facts): XLSX.WorkSheet {
  const g = new Grid();

  const lastCol = 2 + Math.max(f.cells.length, 1);
  g.band(0, 0, lastCol, 'CELL × PART MATRIX  —  quantity of every part per cell',
    { bold: true, size: 14, color: NAVY, v: 'center' });
  g.height(0, 32);

  const by = new Map<string, { partNumber: string; description: string; total: number }>();
  for (const p of f.everyPart) {
    const key = `${p.partNumber}|${p.description}`;
    const had = by.get(key);
    if (had) { had.total += p.quantity; continue; }
    by.set(key, { partNumber: p.partNumber || '-', description: p.description || '-', total: p.quantity });
  }
  const parts = [...by.values()].sort((a, b) => b.total - a.total);

  const HEAD = 2;
  const headLook: Look = {
    bold: true, size: 9, color: WHITE, fill: NAVY, h: 'center', v: 'center', wrap: true,
  };
  g.set(HEAD, 0, 'Part number', headLook);
  g.set(HEAD, 1, 'Description', headLook);
  g.set(HEAD, 2, 'Total', { ...headLook, fill: AMBER });
  f.cells.forEach((c, i) => g.set(HEAD, 3 + i, c.feederNo, headLook));
  g.height(HEAD, 34);

  const most = Math.max(1, ...parts.map(p => p.total));
  const mostInCell = Math.max(1, ...f.cells.flatMap(c => c.parts.map(p => p.quantity)));

  let r = HEAD + 1;
  for (const part of parts) {
    const fill = r % 2 === 0 ? ZEBRA : WHITE;
    const line: Look = { size: 9, h: 'center', v: 'center', fill, box: 'thin', boxColor: HAIR };
    g.set(r, 0, part.partNumber, line);
    g.set(r, 1, part.description, { ...line, h: 'left' });
    g.set(r, 2, part.total, { ...line, bold: true, fill: bar(AMBER, part.total / most) });

    f.cells.forEach((cell, i) => {
      const qty = cell.parts
        .filter(p => (p.partNumber || '-') === part.partNumber
                  && (p.description || '-') === part.description)
        .reduce((n, p) => n + p.quantity, 0);
      // The colour scale, computed: empty stays white, the heaviest cell
      // reaches the same soft teal the original's scale tops out at.
      g.set(r, 3 + i, qty || '',
        qty ? { ...line, fill: shade(TEAL_SOFT, 0.25 + 0.75 * (qty / mostInCell)) } : line);
    });
    g.height(r, 18);
    r++;
  }

  if (parts.length === 0) {
    g.band(HEAD + 1, 0, lastCol, 'No parts on the templates behind these feeders.',
      { italic: true, color: AMBER, size: 10 });
  }

  g.width(0, 22);
  g.width(1, 48);
  g.width(2, 10);
  f.cells.forEach((_, i) => g.width(3 + i, 9));
  return g.sheet();
}

// ── Sheet 6: Panel Elevation ───────────────────────────────────────────────
//
// The line-up drawn out of cells so it prints crisply: one cubicle per feeder,
// as many columns wide as its size deserves, with the compartment stack the
// panel type asks for.
function elevationSheet(f: Facts): XLSX.WorkSheet {
  const g = new Grid();
  const type = f.panelType.toUpperCase();
  const isMv = f.layout.equipment.type === 'MV'
    || /A4|SIMOPRIME|EK36|KV/.test(type);

  g.band(1, 1, 9, 'PANEL ELEVATION', { bold: true, size: 14, color: NAVY });
  g.height(1, 24);
  g.band(2, 1, 9, `${f.switchgear}  —  ${f.panelType}`, { size: 10, color: SLATE });
  g.height(2, 18);

  // caption, rows tall, fill, ink
  const compartments: [string, number, string, string][] = isMv
    ? [
      ['BUSBAR', 2, '1E3350', '7FA8DA'],
      ['LV COMPARTMENT', 4, 'EEF2F7', INK],
      ['CB TRUCK', 5, 'DCE3EB', INK],
      ['', 1, '8EA0B6', INK],
      ['CABLE / CT', 4, 'E7ECF2', INK],
    ]
    : [
      ['BUSBAR', 2, '223A5C', '7FA8DA'],
      ['DISTRIBUTION', 4, 'EEF2F7', INK],
      ['FEEDER MODULES', 6, 'DCE3EB', INK],
      ['', 1, '93A5BB', INK],
      ['CABLE', 4, 'E7ECF2', INK],
    ];

  /** How many spreadsheet columns one cubicle is drawn across. */
  const columnsFor = (cell: ReportCell): number => {
    if (f.cellWidthMm > 0) return Math.max(2, Math.min(5, Math.round(f.cellWidthMm / 275)));
    return Math.max(2, Math.min(5, Math.round(cell.modules) || 3));
  };

  const TOP = 4;
  let col = 1;

  if (f.cells.length === 0) {
    g.set(TOP, 1, 'No cells in this switchgear.', { color: SLATE });
  }

  for (const cell of f.cells) {
    const span = columnsFor(cell);
    let r = TOP;

    g.band(r, col, col + span - 1, cell.feederNo,
      { bold: true, size: 10, color: WHITE, fill: INK, h: 'center', v: 'center' });
    g.height(r, 18);
    r++;

    for (const [caption, rows, fill, ink] of compartments) {
      g.block(r, col, r + rows - 1, col + span - 1, caption, {
        size: 8.5, color: ink, fill, h: 'center', v: 'center', box: 'thin', boxColor: SLATE,
      });
      for (let rr = r; rr < r + rows; rr++) g.height(rr, 14);
      r += rows;
    }

    g.band(r, col, col + span - 1, '', { fill: INK });   // plinth
    g.height(r, 7);
    r++;

    g.band(r, col, col + span - 1, cell.template || '-',
      { size: 8, bold: true, color: NAVY, h: 'center', wrap: true });
    g.height(r, 22);
    g.band(r + 1, col, col + span - 1,
      f.cellWidthMm > 0 ? `${f.cellWidthMm} mm` : (cell.size || '-'),
      { size: 8, color: SLATE, h: 'center' });

    for (let c = col; c < col + span; c++) g.width(c, 5.5);
    col += span;                                          // shoulder to shoulder
  }

  g.width(0, 2.5);
  return g.sheet();
}

// ── Sheet 7: this app's own derived list ───────────────────────────────────
function itemsSheet(data: ProjectData, equipment: Equipment): XLSX.WorkSheet {
  const g = new Grid();
  g.band(0, 0, MECHANICAL_HEADERS.length - 1,
    'MECHANICAL ITEMS  —  counted from what the project states, with the basis for each',
    { bold: true, size: 14, color: NAVY, v: 'center' });
  g.height(0, 32);

  MECHANICAL_HEADERS.forEach((h, i) => g.set(2, i, h, {
    bold: true, size: 10, color: WHITE, fill: TEAL,
    h: 'center', v: 'center', wrap: true, box: 'medium', boxColor: TEAL,
  }));
  g.height(2, 28);

  const rows = buildMechanicalItems(data, equipment);
  rows.forEach((row, i) => {
    const r = 3 + i;
    const fill = r % 2 === 0 ? ZEBRA : WHITE;
    const line: Look = { size: 9.5, v: 'center', fill, box: 'thin', boxColor: HAIR };
    [row.switchgear, row.section, row.item, row.specification, row.unit, row.quantity, row.basis]
      .forEach((v, c) => g.set(r, c, v, c === 5 ? { ...line, h: 'center' } : line));
    g.height(r, 20);
  });
  if (rows.length > 0) g.autoFilter(2, 0, 2 + rows.length, MECHANICAL_HEADERS.length - 1);

  [20, 16, 26, 34, 8, 10, 46].forEach((w, i) => g.width(i, w));
  return g.sheet();
}

// ── The workbook ───────────────────────────────────────────────────────────

/** The mechanical report for one switchgear, ready to be written. */
export function buildMechanicalReport(
  data: ProjectData, equipment: Equipment, revision = '',
): XLSX.WorkBook {
  const f = gather(data, equipment, revision);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, coverSheet(f), 'Cover');
  XLSX.utils.book_append_sheet(wb, overviewSheet(f), 'Overview');
  XLSX.utils.book_append_sheet(wb, summarySheet(f), 'Equipment Summary');
  XLSX.utils.book_append_sheet(wb, dataSheet(f), 'Mechanical Data');
  XLSX.utils.book_append_sheet(wb, matrixSheet(f), 'Cell x Part Matrix');
  XLSX.utils.book_append_sheet(wb, elevationSheet(f), 'Panel Elevation');
  XLSX.utils.book_append_sheet(wb, itemsSheet(data, equipment), 'Mechanical Items');
  return wb;
}

/** What to call the file — the original's shape, with this project's names. */
export function mechanicalReportName(
  data: ProjectData, equipment: Equipment, revision = '',
): string {
  const safe = (s: string) => text(s).replace(/[\\/:*?"<>|]+/g, '_') || '-';
  const rev = text(revision);
  return `MechanicalReport_${safe(text(data.projectName))}_${safe(text(equipment.name))}`
    + `${rev ? `_Rev${safe(rev)}` : ''}.xlsx`;
}
