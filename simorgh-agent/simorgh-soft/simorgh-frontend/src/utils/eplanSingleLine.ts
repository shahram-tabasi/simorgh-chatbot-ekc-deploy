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
import { CELL, SymbolId, drawIecSymbol, symbolRight, buildSymbolCatalogueSvg } from './iecSymbols';

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
  'VCB OR VC/FUSE': 'vcb',              // MV: the vacuum breaker of the legend
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
  'AMMETER selector': 'ampere-selector',
  'VOLTMETER selector': 'voltage-selector',
  'TEST BLOCK': 'test-block',
  'SURGE ARRESTER': 'surge-arrester',
  'VOLTAGE INDICATOR': 'lamp',
  'ALARM ANUNCIATOR': 'alarm-annunciator',
  'ALARM WINDDOW': 'alarm-annunciator',
  'ACCESSORY': 'accessory',
};

// EPLAN's function definition — "Circuit breaker, 3 pole", "Current
// transformer", "Motor, 3 phase" — is what the part actually is, so it wins
// over the slot it was filed under.
const FUNCTION_SYMBOL: [RegExp, SymbolId][] = [
  [/vacuum.?contactor|contactor.*fuse|\bv\.?c\b.*fuse/i, 'vacuum-contactor-fuse'],
  [/vacuum.?(circuit.?)?breaker|\bvcb\b/i, 'vcb'],
  [/withdraw|draw.?out|truck|racking/i, 'withdrawable-cb'],
  [/miniature.?circuit.?breaker|\bmcb\b/i, 'mcb'],
  [/circuit.?breaker|leistungsschalter|\bmccb\b|\bacb\b/i, 'circuit-breaker'],
  [/switch.?disconnector|load.?break|sectionali[sz]er/i, 'switch-disconnector'],
  [/disconnector|isolator/i, 'disconnector'],
  [/fuse.?switch|switch.?fuse/i, 'switch-fuse'],
  [/hrc.?fuse|high.?rupturing/i, 'hrc-fuse'],
  [/\bfuse\b|sicherung/i, 'fuse'],
  [/contactor|sch(ü|u)tz/i, 'contactor'],
  [/overload|thermal.?relay|bimetal/i, 'thermal-overload'],
  [/earth.?fault|residual.?current|\brcd\b/i, 'earth-fault-relay'],
  [/core.?balance|summation.?transformer/i, 'core-balance-ct'],
  [/current.?transformer|stromwandler|\bct\b/i, 'current-transformer'],
  [/voltage.?transformer|potential.?transformer|spannungswandler|\bpt\b|\bvt\b/i, 'voltage-transformer'],
  [/power.?transformer|transformer|transformator/i, 'transformer'],
  [/\bkwh\b|kilo.?watt.?hour|energy.?meter/i, 'kwh-meter'],
  [/\bkvarh\b|kilo.?var.?hour/i, 'kvarh-meter'],
  [/ammeter|amperemeter/i, 'ammeter'],
  [/voltmeter/i, 'voltmeter'],
  [/power.?factor|cos.?(φ|phi)/i, 'power-factor-meter'],
  [/\bvar.?meter\b/i, 'var-meter'],
  [/watt.?meter/i, 'watt-meter'],
  [/frequency.?meter/i, 'frequency-meter'],
  [/hour.?meter|running.?hour/i, 'hour-meter'],
  [/multimeter|power.?meter/i, 'multimeter'],
  [/transducer/i, 'transducer'],
  [/\bptc\b|thermistor/i, 'ptc'],
  [/ampere.?selector/i, 'ampere-selector'],
  [/voltage.?selector/i, 'voltage-selector'],
  [/selector/i, 'selector-switch'],
  [/protection.?relay|protective|\brelay\b/i, 'protection-relay'],
  [/surge.?arrester|arrester|\bspd\b|overvoltage/i, 'surge-arrester'],
  [/capacitor.*delta|delta.*capacitor/i, 'capacitor-delta'],
  [/capacitor|kondensator/i, 'capacitor'],
  [/surge.?limiter/i, 'surge-limiter'],
  [/annunciator|alarm.?window/i, 'alarm-annunciator'],
  [/local.?control.?station|\blcs\b/i, 'lcs'],
  [/transfer.?switch|\bats\b/i, 'ats'],
  [/magnet\b/i, 'magnet'],
  [/key.?interlock/i, 'key-interlock'],
  [/bus.?duct|bus.?bridge/i, 'bus-duct'],
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
  busY: 150,
  cardRowHeight: 16,
};

// The rows of the block under the drawing, as the office's own sheets carry
// them: one line per property, one column per feeder.
const TABLE_ROWS: { label: string; value: (line: DeviceTableRow) => string }[] = [
  { label: 'BUS', value: l => String(l.busSection || '—') },
  { label: 'Line', value: l => String(l.feederNo || '—') },
  { label: 'Type', value: l => String(l.templateName || l.wiringType || '—') },
  { label: 'Power', value: l => (l.ratingPower ? `${l.ratingPower} kW` : '—') },
  { label: 'Nominal Current', value: l => (l.flc ? `${l.flc} A` : '—') },
  { label: 'Position', value: l => [l.size, l.moduleNo && `M${l.moduleNo}`, l.sfdHfd].filter(Boolean).join(' · ') || '—' },
  { label: 'Tag', value: l => String(l.tag || '—') },
  { label: 'Description', value: l => String(l.description || '—') },
  { label: 'Cable', value: l => String(l.cableSize || '—') },
];

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

// Where the text beside a device starts: clear of a symbol exported from
// EPLAN (they are drawn 36 wide) or of the library symbol's own box.
function labelOffset(item: ChainItem): number {
  return item.eplan?.packUrl ? 24 : symbolRight(item.id) + 6;
}

// How much room a device needs down the line: its own cell, and enough for the
// accessory lines written beside it, so one device's text never runs into the
// next device's tag.
function stepFor(item: ChainItem): number {
  const lines = Math.min(item.accessories.length, 3);
  return Math.max(CELL, 26 + lines * 9);
}

// ── Series and parallel ─────────────────────────────────────────────────────
//
// A device is either in the power path — the line runs through it — or it is
// an instrument working off a transformer beside the line. The office draws
// the first down the branch and the second out to the side, joined by its own
// connection: the CT feeds the ammeter and the protection relay, the
// core-balance CT feeds the protection and earth-fault relays, the VT feeds
// the voltmeter. So an instrument never sits in the power path, where it would
// read as another device the current runs through.
//
// The rank is the order they hang off the line: the current instruments first,
// then the relays (the protection relay between the CT above it and the
// core-balance CT below, since both feed it), then the voltage instruments.
const INSTRUMENT_RANK: Partial<Record<SymbolId, number>> = {
  ammeter: 1, 'ampere-selector': 2, multimeter: 3, 'watt-meter': 4, 'var-meter': 5,
  'power-factor-meter': 6, 'kwh-meter': 7, 'kvarh-meter': 8, transducer: 9,
  'test-block': 10, 'protection-relay': 11, 'earth-fault-relay': 12,
  voltmeter: 13, 'voltage-selector': 14, 'frequency-meter': 15, 'hour-meter': 16,
  'alarm-annunciator': 17, lamp: 18, ptc: 19, lcs: 20,
};
const isInstrument = (id: SymbolId) => INSTRUMENT_RANK[id] != null;

interface Branch {
  /** The devices the current runs through, in order down the line. */
  series: ChainItem[];
  /** The instruments beside the line, in the order they hang off it. */
  instruments: ChainItem[];
  /** For each instrument, the series device that feeds it (an index into
   *  `series`), or null when nothing on this line does — control wiring, drawn
   *  as the legend draws it, with a dashed link. */
  fedBy: (number | null)[];
  /** A second transformer the instrument also works off: the protection relay
   *  takes the phase CTs and the core-balance CT both, and the drawing has to
   *  show both, or the earth-fault side of it is not there. */
  alsoFed: (number | null)[];
}

function splitBranch(chain: ChainItem[]): Branch {
  const series = chain.filter(i => !isInstrument(i.id));
  const instruments = chain.filter(i => isInstrument(i.id))
    .sort((a, b) => (INSTRUMENT_RANK[a.id] ?? 99) - (INSTRUMENT_RANK[b.id] ?? 99));

  const at = (id: SymbolId) => series.findIndex(s => s.id === id);
  const ct = at('current-transformer');
  const cbct = at('core-balance-ct');
  const vt = at('voltage-transformer');
  const any = [ct, cbct, vt].find(n => n >= 0) ?? -1;

  const fedBy = instruments.map(item => {
    let source: number;
    if (item.id === 'earth-fault-relay') source = cbct >= 0 ? cbct : ct;
    else if (item.id === 'voltmeter' || item.id === 'voltage-selector' || item.id === 'frequency-meter')
      source = vt >= 0 ? vt : ct;
    else source = ct >= 0 ? ct : (cbct >= 0 ? cbct : vt);
    if (source < 0) source = any;
    return source >= 0 ? source : null;
  });

  // The protection relay works off the core-balance CT as well as the phase
  // CTs, so it gets its second connection drawn.
  const alsoFed = instruments.map((item, k) =>
    item.id === 'protection-relay' && cbct >= 0 && fedBy[k] !== cbct ? cbct : null);

  return { series, instruments, fedBy, alsoFed };
}

// ── Where everything on a branch sits ───────────────────────────────────────
//
// The instruments hang off the line in groups — one group per transformer that
// feeds them — and a group starts level with its own transformer, so the
// connection runs straight out of it into the instruments it feeds and no
// group is left pointing at another's.
interface InstrumentGroup {
  /** The series device feeding this group, or null for control wiring. */
  source: number | null;
  /** Indices into `branch.instruments`, in the order they hang down. */
  items: number[];
  /** Where each of them sits. */
  ys: number[];
}

interface BranchLayout {
  /** Where each device in the power path sits. */
  ys: number[];
  /** Where the power path leaves the branch. */
  seriesBottom: number;
  groups: InstrumentGroup[];
  /** The lowest point anything on the branch reaches. */
  bottom: number;
}

function layoutBranch(branch: Branch, top: number): BranchLayout {
  const ys: number[] = [];
  let y = top;
  for (const item of branch.series) { ys.push(y); y += stepFor(item); }
  const seriesBottom = branch.series.length > 0 ? y : top;

  // One group per feeding device, in the order those devices sit on the line;
  // control wiring (nothing feeds it) comes last.
  const order: (number | null)[] = [];
  branch.fedBy.forEach(source => { if (!order.includes(source)) order.push(source); });
  order.sort((a, b) => (a == null ? 1e6 : ys[a]) - (b == null ? 1e6 : ys[b]));

  const groups: InstrumentGroup[] = [];
  let cursor = top;
  for (const source of order) {
    const items = branch.instruments
      .map((_, k) => k).filter(k => branch.fedBy[k] === source);
    if (items.length === 0) continue;
    const start = Math.max(cursor, source == null ? top : ys[source] - CELL / 2);
    groups.push({ source, items, ys: items.map((_, k) => start + k * CELL) });
    cursor = start + items.length * CELL;
  }

  return {
    ys, seriesBottom, groups,
    bottom: Math.max(seriesBottom, cursor),
  };
}

/** How tall a branch is: the power path, or the instruments beside it. */
const branchHeight = (b: Branch) => layoutBranch(b, 0).bottom;

// How far right of the line the instruments stand: clear of the tags and codes
// written beside the devices in the power path.
const INSTR_DX = 120;

const line = (x1: number, y1: number, x2: number, y2: number, w = 1.3, dash = '') =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#111" stroke-width="${w}"${
    dash ? ` stroke-dasharray="${dash}"` : ''}/>`;

// The tag in black and the part code in blue, with the accessories under them:
// the office writes the codes in colour beside the symbol, and it keeps the
// two apart at a glance.
function deviceText(item: ChainItem, tx: number, y: number, codeChars = 17): string {
  const out = [
    `<text x="${tx}" y="${y}" font-size="9" font-weight="600" fill="#111">${esc(item.tag)}</text>`,
    `<text x="${tx}" y="${y + 11}" font-size="8.5" fill="#1d4ed8"><title>${esc(item.code)}</title>${
      esc(clip(item.code, codeChars))}</text>`,
  ];
  item.accessories.slice(0, 2).forEach((a, ai) => {
    out.push(`<text x="${tx}" y="${y + 21 + ai * 9}" font-size="7.5" fill="#6b7280"><title>${
      esc(a)}</title>+ ${esc(clip(a, codeChars))}</text>`);
  });
  if (item.accessories.length > 2) {
    out.push(`<text x="${tx}" y="${y + 39}" font-size="7.5" fill="#6b7280">+ ${
      item.accessories.length - 2} more</text>`);
  }
  return out.join('');
}

/**
 * One branch: the power path down the line with its devices, and the
 * instruments beside it, each joined to what feeds it.
 *
 * Returns the drawing and the y the power path leaves at, so the caller can
 * run the line on to the load.
 */
function drawBranch(branch: Branch, x: number, top: number): { svg: string; bottom: number } {
  const out: string[] = [];
  const ix = x + INSTR_DX;
  const { ys, seriesBottom, groups } = layoutBranch(branch, top);

  // A device whose connection leaves at the middle of its cell has its own
  // text written above it, so the connection never runs through the text.
  const feeds = new Set<number>();
  for (const g of groups) if (g.source != null) feeds.add(g.source);
  branch.alsoFed.forEach(s => { if (s != null) feeds.add(s); });
  // With no transformer on the line, control wiring leaves from the first
  // device, so that one's text moves up too.
  const controlFrom = groups.some(g => g.source == null) && branch.series.length > 0 ? 0 : null;
  if (controlFrom != null) feeds.add(controlFrom);

  // The power path: the line first, so the white boxes of the symbols sit on
  // top of it.
  if (branch.series.length > 0) out.push(line(x, top, x, seriesBottom));
  branch.series.forEach((item, index) => {
    out.push(drawDevice(item, x, ys[index]));
    out.push(deviceText(item, x + Math.max(40, labelOffset(item)),
      ys[index] + (feeds.has(index) ? 5 : 14), 15));
  });

  // The instruments beside the line, group by group: the transformer's
  // connection out to the column, and the instruments strung on it.
  for (const group of groups) {
    const first = group.ys[0];
    const last = group.ys[group.ys.length - 1] + CELL;
    const ty = group.source == null
      ? (controlFrom == null ? first + CELL / 2 : ys[controlFrom] + CELL / 2)
      : ys[group.source] + CELL / 2;

    out.push(line(ix, Math.min(first, ty), ix, Math.max(last, ty)));
    out.push(line(x + 8, ty, ix, ty, group.source == null ? 1 : 1.1,
      group.source == null ? '4 3' : ''));
    if (group.source != null) out.push(`<circle cx="${ix}" cy="${ty}" r="2.4" fill="#111"/>`);

    group.items.forEach((k, n) => {
      const item = branch.instruments[k];
      out.push(drawDevice(item, ix, group.ys[n]));
      out.push(deviceText(item, ix + Math.max(34, labelOffset(item)), group.ys[n] + 17, 14));

      // The second transformer feeding this instrument — the core-balance CT
      // under the relay — comes in on its own elbow beside the column, so the
      // two connections stay apart and each one is followed by eye.
      const also = branch.alsoFed[k];
      if (also != null) {
        const ay = ys[also] + CELL / 2;
        const my = group.ys[n] + CELL / 2;
        const ex = ix - 12;
        out.push(line(x + 8, ay, ex, ay, 1.1));
        out.push(line(ex, ay, ex, my, 1.1));
        out.push(line(ex, my, ix, my, 1.1));
        out.push(`<circle cx="${ix}" cy="${my}" r="2.4" fill="#111"/>`);
      }
    });
  }

  return { svg: out.join('\n'), bottom: seriesBottom };
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
  const { margin, cardRowHeight } = GEOM;

  const branches = o.lines.map((line_, i) =>
    splitBranch(chainFor(line_, o.templates, o.order, o.firstIndex + i + 1, o.symbols)));
  const supplyAll = o.supply
    ? splitBranch(chainFor(o.supply, o.templates, o.order, 0, o.symbols))
    : null;
  // The incoming column shows the head of its chain; the whole of it belongs
  // to the incomer's own sheet, not to this one.
  const supplyBranch: Branch | null = supplyAll && {
    series: supplyAll.series.slice(0, 3),
    instruments: supplyAll.instruments.slice(0, 3),
    fedBy: supplyAll.fedBy.slice(0, 3).map(s => (s != null && s < 3 ? s : null)),
    alsoFed: supplyAll.alsoFed.slice(0, 3).map(s => (s != null && s < 3 ? s : null)),
  };

  // A feeder with instruments beside it needs the room for them; one without
  // stays narrow, so a board of plain feeders still fits the sheet.
  const wide = [...branches, ...(supplyBranch ? [supplyBranch] : [])]
    .some(b => b.instruments.length > 0);
  const colWidth = wide ? 290 : 200;
  const branchDx = 34;

  const supplyWidth = o.supply ? colWidth : 90;
  const bodyLeft = margin + supplyWidth;
  const supplyX = margin + branchDx;

  const supplyTop = 104;
  const busY = Math.max(GEOM.busY,
    supplyTop + (supplyBranch ? branchHeight(supplyBranch) : 0) + 26);

  const chainTop = busY + 26;
  const body = Math.max(CELL, ...branches.map(branchHeight));
  const loadY = chainTop + body + 20;
  const tableTop = loadY + CELL + 36;
  const tableHeight = TABLE_ROWS.length * cardRowHeight;
  // The sheet is exactly as wide as the feeders on it: busbar and the block
  // underneath both end at the last column, never in mid-air.
  const contentRight = bodyLeft + Math.max(1, o.lines.length) * colWidth;
  const width = contentRight + margin;
  const height = tableTop + tableHeight + 40;

  const out: string[] = [];
  // Sized by its viewBox and left to fit whatever it is put in, so a wide
  // sheet is scaled down to the screen instead of running off the side of it.
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" ` +
    `preserveAspectRatio="xMidYMin meet" style="max-width:${width}px;height:auto;display:block" ` +
    `font-family="Segoe UI, Arial, sans-serif">`);
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
  out.push(`<text x="${width - margin}" y="24" font-size="10" text-anchor="end" fill="#444">Single line diagram (SLD)</text>`);
  out.push(`<text x="${width - margin}" y="42" font-size="10" text-anchor="end" fill="#444">${
    esc(`${new Date().toLocaleDateString()}   sheet ${o.page}/${o.of}`)}</text>`);

  // ── The busbar, labelled the way the office labels it ────────────────
  const busLabel = [
    `BUS ${o.lines[0]?.busSection || 'A'}`,
    o.spec.serviceVoltage || o.spec.ratedInsulationVoltage,
    o.spec.mainBusbarConfiguration,
    o.spec.mainBusbarRatedCurrent && `${o.spec.mainBusbarRatedCurrent} A`,
    o.spec.ratedShortTimeWithstandCurrent && `${o.spec.ratedShortTimeWithstandCurrent} kA / 1 Sec`,
  ].filter(Boolean).join(', ');
  // Written above the bar and clear of the incoming column, so the label never
  // runs across the supply drop.
  out.push(`<text x="${bodyLeft + 4}" y="${busY - 9}" font-size="9.5" font-weight="600" fill="#111">${esc(busLabel)}</text>`);
  out.push(`<line x1="${margin}" y1="${busY}" x2="${contentRight}" y2="${busY}" stroke="#111" stroke-width="4.5"/>`);

  // ── The incoming column ───────────────────────────────────────────────
  if (o.supply && supplyBranch) {
    out.push(`<text x="${supplyX}" y="80" font-size="10" font-weight="700" fill="#111">${
      esc(clip(String(o.supply.feederNo || 'INCOMING'), 22))}</text>`);
    out.push(`<text x="${supplyX}" y="94" font-size="9" fill="#555">${
      esc(clip(String(o.supply.description || ''), 30))}</text>`);
    const drawn = drawBranch(supplyBranch, supplyX, supplyTop);
    out.push(drawn.svg);
    out.push(`<line x1="${supplyX}" y1="${drawn.bottom}" x2="${supplyX}" y2="${busY}" stroke="#111" stroke-width="1.4"/>`);
  } else {
    out.push(drawIecSymbol('incoming', supplyX, 92));
    out.push(`<line x1="${supplyX}" y1="132" x2="${supplyX}" y2="${busY}" stroke="#111" stroke-width="1.4"/>`);
    out.push(`<text x="${supplyX}" y="84" font-size="9" text-anchor="middle" fill="#555">supply</text>`);
  }

  // ── Outgoing feeders ──────────────────────────────────────────────────
  o.lines.forEach((line_, i) => {
    const x = bodyLeft + i * colWidth + branchDx;
    out.push(`<line x1="${x}" y1="${busY}" x2="${x}" y2="${chainTop}" stroke="#111" stroke-width="1.3"/>`);
    out.push(`<circle cx="${x}" cy="${busY}" r="3" fill="#111"/>`);

    const drawn = drawBranch(branches[i], x, chainTop);
    out.push(drawn.svg);
    out.push(`<line x1="${x}" y1="${drawn.bottom}" x2="${x}" y2="${loadY}" stroke="#111" stroke-width="1.3"/>`);
    out.push(drawIecSymbol(isMotorLoad(line_) ? 'motor' : 'outgoing', x, loadY));
  });

  // ── The block under the drawing ───────────────────────────────────────
  out.push(`<rect x="${margin}" y="${tableTop}" width="${contentRight - margin}" height="${tableHeight}" fill="none" stroke="#111" stroke-width="1"/>`);
  TABLE_ROWS.forEach((row, r) => {
    const ry = tableTop + r * cardRowHeight;
    if (r > 0) out.push(`<line x1="${margin}" y1="${ry}" x2="${contentRight}" y2="${ry}" stroke="#c9ced6" stroke-width="0.7"/>`);
    out.push(`<text x="${margin + 6}" y="${ry + 11}" font-size="8.5" font-weight="600" fill="#111">${esc(row.label)} :</text>`);
    o.lines.forEach((line_, i) => {
      const cx = bodyLeft + i * colWidth + colWidth / 2;
      const value = row.value(line_);
      out.push(`<text x="${cx}" y="${ry + 11}" font-size="8.5" text-anchor="middle" fill="#111">` +
        `<title>${esc(value)}</title>${esc(clip(value, 30))}</text>`);
    });
  });
  // The column rules: the label column ends where the first feeder column
  // begins, so every column below the drawing stands under its own feeder.
  out.push(`<line x1="${bodyLeft}" y1="${tableTop}" x2="${bodyLeft}" y2="${tableTop + tableHeight}" stroke="#111" stroke-width="1"/>`);
  o.lines.forEach((_, i) => {
    if (i === 0) return;
    const cx = bodyLeft + i * colWidth;
    out.push(`<line x1="${cx}" y1="${tableTop}" x2="${cx}" y2="${tableTop + tableHeight}" stroke="#c9ced6" stroke-width="0.7"/>`);
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
