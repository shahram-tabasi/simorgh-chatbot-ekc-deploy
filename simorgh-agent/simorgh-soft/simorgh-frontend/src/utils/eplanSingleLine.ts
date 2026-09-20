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
import {
  CELL, SymbolId, drawIecSymbol, symbolRight, symbolLeft, symbolHeight,
  overrideBox, buildSymbolCatalogueSvg, IEC_SYMBOLS
} from './iecSymbols';

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
  /** That file's own box and the place its conductor runs in it, so it is
   *  drawn to the cell with its connection point on the branch line. */
  packWidth?: number;
  packHeight?: number;
  packPinX?: number;
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
  [/earth(ing)?[\s-]?switch|earthing.?device|erdungsschalter/i, 'earthing-switch'],
  [/capacitive.?(voltage.?)?divider|voltage.?divider|capacitive.?indicator/i, 'capacitive-divider'],
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

/** What TPMS itself says a part is — its own descriptions, which is all there
 *  is to go on when the EPLAN parts database is out of reach or holds nothing
 *  for it: an earth switch, a capacitive divider, a magnet, a test block. */
export function partDescription(part: any): string {
  return [
    part?.fullData?.Designation1, part?.fullData?.Designation2,
    part?.fullData?.Designation3, part?.fullData?.TypeNumber,
  ].map(v => stripLocaleTags(v)).filter(Boolean).join(' ');
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

/**
 * A template, as much of one as drawing it needs.
 *
 * The template screen carries its own narrower idea of a template; asking for
 * only what is read here means neither has to be widened to match the other.
 */
export interface TemplateLike {
  id?: string;
  name?: string;
  properties?: Record<string, any>;
}

/** Where a part's symbol was decided, so a screen can say why it drew that. */
export type SymbolSource = 'chosen' | 'eplan' | 'description' | 'slot' | 'accessory';

/**
 * Which symbol a part is drawn with, and what decided it.
 *
 * The order was always: what EPLAN says the part is, then whether it reads as
 * an accessory of the device above it, then the part's own description, then
 * the slot it was filed under. A symbol picked by hand in the template now
 * comes before all of that — someone who has chosen is not guessing.
 *
 * The single line and the template screen both go through here, so the symbol
 * previewed beside a part is the symbol the drawing puts on the line.
 */
export function symbolForPart(
  part: any,
  slot: string,
  symbols?: EplanSymbolMap,
): { id: SymbolId; from: SymbolSource; eplan?: EplanSymbolInfo } {
  const eplan = lookupSymbol(part, symbols);
  const chosen = String(part?.symbolId ?? '').trim();
  if (chosen && IEC_SYMBOLS[chosen as SymbolId]) {
    return { id: chosen as SymbolId, from: 'chosen', eplan };
  }

  const fromFunction = kindFromFunction(eplan?.functionDefinition);
  if (fromFunction) return { id: fromFunction, from: 'eplan', eplan };

  const described = partDescription(part);
  // The accessory test comes before the description: "auxiliary switch for
  // circuit breaker" is an accessory of the breaker, not a second breaker.
  if (ACCESSORY.test(`${eplan?.functionDefinition ?? ''} ${described}`)) {
    return { id: 'accessory', from: 'accessory', eplan };
  }

  const fromDescription = kindFromFunction(described);
  if (fromDescription) return { id: fromDescription, from: 'description', eplan };

  return { id: SLOT_SYMBOL[slot] ?? 'accessory', from: 'slot', eplan };
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
  return chainOfTemplate(template, order, page, symbols);
}

/**
 * The devices a template holds, in the order a cell is drawn.
 *
 * Split out of `chainFor` so a template can be drawn on its own — beside the
 * parts as they are entered — with the very same reading of it that the sheet
 * uses. Nothing about the reading changed in the splitting.
 */
function chainOfTemplate(
  template: TemplateLike | undefined,
  order: string[],
  page: number,
  symbols?: EplanSymbolMap,
): ChainItem[] {
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
    const { id, eplan } = symbolForPart(primary, slot, symbols);

    const label = stripLocaleTags(primary?.label) || SLOT_LETTER[slot] || 'A';
    counters[label] = (counters[label] ?? 0) + 1;
    const tag = `-${label}${page}${counters[label] > 1 ? `.${counters[label]}` : ''}`;

    // **An accessory is not a device on the branch.**
    //
    // Nothing could say what this part is — not the symbol somebody chose for
    // it, not EPLAN, not its description, not the slot it sits in — so the
    // drawing fell back to the `accessory` symbol, which is an empty dashed
    // square on the conductor. That is the software writing "I do not know
    // what this is" into the middle of a customer's drawing, and this office's
    // templates have two such slots on every feeder: sixteen empty boxes on an
    // eight-way board, in the place a reader looks for devices.
    //
    // A slot's own rule already says where the parts that are not the device
    // go — written beside a device rather than drawn as one. These are written
    // against the **first** device on the branch, which is its principal one:
    // earthing tools and a power connector belong to the unit the breaker is
    // in, not to whichever slot happened to be read last. Attaching them to
    // the last one put the earthing tools against the current transformer,
    // which is a different claim and a wrong one.
    //
    // The tag comes with them, so nothing the sheet used to say is lost — it
    // is said in the place that is true.
    //
    // Unless there is no device yet, because this slot is the first thing on
    // the branch. Then it is drawn, since a feeder that starts with nothing
    // is worse than one that starts with a box.
    if (id === 'accessory' && out.length > 0) {
      out[0].accessories.push(
        ...inSlot.map(part => [tag, formatPartEntry(part)].filter(Boolean).join(' ')));
      continue;
    }

    out.push({
      id,
      tag,
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

/**
 * A device, wrapped so the sheet remembers what it is.
 *
 * The sheet goes out as SVG and comes back as geometry (`cad/fromSvg`), and
 * without these three attributes that round trip threw away everything except
 * the lines. A breaker became eleven lines near each other: it could not be
 * picked as one object, and — the part that actually hurt — it could not be
 * *found* again. Redrawing the disconnector in the symbol library searched
 * every sheet in the project, matched nothing, and said so, while the old
 * disconnector sat on all of them. "It does not get replaced and it does not
 * get fixed" is exactly this, and no amount of redrawing could have fixed it.
 *
 * The block id is built from the symbol and the point it is drawn at. That is
 * unique on a sheet — two devices cannot occupy one place — and it is stable,
 * because the same project laid out again puts the same device at the same
 * coordinate. A counter would have been unique and not stable, and an
 * unstable id means the edits kept against one sheet stop matching the next
 * time it is drawn.
 */
function symbolBlock(id: SymbolId, x: number, y: number): string {
  return `data-block="d.${esc(id)}.${Math.round(x * 10)}.${Math.round(y * 10)}" `
    + `data-symbol="${esc(id)}" `
    + `data-name="${esc(IEC_SYMBOLS[id]?.title ?? id)}"`;
}

/** A library symbol drawn on the sheet, as one object the sheet remembers. */
function drawBlock(id: SymbolId, x: number, y: number): string {
  return `<g ${symbolBlock(id, x, y)}>${drawIecSymbol(id, x, y)}</g>`;
}

// A device is drawn with the symbol exported from EPLAN when the pack has one,
// and with the library's IEC symbol otherwise.
function drawDevice(item: ChainItem, x: number, y: number): string {
  const url = item.eplan?.packUrl;
  const open = `<g ${symbolBlock(item.id, x, y)}>`;
  if (url) {
    const { w, h, dx } = overrideBox({
      url,
      width: item.eplan?.packWidth,
      height: item.eplan?.packHeight,
      pinX: item.eplan?.packPinX,
    });
    return `${open}<line x1="${x}" y1="${y}" x2="${x}" y2="${y + CELL}" stroke="#111" stroke-width="0.8"/>` +
      `<image href="${esc(url)}" x="${x + dx}" y="${y}" width="${w}" height="${h}" ` +
      `preserveAspectRatio="xMidYMid meet"><title>${esc(item.eplan?.symbol || '')}</title></image></g>`;
  }
  return `${open}${drawIecSymbol(item.id, x, y)}</g>`;
}

// Where the text beside a device starts: clear of a symbol exported from
// EPLAN (they are drawn 36 wide) or of the library symbol's own box.
function labelOffset(item: ChainItem): number {
  if (item.eplan?.packUrl) {
    const { w, dx } = overrideBox({
      url: item.eplan.packUrl,
      width: item.eplan.packWidth, height: item.eplan.packHeight, pinX: item.eplan.packPinX,
    });
    return Math.max(24, w + dx + 6);
  }
  return symbolRight(item.id) + 6;
}

// ── The block of text beside a device ───────────────────────────────────────
//
// Where each line of it sits, relative to the top of the device's cell. These
// are stated once because two pieces of code need them and they must agree:
// `deviceText` writes the lines, and `stepFor` decides how far down the branch
// the next device goes. When they disagreed — the spacing said 26 + 9 a line
// and the markup wrote the first accessory at 35 — the last line of one
// device's text sat exactly on the next device's symbol. Two crowded rows a
// feeder, on every feeder, which is the sort of thing that reads as sloppiness
// long before anybody can say what is wrong with it.
const TEXT = {
  /** The tag, below the top of the cell. Less when the cell is fed midway. */
  top: 14,
  topWhenFed: 2,
  /** The part code, under the tag. */
  code: 11,
  /** The first accessory line, and the step between them. */
  firstAccessory: 21,
  accessoryStep: 9,
  /** Clear of the bottom line, before the next device may start. */
  gap: 6,
};

/** How tall the text beside a device is, from the top of its cell. */
function textRoom(item: ChainItem): number {
  const lines = Math.min(item.accessories.length, 3);
  const last = lines === 0
    ? TEXT.code
    : TEXT.firstAccessory + (lines - 1) * TEXT.accessoryStep;
  return TEXT.top + last + TEXT.gap;
}

// How much room a device needs down the line: its own cell, and enough for the
// accessory lines written beside it, so one device's text never runs into the
// next device's tag.
function stepFor(item: ChainItem): number {
  return Math.max(symbolHeight(item.id), CELL, textRoom(item));
}

// ── The order of a cell, and what hangs off it ──────────────────────────────
//
// An MV cell is drawn in one order, the order the office draws it in:
//
//   1. the main switch      — the disconnector, the vacuum breaker (fixed or
//                             withdrawable), or the vacuum contactor with its
//                             fuse
//   2. the earth switch     — beside the line, down to earth, interlocked with
//                             the magnet under it
//   3. the current transformer, in series with the switch — one secondary out
//      of it per core, into the test block
//   4. the capacitive voltage divider, beside the line to earth
//   5. the surge arrester, beside the line to earth
//   6. the core-balance CT, in series, out to the relay
//
// and the secondary side of it: the CT and the core-balance CT both come out
// through the test block (XD) into the protection relay, and the alarm window
// hangs on the relay.
//
// So every device on a feeder is one of three things, and the drawing keeps
// them apart:
//
//   series      the current runs through it — it sits on the line
//   shunt       it works between the line and earth — it sits beside the line
//               with the earth under it
//   instrument  it works off a transformer — it sits in the secondary column
//               to the right, on the connection from what feeds it

// The place a device takes in the power path, whatever order the template
// filed it under.
const POWER_RANK: Partial<Record<SymbolId, number>> = {
  'bus-duct': 4, incoming: 4, ats: 8,
  disconnector: 10, 'switch-disconnector': 12, 'withdrawable-cb': 18,
  vcb: 20, 'vcb-racking': 20, 'circuit-breaker': 22, mcb: 24,
  'vacuum-contactor-fuse': 26, 'hrc-fuse': 28, fuse: 28, 'switch-fuse': 28,
  contactor: 30, 'motor-starter': 31, 'thermal-overload': 34,
  drive: 36, 'soft-starter': 36, 'key-interlock': 42, 'mechanical-interlock': 42,
  accessory: 44, link: 44,
  'current-transformer': 50, 'voltage-transformer': 52, transformer: 54,
  'core-balance-ct': 70, capacitor: 74, 'capacitor-delta': 74,
};
const powerRank = (id: SymbolId) => POWER_RANK[id] ?? 45;

// The devices that work between the line and earth: they hang beside the line
// with the earth under them, never in the power path.
const SHUNT_RANK: Partial<Record<SymbolId, number>> = {
  'earthing-switch': 40, magnet: 41,
  'capacitive-divider': 60, 'surge-arrester': 65, 'surge-limiter': 66,
};
const isShunt = (id: SymbolId) => SHUNT_RANK[id] != null;

// The order the instruments hang down the secondary column: the test block
// first — everything reaches the relay through it — then the current
// instruments, the relays, the voltage instruments, and the alarm window on
// the end of the relay.
const INSTRUMENT_RANK: Partial<Record<SymbolId, number>> = {
  'test-block': 0,
  ammeter: 1, 'ampere-selector': 2, multimeter: 3, 'watt-meter': 4, 'var-meter': 5,
  'power-factor-meter': 6, 'kwh-meter': 7, 'kvarh-meter': 8, transducer: 9,
  'protection-relay': 11, 'earth-fault-relay': 12,
  voltmeter: 13, 'voltage-selector': 14, 'frequency-meter': 15, 'hour-meter': 16,
  'alarm-annunciator': 17, lamp: 18, ptc: 19, lcs: 20,
};
const isInstrument = (id: SymbolId) => INSTRUMENT_RANK[id] != null;

/** How many cores a transformer has: `300/5A x3`, `3 core`, `3C`. */
export function coreCount(item: ChainItem): number {
  const text_ = `${item.code} ${item.accessories.join(' ')}`;
  const m = /x\s*([1-9])\b/i.exec(text_) ?? /\b([1-9])\s*(?:core|c)\b/i.exec(text_);
  return m ? Number(m[1]) : 1;
}

interface Branch {
  /** The devices the current runs through, in order down the line. */
  series: ChainItem[];
  /** The devices between the line and earth, beside it. */
  shunts: ChainItem[];
  /** For each shunt, the series device it hangs below (an index into
   *  `series`), or -1 for the top of the branch. */
  shuntAfter: number[];
  /** The instruments in the secondary column, in the order they hang down. */
  instruments: ChainItem[];
  /** For each instrument, the series device that feeds it (an index into
   *  `series`), or null when nothing on this line does — control wiring, drawn
   *  as the legend draws it, with a dashed link. */
  fedBy: (number | null)[];
  /** A second transformer the instrument also works off: the core-balance CT
   *  comes into the test block beside the CT, so both reach the relay through
   *  it — and where there is no test block, straight into the relay. */
  alsoFed: (number | null)[];
}

function splitBranch(chain: ChainItem[]): Branch {
  // The power path, in the order a cell is drawn rather than the order the
  // template filed its slots.
  const series = chain.filter(i => !isInstrument(i.id) && !isShunt(i.id))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => powerRank(a.item.id) - powerRank(b.item.id) || a.index - b.index)
    .map(e => e.item);

  const shunts = chain.filter(i => isShunt(i.id))
    .sort((a, b) => (SHUNT_RANK[a.id] ?? 99) - (SHUNT_RANK[b.id] ?? 99));
  // A shunt hangs below the last device in the path it comes after.
  const shuntAfter = shunts.map(s => {
    const rank = SHUNT_RANK[s.id] ?? 99;
    let after = -1;
    series.forEach((item, index) => { if (powerRank(item.id) <= rank) after = index; });
    return after;
  });

  const instruments = chain.filter(i => isInstrument(i.id))
    .sort((a, b) => (INSTRUMENT_RANK[a.id] ?? 99) - (INSTRUMENT_RANK[b.id] ?? 99));

  const at = (id: SymbolId) => series.findIndex(s => s.id === id);
  const ct = at('current-transformer');
  const cbct = at('core-balance-ct');
  const vt = at('voltage-transformer');
  const any = [ct, cbct, vt].find(n => n >= 0) ?? -1;
  const xd = instruments.findIndex(i => i.id === 'test-block');

  const fedBy = instruments.map(item => {
    let source: number;
    // With a test block on the feeder everything reaches the relay through it,
    // so the whole column hangs on the one connection out of the CT.
    if (xd >= 0) source = ct >= 0 ? ct : (cbct >= 0 ? cbct : vt);
    else if (item.id === 'earth-fault-relay') source = cbct >= 0 ? cbct : ct;
    else if (item.id === 'voltmeter' || item.id === 'voltage-selector' || item.id === 'frequency-meter')
      source = vt >= 0 ? vt : ct;
    else source = ct >= 0 ? ct : (cbct >= 0 ? cbct : vt);
    if (source < 0) source = any;
    return source >= 0 ? source : null;
  });

  // The core-balance CT's own connection: into the test block when there is
  // one — that is how it reaches the relay — and into the relay when there is
  // not.
  const link = xd >= 0 ? xd : instruments.findIndex(i => i.id === 'protection-relay');
  const alsoFed = instruments.map((_, k) =>
    k === link && cbct >= 0 && fedBy[k] !== cbct ? cbct : null);

  return { series, shunts, shuntAfter, instruments, fedBy, alsoFed };
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
  /** Where each shunt sits beside the line. */
  shuntYs: number[];
  groups: InstrumentGroup[];
  /** The lowest point anything on the branch reaches. */
  bottom: number;
}

// A shunt needs its own cell and the earth under it.
const SHUNT_STEP = CELL + 16;

function layoutBranch(branch: Branch, top: number): BranchLayout {
  // The path and the shunts are laid out together, walking down the cell: a
  // shunt takes its own place on the line, between the device it comes after
  // and the one that follows, so the order down the drawing is the order of
  // the cell — switch, earth switch, CT, divider, arrester, core balance.
  const ys: number[] = [];
  const shuntYs: number[] = new Array(branch.shunts.length).fill(top);
  const step = (item: ChainItem) => (item.id === 'magnet' ? CELL + 4 : SHUNT_STEP);
  let y = top;

  const placeShunts = (after: number) => {
    branch.shunts.forEach((item, k) => {
      if (branch.shuntAfter[k] !== after) return;
      shuntYs[k] = y;
      y += step(item);
    });
  };

  placeShunts(-1);
  branch.series.forEach((item, index) => {
    ys.push(y);
    y += stepFor(item);
    placeShunts(index);
  });
  const seriesBottom = y;

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
    const start = Math.max(cursor, source == null ? top : ys[source]);
    groups.push({ source, items, ys: items.map((_, k) => start + k * CELL) });
    cursor = start + items.length * CELL;
  }

  return {
    ys, seriesBottom, shuntYs, groups,
    bottom: Math.max(seriesBottom, cursor),
  };
}

/** How tall a branch is: the power path, or whatever hangs beside it. */
const branchHeight = (b: Branch) => layoutBranch(b, 0).bottom;

// How far the shunts and the instruments stand from the line: far enough that
// the tags and codes written beside the devices never reach them.
const SHUNT_DX = 56;
const INSTR_DX = 120;

const line = (x1: number, y1: number, x2: number, y2: number, w = 1.3, dash = '') =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#111" stroke-width="${w}"${
    dash ? ` stroke-dasharray="${dash}"` : ''}/>`;

/** The earth under a shunt. */
const earth = (x: number, y: number) => [
  line(x, y - 6, x, y),
  line(x - 7, y, x + 7, y, 1.5),
  line(x - 4.5, y + 3, x + 4.5, y + 3, 1.2),
  line(x - 2, y + 6, x + 2, y + 6, 1.2),
].join('');

// The tag in black and the part code in blue, with the accessories under them:
// the office writes the codes in colour beside the symbol, and it keeps the
// two apart at a glance.
function deviceText(item: ChainItem, tx: number, y: number, codeChars = 17, anchor = 'start'): string {
  const a = anchor === 'start' ? '' : ` text-anchor="${anchor}"`;
  const out = [
    `<text x="${tx}" y="${y}" font-size="9" font-weight="600" fill="#111"${a}>${esc(item.tag)}</text>`,
    `<text x="${tx}" y="${y + TEXT.code}" font-size="8.5" fill="#1d4ed8"${a}><title>${esc(item.code)}</title>${
      esc(clip(item.code, codeChars))}</text>`,
  ];
  const line = (n: number) => y + TEXT.firstAccessory + n * TEXT.accessoryStep;
  item.accessories.slice(0, 2).forEach((ac, ai) => {
    out.push(`<text x="${tx}" y="${line(ai)}" font-size="7.5" fill="#6b7280"${a}><title>${
      esc(ac)}</title>+ ${esc(clip(ac, codeChars))}</text>`);
  });
  if (item.accessories.length > 2) {
    out.push(`<text x="${tx}" y="${line(2)}" font-size="7.5" fill="#6b7280"${a}>+ ${
      item.accessories.length - 2} more</text>`);
  }
  return out.join('');
}

/**
 * One branch: the power path down the line with its devices, the shunts
 * beside it down to earth, and the instruments in the secondary column, each
 * joined to what feeds it.
 *
 * Returns the drawing and the y the power path leaves at, so the caller can
 * run the line on to the load.
 */
function drawBranch(branch: Branch, x: number, top: number): { svg: string; bottom: number } {
  const out: string[] = [];
  const ix = x + INSTR_DX;
  const sx = x - SHUNT_DX;
  const { ys, seriesBottom, shuntYs, groups } = layoutBranch(branch, top);

  // A device whose connection leaves at the middle of its cell has its own
  // text written above it, so the connection never runs through the text.
  const feeds = new Set<number>();
  for (const g of groups) if (g.source != null) feeds.add(g.source);
  branch.alsoFed.forEach(s => { if (s != null) feeds.add(s); });
  // With no transformer on the line, control wiring leaves from the first
  // device, so that one's text moves up too.
  const controlFrom = groups.some(g => g.source == null) && branch.series.length > 0 ? 0 : null;
  if (controlFrom != null) feeds.add(controlFrom);

  // Where the text beside this branch starts.
  //
  // One column for the whole branch, set by the widest symbol on it. It used
  // to be a flat 40 units from the conductor whatever was drawn there, and
  // most of these symbols reach 16: the labels floated in the gap, nearer the
  // next feeder than their own device, which is exactly how a reader comes to
  // attribute a rating to the wrong branch. Hugging each symbol separately
  // would be worse again — a ragged column of text down a schematic reads as
  // carelessness. So: as close as the widest symbol allows, and level.
  const labelX = x + Math.max(
    24, ...branch.series.map(item => labelOffset(item)));

  // The power path: the line first, so the white boxes of the symbols sit on
  // top of it.
  if (branch.series.length > 0) out.push(line(x, top, x, seriesBottom));
  branch.series.forEach((item, index) => {
    out.push(drawDevice(item, x, ys[index]));
    out.push(deviceText(
      item, labelX, ys[index] + (feeds.has(index) ? TEXT.topWhenFed : TEXT.top), 15));
  });

  // The shunts: beside the line, down to earth. The magnet is the exception —
  // it is what the earth switch is interlocked with, so it hangs under the
  // earth switch on the dashed link instead of on an earth of its own.
  branch.shunts.forEach((item, k) => {
    const y = shuntYs[k];
    if (item.id === 'magnet' && k > 0 && branch.shunts[k - 1].id === 'earthing-switch') {
      out.push(line(sx, shuntYs[k - 1] + CELL, sx, y, 1, '4 3'));
    } else {
      out.push(line(sx, y, x, y, 1.2));
      out.push(`<circle cx="${x}" cy="${y}" r="2.4" fill="#111"/>`);
    }
    out.push(drawDevice(item, sx, y));
    if (item.id !== 'magnet' && item.id !== 'earthing-switch') out.push(earth(sx, y + CELL + 8));
    out.push(deviceText(item, sx - 24, y + 14, 11, 'end'));
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
    out.push(secondary(x, ty, ix, group.source == null ? null : branch.series[group.source]));

    group.items.forEach((k, n) => {
      const item = branch.instruments[k];
      out.push(drawDevice(item, ix, group.ys[n]));
      out.push(deviceText(item, ix + Math.max(34, labelOffset(item)), group.ys[n] + 17, 14));

      // The second transformer feeding this instrument — the core-balance CT
      // into the test block — comes in on its own elbow beside the column, so
      // the two connections stay apart and each one is followed by eye.
      const also = branch.alsoFed[k];
      if (also != null) {
        const ay = ys[also] + CELL / 2;
        const my = group.ys[n] + CELL - 8;
        const ex = ix - 12;
        out.push(secondary(x, ay, ex, branch.series[also]));
        out.push(line(ex, ay, ex, my, 1.1));
        out.push(line(ex, my, ix, my, 1.1));
        out.push(`<circle cx="${ix}" cy="${my}" r="2.4" fill="#111"/>`);
      }
    });
  }

  return { svg: out.join('\n'), bottom: seriesBottom };
}

/**
 * A transformer's secondary out to the column: one line per core, because the
 * cell needs one output per core of the CT — and a dashed control line where
 * no transformer feeds the instrument at all.
 */
function secondary(x: number, y: number, to: number, source: ChainItem | null): string {
  if (!source) return line(x + 8, y, to, y, 1, '4 3');
  const cores = Math.min(coreCount(source), 4);
  const out: string[] = [];
  for (let c = 0; c < cores; c++) {
    const cy = y + (c - (cores - 1) / 2) * 3.4;
    out.push(line(x + 8, cy, to, cy, 1));
  }
  out.push(`<circle cx="${to}" cy="${y}" r="2.4" fill="#111"/>`);
  return out.join('');
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
    shunts: supplyAll.shunts.slice(0, 2),
    shuntAfter: supplyAll.shuntAfter.slice(0, 2).map(a => (a < 3 ? a : -1)),
    instruments: supplyAll.instruments.slice(0, 3),
    fedBy: supplyAll.fedBy.slice(0, 3).map(s => (s != null && s < 3 ? s : null)),
    alsoFed: supplyAll.alsoFed.slice(0, 3).map(s => (s != null && s < 3 ? s : null)),
  };

  // A feeder with instruments beside it needs the room for them; one without
  // stays narrow, so a board of plain feeders still fits the sheet.
  const all = [...branches, ...(supplyBranch ? [supplyBranch] : [])];
  const wide = all.some(b => b.instruments.length > 0);
  const hasShunt = all.some(b => b.shunts.length > 0);
  // A cell with something beside the line needs the room for it: the shunts
  // stand to the left of the line with their tags, the instruments to the
  // right with theirs.
  // A symbol from the pack can reach out to the left — a breaker drawn with
  // its racking does — so the line is set far enough in for the widest of them.
  const reach = Math.max(...all.flatMap(b =>
    [...b.series, ...b.instruments].map(i => symbolLeft(i.id))), 16);
  const branchDx = Math.max(hasShunt ? 130 : 34, reach + 10);
  const colWidth = Math.max(200, hasShunt || wide ? branchDx + INSTR_DX + 104 : 0);

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
    out.push(drawBlock('incoming', supplyX, 92));
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
    out.push(drawBlock(isMotorLoad(line_) ? 'motor' : 'outgoing', x, loadY));
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

/**
 * One template drawn on its own — the whole of it, as a cell.
 *
 * The same reading the sheet gives a feeder: the devices that carry power in
 * series down the line, in the order a cell is drawn rather than the order the
 * template filed its slots; the instruments hanging off it in parallel, each
 * group starting level with the transformer that feeds it; and the shunts —
 * arresters, dividers — beside the line with the earth under them. It goes
 * through `splitBranch` and `drawBranch`, which is to say it is not a second
 * opinion about how a template is drawn but the same one.
 *
 * The stubs at the top and the bottom stand for the busbar it will hang from
 * and whatever it will feed; on a sheet those come from the feeder around it.
 */
export function buildTemplateSvg(
  template: TemplateLike | undefined,
  tier: 'LV' | 'MV' | 'HV',
  symbols?: EplanSymbolMap,
): { svg: string; width: number; height: number; devices: number } {
  const { margin } = GEOM;
  const order = propertyOrder(tier);
  const chain = chainOfTemplate(template, order, 1, symbols);
  const branch = splitBranch(chain);

  // Room for whatever reaches out sideways, the same way a sheet works out how
  // wide a column has to be.
  const reach = Math.max(16, ...[...branch.series, ...branch.instruments].map(i => symbolLeft(i.id)));
  const branchDx = Math.max(branch.shunts.length > 0 ? 130 : 34, reach + 10);
  const x = margin + branchDx;
  const stub = 26;
  const top = 34 + stub;

  const drawn = drawBranch(branch, x, top);
  const width = x + INSTR_DX + 104 + margin;
  const bottom = Math.max(drawn.bottom, top);
  const height = bottom + stub + 34;

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}" font-family="Segoe UI, Arial, sans-serif">`);
  out.push(`<rect width="${width}" height="${height}" fill="#fff"/>`);

  out.push(`<text x="${margin}" y="22" font-size="12" font-weight="700" fill="#111">${
    esc(stripLocaleTags(template?.name) || 'Template')}</text>`);
  out.push(`<text x="${width - margin}" y="22" font-size="9" text-anchor="end" fill="#666">${
    esc(`${tier} · ${branch.series.length} in series · ${branch.instruments.length} instrument(s)`
      + (branch.shunts.length ? ` · ${branch.shunts.length} to earth` : ''))}</text>`);

  if (chain.length === 0) {
    out.push(`<text x="${margin}" y="${top + 20}" font-size="11" fill="#888">` +
      `No parts in this template yet.</text>`);
    out.push('</svg>');
    return { svg: out.join('\n'), width, height, devices: 0 };
  }

  // Where it hangs from, and what it feeds.
  out.push(line(x, top - stub, x, top, 1.3));
  out.push(`<path d="M ${x - 6} ${top - stub + 11} L ${x} ${top - stub} L ${x + 6} ${top - stub + 11} Z" fill="#111"/>`);
  out.push(`<text x="${x + 10}" y="${top - stub + 9}" font-size="8.5" fill="#666">from the busbar</text>`);

  out.push(drawn.svg);

  out.push(line(x, bottom, x, bottom + stub, 1.3));
  out.push(`<path d="M ${x - 6} ${bottom + stub - 11} L ${x} ${bottom + stub} L ${x + 6} ${bottom + stub - 11} Z" fill="#111"/>`);
  out.push(`<text x="${x + 10}" y="${bottom + stub - 2}" font-size="8.5" fill="#666">to the load</text>`);

  out.push('</svg>');
  return { svg: out.join('\n'), width, height, devices: chain.length };
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
<h1 style="font-size:16px;margin-bottom:4px">IEC single-line symbols</h1>
<p style="font-size:11px;color:#555;margin-bottom:10px">The symbols this app draws on a single line. A symbol exported from EPLAN into the symbol pack replaces the one here.</p>
${buildSymbolCatalogueSvg()}
</body></html>`;
}
