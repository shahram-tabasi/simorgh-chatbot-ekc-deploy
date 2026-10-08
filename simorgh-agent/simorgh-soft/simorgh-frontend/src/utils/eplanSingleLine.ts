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
import {
  ProjectData, Equipment, TemplateItem, DeviceTableRow,
  TemplateSingleLine, TemplateMechanical, DeviceAttachment, CtCore, PartSingleLine,
} from '../types/project';
import {
  templateParts, formatPartEntry, stripLocaleTags, getEplanixValue,
  LV_TEMPLATE_PROPERTIES, MV_TEMPLATE_PROPERTIES,
} from './tierEquipmentMatrix';
import {
  CELL, HALF, SymbolId, drawIecSymbol, symbolRight, symbolLeft, symbolHeight,
  overrideBox, buildSymbolCatalogueSvg, IEC_SYMBOLS, symbolOverride, symbolTerminals, OFFICE_PREFIX,
} from './iecSymbols';
import { type Tier, LAYOUT_OF } from './tiers';
import { partCode } from './eplanDataExport';

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

// The letter a device takes when its part carries none and its row is not
// one of the standard ones — a renamed spare: "magnet" is MB, not A.
const KIND_LETTER: Partial<Record<string, string>> = {
  magnet: 'MB', 'earthing-switch': 'QC', 'capacitive-divider': 'PV', 'surge-arrester': 'FA',
  'surge-limiter': 'FA', 'test-block': 'XD', 'current-transformer': 'B', 'core-balance-ct': 'B',
  'voltage-transformer': 'T', 'protection-relay': 'F', 'earth-fault-relay': 'F',
  'mechanical-interlock': 'M.I', 'key-interlock': 'KI', vcb: 'Q', 'vacuum-contactor-fuse': 'Q',
  'circuit-breaker': 'Q', disconnector: 'Q', ammeter: 'P', voltmeter: 'P', multimeter: 'P',
  'kwh-meter': 'P', transducer: 'P', 'alarm-annunciator': 'H', lamp: 'H', 'hrc-fuse': 'F',
};

const propertyOrder = (tier: Tier) =>
  LAYOUT_OF[tier] === 'MV' ? MV_TEMPLATE_PROPERTIES : LV_TEMPLATE_PROPERTIES;

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
  [/capacitive.?(voltage.?)?divider|voltage.?divider|capacitive.?(voltage.?)?(indicator|detect)|voltage.?detect|\bcapdis\b|\bvoie\b|\bwega\b/i, 'capacitive-divider'],
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
  /** Where it is filed — an MV path starts with its switchgear family. */
  hierarchy?: { path?: string[] };
  /** The answers the single line is drawn with; see `TemplateSingleLine`. */
  singleLine?: TemplateSingleLine;
  /** The earth switch and the magnet are answered here too. */
  mechanical?: TemplateMechanical;
  /** Drawn in Simorgh Draw — an LV template is then drawn by the cell's rules. */
  useSimorghDraw?: boolean;
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
/**
 * Symbols that only exist on medium voltage, and what they are on low.
 *
 * A vacuum circuit breaker is drawn with the withdrawable isolating contacts
 * of a medium-voltage cell — two filled bars with their contact arcs, above
 * and below the blade. On a low-voltage board that device does not exist, and
 * at sheet scale those filled bars are the heaviest mark on the drawing: a
 * board whose every feeder was resolved to one is a column of black blocks
 * where the switchgear should be. It is also simply wrong, which is the part
 * that matters when the drawing is issued.
 *
 * The automatic reading is what gets constrained here, because the automatic
 * reading is what goes wrong: a part described "1250A VCB panel" on an LV
 * board matches `vcb` on its description and nothing downstream questions it.
 * A symbol an engineer picked by hand is left exactly as picked — they were
 * looking at the device and the software was not.
 */
const LV_INSTEAD: Partial<Record<SymbolId, SymbolId>> = {
  vcb: 'circuit-breaker',
  'vcb-racking': 'withdrawable-cb',
  'vacuum-contactor-fuse': 'contactor',
  // The medium-voltage voltage indicator is a capacitive divider; on LV the
  // indication is a lamp.
  'capacitive-divider': 'lamp',
  // A limiter is the medium-voltage form of the same protection.
  'surge-limiter': 'surge-arrester',
};

/** The symbol as this tier draws it. */
const forTier = (id: SymbolId, tier?: Tier): SymbolId =>
  (tier && LAYOUT_OF[tier] === 'LV' ? LV_INSTEAD[id] ?? id : id);

/**
 * On a medium-voltage template the row a part is filed in says what it is.
 *
 * The office fills these rows by what the device is: the CT under CT RATING,
 * the detector under VOLTAGE INDICATOR. Reading the part's own wording first
 * turned a two-core CT ("ADB36S, Core 1: 400-200/1A, CL.5P20…") into a
 * capacitive divider and the detector into a lamp, and with no CT on the
 * cell its relay, its test block and its cores all went with it.
 */
const MV_ROW_IS: Record<string, SymbolId> = {
  'CT RATING': 'current-transformer',
  'COREBALANCE CT': 'core-balance-ct',
  'PT RATING': 'voltage-transformer',
  'PROTECTION RELAY': 'protection-relay',
  'VOLTAGE INDICATOR': 'capacitive-divider',
  'SURGE ARRESTER': 'surge-arrester',
  'TEST BLOCK': 'test-block',
};

/**
 * In a row that does not say — a spare, an accessory — the office's own
 * device letters do: QC the earth switch, MB the magnet, PV the detector,
 * FA the arrester, XD the test block, M.I the interlock, B the CT.
 */
function mvFromLabel(label: string, described: string): SymbolId | null {
  const l = label.toUpperCase().replace(/\s+/g, '');
  if (/^QC\d*/.test(l)) return 'earthing-switch';
  if (/^MB\d*/.test(l)) return 'magnet';
  if (/^PV\d*/.test(l)) return 'capacitive-divider';
  if (/^FA\d*/.test(l)) return 'surge-arrester';
  if (/^XD\d*/.test(l)) return 'test-block';
  if (/^M\.?I\b/.test(l)) return 'mechanical-interlock';
  if (/^B\d/.test(l)) {
    const k = kindFromFunction(described);
    if (k === 'core-balance-ct' || k === 'voltage-transformer') return k;
    if (/\bRCT\b|\bID\s*>=|ring.?type|window/i.test(described)) return 'core-balance-ct';
    return 'current-transformer';
  }
  return null;
}

export function symbolForPart(
  part: any,
  slot: string,
  symbols?: EplanSymbolMap,
  tier?: Tier,
  /** The row's own name when it was renamed in the template. */
  rowName?: string,
): { id: SymbolId; from: SymbolSource; eplan?: EplanSymbolInfo } {
  const eplan = lookupSymbol(part, symbols);
  const chosen = String(part?.symbolId ?? '').trim();
  if (chosen && IEC_SYMBOLS[chosen as SymbolId]) {
    return { id: chosen as SymbolId, from: 'chosen', eplan };
  }

  const mv = Boolean(tier && LAYOUT_OF[tier] === 'MV');
  if (mv && MV_ROW_IS[slot]) return { id: MV_ROW_IS[slot], from: 'slot', eplan };
  // A row renamed for what it holds — "magnet", "Earth switch", "multimeter".
  const named = String(rowName ?? '').trim();
  if (mv && named && named.toUpperCase() !== slot.toUpperCase()) {
    const byRow = MV_ROW_IS[named.toUpperCase()] ?? kindFromFunction(named);
    if (byRow) return { id: byRow, from: 'slot', eplan };
  }
  if (mv) {
    const byLabel = mvFromLabel(stripLocaleTags(part?.label), partDescription(part));
    if (byLabel) return { id: byLabel, from: 'description', eplan };
  }

  const fromFunction = kindFromFunction(eplan?.functionDefinition);
  if (fromFunction) return { id: forTier(fromFunction, tier), from: 'eplan', eplan };

  const described = partDescription(part);
  // The accessory test comes before the description: "auxiliary switch for
  // circuit breaker" is an accessory of the breaker, not a second breaker.
  if (ACCESSORY.test(`${eplan?.functionDefinition ?? ''} ${described}`)) {
    return { id: 'accessory', from: 'accessory', eplan };
  }

  const fromDescription = kindFromFunction(described);
  if (fromDescription) return { id: forTier(fromDescription, tier), from: 'description', eplan };

  return { id: forTier(SLOT_SYMBOL[slot] ?? 'accessory', tier), from: 'slot', eplan };
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
export interface ChainItem {
  id: SymbolId;
  tag: string;
  /** The device's own letter — Q, F, T — with no number after it. */
  label: string;
  /** The part's SIM-TABLE value, as Create Template shows it. The sheet
   *  writes `label : SIM-TABLE` beside the device and nothing else. */
  simTable: string;
  code: string;
  slot: string;
  /** The rest of the parts in this slot — written, not drawn. */
  accessories: string[];
  /** The SIM-TABLE of each accessory, written under the device's own. */
  accessoryCodes: string[];
  /** Its symbol was picked by hand in the template, not worked out. */
  chosen?: boolean;
  /** On the line or beside it, when the part's window said so. */
  placement?: 'series' | 'parallel';
  /** A relay: the main one the CTs go into, or an auxiliary one. */
  relayRole?: 'main' | 'auxiliary';
  /** An auxiliary relay: wired to the breaker, the main relay, or both. */
  relayConnect?: 'breaker' | 'relay' | 'both';
  /** A relay's functions, written in its box. */
  functions?: string;
  /** A relay's serial link, and its text. */
  serialLink?: boolean;
  serialText?: string;
  /** Status signals out of a relay or a breaker. */
  statuses?: string[];
  /** A CT's cores, top to bottom, as its window or its SIM-TABLE says. */
  cores?: CtCore[];
  /** One of the office's new symbols it is drawn with, by id. */
  drawAs?: string;
  /** Everything its window answered, for what the drawing reads directly. */
  sld?: PartSingleLine;
  /** Lines written under it that are not SIM-TABLE — an LV breaker's poles
   *  and trip unit. */
  info?: string[];
  /** The part, as the template knows it: `slot#index`. */
  key?: string;
  /** The device the part above it became — what "series" and "parallel"
   *  in its window are measured against. */
  anchor?: ChainItem;
  eplan?: EplanSymbolInfo;
}

/**
 * What a device is drawn with: the office's new symbol its window chose, or
 * the drawing of its kind. Its kind (`id`) still decides how it is connected;
 * this decides what it looks like and where its points are.
 */
const dk = (item: ChainItem): SymbolId =>
  (item.drawAs ? `${OFFICE_PREFIX}${item.drawAs}` : item.id) as SymbolId;

function chainFor(
  line: DeviceTableRow,
  templates: Map<string, TemplateItem>,
  order: string[],
  page: number,
  symbols?: EplanSymbolMap,
  tier?: Tier,
): ChainItem[] {
  const template = line.templateId ? templates.get(line.templateId) : undefined;
  return chainOfTemplate(template, order, page, symbols, tier);
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
  tier?: Tier,
): ChainItem[] {
  const parts = template ? templateParts(template) : {};
  const slots = [
    ...order.filter(p => parts[p]?.length),
    ...Object.keys(parts).filter(p => !order.includes(p)),
  ];

  const counters: Record<string, number> = {};
  const out: ChainItem[] = [];
  // A row renamed in the template ("magnet", "Earth switch") says what its
  // parts are as plainly as the office's standard rows do.
  const rowNames: Record<string, string> = (template?.properties as any)?.__displayNames ?? {};

  for (const slot of slots) {
    const inSlot = parts[slot];
    // The device of a row is its first part. Each part after it is an
    // accessory of the device above it — its SIM-TABLE written under that
    // device's — unless its window says it is a device of its own, which
    // then takes its own place in series or in parallel. Unanswered, a later
    // part is an accessory, which is how a row was always read.
    let host: ChainItem | undefined;
    inSlot.forEach((part: any, k: number) => {
      const sld = part?.sld ?? {};
      const accessory = k > 0 ? sld.role !== 'main' : sld.role === 'accessory';
      const hostOf = host ?? out[out.length - 1];
      if (accessory && hostOf) {
        hostOf.accessories.push(formatPartEntry(part));
        const code = partCode(part);
        if (code) hostOf.accessoryCodes.push(code);
        return;
      }

      const { id, eplan, from } = symbolForPart(part, slot, symbols, tier, rowNames[slot]);
      const label = stripLocaleTags(part?.label) || SLOT_LETTER[slot] || KIND_LETTER[id] || 'A';
      counters[label] = (counters[label] ?? 0) + 1;
      const tag = `-${label}${page}${counters[label] > 1 ? `.${counters[label]}` : ''}`;

      // **An accessory is not a device on the branch.**
      //
      // Nothing could say what this part is — not the symbol somebody chose
      // for it, not EPLAN, not its description, not the slot it sits in — so
      // the drawing fell back to the `accessory` symbol, an empty dashed
      // square on the conductor: the software writing "I do not know what
      // this is" into a customer's drawing. Such a part is written against
      // the **first** device on the branch, its principal one — earthing
      // tools and a power connector belong to the unit the breaker is in —
      // tag and all, so nothing the sheet used to say is lost. Unless there
      // is no device yet; then it is drawn, since a feeder that starts with
      // nothing is worse than one that starts with a box. A part somebody
      // said is a device of its own is drawn whatever it reads as.
      if (id === 'accessory' && out.length > 0 && sld.role !== 'main') {
        out[0].accessories.push([tag, formatPartEntry(part)].filter(Boolean).join(' '));
        const code = partCode(part);
        if (code) out[0].accessoryCodes.push(code);
        return;
      }

      const item: ChainItem = {
        id,
        tag,
        label,
        simTable: partCode(part),
        code: formatPartEntry(part),
        slot,
        accessories: [],
        accessoryCodes: [],
        eplan,
        chosen: from === 'chosen',
        placement: sld.placement,
        relayRole: sld.relayRole,
        relayConnect: sld.relayConnect,
        functions: sld.functions,
        serialLink: sld.serialLink,
        serialText: sld.serialText,
        statuses: sld.statuses,
        cores: sld.cores,
        drawAs: sld.drawing,
        sld,
        key: `${slot}#${k}`,
        anchor: out[out.length - 1],
      };
      // An LV main switch's poles and trip unit, written under it.
      if (sld.poles || sld.protection) item.info = [[sld.poles, sld.protection].filter(Boolean).join(' · ')];
      out.push(item);
      host = item;
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
  // On an MV board only a feeder cell can be the supply. A coupling, a riser,
  // an incoming VT cell match the old wording test ("coupl", "incom") but are
  // cells on the bus like any other — taken as the supply, the coupling was
  // drawn above the busbar and every other such cell vanished from the sheet.
  const mvNotSupply = (l: DeviceTableRow) => {
    if (LAYOUT_OF[equipment.type] !== 'MV') return false;
    const t = l.templateId ? templates.get(l.templateId) : undefined;
    const { cellType } = mvCellType(t);
    return Boolean(cellType) && !/^feeder/i.test(cellType);
  };
  const incomers = all.filter(l => isIncomer(l) && !mvNotSupply(l));
  const outgoing = all.filter(l => !isIncomer(l) || mvNotSupply(l));
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
/**
 * EPLAN's picture of a part, unless the symbol has been drawn here.
 *
 * A symbol redrawn for the project, or the office's own from the pack, is
 * what the office decided the device looks like; EPLAN's exported picture of
 * one part is only what EPLAN happens to hold. It used to win — the office
 * redrew its breaker with its three connection points and the sheet went on
 * placing EPLAN's picture, with none.
 */
const packUrlOf = (item: ChainItem): string | undefined =>
  (symbolOverride(dk(item))?.art ? undefined : item.eplan?.packUrl);

function drawDevice(item: ChainItem, x: number, y: number): string {
  const url = packUrlOf(item);
  const open = `<g ${symbolBlock(dk(item), x, y)}>`;
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
  return `${open}${drawIecSymbol(dk(item), x, y)}</g>`;
}

// Where the text beside a device starts: clear of a symbol exported from
// EPLAN (they are drawn 36 wide) or of the library symbol's own box.
function labelOffset(item: ChainItem): number {
  if (packUrlOf(item) && item.eplan?.packUrl) {
    const { w, dx } = overrideBox({
      url: item.eplan.packUrl,
      width: item.eplan.packWidth, height: item.eplan.packHeight, pinX: item.eplan.packPinX,
    });
    return Math.max(24, w + dx + 6);
  }
  return symbolRight(dk(item)) + 6;
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
  /**
   * How big the writing is, against the cell a symbol is drawn in.
   *
   * A drawing office sizes its lettering against the symbols, not against the
   * sheet: on an A3 single line the symbols come out about 10 mm and the
   * device tags about 3 mm, so a tag is a bit over a quarter of a cell. These
   * were 9 against a 40-unit cell — under a quarter — and on a sheet three
   * times wider than it is tall that reads as a row of marks with captions too
   * small to be meant for reading. A quarter of a cell for the tag, a shade
   * under for the code, less again for the accessories: the same order a
   * reader expects, at a size they can hold.
   */
  tag: 10.5,
  codeSize: 9,
  accessorySize: 8,
  /** The tag, below the top of the cell. Less when the cell is fed midway. */
  top: 14,
  topWhenFed: 2,
  /** The part code, under the tag. */
  code: 12,
  /** The first accessory line, and the step between them. */
  firstAccessory: 23,
  accessoryStep: 10,
  /** Clear of the bottom line, before the next device may start. */
  gap: 6,
};

/**
 * How wide a run of text comes out, near enough to lay a sheet out by.
 *
 * Half the type size a character is close enough for a sans face at these
 * sizes, and the only thing it is used for is leaving room — a column set from
 * a guess that is a little generous is right, and one set from no guess at all
 * is the flat 200 units this sheet used to use whatever was written on it.
 */
const textWidth = (chars: number, size: number): number => chars * size * 0.52;

/** How much of a part code is written beside a device before it is cut. */
const CODE_CHARS = 15;

/** How tall the text beside a device is, from the top of its cell. */
function textRoom(item: ChainItem): number {
  // The label, broken onto lines, and the accessories' SIM-TABLE under it.
  return TEXT.top + (labelLineCount(item, LV_WRAP) - 1) * TEXT.tag * 1.15 + TEXT.gap;
}

// How much room a device needs down the line: its own cell, and enough for the
// accessory lines written beside it, so one device's text never runs into the
// next device's tag.
function stepFor(item: ChainItem): number {
  return Math.max(symbolHeight(dk(item)), CELL, textRoom(item));
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
  // A part's window can say on the line or beside it; unanswered, its kind
  // decides, as it always did.
  const instrumentHere = (i: ChainItem) => i.placement !== 'series' && isInstrument(i.id);
  const shuntHere = (i: ChainItem) =>
    (i.placement === 'parallel' ? !isInstrument(i.id) : i.placement === 'series' ? false : isShunt(i.id));
  const series = chain.filter(i => !instrumentHere(i) && !shuntHere(i))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => powerRank(a.item.id) - powerRank(b.item.id) || a.index - b.index)
    .map(e => e.item);

  const shunts = chain.filter(shuntHere)
    .sort((a, b) => (SHUNT_RANK[a.id] ?? 99) - (SHUNT_RANK[b.id] ?? 99));
  // A shunt hangs below the last device in the path it comes after.
  const shuntAfter = shunts.map(s => {
    const rank = SHUNT_RANK[s.id] ?? 99;
    let after = -1;
    series.forEach((item, index) => { if (powerRank(item.id) <= rank) after = index; });
    return after;
  });

  const instruments = chain.filter(instrumentHere)
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

/**
 * While an MV cell is drawn, every connecting line is recorded rather than
 * written, so that once the whole cell is laid out the crossings can be found
 * and each horizontal line bridged over the vertical it crosses — the
 * drafting convention for two wires that cross without joining. A junction
 * (a line ending on another) is not a crossing and gets its dot as before.
 */
interface Seg { x1: number; y1: number; x2: number; y2: number; w: number; dash: string }
let SEGS: Seg[] | null = null;

const rawLine = (x1: number, y1: number, x2: number, y2: number, w: number, dash: string) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#111" stroke-width="${w}"${
    dash ? ` stroke-dasharray="${dash}"` : ''}/>`;

const line = (x1: number, y1: number, x2: number, y2: number, w = 1.3, dash = ''): string => {
  if (!SEGS) return rawLine(x1, y1, x2, y2, w, dash);
  SEGS.push({ x1, y1, x2, y2, w, dash });
  return `<!--seg:${SEGS.length - 1}-->`;
};

/** The recorded lines written out, each horizontal one bridging the
 *  verticals it crosses. */
function writeSegs(svg: string, segs: Seg[]): string {
  const HOP = 3.2;
  const verticals = segs.filter(v => v.x1 === v.x2 && v.y1 !== v.y2);
  const render = (sg: Seg): string => {
    if (sg.y1 !== sg.y2 || sg.x1 === sg.x2) return rawLine(sg.x1, sg.y1, sg.x2, sg.y2, sg.w, sg.dash);
    const y = sg.y1;
    const a = Math.min(sg.x1, sg.x2);
    const b = Math.max(sg.x1, sg.x2);
    const hops = [...new Set(verticals
      .filter(v => v.x1 > a + HOP + 0.5 && v.x1 < b - HOP - 0.5
        && Math.min(v.y1, v.y2) < y - 1 && Math.max(v.y1, v.y2) > y + 1)
      .map(v => v.x1))].sort((p, q) => p - q);
    if (hops.length === 0) return rawLine(sg.x1, sg.y1, sg.x2, sg.y2, sg.w, sg.dash);
    let d = `M ${a} ${y}`;
    let last = a - HOP * 3;
    for (const hx of hops) {
      if (hx - last < HOP * 2.2) continue;
      d += ` L ${hx - HOP} ${y} A ${HOP} ${HOP} 0 0 1 ${hx + HOP} ${y}`;
      last = hx;
    }
    d += ` L ${b} ${y}`;
    return `<path d="${d}" fill="none" stroke="#111" stroke-width="${sg.w}"${
      sg.dash ? ` stroke-dasharray="${sg.dash}"` : ''}/>`;
  };
  return svg.replace(/<!--seg:(\d+)-->/g, (_, k) => render(segs[Number(k)]));
}

/** The earth under a shunt. */
const earth = (x: number, y: number) => [
  line(x, y - 6, x, y),
  line(x - 7, y, x + 7, y, 1.5),
  line(x - 4.5, y + 3, x + 4.5, y + 3, 1.2),
  line(x - 2, y + 6, x + 2, y + 6, 1.2),
].join('');

// What is written beside a device: its label, a colon, and the part's
// SIM-TABLE value — the code Create Template shows for it. Nothing else, and
// no number after the label. The numbered tag, the full part entry and the
// accessories it used to write out are kept as the text's tooltip, so nothing
// that was known about the device is lost.

/** `Q : 3AH5…` — or the label alone when the part has no SIM-TABLE yet. */
const labelText = (item: ChainItem) =>
  (item.simTable ? `${item.label} : ${item.simTable}` : item.label);

/**
 * A label broken onto lines of about `wrap` characters, at its commas.
 *
 * A SIM-TABLE value can be a whole specification — "ADB36S , Core 1:
 * 400-200/1A , CL.5P20 , 30VA , Core 2: …" — and written on one line it ran
 * across the relay, the cores and the next cell.
 */
function labelLines(text_: string, wrap: number): string[] {
  if (!wrap || text_.length <= wrap) return [text_];
  // At the commas first; a piece still too long breaks between words.
  const lines: string[] = [];
  let cur = '';
  // At the commas, and before every "Core 2:" — each core of a CT on its
  // own line.
  const pieces = text_.split(/\s*,\s*|\s+(?=core\s*\d+\s*:)/i).filter(Boolean);
  pieces.forEach((piece, k) => {
    const comma = k < pieces.length - 1 ? ',' : '';
    // A word longer than the line — an order code — breaks after a dash.
    const words = `${piece}${comma}`.split(/\s+/).filter(Boolean)
      .flatMap(w => (w.length > wrap ? w.split(/(?<=-)/) : [w]))
      // A colon on its own belongs to the word before it: "Transformer :".
      .reduce<string[]>((acc, w) => {
        if (w === ':' && acc.length) acc[acc.length - 1] += ' :'; else acc.push(w);
        return acc;
      }, []);
    let chunk = '';
    const chunks: string[] = [];
    for (const w of words) {
      const next = chunk ? (chunk.endsWith('-') ? `${chunk}${w}` : `${chunk} ${w}`) : w;
      if (next.length > wrap && chunk) { chunks.push(chunk); chunk = w; } else chunk = next;
    }
    if (chunk) chunks.push(chunk);
    for (const c of chunks) {
      const next = cur ? (cur.endsWith('-') ? `${cur}${c}` : `${cur} ${c}`) : c;
      if (next.length > wrap && cur) { lines.push(cur); cur = c; } else cur = next;
    }
  });
  if (cur) lines.push(cur);
  // Never leave a short label — "Q :" — alone on a line: it stays with what
  // it labels. A long one ("MV Current Transformer :") may end its line.
  for (let k = 0; k < lines.length - 1; k++) {
    if (/:\s*$/.test(lines[k]) && lines[k].length <= 6) {
      lines.splice(k, 2, `${lines[k]} ${lines[k + 1]}`);
    }
  }
  return lines;
}

/** Where an LV label is broken. */
const LV_WRAP = 30;

/**
 * Every line written beside a device: its own `label : SIM-TABLE`, broken,
 * then each accessory's SIM-TABLE on lines of its own under it.
 */
function allLines(item: ChainItem, wrap: number): { text: string; accessory: boolean; sim: boolean }[] {
  return [
    ...labelLines(labelText(item), wrap).map((text, n) => ({ text, accessory: false, sim: n > 0 })),
    ...item.accessoryCodes.flatMap(c => labelLines(c, wrap).map(text => ({ text, accessory: true, sim: true }))),
    ...(item.info ?? []).map(text => ({ text, accessory: true, sim: false })),
  ];
}

/** How many lines a device's label takes, accessories included. */
const labelLineCount = (item: ChainItem, wrap: number) => allLines(item, wrap).length;

/** A label broken the way the drawing breaks it — for a screen that shows
 *  what will be written. */
export const breakLabel = (text_: string, wrap = 26): string[] => labelLines(text_, wrap);

/** How wide a wrapped label comes out. */
const labelWidth = (item: ChainItem, size: number, wrap = 0) =>
  Math.max(...allLines(item, wrap).map(l => l.text.length)) * size * 0.56;

function simLabel(
  item: ChainItem, tx: number, y: number, anchor = 'start', size: number = TEXT.tag, wrap = 0,
): string {
  const a = anchor === 'start' ? '' : ` text-anchor="${anchor}"`;
  const about = [item.tag, item.code, ...item.accessories].filter(Boolean).join(' · ');
  const lines = allLines(item, wrap);
  // The SIM-TABLE is on a layer of its own, so a sheet can go out with the
  // designations alone: the first line is the letter, then its SIM-TABLE.
  const tag = item.simTable ? `${item.label} : ` : '';
  const sim = ' data-layer="SIMTABLE"';
  // How wide a piece of text comes out, character by character (a semibold
  // sans: capitals wide, digits and lower case less, punctuation narrow).
  const w = (t: string) => [...t].reduce((sum, c) => sum + size * (
    /[A-Z]/.test(c) ? 0.68 : /[0-9]/.test(c) ? 0.56 : /[a-z]/.test(c) ? 0.53
      : /[ .,:;/|'()-]/.test(c) ? 0.3 : 0.6), 0);
  const first = (t: string) => {
    if (!tag || !t.startsWith(tag)) return `<tspan x="${tx}" dy="0">${esc(t)}</tspan>`;
    // The letter alone, and the colon with the SIM-TABLE — hidden, the
    // SIM-TABLE leaves the designation as it is written without one.
    const head = item.label;
    const rest = t.slice(head.length).trimStart();
    // A fixed gap between the two, so an estimate short of the real width
    // never runs the code into the letter.
    const gap = size * 0.4;
    const total = w(head) + gap + w(rest);
    const left = anchor === 'start' ? tx : anchor === 'end' ? tx - total : tx - total / 2;
    const at = (l: number, width: number) => (anchor === 'start' ? l : anchor === 'end' ? l + width : l + width / 2);
    return `<tspan x="${at(left, w(head))}" dy="0">${esc(head)}</tspan>` +
      `<tspan x="${at(left + w(head) + gap, w(rest))}" dy="0"${sim}>${esc(rest)}</tspan>`;
  };
  // An accessory's SIM-TABLE is written lighter than the device's own, so
  // the two read as one device and what came with it.
  const body = lines.map((l, n) => (n === 0
    ? first(l.text)
    : `<tspan x="${tx}" dy="${size * 1.15}"${l.accessory ? ' font-weight="400"' : ''}${l.sim ? sim : ''}>${esc(l.text)}</tspan>`)).join('');
  return `<text x="${tx}" y="${y}" font-size="${size}" font-weight="600" fill="#111"${a}>` +
    `${about ? `<title>${esc(about)}</title>` : ''}${body}</text>`;
}

function deviceText(item: ChainItem, tx: number, y: number, _codeChars = 17, anchor = 'start'): string {
  return simLabel(item, tx, y, anchor, TEXT.tag, LV_WRAP);
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
  // Between the devices, never through them: a line under the whole branch
  // joined every breaker's terminals past its open blade.
  if (branch.series.length > 0) {
    let cursor = top;
    branch.series.forEach((item, index) => {
      const p1 = pinOf(dk(item), x, ys[index], '1');
      const p2 = pinOf(dk(item), x, ys[index], '2');
      if (p1.y > cursor) out.push(line(x, cursor, x, p1.y));
      cursor = Math.max(cursor, p2.y);
    });
    if (seriesBottom > cursor) out.push(line(x, cursor, x, seriesBottom));
  }
  branch.series.forEach((item, index) => {
    out.push(drawDevice(item, x, ys[index]));
    out.push(deviceText(
      item, labelX, ys[index] + (feeds.has(index) ? TEXT.topWhenFed : TEXT.top), CODE_CHARS));
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

// ── A medium-voltage cell, as the office draws one ──────────────────────────
//
// The LV branch above is a column of devices with instruments hanging off the
// side. An MV cell is drawn the way the panel is built (Siemens' own component
// tables, the EK36 and SIMOPRIME sheets), and it is drawn as a set of
// connections between named points rather than as a column:
//
//   on the line      the switch — a vacuum breaker, or a vacuum contactor with
//                    its fuses — then the CT and the rest of the power path
//   the switch's 3   → the mechanical interlock's 1
//   interlock's 2    → the earth switch's 2
//   earth switch 1   → the line, after the switch symbol
//   earth switch 3   → the magnet's 1
//   magnet's 2       → OUTGOING FEEDER, written on the line
//
// EK36 puts the earth switch straight after the switch and the CT after it;
// every other cell has the CT first, then the earth switch and the capacitive
// voltage detector. The CT's cores go out one each to what they are for — the
// protection core into the relay, the measuring core into the meters, a
// remark core to an arrow with its text — and what hangs on the breaker and
// the relay (serial, link, status) is strung along a key interlock line.
//
// The connection points are the symbol's own when it has been drawn with them
// (named 1, 2, 3 on the symbol page); the library's drawings get the points
// below, which sit where those connections are on its ink.

/** Which family a template belongs to, from the head of its path. */
export function mvFamily(template?: TemplateLike): 'EK36' | 'SIMOPRIME' | '' {
  const head = String(template?.hierarchy?.path?.[0] ?? '').toUpperCase();
  if (head === 'EK36') return 'EK36';
  if (head.startsWith('SIMOPRIME')) return 'SIMOPRIME';
  return '';
}

/** The cell type and its sub-type (w VT / With Fuse) from the path, with
 *  the family at its head stepped over. */
export function mvCellType(template?: TemplateLike): { cellType: string; sub: string } {
  const full = (template?.hierarchy?.path ?? []).map(p => String(p ?? '').trim());
  const path = mvFamily(template) ? full.slice(1) : full;
  return { cellType: path[0] ?? '', sub: path[1] ?? '' };
}

export interface MvCellOptions {
  answers?: TemplateSingleLine;
  mechanical?: TemplateMechanical;
  family?: 'EK36' | 'SIMOPRIME' | '';
  /** Feeder Truck, Coupling Wda, Metering Riser… — what kind of panel. */
  cellType?: string;
  /** w VT / wo VT, With Fuse / Without Fuse. */
  sub?: string;
  /** An LV feeder drawn by the cell's rules: its breaker stays the breaker
   *  it is, not the MV catalogue's vacuum breaker. */
  lv?: boolean;
}

export const mvOptionsOf = (template?: TemplateLike): MvCellOptions => ({
  answers: template?.singleLine,
  mechanical: template?.mechanical,
  family: mvFamily(template),
  ...mvCellType(template),
});

/**
 * How a cell's line ends at the bottom of the sheet.
 *
 *   outgoing   the arrow to the load (a feeder, a disconnector link)
 *   coupling   the bus sectionalizer's breaker: its line turns across to the
 *              riser beside it (a bar connection) — the sheet joins them
 *   riser      the riser: up from that bar connection into the next section
 *   cable      a bus cable connection: a cable sealing end, out
 *   cable-in   the incoming VT cell: the cable comes in from below
 *   bar        an adaptor: the copper bar on to another panel
 *   busduct    a busduct
 *   capacitor  a capacitor bank
 *   none       the line ends at its last device (metering, neutral)
 */
export type MvEnd =
  | 'outgoing' | 'coupling' | 'riser' | 'cable' | 'cable-in' | 'bar' | 'busduct' | 'capacitor' | 'none';

/** What kind of panel a cell type is, as far as the drawing cares. */
function cellKind(cellType = '', sub = '') {
  const t = cellType.toLowerCase();
  const s = sub.toLowerCase();
  const withVt = /\bw vt\b/.test(s) || /^metering|incoming vt/.test(t);
  if (/^coupling/.test(t)) return { end: 'coupling' as MvEnd, withVt: false, switchDefault: 'vcb' as SymbolId };
  if (t === 'riser' || t === 'metering riser') return { end: 'riser' as MvEnd, withVt: t === 'metering riser' };
  if (/riser connection/.test(t)) return { end: 'cable' as MvEnd, withVt: /^metering/.test(t) };
  if (t === 'incoming vt cell') return { end: 'cable-in' as MvEnd, withVt: true };
  if (t === 'metering') return { end: 'none' as MvEnd, withVt: true, vtIsLoad: true };
  if (t === 'adaptor') return { end: 'bar' as MvEnd, withVt: false };
  if (t === 'busduct') return { end: 'busduct' as MvEnd, withVt: false };
  if (t === 'dummy') return { end: 'none' as MvEnd, withVt: false, dummy: true };
  if (t === 'cap bank') return { end: 'capacitor' as MvEnd, withVt: false, switchDefault: 'vcb' as SymbolId };
  if (t === 'neutral panel') return { end: 'none' as MvEnd, withVt: false, neutral: true };
  if (t === 'disconnector link') {
    return { end: 'outgoing' as MvEnd, withVt: false, switchDefault: 'disconnector' as SymbolId,
      fuse: /with fuse/.test(s) && !/without/.test(s) };
  }
  // Feeder Truck / Feeder Wda, and anything not filed by cell type yet.
  return { end: 'outgoing' as MvEnd, withVt, switchDefault: t.startsWith('feeder') ? 'vcb' as SymbolId : undefined };
}

/** Which single-line questions a cell type is asked — only the ones its
 *  drawing has a place for. */
export function mvAsks(cellType = '', sub = '') {
  const k = cellKind(cellType, sub);
  const t = cellType.toLowerCase();
  const switched = k.end === 'outgoing' || k.end === 'coupling' || k.end === 'capacitor' || !cellType;
  const secondary = !k.dummy && k.end !== 'bar' && k.end !== 'busduct';
  return {
    nothing: Boolean(k.dummy),
    switchType: switched && t !== 'disconnector link',
    interlocks: switched,
    ctCores: secondary,
    relay: secondary,
    breakerAttachments: switched,
    vt: Boolean(k.withVt) || /feeder|^$/.test(t),
    ptTruck: /feeder|^$/.test(t),
    otherSection: k.end === 'coupling',
    connectedTo: ['cable', 'cable-in', 'bar', 'busduct'].includes(k.end),
    connectedToHint: k.end === 'cable-in' ? 'INCOMING CABLE' : k.end === 'cable' ? 'BUS CABLE CONNECTION'
      : k.end === 'bar' ? 'BAR CONNECTION TO ANOTHER PANEL' : 'BUSDUCT',
    neutral: Boolean(k.neutral),
  };
}

/** Where a cell's line ends, so the sheet can finish it. */
export const mvEndOf = (opts: MvCellOptions): MvEnd => cellKind(opts.cellType, opts.sub).end;
/** A dummy cell and the neutral panel are not hung on the busbar. */
export const mvOffBus = (opts: MvCellOptions): boolean => {
  const k = cellKind(opts.cellType, opts.sub);
  return Boolean(k.dummy || k.neutral);
};

/**
 * A device's serial link and statuses as its window gives them, each with
 * the way its arrow points at the foot of the cell (up: a signal coming in).
 */
export function signalList(item: { serialLink?: boolean; serialText?: string; statuses?: string[]; sld?: PartSingleLine }):
  { text: string; up: boolean }[] {
  const dirs = item.sld?.statusDirs ?? [];
  return [
    ...(item.serialLink ? [{ text: String(item.serialText ?? '').trim() || 'SERIAL LINK', up: item.sld?.serialDir === 'up' }] : []),
    ...(item.statuses ?? []).map((t, k) => ({ text: t.trim(), up: dirs[k] === 'up' })).filter(sg => sg.text),
  ];
}

/** Every current transformer: labelled on its left, its cores to the right. */
const CT_IDS: SymbolId[] = ['current-transformer', 'core-balance-ct'];

const SWITCH_IDS: SymbolId[] = [
  'vcb', 'vcb-racking', 'withdrawable-cb', 'vacuum-contactor-fuse',
  'circuit-breaker', 'contactor', 'disconnector', 'switch-disconnector',
];
const METER_IDS: SymbolId[] = [
  'ammeter', 'ampere-selector', 'multimeter', 'watt-meter', 'var-meter',
  'power-factor-meter', 'kwh-meter', 'kvarh-meter', 'transducer',
];
const VOLTAGE_IDS: SymbolId[] = ['voltmeter', 'voltage-selector', 'frequency-meter'];
const LEFT_SHUNTS: SymbolId[] = ['capacitive-divider', 'surge-arrester', 'surge-limiter'];

type Pt = { x: number; y: number };

/**
 * The library's own connection points that are not the two ends of the line.
 * Offsets from where the symbol is drawn.
 */
const LIBRARY_PINS: Partial<Record<SymbolId, Record<string, Pt>>> = {
  // The switch's operating side, beside the blade.
  vcb: { 3: { x: -8, y: 19 } },
  'vcb-racking': { 3: { x: -8, y: 19 } },
  'withdrawable-cb': { 3: { x: -8, y: 19 } },
  'vacuum-contactor-fuse': { 3: { x: -6, y: 28 } },
  'circuit-breaker': { 3: { x: -4, y: 20 } },
  contactor: { 3: { x: -4, y: 20 } },
  disconnector: { 3: { x: -4, y: 20 } },
  'switch-disconnector': { 3: { x: -4, y: 20 } },
  // The earth switch: 1 its contact to the line, 2 the blade's middle — where
  // the interlock works it — and 3 near the pivot, out to the magnet.
  'earthing-switch': { 1: { x: 10, y: 2 }, 2: { x: 5, y: 9 }, 3: { x: 2, y: 13 } },
  // Drawn across: 1 on the right, 2 on the left.
  'mechanical-interlock': { 1: { x: 18, y: HALF }, 2: { x: -18, y: HALF } },
  magnet: { 1: { x: 0, y: 0 }, 2: { x: 0, y: CELL } },
};

/** Where a named connection point of a device drawn at (x, y) is. */
function pinOf(id: SymbolId, x: number, y: number, name: string): Pt {
  const o = symbolOverride(id);
  if (o?.art && o.terminals?.length) {
    const t = symbolTerminals(id, x, y).find(p => p.name === name);
    if (t) return { x: t.x, y: t.y };
  }
  const own = LIBRARY_PINS[id]?.[name];
  if (own) return { x: x + own.x, y: y + own.y };
  return name === '2' ? { x, y: y + symbolHeight(id) } : { x, y };
}

/** Which way the wire leaves a connection point: the symbol's own say when
 *  it was drawn with one, the library's otherwise. */
const LIBRARY_DIRS: Partial<Record<SymbolId, Record<string, string>>> = {
  'mechanical-interlock': { 1: 'right', 2: 'left' },
  'earthing-switch': { 1: 'right', 2: 'right', 3: 'left' },
  magnet: { 1: 'up', 2: 'down' },
};
function pinDirOf(id: SymbolId, name: string): string | undefined {
  const o = symbolOverride(id);
  if (o?.art && o.terminals?.length) {
    const t = o.terminals.find(p => p.name === name);
    if (t) return t.dir;
  }
  return LIBRARY_DIRS[id]?.[name];
}
const isUpright = (dir?: string) => dir === 'up' || dir === 'down';

const dashed = (pts: Pt[], w = 1) => (SEGS
  ? pts.slice(1).map((p, i) => line(pts[i].x, pts[i].y, p.x, p.y, w, '4 3')).join('')
  : `<polyline points="${pts.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="#111" ` +
    `stroke-width="${w}" stroke-dasharray="4 3"/>`);
const solidPath = (pts: Pt[], w = 1.1) => (SEGS
  ? pts.slice(1).map((p, i) => line(pts[i].x, pts[i].y, p.x, p.y, w)).join('')
  : `<polyline points="${pts.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="#111" stroke-width="${w}"/>`);
const node = (p: Pt) => `<circle cx="${p.x}" cy="${p.y}" r="2.2" fill="#111"/>`;
const arrowRight = (x: number, y: number) =>
  `<path d="M ${x - 7} ${y - 3.5} L ${x} ${y} L ${x - 7} ${y + 3.5} Z" fill="#111"/>`;
const arrowDown = (x: number, y: number) =>
  `<path d="M ${x - 3.5} ${y - 7} L ${x} ${y} L ${x + 3.5} ${y - 7} Z" fill="#111"/>`;
/** A signal's arrow at the foot of the cell pointing back up: one coming in. */
const arrowUp = (x: number, y: number) =>
  `<path d="M ${x - 3.5} ${y} L ${x} ${y - 7} L ${x + 3.5} ${y} Z" fill="#111"/>`;

const ATTACHMENT_TEXT: Record<DeviceAttachment['kind'], string> = {
  serial: 'SERIAL', link: 'LINK', status: 'STATUS', other: '',
};
const attachmentText = (a: DeviceAttachment) =>
  (String(a.text ?? '').trim() || ATTACHMENT_TEXT[a.kind] || '').toUpperCase();

/**
 * What hangs on a device — 94, CR, 74, 86, serial, link, status — as the
 * office's sheets draw it: small boxes stacked one under the other right
 * beside the device, on a bracket from it. And, when it is interlocked with
 * something upstream, the key on a dashed line under them with what it is
 * interlocked with.
 *
 * Returns the markup and how far right and down it reached.
 */
function keyLine(from: Pt, attachments: DeviceAttachment[], upstream?: string): { svg: string; right: number; bottom: number } {
  const items = attachments.map(attachmentText).filter(Boolean);
  if (items.length === 0 && !upstream) return { svg: '', right: from.x, bottom: from.y };
  const out: string[] = [];
  const bh = 11;
  const bw = Math.max(16, ...items.map(t => t.length * 7 * 0.66 + 6));
  const bracket = from.x + 8;
  const bx = bracket + 5;
  const top = from.y - (items.length * bh) / 2;
  let right = from.x;
  let bottom = from.y;
  if (items.length) {
    out.push(line(from.x, from.y, bracket, from.y, 1));
    out.push(line(bracket, top + bh / 2, bracket, top + (items.length - 0.5) * bh, 1));
    items.forEach((t, n) => {
      const cy = top + n * bh + bh / 2;
      out.push(line(bracket, cy, bx, cy, 1));
      out.push(`<rect x="${bx}" y="${top + n * bh}" width="${bw}" height="${bh}" fill="#fff" stroke="#111" stroke-width="0.9"/>` +
        `<text x="${bx + bw / 2}" y="${cy + 2.6}" font-size="7" text-anchor="middle" fill="#111">${esc(t)}</text>`);
    });
    right = bx + bw;
    bottom = top + items.length * bh;
  }
  if (upstream) {
    const ky = bottom + 8;
    const kx = bx + 6;
    out.push(dashed([{ x: from.x, y: items.length ? from.y : ky }, { x: bracket, y: items.length ? from.y : ky },
      { x: bracket, y: ky }, { x: kx - 4, y: ky }]));
    out.push(`<g data-symbol="key-interlock" data-name="Key interlock">` +
      `<circle cx="${kx}" cy="${ky}" r="3.5" fill="#fff" stroke="#111" stroke-width="1"/>` +
      `<line x1="${kx + 3.5}" y1="${ky}" x2="${kx + 12}" y2="${ky}" stroke="#111" stroke-width="1"/>` +
      `<line x1="${kx + 9}" y1="${ky}" x2="${kx + 9}" y2="${ky + 3.5}" stroke="#111" stroke-width="1"/>` +
      `<line x1="${kx + 12}" y1="${ky}" x2="${kx + 12}" y2="${ky + 3.5}" stroke="#111" stroke-width="1"/></g>`);
    out.push(`<text x="${kx + 16}" y="${ky + 3}" font-size="7.5" fill="#111">${esc(upstream.toUpperCase())}</text>`);
    right = Math.max(right, kx + 16 + upstream.length * 7.5 * 0.66);
    bottom = ky + 5;
  }
  return { svg: out.join(''), right, bottom };
}

/**
 * What a CT's own SIM-TABLE says its cores are for, top to bottom:
 * "Core 1: 400-200/1A, CL.5P20, 30VA, Core 2: 400-200/1A, CL.0.2FS5, 15VA"
 * is a protection core (5P20, 10P10, PX, TPS) and a measuring one (0.2, 0.5,
 * 1, FS). Nothing to go on is no cores — the cell's own answer, or the
 * parts, then decide.
 */
export function coresFromText(text_: string): CtCore[] {
  // Each "Core n:" with what follows it, put in the order of its number —
  // core 1 first, whatever order the text happens to list them in.
  const found: { n: number; piece: string }[] = [];
  const re = /core\s*(\d+)\s*[:=-]/gi;
  const text = String(text_ ?? '');
  const hits = [...text.matchAll(re)];
  hits.forEach((h, k) => {
    const from = (h.index ?? 0) + h[0].length;
    const to = k + 1 < hits.length ? hits[k + 1].index ?? text.length : text.length;
    found.push({ n: Number(h[1]), piece: text.slice(from, to) });
  });
  return found
    .sort((a, b) => a.n - b.n)
    .map(({ piece }) => (
      /\b\d+\s*P\s*\d+|\bP\s*X\b|\bTP[SXYZ]\b|protect/i.test(piece)
        ? { purpose: 'protection' as const }
        : { purpose: 'measurement' as const }));
}

/** A core's number written on its line beside the CT, so the order of the
 *  cores — core 1 the top line — is there to read on the drawing. */
const coreNumber = (x: number, y: number, n: number) =>
  `<text x="${x + 5}" y="${y - 2}" font-size="6.5" fill="#111">${n}</text>`;

/** The cores a CT is drawn with: its own window's, the cell's answer, what
 *  its SIM-TABLE says, or what the parts imply. */
function coresOf(
  answers: TemplateSingleLine | undefined, hasRelay: boolean, hasMeters: boolean, ct?: ChainItem,
): CtCore[] {
  if (ct?.cores?.length) return ct.cores;
  // The CT's own SIM-TABLE says more about its cores than the cell's
  // general answer does.
  const read = ct ? (coresFromText(ct.simTable).length ? coresFromText(ct.simTable) : coresFromText(ct.code)) : [];
  if (read.length) return read;
  if (answers?.ctCores?.length) return answers.ctCores;
  const cores: CtCore[] = [];
  if (hasRelay) cores.push({ purpose: 'protection' });
  if (hasMeters) cores.push({ purpose: 'measurement' });
  return cores;
}

const synth = (id: SymbolId, label: string): ChainItem =>
  ({ id, tag: `-${label}`, label, simTable: '', code: '', slot: '', accessories: [], accessoryCodes: [] });

/**
 * The cell's answers with each part's own laid over them: the breaker's
 * window says its upstream interlock and the boxes beside it, the magnet's
 * its downstream interlock, the VT's its fuses and PT truck. The cell-wide
 * answers a template carried before the parts were asked are still read
 * where a part has said nothing.
 */
function withPartAnswers(cell: TemplateSingleLine, chain: ChainItem[]): TemplateSingleLine {
  const out: TemplateSingleLine = { ...cell };
  const sw = chain.find(i => SWITCH_IDS.includes(i.id))?.sld;
  if (sw?.upstreamInterlock !== undefined) {
    out.upstreamInterlock = sw.upstreamInterlock;
    out.upstreamText = sw.upstreamText;
  }
  if (sw?.upstreamDir) out.upstreamDir = sw.upstreamDir;
  if (sw?.attachments) {
    out.breakerAttachments = sw.attachments.map(t => t.trim()).filter(Boolean)
      .map(text => ({ kind: 'other' as const, text }));
  }
  const mg = chain.find(i => i.id === 'magnet')?.sld;
  if (mg?.downstreamInterlock !== undefined) out.downstreamInterlock = mg.downstreamInterlock;
  if (mg?.downstreamText !== undefined) out.downstreamText = mg.downstreamText;
  if (mg?.downstreamDir) out.downstreamDir = mg.downstreamDir;
  const vt = chain.find(i => i.id === 'voltage-transformer')?.sld;
  if (vt?.vtFuses !== undefined) out.vtFuses = vt.vtFuses;
  if (vt?.ptTruck !== undefined) out.ptTruck = vt.ptTruck;
  return out;
}

/** Geometry the sheet needs to lay columns out round a cell. */
/** How MV labels are written: smaller than LV's, and broken onto lines. */
const MV_LABEL = { size: 9, wrap: 26 };

export const MV_CELL = {
  /** The earth switch and the magnet stand this far left of the line. */
  shuntDx: 140,
  /** The magnet stands this far left of them. */
  magnetDx: 42,
  /** The CT's cores run down lanes starting this far right of the line. */
  laneDx: 140,
  laneStep: 12,
  /** Where the relay and the meters stand. */
  instrDx: 178,
};

/**
 * One MV cell drawn down the line at `x`, from `top`.
 *
 * Returns the markup, where the power path leaves (for the line on to the
 * load), and how far the drawing reaches either side and down, so the sheet
 * can size the column round it.
 */
function drawMvCell(
  chain: ChainItem[], opts: MvCellOptions, x: number, top: number, floorAt?: number,
): { svg: string; bottom: number; reachBottom: number; left: number; right: number } {
  const prev = SEGS;
  const segs: Seg[] = [];
  SEGS = segs;
  try {
    const drawn = drawMvCellLines(chain, opts, x, top, floorAt);
    return { ...drawn, svg: writeSegs(drawn.svg, segs) };
  } finally {
    SEGS = prev;
  }
}

function drawMvCellLines(
  chain: ChainItem[], opts: MvCellOptions, x: number, top: number,
  /** The foot of the cell — level with the arrow its line ends in — where
   *  every signal line (serial link, status, interlock) is run down to. */
  floorAt?: number,
): { svg: string; bottom: number; reachBottom: number; left: number; right: number } {
  const answers = withPartAnswers(opts.answers ?? {}, chain);
  const mech = opts.mechanical ?? {};
  const kind = cellKind(opts.cellType, opts.sub);
  const out: string[] = [];
  let reachBottom = top;
  let left = x - 20;
  let right = x + 20;
  const reach = (px: number, py: number) => {
    left = Math.min(left, px); right = Math.max(right, px); reachBottom = Math.max(reachBottom, py);
  };

  // An empty cell is a box saying so: no line, nothing on the bus.
  if (kind.dummy) {
    out.push(`<rect x="${x - 30}" y="${top}" width="60" height="${CELL * 2}" fill="none" stroke="#111" ` +
      `stroke-width="1" stroke-dasharray="5 3"/>`);
    out.push(`<text x="${x}" y="${top + CELL + 3}" font-size="9" font-weight="600" text-anchor="middle" fill="#111">DUMMY</text>`);
    return { svg: out.join(''), bottom: top + CELL * 2, reachBottom: top + CELL * 2, left: x - 30, right: x + 30 };
  }

  // ── Sort the parts into the cell ──────────────────────────────────────
  const rest = [...chain];
  const take = (pred: (i: ChainItem) => boolean): ChainItem | undefined => {
    const k = rest.findIndex(pred);
    return k >= 0 ? rest.splice(k, 1)[0] : undefined;
  };

  let sw = answers.switchType === 'none' ? undefined : take(i => SWITCH_IDS.includes(i.id));
  if (answers.switchType === 'vcb') sw = { ...(sw ?? synth('vcb', 'Q')), id: 'vcb' };
  if (answers.switchType === 'vc-fuse') sw = { ...(sw ?? synth('vacuum-contactor-fuse', 'Q')), id: 'vacuum-contactor-fuse' };
  // An MV cell's switch is one of the catalogue's: the vacuum breaker or the
  // vacuum contactor with its fuses. The part's wording can read as any
  // breaker — "withdrawable", "truck", "circuit-breaker" — and each of those
  // is a different symbol the office has not redrawn, so the sheet showed a
  // stranger where the office's own V.C.B belongs. A symbol picked by hand
  // stays as picked.
  if (sw && !sw.chosen && !answers.switchType && !opts.lv) {
    if (['vcb-racking', 'withdrawable-cb', 'circuit-breaker', 'mcb'].includes(sw.id)) sw = { ...sw, id: 'vcb' };
    else if (['contactor', 'motor-starter'].includes(sw.id)) sw = { ...sw, id: 'vacuum-contactor-fuse' };
  }
  // A panel that is a switch by what it is — a feeder, a coupling, a link —
  // draws one even before its parts are in.
  if (!sw && answers.switchType !== 'none' && kind.switchDefault) sw = synth(kind.switchDefault, 'Q');
  // A disconnector link is a disconnector: a breaker read from its parts is
  // the parts' wording, not the panel.
  if (sw && kind.switchDefault === 'disconnector' && !answers.switchType) sw = { ...sw, id: 'disconnector' };
  // The fuse-linked panel carries its fuses after the disconnector.
  const linkFuse = kind.fuse ? take(i => i.id === 'hrc-fuse' || i.id === 'fuse') ?? synth('hrc-fuse', 'F') : undefined;

  let es = take(i => i.id === 'earthing-switch');
  if (!es && mech.cableEarthSwitch) es = synth('earthing-switch', 'QC');
  const interlock = take(i => i.id === 'mechanical-interlock');
  let magnet = take(i => i.id === 'magnet');
  if (!magnet && (mech.magnetLabel || answers.downstreamInterlock)) magnet = synth('magnet', 'MB');
  // With no earth switch to hang on, a magnet stands beside the line on its
  // own, as it always has.
  const orphanMagnet = !es && magnet ? magnet : undefined;
  if (orphanMagnet) magnet = undefined;
  take(i => i.id === 'key-interlock');   // drawn as the key on the key line

  const ct = take(i => i.id === 'current-transformer');
  const ptTruck = opts.family === 'SIMOPRIME' && answers.ptTruck === true;
  // The VT: tapped off the line beside the cell — on a socket when the
  // incoming has a PT truck, through its HRC fuses unless answered without.
  // On a metering panel it is the load, at the end of the line.
  const vtPart = take(i => i.id === 'voltage-transformer');
  const vtItem = vtPart ?? (kind.withVt || ptTruck ? synth('voltage-transformer', 'T') : undefined);
  const vtFuse = answers.vtFuses !== false;
  const socketVt = vtItem && !kind.vtIsLoad ? vtItem : undefined;
  const loadVt = vtItem && kind.vtIsLoad ? vtItem : undefined;
  // The neutral panel: from the transformer's star point, through the
  // resistor unless earthed solidly, to earth.
  const ngr = kind.neutral && answers.neutralEarthing !== 'solid'
    ? take(i => i.id === 'resistor') ?? synth('resistor', 'R') : undefined;
  // A part's window can put it on the line (series) or beside it (parallel)
  // whatever kind of device it is; unanswered, its kind decides.
  const besideLine = (i: ChainItem) =>
    (i.placement === 'parallel' ? !isInstrument(i.id) : i.placement === 'series' ? false : LEFT_SHUNTS.includes(i.id));
  // An instrument stays on the secondary side whatever it is answered:
  // series and parallel say how it stands by the part above it there.
  const offLine = (i: ChainItem) => isInstrument(i.id);
  const shunts = [...(orphanMagnet ? [orphanMagnet] : []), ...rest.filter(besideLine)];
  const instruments = rest.filter(offLine);
  const series = rest.filter(i => !besideLine(i) && !offLine(i))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => powerRank(a.item.id) - powerRank(b.item.id) || a.index - b.index)
    .map(e => e.item);

  // ── Down the line ─────────────────────────────────────────────────────
  type Station =
    | { kind: 'series'; item: ChainItem; role?: 'switch' | 'ct' }
    | { kind: 'earth'; item: ChainItem }
    | { kind: 'shunt'; item: ChainItem }
    | { kind: 'socket-vt'; item: ChainItem };
  const stations: Station[] = [];
  if (sw) stations.push({ kind: 'series', item: sw, role: 'switch' });
  if (linkFuse) stations.push({ kind: 'series', item: linkFuse });
  const earthAndDetectors = () => {
    if (es) stations.push({ kind: 'earth', item: es });
    shunts.forEach(item => stations.push({ kind: 'shunt', item }));
  };
  // EK36: the earth switch straight after the switch, the CT after it. Every
  // other cell: the CT first, then the earth switch and the detector.
  if (opts.family === 'EK36') {
    // As the EK36 sheets draw it: the earth switch, the capacitive voltage
    // detector, and the CT always after the detector; then the arrester.
    if (es) stations.push({ kind: 'earth', item: es });
    shunts.filter(i => i.id === 'capacitive-divider').forEach(item => stations.push({ kind: 'shunt', item }));
    if (ct) stations.push({ kind: 'series', item: ct, role: 'ct' });
    shunts.filter(i => i.id !== 'capacitive-divider').forEach(item => stations.push({ kind: 'shunt', item }));
  } else {
    if (ct) stations.push({ kind: 'series', item: ct, role: 'ct' });
    earthAndDetectors();
  }
  series.forEach(item => stations.push({ kind: 'series', item }));
  if (socketVt) stations.push({ kind: 'socket-vt', item: socketVt });
  if (loadVt) {
    if (vtFuse) stations.push({ kind: 'series', item: synth('hrc-fuse', 'F') });
    stations.push({ kind: 'series', item: loadVt });
  }
  if (ngr) stations.push({ kind: 'series', item: ngr });
  // A part whose window answered series or parallel stands by the part above
  // it, when that part is on the line too: in series, straight after it, fed
  // from it; in parallel, tapped off the line just before it, so it is joined
  // where that part is and stands beside it. Unanswered, its kind places it.
  for (const st of [...stations]) {
    const anchor = st.item.anchor;
    if (!st.item.placement || !anchor) continue;
    const from = stations.indexOf(st);
    if (stations.findIndex(o => o.item === anchor) < 0) continue;
    stations.splice(from, 1);
    const at = stations.findIndex(o => o.item === anchor);
    stations.splice(st.item.placement === 'series' ? at + 1 : at, 0, st);
  }

  // How far below the top of the switch its 94 / CR / 74 / 86 and the
  // upstream key reach, so the next device starts clear of them.
  const switchHang = (item: ChainItem) => {
    const n = (answers.breakerAttachments ?? []).map(attachmentText).filter(Boolean).length;
    return symbolHeight(dk(item)) / 2 + n * 5.5 + (answers.upstreamInterlock ? 18 : 0) + 14;
  };
  const sx = x - MV_CELL.shuntDx;
  const labelX = x + Math.max(24, ...[sw, ct, ...series].filter(Boolean)
    .map(i => labelOffset(i as ChainItem)));
  const ys = new Map<ChainItem, number>();
  // The neutral panel's caption stands above its line.
  let y = kind.neutral ? top + 14 : top;
  const lineTop = y;
  let switchY = -1;
  let ctY = -1;
  let esY = -1;
  for (const st of stations) {
    ys.set(st.item, y);
    if (st.kind === 'series') {
      if (st.role === 'switch') switchY = y;
      if (st.role === 'ct') ctY = y;
      y += Math.max(stepFor(st.item), st.role === 'switch' ? CELL + 10 : 0,
        // A long label is broken onto lines; the device keeps room for them.
        12 + labelLineCount(st.item, st.role || CT_IDS.includes(st.item.id) ? 22 : MV_LABEL.wrap) * MV_LABEL.size * 1.15 + 8,
        // Room for what hangs beside the switch, stacked down from its middle.
        st.role === 'switch' ? switchHang(st.item) : 0);
    } else if (st.kind === 'earth') {
      // An interlock drawn upright hangs between the switch's 3 and the
      // earth switch's 2, so the earth switch starts low enough to take it.
      if (sw && switchY >= 0) {
        const il = interlock?.id ?? 'mechanical-interlock';
        if (isUpright(pinDirOf(il, '1'))) {
          const s3y = pinOf(dk(sw), x, switchY, '3').y;
          const span = pinOf(il, 0, 0, '2').y - pinOf(il, 0, 0, '1').y;
          const e2off = pinOf(dk(st.item), 0, 0, '2').y;
          y = Math.max(y, s3y + 10 + Math.abs(span) + 8 - e2off);
          ys.set(st.item, y);
        }
      }
      esY = y;
      y += CELL + 10;
    } else if (st.kind === 'shunt') {
      // Tapped across and down into its top, with the earth under it.
      y += SHUNT_STEP + 12;
    } else {
      y += (ptTruck ? 30 : 8) + (vtFuse ? CELL : 0) + CELL + 14;
    }
  }
  const bottom = Math.max(y, top + CELL);
  const floor = Math.max(floorAt ?? bottom + 26, bottom + 26);

  /**
   * A signal run down to the foot of the cell, as the office's sheets draw
   * them: a dashed line from `fromY` to the floor with its arrow, and its
   * text written along it, on a white ground so the dashes do not cross it.
   */
  // Collected, and drawn last, so every one of them ends on one level: the
  // floor, or lower when the longest text needs it — never each at its own.
  // Each arrow points as its window says: down, a signal going out; up, one
  // coming in.
  const signals: { x: number; fromY: number; name: string; up?: boolean }[] = [];
  const signalDown = (sx_: number, fromY: number, text_: string, up?: boolean) => {
    signals.push({ x: sx_, fromY, name: text_.trim().toUpperCase(), up });
  };
  const arrowAt = (x_: number, y_: number, up?: boolean) => (up ? arrowUp(x_, y_) : arrowDown(x_, y_));
  const textLen = (name: string) => name.length * 7.5 * 0.68;
  const drawSignals = () => {
    if (!signals.length) return;
    const end = Math.max(floor, ...signals.map(sg => sg.fromY + textLen(sg.name) + 24));
    for (const { x: sx_, fromY, name, up } of signals) {
      const tw = textLen(name);
      const mid = (fromY + end) / 2;
      // The line stops either side of its text rather than running under a
      // white patch: the patch is paper, and is not there once the graphic
      // is opened in the editor or sent out as DXF.
      if (name) {
        out.push(dashed([{ x: sx_, y: fromY }, { x: sx_, y: mid - tw / 2 - 3 }]));
        out.push(dashed([{ x: sx_, y: mid + tw / 2 + 3 }, { x: sx_, y: end }]), arrowAt(sx_, end, up));
        out.push(`<g transform="rotate(-90 ${sx_} ${mid})">` +
          `<text x="${sx_}" y="${mid + 2.8}" font-size="7.5" text-anchor="middle" fill="#111">${esc(name)}</text></g>`);
      } else {
        out.push(dashed([{ x: sx_, y: fromY }, { x: sx_, y: end }]), arrowAt(sx_, end, up));
      }
      reach(sx_ - 6, end);
      reach(sx_ + 6, end);
    }
  };
  // **The line is drawn between the devices, never through them.** One line
  // from top to bottom under everything joined the breaker's two terminals
  // past its open blade — the drawing said the breaker was closed. Each
  // device on the line brings its own conductor from its 1 to its 2; the
  // line only fills the gaps.
  {
    let cursor = lineTop;
    for (const st of stations) {
      if (st.kind !== 'series') continue;
      const sy = ys.get(st.item)!;
      const p1 = pinOf(dk(st.item), x, sy, '1');
      const p2 = pinOf(dk(st.item), x, sy, '2');
      if (p1.y > cursor) out.push(line(x, cursor, x, p1.y));
      cursor = Math.max(cursor, p2.y);
    }
    if (bottom > cursor) out.push(line(x, cursor, x, bottom));
  }
  reach(x, bottom);
  if (kind.neutral) {
    // Not on the busbar: it hangs from the transformer's star point and ends
    // in the earth.
    out.push(`<text x="${x + 8}" y="${top + 6}" font-size="8" fill="#111">FROM TRANSFORMER NEUTRAL</text>`);
    out.push(`<path d="M ${x - 4} ${lineTop - 6} L ${x} ${lineTop} L ${x + 4} ${lineTop - 6} Z" fill="#111"/>`);
    out.push(earth(x, bottom + 8));
    reach(x, bottom + 16);
  }

  for (const st of stations) {
    const sy = ys.get(st.item)!;
    if (st.kind === 'series') {
      out.push(drawDevice(st.item, x, sy));
      if (st.role === 'switch' || st.role === 'ct' || CT_IDS.includes(st.item.id)) {
        // The switch and the CT are labelled on their left, as the office's
        // sheets do: their right is where the 94 / CR / 74 / 86 hang and the
        // cores leave. The switch's label climbs up beside its top when it
        // has several lines, so its accessories' SIM-TABLE stays clear of the
        // operating mechanism drawn on its left.
        const lx = x - symbolLeft(dk(st.item)) - 6;
        // Broken shorter than the rest: the interlock's dashed line runs down
        // the left, and a long CT specification would reach it.
        const wrap = 22;
        const climb = st.role === 'switch'
          ? Math.min(labelLineCount(st.item, wrap) - 1, 2) * MV_LABEL.size * 1.15 : 0;
        out.push(simLabel(st.item, lx, sy + 12 - climb, 'end', MV_LABEL.size, wrap));
        reach(lx - labelWidth(st.item, MV_LABEL.size, wrap), sy);
        continue;
      }
      out.push(simLabel(st.item, labelX, sy + TEXT.top, 'start', MV_LABEL.size, MV_LABEL.wrap));
      reach(labelX + labelWidth(st.item, MV_LABEL.size, MV_LABEL.wrap), sy);
    } else if (st.kind === 'earth') {
      const e1 = pinOf(dk(st.item), sx, sy, '1');
      out.push(solidPath([{ x, y: e1.y }, e1], 1.2), node({ x, y: e1.y }));
      out.push(drawDevice(st.item, sx, sy));
      // Between the earth switch and the line, so broken short enough to
      // stay clear of the line.
      out.push(simLabel(st.item, sx + 16, sy + 30, 'start', MV_LABEL.size, 18));
      reach(sx - 12, sy + CELL);
    } else if (st.kind === 'shunt') {
      // A shunt whose connection point leaves to the left is drawn to stand
      // on the right of the line — the office's capacitive detector is — and
      // the other way round; one with no say stands on the left.
      // The detector and the arrester stand on the right of the line, as on
      // the office's sheets: tapped across, the detector straight into its
      // side, the arrester down into its top with the earth under it.
      const d1 = pinDirOf(dk(st.item), '1');
      if (st.item.id !== 'magnet') {
        const off = pinOf(dk(st.item), 0, 0, '1');
        const across = d1 === 'left' || d1 === 'right';
        const px = across ? x + 22 - off.x : x + 34 - off.x;
        const py = across ? sy : sy + 10 - off.y;
        const p1 = pinOf(dk(st.item), px, py, '1');
        const tapY = across ? p1.y : sy;
        out.push(solidPath(across ? [{ x, y: tapY }, p1] : [{ x, y: tapY }, { x: p1.x, y: tapY }, p1], 1.2),
          node({ x, y: tapY }));
        out.push(drawDevice(st.item, px, py));
        if (!symbolOverride(dk(st.item))?.art) out.push(earth(px, py + CELL + 8));
        const lx = px + symbolRight(dk(st.item)) + 6;
        out.push(simLabel(st.item, lx, py + 18, 'start', MV_LABEL.size, MV_LABEL.wrap));
        reach(lx + labelWidth(st.item, MV_LABEL.size, MV_LABEL.wrap), py + symbolHeight(dk(st.item)) + 16);
      } else {
        out.push(line(sx, sy, x, sy, 1.2), node({ x, y: sy }));
        out.push(drawDevice(st.item, sx, sy));
        if (st.item.id !== 'magnet' && !symbolOverride(dk(st.item))?.art) out.push(earth(sx, sy + CELL + 8));
        out.push(simLabel(st.item, sx + 16, sy + 30, 'start', MV_LABEL.size, MV_LABEL.wrap));
        reach(sx - 12, sy + CELL + 14);
      }
    } else {
      // The VT beside the line. With a PT truck at the incoming it is
      // plugged in on a socket after the breaker, never drawn as a second
      // switched device; its HRC fuses above it unless answered without.
      out.push(line(sx, sy + 4, x, sy + 4, 1.2), node({ x, y: sy + 4 }));
      let vy = sy + 4;
      if (ptTruck) {
        out.push(line(sx, vy, sx, vy + 4, 1.2));
        out.push(drawBlock('socket', sx, vy + 4));
        vy += 30;
      } else {
        out.push(line(sx, vy, sx, vy + 4, 1.2));
        vy += 4;
      }
      if (vtFuse) {
        const fuse = synth('hrc-fuse', 'F');
        out.push(drawDevice(fuse, sx, vy));
        vy += CELL;
      }
      out.push(drawDevice(st.item, sx, vy));
      out.push(simLabel(st.item, sx + 30, vy + 16, 'start', MV_LABEL.size, MV_LABEL.wrap));
      reach(sx - 12, vy + CELL);
    }
  }

  // ── The mechanical chain: switch → interlock → earth switch → magnet ──
  if (sw && es && switchY >= 0 && esY >= 0) {
    const s3 = pinOf(dk(sw), x, switchY, '3');
    const ilItem = interlock ?? synth('mechanical-interlock', '');
    const e2 = pinOf(dk(es), sx, esY, '2');
    if (isUpright(pinDirOf(dk(ilItem), '1'))) {
      // Drawn upright, as the office drew it: its 1 at the top takes the
      // switch's 3 from above, its 2 at the bottom goes down and across into
      // the earth switch's 2 — from the side that point faces.
      const off1 = pinOf(dk(ilItem), 0, 0, '1');
      const e2Left = pinDirOf(dk(es), '2') !== 'right';
      const col = e2Left ? e2.x - 18 : e2.x + 18;
      const ilX = col - off1.x;
      const ilY = s3.y + 10 - off1.y;
      const i1 = pinOf(dk(ilItem), ilX, ilY, '1');
      const i2 = pinOf(dk(ilItem), ilX, ilY, '2');
      out.push(dashed([s3, { x: i1.x, y: s3.y }, i1]));
      out.push(`<g ${symbolBlock(dk(ilItem), ilX, ilY)}>${drawIecSymbol(dk(ilItem), ilX, ilY)}</g>`);
      if (interlock) out.push(simLabel(interlock, ilX - symbolLeft(dk(ilItem)) - 4, ilY + HALF, 'end', 8));
      out.push(dashed([i2, { x: i2.x, y: e2.y }, e2]));
      reach(ilX - symbolLeft(dk(ilItem)), i2.y);
    } else {
      // Drawn across: level with the switch's 3, halfway out to the earth
      // switch.
      const ilX = x - MV_CELL.shuntDx / 2 + 4;
      const ilY = s3.y - HALF;
      const i1 = pinOf(dk(ilItem), ilX, ilY, '1');
      const i2 = pinOf(dk(ilItem), ilX, ilY, '2');
      out.push(dashed([s3, { x: i1.x, y: s3.y }, i1]));
      out.push(`<g ${symbolBlock(dk(ilItem), ilX, ilY)}>${drawIecSymbol(dk(ilItem), ilX, ilY)}</g>`);
      if (interlock) out.push(simLabel(interlock, ilX, ilY + 4, 'middle', 8));
      out.push(dashed([i2, { x: e2.x, y: i2.y }, e2]));
    }
  }
  if (es && magnet && esY >= 0) {
    const e3 = pinOf(dk(es), sx, esY, '3');
    const mOff = pinOf(dk(magnet), 0, 0, '1');
    const mx = sx - MV_CELL.magnetDx - mOff.x;
    // Its 1 faces up: the line from the earth switch's 3 runs across and
    // drops into it from above.
    const my = e3.y + 10 - mOff.y;
    const m1 = pinOf(dk(magnet), mx, my, '1');
    out.push(dashed([e3, { x: m1.x, y: e3.y }, m1]));
    out.push(drawDevice(magnet, mx, my));
    // Its label on its right, under the earth switch, so the cell does not
    // spread out to the left for it.
    const mlx = mx + symbolRight(dk(magnet)) + 6;
    out.push(simLabel(magnet, mlx, my + 22, 'start', MV_LABEL.size, 16));
    reach(mx - symbolLeft(dk(magnet)), my + CELL);
    // Magnet's 2 out to the feeder it is interlocked with, the name written
    // on the line itself.
    if (answers.downstreamInterlock !== false) {
      // Magnet's 2 to the feeder it is interlocked with, named along the
      // line, down to the foot of the cell with the other signals.
      const m2 = pinOf(dk(magnet), mx, my, '2');
      signalDown(m2.x, m2.y, String(answers.downstreamText ?? '').trim() || 'OUTGOING FEEDER', answers.downstreamDir === 'up');
    }
  }

  // ── The breaker's status signals ──────────────────────────────────────
  // The mechanical interlock's dashed line carries on past the interlock,
  // out to the left of everything on the cell, and each status drops from it
  // to the foot of the cell with its text along it — the bundle of dashed
  // lines down the left of the office's SIMOPRIME sheets.
  const swSignals = (sw?.statuses ?? [])
    .map((t, k) => ({ text: t.trim(), up: sw?.sld?.statusDirs?.[k] === 'up' })).filter(sg => sg.text);
  const swStatuses = swSignals.map(sg => sg.text);
  const swStatusUp = swSignals.map(sg => sg.up);
  if (sw && switchY >= 0 && swStatuses.length) {
    const s3 = pinOf(dk(sw), x, switchY, '3');
    const first = left - 14;
    const lanes = swStatuses.map((_, k) => first - k * 16);
    out.push(dashed([s3, { x: lanes[lanes.length - 1], y: s3.y }]));
    swStatuses.forEach((t, k) => signalDown(lanes[k], s3.y, t, swStatusUp[k]));
  }

  // ── What hangs on the breaker, along the key interlock's line ─────────
  if (sw && switchY >= 0) {
    const upstream = answers.upstreamInterlock
      ? (String(answers.upstreamText ?? '').trim() || 'INCOMING FEEDER') : undefined;
    // Beside the switch, level with its middle, as the office draws its
    // 94 / CR / 74 / 86.
    const k = keyLine({ x: x + symbolRight(dk(sw)) + 2, y: switchY + symbolHeight(dk(sw)) / 2 },
      answers.breakerAttachments ?? [], upstream);
    out.push(k.svg);
    reach(k.right, k.bottom);
  }

  // ── The secondary side: the CT's cores, and what each one feeds ───────
  // The main relay is the one the CTs and the core-balance CT go into: the
  // one whose window says so, else the first protection relay that is not
  // said to be auxiliary. Every other relay is auxiliary, wired to the
  // breaker, the main relay or both.
  const relays = instruments.filter(i => i.id === 'protection-relay' || i.id === 'earth-fault-relay');
  const relay = relays.find(r => r.relayRole === 'main')
    ?? relays.find(r => r.relayRole !== 'auxiliary' && r.id === 'protection-relay')
    ?? relays.find(r => r.relayRole !== 'auxiliary');
  const auxRelays = relays.filter(r => r !== relay);
  const testBlock = instruments.find(i => i.id === 'test-block');
  const meters = instruments.filter(i => METER_IDS.includes(i.id));
  const volts = instruments.filter(i => VOLTAGE_IDS.includes(i.id));
  const others = instruments.filter(i =>
    !relays.includes(i) && i !== testBlock && !meters.includes(i) && !volts.includes(i));
  const ix = x + MV_CELL.instrDx;
  let ty = ctY >= 0 ? ctY : (switchY >= 0 ? switchY : top);
  let relayAt = -1;
  /** Where the meters' line starts, once they are hung. */
  let meterTop = -1;
  /** Where each part's device was drawn, by its key, for a wire drawn to it
   *  afterwards — an auxiliary relay to the alarm window. */
  const placed = new Map<string, { x: number; y: number; w: number; h: number; cx?: number }>();
  /** An auxiliary relay's wires to other parts, drawn once all are placed. */
  const auxLinks: { from: Pt; key: string }[] = [];
  /** Where a core can come up into the relay from below, and how far right
   *  it and what hangs on it reach. */
  let relayBox = { cx: 0, bottom: 0, right: 0, reach: 0, left: 0 };

  /** A column of instruments hanging on one line at `ix`, from `y0`. */
  /** A device's serial link and status signals, as its window gives them. */
  const signalsOf = (item: ChainItem) => signalList(item);
  /**
   * The relay's and the meters' signals, collected and laid out together
   * once everything on the secondary side is drawn: each one leaves its
   * device, runs across to a lane of its own out to the right of everything,
   * and down to the foot of the cell. A signal that leaves higher up takes a
   * lane further out, so none crosses another on its way.
   */
  const instrSignals: { lead: Pt[]; y: number; text: string; up?: boolean }[] = [];

  /**
   * A meter whose connection point 1 is on its side — the office draws them
   * so, the core coming in from the left — hangs off the core's line by that
   * point rather than sitting in it with the line drawn through it. One
   * point or two makes no difference: where 1 is decides.
   */
  const singlePin = (id: SymbolId) => {
    const o = symbolOverride(id);
    if (!o?.art || !o.terminals?.length) return false;
    const t1 = o.terminals.find(t => t.name === '1') ?? o.terminals[0];
    if (t1.dir) return t1.dir === 'left' || t1.dir === 'right';
    const w = o.width && o.width > 0 ? o.width : 1;
    return o.terminals.length === 1 || t1.x <= w * 0.3 || t1.x >= w * 0.7;
  };

  /** A column of instruments hanging on one line at `ix`, from `y0`. */
  /**
   * A column of instruments hanging on one line at `colX`, from `y0`.
   * `enter` is where the line feeding them reaches the column, when it does.
   * The line runs from one device's point to the next — into a side-fed one
   * by a tap, into a top-fed one at its 1 and on from its 2 — and stops at the
   * last point it has to reach: never run on through a device that has no
   * way out at the bottom.
   */
  const stack = (items: ChainItem[], y0: number, colX = ix, enter?: number): number => {
    if (items.length === 0) return y0;
    let cursor: number | null = enter ?? null;
    const lineTo = (to: number) => {
      if (cursor != null && to > cursor + 0.5) out.push(line(colX, cursor, colX, to));
    };
    // Each one as tall as its label needs, so a long SIM-TABLE never runs
    // into the next instrument's — and room under it for its signals.
    const step = (item: ChainItem) =>
      Math.max(CELL, 17 + labelLineCount(item, MV_LABEL.wrap) * MV_LABEL.size * 1.15)
      + Math.max(0, signalsOf(item).length) * 6;
    let yy = y0;
    /** Where each one stood in this column, for one answered parallel with it. */
    const rows = new Map<ChainItem, { y: number; feed: number; out: number | null; px: number; side: boolean }>();
    // **Series and parallel with the part above, as answered.** A device fed
    // from its side (in at 1 on its left, out at 2 on its right — the
    // office's meters) is in series with the one above it when it carries on
    // in that one's row, from its 2 into this one's 1; in parallel, it takes
    // its own tap off the line, which is how such devices always hang. A
    // device fed from its top is in series down the line, as always; in
    // parallel it stands beside the one above, fed from where that one is fed
    // and joined back under it.
    const tails = new Map<ChainItem, ChainItem[]>();
    const inTail = new Set<ChainItem>();
    items.forEach((item, k) => {
      const prev = items[k - 1];
      if (!prev || item.placement !== 'series' || item.anchor !== prev || !singlePin(dk(item))) return;
      const head = [...tails.entries()].find(([, t]) => t[t.length - 1] === prev)?.[0]
        ?? (singlePin(dk(prev)) && !inTail.has(prev) ? prev : undefined);
      if (!head) return;
      tails.set(head, [...(tails.get(head) ?? []), item]);
      inTail.add(item);
    });
    const ROW_WRAP = 16;
    items.forEach(item => {
      if (inTail.has(item)) return;
      let rightEdge: number;
      let tx: number;
      // Answered parallel with the part above it, and that part is in this
      // column: beside it, level with it, fed from the point it is fed from
      // and joined back under it — never on after it down the column.
      const anchorRow = item.placement === 'parallel' && item.anchor ? rows.get(item.anchor) : undefined;
      const beside = anchorRow && !anchorRow.side ? anchorRow : undefined;
      if (beside) {
        const px = beside.px + 26;
        const ry = beside.y;
        const p1 = pinOf(dk(item), px, ry, '1');
        const feedY = Math.min(beside.feed, p1.y) - 6;
        out.push(solidPath([{ x: colX, y: feedY }, { x: p1.x, y: feedY }, p1]), node({ x: colX, y: feedY }));
        out.push(drawDevice(item, px, ry));
        if (item.key) {
          placed.set(item.key, { x: px - symbolLeft(dk(item)), y: ry,
            w: symbolLeft(dk(item)) + symbolRight(dk(item)), h: symbolHeight(dk(item)) });
        }
        const o = symbolOverride(dk(item));
        const has2 = !(o?.art && o.terminals?.length) || o.terminals.some(t => t.name === '2');
        if (has2 && beside.out != null) {
          const p2 = pinOf(dk(item), px, ry, '2');
          const joinY = Math.max(beside.out, p2.y) + 6;
          out.push(solidPath([p2, { x: p2.x, y: joinY }, { x: colX, y: joinY }]), node({ x: colX, y: joinY }));
          if (cursor != null) cursor = Math.max(cursor, joinY);
        }
        const ptx = px + Math.max(34, labelOffset(item));
        out.push(simLabel(item, ptx, ry - 4, 'start', MV_LABEL.size, MV_LABEL.wrap));
        reach(ptx + labelWidth(item, MV_LABEL.size, MV_LABEL.wrap), ry + step(item));
        beside.px = ptx + labelWidth(item, MV_LABEL.size, MV_LABEL.wrap);
        signalsOf(item).forEach((t, k) => {
          const sy = ry + step(item) - 6 - (signalsOf(item).length - 1 - k) * 6;
          instrSignals.push({ lead: [{ x: px + symbolRight(dk(item)), y: sy }], y: sy, text: t.text, up: t.up });
        });
        yy = Math.max(yy, ry + step(item));
        return;
      }
      const tail = tails.get(item) ?? [];
      if (tail.length) {
        // A row: the first tapped off the line, each after it on from the
        // one before, every label written above its own device.
        const row = [item, ...tail];
        const lift = Math.max(...row.map(i => labelLineCount(i, ROW_WRAP))) * MV_LABEL.size * 1.15 + 4;
        const tapY = yy + lift + HALF;
        lineTo(tapY);
        cursor = tapY;
        out.push(node({ x: colX, y: tapY }));
        let from: Pt = { x: colX, y: tapY };
        let rowStep = 0;
        /** Where the label before ends: the next device stands clear of it. */
        let clear = -Infinity;
        row.forEach(r => {
          const off = pinOf(dk(r), 0, 0, '1');
          const mx = Math.max(from.x + 16 - off.x, clear + 10 + symbolLeft(dk(r)));
          const my = tapY - off.y;
          const p1x = mx + off.x;
          out.push(line(from.x, tapY, p1x, tapY, 1.1));
          out.push(drawDevice(r, mx, my));
          const lx = mx - symbolLeft(dk(r));
          if (r.key) {
            placed.set(r.key, { x: lx, y: my, w: symbolLeft(dk(r)) + symbolRight(dk(r)), h: symbolHeight(dk(r)) });
          }
          const up = (labelLineCount(r, ROW_WRAP) - 1) * MV_LABEL.size * 1.15;
          // From where its ink starts, clear of the line it is tapped off.
          const lbx = Math.max(lx, p1x) + 2;
          out.push(simLabel(r, lbx, my - 4 - up, 'start', MV_LABEL.size, ROW_WRAP));
          clear = lbx + labelWidth(r, MV_LABEL.size, ROW_WRAP);
          reach(clear, my + symbolHeight(dk(r)));
          const re = mx + symbolRight(dk(r));
          const sigs = signalsOf(r);
          sigs.forEach((t, k) => {
            const sy = my + symbolHeight(dk(r)) + 4 + k * 6;
            instrSignals.push({ lead: [{ x: re - 4, y: my + symbolHeight(dk(r)) }, { x: re - 4, y: sy }], y: sy, text: t.text, up: t.up });
          });
          rowStep = Math.max(rowStep, symbolHeight(dk(r)) + 8 + sigs.length * 6);
          rows.set(r, { y: my, feed: tapY, out: cursor, px: re + 6, side: true });
          const o = symbolOverride(dk(r));
          const has2 = !(o?.art && o.terminals?.length) || o.terminals.some(t => t.name === '2');
          from = has2 ? { x: pinOf(dk(r), mx, my, '2').x, y: tapY } : { x: re, y: tapY };
        });
        yy += lift + Math.max(CELL, rowStep);
        return;
      }
      const rowY = yy;
      if (singlePin(dk(item))) {
        // Tapped off the line at its one point.
        const off = pinOf(dk(item), 0, 0, '1');
        // Its point on its right: it stands to the left of the line.
        const o1 = symbolOverride(dk(item));
        const t1 = o1?.terminals?.find(t => t.name === '1') ?? o1?.terminals?.[0];
        const goesRight = pinDirOf(dk(item), '1') === 'right'
          || (!t1?.dir && !!t1 && t1.x >= (o1?.width ?? 1) * 0.7);
        const px = goesRight ? colX - 16 : colX + 16;
        const mx = px - off.x;
        const my = yy + HALF - off.y;
        lineTo(yy + HALF);
        cursor = yy + HALF;
        out.push(line(colX, yy + HALF, px, yy + HALF, 1.1), node({ x: colX, y: yy + HALF }));
        out.push(drawDevice(item, mx, my));
        if (item.key) {
          placed.set(item.key, { x: mx - symbolLeft(dk(item)), y: my,
            w: symbolLeft(dk(item)) + symbolRight(dk(item)), h: symbolHeight(dk(item)) });
        }
        rightEdge = mx + symbolRight(dk(item));
        tx = rightEdge + 6;
      } else {
        const p1 = pinOf(dk(item), colX, yy, '1');
        if (cursor == null) cursor = p1.y;
        lineTo(p1.y);
        out.push(drawDevice(item, colX, yy));
        if (item.key) {
          placed.set(item.key, { x: colX - symbolLeft(dk(item)), y: yy,
            w: symbolLeft(dk(item)) + symbolRight(dk(item)), h: symbolHeight(dk(item)), cx: p1.x });
        }
        // On from its 2 when it has one; a device with no way out at the
        // bottom ends the line.
        const o = symbolOverride(dk(item));
        const has2 = !(o?.art && o.terminals?.length) || o.terminals.some(t => t.name === '2');
        cursor = has2 ? pinOf(dk(item), colX, yy, '2').y : null;
        rightEdge = colX + symbolRight(dk(item));
        tx = colX + Math.max(34, labelOffset(item));
      }
      out.push(simLabel(item, tx, yy + 17, 'start', MV_LABEL.size, MV_LABEL.wrap));
      reach(tx + labelWidth(item, MV_LABEL.size, MV_LABEL.wrap), yy + step(item));
      rows.set(item, {
        y: rowY,
        feed: singlePin(dk(item)) ? rowY + HALF : pinOf(dk(item), colX, rowY, '1').y,
        out: cursor,
        px: tx + labelWidth(item, MV_LABEL.size, MV_LABEL.wrap),
        side: singlePin(dk(item)),
      });
      // Its signals leave under its label, one under the other.
      signalsOf(item).forEach((t, k) => {
        const sy = yy + step(item) - 6 - (signalsOf(item).length - 1 - k) * 6;
        instrSignals.push({ lead: [{ x: rightEdge, y: sy }], y: sy, text: t.text, up: t.up });
      });
      yy += step(item);
    });
    return yy;
  };

  const drawRelay = (item: ChainItem, y0: number): number => {
    relayAt = y0;
    relayBox = { cx: ix + 4 + Math.max(16, symbolRight(dk(item)) / 2), bottom: y0 + CELL - 8,
      right: ix + symbolRight(dk(item)), reach: ix + symbolRight(dk(item)), left: ix + 5 };
    // Written above the relay's box, whatever height the box comes out.
    // A label of several lines climbs up from the box rather than into it.
    const label = (top_: number) => {
      const up = (labelLineCount(item, MV_LABEL.wrap) - 1) * MV_LABEL.size * 1.15;
      out.push(simLabel(item, ix + 5, Math.min(y0 + 5, top_ - 3) - up, 'start', MV_LABEL.size, MV_LABEL.wrap));
      reach(ix + 5 + labelWidth(item, MV_LABEL.size, MV_LABEL.wrap), y0);
    };
    let rx = ix + symbolRight(dk(item));
    let h = CELL;
    // The relay's own window says its functions; the cell's question is the
    // fallback. None: the plain relay, "PROTECTION RELAY" in its box.
    const fnText = String(item.functions ?? '').trim()
      || (item.id === 'protection-relay' && answers.relayMode === 'functions' ? String(answers.relayFunctions ?? '') : '');
    const fns = fnText.split(/[,،;\n]+/).map(f => f.trim()).filter(Boolean);
    if (fns.length === 0) {
      out.push(drawDevice(item, ix, y0));
      label(y0 + 8);
    } else if (opts.family === 'SIMOPRIME') {
      // SIMOPRIME's sheets: one circle per function, side by side in the
      // relay's box, two rows at most before it grows.
      const perRow = Math.min(fns.length, 4);
      const rows = Math.ceil(fns.length / perRow);
      const d = 14;
      const w = perRow * d + 4;
      const bh = rows * d + 4;
      const by = y0 + HALF - bh / 2;
      out.push(`<g ${symbolBlock('protection-relay', ix, y0)}>` +
        line(ix, y0 + HALF, ix + 4, y0 + HALF, 1) +
        `<rect x="${ix + 4}" y="${by}" width="${w}" height="${bh}" fill="#fff" stroke="#111" stroke-width="1"/>` +
        fns.map((f, n) => {
          const cx = ix + 4 + 2 + (n % perRow) * d + d / 2;
          const cy = by + 2 + Math.floor(n / perRow) * d + d / 2;
          return `<circle cx="${cx}" cy="${cy}" r="${d / 2 - 0.8}" fill="#fff" stroke="#111" stroke-width="0.8"/>` +
            `<text x="${cx}" y="${cy + 2}" font-size="${f.length > 3 ? 4.4 : 5.5}" text-anchor="middle" fill="#111">${esc(f)}</text>`;
        }).join('') + '</g>');
      rx = ix + 4 + w;
      h = Math.max(CELL, bh + 12);
      label(by);
      relayBox = { cx: ix + 4 + w / 2, bottom: by + bh, right: ix + 4 + w, reach: ix + 4 + w, left: ix + 4 };
    } else {
      // EK36's sheets: the functions written in the relay's own box, run
      // together the way the office writes them — "50,50N,51,51N," — and
      // broken onto as few lines as fit.
      const lines: string[] = [];
      let cur = '';
      for (const f of fns) {
        const next = cur ? `${cur},${f}` : f;
        if (next.length > 14 && cur) { lines.push(`${cur},`); cur = f; } else cur = next;
      }
      if (cur) lines.push(cur);
      const w = Math.max(...lines.map(l => l.length * 7.5 * 0.6)) + 10;
      const bh = lines.length * 9.5 + 7;
      const by = y0 + HALF - bh / 2;
      out.push(`<g ${symbolBlock('protection-relay', ix, y0)}>` +
        line(ix, y0 + HALF, ix + 4, y0 + HALF, 1) +
        `<rect x="${ix + 4}" y="${by}" width="${w}" height="${bh}" fill="#fff" stroke="#111" stroke-width="1"/>` +
        lines.map((l, n) => `<text x="${ix + 4 + w / 2}" y="${by + 10 + n * 9.5}" font-size="7.5" text-anchor="middle" fill="#111">${esc(l)}</text>`).join('') +
        '</g>');
      rx = ix + 4 + w;
      h = Math.max(CELL, bh + 12);
      label(by);
      relayBox = { cx: ix + 4 + w / 2, bottom: by + bh, right: ix + 4 + w, reach: ix + 4 + w, left: ix + 4 };
    }
    const k = keyLine({ x: rx, y: y0 + HALF }, answers.relayAttachments ?? []);
    out.push(k.svg);
    relayBox.reach = Math.max(relayBox.right, k.right);
    reach(Math.max(rx, k.right), Math.max(y0 + h, k.bottom));

    // The serial link and the status signals: each leaves the bottom of the
    // relay's box, turns out to the right of everything on the relay, and
    // runs down to the foot of the cell with its text along it. The first
    // goes furthest out and the later ones turn lower and nearer in, so no
    // two of them cross.
    const signals = signalsOf(item);
    signals.forEach((t, k) => {
      const sx_ = Math.max(relayBox.cx + 8, relayBox.right - 6 - k * 7);
      const turn = relayBox.bottom + 6 + k * 6;
      instrSignals.push({ lead: [{ x: sx_, y: relayBox.bottom }, { x: sx_, y: turn }], y: turn, text: t.text, up: t.up });
    });
    return Math.max(y0 + h, k.bottom + 4 + signals.length * 6);
  };

  // A relay whose functions were answered is on the cell whether or not
  // its part is in the template yet.
  const cores = ct
    ? coresOf(answers, Boolean(relay || answers.relayMode === 'functions'), meters.length > 0, ct)
    : [];
  if (ct && cores.length) {
    // The cores leave the CT's secondary one under the other and part, each
    // down its own lane. The first runs straight across into what stands
    // level with the CT; each later one starts lower and turns down further
    // left, so no core crosses another on its way.
    // Out of the CT's own secondary when it was drawn with one (its 3).
    const sec = symbolOverride(dk(ct))?.terminals?.some(t => t.name === '3')
      ? pinOf(dk(ct), x, ctY, '3') : { x: x + 20, y: ctY + HALF };
    const cx0 = sec.x;
    const cy = sec.y;
    const coreY = (n: number) => cy + n * 10;
    // The meters shared out among the measuring cores, in order.
    const measuring = cores.filter(c => c.purpose === 'measurement').length;
    const meterGroups: ChainItem[][] = Array.from({ length: measuring }, (_, j) =>
      (j === measuring - 1 ? meters.slice(j) : meters.slice(j, j + 1)));
    let measSeen = 0;
    if (cores.length > 1) out.push(line(cx0, coreY(0), cx0, coreY(cores.length - 1), 1));
    cores.forEach((core, n) => {
      const lane = x + MV_CELL.laneDx - n * MV_CELL.laneStep;
      const start = { x: cx0, y: coreY(n) };
      out.push(coreNumber(cx0, start.y, n + 1));
      let landY: number;
      let next: number;
      if (core.purpose === 'protection') {
        const item = relay ?? synth('protection-relay', 'F');
        if (relayAt >= 0) { landY = relayAt + HALF; next = ty; }
        else { landY = ty + HALF; next = drawRelay(item, ty) + 8; }
        out.push(solidPath([start, { x: lane, y: start.y }, { x: lane, y: landY }, { x: ix, y: landY }]), node({ x: ix, y: landY }));
      } else if (core.purpose === 'measurement') {
        // The meters this core feeds: with several measuring cores, each
        // takes its own, in order — core 2 the first meter, core 3 the next,
        // the last core the rest — so two cores never run into one meter on
        // top of each other. A core left with no meter is an arrow.
        const mine = meterGroups[measSeen++] ?? [];
        if (mine.length) {
          // Straight across into the first meter when it is fed from its
          // side: the meters hang so its point is level with the core.
          const side = singlePin(dk(mine[0]));
          const top_ = side ? Math.max(ty, start.y - HALF) : ty;
          landY = side ? top_ + HALF : top_;
          if (meterTop < 0) meterTop = side ? top_ + HALF : top_;
          next = stack(mine, top_, ix, landY) + 8;
          out.push(solidPath([start, { x: lane, y: start.y }, { x: lane, y: landY }, { x: ix, y: landY }]), node({ x: ix, y: landY }));
        } else {
          // No meter on the cell to take it: a short arrow straight out of
          // the CT saying what the core is for.
          landY = start.y;
          const tip = start.x + 30;
          out.push(solidPath([start, { x: tip, y: start.y }]), arrowRight(tip, start.y));
          out.push(`<text x="${tip + 4}" y="${start.y + 3}" font-size="7.5" fill="#111">MEASURING</text>`);
          reach(tip + 4 + 9 * 7.5 * 0.62, landY);
          next = ty;
        }
      } else {
        // A remark is a short arrow straight out of the CT with its text
        // after it, as the office writes "CURRENT SAMPLE TO METERING PANEL"
        // — it feeds nothing on this cell, so it takes no lane.
        landY = start.y;
        const say = String(core.text ?? '').trim().toUpperCase();
        const tip = start.x + 30;
        out.push(solidPath([start, { x: tip, y: start.y }]), arrowRight(tip, start.y));
        if (say) out.push(`<text x="${tip + 4}" y="${start.y + 3}" font-size="7.5" fill="#111">${esc(say)}</text>`);
        reach(tip + 4 + say.length * 7.5 * 0.62, landY);
        next = ty;
      }
      // Through the test block, when the cell has one: a test terminal on
      // every core, just before the core reaches what it feeds.
      if (testBlock && core.purpose !== 'remark') {
        const tbx = lane + 22;
        out.push(`<g ${symbolBlock('test-block', tbx, landY)}><circle cx="${tbx}" cy="${landY}" r="4" fill="#fff" stroke="#111" stroke-width="1.1"/>` +
          `<circle cx="${tbx}" cy="${landY}" r="1.6" fill="#111"/></g>`);
        if (n === 0) out.push(simLabel(testBlock, tbx + 5, landY - 7, 'end', 8, 22));
      }
      ty = Math.max(ty, next);
      reach(ix, landY);
    });
  } else if (relay) {
    // No CT on the cell, or no core answered: the relay still stands where
    // it would, joined by a control line from the switch.
    const item = relay;
    const from = switchY >= 0 ? switchY + HALF : top + HALF;
    out.push(dashed([{ x: x + 8, y: from }, { x: ix, y: from }]));
    ty = drawRelay(item, Math.max(ty, from - HALF)) + 8;
  }

  // The auxiliary relays, to the right of the main one and below it, each
  // wired as its window says: from the main relay, from the breaker, or
  // both. Unanswered, one beside a main relay hangs on it, as the earth
  // fault relay always did; one with no main relay to hang on, on the
  // breaker.
  if (auxRelays.length) {
    // Right of everything already hung on the secondary side, so it never
    // stands on a meter or its label.
    const ax = Math.max(relayAt >= 0 ? relayBox.reach : ix, right) + 28;
    let ay = relayAt >= 0 ? relayBox.bottom + 18 : ty;
    for (const aux of auxRelays) {
      // What its window says it is wired to — any of the breaker, the main
      // relay and other parts (the alarm window…); the older single answer
      // when there is no list; and, unanswered, the main relay when there is
      // one to hang on, the breaker when there is not.
      const connects: string[] = aux.sld?.connects
        ?? (aux.relayConnect === 'both' ? ['breaker', 'relay']
          : aux.relayConnect ? [aux.relayConnect] : [relayAt >= 0 ? 'relay' : 'breaker']);
      const connect = connects.includes('breaker') && connects.includes('relay') ? 'both'
        : connects.includes('breaker') ? 'breaker' : connects.includes('relay') ? 'relay' : 'none';
      out.push(drawDevice(aux, ax, ay));
      if (aux.key) placed.set(aux.key, { x: ax, y: ay, w: symbolRight(dk(aux)), h: symbolHeight(dk(aux)) });
      connects.filter(c => c !== 'breaker' && c !== 'relay').forEach((key, n) => {
        auxLinks.push({ from: { x: ax + Math.min(symbolRight(dk(aux)) - 6, 10 + n * 6), y: ay + symbolHeight(dk(aux)) - 8 }, key });
      });
      const up = (labelLineCount(aux, MV_LABEL.wrap) - 1) * MV_LABEL.size * 1.15;
      out.push(simLabel(aux, ax + 5, ay + 5 - up, 'start', MV_LABEL.size, MV_LABEL.wrap));
      const mid = { x: ax, y: ay + HALF };
      if ((connect === 'relay' || connect === 'both') && relayAt >= 0) {
        // Out of the relay's right side, high up, and down beside the
        // auxiliary relay — clear of the meters hung under the main one.
        const fy = relayAt + 16;
        const down = ax - 10;
        out.push(dashed([{ x: relayBox.right, y: fy }, { x: down, y: fy }, { x: down, y: mid.y }, mid]));
      }
      if ((connect === 'breaker' || connect === 'both') && sw && switchY >= 0) {
        // Round the far side of the relay, clear of its label, into its side.
        const from = { x: x + symbolRight(dk(sw)) + 2, y: switchY + 4 };
        const far = ax + Math.max(symbolRight(dk(aux)), labelWidth(aux, MV_LABEL.size, MV_LABEL.wrap) + 5) + 12;
        out.push(dashed([from, { x: far, y: from.y }, { x: far, y: mid.y }, { x: ax + symbolRight(dk(aux)), y: mid.y }]));
      }
      reach(ax + Math.max(symbolRight(dk(aux)), labelWidth(aux, MV_LABEL.size, MV_LABEL.wrap)) + 8, ay + CELL);
      ay += CELL + 22;
    }
    ty = Math.max(ty, ay);
  }

  // The core-balance CT's core: out of its side, up its own lane — through
  // the test block when the cell has one, the office's XD2 — into the relay.
  const cbct = series.find(i => i.id === 'core-balance-ct');
  if (cbct && relayAt >= 0) {
    const by0 = ys.get(cbct)!;
    const from = symbolOverride(dk(cbct))?.terminals?.some(t => t.name === '3')
      ? pinOf(dk(cbct), x, by0, '3') : { x: x + symbolRight(dk(cbct)), y: by0 + HALF };
    // Up into the bottom of the relay, as the office draws XD2 — unless
    // meters hang under the relay, then in from the side on its own lane.
    const under = meters.length > 0 || others.length > 0;
    const lane = under ? x + MV_CELL.laneDx + 18 : relayBox.cx;
    const land = under ? { x: ix, y: relayAt + HALF + 8 } : { x: lane, y: relayBox.bottom };
    out.push(solidPath(under
      ? [from, { x: lane, y: from.y }, { x: lane, y: land.y }, land]
      : [from, { x: lane, y: from.y }, land]), node(land));
    if (under) out.push(line(ix, land.y, ix + 4, land.y, 1));
    if (testBlock) {
      const ty_ = (from.y + land.y) / 2;
      out.push(`<g ${symbolBlock('test-block', lane, ty_)}><circle cx="${lane}" cy="${ty_}" r="4" fill="#fff" stroke="#111" stroke-width="1.1"/>` +
        `<circle cx="${lane}" cy="${ty_}" r="1.6" fill="#111"/></g>`);
      out.push(simLabel(testBlock, lane + 7, ty_ + 3, 'start', 8, 22));
    }
    reach(lane + 8, from.y);
  }
  if (!ct && meters.length) { meterTop = singlePin(dk(meters[0])) ? ty + HALF : ty; ty = stack(meters, ty) + 8; }

  // Every other CT on the line has its cores too, each to what it is for:
  // protection up into the relay, measuring onto the meters' line, a remark
  // as an arrow with its text — and with nothing on the cell to take a core,
  // an arrow saying what it is for.
  const moreCts = series.filter(i => i.id === 'current-transformer' && i !== ct);
  // The lowest core run across to the secondary side: what hangs under the
  // relay starts below it, so no core runs through a device.
  let lowestCore = -Infinity;
  moreCts.forEach((other, j) => {
    const oy = ys.get(other);
    if (oy == null) return;
    const own = coresOf(answers, Boolean(relay), meters.length > 0, other);
    const sec = symbolOverride(dk(other))?.terminals?.some(t => t.name === '3')
      ? pinOf(dk(other), x, oy, '3') : { x: x + 20, y: oy + HALF };
    if (own.length > 1) out.push(line(sec.x, sec.y, sec.x, sec.y + (own.length - 1) * 10, 1));
    own.forEach((core, k) => {
      const start = { x: sec.x, y: sec.y + k * 10 };
      out.push(coreNumber(sec.x, start.y, k + 1));
      const arrow = (say: string) => {
        const tip = start.x + 30;
        out.push(solidPath([start, { x: tip, y: start.y }]), arrowRight(tip, start.y));
        out.push(`<text x="${tip + 4}" y="${start.y + 3}" font-size="7.5" fill="#111">${esc(say)}</text>`);
        reach(tip + 4 + say.length * 7.5 * 0.62, start.y);
      };
      lowestCore = Math.max(lowestCore, start.y);
      if (core.purpose === 'protection' && relayAt >= 0 && (others.length || meters.length)) {
        // Something hangs under the relay: in from its side instead, on a
        // lane of its own left of the instruments.
        const lane = ix - 24 - (j * 2 + k) * 6;
        const ly = relayAt + HALF + 6 + (j * 2 + k) * 4;
        out.push(solidPath([start, { x: lane, y: start.y }, { x: lane, y: ly }, { x: ix, y: ly }]),
          node({ x: ix, y: ly }));
        out.push(line(ix, ly, relayBox.left, ly, 1));
      } else if (core.purpose === 'protection' && relayAt >= 0) {
        const lane = relayBox.cx - 10 - (j * 2 + k) * 8;
        out.push(solidPath([start, { x: lane, y: start.y }, { x: lane, y: relayBox.bottom }]),
          node({ x: lane, y: relayBox.bottom }));
      } else if (core.purpose === 'measurement' && meterTop >= 0) {
        const lane = ix - 14 - (j * 2 + k) * 6;
        out.push(solidPath([start, { x: lane, y: start.y }, { x: lane, y: meterTop }, { x: ix, y: meterTop }]),
          node({ x: ix, y: meterTop }));
      } else {
        arrow(core.purpose === 'remark' ? String(core.text ?? '').trim().toUpperCase()
          : core.purpose === 'protection' ? 'PROTECTION' : 'MEASURING');
      }
    });
  });

  // The voltage instruments, off the VT when there is one.
  if (volts.length) {
    const vt = socketVt ?? loadVt ?? series.find(i => i.id === 'voltage-transformer');
    const vy = vt ? ys.get(vt) : undefined;
    const start = ty;
    ty = stack(volts, ty, ix, ty) + 8;
    if (vt && vy != null) {
      const fromX = vt === socketVt ? sx + 28 : x + 28;
      const fromY = vt === socketVt ? vy + CELL + 10 + HALF + 5 : vy + HALF + 5;
      const lane = x + MV_CELL.laneDx - MV_CELL.laneStep;
      out.push(solidPath([{ x: fromX, y: fromY }, { x: lane, y: fromY }, { x: lane, y: start }, { x: ix, y: start }]), node({ x: ix, y: start }));
    }
  }

  // Everything else — the alarm window, lamps, the LCS — on the relay's
  // control line, or the switch's when there is no relay.
  if (others.length) {
    const start = Math.max(ty, lowestCore + 14);
    if (relayAt >= 0) {
      // Wired into the relay's own box: straight down out of its bottom, the
      // alarm window hung on that line under whatever already hangs there.
      // The line keeps clear of the CTs' cores coming up into the box's
      // middle and the signals leaving its right.
      const colX = relayBox.left + 6;
      out.push(line(colX, relayBox.bottom, colX, start, 1.1));
      ty = stack(others, start, colX, start) + 8;
    } else {
      ty = stack(others, ty, ix, ty) + 8;
      const fromY = switchY >= 0 ? switchY + HALF : top;
      out.push(dashed([{ x: x + 8, y: fromY }, { x: ix - 10, y: fromY }, { x: ix - 10, y: start }, { x: ix, y: start }]));
    }
  }
  reach(ix, ty);

  // An auxiliary relay's wires to the other parts it is connected to: down
  // out of its bottom and across into the device's near side.
  for (const link of auxLinks) {
    const to = placed.get(link.key);
    if (!to) continue;
    // Down into its top, at its near side, clear of the label beside it and
    // of the line coming into its 1.
    const cx = to.cx ?? to.x + to.w / 2;
    const tx_ = link.from.x >= cx ? cx + 7 : cx - 7;
    const above = to.y - 8;
    out.push(dashed([link.from, { x: link.from.x, y: above }, { x: tx_, y: above }, { x: tx_, y: to.y + Math.min(8, to.h / 4) }]));
  }

  // The secondary side's signals, to lanes out past everything drawn.
  if (instrSignals.length) {
    const base = right + 16;
    const order = [...instrSignals].sort((a, b) => a.y - b.y);
    order.forEach((sg, i) => {
      const lane = base + (order.length - 1 - i) * 16;
      out.push(dashed([...sg.lead, { x: lane, y: sg.y }]));
      signalDown(lane, sg.y, sg.text, sg.up);
    });
  }
  drawSignals();
  return { svg: out.join('\n'), bottom, reachBottom: Math.max(reachBottom, bottom), left, right };
}

/**
 * How a cell's line is finished below its last device, at `y`: the arrow to
 * the load, the cable sealing end, the capacitor, the busduct, the copper
 * bar on to another panel. A coupling and its riser are joined by the sheet.
 */
function drawMvEnd(end: MvEnd, x: number, y: number, opts: MvCellOptions, motor: boolean): string {
  const say = (fallback: string) =>
    (String(opts.answers?.connectedTo ?? '').trim() || fallback).toUpperCase();
  const caption = (t: string, ty: number) =>
    `<text x="${x + 10}" y="${ty}" font-size="8" fill="#111">${esc(t)}</text>`;
  switch (end) {
    case 'outgoing': return drawBlock(motor ? 'motor' : 'outgoing', x, y);
    case 'cable':
      return drawBlock('cable-sealing-end', x, y) + drawBlock('outgoing', x, y + CELL) +
        caption(say('BUS CABLE CONNECTION'), y + CELL + 30);
    case 'cable-in':
      return drawBlock('cable-sealing-end', x, y) + drawBlock('incoming', x, y + CELL) +
        caption(say('INCOMING CABLE'), y + CELL + 30);
    case 'capacitor': return drawBlock('capacitor', x, y);
    case 'busduct':
      return drawBlock('bus-duct', x, y) + caption(say('BUSDUCT'), y + CELL - 4);
    case 'bar':
      return line(x, y, x, y + 24, 2.2) + `<path d="M ${x - 6} ${y + 20} L ${x} ${y + 32} L ${x + 6} ${y + 20} Z" fill="#111"/>` +
        caption(say('BAR CONNECTION TO ANOTHER PANEL'), y + 30);
    default: return '';
  }
}

/** How much room a cell takes, measured by drawing it at the origin. */
function measureMvCell(chain: ChainItem[], opts: MvCellOptions) {
  const d = drawMvCell(chain, opts, 0, 0);
  return { left: -d.left, right: d.right, height: d.reachBottom, bottom: d.bottom };
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

  // A medium-voltage board is drawn cell by cell (`drawMvCell`), each with the
  // answers its own template holds.
  const isMv = LAYOUT_OF[o.equipment.type] === 'MV';
  const mvOf = (line_: DeviceTableRow, page: number) => {
    const template = line_.templateId ? o.templates.get(line_.templateId) : undefined;
    const chain = chainFor(line_, o.templates, o.order, page, o.symbols, o.equipment.type);
    const opts = mvOptionsOf(template);
    return { chain, opts, size: measureMvCell(chain, opts) };
  };
  const mvCells = isMv ? o.lines.map((line_, i) => mvOf(line_, o.firstIndex + i + 1)) : [];
  const mvSupply = isMv && o.supply ? mvOf(o.supply, 0) : null;

  const branches = o.lines.map((line_, i) =>
    splitBranch(chainFor(
      line_, o.templates, o.order, o.firstIndex + i + 1, o.symbols, o.equipment.type)));
  const supplyAll = o.supply
    ? splitBranch(chainFor(o.supply, o.templates, o.order, 0, o.symbols, o.equipment.type))
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
    [...b.series, ...b.instruments].map(i => symbolLeft(dk(i)))), 16);
  const mvAll = [...mvCells, ...(mvSupply ? [mvSupply] : [])];
  const branchDx = isMv && mvAll.length
    ? Math.max(34, reach + 10, ...mvAll.map(c => c.size.left + 12))
    : Math.max(hasShunt ? 130 : 34, reach + 10);

  /**
   * How wide a feeder column has to be.
   *
   * Worked out from what is written in it rather than declared: the conductor
   * is `branchDx` in from the left, the text starts clear of the widest symbol
   * on the branch, and the part code is clipped to `CODE_CHARS`. A flat 200
   * units — which is what this was — is right for a cell with instruments
   * beside it and half empty for a plain outgoing feeder, and eight half-empty
   * columns is a sheet three times wider than it is tall with the drawing
   * strung out thin across it. That is most of what makes these sheets look
   * like a row of marks rather than a drawing.
   */
  const labelReach = Math.max(24, ...all.flatMap(
    b => b.series.map(i => labelOffset(i))));
  // The label is written whole — `Q : <SIM-TABLE>` — so the column is as wide
  // as the longest one on the sheet, and never narrower than it used to be.
  const labelChars = Math.max(0, ...all.flatMap(b => [...b.series, ...b.shunts, ...b.instruments]
    .map(i => Math.max(...allLines(i, LV_WRAP).map(l => l.text.length)))));
  const forText = branchDx + labelReach + Math.max(
    textWidth(CODE_CHARS, TEXT.codeSize), textWidth(labelChars, TEXT.tag)) + 18;
  const colWidth = Math.max(
    forText,
    hasShunt || wide ? branchDx + INSTR_DX + 104 : 0,
    ...mvAll.map(c => branchDx + c.size.right + 24),
  );

  const supplyWidth = o.supply ? colWidth : 90;
  const bodyLeft = margin + supplyWidth;
  const supplyX = margin + branchDx;

  const supplyTop = 104;
  const busY = Math.max(GEOM.busY,
    supplyTop + (mvSupply ? mvSupply.size.height
      : supplyBranch ? branchHeight(supplyBranch) : 0) + 26);

  const chainTop = busY + 26;
  const body = isMv
    ? Math.max(CELL, ...mvCells.map(c => c.size.bottom))
    : Math.max(CELL, ...branches.map(branchHeight));
  const loadY = chainTop + body + 20;
  // An MV cell can reach below its own line — the magnet's line down to the
  // feeder it is interlocked with — and the table starts clear of that too.
  // A cable connection ends in its sealing end and the cable below it.
  const endRoom = mvCells.some(c => ['cable', 'cable-in'].includes(mvEndOf(c.opts))) ? CELL + 10 : 0;
  const tableTop = Math.max(loadY + CELL + 36 + endRoom,
    ...mvCells.map(c => chainTop + c.size.height + 24));
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
  // The busbar says outright which layer it is. It used to be recognised by
  // being drawn heavier than 4 units, which made its weight a thing the reader
  // depended on rather than a thing the draughtsman could choose.
  // A bus sectionalizer splits the bar: the coupling's breaker on one side,
  // its riser on the other, joined underneath by the bar connection. Each
  // coupling is paired with the riser beside it on the sheet.
  const ends = isMv ? mvCells.map(c => mvEndOf(c.opts)) : [];
  const pairOf = new Map<number, number>();
  ends.forEach((end, i) => {
    if (end !== 'coupling' || pairOf.has(i)) return;
    const j = [i + 1, i - 1].find(k => ends[k] === 'riser' && !pairOf.has(k));
    if (j != null) { pairOf.set(i, j); pairOf.set(j, i); }
  });
  const breaks: { x: number; label: string }[] = [];
  ends.forEach((end, i) => {
    const j = pairOf.get(i);
    if (end !== 'coupling' || j == null) return;
    const riserRow = o.lines[j];
    breaks.push({
      x: bodyLeft + Math.max(i, j) * colWidth,
      label: String(mvCells[i].opts.answers?.otherSection ?? '').trim()
        || (riserRow.busSection ? `BUS ${riserRow.busSection}` : 'BUS B'),
    });
  });
  breaks.sort((a, b) => a.x - b.x);
  let from = margin;
  for (const b of breaks) {
    out.push(`<line data-layer="BUS" x1="${from}" y1="${busY}" x2="${b.x - 7}" y2="${busY}" stroke="#111" stroke-width="3.2"/>`);
    out.push(`<text x="${b.x + 11}" y="${busY - 9}" font-size="9.5" font-weight="600" fill="#111">${esc(b.label)}</text>`);
    from = b.x + 7;
  }
  out.push(`<line data-layer="BUS" x1="${from}" y1="${busY}" x2="${contentRight}" y2="${busY}" stroke="#111" stroke-width="3.2"/>`);

  // ── The incoming column ───────────────────────────────────────────────
  if (o.supply && supplyBranch) {
    out.push(`<text x="${supplyX}" y="80" font-size="10" font-weight="700" fill="#111">${
      esc(clip(String(o.supply.feederNo || 'INCOMING'), 22))}</text>`);
    out.push(`<text x="${supplyX}" y="94" font-size="9" fill="#555">${
      esc(clip(String(o.supply.description || ''), 30))}</text>`);
    const drawn = mvSupply
      ? drawMvCell(mvSupply.chain, mvSupply.opts, supplyX, supplyTop, busY - 8)
      : drawBranch(supplyBranch, supplyX, supplyTop);
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
    const offBus = isMv && mvOffBus(mvCells[i].opts);
    if (!offBus) {
      out.push(`<line x1="${x}" y1="${busY}" x2="${x}" y2="${chainTop}" stroke="#111" stroke-width="1.3"/>`);
      out.push(`<circle cx="${x}" cy="${busY}" r="3" fill="#111"/>`);
    }

    const drawn = isMv
      ? drawMvCell(mvCells[i].chain, mvCells[i].opts, x, chainTop, loadY + 36)
      : drawBranch(branches[i], x, chainTop);
    out.push(drawn.svg);
    if (!isMv) {
      out.push(`<line x1="${x}" y1="${drawn.bottom}" x2="${x}" y2="${loadY}" stroke="#111" stroke-width="1.3"/>`);
      out.push(drawBlock(isMotorLoad(line_) ? 'motor' : 'outgoing', x, loadY));
      return;
    }
    const end = ends[i];
    if (end === 'none') return;
    if (end === 'coupling' || end === 'riser') {
      // Down to the bar connection, and — from the coupling's side — across
      // to the riser.
      const barY = loadY + 12;
      out.push(`<line x1="${x}" y1="${drawn.bottom}" x2="${x}" y2="${barY}" stroke="#111" stroke-width="1.3"/>`);
      const j = pairOf.get(i);
      if (end === 'coupling' && j != null) {
        const rx = bodyLeft + j * colWidth + branchDx;
        out.push(`<line x1="${x}" y1="${barY}" x2="${rx}" y2="${barY}" stroke="#111" stroke-width="2.2"/>`);
      } else if (j == null) {
        // No partner on this sheet: say where the bar goes.
        out.push(`<text x="${x + 8}" y="${barY + 4}" font-size="8" fill="#111">${
          esc(end === 'coupling' ? 'TO RISER' : 'TO COUPLING')}</text>`);
      }
      return;
    }
    out.push(`<line x1="${x}" y1="${drawn.bottom}" x2="${x}" y2="${loadY}" stroke="#111" stroke-width="1.3"/>`);
    out.push(drawMvEnd(end, x, loadY, mvCells[i].opts, isMotorLoad(line_)));
  });

  // ── The block under the drawing ───────────────────────────────────────
  out.push(`<rect x="${margin}" y="${tableTop}" width="${contentRight - margin}" height="${tableHeight}" fill="none" stroke="#111" stroke-width="1"/>`);
  const tableChars = Math.max(8, Math.floor((colWidth - 12) / (9 * 0.52)));
  TABLE_ROWS.forEach((row, r) => {
    const ry = tableTop + r * cardRowHeight;
    if (r > 0) out.push(`<line x1="${margin}" y1="${ry}" x2="${contentRight}" y2="${ry}" stroke="#c9ced6" stroke-width="0.7"/>`);
    out.push(`<text x="${margin + 6}" y="${ry + 11}" font-size="9" font-weight="600" fill="#111">${esc(row.label)} :</text>`);
    o.lines.forEach((line_, i) => {
      const cx = bodyLeft + i * colWidth + colWidth / 2;
      const value = row.value(line_);
      // Cut to the column it is written in. Thirty characters was right for a
      // 200-unit column and would run into its neighbours in a narrower one.
      out.push(`<text x="${cx}" y="${ry + 11}" font-size="9" text-anchor="middle" fill="#111">` +
        `<title>${esc(value)}</title>${esc(clip(value, tableChars))}</text>`);
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
/** A template's devices in the order a cell is drawn, its answers with each
 *  part's own laid over them, and a CT's cores — the same reading the
 *  drawing makes, for a back-end that lays the cell out on its own (the
 *  EPLAN window macro). */
export function templateCell(template: TemplateLike | undefined, tier: Tier, symbols?: EplanSymbolMap) {
  const chain = chainOfTemplate(template, propertyOrder(tier), 1, symbols, tier);
  const opts = mvOptionsOf(template);
  const answers = withPartAnswers(opts.answers ?? {}, chain);
  return {
    chain,
    answers,
    family: opts.family ?? '',
    cores: (ct: ChainItem, hasRelay: boolean, hasMeters: boolean) => coresOf(answers, hasRelay, hasMeters, ct),
  };
}

export function buildTemplateSvg(
  template: TemplateLike | undefined,
  tier: Tier,
  symbols?: EplanSymbolMap,
): { svg: string; width: number; height: number; devices: number } {
  const { margin } = GEOM;
  const order = propertyOrder(tier);
  const chain = chainOfTemplate(template, order, 1, symbols, tier);
  const branch = splitBranch(chain);
  const isMv = LAYOUT_OF[tier] === 'MV';
  // An LV feeder drawn in Simorgh Draw follows the cell's rules too — relays
  // main and auxiliary, serial links, statuses, interlocks — with its own
  // breaker kept, and is drawn as one line or as every conductor.
  const lvCell = tier === 'LV' && template?.useSimorghDraw !== false && !!template?.singleLine?.lvLines;
  if (lvCell && template?.singleLine?.lvLines === 'multi') return buildLvMultiLineSvg(template, chain);
  const mvOpts: MvCellOptions = lvCell
    ? { answers: template?.singleLine, mechanical: template?.mechanical, family: '', cellType: '', sub: '', lv: true }
    : mvOptionsOf(template);
  const mvSize = isMv || lvCell ? measureMvCell(chain, mvOpts) : null;

  // Room for whatever reaches out sideways, the same way a sheet works out how
  // wide a column has to be.
  const reach = Math.max(16, ...[...branch.series, ...branch.instruments].map(i => symbolLeft(dk(i))));
  const branchDx = mvSize
    ? Math.max(34, reach + 10, mvSize.left + 12)
    : Math.max(branch.shunts.length > 0 ? 130 : 34, reach + 10);
  const x = margin + branchDx;
  const stub = 26;
  const top = 34 + stub;

  const drawn = mvSize ? drawMvCell(chain, mvOpts, x, top) : drawBranch(branch, x, top);
  const width = mvSize
    ? Math.max(x + INSTR_DX + 104, x + mvSize.right + 20) + margin
    : x + INSTR_DX + 104 + margin;
  const bottom = Math.max(drawn.bottom, top);
  const height = Math.max(bottom + stub + 34 + (mvSize ? CELL + 20 : 0), mvSize ? top + mvSize.height + 20 : 0);

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}" font-family="Segoe UI, Arial, sans-serif">`);
  out.push(`<rect width="${width}" height="${height}" fill="#fff"/>`);

  out.push(`<text x="${margin}" y="22" font-size="12" font-weight="700" fill="#111">${
    esc(stripLocaleTags(template?.name) || 'Template')}</text>`);
  out.push(`<text x="${width - margin}" y="22" font-size="9" text-anchor="end" fill="#666">${
    esc(`${tier} · ${branch.series.length} in series · ${branch.instruments.length} instrument(s)`
      + (branch.shunts.length ? ` · ${branch.shunts.length} to earth` : ''))}</text>`);

  // An MV cell is drawn from its type even before it has parts — a riser or
  // a dummy may never have any.
  if (chain.length === 0 && !(mvSize && mvOpts.cellType)) {
    out.push(`<text x="${margin}" y="${top + 20}" font-size="11" fill="#888">` +
      `No parts in this template yet.</text>`);
    out.push('</svg>');
    return { svg: out.join('\n'), width, height, devices: 0 };
  }

  // Where it hangs from, and what it feeds. A dummy and the neutral panel
  // hang from nothing on the busbar.
  if (!(mvSize && mvOffBus(mvOpts))) {
    out.push(line(x, top - stub, x, top, 1.3));
    out.push(`<path d="M ${x - 6} ${top - stub + 11} L ${x} ${top - stub} L ${x + 6} ${top - stub + 11} Z" fill="#111"/>`);
    out.push(`<text x="${x + 10}" y="${top - stub + 9}" font-size="8.5" fill="#666">from the busbar</text>`);
  }
  // An LV single line says what it carries: a slash across the line at the
  // top, and beside it 1PH+N, 3 or 4.
  const phases = lvCell ? template?.singleLine?.phases : undefined;
  if (phases) out.push(phaseTick(x, top - 7, phases));

  out.push(drawn.svg);

  const mvEnd = mvSize ? mvEndOf(mvOpts) : 'outgoing';
  if (mvSize && mvEnd !== 'outgoing') {
    // The cell's own ending — a riser's bar, a cable sealing end, nothing.
    if (mvEnd === 'coupling' || mvEnd === 'riser') {
      out.push(line(x, bottom, x, bottom + 12, 1.3));
      out.push(line(x, bottom + 12, x + (mvEnd === 'coupling' ? 40 : -40), bottom + 12, 2.2));
      out.push(`<text x="${x + 10}" y="${bottom + 26}" font-size="8.5" fill="#666">${
        mvEnd === 'coupling' ? 'bar connection to the riser' : 'bar connection to the coupling'}</text>`);
    } else {
      out.push(drawMvEnd(mvEnd, x, bottom, mvOpts, false));
    }
  } else {
    out.push(line(x, bottom, x, bottom + stub, 1.3));
    out.push(`<path d="M ${x - 6} ${bottom + stub - 11} L ${x} ${bottom + stub} L ${x + 6} ${bottom + stub - 11} Z" fill="#111"/>`);
    out.push(`<text x="${x + 10}" y="${bottom + stub - 2}" font-size="8.5" fill="#666">to the load</text>`);
  }

  out.push('</svg>');
  return { svg: out.join('\n'), width, height, devices: chain.length };
}

/** The slash across a single line, and what it carries: 1PH+N, 3 or 4. */
function phaseTick(x: number, y: number, phases: string): string {
  const mark = phases === '1PH+N' ? '1PH+N' : phases === '3PH' ? '3' : '4';
  return `<line x1="${x - 6}" y1="${y + 5}" x2="${x + 6}" y2="${y - 5}" stroke="#111" stroke-width="1.2"/>` +
    `<text x="${x + 9}" y="${y + 4}" font-size="9" font-weight="600" fill="#111">${esc(mark)}</text>`;
}

// ── LV multi-line ───────────────────────────────────────────────────────────
//
// Every conductor drawn: L1, L2, L3 (or L for single phase), N, and PE — or
// the PEN, neutral and earth in one, on a TN-C system. A switching device is
// drawn on each conductor it switches, its poles joined by the dashed line of
// its mechanism; a CT on each phase; the core-balance CT round every live
// conductor. Whatever hangs beside the line (meters, relays, arresters) is
// drawn in a column to the right, fed from the device it hangs on.

const GAP = 44;
/** Switching devices: drawn on every pole, their mechanism joining them. */
const MULTIPOLE = new Set<SymbolId>([
  'circuit-breaker', 'mcb', 'withdrawable-cb', 'motor-starter', 'switch-disconnector', 'disconnector',
  'contactor', 'switch-fuse', 'fuse', 'hrc-fuse', 'thermal-overload', 'ats', 'vcb', 'vcb-racking',
]);

/** The conductors a feeder has, left to right. */
function conductorsOf(sl: TemplateSingleLine): string[] {
  const ph = sl.phases ?? '3PH+N';
  const live = ph === '1PH+N' ? ['L'] : ['L1', 'L2', 'L3'];
  const neutral = ph !== '3PH';
  if (sl.pen) return [...live, 'PEN'];
  return [...live, ...(neutral ? ['N'] : []), 'PE'];
}

/** Which conductors a device switches: its poles, else every phase. */
function polesOf(item: ChainItem, conductors: string[]): string[] {
  const live = conductors.filter(c => c.startsWith('L'));
  const n = conductors.find(c => c === 'N' || c === 'PEN');
  const p = item.sld?.poles;
  if (!p) return live;
  if (p === '1P') return live.slice(0, 1);
  if (p === '1P+N' || p === '2P') return p === '2P' && live.length > 1 ? live.slice(0, 2) : [live[0], ...(n ? [n] : [])];
  if (p === '3P') return live;
  return [...live, ...(n ? [n] : [])];
}

function buildLvMultiLineSvg(
  template: TemplateLike, chain: ChainItem[],
): { svg: string; width: number; height: number; devices: number } {
  const ln = (x1: number, y1: number, x2: number, y2: number, w = 1.3, dash = '') => rawLine(x1, y1, x2, y2, w, dash);
  const sl = template.singleLine ?? {};
  const branch = splitBranch(chain);
  const conductors = conductorsOf(sl);
  const margin = 30;
  const x0 = margin + 40;
  const xs = conductors.map((_, k) => x0 + k * GAP);
  const xOf = (c: string) => xs[conductors.indexOf(c)];
  const lastX = xs[xs.length - 1];
  const textX = lastX + 34;
  const colX = textX + 210;
  const top = 70;
  const out: string[] = [];
  const body: string[] = [];

  // The power path, device by device.
  let y = top;
  const rowY: number[] = [];
  for (const item of branch.series) {
    rowY.push(y);
    const on = item.id === 'core-balance-ct' ? [] : MULTIPOLE.has(item.id) ? polesOf(item, conductors)
      : item.id === 'current-transformer' ? conductors.filter(c => c.startsWith('L'))
      : conductors.slice(0, 1);
    const h = Math.max(stepFor(item), CELL);
    // Conductors it does not cut pass straight by.
    conductors.forEach(c => {
      if (!on.includes(c)) body.push(ln(xOf(c), y, xOf(c), y + h, c === 'PE' ? 1 : 1.3));
    });
    on.forEach(c => {
      body.push(drawDevice(item, xOf(c), y));
      if (h > CELL) body.push(ln(xOf(c), y + CELL, xOf(c), y + h, 1.3));
    });
    // A core-balance CT: one ring round every live conductor.
    if (item.id === 'core-balance-ct') {
      const live = conductors.filter(c => c !== 'PE');
      const a = xOf(live[0]) - 10, b = xOf(live[live.length - 1]) + 10;
      body.push(`<ellipse cx="${(a + b) / 2}" cy="${y + HALF}" rx="${(b - a) / 2}" ry="7" fill="none" stroke="#111" stroke-width="1.2"/>`);
    }
    // The mechanism joining the poles.
    if (on.length > 1 && MULTIPOLE.has(item.id)) {
      body.push(ln(xOf(on[0]) + 6, y + HALF, xOf(on[on.length - 1]) + 6, y + HALF, 0.9, '4 3'));
    }
    body.push(deviceText(item, textX, y));
    y += h;
  }
  const bottom = Math.max(y, top + CELL);

  // Beside the line: shunts and instruments, in a column, fed from the
  // device they hang on (dashed for control wiring).
  const side = [...branch.shunts, ...branch.instruments];
  side.forEach((item, k) => {
    const sy = top + k * (CELL + 10);
    body.push(drawDevice(item, colX, sy));
    body.push(deviceText(item, colX + labelOffset(item), sy));
    const feed = branch.instruments.indexOf(item);
    const source = feed >= 0 ? branch.fedBy[feed] : branch.shuntAfter[branch.shunts.indexOf(item)];
    const fy = source != null && source >= 0 ? rowY[source] + HALF : top;
    body.push(ln(lastX + 6, fy, colX - 18, fy, 0.8, '3 3'));
    body.push(ln(colX - 18, fy, colX - 18, sy + HALF, 0.8, '3 3'));
    body.push(ln(colX - 18, sy + HALF, colX - 2, sy + HALF, 0.8, '3 3'));
  });
  const sideBottom = top + side.length * (CELL + 10);

  const end = Math.max(bottom, sideBottom) + 30;
  const width = Math.max(colX + 200, textX + 260) + margin;
  const height = end + 40;
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}" font-family="Segoe UI, Arial, sans-serif">`);
  out.push(`<rect width="${width}" height="${height}" fill="#fff"/>`);
  out.push(`<text x="${margin}" y="22" font-size="12" font-weight="700" fill="#111">${
    esc(stripLocaleTags(template.name) || 'Template')}</text>`);
  out.push(`<text x="${width - margin}" y="22" font-size="9" text-anchor="end" fill="#666">${
    esc(`LV · multi-line · ${sl.phases ?? '3PH+N'}${sl.pen ? ' · PEN' : ''} · ${branch.series.length} in series`)}</text>`);

  // From the busbar and to the load, every conductor, named at both ends.
  conductors.forEach((c, k) => {
    const cx = xs[k];
    out.push(ln(cx, top - 26, cx, top, 1.3));
    out.push(`<text x="${cx}" y="${top - 30}" font-size="9" font-weight="600" text-anchor="middle" fill="#111">${c}</text>`);
    if (!branch.series.length) out.push(ln(cx, top, cx, bottom, 1.3));
    out.push(ln(cx, bottom, cx, end, 1.3));
    if (c !== 'PE' && c !== 'PEN') {
      out.push(`<path d="M ${cx - 5} ${end - 9} L ${cx} ${end} L ${cx + 5} ${end - 9} Z" fill="#111"/>`);
    } else {
      // The protective conductor ends on its earth mark.
      out.push(ln(cx - 8, end, cx + 8, end, 1.3) + ln(cx - 5, end + 3, cx + 5, end + 3, 1.1) + ln(cx - 2, end + 6, cx + 2, end + 6, 1));
    }
  });
  out.push(`<text x="${lastX + 12}" y="${top - 16}" font-size="8.5" fill="#666">from the busbar</text>`);
  out.push(`<text x="${lastX + 12}" y="${end - 2}" font-size="8.5" fill="#666">to the load</text>`);
  out.push(...body);
  if (!chain.length) {
    out.push(`<text x="${textX}" y="${top + 20}" font-size="11" fill="#888">No parts in this template yet.</text>`);
  }
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
