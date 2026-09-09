// src/utils/eplanSingleLine.ts
//
// The single-line side of a project: what EPLAN needs to draw it, and a
// schematic drawing of it for review.
//
// Two outputs, from the same data (Device Selection rows + the templates
// behind them):
//
//   buildEplanRows()      one row per device on a feeder, in the column order
//                         EPLAN's device-list import reads — page, device tag,
//                         function text, part number, location. This is the
//                         file that goes into EPLAN.
//   buildSingleLineSvg()  the same lines drawn as a single-line diagram: a
//                         busbar with one branch per feeder, the devices on it
//                         in slot order. For reading and checking, not a
//                         substitute for the EPLAN drawing.
//   buildSingleLineDxf()  that same drawing as CAD geometry, for the customer
//                         who has no EPLAN: layers, lines, arcs and text that
//                         AutoCAD, BricsCAD, ZWCAD or LibreCAD can edit.
import { ProjectData, Equipment, TemplateItem, DeviceTableRow } from '../types/project';
import {
  templateParts, formatPartEntry, stripLocaleTags, getEplanixValue,
  LV_TEMPLATE_PROPERTIES, MV_TEMPLATE_PROPERTIES,
} from './tierEquipmentMatrix';
import { Drawing } from './cad/shapes';
import { renderSvg } from './cad/svg';
import { renderDxf, mergeDrawings } from './cad/dxf';

export const EPLAN_HEADERS = [
  'Page', 'Higher-level function', 'Location', 'DT', 'Function text',
  'Part number', 'Type number', 'Manufacturer', 'Quantity',
  'Feeder no.', 'Bus section', 'Template', 'Slot', 'Description',
];

// The device tag letter EPLAN uses for a slot, when the part itself carries
// none. The part's own label wins — TPMS already stores Q, K, F, T…
const SLOT_LETTER: Record<string, string> = {
  'CB ORDER': 'Q', 'VCB OR VC/FUSE': 'Q', 'CONTACTOR. ORDER': 'K',
  'OVER LOAD RELAY': 'F', 'EARTH FAULT': 'F', 'PROTECTION RELAY': 'F',
  'COREBALANCE CT': 'T', 'CT RATING': 'T', 'PT RATING': 'T',
  'AMMETER': 'P', 'VOLTMETER': 'P', 'MULTIMETER': 'P', 'TRANSDUSER': 'P',
  'AMMETER selector': 'S', 'VOLTMETER selector': 'S',
  'TEST BLOCK': 'X', 'ALARM ANUNCIATOR': 'H', 'ALARM WINDDOW': 'H',
  'VOLTAGE INDICATOR': 'H', 'SURGE ARRESTER': 'F', 'ACCESSORY': 'A',
};

const text = (v: any) => (v == null ? '' : String(v).trim());

const propertyOrder = (tier: 'LV' | 'MV' | 'HV') =>
  tier === 'MV' ? MV_TEMPLATE_PROPERTIES : LV_TEMPLATE_PROPERTIES;

/** One row per device on a feeder line, ready for EPLAN's device-list import. */
export function buildEplanRows(
  data: ProjectData,
  equipment: Equipment,
): (string | number)[][] {
  const templates = new Map(
    [...(data.templates?.[equipment.type] ?? [])].map(t => [t.id, t as TemplateItem]));
  const order = propertyOrder(equipment.type);
  const rows: (string | number)[][] = [];
  const project = text(data.projectName) || 'PROJECT';

  (equipment.devices ?? []).forEach((line, index) => {
    const page = index + 1;
    const template = line.templateId ? templates.get(line.templateId) : undefined;
    const parts = template ? templateParts(template) : {};
    // Slots the template actually fills, in the order the tier lays them out;
    // anything unexpected still comes through, after the known ones.
    const slots = [
      ...order.filter(p => parts[p]?.length),
      ...Object.keys(parts).filter(p => !order.includes(p)),
    ];

    const counters: Record<string, number> = {};
    let wrote = false;

    for (const slot of slots) {
      for (const part of parts[slot]) {
        const label = stripLocaleTags(part?.label) || SLOT_LETTER[slot] || 'A';
        counters[label] = (counters[label] ?? 0) + 1;
        const dt = `-${label}${page}${counters[label] > 1 ? `.${counters[label]}` : ''}`;
        rows.push([
          page,
          `=${project}`,
          `+${equipment.name}${text(line.moduleNo) ? `.${text(line.moduleNo)}` : ''}`,
          dt,
          stripLocaleTags(part?.fullData?.Designation1) || slot,
          getEplanixValue(part?.fullData),
          stripLocaleTags(part?.fullData?.TypeNumber),
          stripLocaleTags(part?.fullData?.Manufacturer),
          part?.quantity ?? 1,
          text(line.feederNo),
          text(line.busSection),
          text(line.templateName),
          slot,
          text(line.description),
        ]);
        wrote = true;
      }
    }

    // A line with no parts yet still deserves its page, so the drawing set and
    // the table stay the same length.
    if (!wrote) {
      rows.push([
        page, `=${project}`, `+${equipment.name}`, '', '', '', '', '', 0,
        text(line.feederNo), text(line.busSection), text(line.templateName), '',
        text(line.description),
      ]);
    }
  });

  return rows;
}


// ── The drawing ──────────────────────────────────────────────────────────────
//
// Laid out the way SIMARIS draws a distribution board: the supply at the top
// left, a busbar across the sheet with its ratings beside it, one branch per
// outgoing feeder hanging off it with its devices in order, and under each
// branch a data block — feeder, tag, description, rating, current, cable —
// so the sheet can be read without the tables. Sheets are paginated, a fixed
// number of feeders each, like SIMARIS pages a board over several drawings.

type SymbolKind = 'breaker' | 'switch-fuse' | 'contactor' | 'overload' | 'ct' | 'pt'
                | 'meter' | 'relay' | 'arrester' | 'fuse' | 'box';

// Which symbol stands for a slot. Anything not named here is drawn as a dashed
// box carrying its code, which is honest: the part is on the line, and the
// drawing does not pretend to know its schematic shape.
const SLOT_SYMBOL: Record<string, SymbolKind> = {
  'CB ORDER': 'breaker', 'VCB OR VC/FUSE': 'breaker',
  'CONTACTOR. ORDER': 'contactor',
  'OVER LOAD RELAY': 'overload',
  'CT RATING': 'ct', 'COREBALANCE CT': 'ct', 'PT RATING': 'pt',
  'AMMETER': 'meter', 'VOLTMETER': 'meter', 'MULTIMETER': 'meter', 'TRANSDUSER': 'meter',
  'PROTECTION RELAY': 'relay', 'EARTH FAULT': 'relay',
  'SURGE ARRESTER': 'arrester',
  'TEST BLOCK': 'box', 'ACCESSORY': 'box', 'VOLTAGE INDICATOR': 'box',
};

const esc = (s: string) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Feeders that bring power in rather than take it out. */
const isIncomer = (line: DeviceTableRow) =>
  /incom|main|supply|source|tie|coupl/i.test(
    `${line.wiringType ?? ''} ${line.description ?? ''} ${line.templateName ?? ''}`);

const isMotorLoad = (line: DeviceTableRow) =>
  /^m/i.test(String(line.wiringType || '')) ||
  /motor|pump|fan|blower|compressor|mill/i.test(String(line.description || ''));

// One device on a branch: its symbol, its tag and its code.
interface ChainItem { kind: SymbolKind; tag: string; code: string; slot: string }

function chainFor(
  line: DeviceTableRow,
  templates: Map<string, TemplateItem>,
  order: string[],
  page: number,
): ChainItem[] {
  const template = line.templateId ? templates.get(line.templateId) : undefined;
  const parts = template ? templateParts(template) : {};
  const slots = [
    ...order.filter(p => parts[p]?.length),
    ...Object.keys(parts).filter(p => !order.includes(p)),
  ];
  const counters: Record<string, number> = {};
  const out: ChainItem[] = [];
  for (const slot of slots) {
    for (const part of parts[slot]) {
      const label = stripLocaleTags(part?.label) || SLOT_LETTER[slot] || 'A';
      counters[label] = (counters[label] ?? 0) + 1;
      out.push({
        kind: SLOT_SYMBOL[slot] ?? 'box',
        tag: `-${label}${page}${counters[label] > 1 ? `.${counters[label]}` : ''}`,
        code: formatPartEntry(part),
        slot,
      });
    }
  }
  return out;
}

// Symbols are drawn on the branch line, centred on x, occupying 34 px of it.
// Symbols are drawn on the branch line, centred on x, occupying 34 units of it.
// They are our own geometry, drawn to the IEC 60617 conventions — no symbol
// library is copied — which is what lets the same shapes go out as DXF.
function drawSymbol(d: Drawing, kind: SymbolKind, x: number, y: number): void {
  const S = { layer: 'SYMBOL' as const, color: '#111' };
  const line = (x1: number, y1: number, x2: number, y2: number, w = 1.3) =>
    d.line(x1, y1, x2, y2, { ...S, width: w });
  const box = (bx: number, by: number, bw: number, bh: number, w = 1.3, dash?: string) =>
    d.rect(bx, by, bw, bh, { ...S, fill: '#fff', width: w, dash });

  switch (kind) {
    case 'breaker':
      // IEC circuit breaker: a switch whose fixed contact carries the cross.
      line(x, y, x, y + 8);
      d.circle(x, y + 8, 1.8, { ...S, fill: '#111', width: 0 });
      line(x, y + 8, x + 11, y + 26, 1.5);          // moving contact
      line(x - 5, y + 21, x + 5, y + 31, 1.5);      // ×
      line(x + 5, y + 21, x - 5, y + 31, 1.5);
      line(x, y + 26, x, y + 34);
      break;
    case 'switch-fuse':
      line(x, y, x, y + 6);
      line(x, y + 6, x + 11, y + 22, 1.5);
      box(x - 5, y + 22, 10, 12);
      break;
    case 'contactor':
      // Switch stroke with the contactor's arc under the moving contact.
      line(x, y, x, y + 6);
      line(x, y + 6, x + 12, y + 22, 1.5);
      d.arc(x, y + 22, 6, 0, 180, { ...S, width: 1.3 });
      line(x, y + 26, x, y + 34);
      break;
    case 'overload':
      box(x - 8, y + 6, 16, 22);
      d.curve(x - 4, y + 11, x + 1, y + 17, x - 4, y + 23, { ...S, width: 1.3 });
      line(x, y, x, y + 6); line(x, y + 28, x, y + 34);
      break;
    case 'ct':
      line(x, y, x, y + 34);
      d.arc(x + 2, y + 17, 7, 270, 450, { ...S, width: 1.3 });
      break;
    case 'pt':
      line(x, y, x, y + 34);
      d.circle(x + 9, y + 12, 6, { ...S, fill: '#fff', width: 1.2 });
      d.circle(x + 9, y + 22, 6, { ...S, fill: '#fff', width: 1.2 });
      break;
    case 'meter':
      line(x, y, x, y + 34);
      d.circle(x + 12, y + 17, 8, { ...S, fill: '#fff', width: 1.2 });
      break;
    case 'relay':
      line(x, y, x, y + 34);
      box(x + 4, y + 7, 18, 20, 1.2);
      break;
    case 'arrester':
      line(x, y, x, y + 6);
      box(x - 7, y + 6, 14, 20);
      line(x - 4, y + 11, x + 4, y + 21);
      line(x, y + 26, x, y + 34);
      break;
    case 'fuse':
      line(x, y, x, y + 8);
      box(x - 6, y + 8, 12, 18);
      line(x, y + 26, x, y + 34);
      break;
    default:
      line(x, y, x, y + 34);
      box(x + 4, y + 9, 16, 16, 1, '3 2');
  }
}

export interface SingleLinePage {
  page: number;
  of: number;
  /** The sheet as geometry — what `renderSvg` and `renderDxf` both read. */
  drawing: Drawing;
  svg: string;
  feeders: number;
}

const GEOM = {
  margin: 30,
  colWidth: 190,
  headerHeight: 58,
  busY: 150,
  chainStep: 44,
  cardRows: 7,
  cardRowHeight: 15,
};

/**
 * The switchgear drawn as single-line sheets, SIMARIS-fashion: supply, busbar,
 * outgoing branches with their devices, and a data block under each branch.
 * `perPage` feeders to a sheet.
 */
export function buildSingleLinePages(
  data: ProjectData,
  equipment: Equipment,
  perPage = 8,
): SingleLinePage[] {
  const templates = new Map(
    [...(data.templates?.[equipment.type] ?? [])].map(t => [t.id, t as TemplateItem]));
  const order = propertyOrder(equipment.type);
  const library = data.deviceLibrary?.[equipment.type] ?? [];
  const spec =
    library.find(d => d.id === equipment.properties?.deviceLibraryItemId)?.properties ??
    library.find(d => d.name === equipment.name)?.properties ?? {};

  const all = equipment.devices ?? [];
  const incomers = all.filter(isIncomer);
  const outgoing = all.filter(l => !isIncomer(l));
  // A board drawn with no outgoing feeder at all would be an empty sheet; in
  // that case the incomers are drawn as the branches instead.
  const branches = outgoing.length > 0 ? outgoing : all;
  const supply = outgoing.length > 0 ? incomers[0] : undefined;

  const chunks: DeviceTableRow[][] = [];
  for (let i = 0; i < branches.length; i += perPage) chunks.push(branches.slice(i, i + perPage));
  if (chunks.length === 0) chunks.push([]);

  return chunks.map((chunk, index) => {
    const drawing = drawSheet({
      data, equipment, spec, templates, order,
      supply, lines: chunk,
      firstIndex: index * perPage,
      page: index + 1, of: chunks.length,
    });
    return {
      page: index + 1,
      of: chunks.length,
      feeders: chunk.length,
      drawing,
      svg: renderSvg(drawing),
    };
  });
}

function drawSheet(o: {
  data: ProjectData;
  equipment: Equipment;
  spec: any;
  templates: Map<string, TemplateItem>;
  order: string[];
  supply?: DeviceTableRow;
  lines: DeviceTableRow[];
  firstIndex: number;
  page: number;
  of: number;
}): Drawing {
  const { margin, colWidth, chainStep, cardRows, cardRowHeight } = GEOM;
  const supplyWidth = o.supply ? colWidth : 90;
  const bodyLeft = margin + supplyWidth;

  const chains = o.lines.map((line, i) =>
    chainFor(line, o.templates, o.order, o.firstIndex + i + 1));
  const supplyChain = o.supply ? chainFor(o.supply, o.templates, o.order, 0) : [];
  const supplyShown = supplyChain.slice(0, 3);
  const deepest = Math.max(1, ...chains.map(c => c.length));
  // The busbar sits below whatever the incomer needs, never above its own
  // minimum — so the supply never runs into it.
  const busY = Math.max(GEOM.busY, 104 + supplyShown.length * 34 + 26);

  const chainTop = busY + 26;
  const loadY = chainTop + deepest * chainStep + 26;
  const cardY = loadY + 44;
  const cardHeight = cardRows * cardRowHeight + 6;
  const width = Math.max(900, bodyLeft + Math.max(1, o.lines.length) * colWidth + margin);
  const height = cardY + cardHeight + 46;

  const d = new Drawing(width, height,
    `${text(o.equipment.name)} — single line ${o.page}/${o.of}`);

  // ── Title band ────────────────────────────────────────────────────────
  d.line(margin, 52, width - margin, 52, { layer: 'FRAME', color: '#111', width: 1.6 });
  d.text(margin, 24, text(o.equipment.name), 13.5, { layer: 'TITLE', color: '#111', bold: true });
  d.text(margin, 42, [
    o.data.projectName,
    o.data.projectNumber && `OE ${o.data.projectNumber}`,
    o.equipment.type,
    o.equipment.description,
  ].filter(Boolean).join('  ·  '), 10, { layer: 'TITLE', color: '#444' });
  d.text(width - margin, 24, 'Single line diagram', 10,
    { layer: 'TITLE', color: '#444', anchor: 'end' });
  d.text(width - margin, 42, `${new Date().toLocaleDateString()}   sheet ${o.page}/${o.of}`, 10,
    { layer: 'TITLE', color: '#444', anchor: 'end' });

  // ── Supply ────────────────────────────────────────────────────────────
  const supplyX = margin + supplyWidth / 2;
  if (o.supply) {
    d.text(supplyX, 82, clip(String(o.supply.feederNo || 'INCOMING'), 22), 10,
      { layer: 'TEXT', color: '#111', anchor: 'middle', bold: true });
    d.text(supplyX, 96, clip(String(o.supply.description || ''), 26), 9,
      { layer: 'TEXT', color: '#555', anchor: 'middle' });
    // The incomer's own devices, drawn compactly above the busbar.
    let y = 104;
    for (const item of supplyShown) {
      drawSymbol(d, item.kind, supplyX, y);
      d.text(supplyX + 26, y + 20, clip(item.code, 18), 8.5, { layer: 'TEXT', color: '#111' });
      y += 34;
    }
    d.line(supplyX, y, supplyX, busY, { layer: 'WIRE', color: '#111', width: 1.4 });
  } else {
    // No incomer on this board: the busbar is simply fed from elsewhere.
    d.line(supplyX, 96, supplyX, busY, { layer: 'WIRE', color: '#111', width: 1.4 });
    d.poly([[supplyX - 7, 96], [supplyX, 84], [supplyX + 7, 96]],
      { layer: 'WIRE', fill: '#111', width: 0, close: true });
    d.text(supplyX, 78, 'supply', 9, { layer: 'TEXT', color: '#555', anchor: 'middle' });
  }

  // ── Busbar ────────────────────────────────────────────────────────────
  d.line(margin, busY, width - margin, busY, { layer: 'BUS', color: '#111', width: 5 });
  const busText = [
    o.spec.mainBusbarConfiguration,
    o.spec.mainBusbarRatedCurrent && `${o.spec.mainBusbarRatedCurrent} A`,
    o.spec.ratedShortTimeWithstandCurrent && `Icw ${o.spec.ratedShortTimeWithstandCurrent} kA`,
    o.spec.mainBusbarSize,
  ].filter(Boolean).join('  ·  ');
  if (busText) {
    // Right of the sheet, clear of the supply column.
    d.text(width - margin, busY - 10, busText, 9.5,
      { layer: 'TEXT', color: '#333', anchor: 'end' });
  }

  // ── Outgoing branches ─────────────────────────────────────────────────
  o.lines.forEach((line, i) => {
    const x = bodyLeft + i * colWidth + colWidth / 2;
    const chain = chains[i];

    d.line(x, busY, x, chainTop, { layer: 'WIRE', color: '#111', width: 1.3 });
    d.circle(x, busY, 3, { layer: 'WIRE', color: '#111', fill: '#111', width: 0 });

    let y = chainTop;
    for (const item of chain) {
      drawSymbol(d, item.kind, x, y);
      d.text(x + 26, y + 14, item.tag, 9, { layer: 'TAG', color: '#111', bold: true });
      d.text(x + 26, y + 26, clip(item.code, 17), 8.5,
        { layer: 'TEXT', color: '#444', title: item.code });
      y += chainStep;
    }
    d.line(x, y, x, loadY, { layer: 'WIRE', color: '#111', width: 1.3 });

    // The load at the foot: a motor when the line says so, an outgoing arrow
    // otherwise.
    if (isMotorLoad(line)) {
      d.circle(x, loadY + 14, 13, { layer: 'LOAD', color: '#111', fill: '#fff', width: 1.4 });
      d.text(x, loadY + 18, 'M', 11, { layer: 'LOAD', color: '#111', anchor: 'middle' });
    } else {
      d.poly([[x - 7, loadY + 6], [x, loadY + 20], [x + 7, loadY + 6]],
        { layer: 'LOAD', fill: '#111', width: 0, close: true });
    }

    // ── Data block, the same rows on every branch so the sheet reads as a
    //    table under the drawing.
    const cx = bodyLeft + i * colWidth + 6;
    const cw = colWidth - 12;
    d.rect(cx, cardY, cw, cardHeight, { layer: 'TABLE', color: '#111', fill: '#fff', width: 1 });
    const rows: [string, string][] = [
      ['Feeder', String(line.feederNo || '—')],
      ['Tag', String(line.tag || '—')],
      ['Description', String(line.description || '—')],
      ['Template', String(line.templateName || '—')],
      ['Rating', [line.ratingPower && `${line.ratingPower} kW`, line.flc && `${line.flc} A`].filter(Boolean).join(' / ') || '—'],
      ['Cable', String(line.cableSize || '—')],
      ['Position', [line.busSection && `BUS ${line.busSection}`, line.size, line.moduleNo && `M${line.moduleNo}`].filter(Boolean).join(' · ') || '—'],
    ];
    rows.forEach(([label, value], r) => {
      const ry = cardY + 3 + r * cardRowHeight;
      if (r > 0) {
        d.line(cx, ry, cx + cw, ry, { layer: 'TABLE', color: '#e5e7eb', width: 0.8 });
      }
      d.text(cx + 6, ry + 11, label, 8, { layer: 'TABLE', color: '#6b7280' });
      d.text(cx + cw - 6, ry + 11, clip(value, 20), 8.5,
        { layer: 'TEXT', color: '#111', anchor: 'end', title: value });
    });
  });

  if (o.lines.length === 0) {
    d.text(bodyLeft + 20, chainTop + 30, 'No outgoing feeders on this switchgear.', 11,
      { layer: 'TEXT', color: '#888' });
  }

  return d;
}

/** One switchgear's sheets, joined for preview or print. */
export function buildSingleLineSvg(data: ProjectData, equipment: Equipment, perPage = 8): string {
  return buildSingleLinePages(data, equipment, perPage).map(p => p.svg).join('\n');
}

/** A print-ready document: every switchgear, every sheet, one page each. */
export function buildSingleLineHtml(
  data: ProjectData,
  equipments: Equipment[],
  perPage = 8,
): string {
  const pages = equipments.flatMap(eq =>
    buildSingleLinePages(data, eq, perPage).map(page => `
    <section style="page-break-after:always;padding:6px 0">
      <div style="overflow-x:auto">${page.svg}</div>
    </section>`));

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>${esc(data.projectName || 'Project')} — Single line</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,sans-serif;background:#fff;color:#111;padding:14px}
  @page{size:A3 landscape;margin:8mm}
  @media print{.no-print{display:none}body{padding:0}}
</style></head><body>
<button class="no-print" onclick="window.print()" style="margin-bottom:10px;padding:8px 14px;background:#1d4ed8;color:#fff;border:0;border-radius:6px;cursor:pointer">Print / Save as PDF</button>
${pages.join('')}
</body></html>`;
}

/**
 * The switchgear as a DXF file — every sheet in one drawing, tiled left to
 * right, on the layers a drawing office expects (BUS, WIRE, SYMBOL, TAG…).
 *
 * This is the output for customers without EPLAN: DXF is Autodesk's published
 * interchange format, so the file opens and edits in essentially any CAD
 * package, and in EPLAN's own DXF import.
 */
export function buildSingleLineDxf(
  data: ProjectData,
  equipment: Equipment,
  perPage = 8,
): string {
  const pages = buildSingleLinePages(data, equipment, perPage);
  const name = `${text(equipment.name)} — single line`;
  const drawing = pages.length === 1
    ? pages[0].drawing
    : mergeDrawings(pages.map(p => p.drawing), 60, name);

  return renderDxf(drawing, {
    titleBlock: [
      text(equipment.name) || 'SWITCHGEAR',
      [text(data.projectName), text(data.projectNumber) && `OE ${text(data.projectNumber)}`]
        .filter(Boolean).join('   ·   '),
      `Single line diagram · ${equipment.type} · ${pages.length} sheet(s)`,
      new Date().toLocaleDateString(),
    ].filter(Boolean),
  });
}
