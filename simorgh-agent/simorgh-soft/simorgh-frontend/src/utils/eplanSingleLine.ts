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

type SymbolKind = 'breaker' | 'disconnector' | 'switch-fuse' | 'contactor' | 'overload'
                | 'ct' | 'pt' | 'meter' | 'relay' | 'arrester' | 'fuse'
                | 'transformer' | 'motor' | 'capacitor' | 'drive' | 'box';

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

// EPLAN's function definition says what the part *is* — "Circuit breaker,
// 3 pole", "Current transformer", "Motor, 3 phase". That text decides the
// symbol, so the drawing follows EPLAN's own classification of the part
// rather than the slot the part happens to sit in.
const FUNCTION_SYMBOL: [RegExp, SymbolKind][] = [
  [/vacuum|circuit.?breaker|leistungsschalter|\bmccb\b|\bacb\b|\bvcb\b|\bmcb\b/i, 'breaker'],
  [/switch.?disconnector|disconnector|isolator|load.?break|sectionali[sz]er/i, 'disconnector'],
  [/fuse.?switch|switch.?fuse/i, 'switch-fuse'],
  [/\bfuse\b|sicherung/i, 'fuse'],
  [/contactor|sch(ü|u)tz/i, 'contactor'],
  [/overload|thermal.?relay|bimetal/i, 'overload'],
  [/current.?transformer|stromwandler|\bct\b/i, 'ct'],
  [/voltage.?transformer|potential.?transformer|spannungswandler|\bpt\b|\bvt\b/i, 'pt'],
  [/transformer|transformator/i, 'transformer'],
  [/ammeter|voltmeter|multimeter|power.?meter|measuring|\bmeter\b/i, 'meter'],
  [/protection.?relay|protective|\brelay\b/i, 'relay'],
  [/surge.?arrester|arrester|\bspd\b|overvoltage/i, 'arrester'],
  [/capacitor|kondensator|power.?factor/i, 'capacitor'],
  [/soft.?start|frequency.?(converter|inverter)|\bvfd\b|\bvsd\b|drive/i, 'drive'],
  [/\bmotor\b/i, 'motor'],
];

export function kindFromFunction(functionDefinition?: string): SymbolKind | null {
  const text = String(functionDefinition ?? '');
  if (!text) return null;
  for (const [pattern, kind] of FUNCTION_SYMBOL) if (pattern.test(text)) return kind;
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
interface ChainItem {
  kind: SymbolKind;
  tag: string;
  code: string;
  slot: string;
  /** What EPLAN says this part is, when its parts database was reachable. */
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
    for (const part of parts[slot]) {
      const label = stripLocaleTags(part?.label) || SLOT_LETTER[slot] || 'A';
      counters[label] = (counters[label] ?? 0) + 1;
      // EPLAN's own classification of the part wins; the slot it sits in is
      // the fallback for a part EPLAN does not know.
      const eplan = lookupSymbol(part, symbols);
      const kind = kindFromFunction(eplan?.functionDefinition) ?? SLOT_SYMBOL[slot] ?? 'box';
      out.push({
        kind,
        tag: `-${label}${page}${counters[label] > 1 ? `.${counters[label]}` : ''}`,
        code: formatPartEntry(part),
        slot,
        eplan,
      });
    }
  }
  return out;
}

// Symbols are drawn on the branch line, centred on x, occupying 34 px of it.
function drawSymbol(kind: SymbolKind, x: number, y: number): string {
  const g: string[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number, w = 1.3) =>
    g.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#111" stroke-width="${w}"/>`);
  switch (kind) {
    case 'breaker':
      // IEC circuit breaker: a switch whose fixed contact carries the cross.
      line(x, y, x, y + 8);
      g.push(`<circle cx="${x}" cy="${y + 8}" r="1.8" fill="#111"/>`);
      line(x, y + 8, x + 11, y + 26, 1.5);          // moving contact
      line(x - 5, y + 21, x + 5, y + 31, 1.5);      // ×
      line(x + 5, y + 21, x - 5, y + 31, 1.5);
      line(x, y + 26, x, y + 34);
      break;
    case 'switch-fuse':
      line(x, y, x, y + 6);
      line(x, y + 6, x + 11, y + 22, 1.5);
      g.push(`<rect x="${x - 5}" y="${y + 22}" width="10" height="12" fill="#fff" stroke="#111" stroke-width="1.3"/>`);
      break;
    case 'contactor':
      // Switch stroke with the contactor's arc under the moving contact.
      line(x, y, x, y + 6);
      line(x, y + 6, x + 12, y + 22, 1.5);
      g.push(`<path d="M ${x - 6} ${y + 22} a 6 6 0 0 0 12 0" fill="none" stroke="#111" stroke-width="1.3"/>`);
      line(x, y + 26, x, y + 34);
      break;
    case 'overload':
      g.push(`<rect x="${x - 8}" y="${y + 6}" width="16" height="22" fill="#fff" stroke="#111" stroke-width="1.3"/>`);
      g.push(`<path d="M ${x - 4} ${y + 11} q 5 6 0 12" fill="none" stroke="#111" stroke-width="1.3"/>`);
      line(x, y, x, y + 6); line(x, y + 28, x, y + 34);
      break;
    case 'ct':
      line(x, y, x, y + 34);
      g.push(`<path d="M ${x + 2} ${y + 10} a 7 7 0 1 1 0 14" fill="none" stroke="#111" stroke-width="1.3"/>`);
      break;
    case 'pt':
      line(x, y, x, y + 34);
      g.push(`<circle cx="${x + 9}" cy="${y + 12}" r="6" fill="#fff" stroke="#111" stroke-width="1.2"/>`);
      g.push(`<circle cx="${x + 9}" cy="${y + 22}" r="6" fill="#fff" stroke="#111" stroke-width="1.2"/>`);
      break;
    case 'meter':
      line(x, y, x, y + 34);
      g.push(`<circle cx="${x + 12}" cy="${y + 17}" r="8" fill="#fff" stroke="#111" stroke-width="1.2"/>`);
      break;
    case 'relay':
      line(x, y, x, y + 34);
      g.push(`<rect x="${x + 4}" y="${y + 7}" width="18" height="20" fill="#fff" stroke="#111" stroke-width="1.2"/>`);
      break;
    case 'arrester':
      line(x, y, x, y + 6);
      g.push(`<rect x="${x - 7}" y="${y + 6}" width="14" height="20" fill="#fff" stroke="#111" stroke-width="1.3"/>`);
      line(x - 4, y + 11, x + 4, y + 21);
      line(x, y + 26, x, y + 34);
      break;
    case 'fuse':
      line(x, y, x, y + 8);
      g.push(`<rect x="${x - 6}" y="${y + 8}" width="12" height="18" fill="#fff" stroke="#111" stroke-width="1.3"/>`);
      line(x, y + 26, x, y + 34);
      break;
    case 'disconnector':
      // A switch with no cross: the contact simply opens.
      line(x, y, x, y + 8);
      g.push(`<circle cx="${x}" cy="${y + 8}" r="1.8" fill="#111"/>`);
      line(x, y + 8, x + 12, y + 26, 1.5);
      g.push(`<circle cx="${x}" cy="${y + 26}" r="1.8" fill="#111"/>`);
      line(x, y + 26, x, y + 34);
      break;
    case 'transformer':
      line(x, y, x, y + 6);
      g.push(`<circle cx="${x}" cy="${y + 13}" r="7.5" fill="none" stroke="#111" stroke-width="1.3"/>`);
      g.push(`<circle cx="${x}" cy="${y + 22}" r="7.5" fill="none" stroke="#111" stroke-width="1.3"/>`);
      line(x, y + 30, x, y + 34);
      break;
    case 'motor':
      line(x, y, x, y + 8);
      g.push(`<circle cx="${x}" cy="${y + 20}" r="11" fill="#fff" stroke="#111" stroke-width="1.4"/>`);
      g.push(`<text x="${x}" y="${y + 24}" font-size="10" text-anchor="middle" fill="#111">M</text>`);
      break;
    case 'capacitor':
      line(x, y, x, y + 14);
      line(x - 8, y + 14, x + 8, y + 14, 1.6);
      line(x - 8, y + 19, x + 8, y + 19, 1.6);
      line(x, y + 19, x, y + 34);
      break;
    case 'drive':
      line(x, y, x, y + 6);
      g.push(`<rect x="${x - 11}" y="${y + 6}" width="22" height="22" fill="#fff" stroke="#111" stroke-width="1.3"/>`);
      line(x - 6, y + 22, x + 6, y + 12, 1.2);
      line(x, y + 28, x, y + 34);
      break;
    default:
      line(x, y, x, y + 34);
      g.push(`<rect x="${x + 4}" y="${y + 9}" width="16" height="16" fill="#fff" stroke="#111" stroke-width="1" stroke-dasharray="3 2"/>`);
  }
  return g.join('');
}

// A device is drawn with the symbol EPLAN exported, when the symbol pack has
// one for it, and with the app's own IEC symbol otherwise.
function drawDevice(item: ChainItem, x: number, y: number): string {
  const url = item.eplan?.packUrl;
  if (url) {
    return `<image href="${esc(url)}" x="${x - 17}" y="${y}" width="34" height="34" ` +
      `preserveAspectRatio="xMidYMid meet"><title>${esc(item.eplan?.symbol || '')}</title></image>` +
      `<line x1="${x}" y1="${y}" x2="${x}" y2="${y + 34}" stroke="#111" stroke-width="0.6" opacity="0.35"/>`;
  }
  return drawSymbol(item.kind, x, y);
}

export interface SingleLinePage {
  page: number;
  of: number;
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
  // A board drawn with no outgoing feeder at all would be an empty sheet; in
  // that case the incomers are drawn as the branches instead.
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
  const { margin, colWidth, chainStep, cardRows, cardRowHeight } = GEOM;
  const supplyWidth = o.supply ? colWidth : 90;
  const bodyLeft = margin + supplyWidth;

  const chains = o.lines.map((line, i) =>
    chainFor(line, o.templates, o.order, o.firstIndex + i + 1, o.symbols));
  const supplyChain = o.supply ? chainFor(o.supply, o.templates, o.order, 0, o.symbols) : [];
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
  out.push(`<text x="${width - margin}" y="24" font-size="10" text-anchor="end" fill="#444">Single line diagram</text>`);
  out.push(`<text x="${width - margin}" y="42" font-size="10" text-anchor="end" fill="#444">${
    esc(`${new Date().toLocaleDateString()}   sheet ${o.page}/${o.of}`)}</text>`);

  // ── Supply ────────────────────────────────────────────────────────────
  const supplyX = margin + supplyWidth / 2;
  if (o.supply) {
    out.push(`<text x="${supplyX}" y="82" font-size="10" font-weight="700" text-anchor="middle" fill="#111">${
      esc(clip(String(o.supply.feederNo || 'INCOMING'), 22))}</text>`);
    out.push(`<text x="${supplyX}" y="96" font-size="9" text-anchor="middle" fill="#555">${
      esc(clip(String(o.supply.description || ''), 26))}</text>`);
    // The incomer's own devices, drawn compactly above the busbar.
    let y = 104;
    for (const item of supplyShown) {
      out.push(drawDevice(item, supplyX, y));
      out.push(`<text x="${supplyX + 26}" y="${y + 20}" font-size="8.5" fill="#111">${esc(clip(item.code, 18))}</text>`);
      y += 34;
    }
    out.push(`<line x1="${supplyX}" y1="${y}" x2="${supplyX}" y2="${busY}" stroke="#111" stroke-width="1.4"/>`);
  } else {
    // No incomer on this board: the busbar is simply fed from elsewhere.
    out.push(`<path d="M ${supplyX} 96 L ${supplyX} ${busY}" stroke="#111" stroke-width="1.4"/>`);
    out.push(`<path d="M ${supplyX - 7} 96 L ${supplyX} 84 L ${supplyX + 7} 96 Z" fill="#111"/>`);
    out.push(`<text x="${supplyX}" y="78" font-size="9" text-anchor="middle" fill="#555">supply</text>`);
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
    // Right of the sheet, clear of the supply column.
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
      out.push(`<text x="${x + 26}" y="${y + 14}" font-size="9" font-weight="600" fill="#111">${esc(item.tag)}</text>`);
      out.push(`<text x="${x + 26}" y="${y + 26}" font-size="8.5" fill="#444"><title>${esc(item.code)}</title>${
        esc(clip(item.code, 17))}</text>`);
      y += chainStep;
    }
    out.push(`<line x1="${x}" y1="${y}" x2="${x}" y2="${loadY}" stroke="#111" stroke-width="1.3"/>`);

    // The load at the foot: a motor when the line says so, an outgoing arrow
    // otherwise.
    if (isMotorLoad(line)) {
      out.push(`<circle cx="${x}" cy="${loadY + 14}" r="13" fill="#fff" stroke="#111" stroke-width="1.4"/>`);
      out.push(`<text x="${x}" y="${loadY + 18}" font-size="11" text-anchor="middle" fill="#111">M</text>`);
    } else {
      out.push(`<path d="M ${x - 7} ${loadY + 6} L ${x} ${loadY + 20} L ${x + 7} ${loadY + 6} Z" fill="#111"/>`);
    }

    // ── Data block, the same rows on every branch so the sheet reads as a
    //    table under the drawing.
    const cx = bodyLeft + i * colWidth + 6;
    const cw = colWidth - 12;
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
      if (r > 0) {
        out.push(`<line x1="${cx}" y1="${ry}" x2="${cx + cw}" y2="${ry}" stroke="#e5e7eb" stroke-width="0.8"/>`);
      }
      out.push(`<text x="${cx + 6}" y="${ry + 11}" font-size="8" fill="#6b7280">${esc(label)}</text>`);
      out.push(`<text x="${cx + cw - 6}" y="${ry + 11}" font-size="8.5" text-anchor="end" fill="#111">` +
        `<title>${esc(value)}</title>${esc(clip(value, 20))}</text>`);
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
