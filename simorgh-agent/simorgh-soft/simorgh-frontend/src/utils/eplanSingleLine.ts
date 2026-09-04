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
import { ProjectData, Equipment, TemplateItem, DeviceTableRow } from '../types/project';
import {
  templateParts, formatPartEntry, stripLocaleTags, getEplanixValue,
  LV_TEMPLATE_PROPERTIES, MV_TEMPLATE_PROPERTIES,
} from './tierEquipmentMatrix';
import { CELL, SymbolId, drawIecSymbol, buildSymbolCatalogueSvg } from './iecSymbols';

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
// Laid out the way a distribution board is drawn: the supply at the top left,
// a busbar across the sheet, one branch per outgoing feeder with its devices
// down it, and under each branch a data block. The symbols themselves are the
// IEC library in iecSymbols.ts.
//
// One rule decides what becomes a symbol: **a slot is one device**. The first
// part in a slot is the device — the breaker, the contactor, the CT — and the
// rest of that slot is its accessories: an auxiliary switch, a shunt trip, a
// terminal cover. Those are written beside the device, never drawn as a second
// switch on the line, which is how a single line is read.

/** What EPLAN says a part is: the symbol it places, and for what function. */
export interface EplanSymbolInfo {
  symbol: string;
  library?: string;
  variant?: string;
  functionDefinition?: string;
  /** An SVG exported from EPLAN, when the symbol pack has one. */
  packUrl?: string;
}
export type EplanSymbolMap = Record<string, EplanSymbolInfo>;

// The slot a part sits in says what the device is, unless EPLAN says better.
const SLOT_SYMBOL: Record<string, SymbolId> = {
  'CB ORDER': 'circuit-breaker',
  'VCB OR VC/FUSE': 'withdrawable-cb',
  'CONTACTOR. ORDER': 'contactor',
  'OVER LOAD RELAY': 'thermal-overload',
  'EARTH FAULT': 'earth-fault-relay',
  'COREBALANCE CT': 'core-balance-ct',
  'PROTECTION RELAY': 'protection-relay',
  'CT RATING': 'current-transformer',
  'PT RATING': 'voltage-transformer',
  'AMMETER': 'ammeter',
  'VOLTMETER': 'voltmeter',
  'MULTIMETER': 'multimeter',
  'TRANSDUSER': 'transducer',
  'AMMETER selector': 'selector-switch',
  'VOLTMETER selector': 'selector-switch',
  'TEST BLOCK': 'test-block',
  'SURGE ARRESTER': 'surge-arrester',
  'VOLTAGE INDICATOR': 'lamp',
  'ALARM ANUNCIATOR': 'lamp',
  'ALARM WINDDOW': 'lamp',
  'ACCESSORY': 'accessory',
};

// EPLAN's function definition — "Circuit breaker, 3 pole", "Current
// transformer", "Motor, 3 phase" — is what the part actually is, so it wins
// over the slot it was filed under.
const FUNCTION_SYMBOL: [RegExp, SymbolId][] = [
  [/withdraw|draw.?out|truck|racking/i, 'withdrawable-cb'],
  [/vacuum|circuit.?breaker|leistungsschalter|\bmccb\b|\bacb\b|\bvcb\b|\bmcb\b/i, 'circuit-breaker'],
  [/switch.?disconnector|load.?break|sectionali[sz]er/i, 'switch-disconnector'],
  [/disconnector|isolator/i, 'disconnector'],
  [/fuse.?switch|switch.?fuse/i, 'switch-fuse'],
  [/\bfuse\b|sicherung/i, 'fuse'],
  [/contactor|sch(ü|u)tz/i, 'contactor'],
  [/overload|thermal.?relay|bimetal/i, 'thermal-overload'],
  [/earth.?fault|residual.?current|\brcd\b/i, 'earth-fault-relay'],
  [/core.?balance|summation.?transformer/i, 'core-balance-ct'],
  [/current.?transformer|stromwandler|\bct\b/i, 'current-transformer'],
  [/voltage.?transformer|potential.?transformer|spannungswandler|\bpt\b|\bvt\b/i, 'voltage-transformer'],
  [/power.?transformer|transformer|transformator/i, 'transformer'],
  [/ammeter|amperemeter/i, 'ammeter'],
  [/voltmeter/i, 'voltmeter'],
  [/multimeter|power.?meter|energy.?meter|\bkwh\b/i, 'multimeter'],
  [/transducer/i, 'transducer'],
  [/selector/i, 'selector-switch'],
  [/protection.?relay|protective|\brelay\b/i, 'protection-relay'],
  [/surge.?arrester|arrester|\bspd\b|overvoltage/i, 'surge-arrester'],
  [/capacitor|kondensator|power.?factor/i, 'capacitor'],
  [/soft.?start/i, 'soft-starter'],
  [/frequency.?(converter|inverter)|\bvfd\b|\bvsd\b|inverter|drive/i, 'drive'],
  [/heater|heating/i, 'heater'],
  [/lamp|indicator|signal|annunciator/i, 'lamp'],
  [/socket|outlet/i, 'socket'],
  [/terminal|test.?block|test.?disconnect/i, 'test-block'],
  [/generator/i, 'generator'],
  [/\bmotor\b/i, 'motor'],
];

// Parts that are not a device of their own: they belong to the device above.
const ACCESSORY = /auxiliary|aux\.|shunt.?trip|under.?voltage|trip.?coil|closing.?coil|handle|cover|terminal.?cover|accessor|spare.?part|connection.?cable|mounting|adapter|link.?kit/i;

export function kindFromFunction(functionDefinition?: string): SymbolId | null {
  const value = String(functionDefinition ?? '');
  if (!value) return null;
  for (const [pattern, id] of FUNCTION_SYMBOL) if (pattern.test(value)) return id;
  return null;
}

// The keys a part might be found under in EPLAN: its order number, its part
// number, its type number — whichever the template row carries.
export function partKeys(part: any): string[] {
  return [
    getEplanixValue(part?.fullData),
    stripLocaleTags(part?.fullData?.OrderNumber),
    stripLocaleTags(part?.fullData?.PartNumber),
    stripLocaleTags(part?.fullData?.TypeNumber),
    stripLocaleTags(part?.partNumber),
  ].map(v => String(v ?? '').trim()).filter(Boolean);
}

export function lookupSymbol(part: any, symbols?: EplanSymbolMap): EplanSymbolInfo | undefined {
  if (!symbols) return undefined;
  for (const key of partKeys(part)) if (symbols[key]) return symbols[key];
  return undefined;
}

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

/** One device on a branch: its symbol, its tag, its code and its accessories. */
interface ChainItem {
  id: SymbolId;
  tag: string;
  code: string;
  slot: string;
  /** The rest of the parts in this slot — written, not drawn. */
  accessories: string[];
  eplan?: EplanSymbolInfo;
}

function chainFor(
  line: DeviceTableRow,
  templates: Map<string, TemplateItem>,
  order: string[],
  page: number,
  symbols?: EplanSymbolMap,
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
    const inSlot = parts[slot];
    // The device of this slot is its first part; anything after it is an
    // accessory of that device, not a device of its own.
    const primary = inSlot[0];
    const eplan = lookupSymbol(primary, symbols);
    const fromFunction = kindFromFunction(eplan?.functionDefinition);
    const isAccessory = !fromFunction &&
      ACCESSORY.test(`${eplan?.functionDefinition ?? ''} ${stripLocaleTags(primary?.fullData?.Designation1)}`);
    const id: SymbolId = fromFunction ?? (isAccessory ? 'accessory' : (SLOT_SYMBOL[slot] ?? 'accessory'));

    const label = stripLocaleTags(primary?.label) || SLOT_LETTER[slot] || 'A';
    counters[label] = (counters[label] ?? 0) + 1;

    out.push({
      id,
      tag: `-${label}${page}${counters[label] > 1 ? `.${counters[label]}` : ''}`,
      code: formatPartEntry(primary),
      slot,
      accessories: inSlot.slice(1).map(p => formatPartEntry(p)),
      eplan,
    });
  }

  return out;
}

export interface SingleLinePage {
  page: number;
  of: number;
  svg: string;
  feeders: number;
}

const GEOM = {
  margin: 30,
  colWidth: 200,
  busY: 150,
  cardRows: 7,
  cardRowHeight: 15,
};

/**
 * The switchgear drawn as single-line sheets: supply, busbar, outgoing
 * branches with their devices, and a data block under each branch.
 */
export function buildSingleLinePages(
  data: ProjectData,
  equipment: Equipment,
  perPage = 8,
  symbols?: EplanSymbolMap,
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
  const branches = outgoing.length > 0 ? outgoing : all;
  const supply = outgoing.length > 0 ? incomers[0] : undefined;

  const chunks: DeviceTableRow[][] = [];
  for (let i = 0; i < branches.length; i += perPage) chunks.push(branches.slice(i, i + perPage));
  if (chunks.length === 0) chunks.push([]);

  return chunks.map((chunk, index) => ({
    page: index + 1,
    of: chunks.length,
    feeders: chunk.length,
    svg: drawSheet({
      data, equipment, spec, templates, order, symbols,
      supply, lines: chunk,
      firstIndex: index * perPage,
      page: index + 1, of: chunks.length,
    }),
  }));
}

// A device is drawn with the symbol exported from EPLAN when the pack has one,
// and with the library's IEC symbol otherwise.
function drawDevice(item: ChainItem, x: number, y: number): string {
  const url = item.eplan?.packUrl;
  if (url) {
    return `<line x1="${x}" y1="${y}" x2="${x}" y2="${y + CELL}" stroke="#111" stroke-width="0.8"/>` +
      `<image href="${esc(url)}" x="${x - 18}" y="${y + 2}" width="36" height="36" ` +
      `preserveAspectRatio="xMidYMid meet"><title>${esc(item.eplan?.symbol || '')}</title></image>`;
  }
  return drawIecSymbol(item.id, x, y);
}

function drawSheet(o: {
  data: ProjectData;
  equipment: Equipment;
  spec: any;
  templates: Map<string, TemplateItem>;
  order: string[];
  symbols?: EplanSymbolMap;
  supply?: DeviceTableRow;
  lines: DeviceTableRow[];
  firstIndex: number;
  page: number;
  of: number;
}): string {
  const { margin, colWidth, cardRows, cardRowHeight } = GEOM;
  const supplyWidth = o.supply ? colWidth : 90;
  const bodyLeft = margin + supplyWidth;

  const chains = o.lines.map((line, i) =>
    chainFor(line, o.templates, o.order, o.firstIndex + i + 1, o.symbols));
  const supplyChain = o.supply ? chainFor(o.supply, o.templates, o.order, 0, o.symbols) : [];
  const supplyShown = supplyChain.slice(0, 3);
  const deepest = Math.max(1, ...chains.map(c => c.length));
  const busY = Math.max(GEOM.busY, 104 + supplyShown.length * CELL + 26);

  const chainTop = busY + 26;
  const loadY = chainTop + deepest * CELL + 20;
  const cardY = loadY + CELL + 14;
  const cardHeight = cardRows * cardRowHeight + 6;
  const width = Math.max(900, bodyLeft + Math.max(1, o.lines.length) * colWidth + margin);
  const height = cardY + cardHeight + 46;

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Segoe UI, Arial, sans-serif">`);
  out.push(`<rect width="${width}" height="${height}" fill="#fff"/>`);

  // ── Title band ────────────────────────────────────────────────────────
  out.push(`<line x1="${margin}" y1="52" x2="${width - margin}" y2="52" stroke="#111" stroke-width="1.6"/>`);
  out.push(`<text x="${margin}" y="24" font-size="13.5" font-weight="700" fill="#111">${esc(o.equipment.name)}</text>`);
  out.push(`<text x="${margin}" y="42" font-size="10" fill="#444">${esc([
    o.data.projectName,
    o.data.projectNumber && `OE ${o.data.projectNumber}`,
    o.equipment.type,
    o.equipment.description,
  ].filter(Boolean).join('  ·  '))}</text>`);
  out.push(`<text x="${width - margin}" y="24" font-size="10" text-anchor="end" fill="#444">Single line diagram — IEC</text>`);
  out.push(`<text x="${width - margin}" y="42" font-size="10" text-anchor="end" fill="#444">${
    esc(`${new Date().toLocaleDateString()}   sheet ${o.page}/${o.of}`)}</text>`);

  // ── Supply ────────────────────────────────────────────────────────────
  const supplyX = margin + supplyWidth / 2;
  if (o.supply) {
    out.push(`<text x="${supplyX}" y="80" font-size="10" font-weight="700" text-anchor="middle" fill="#111">${
      esc(clip(String(o.supply.feederNo || 'INCOMING'), 22))}</text>`);
    out.push(`<text x="${supplyX}" y="94" font-size="9" text-anchor="middle" fill="#555">${
      esc(clip(String(o.supply.description || ''), 26))}</text>`);
    let y = 104;
    for (const item of supplyShown) {
      out.push(drawDevice(item, supplyX, y));
      out.push(`<text x="${supplyX + 34}" y="${y + 15}" font-size="9" font-weight="600" fill="#111">${esc(item.tag)}</text>`);
      out.push(`<text x="${supplyX + 34}" y="${y + 27}" font-size="8.5" fill="#444"><title>${esc(item.code)}</title>${esc(clip(item.code, 15))}</text>`);
      y += CELL;
    }
    out.push(`<line x1="${supplyX}" y1="${y}" x2="${supplyX}" y2="${busY}" stroke="#111" stroke-width="1.4"/>`);
  } else {
    out.push(drawIecSymbol('incoming', supplyX, 92));
    out.push(`<line x1="${supplyX}" y1="132" x2="${supplyX}" y2="${busY}" stroke="#111" stroke-width="1.4"/>`);
    out.push(`<text x="${supplyX}" y="84" font-size="9" text-anchor="middle" fill="#555">supply</text>`);
  }

  // ── Busbar ────────────────────────────────────────────────────────────
  out.push(`<line x1="${margin}" y1="${busY}" x2="${width - margin}" y2="${busY}" stroke="#111" stroke-width="5"/>`);
  const busText = [
    o.spec.mainBusbarConfiguration,
    o.spec.mainBusbarRatedCurrent && `${o.spec.mainBusbarRatedCurrent} A`,
    o.spec.ratedShortTimeWithstandCurrent && `Icw ${o.spec.ratedShortTimeWithstandCurrent} kA`,
    o.spec.mainBusbarSize,
  ].filter(Boolean).join('  ·  ');
  if (busText) {
    out.push(`<text x="${width - margin}" y="${busY - 10}" font-size="9.5" text-anchor="end" fill="#333">${esc(busText)}</text>`);
  }

  // ── Outgoing branches ─────────────────────────────────────────────────
  o.lines.forEach((line, i) => {
    const x = bodyLeft + i * colWidth + colWidth / 2;
    const chain = chains[i];

    out.push(`<line x1="${x}" y1="${busY}" x2="${x}" y2="${chainTop}" stroke="#111" stroke-width="1.3"/>`);
    out.push(`<circle cx="${x}" cy="${busY}" r="3" fill="#111"/>`);

    let y = chainTop;
    for (const item of chain) {
      out.push(drawDevice(item, x, y));
      // The label column clears the widest symbol in the library (a relay box
      // or a meter), so nothing is ever written over a symbol.
      out.push(`<text x="${x + 34}" y="${y + 14}" font-size="9" font-weight="600" fill="#111">${esc(item.tag)}</text>`);
      out.push(`<text x="${x + 34}" y="${y + 25}" font-size="8.5" fill="#333"><title>${esc(item.code)}</title>${esc(clip(item.code, 17))}</text>`);
      // Accessories belong to the device: listed under it, never a symbol.
      item.accessories.slice(0, 2).forEach((a, ai) => {
        out.push(`<text x="${x + 34}" y="${y + 35 + ai * 9}" font-size="7.5" fill="#777"><title>${esc(a)}</title>+ ${esc(clip(a, 17))}</text>`);
      });
      if (item.accessories.length > 2) {
        out.push(`<text x="${x + 34}" y="${y + 53}" font-size="7.5" fill="#777">+ ${item.accessories.length - 2} more</text>`);
      }
      y += CELL;
    }
    out.push(`<line x1="${x}" y1="${y}" x2="${x}" y2="${loadY}" stroke="#111" stroke-width="1.3"/>`);
    out.push(drawIecSymbol(isMotorLoad(line) ? 'motor' : 'outgoing', x, loadY));

    // ── Data block ──
    const cx = bodyLeft + i * colWidth + 8;
    const cw = colWidth - 16;
    out.push(`<rect x="${cx}" y="${cardY}" width="${cw}" height="${cardHeight}" fill="#fff" stroke="#111" stroke-width="1"/>`);
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
      if (r > 0) out.push(`<line x1="${cx}" y1="${ry}" x2="${cx + cw}" y2="${ry}" stroke="#e5e7eb" stroke-width="0.8"/>`);
      out.push(`<text x="${cx + 6}" y="${ry + 11}" font-size="8" fill="#6b7280">${esc(label)}</text>`);
      out.push(`<text x="${cx + cw - 6}" y="${ry + 11}" font-size="8.5" text-anchor="end" fill="#111">` +
        `<title>${esc(value)}</title>${esc(clip(value, 22))}</text>`);
    });
  });

  if (o.lines.length === 0) {
    out.push(`<text x="${bodyLeft + 20}" y="${chainTop + 30}" font-size="11" fill="#888">No outgoing feeders on this switchgear.</text>`);
  }

  out.push('</svg>');
  return out.join('\n');
}

/** One switchgear's sheets, joined for preview or print. */
export function buildSingleLineSvg(
  data: ProjectData, equipment: Equipment, perPage = 8, symbols?: EplanSymbolMap,
): string {
  return buildSingleLinePages(data, equipment, perPage, symbols).map(p => p.svg).join('\n');
}

/** A print-ready document: every switchgear, every sheet, one page each. */
export function buildSingleLineHtml(
  data: ProjectData,
  equipments: Equipment[],
  perPage = 8,
  symbols?: EplanSymbolMap,
): string {
  const pages = equipments.flatMap(eq =>
    buildSingleLinePages(data, eq, perPage, symbols).map(page => `
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

/** The symbol library on its own sheet, for printing or checking. */
export function buildSymbolLibraryHtml(): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>IEC single-line symbols</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,sans-serif;background:#fff;color:#111;padding:16px}
  @page{size:A3 landscape;margin:10mm}
  @media print{.no-print{display:none}body{padding:0}}
</style></head><body>
<button class="no-print" onclick="window.print()" style="margin-bottom:10px;padding:8px 14px;background:#1d4ed8;color:#fff;border:0;border-radius:6px;cursor:pointer">Print / Save as PDF</button>
<h1 style="font-size:16px;margin-bottom:4px">IEC single-line symbols — علائم تک‌خطی</h1>
<p style="font-size:11px;color:#555;margin-bottom:10px">The symbols this app draws on a single line. A symbol exported from EPLAN into the symbol pack replaces the one here.</p>
${buildSymbolCatalogueSvg()}
</body></html>`;
}
