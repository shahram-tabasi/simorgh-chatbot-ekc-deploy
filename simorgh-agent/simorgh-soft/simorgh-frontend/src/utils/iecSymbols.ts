// src/utils/iecSymbols.ts
//
// The IEC single-line symbol library.
//
// Every symbol is drawn to the same cell so they stack on a branch without
// thinking about it:
//
//   · the branch line runs vertically through x
//   · the cell is CELL tall: it is entered at (x, y) and left at (x, y + CELL)
//   · the symbol occupies the middle of that cell, and whatever sticks out
//     sideways (a CT's secondary, a relay box) goes to the right, where the
//     device tag and code are written.
//
// Shapes follow IEC 60617 as it is drawn on a single line:
//
//   disconnector        an open blade between two contacts
//   switch-disconnector the blade with the load-break bar on the fixed contact
//   circuit breaker     the blade with the cross on the fixed contact
//   contactor           the open contact with the small rectangle on it
//   thermal overload    a rectangle with the half-split square inside it
//   fuse                a rectangle across the line
//   current transformer one circle sitting on the line, secondary to the side
//   voltage transformer two interlocking circles, secondary to the side
//   transformer         two interlocking circles, in the line
//   meters              a circle carrying A, V, W, kWh…
//   motor / generator   a circle carrying M or G
//
// Nothing here knows about projects or parts: it draws symbols. What each
// part *is* — and therefore which symbol it gets — is decided in
// eplanSingleLine.ts from EPLAN's own function definition.

export const CELL = 40;          // height of one symbol on a branch
export const HALF = CELL / 2;

export type SymbolId =
  | 'disconnector' | 'switch-disconnector' | 'circuit-breaker' | 'withdrawable-cb'
  | 'contactor' | 'thermal-overload' | 'fuse' | 'switch-fuse' | 'motor-starter'
  | 'current-transformer' | 'core-balance-ct' | 'voltage-transformer' | 'transformer'
  | 'ammeter' | 'voltmeter' | 'multimeter' | 'transducer'
  | 'protection-relay' | 'earth-fault-relay' | 'selector-switch'
  | 'surge-arrester' | 'capacitor' | 'drive' | 'soft-starter'
  | 'motor' | 'generator' | 'heater' | 'lamp' | 'socket'
  | 'terminal' | 'test-block' | 'earthing-switch' | 'link'
  | 'outgoing' | 'incoming' | 'accessory';

export interface IecSymbol {
  id: SymbolId;
  title: string;
  titleFa: string;
  group: 'Switching' | 'Protection' | 'Measuring' | 'Loads' | 'Connections';
  /** SVG for one symbol, entered at (x, y), left at (x, y + CELL). */
  draw: (x: number, y: number) => string;
}

const S = '#111';
const line = (x1: number, y1: number, x2: number, y2: number, w = 1.3) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${S}" stroke-width="${w}"/>`;
const circle = (cx: number, cy: number, r: number, fill = 'none', w = 1.3) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${S}" stroke-width="${w}"/>`;
const rect = (x: number, y: number, w: number, h: number, fill = '#fff', sw = 1.3) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${S}" stroke-width="${sw}"/>`;
const dot = (cx: number, cy: number, r = 1.9) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${S}"/>`;
const text = (x: number, y: number, s: string, size = 9, anchor = 'middle') =>
  `<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" fill="${S}" font-family="Segoe UI, Arial, sans-serif">${s}</text>`;

// The two contacts of a switching device sit at a third and two thirds of the
// cell, and the blade opens to the right between them — the geometry every
// switch in the library shares.
const CONTACT_TOP = 12;
const CONTACT_BOTTOM = 28;
const BLADE_X = 13;

const switchBody = (x: number, y: number) => [
  line(x, y, x, y + CONTACT_TOP),
  dot(x, y + CONTACT_TOP),
  line(x, y + CONTACT_TOP, x + BLADE_X, y + CONTACT_BOTTOM - 2, 1.5),   // the blade
  dot(x, y + CONTACT_BOTTOM),
  line(x, y + CONTACT_BOTTOM, x, y + CELL),
].join('');

// A cross on the fixed contact — what makes a switch a circuit breaker.
const breakerCross = (x: number, y: number) => [
  line(x - 5, y + CONTACT_BOTTOM - 5, x + 5, y + CONTACT_BOTTOM + 5, 1.5),
  line(x + 5, y + CONTACT_BOTTOM - 5, x - 5, y + CONTACT_BOTTOM + 5, 1.5),
].join('');

// Two interlocking circles: a transformer's windings, and a VT's.
const interlocking = (cx: number, cy: number, r = 8) =>
  circle(cx, cy - r * 0.55, r) + circle(cx, cy + r * 0.55, r);

const meter = (x: number, y: number, letter: string) => [
  line(x, y, x, y + CELL),
  circle(x + 13, y + HALF, 9, '#fff'),
  text(x + 13, y + HALF + 3.5, letter, 9),
  line(x, y + HALF, x + 4, y + HALF, 1),
].join('');

export const IEC_SYMBOLS: Record<SymbolId, IecSymbol> = {
  // ── Switching ────────────────────────────────────────────────────────
  disconnector: {
    id: 'disconnector', title: 'Disconnector / isolator', titleFa: 'سکسیونر',
    group: 'Switching',
    draw: (x, y) => switchBody(x, y),
  },
  'switch-disconnector': {
    id: 'switch-disconnector', title: 'Switch disconnector (load break)', titleFa: 'کلید قابل قطع زیر بار',
    group: 'Switching',
    draw: (x, y) => switchBody(x, y) +
      line(x - 6, y + CONTACT_BOTTOM, x + 6, y + CONTACT_BOTTOM, 2.4),
  },
  'circuit-breaker': {
    id: 'circuit-breaker', title: 'Circuit breaker', titleFa: 'کلید اتوماتیک',
    group: 'Switching',
    draw: (x, y) => switchBody(x, y) + breakerCross(x, y),
  },
  'withdrawable-cb': {
    id: 'withdrawable-cb', title: 'Withdrawable circuit breaker', titleFa: 'کلید کشویی',
    group: 'Switching',
    draw: (x, y) => switchBody(x, y) + breakerCross(x, y) +
      // the drawout contacts, a bracket each side of the device
      line(x - 11, y + 8, x - 11, y + CELL - 8, 1) +
      line(x - 11, y + 8, x - 7, y + 8, 1) +
      line(x - 11, y + CELL - 8, x - 7, y + CELL - 8, 1),
  },
  contactor: {
    id: 'contactor', title: 'Contactor', titleFa: 'کنتاکتور',
    group: 'Switching',
    // An open contact with the small rectangle on the fixed contact.
    draw: (x, y) => [
      line(x, y, x, y + CONTACT_TOP),
      dot(x, y + CONTACT_TOP),
      line(x, y + CONTACT_TOP, x + BLADE_X, y + CONTACT_BOTTOM - 2, 1.5),
      rect(x - 6, y + CONTACT_BOTTOM - 3, 12, 6),
      line(x, y + CONTACT_BOTTOM + 3, x, y + CELL),
    ].join(''),
  },
  'motor-starter': {
    id: 'motor-starter', title: 'Motor starter (CB + contactor)', titleFa: 'راه‌انداز موتور',
    group: 'Switching',
    draw: (x, y) => switchBody(x, y) + breakerCross(x, y) +
      rect(x - 6, y + CONTACT_BOTTOM + 5, 12, 5),
  },
  'earthing-switch': {
    id: 'earthing-switch', title: 'Earthing switch', titleFa: 'کلید ارت',
    group: 'Switching',
    draw: (x, y) => [
      line(x, y, x, y + CONTACT_TOP),
      dot(x, y + CONTACT_TOP),
      line(x, y + CONTACT_TOP, x + BLADE_X, y + CONTACT_BOTTOM - 2, 1.5),
      line(x - 7, y + CONTACT_BOTTOM, x + 7, y + CONTACT_BOTTOM, 1.6),
      line(x - 4.5, y + CONTACT_BOTTOM + 4, x + 4.5, y + CONTACT_BOTTOM + 4, 1.4),
      line(x - 2, y + CONTACT_BOTTOM + 8, x + 2, y + CONTACT_BOTTOM + 8, 1.2),
    ].join(''),
  },
  link: {
    id: 'link', title: 'Link / busbar riser', titleFa: 'رابط',
    group: 'Connections',
    draw: (x, y) => line(x, y, x, y + CELL),
  },

  // ── Protection ───────────────────────────────────────────────────────
  fuse: {
    id: 'fuse', title: 'Fuse', titleFa: 'فیوز',
    group: 'Protection',
    draw: (x, y) => [
      line(x, y, x, y + 11),
      rect(x - 6, y + 11, 12, 18),
      line(x, y + 11, x, y + 29, 1),
      line(x, y + 29, x, y + CELL),
    ].join(''),
  },
  'switch-fuse': {
    id: 'switch-fuse', title: 'Switch fuse', titleFa: 'کلید فیوزدار',
    group: 'Protection',
    draw: (x, y) => [
      line(x, y, x, y + 8),
      dot(x, y + 8),
      line(x, y + 8, x + BLADE_X, y + 20, 1.5),
      rect(x - 6, y + 22, 12, 14),
      line(x, y + 36, x, y + CELL),
    ].join(''),
  },
  'thermal-overload': {
    id: 'thermal-overload', title: 'Thermal overload relay (bimetal)', titleFa: 'بی‌متال (رله حرارتی)',
    group: 'Protection',
    // A rectangle with the square split across its middle inside it.
    draw: (x, y) => [
      line(x, y, x, y + 8),
      rect(x - 10, y + 8, 20, 24),
      rect(x - 5, y + 14, 10, 12, 'none', 1.1),
      line(x - 5, y + 20, x + 5, y + 20, 1.1),
      `<rect x="${x - 5}" y="${y + 20}" width="10" height="6" fill="${S}"/>`,
      line(x, y + 32, x, y + CELL),
    ].join(''),
  },
  'protection-relay': {
    id: 'protection-relay', title: 'Protection relay', titleFa: 'رله حفاظتی',
    group: 'Protection',
    draw: (x, y) => [
      line(x, y, x, y + CELL),
      rect(x + 4, y + 9, 22, 22),
      text(x + 15, y + HALF + 4, 'I&gt;', 9),
      line(x, y + HALF, x + 4, y + HALF, 1),
    ].join(''),
  },
  'earth-fault-relay': {
    id: 'earth-fault-relay', title: 'Earth fault relay', titleFa: 'رله ارت فالت',
    group: 'Protection',
    draw: (x, y) => [
      line(x, y, x, y + CELL),
      rect(x + 4, y + 9, 22, 22),
      text(x + 15, y + HALF + 4, 'I₀&gt;', 8),
      line(x, y + HALF, x + 4, y + HALF, 1),
    ].join(''),
  },
  'surge-arrester': {
    id: 'surge-arrester', title: 'Surge arrester', titleFa: 'برقگیر',
    group: 'Protection',
    draw: (x, y) => [
      line(x, y, x, y + 8),
      rect(x - 7, y + 8, 14, 18),
      line(x - 4, y + 12, x + 4, y + 22, 1.4),
      `<path d="M ${x + 4} ${y + 22} l -3 -1 l 0.5 3 Z" fill="${S}"/>`,
      line(x, y + 26, x, y + 30),
      line(x - 7, y + 30, x + 7, y + 30, 1.6),
      line(x - 4.5, y + 34, x + 4.5, y + 34, 1.4),
      line(x - 2, y + 38, x + 2, y + 38, 1.2),
    ].join(''),
  },

  // ── Measuring ────────────────────────────────────────────────────────
  'current-transformer': {
    id: 'current-transformer', title: 'Current transformer', titleFa: 'ترانس جریان (CT)',
    group: 'Measuring',
    // One circle sitting on the line, with the secondary drawn to the side.
    draw: (x, y) => [
      line(x, y, x, y + CELL),
      circle(x, y + HALF, 8),
      line(x + 8, y + HALF, x + 18, y + HALF, 1),
      dot(x + 18, y + HALF, 1.6),
    ].join(''),
  },
  'core-balance-ct': {
    id: 'core-balance-ct', title: 'Core balance CT', titleFa: 'CT کر بالانس',
    group: 'Measuring',
    draw: (x, y) => [
      line(x, y, x, y + CELL),
      circle(x, y + HALF, 10),
      circle(x, y + HALF, 6, 'none', 1),
      line(x + 10, y + HALF, x + 18, y + HALF, 1),
    ].join(''),
  },
  'voltage-transformer': {
    id: 'voltage-transformer', title: 'Voltage transformer (PT/VT)', titleFa: 'ترانس ولتاژ (PT)',
    group: 'Measuring',
    // Two interlocking circles — primary on the line, secondary to the side.
    draw: (x, y) => [
      line(x, y, x, y + 6),
      interlocking(x, y + HALF + 2),
      line(x + 9, y + HALF + 2, x + 18, y + HALF + 2, 1),
      dot(x + 18, y + HALF + 2, 1.6),
      line(x, y + CELL - 3, x, y + CELL),
    ].join(''),
  },
  ammeter: {
    id: 'ammeter', title: 'Ammeter', titleFa: 'آمپرمتر',
    group: 'Measuring', draw: (x, y) => meter(x, y, 'A'),
  },
  voltmeter: {
    id: 'voltmeter', title: 'Voltmeter', titleFa: 'ولت‌متر',
    group: 'Measuring', draw: (x, y) => meter(x, y, 'V'),
  },
  multimeter: {
    id: 'multimeter', title: 'Multimeter / power meter', titleFa: 'مولتی‌متر',
    group: 'Measuring', draw: (x, y) => meter(x, y, 'kW'),
  },
  transducer: {
    id: 'transducer', title: 'Transducer', titleFa: 'ترانسدیوسر',
    group: 'Measuring',
    draw: (x, y) => [
      line(x, y, x, y + CELL),
      rect(x + 4, y + 11, 20, 18),
      line(x + 9, y + 25, x + 19, y + 15, 1.2),
      line(x, y + HALF, x + 4, y + HALF, 1),
    ].join(''),
  },
  'selector-switch': {
    id: 'selector-switch', title: 'Selector switch', titleFa: 'سلکتور سوییچ',
    group: 'Measuring',
    draw: (x, y) => [
      line(x, y, x, y + CONTACT_TOP),
      dot(x, y + CONTACT_TOP),
      line(x, y + CONTACT_TOP, x + BLADE_X, y + CONTACT_BOTTOM - 2, 1.4),
      dot(x + BLADE_X, y + CONTACT_TOP + 1, 1.5),
      dot(x + BLADE_X, y + CONTACT_BOTTOM - 2, 1.5),
      line(x, y + CONTACT_BOTTOM, x, y + CELL),
    ].join(''),
  },
  'test-block': {
    id: 'test-block', title: 'Test block', titleFa: 'ترمینال تست',
    group: 'Connections',
    draw: (x, y) => [
      line(x, y, x, y + 12),
      rect(x - 8, y + 12, 16, 16, '#fff', 1.1),
      circle(x, y + 20, 3, '#fff', 1),
      line(x, y + 28, x, y + CELL),
    ].join(''),
  },
  terminal: {
    id: 'terminal', title: 'Terminal', titleFa: 'ترمینال',
    group: 'Connections',
    draw: (x, y) => line(x, y, x, y + CELL) + circle(x, y + HALF, 3.5, '#fff', 1.1),
  },

  // ── Loads and converters ─────────────────────────────────────────────
  capacitor: {
    id: 'capacitor', title: 'Capacitor', titleFa: 'خازن',
    group: 'Loads',
    draw: (x, y) => [
      line(x, y, x, y + 16),
      line(x - 9, y + 16, x + 9, y + 16, 1.8),
      line(x - 9, y + 22, x + 9, y + 22, 1.8),
      line(x, y + 22, x, y + CELL),
    ].join(''),
  },
  drive: {
    id: 'drive', title: 'Frequency converter', titleFa: 'درایو (اینورتر)',
    group: 'Loads',
    draw: (x, y) => [
      line(x, y, x, y + 8),
      rect(x - 12, y + 8, 24, 24),
      line(x - 7, y + 27, x + 7, y + 13, 1.2),
      text(x - 7, y + 16, '~', 9, 'start'),
      text(x + 3, y + 30, '=', 9, 'start'),
      line(x, y + 32, x, y + CELL),
    ].join(''),
  },
  'soft-starter': {
    id: 'soft-starter', title: 'Soft starter', titleFa: 'سافت استارتر',
    group: 'Loads',
    draw: (x, y) => [
      line(x, y, x, y + 8),
      rect(x - 12, y + 8, 24, 24),
      `<path d="M ${x - 7} ${y + 27} q 7 -14 14 -14" fill="none" stroke="${S}" stroke-width="1.2"/>`,
      line(x, y + 32, x, y + CELL),
    ].join(''),
  },
  transformer: {
    id: 'transformer', title: 'Power transformer', titleFa: 'ترانسفورماتور',
    group: 'Loads',
    draw: (x, y) => [
      line(x, y, x, y + 6),
      interlocking(x, y + HALF, 9),
      line(x, y + CELL - 6, x, y + CELL),
    ].join(''),
  },
  motor: {
    id: 'motor', title: 'Motor', titleFa: 'موتور',
    group: 'Loads',
    draw: (x, y) => [
      line(x, y, x, y + 8),
      circle(x, y + 24, 12, '#fff', 1.4),
      text(x, y + 28, 'M', 11),
    ].join(''),
  },
  generator: {
    id: 'generator', title: 'Generator', titleFa: 'ژنراتور',
    group: 'Loads',
    draw: (x, y) => [
      line(x, y, x, y + 8),
      circle(x, y + 24, 12, '#fff', 1.4),
      text(x, y + 28, 'G', 11),
    ].join(''),
  },
  heater: {
    id: 'heater', title: 'Heater', titleFa: 'المنت حرارتی',
    group: 'Loads',
    draw: (x, y) => [
      line(x, y, x, y + 10),
      rect(x - 10, y + 10, 20, 20),
      line(x - 5, y + 16, x + 5, y + 16, 1.2),
      line(x - 5, y + 20, x + 5, y + 20, 1.2),
      line(x - 5, y + 24, x + 5, y + 24, 1.2),
      line(x, y + 30, x, y + CELL),
    ].join(''),
  },
  lamp: {
    id: 'lamp', title: 'Lighting', titleFa: 'روشنایی',
    group: 'Loads',
    draw: (x, y) => [
      line(x, y, x, y + 10),
      circle(x, y + 22, 10, '#fff'),
      line(x - 7, y + 15, x + 7, y + 29, 1.2),
      line(x + 7, y + 15, x - 7, y + 29, 1.2),
    ].join(''),
  },
  socket: {
    id: 'socket', title: 'Socket outlet', titleFa: 'پریز',
    group: 'Loads',
    draw: (x, y) => [
      line(x, y, x, y + 16),
      `<path d="M ${x - 10} ${y + 26} a 10 10 0 0 1 20 0" fill="none" stroke="${S}" stroke-width="1.4"/>`,
      line(x - 10, y + 26, x + 10, y + 26, 1.4),
    ].join(''),
  },

  // ── Connections ──────────────────────────────────────────────────────
  outgoing: {
    id: 'outgoing', title: 'Outgoing feeder', titleFa: 'خروجی',
    group: 'Connections',
    draw: (x, y) => line(x, y, x, y + 26) +
      `<path d="M ${x - 6} ${y + 24} L ${x} ${y + 36} L ${x + 6} ${y + 24} Z" fill="${S}"/>`,
  },
  incoming: {
    id: 'incoming', title: 'Incoming supply', titleFa: 'ورودی',
    group: 'Connections',
    draw: (x, y) => line(x, y + 14, x, y + CELL) +
      `<path d="M ${x - 6} ${y + 16} L ${x} ${y + 4} L ${x + 6} ${y + 16} Z" fill="${S}"/>`,
  },
  accessory: {
    id: 'accessory', title: 'Accessory (not a device on the line)', titleFa: 'متعلقات',
    group: 'Connections',
    // Accessories belong to the device above them; on the line they are a
    // note, not a symbol of their own.
    draw: (x, y) => line(x, y, x, y + CELL) +
      `<rect x="${x + 5}" y="${y + 14}" width="12" height="12" fill="#fff" stroke="${S}" stroke-width="1" stroke-dasharray="3 2"/>`,
  },
};

export const SYMBOL_GROUPS: IecSymbol['group'][] =
  ['Switching', 'Protection', 'Measuring', 'Loads', 'Connections'];

/** One symbol, drawn on its own with the branch line through it. */
export function drawIecSymbol(id: SymbolId, x: number, y: number): string {
  return (IEC_SYMBOLS[id] ?? IEC_SYMBOLS.link).draw(x, y);
}

/** The whole library as a printable/previewable sheet. */
export function buildSymbolCatalogueSvg(perRow = 6): string {
  const cellW = 150;
  const cellH = 96;
  const out: string[] = [];
  let y = 30;
  let width = perRow * cellW + 40;

  for (const group of SYMBOL_GROUPS) {
    const symbols = Object.values(IEC_SYMBOLS).filter(s => s.group === group);
    out.push(`<text x="20" y="${y}" font-size="12" font-weight="700" fill="${S}" font-family="Segoe UI, Arial, sans-serif">${group}</text>`);
    y += 14;
    symbols.forEach((symbol, i) => {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const cx = 20 + col * cellW + cellW / 2;
      const cy = y + row * cellH;
      out.push(`<rect x="${20 + col * cellW}" y="${cy}" width="${cellW - 8}" height="${cellH - 8}" fill="#fff" stroke="#e5e7eb"/>`);
      out.push(symbol.draw(cx - 20, cy + 12));
      out.push(`<text x="${20 + col * cellW + 8}" y="${cy + cellH - 22}" font-size="9" fill="#111" font-family="Segoe UI, Arial, sans-serif">${symbol.title}</text>`);
      out.push(`<text x="${20 + col * cellW + 8}" y="${cy + cellH - 11}" font-size="9" fill="#666" font-family="Segoe UI, Arial, sans-serif" direction="rtl">${symbol.titleFa}</text>`);
    });
    y += Math.ceil(symbols.length / perRow) * cellH + 16;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${y}" width="${width}" height="${y}">` +
    `<rect width="${width}" height="${y}" fill="#fff"/>${out.join('')}</svg>`;
}
