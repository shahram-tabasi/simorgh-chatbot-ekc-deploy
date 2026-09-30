// src/utils/iecSymbols.ts
//
// The single-line symbol library, drawn from the office's own legend sheet
// (the "SYMBOL / DESCRIPTION" table on sheet 14 of the SLD set) rather than
// from a generic IEC list — so a drawing this app produces carries the same
// symbols as the drawings the office already issues.
//
// Every symbol is drawn to the same cell so they stack on a branch without
// thinking about it:
//
//   · the branch line runs vertically through x
//   · the cell is CELL tall: entered at (x, y), left at (x, y + CELL)
//   · anything that reaches sideways — a CT's secondary, a meter box — goes
//     to the right, where the device tag and its code are written.
//
// The shapes that matter, as the legend draws them:
//
//   V.C.B                 isolating contacts top and bottom, the blade
//                         between them, the trip cross beside it
//   V.C with HRC fuse     the same contacts, the fuse, the contactor arc
//   HRC fuse              a rectangle with the diagonal through it
//   MCB                   the hooked blade with the arrow
//   current transformer   one circle on the line, secondary to the side
//   core balance CT       an ellipse with the three phases through it
//   two-winding VT        interlocking circles with their star points
//   meters                a square carrying A, V, M, W, VAR, COSφ…
//   kWh / kVArh           a box with its band across the top
//   surge limiter         a box with the cross; arrester, the filled triangle
//   annunciator           the window grid

export const CELL = 40;
export const HALF = CELL / 2;

export type SymbolId =
  // switching
  | 'vcb' | 'vcb-racking' | 'vacuum-contactor-fuse' | 'circuit-breaker' | 'withdrawable-cb'
  | 'disconnector' | 'switch-disconnector' | 'contactor' | 'motor-starter'
  | 'earthing-switch' | 'mcb' | 'ats'
  // protection
  | 'hrc-fuse' | 'fuse' | 'switch-fuse' | 'thermal-overload' | 'protection-relay'
  | 'earth-fault-relay' | 'surge-arrester' | 'surge-limiter' | 'ptc'
  // measuring
  | 'current-transformer' | 'core-balance-ct' | 'voltage-transformer' | 'transformer'
  | 'ammeter' | 'voltmeter' | 'multimeter' | 'watt-meter' | 'var-meter'
  | 'power-factor-meter' | 'frequency-meter' | 'hour-meter' | 'kwh-meter' | 'kvarh-meter'
  | 'transducer' | 'selector-switch' | 'voltage-selector' | 'ampere-selector'
  | 'capacitive-divider'
  // loads and signalling
  | 'motor' | 'generator' | 'heater' | 'lamp' | 'socket' | 'capacitor' | 'capacitor-delta'
  | 'drive' | 'soft-starter' | 'magnet' | 'alarm-annunciator' | 'lcs'
  // connections
  | 'terminal' | 'test-block' | 'key-interlock' | 'mechanical-interlock'
  | 'bus-duct' | 'link' | 'outgoing' | 'incoming' | 'accessory';

export interface IecSymbol {
  id: SymbolId;
  title: string;
  titleFa: string;
  group: 'Switching' | 'Protection' | 'Measuring' | 'Loads' | 'Connections';
  draw: (x: number, y: number) => string;
}

const S = '#111';
const ln = (x1: number, y1: number, x2: number, y2: number, w = 1.2) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${S}" stroke-width="${w}"/>`;
const circ = (cx: number, cy: number, r: number, fill = 'none', w = 1.2) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${S}" stroke-width="${w}"/>`;
const box = (x: number, y: number, w: number, h: number, fill = '#fff', sw = 1.2) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${S}" stroke-width="${sw}"/>`;
const solid = (x: number, y: number, w: number, h: number) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${S}"/>`;
const dot = (cx: number, cy: number, r = 1.6) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${S}"/>`;
const path = (d: string, w = 1.2, fill = 'none') =>
  `<path d="${d}" fill="${fill}" stroke="${S}" stroke-width="${w}"/>`;
const esc = (s: string) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const txt = (x: number, y: number, s: string, size = 8, anchor = 'middle') =>
  `<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" fill="${S}" font-family="Segoe UI, Arial, sans-serif">${s}</text>`;

// The withdrawable isolating contact the legend puts above and below a
// vacuum device: a filled bar with the contact arc over it.
const isolatorTop = (x: number, y: number) =>
  path(`M ${x - 4} ${y + 6} a 4 4 0 0 1 8 0`, 1.2) + solid(x - 2, y + 6, 4, 7) + ln(x, y + 13, x, y + 15);
const isolatorBottom = (x: number, y: number) =>
  ln(x, y + CELL - 15, x, y + CELL - 13) + solid(x - 2, y + CELL - 13, 4, 7) +
  path(`M ${x - 4} ${y + CELL - 6} a 4 4 0 0 0 8 0`, 1.2);

// A meter is a square carrying its letters, tapped off the line.
const meterBox = (x: number, y: number, label: string, size = 8) => [
  ln(x, y, x, y + CELL),
  ln(x, y + HALF, x + 6, y + HALF),
  box(x + 6, y + HALF - 9, 22, 18),
  txt(x + 17, y + HALF + 3.5, label, size),
].join('');

// kWh and kVArh meters carry a band across the top of the box.
const energyMeter = (x: number, y: number, label: string) => [
  ln(x, y, x, y + CELL),
  ln(x, y + HALF, x + 5, y + HALF),
  box(x + 5, y + 6, 26, 28),
  ln(x + 5, y + 13, x + 31, y + 13, 1),
  txt(x + 18, y + 27, label, 7.5),
].join('');

// Star point, as the legend draws inside a transformer winding.
const star = (cx: number, cy: number, r = 4) => [
  ln(cx, cy, cx, cy + r, 1),
  ln(cx, cy, cx - r * 0.87, cy - r * 0.5, 1),
  ln(cx, cy, cx + r * 0.87, cy - r * 0.5, 1),
].join('');

export const IEC_SYMBOLS: Record<SymbolId, IecSymbol> = {
  // ── Switching ────────────────────────────────────────────────────────
  vcb: {
    id: 'vcb', title: 'Vacuum circuit breaker (V.C.B)', titleFa: 'کلید وکیوم',
    group: 'Switching',
    // As the legend draws it: the fixed contact ends at the trip cross, and
    // the blade stands open to the upper left, closing onto the line below.
    draw: (x, y) => [
      isolatorTop(x, y),
      ln(x - 10, y + 13, x, y + 25, 1.4),         // the blade
      ln(x + 1.5, y + 12, x + 6.5, y + 17, 1.3),  // the trip cross, on the line
      ln(x + 6.5, y + 12, x + 1.5, y + 17, 1.3),
      dot(x, y + 25),
      isolatorBottom(x, y),
    ].join(''),
  },
  'vcb-racking': {
    id: 'vcb-racking', title: 'V.C.B with spring charge and racking', titleFa: 'کلید وکیوم با شارژ فنر',
    group: 'Switching',
    draw: (x, y) => [
      IEC_SYMBOLS.vcb.draw(x, y),
      circ(x - 30, y + 14, 5), txt(x - 30, y + 17, 'M', 6),
      ln(x - 25, y + 14, x - 21, y + 14, 1),
      box(x - 21, y + 9, 10, 10, '#fff', 1),
      ln(x - 16, y + 9, x - 16, y + 19, 1), ln(x - 21, y + 14, x - 11, y + 14, 1),
      `<line x1="${x - 11}" y1="${y + 18}" x2="${x - 3}" y2="${y + 18}" stroke="${S}" ` +
        `stroke-width="1" stroke-dasharray="2 2"/>`,
    ].join(''),
  },
  'vacuum-contactor-fuse': {
    id: 'vacuum-contactor-fuse', title: 'Vacuum contactor with HRC fuse (V.C)', titleFa: 'کنتاکتور وکیوم با فیوز',
    group: 'Switching',
    draw: (x, y) => [
      isolatorTop(x, y),
      box(x - 5, y + 15, 10, 8),                   // the fuse
      ln(x - 5, y + 23, x + 5, y + 15, 1),
      txt(x + 10, y + 19, '3', 6, 'start'),
      dot(x, y + 25),
      ln(x, y + 25, x + 8, y + 32, 1.3),           // the contactor blade
      path(`M ${x - 4} ${y + 32} a 4 4 0 0 0 8 0`, 1.2),
      isolatorBottom(x, y),
    ].join(''),
  },
  'circuit-breaker': {
    id: 'circuit-breaker', title: 'Circuit breaker', titleFa: 'کلید اتوماتیک',
    group: 'Switching',
    draw: (x, y) => [
      ln(x, y, x, y + 12), dot(x, y + 12),
      ln(x, y + 12, x + 11, y + 26, 1.4),
      ln(x - 5, y + 23, x + 5, y + 33, 1.3),
      ln(x + 5, y + 23, x - 5, y + 33, 1.3),
      dot(x, y + 28), ln(x, y + 28, x, y + CELL),
    ].join(''),
  },
  'withdrawable-cb': {
    id: 'withdrawable-cb', title: 'Withdrawable circuit breaker', titleFa: 'کلید کشویی',
    group: 'Switching',
    draw: (x, y) => [
      isolatorTop(x, y),
      ln(x - 10, y + 13, x, y + 25, 1.4),
      ln(x + 1.5, y + 12, x + 6.5, y + 17, 1.3), ln(x + 6.5, y + 12, x + 1.5, y + 17, 1.3),
      dot(x, y + 25), isolatorBottom(x, y),
    ].join(''),
  },
  disconnector: {
    id: 'disconnector', title: 'Disconnector / isolator', titleFa: 'سکسیونر',
    group: 'Switching',
    draw: (x, y) => [
      ln(x, y, x, y + 12), dot(x, y + 12),
      ln(x, y + 12, x + 12, y + 26, 1.4),
      dot(x, y + 28), ln(x, y + 28, x, y + CELL),
    ].join(''),
  },
  'switch-disconnector': {
    id: 'switch-disconnector', title: 'Switch disconnector (load break)', titleFa: 'کلید قابل قطع زیر بار',
    group: 'Switching',
    draw: (x, y) => IEC_SYMBOLS.disconnector.draw(x, y) + ln(x - 6, y + 28, x + 6, y + 28, 2.2),
  },
  contactor: {
    id: 'contactor', title: 'Contactor', titleFa: 'کنتاکتور',
    group: 'Switching',
    // The open contact with the contactor arc under it, as the legend draws
    // the vacuum contactor.
    draw: (x, y) => [
      ln(x, y, x, y + 13), dot(x, y + 13),
      ln(x, y + 13, x + 11, y + 25, 1.4),
      path(`M ${x - 5} ${y + 27} a 5 5 0 0 0 10 0`, 1.3),
      ln(x, y + 27, x, y + CELL),
    ].join(''),
  },
  'motor-starter': {
    id: 'motor-starter', title: 'Motor starter (CB + contactor)', titleFa: 'راه‌انداز موتور',
    group: 'Switching',
    draw: (x, y) => [
      ln(x, y, x, y + 10), dot(x, y + 10),
      ln(x, y + 10, x + 10, y + 21, 1.4),
      ln(x - 4, y + 17, x + 4, y + 25, 1.2), ln(x + 4, y + 17, x - 4, y + 25, 1.2),
      path(`M ${x - 5} ${y + 30} a 5 5 0 0 0 10 0`, 1.2),
      ln(x, y + 30, x, y + CELL),
    ].join(''),
  },
  'earthing-switch': {
    id: 'earthing-switch', title: 'Earth switch', titleFa: 'کلید ارت',
    group: 'Switching',
    draw: (x, y) => [
      ln(x + 10, y + 2, x, y + 16, 1.4),
      ln(x + 8, y + 2, x + 12, y + 6, 1.2),
      ln(x, y + 16, x, y + 28),
      ln(x - 8, y + 28, x + 8, y + 28, 1.5),
      ln(x - 5, y + 32, x + 5, y + 32, 1.3),
      ln(x - 2, y + 36, x + 2, y + 36, 1.2),
    ].join(''),
  },
  mcb: {
    id: 'mcb', title: 'Miniature circuit breaker', titleFa: 'کلید مینیاتوری',
    group: 'Switching',
    draw: (x, y) => [
      ln(x, y, x, y + 12), dot(x, y + 12),
      // the hooked blade with the arrow the legend uses
      path(`M ${x} ${y + 12} l 8 -6 l 5 5 l -5 4 l 6 6`, 1.3),
      path(`M ${x + 14} ${y + 21} l 4 4 l -1 -5 l 5 1 Z`, 1, S),
      ln(x, y + 28, x, y + CELL),
      txt(x - 8, y + 34, '3', 6),
    ].join(''),
  },
  ats: {
    id: 'ats', title: 'Automatic transfer switch', titleFa: 'کلید تعویض خودکار',
    group: 'Switching',
    draw: (x, y) => [ln(x, y, x, y + CELL), box(x + 5, y + 10, 26, 20), txt(x + 18, y + 24, 'ATS', 8)].join(''),
  },

  // ── Protection ───────────────────────────────────────────────────────
  'hrc-fuse': {
    id: 'hrc-fuse', title: 'HRC fuse', titleFa: 'فیوز HRC',
    group: 'Protection',
    draw: (x, y) => [
      ln(x, y, x, y + 13),
      box(x - 7, y + 13, 14, 14),
      ln(x - 7, y + 27, x + 7, y + 13, 1.2),
      txt(x + 12, y + 14, '3', 6, 'start'),
      ln(x, y + 27, x, y + CELL),
    ].join(''),
  },
  fuse: {
    id: 'fuse', title: 'Fuse', titleFa: 'فیوز',
    group: 'Protection',
    draw: (x, y) => [
      ln(x, y, x, y + 12), box(x - 6, y + 12, 12, 16), ln(x, y + 12, x, y + 28, 1),
      ln(x, y + 28, x, y + CELL),
    ].join(''),
  },
  'switch-fuse': {
    id: 'switch-fuse', title: 'Switch fuse', titleFa: 'کلید فیوزدار',
    group: 'Protection',
    draw: (x, y) => [
      ln(x, y, x, y + 8), dot(x, y + 8), ln(x, y + 8, x + 10, y + 18, 1.3),
      box(x - 6, y + 20, 12, 14), ln(x - 6, y + 34, x + 6, y + 20, 1.1),
      ln(x, y + 34, x, y + CELL),
    ].join(''),
  },
  'thermal-overload': {
    id: 'thermal-overload', title: 'Thermal overload relay (bimetal)', titleFa: 'بی‌متال (رله حرارتی)',
    group: 'Protection',
    draw: (x, y) => [
      ln(x, y, x, y + 8),
      box(x - 10, y + 8, 20, 24),
      box(x - 5, y + 14, 10, 12, 'none', 1),
      ln(x - 5, y + 20, x + 5, y + 20, 1),
      solid(x - 5, y + 20, 10, 6),
      ln(x, y + 32, x, y + CELL),
    ].join(''),
  },
  'protection-relay': {
    id: 'protection-relay', title: 'Protection relay', titleFa: 'رله حفاظتی',
    group: 'Protection',
    draw: (x, y) => [
      ln(x, y, x, y + CELL), ln(x, y + HALF, x + 5, y + HALF),
      box(x + 5, y + 8, 34, 24),
      txt(x + 22, y + 18, 'PROTECTION', 4.6), txt(x + 22, y + 26, 'RELAY', 4.6),
    ].join(''),
  },
  'earth-fault-relay': {
    id: 'earth-fault-relay', title: 'Earth fault relay', titleFa: 'رله ارت فالت',
    group: 'Protection',
    draw: (x, y) => [
      ln(x, y, x, y + CELL), ln(x, y + HALF, x + 5, y + HALF),
      box(x + 5, y + 10, 26, 20), txt(x + 18, y + 24, 'E/F', 8),
    ].join(''),
  },
  'surge-arrester': {
    id: 'surge-arrester', title: 'Surge arrester', titleFa: 'برقگیر',
    group: 'Protection',
    draw: (x, y) => [
      ln(x, y, x, y + 10),
      box(x - 6, y + 10, 12, 20),
      path(`M ${x - 4} ${y + 14} l 8 0 l -4 9 Z`, 1, S),
      ln(x, y + 30, x, y + CELL),
    ].join(''),
  },
  'surge-limiter': {
    id: 'surge-limiter', title: 'Surge limiter', titleFa: 'محدودکنندهٔ اضافه ولتاژ',
    group: 'Protection',
    draw: (x, y) => [
      ln(x, y, x, y + 10),
      box(x - 6, y + 10, 12, 20),
      ln(x - 6, y + 10, x + 6, y + 30, 1.1), ln(x + 6, y + 10, x - 6, y + 30, 1.1),
      ln(x, y + 30, x, y + CELL),
    ].join(''),
  },
  ptc: {
    id: 'ptc', title: 'PTC thermistor', titleFa: 'PTC',
    group: 'Protection',
    draw: (x, y) => [ln(x, y, x, y + CELL), ln(x, y + HALF, x + 5, y + HALF),
      box(x + 5, y + 11, 24, 18), txt(x + 17, y + 24, 'PTC', 7)].join(''),
  },

  // ── Measuring ────────────────────────────────────────────────────────
  'current-transformer': {
    id: 'current-transformer', title: 'Current transformer', titleFa: 'ترانس جریان (CT)',
    group: 'Measuring',
    draw: (x, y) => [
      ln(x, y, x, y + CELL),
      circ(x, y + HALF, 9),
      ln(x + 9, y + HALF, x + 20, y + HALF, 1),
      ln(x + 3, y + HALF - 9, x + 9, y + HALF - 3, 1),   // the winding tick
      txt(x + 11, y + HALF - 10, '1', 6, 'start'),
    ].join(''),
  },
  'core-balance-ct': {
    id: 'core-balance-ct', title: 'Core balance CT', titleFa: 'CT کر بالانس',
    group: 'Measuring',
    // The legend's ellipse with the three phases running through it.
    draw: (x, y) => [
      `<ellipse cx="${x}" cy="${y + HALF}" rx="14" ry="9" fill="none" stroke="${S}" stroke-width="1.2"/>`,
      ln(x - 7, y + 4, x - 7, y + CELL - 4, 1),
      ln(x, y, x, y + CELL),
      ln(x + 7, y + 4, x + 7, y + CELL - 4, 1),
      ln(x + 14, y + HALF, x + 22, y + HALF, 1),
    ].join(''),
  },
  'voltage-transformer': {
    id: 'voltage-transformer', title: 'Voltage transformer (PT/VT)', titleFa: 'ترانس ولتاژ (PT)',
    group: 'Measuring',
    // Interlocking circles with their star points, tapped off the line.
    draw: (x, y) => [
      ln(x, y, x, y + CELL),
      ln(x, y + HALF, x + 6, y + HALF, 1),
      circ(x + 14, y + HALF - 4, 8), star(x + 14, y + HALF - 6),
      circ(x + 14, y + HALF + 5, 8), star(x + 14, y + HALF + 3),
      ln(x + 22, y + HALF + 5, x + 28, y + HALF + 5, 1),
    ].join(''),
  },
  transformer: {
    id: 'transformer', title: 'Two winding transformer', titleFa: 'ترانسفورماتور دو سیم‌پیچ',
    group: 'Measuring',
    draw: (x, y) => [
      ln(x, y, x, y + 6),
      circ(x, y + HALF - 5, 9), star(x, y + HALF - 7),
      circ(x, y + HALF + 6, 9), star(x, y + HALF + 4),
      ln(x, y + CELL - 6, x, y + CELL),
    ].join(''),
  },
  ammeter: { id: 'ammeter', title: 'Ammeter', titleFa: 'آمپرمتر', group: 'Measuring',
    draw: (x, y) => meterBox(x, y, 'A') },
  voltmeter: { id: 'voltmeter', title: 'Voltmeter', titleFa: 'ولت‌متر', group: 'Measuring',
    draw: (x, y) => meterBox(x, y, 'V') },
  multimeter: { id: 'multimeter', title: 'Multimeter', titleFa: 'مولتی‌متر', group: 'Measuring',
    draw: (x, y) => meterBox(x, y, 'M') },
  'watt-meter': { id: 'watt-meter', title: 'Watt meter', titleFa: 'وات‌متر', group: 'Measuring',
    draw: (x, y) => meterBox(x, y, 'W') },
  'var-meter': { id: 'var-meter', title: 'VAR meter', titleFa: 'وارمتر', group: 'Measuring',
    draw: (x, y) => meterBox(x, y, 'VAR', 7) },
  'power-factor-meter': { id: 'power-factor-meter', title: 'Power factor meter', titleFa: 'کسینوس‌فی‌متر',
    group: 'Measuring', draw: (x, y) => meterBox(x, y, 'COSΦ', 6) },
  'frequency-meter': { id: 'frequency-meter', title: 'Frequency meter', titleFa: 'فرکانس‌متر',
    group: 'Measuring', draw: (x, y) => meterBox(x, y, 'F') },
  'hour-meter': { id: 'hour-meter', title: 'Hour meter', titleFa: 'ساعت‌شمار',
    group: 'Measuring', draw: (x, y) => meterBox(x, y, 'H.M', 6.5) },
  'kwh-meter': { id: 'kwh-meter', title: 'Kilo watt-hour meter', titleFa: 'کنتور کیلووات‌ساعت',
    group: 'Measuring', draw: (x, y) => energyMeter(x, y, 'KWH') },
  'kvarh-meter': { id: 'kvarh-meter', title: 'Kilo var-hour meter', titleFa: 'کنتور کیلووار‌ساعت',
    group: 'Measuring', draw: (x, y) => energyMeter(x, y, 'KVARH') },
  transducer: { id: 'transducer', title: 'Transducer', titleFa: 'ترانسدیوسر',
    group: 'Measuring', draw: (x, y) => meterBox(x, y, 'TD', 7) },
  'selector-switch': {
    id: 'selector-switch', title: 'Selector switch', titleFa: 'سلکتور سوییچ',
    group: 'Measuring',
    draw: (x, y) => [
      ln(x, y, x, y + CELL), ln(x, y + HALF, x + 5, y + HALF),
      box(x + 5, y + HALF - 8, 22, 16), txt(x + 16, y + HALF + 3, 'S.S', 7),
      ln(x + 27, y + HALF, x + 32, y + HALF),
    ].join(''),
  },
  'voltage-selector': {
    id: 'voltage-selector', title: 'Voltage selector switch', titleFa: 'سلکتور ولتاژ',
    group: 'Measuring',
    draw: (x, y) => [
      ln(x, y, x, y + CELL), ln(x, y + HALF, x + 5, y + HALF),
      box(x + 5, y + HALF - 8, 22, 16), txt(x + 16, y + HALF + 3, 'V.S', 7),
      ln(x + 27, y + HALF, x + 32, y + HALF),
    ].join(''),
  },
  'ampere-selector': {
    id: 'ampere-selector', title: 'Ampere selector switch', titleFa: 'سلکتور آمپر',
    group: 'Measuring',
    draw: (x, y) => [
      ln(x, y, x, y + CELL), ln(x, y + HALF, x + 5, y + HALF),
      box(x + 5, y + HALF - 8, 22, 16), txt(x + 16, y + HALF + 3, 'A.S', 7),
      ln(x + 27, y + HALF, x + 32, y + HALF),
    ].join(''),
  },
  'capacitive-divider': {
    id: 'capacitive-divider', title: 'Capacitive voltage divider', titleFa: 'مقسم ولتاژ خازنی',
    group: 'Measuring',
    draw: (x, y) => [
      ln(x, y, x, y + 15),
      ln(x - 8, y + 15, x + 8, y + 15, 1.6),
      ln(x - 8, y + 21, x + 8, y + 21, 1.6),
      path(`M ${x + 4} ${y + 26} a 6 6 0 1 0 0 8`, 1.2),
      ln(x, y + 21, x, y + CELL),
    ].join(''),
  },

  // ── Loads and signalling ─────────────────────────────────────────────
  motor: {
    id: 'motor', title: 'Motor', titleFa: 'موتور', group: 'Loads',
    draw: (x, y) => ln(x, y, x, y + 8) + circ(x, y + 24, 12, '#fff', 1.3) + txt(x, y + 28, 'M', 11),
  },
  generator: {
    id: 'generator', title: 'Generator', titleFa: 'ژنراتور', group: 'Loads',
    draw: (x, y) => ln(x, y, x, y + 8) + circ(x, y + 24, 12, '#fff', 1.3) + txt(x, y + 28, 'G', 11),
  },
  heater: {
    id: 'heater', title: 'Heating element', titleFa: 'المنت حرارتی', group: 'Loads',
    draw: (x, y) => [
      ln(x, y, x, y + 14),
      box(x - 14, y + 14, 28, 12),
      ln(x - 7, y + 14, x - 7, y + 26, 1), ln(x, y + 14, x, y + 26, 1), ln(x + 7, y + 14, x + 7, y + 26, 1),
      ln(x, y + 26, x, y + CELL),
    ].join(''),
  },
  lamp: {
    id: 'lamp', title: 'Lamp / indicator light', titleFa: 'چراغ سیگنال', group: 'Loads',
    draw: (x, y) => [
      ln(x, y, x, y + 11), circ(x, y + 22, 10),
      ln(x - 7, y + 15, x + 7, y + 29, 1.1), ln(x + 7, y + 15, x - 7, y + 29, 1.1),
    ].join(''),
  },
  socket: {
    id: 'socket', title: 'Socket outlet', titleFa: 'پریز', group: 'Loads',
    draw: (x, y) => ln(x, y, x, y + 16) +
      path(`M ${x - 10} ${y + 26} a 10 10 0 0 1 20 0`, 1.3) + ln(x - 10, y + 26, x + 10, y + 26, 1.3),
  },
  capacitor: {
    id: 'capacitor', title: 'Capacitor', titleFa: 'خازن', group: 'Loads',
    draw: (x, y) => [
      ln(x, y, x, y + 16),
      ln(x - 9, y + 16, x + 9, y + 16, 1.7),
      ln(x - 9, y + 22, x + 9, y + 22, 1.7),
      ln(x, y + 22, x, y + CELL),
    ].join(''),
  },
  'capacitor-delta': {
    id: 'capacitor-delta', title: 'Capacitor, delta connection', titleFa: 'خازن مثلث',
    group: 'Loads',
    draw: (x, y) => [
      ln(x, y, x, y + 8),
      path(`M ${x} ${y + 8} L ${x - 13} ${y + 32} L ${x + 13} ${y + 32} Z`, 1.2),
      ln(x - 8, y + 20, x + 2, y + 20, 1.4), ln(x - 6, y + 24, x + 4, y + 24, 1.4),
    ].join(''),
  },
  drive: {
    id: 'drive', title: 'Frequency converter', titleFa: 'درایو (اینورتر)', group: 'Loads',
    draw: (x, y) => [
      ln(x, y, x, y + 8), box(x - 13, y + 8, 26, 24),
      ln(x - 8, y + 27, x + 8, y + 13, 1.1),
      txt(x - 7, y + 18, '~', 8), txt(x + 6, y + 29, '=', 8),
      ln(x, y + 32, x, y + CELL),
    ].join(''),
  },
  'soft-starter': {
    id: 'soft-starter', title: 'Soft starter', titleFa: 'سافت استارتر', group: 'Loads',
    draw: (x, y) => [
      ln(x, y, x, y + 8), box(x - 13, y + 8, 26, 24),
      path(`M ${x - 8} ${y + 27} q 8 -15 16 -15`, 1.2),
      ln(x, y + 32, x, y + CELL),
    ].join(''),
  },
  magnet: {
    id: 'magnet', title: 'Magnet', titleFa: 'مگنت', group: 'Loads',
    draw: (x, y) => [
      ln(x, y, x, y + 14), box(x - 12, y + 14, 24, 12),
      ln(x - 12, y + 26, x + 12, y + 14, 1.1), ln(x, y + 26, x, y + CELL),
    ].join(''),
  },
  'alarm-annunciator': {
    id: 'alarm-annunciator', title: 'Alarm annunciator', titleFa: 'آنانسیاتور آلارم',
    group: 'Loads',
    draw: (x, y) => {
      const g: string[] = [ln(x, y, x, y + CELL)];
      const left = x + 6, top = y + 8, cell = 6;
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
        g.push(box(left + c * cell, top + r * cell, cell, cell, '#fff', 0.8));
      }
      return g.join('');
    },
  },
  lcs: {
    id: 'lcs', title: 'Local control station (LCS)', titleFa: 'ایستگاه کنترل محلی',
    group: 'Loads',
    draw: (x, y) => [
      ln(x, y, x, y + CELL), ln(x, y + HALF, x + 5, y + HALF),
      box(x + 5, y + 6, 32, 28),
      txt(x + 11, y + 14, 'L', 5.5), txt(x + 18, y + 14, 'R', 5.5),
      circ(x + 29, y + 12, 4), txt(x + 29, y + 14, 'A', 5),
      circ(x + 11, y + 22, 1.6, '#fff', 0.8), txt(x + 24, y + 24, 'START', 4.5),
      circ(x + 11, y + 29, 1.6, '#fff', 0.8), txt(x + 24, y + 31, 'STOP', 4.5),
    ].join(''),
  },

  // ── Connections ──────────────────────────────────────────────────────
  terminal: {
    id: 'terminal', title: 'Terminal', titleFa: 'ترمینال', group: 'Connections',
    draw: (x, y) => ln(x, y, x, y + CELL) + circ(x, y + HALF, 3.2, '#fff', 1.1),
  },
  'test-block': {
    id: 'test-block', title: 'Test box', titleFa: 'ترمینال تست', group: 'Connections',
    draw: (x, y) => [
      ln(x, y, x, y + HALF - 6), circ(x, y + HALF, 6), dot(x, y + HALF, 2.4),
      ln(x, y + HALF + 6, x, y + CELL),
    ].join(''),
  },
  'key-interlock': {
    id: 'key-interlock', title: 'Key interlock', titleFa: 'اینترلاک کلیدی', group: 'Connections',
    draw: (x, y) => [
      ln(x, y, x, y + CELL), box(x + 5, y + 10, 18, 20),
      circ(x + 14, y + 17, 3), ln(x + 14, y + 20, x + 14, y + 26, 1),
      ln(x + 14, y + 24, x + 17, y + 24, 1),
    ].join(''),
  },
  'mechanical-interlock': {
    id: 'mechanical-interlock', title: 'Mechanical interlock', titleFa: 'اینترلاک مکانیکی',
    group: 'Connections',
    draw: (x, y) => [
      `<line x1="${x - 18}" y1="${y + HALF}" x2="${x - 6}" y2="${y + HALF}" stroke="${S}" stroke-width="1" stroke-dasharray="3 2"/>`,
      path(`M ${x - 6} ${y + HALF - 5} L ${x + 6} ${y + HALF - 5} L ${x} ${y + HALF + 5} Z`, 1.1),
      `<line x1="${x + 6}" y1="${y + HALF}" x2="${x + 18}" y2="${y + HALF}" stroke="${S}" stroke-width="1" stroke-dasharray="3 2"/>`,
    ].join(''),
  },
  'bus-duct': {
    id: 'bus-duct', title: 'Bus duct / bus bridge', titleFa: 'باس‌داکت',
    group: 'Connections',
    draw: (x, y) => [
      path(`M ${x - 5} ${y + 6} q 6 ${HALF - 6} 0 ${CELL - 12}`, 1.4),
      path(`M ${x + 5} ${y + 6} q -6 ${HALF - 6} 0 ${CELL - 12}`, 1.4),
    ].join(''),
  },
  link: {
    id: 'link', title: 'Hard wire connection', titleFa: 'اتصال سیمی',
    group: 'Connections', draw: (x, y) => ln(x, y, x, y + CELL),
  },
  outgoing: {
    id: 'outgoing', title: 'Outgoing feeder', titleFa: 'خروجی', group: 'Connections',
    draw: (x, y) => ln(x, y, x, y + 26) +
      path(`M ${x - 6} ${y + 24} L ${x} ${y + 36} L ${x + 6} ${y + 24} Z`, 1, S),
  },
  incoming: {
    id: 'incoming', title: 'Incoming supply', titleFa: 'ورودی', group: 'Connections',
    draw: (x, y) => ln(x, y + 14, x, y + CELL) +
      path(`M ${x - 6} ${y + 16} L ${x} ${y + 4} L ${x + 6} ${y + 16} Z`, 1, S),
  },
  accessory: {
    id: 'accessory', title: 'Accessory (belongs to the device above)', titleFa: 'متعلقات',
    group: 'Connections',
    draw: (x, y) => ln(x, y, x, y + CELL) +
      `<rect x="${x + 5}" y="${y + 14}" width="12" height="12" fill="#fff" stroke="${S}" stroke-width="1" stroke-dasharray="3 2"/>`,
  },
};

export const SYMBOL_GROUPS: IecSymbol['group'][] =
  ['Switching', 'Protection', 'Measuring', 'Loads', 'Connections'];

// How far right of the branch a symbol reaches. A boxed symbol — a relay, a
// meter, an annunciator — is wide, and the tag written beside it has to start
// clear of the box instead of on top of it.
const SYMBOL_RIGHT: Partial<Record<SymbolId, number>> = {
  'protection-relay': 40, 'earth-fault-relay': 32, ats: 32, lcs: 38,
  'alarm-annunciator': 31, 'kwh-meter': 32, 'kvarh-meter': 32,
  ammeter: 29, voltmeter: 29, multimeter: 29, 'watt-meter': 29, 'var-meter': 29,
  'power-factor-meter': 29, 'frequency-meter': 29, 'hour-meter': 29, transducer: 29,
  ptc: 29, 'selector-switch': 33, 'voltage-selector': 33, 'ampere-selector': 33,
  'current-transformer': 22, 'core-balance-ct': 24, 'voltage-transformer': 24,
  transformer: 24, 'bus-duct': 20, 'key-interlock': 24, magnet: 24, heater: 24,
};

// ── Symbols exported from EPLAN, in place of the ones here ──────────────────
//
// A file in the symbol pack named after one of these ids — `vcb.svg`,
// `current-transformer.svg` — replaces that symbol everywhere: on every sheet,
// in the printed set and in the library view. It is drawn to the same cell:
// scaled to the cell's height, and placed so its own conductor (`data-pin-x`
// in the file, the middle of it otherwise) lands on the branch line.
export interface SymbolOverride {
  /** A picture of the symbol. Ignored when `art` is present. */
  url: string;
  /**
   * The symbol as geometry rather than as a picture — the markup for its
   * shapes, in its own coordinate space, with no `<svg>` around it.
   *
   * A symbol brought in from a DXF arrives this way. It matters beyond how it
   * looks: geometry goes back out to DXF and PDF as lines and arcs that can be
   * edited and plotted at any scale, where a picture would have to be
   * re-drawn by hand at the other end.
   */
  art?: string;
  /** The symbol's own box, from its viewBox. */
  width?: number;
  height?: number;
  /** Where the conductor runs inside that box. */
  pinX?: number;
  /**
   * The points a wire may land on, in the symbol's own coordinates.
   *
   * Only a symbol somebody has drawn connection points on has these. The
   * library's own symbols answer the question from their geometry — a
   * single-line device is a conductor with something on it, and the two ends
   * of that conductor are the two terminals — and that answer is right until
   * somebody redraws the symbol as something the rule does not fit.
   */
  terminals?: { x: number; y: number; name: string; dir?: string }[];
  /** How many cells down the line it takes (`data-cells` in the file). */
  cells?: number;
  title?: string;
}

// ── What is standing in for a symbol, and who said so ───────────────────────
//
// Three layers, and they are three because three different places answer the
// question and none of them knows about the others:
//
//   **project** — this job's own drawing of the device, redrawn on the symbol
//                 page. The most particular thing anybody has said, so it wins.
//   **pack**    — the office's DXF symbol pack, kept in this browser.
//   **eplan**   — symbols exported from EPLAN for the parts on this project.
//
// They used to be two, and the pack and EPLAN shared one slot that whichever
// screen ran last overwrote. Worse, every screen set the layers from its own
// effect, so what a symbol looked like depended on which tab had been opened
// and in what order: the library showed the new drawing, the template preview
// showed the old one, and the sheet showed whichever it had last been told.
// "It is somehow not in sync" is that, exactly.
//
// So the layers are separate, each has one writer, and **anything that changes
// them says so**. Drawing from a module-level variable is fine; drawing from
// one that can change without React hearing about it is not, and that is what
// `onSymbols` is for.

let PROJECT_OVERRIDES: Partial<Record<SymbolId, SymbolOverride>> = {};
let PACK_OVERRIDES: Partial<Record<SymbolId, SymbolOverride>> = {};
let EPLAN_OVERRIDES: Partial<Record<SymbolId, SymbolOverride>> = {};

let VERSION = 0;
const watchers = new Set<() => void>();

/** Everything that draws a symbol, told that one has changed. */
function announce(): void {
  VERSION += 1;
  for (const fn of watchers) fn();
}

/**
 * How many times the symbols have changed.
 *
 * A number rather than the maps themselves: a screen only needs to know that
 * it has to draw again, and comparing two nested maps on every render to learn
 * that is work for nothing. Pairs with `onSymbols` for `useSyncExternalStore`.
 */
export const symbolsVersion = (): number => VERSION;

/** Called whenever any layer changes. Returns the way to stop listening. */
export function onSymbols(fn: () => void): () => void {
  watchers.add(fn);
  return () => { watchers.delete(fn); };
}

/** Hand the library the office's DXF pack. Passing {} clears that layer. */
export function setPackSymbolOverrides(map: Partial<Record<SymbolId, SymbolOverride>>): void {
  PACK_OVERRIDES = map ?? {};
  announce();
}

/** Hand the library the symbols EPLAN exported for this project's parts. */
export function setEplanSymbolOverrides(map: Partial<Record<SymbolId, SymbolOverride>>): void {
  EPLAN_OVERRIDES = map ?? {};
  announce();
}

/** Hand the library the project's own drawings. Passing {} clears them. */
export function setProjectSymbolOverrides(map: Partial<Record<SymbolId, SymbolOverride>>): void {
  PROJECT_OVERRIDES = map ?? {};
  announce();
}

/** What the library will draw for an id, when something has replaced it. */
export function symbolOverride(id: string): SymbolOverride | undefined {
  return PROJECT_OVERRIDES[id as SymbolId]
    ?? PACK_OVERRIDES[id as SymbolId]
    ?? EPLAN_OVERRIDES[id as SymbolId];
}

/**
 * Everything except the project's own — what a symbol falls back to when the
 * project's drawing of it is put away again.
 */
export function packSymbolOverride(id: string): SymbolOverride | undefined {
  return PACK_OVERRIDES[id as SymbolId] ?? EPLAN_OVERRIDES[id as SymbolId];
}

/** Which symbols this project draws its own way, for a screen that lists them. */
export const redrawnSymbolIds = (): SymbolId[] =>
  Object.keys(PROJECT_OVERRIDES) as SymbolId[];

/**
 * The geometry an overriding symbol is drawn with.
 *
 * A symbol keeps its own proportions and takes as many cells down the line as
 * those proportions ask for — a whole vacuum breaker with its racking is taller
 * than it is wide and needs two, where a meter needs one. The file decides it
 * outright with `data-cells`; otherwise it comes from the symbol's own box.
 */
export function overrideBox(o: SymbolOverride): { w: number; h: number; dx: number; cells: number } {
  const w0 = o.width && o.width > 0 ? o.width : 1;
  const h0 = o.height && o.height > 0 ? o.height : 1;
  const cells = Math.max(1, Math.min(4, Math.round(o.cells ?? h0 / w0) || 1));
  const h = cells * CELL;
  const scale = h / h0;
  const pin = o.pinX != null && o.pinX >= 0 && o.pinX <= w0 ? o.pinX : w0 / 2;
  return { w: w0 * scale, h, dx: -pin * scale, cells };   // dx: the box's left, from x
}

/** How tall a symbol is on the line: one cell, or as many as an overriding
 *  symbol from the pack asks for. */
export function symbolHeight(id: string): number {
  const o = symbolOverride(id);
  return o ? overrideBox(o).h : CELL;
}

/** The right-hand extent of a symbol, so a caller can place text clear of it. */
export function symbolRight(id: string): number {
  const o = symbolOverride(id);
  if (o) {
    const { w, dx } = overrideBox(o);
    return Math.max(16, w + dx);
  }
  return SYMBOL_RIGHT[id as SymbolId] ?? 16;
}

/** The left-hand extent of a symbol — an overriding symbol can reach out to
 *  the left, the way a breaker with its racking does. */
export function symbolLeft(id: string): number {
  const o = symbolOverride(id);
  return o ? Math.max(16, -overrideBox(o).dx) : 16;
}

/**
 * The symbol as this library itself draws it, with nothing standing in for it.
 *
 * The accessors above all answer with whatever is currently overriding a
 * symbol, which is what every drawing wants. Putting an overriding symbol back
 * is the one job that wants the other answer: what the page has to be redrawn
 * with is the library's own, and asking through the overrides would hand back
 * the very drawing that is being taken away.
 */
export function librarySymbol(id: SymbolId): {
  markup: string; left: number; width: number; height: number;
} {
  const left = 16;
  return {
    markup: (IEC_SYMBOLS[id] ?? IEC_SYMBOLS.link).draw(left, 0),
    left,
    width: left + (SYMBOL_RIGHT[id as SymbolId] ?? 16),
    height: CELL,
  };
}

/**
 * One symbol, drawn where the branch line meets it.
 *
 * **Nothing is drawn through a symbol.** A device's two terminals are joined
 * inside it only if the device itself joins them, and most of what is on a
 * feeder does not: a breaker, a disconnector, a contactor, a switch is drawn
 * *open* — that is the whole meaning of the symbol, the state it sits in until
 * something operates it. A line run from the top terminal to the bottom one
 * past the open blade says the opposite, and says it in the one drawing the
 * rest of the job is read from.
 *
 * That line used to be drawn under every overriding symbol — so a breaker the
 * office redrew for a project, or replaced from its own DXF pack, came back
 * shorted while the library's own copy of it stayed right. Redrawing a symbol
 * must not change what it means.
 *
 * Geometry brings its own conductor: the art is a drawing of the device, leads
 * and gap and all, scaled to exactly the box it declares, so there is nothing
 * left for this to add. A picture is the one case that still needs a lead —
 * see below.
 */
export function drawIecSymbol(id: SymbolId, x: number, y: number): string {
  const o = symbolOverride(id);
  if (o) {
    const { w, h, dx } = overrideBox(o);
    if (o.art) {
      // Geometry, placed by the box it declares, so the symbol's own conductor
      // lands on the branch — and its own gap stays a gap.
      const k = h / (o.height && o.height > 0 ? o.height : 1);
      return `<g transform="translate(${x + dx} ${y}) scale(${k})">${o.art}</g>`;
    }
    // A picture, and only a picture. `xMidYMid meet` letterboxes it inside the
    // cell, so its ink can stop short of both ends with nothing to say where —
    // which leaves a lead the only way to put it on the branch at all. An
    // office that wants its switches drawn open sends geometry (a DXF on the
    // CONN layer, or a redraw on the symbol page), not a picture.
    return `<line x1="${x}" y1="${y}" x2="${x}" y2="${y + h}" stroke="${S}" stroke-width="1"/>` +
      `<image href="${esc(o.url)}" x="${x + dx}" y="${y}" width="${w}" height="${h}" ` +
      `preserveAspectRatio="xMidYMid meet">` +
      `<title>${esc(o.title || IEC_SYMBOLS[id]?.title || id)}</title></image>`;
  }
  return (IEC_SYMBOLS[id] ?? IEC_SYMBOLS.link).draw(x, y);
}

/**
 * Where a wire may land on a symbol drawn at (x, y) — the twin of
 * `drawIecSymbol`, answering for the same placement.
 *
 * It is the twin deliberately. The terminals and the ink have to come out of
 * the same arithmetic or they drift apart, and the way they drift is the worst
 * one: everything looks right, and the wire joins nothing. So this reads the
 * same override through the same box and applies the same transform, and
 * anything that changes one has to walk past the other.
 *
 * A symbol nobody has drawn connection points on gets the two the library has
 * always given it: a single-line device stands in the branch, current in at
 * the top and out at the bottom, and those are the two ends of the conductor
 * the symbol is drawn around.
 */
export function symbolTerminals(
  id: SymbolId, x: number, y: number,
): { x: number; y: number; name: string; dir?: string }[] {
  const o = symbolOverride(id);
  const h = symbolHeight(id);
  if (o?.art && o.terminals?.length) {
    const { dx } = overrideBox(o);
    const k = h / (o.height && o.height > 0 ? o.height : 1);
    // `dx` already carries the conductor back onto the branch — it is
    // `-pinX * k` — so a point is its own offset in the art, at the same
    // scale. Subtracting the pin again here is the mistake to watch for.
    return o.terminals.map(p => ({
      x: x + dx + p.x * k,
      y: y + p.y * k,
      name: p.name,
      dir: p.dir,
    }));
  }
  return [
    { x, y, name: '1', dir: 'up' },
    { x, y: y + h, name: '2', dir: 'down' },
  ];
}

/** The whole library as a legend sheet, laid out like the office's own. */
export function buildSymbolCatalogueSvg(perRow = 5): string {
  const cellW = 190;
  const cellH = 92;
  const out: string[] = [];
  let y = 34;
  const width = perRow * cellW + 40;

  for (const group of SYMBOL_GROUPS) {
    const symbols = Object.values(IEC_SYMBOLS).filter(s => s.group === group);
    out.push(`<text x="20" y="${y}" font-size="12" font-weight="700" fill="${S}" font-family="Segoe UI, Arial, sans-serif">${group}</text>`);
    y += 12;
    symbols.forEach((symbol, i) => {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const bx = 20 + col * cellW;
      const by = y + row * cellH;
      out.push(box(bx, by, cellW - 8, cellH - 8, '#fff', 0.8));
      // Drawn the way the sheet draws it, so a symbol the pack has replaced is
      // the one on show here too — scaled into the card when it is a tall one.
      const tall = symbolHeight(symbol.id) / CELL;
      const art = drawIecSymbol(symbol.id, bx + 46, by + 10);
      out.push(tall > 1
        ? `<g transform="translate(${bx + 46} ${by + 10}) scale(${1 / tall}) translate(${-(bx + 46)} ${-(by + 10)})">${art}</g>`
        : art);
      out.push(`<text x="${bx + 8}" y="${by + cellH - 22}" font-size="9" fill="#111" font-family="Segoe UI, Arial, sans-serif">${symbol.title}</text>`);
      out.push(`<text x="${bx + 8}" y="${by + cellH - 11}" font-size="9" fill="#666" font-family="Segoe UI, Arial, sans-serif">${symbol.titleFa}</text>`);
    });
    y += Math.ceil(symbols.length / perRow) * cellH + 16;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${y}" width="${width}" height="${y}">` +
    `<rect width="${width}" height="${y}" fill="#fff"/>${out.join('')}</svg>`;
}
