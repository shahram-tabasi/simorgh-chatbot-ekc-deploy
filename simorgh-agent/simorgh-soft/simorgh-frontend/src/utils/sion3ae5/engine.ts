// src/utils/sion3ae5/engine.ts
//
// SION 3AE5 vacuum circuit-breaker: specification text → article number.
//
// A port of the office's "SION 3AE5 order code builder" (catalog HG 11.02,
// 10/2022) with the page taken away: the same tables, the same parser, the same
// rules, working on a plain state object so a screen can hold it, save it with
// the scope it belongs to, and redraw from it.
//
//   decode(text)        reads a specification into a state
//   evaluate(state)     the 16 positions, order codes, notes and open questions
//   setField(state,...) one answer, with the knock-on the builder applies
//
// The article number is 3AE5 + 12 positions (5–16) and, after -Z, order codes:
//   3AE5 ABC-D EFGH-I JKL  -Z  F30+F32 …
import { DATA, type PrimaryRow } from './data';

// ── Catalog tables ──────────────────────────────────────────────────────
// key, label, closing/motor letter (pos 10/14), release digit (pos 11/12),
// special suffix (L1x / M1x), 3rd-release J-code
export type Volt = [string, string, string, string, string | null, string];
export const VOLTS: Volt[] = [
  ['DC24', 'DC 24 V', 'B', '1', null, 'J80'], ['DC30', 'DC 30 V', 'M', '9', 'A', 'J81'], ['DC32', 'DC 32 V', 'N', '9', 'B', 'J82'],
  ['DC48', 'DC 48 V', 'C', '2', null, 'J83'], ['DC60', 'DC 60 V', 'D', '3', null, 'J84'], ['DC110', 'DC 110 V', 'E', '4', null, 'J85'],
  ['DC120', 'DC 120 V', 'P', '9', 'C', 'J86'], ['DC125', 'DC 125 V', 'Q', '9', 'D', 'J87'], ['DC127', 'DC 127 V', 'R', '9', 'E', 'J88'],
  ['DC220', 'DC 220 V', 'F', '5', null, 'J89'], ['DC240', 'DC 240 V', 'S', '9', 'F', 'J90'],
  ['AC100', 'AC 100 V', 'H', '6', null, 'J92'], ['AC110', 'AC 110 V', 'J', '7', null, 'J93'], ['AC120', 'AC 120 V', 'U', '9', 'K', 'J95'],
  ['AC125', 'AC 125 V', 'V', '9', 'L', 'J96'], ['AC230', 'AC 230 V', 'K', '8', null, 'J97'], ['AC240', 'AC 240 V', 'W', '9', 'M', 'J98'],
];
const VMAP: Record<string, Volt> = Object.fromEntries(VOLTS.map(v => [v[0], v]));

export const REL: Record<string, string> = {
  none: 'None', sh30: 'Shunt release 30 ms', sh45: 'Shunt release 45 ms', uv: 'Undervoltage release',
  ct05: 'C.t.-operated release 0.5 A', ct1: 'C.t.-operated release 1 A', ct5: 'C.t.-operated release 5 A',
  ctp: 'C.t.-operated release, pulse ≥0.1 Ws (20 Ω)',
};
// [2nd, 3rd, position 9, order codes]
export const COMBOS: [string, string, string, string[]][] = [
  ['none', 'none', 'A', []], ['sh30', 'none', 'B', ['G39']], ['sh45', 'none', 'B', []], ['uv', 'none', 'F', []],
  ['ct05', 'none', 'G', []], ['ct5', 'none', 'G', ['A49']], ['ct1', 'none', 'H', []], ['ctp', 'none', 'C', []],
  ['sh45', 'sh45', 'B', ['F15']], ['sh45', 'ct05', 'T', []], ['sh45', 'ct5', 'T', ['A49']], ['sh45', 'ct1', 'T', ['A46']], ['sh45', 'ctp', 'T', ['A45']],
  ['uv', 'sh45', 'S', []], ['uv', 'ct05', 'V', []], ['uv', 'ct5', 'V', ['A49']], ['uv', 'ct1', 'V', ['A46']], ['uv', 'ctp', 'V', ['A45']],
  ['ct05', 'ct05', 'U', []], ['ct5', 'ct5', 'U', ['A49']],
];
export const INST: Record<string, [string, string[], string]> = {
  '0': ['0', [], 'Fixed mounting, circuit-breaker only'],
  'F2': ['2', ['M22'], 'Fixed mounting, with contact arms and contact systems'],
  'F3': ['3', ['M23'], 'Fixed mounting, with contact arms, contact systems, bushings and fixed contacts'],
  '1': ['1', [], 'On withdrawable part'],
  '2': ['2', [], 'On withdrawable part, with contact arms and contact systems (tulips)'],
  '3': ['3', [], 'On withdrawable part, with contact arms, contact systems, bushings and fixed contacts'],
  '5': ['5', [], 'On withdrawable part in mounting frame, with contact arms, contact systems, bushings, fixed contacts, shutters'],
  '6': ['6', [], 'On withdrawable part in mounting frame, with contact arms, contact systems, bushings, fixed contacts, shutters and earthing switch with short-circuit making capacity'],
};
const IFACE: Record<string, string> = { '20': 'Internal 20-pole connection strip', '64': '64-pole plug', 'X': 'Extended cable harness with 64-pole plug' };
const HARNESS: Record<string, string> = { B02: '500 mm', B01: '800 mm', B04: '1200 mm', B05: '1500 mm', B03: '2000 mm', B06: '2500 mm', B07: '3000 mm', B08: '3500 mm' };
export const LANG: Record<string, [string, number]> = { de: ['German', 0], en: ['English', 2], fr: ['French', 4], es: ['Spanish', 6] };
const GEAR: Record<string, string> = {
  std: 'Siemens racking concept (standard)', nxair: 'For NXAIR (W63)', simo: 'For SIMOPRIME (W66)',
  w89: 'Third-party withdrawable part, Siemens contacts (W89)', w88: 'Third-party withdrawable part and contacts (W88)',
};
const SHELL: Record<string, string> = {
  '': 'None', D90: 'D90 normal design', D91: 'D91 shortened design', D92: 'D92 GT4 design (fixed only)',
  D93: 'D93 for third-party racking', D94: 'D94 fully shortened design',
};
export const EXTRAS: [string, string][] = [
  ['F30', 'Hand crank for charging the closing spring'], ['F31', 'Long hand crank for charging the closing spring'],
  ['F32', 'Hand crank for racking (withdrawable part)'], ['A30', 'Anti-condensation heater 230 V AC'], ['A29', 'Anti-condensation heater 110 V AC'],
  ['A40', 'Operation down to −25 °C'], ['A47', 'Electrical closing lockout'], ['J60', 'Key-operated interlock'],
  ['A10', 'Halogen-free, flame-retardant wiring'], ['A05', 'Cable ends with destination marking'], ['A21', 'Gold-plated aux. switch 12 NO + 12 NC with 64-pole plug'],
  ['M13', 'Contact system with 13 contact fingers'], ['M30', 'Frequent operation, 30,000 cycles'], ['S49', 'Auxiliary switch fully wired (fixed only)'],
  ['E13', 'Ud = 42 kV (12 kV)'], ['E95', 'Up = 95 kV (12 kV)'], ['E16', 'Ud = 32 kV (7.2 kV)'], ['E65', 'Ud = 65 kV (24 kV)'], ['E46', 'Isc = 21 / 26.3 kA (12 kV, 20/25 kA)'],
  ['D23', 'Withdrawable part, 200 mm racking path'], ['D24', 'Withdrawable part, 180 mm racking path'], ['D22', 'Withdrawable part, 220 mm racking path (24 kV)'],
  ['F20', 'Routine test certificate enclosed'], ['F21', 'Routine test certificate, stamped and signed'], ['F23', 'Routine test certificate by e-mail'], ['F17', 'Extended routine test certificate'],
  ['F27', 'Operating sequence O-3 min-CO-3 min-CO'], ['F38', 'Operating sequence O-0.3 s-CO-3 min-CO'],
  ['B00', 'Additional nameplate, loose'], ['W70', 'Warranty 24 months'], ['W71', 'Warranty 36 months'], ['W72', 'Warranty 60 months'], ['W73', 'Warranty 84 months'],
  // The rest of HG 11.02 pages 31–32, so every order code can be ticked.
  ['A13', 'Flat connector with insulating sleeve'], ['A31', 'Version free of silicone emissions'],
  ['B17', 'Lower part of plug at the end of the extended harness + upper part, enclosed (15th position X)'],
  ['B23', 'Without upper part of plug'], ['B24', 'Without material pack'], ['B99', 'Special circuit diagram (on request)'],
  ['D28', 'Protective barrier angled at the top (24 kV; <2000 A only with D59)'],
  ['D55', 'Protective barrier between pole side and operating mechanism side (not with D59)'],
  ['D56', 'Circuit-breaker shaft cover (not with D59)'], ['D59', 'Circuit-breaker with wide housing'],
  ['D98', 'Insulating shell, only lower part (24 kV, with D90 or D91)'], ['E02', '2 kV / 1 min test for secondary systems instead of 1 kV / 1 s'],
  ['J18', 'Fixing bracket for fixed mounting'],
  ['M04', 'Third-party withdrawable part, motorized racking 110 V DC (W88/W89)'], ['M05', 'Third-party withdrawable part, motorized racking 220 V DC (W88/W89)'],
  ['Y40', 'Operating instructions and special labels for USA'], ['Y99', 'Other special version (clear text)'],
];

/**
 * SIMOPRIME World (design catalogue, issue 23, 06/2026, 2.2.2.9): the 3AE5
 * types the panel takes, and whether each must carry D50 and D59. W66 and F20
 * are mandatory on every one; the breaker is motor operated with 12 NO + 12 NC.
 */
export const SIMOPRIME_WORLD: Record<string, [d50: boolean, d59: boolean]> = {
  '3AE5124-1': [false, true],
  '3AE5285-3': [true, false],
  '3AE5124-2': [false, true],
  '3AE5225-1': [true, false],
  '3AE5184-2': [false, true],
  '3AE5225-2': [true, false],
  '3AE5184-3': [false, true],
  '3AE5186-2': [false, false],
  '3AE5125-1': [false, true],
  '3AE5186-6': [false, false],
  '3AE5125-2': [false, true],
  '3AE5286-2': [true, false],
  '3AE5185-2': [false, true],
  '3AE5286-6': [true, false],
  '3AE5185-3': [false, true],
  '3AE5224-1': [true, true],
  '3AE5224-2': [true, true],
  '3AE5284-2': [true, true],
  '3AE5284-3': [true, true],
  '3AE5184-6': [false, false],
  '3AE5185-6': [false, false],
  '3AE5186-8': [false, false],
  '3AE5285-6': [true, false],
  '3AE5286-8': [true, false],
  '3AE5284-6': [true, false],
  '3AE5186-7': [false, false],
  '3AE5285-2': [true, false],
  '3AE5286-7': [true, false],
};

const PRIM = ['kv', 'ka', 'pcd', 'vdt', 'ir'] as const;
type Prim = typeof PRIM[number];
const isPrim = (f: string): f is Prim => (PRIM as readonly string[]).includes(f);
const PRIMLBL: Record<Prim, string> = {
  kv: 'Rated voltage', ka: 'Short-circuit breaking current', pcd: 'Pole-center distance',
  vdt: 'Vertical distance between terminals', ir: 'Rated continuous current',
};
const UNIT: Record<Prim, string> = { kv: 'kV', ka: 'kA', pcd: 'mm', vdt: 'mm', ir: 'A' };
const IDX: Record<Prim, number> = { kv: 1, ka: 2, pcd: 3, vdt: 4, ir: 5 };
/** A primary type's rating. */
const val = (r: PrimaryRow, f: Prim): number => r[IDX[f]] as number;

export const FIELD_LABEL: Record<string, string> = {
  gear: 'Target switchgear', rel2: '2nd release', rel3: '3rd release', vClose: 'Closing solenoid voltage',
  vRel1: '1st release (shunt 30 ms) voltage', vRel2: '2nd release voltage', vRel3: '3rd release voltage',
  vMotor: 'Motor (spring charging) voltage', inst: 'Installation scope', iface: 'Low-voltage interface',
  aux: 'Auxiliary switch', harness: 'Cable harness length', lang: 'Operating instructions / nameplate language',
  freq: 'Frequency of AC control voltages', shell: 'Insulating shell', ...PRIMLBL,
};
const WHY: Record<string, string> = {
  ir: 'Not stated in the text.', pcd: 'Depends on the panel; both are offered for this rating.', vdt: 'Depends on the panel.',
  inst: '“Withdrawable” covers several delivery scopes.', aux: 'The text says auxiliary contacts but not how many.',
  vClose: 'Only one voltage was found in the text; it was applied here.', vRel1: 'Only one voltage was found in the text; it was applied here.',
  vRel2: 'Only one voltage was found in the text; it was applied here.', vRel3: 'Only one voltage was found in the text; it was applied here.',
  vMotor: 'Only one voltage was found in the text; it was applied here.', freq: 'An AC control voltage is selected.',
  shell: 'Required for this voltage or configuration.', rel2: 'Confirm there is no 2nd release.', gear: 'Pick the racking concept.',
};

/** How a value got there. */
export type Source = 'found' | 'assumed' | 'derived' | 'user' | 'default' | null;

export interface SionState {
  kv: number | null; ka: number | null; pcd: number | null; vdt: number | null; ir: number | null;
  gear: string | null; rel2: string | null; rel3: string | null;
  vClose: string | null; vRel1: string | null; vRel2: string | null; vRel3: string | null; vMotor: string | null;
  inst: string | null; iface: string; aux: string | null; harness: string | null;
  lang: string; freq: string | null; shell: string;
  extras: string[]; custom: string;
  /** The panel the breaker goes into, when its catalogue narrows the choice
   *  ('SIMOPRIME-WORLD'). */
  panel?: string | null;
  /** Where each value came from — drives the colours and the questions. */
  st: Record<string, Source>;
  /** What the parser had to say about the text. */
  parseNotes: string[];
  /** Order codes the engineer took off, though the rules add them (W66 on a
   *  project at home, for one). */
  off?: string[];
}

/** Defaults: 64-pole plug, English instructions, Siemens racking. */
export function blank(): SionState {
  return {
    kv: null, ka: null, pcd: null, vdt: null, ir: null, gear: 'std', rel2: null, rel3: 'none',
    vClose: null, vRel1: null, vRel2: null, vRel3: null, vMotor: null,
    inst: null, iface: '64', aux: null, harness: null, lang: 'en', freq: null, shell: '', extras: [], custom: '',
    st: { gear: 'default', rel3: 'default', iface: 'default', lang: 'default', shell: 'default' },
    parseNotes: [],
  };
}

const clone = (s: SionState): SionState => ({ ...s, extras: [...s.extras], st: { ...s.st }, parseNotes: [...s.parseNotes], off: [...(s.off ?? [])] });

// ── Parser ──────────────────────────────────────────────────────────────
function volt(txt: string): { key: string | null; raw: string }[] {
  const out: { key: string | null; raw: string }[] = [];
  const re = /(?:\b(AC|DC)\s*(\d{2,3})\s*V(?:OLTS?)?\b|\b(\d{2,3})\s*V(?:OLTS?)?\s*(AC|DC)\b|\b(\d{2,3})\s*V(AC|DC)\b)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(txt))) {
    const kind = m[1] || m[4] || m[6];
    const n = m[2] || m[3] || m[5];
    const k = kind + n;
    out.push({ key: VMAP[k] ? k : null, raw: `${kind} ${n} V` });
  }
  return out;
}

/** A specification, as English text, read into a state. */
export function decode(text: string): SionState {
  const S = blank();
  const notes = S.parseNotes;
  const set = (f: string, v: any, s: Source = 'found') => { (S as any)[f] = v; S.st[f] = s; };
  const unset = (f: string) => { (S as any)[f] = null; S.st[f] = null; };
  const T = ' ' + text.toUpperCase().replace(/[–—]/g, '-') + ' ';
  let wd = false;

  // ratings
  let m = T.match(/(\d{1,2}(?:[.,]\d)?)\s*KV\b/);
  if (m) {
    const v = parseFloat(m[1].replace(',', '.'));
    if ([7.2, 12, 17.5, 24].includes(v)) set('kv', v);
    else notes.push(`Rated voltage ${v} kV is not in the 3AE5 range (7.2 / 12 / 17.5 / 24 kV).`);
  }
  m = T.match(/(\d{2}(?:[.,]\d)?)\s*KA\b/); if (m) set('ka', parseFloat(m[1].replace(',', '.')));
  m = T.match(/KA\s*\/\s*(\d)\s*S(?:EC)?/);
  if (m) notes.push(`Short-time duration ${m[1]} s is not part of the article number; check it against the technical data / nameplate.`);
  m = T.match(/(?<![\d.K])(\d{3,4})\s*A(?:MP(?:S)?)?\b/); if (m && +m[1] >= 630) set('ir', +m[1]);
  m = T.match(/(?:PCD|POLE[\s-]*(?:CENTRE|CENTER)(?:\s*DISTANCE)?|PHASE\s*(?:DISTANCE|SPACING|PITCH))\D{0,12}(\d{3})/); if (m) set('pcd', +m[1]);
  m = T.match(/(?:VDT|VERTICAL\s*DISTANCE|TERMINAL\s*DISTANCE|DISTANCE\s*BETWEEN\s*TERMINALS)\D{0,25}(\d{3})/); if (m) set('vdt', +m[1]);
  // target switchgear
  if (/NXAIR/.test(T)) set('gear', 'nxair');
  else if (/SIMOPRIME/.test(T)) set('gear', 'simo');
  else if (/THIRD[\s-]*PARTY|OTHER\s*MANUFACTURER/.test(T)) unset('gear');
  // installation
  const withdrawable = /WITHDRAW|DRAW[\s-]*OUT|TRUCK|TROLLEY|RACK(?:ING|ABLE)/.test(T);
  if (/EARTHING\s*SWITCH|EARTH\s*SWITCH/.test(T) && withdrawable) set('inst', '6');
  else if (/MOUNTING\s*FRAME/.test(T) && withdrawable) set('inst', '5');
  else if (withdrawable) { unset('inst'); wd = true; }
  else if (/FIXED/.test(T)) set('inst', '0');
  // releases
  const uv = /UNDER[\s-]*VOLTAGE|\bUVR?\b|\bU\/V\b/.test(T);
  const shunt2 = /(2ND|SECOND|DOUBLE|TWO|2)\.?\s*(?:NOS?\.?\s*)?SHUNT|SHUNT[^,;.]{0,25}(2ND|SECOND)/.test(T);
  const sh45 = /45\s*MS/.test(T);
  const ctm = T.match(/(?:C\.?\s*T\.?[\s-]*OPERATED|TRANSFORMER[\s-]*OPERATED|CT[\s-]*RELEASE)[^,;]{0,30}?(0[.,]5|1|5)\s*A/);
  const ctAny = /C\.?\s*T\.?[\s-]*OPERATED|TRANSFORMER[\s-]*OPERATED|CT[\s-]*RELEASE/.test(T);
  const ctKey = ctm ? ({ '0.5': 'ct05', '0,5': 'ct05', '1': 'ct1', '5': 'ct5' } as Record<string, string>)[ctm[1]] : null;
  if (uv && shunt2) { set('rel2', 'uv'); set('rel3', 'sh45'); }
  else if (uv && ctAny) { set('rel2', 'uv'); if (ctKey) set('rel3', ctKey); else unset('rel3'); }
  else if (uv) set('rel2', 'uv');
  else if (shunt2) { if (sh45) set('rel2', 'sh45'); else unset('rel2'); }
  else if (ctAny) { if (ctKey) set('rel2', ctKey); else unset('rel2'); }
  else if (/SHUNT/.test(T)) set('rel2', 'none', 'assumed');
  // voltages, clause by clause
  const found: Record<string, string> = {};
  for (const c of T.split(/[,;]|&|\bAND\b|\+/)) {
    const all = volt(c);
    all.filter(v => !v.key).forEach(b => notes.push(`Voltage ${b.raw} is not a catalog voltage; pick the nearest one.`));
    const vs = all.filter(v => v.key);
    if (!vs.length) continue;
    const v = vs[0].key!;
    if (/MOTOR|MECHANISM|SPRING\s*CHARG/.test(c)) found.vMotor = v;
    if (/CLOS(?:ING)?\s*(?:COIL|SOLENOID|RELEASE)/.test(c)) found.vClose = v;
    if (/UNDER[\s-]*VOLTAGE|\bUVR?\b/.test(c)) { if (S.rel2 === 'uv') found.vRel2 = v; }
    if (/SHUNT|TRIP(?:PING)?\s*COIL/.test(c) && !/UNDER/.test(c)) found.vRel1 = v;
    if (/CONTROL|AUXILIARY\s*VOLTAGE|AUX\.?\s*SUPPLY|SUPPLY\s*VOLTAGE/.test(c)) {
      ['vMotor', 'vClose', 'vRel1', 'vRel2'].forEach(k => { if (!found[k]) found[k] = v; });
    }
  }
  Object.entries(found).forEach(([k, v]) => set(k, v));
  const every = [...new Set(volt(T).filter(v => v.key).map(v => v.key!))];
  if (every.length === 1) { // one voltage in the whole text: assumed for the other coils
    (['vMotor', 'vClose', 'vRel1'] as const).forEach(k => { if (!S[k]) set(k, every[0], 'assumed'); });
    if (['sh30', 'sh45', 'uv'].includes(S.rel2 ?? '') && !S.vRel2) set('vRel2', every[0], 'assumed');
    if (S.rel3 === 'sh45' && !S.vRel3) set('vRel3', every[0], 'assumed');
  }
  // auxiliary switch and interface
  m = T.match(/(\d{1,2})\s*NO\s*[+&/,]?\s*(\d{1,2})\s*NC/);
  if (m) {
    set('aux', +m[1] <= 6 && +m[2] <= 6 ? '6' : '12');
    if (!['6', '12'].includes(m[1])) notes.push(`Requested ${m[1]} NO + ${m[2]} NC; the catalog offers 6 NO + 6 NC or 12 NO + 12 NC.`);
  }
  if (/HARNESS/.test(T)) set('iface', 'X');
  else if (/20[\s-]*(?:POLE|PIN)|CONNECTION\s*STRIP|TERMINAL\s*STRIP/.test(T)) set('iface', '20');
  else if (/64[\s-]*(?:POLE|PIN)/.test(T)) set('iface', '64');
  // language and frequency
  if (/60\s*HZ/.test(T) && !/50\s*\/\s*60/.test(T)) set('freq', '60'); else if (/\b50\s*HZ/.test(T)) set('freq', '50');
  if (/GERMAN/.test(T)) set('lang', 'de'); else if (/FRENCH/.test(T)) set('lang', 'fr'); else if (/SPANISH/.test(T)) set('lang', 'es');
  // order codes the text asks for
  const ex = (c: string) => { if (!S.extras.includes(c)) S.extras.push(c); };
  if (/MANUAL/.test(T)) ex('F30');
  if (/KEY[\s-]*(?:OPERATED\s*)?INTERLOCK/.test(T)) ex('J60');
  if (/CLOSING\s*LOCK[\s-]*OUT/.test(T)) ex('A47');
  const heater = T.match(/(HEATER|ANTI[\s-]*CONDENSATION)[^,;]*/);
  if (heater) ex(/110\s*V/.test(heater[0]) ? 'A29' : 'A30');
  if (/-\s*25\s*°?\s*C/.test(T)) ex('A40');
  if (/HALOGEN/.test(T)) ex('A10');
  if (/30[,.]?000/.test(T)) ex('M30');
  // A withdrawable breaker comes with its racking crank.
  if (wd) ex('F32');
  if (!/CLOS/.test(T)) notes.push('Closing solenoid is standard equipment on every 3AE5 – its voltage is still needed.');
  if (/MANUAL/.test(T) && !/MOTOR/.test(T)) notes.push('The 3AE5 always has the motor-operating mechanism code (position 14); manual charging is done with the hand crank F30.');
  if (S.gear === null) notes.push('Third-party racking concept mentioned: choose W89 or W88.');
  return S;
}

// ── Rules ───────────────────────────────────────────────────────────────
const baseRows = (S: SionState): PrimaryRow[] => {
  const nx = S.gear === 'nxair';
  const world = S.panel === 'SIMOPRIME-WORLD';
  return DATA.filter(r => (nx ? r[6] === 1 : r[6] === 0) && (!world || r[0] in SIMOPRIME_WORLD));
};
function optionsFor(S: SionState, f: Prim): number[] {
  const rows = baseRows(S).filter(r => PRIM.every(g => g === f || S[g] == null || val(r, g) === S[g]));
  return [...new Set(rows.map(r => val(r, f)))].sort((a, b) => a - b);
}
/** Fill in what the other ratings leave only one answer for. */
function derive(S: SionState) {
  PRIM.forEach(f => { if (S.st[f] === 'derived') { S[f] = null; S.st[f] = null; } });
  for (let i = 0; i < 5; i++) {
    let changed = false;
    PRIM.forEach(f => {
      if (S[f] == null) {
        const o = optionsFor(S, f);
        if (o.length === 1) { S[f] = o[0]; S.st[f] = 'derived'; changed = true; }
      }
    });
    if (!changed) break;
  }
  if (S.iface === 'X' && S.aux !== '12') { S.aux = '12'; S.st.aux = 'derived'; }
}
const candidates = (S: SionState) => baseRows(S).filter(r => PRIM.every(g => S[g] == null || val(r, g) === S[g]));
const theRow = (S: SionState) => {
  const c = candidates(S);
  return PRIM.every(f => S[f] != null) && c.length === 1 ? c[0] : null;
};
const wideStd = (r: PrimaryRow | null) => !!r && (r[5] >= 2000 || r[2] === 40);
const isAC = (S: SionState) => (['vClose', 'vRel1', 'vRel2', 'vRel3', 'vMotor'] as const).some(k => S[k]?.startsWith('AC'));
const valid3 = (r2: string | null) => [...new Set(COMBOS.filter(c => c[0] === r2).map(c => c[1]))];

function needs(S: SionState): Record<string, boolean> {
  const n: Record<string, boolean> = {};
  PRIM.forEach(f => { n[f] = true; });
  ['gear', 'rel2', 'rel3', 'vClose', 'vRel1', 'vMotor', 'inst', 'iface', 'aux', 'lang'].forEach(f => { n[f] = true; });
  if (['sh30', 'sh45', 'uv'].includes(S.rel2 ?? '')) n.vRel2 = true;
  if (S.rel3 === 'sh45') n.vRel3 = true;
  if (S.iface === 'X') n.harness = true;
  if (isAC(S)) n.freq = true;
  if (S.kv === 24 || ['w88', 'w89'].includes(S.gear ?? '') || ['E13', 'E95', 'E16', 'E65'].some(c => S.extras.includes(c))) n.shell = true;
  return n;
}

export type FieldStatus = 'ok' | 'amb' | 'miss' | 'conflict' | null;

function statusOf(S: SionState, f: string, n: Record<string, boolean>): FieldStatus {
  if (!n[f]) return null;
  const v = (S as any)[f];
  if (v == null || v === '') {
    if (f === 'shell' && ['w88', 'w89'].includes(S.gear ?? '')) return 'ok';
    return 'miss';
  }
  if (isPrim(f) && !optionsFor(S, f).includes(v)) return 'conflict';
  return S.st[f] === 'assumed' ? 'amb' : 'ok';
}

export interface Position { c: string; s: 'ok' | 'amb' | 'miss' | 'part' }
export interface Question { field: string; label: string; status: 'miss' | 'amb' | 'conflict'; why: string }
export interface Evaluation {
  /** Positions 1–16 (index 0 unused). */
  pos: Position[];
  codes: string[];
  notes: { text: string; warn?: boolean }[];
  /** The one primary type the ratings point to, when they point to one. */
  primary: PrimaryRow | null;
  /** How many primary types the ratings still allow. */
  candidates: number;
  questions: Question[];
  status: Record<string, FieldStatus>;
  code: string;
  description: string;
  /** The state with derived ratings filled in. */
  state: SionState;
  /** Order codes the rules gave but the engineer took off. */
  removed: string[];
}

const QUESTION_ORDER = ['kv', 'ka', 'ir', 'pcd', 'vdt', 'gear', 'inst', 'rel2', 'rel3', 'vClose', 'vRel1', 'vRel2', 'vRel3',
  'vMotor', 'aux', 'iface', 'harness', 'freq', 'lang', 'shell'];

export function evaluate(input: SionState): Evaluation {
  const S = clone(input);
  derive(S);
  const notes: { text: string; warn?: boolean }[] = S.parseNotes.map(text => ({ text }));
  const warn = (text: string) => notes.push({ text, warn: true });
  const codes = new Set<string>();
  const cand = candidates(S);
  const r = theRow(S);
  const src = (f: string): 'ok' | 'amb' => (S.st[f] === 'assumed' ? 'amb' : 'ok');

  const pos: Position[] = Array.from({ length: 17 }, () => ({ c: '?', s: 'miss' as const }));
  '3AE5'.split('').forEach((c, i) => { pos[i + 1] = { c, s: 'ok' }; });
  const pst = PRIM.some(f => S.st[f] === 'assumed') ? 'amb' : 'ok';
  for (let i = 4; i < 8; i++) {
    const ci = i < 7 ? i : 8; // character in "3AE5ABC-D"
    const chars = [...new Set(cand.map(x => x[0][ci]))];
    pos[i + 1] = chars.length === 1 ? { c: chars[0], s: r ? pst : 'part' } : { c: '?', s: 'miss' };
  }
  if (!cand.length) warn('No 3AE5 matches this combination of ratings. Change one of the rating fields.');
  if (r && r[6]) codes.add('W63');

  // releases
  const cb = COMBOS.find(c => c[0] === S.rel2 && c[1] === S.rel3);
  const relSt = S.st.rel2 === 'assumed' || S.st.rel3 === 'assumed' ? 'amb' : 'ok';
  if (cb) { pos[9] = { c: cb[2], s: relSt }; cb[3].forEach(c => codes.add(c)); }
  else if (S.rel2 && S.rel3) warn(`Release combination “${REL[S.rel2]} + ${REL[S.rel3]}” is not in the catalog (on request).`);
  if (S.vClose) pos[10] = { c: VMAP[S.vClose][2], s: src('vClose') };
  if (S.vRel1) { const v = VMAP[S.vRel1]; pos[11] = { c: v[3], s: src('vRel1') }; if (v[4]) codes.add('L1' + v[4]); }
  if (S.rel2 && !['sh30', 'sh45', 'uv'].includes(S.rel2)) pos[12] = { c: '0', s: relSt };
  else if (S.vRel2) { const v = VMAP[S.vRel2]; pos[12] = { c: v[3], s: src('vRel2') }; if (v[4]) codes.add('M1' + v[4]); }
  if (S.rel3 === 'sh45' && S.vRel3) codes.add(VMAP[S.vRel3][5]);
  if (S.rel3 && S.rel3 !== 'none') {
    if (r && !wideStd(r)) { codes.add('D59'); notes.push({ text: 'A 3rd release needs the wide housing – D59 added.' }); }
    if (r && r[6] && !wideStd(r)) warn('Check wide-housing availability for this NXAIR rating with Siemens.');
  }
  // installation
  if (S.inst) {
    const I = INST[S.inst];
    pos[13] = { c: I[0], s: src('inst') };
    I[1].forEach(c => codes.add(c));
    if (['5', '6'].includes(S.inst) && S.pcd && S.vdt) {
      const ok = S.kv === 24 ? [210, 275].includes(S.pcd) && S.vdt === 310 : [150, 210].includes(S.pcd) && [275, 310].includes(S.vdt);
      if (!ok) warn('Mounting frame (13th position 5/6) is only available for PCD 150/210 mm with VDT 275/310 mm (≤17.5 kV) or PCD 210/275 mm with VDT 310 mm (24 kV).');
    }
  }
  if (S.vMotor) pos[14] = { c: VMAP[S.vMotor][2], s: src('vMotor') };
  // interface
  if (S.iface && S.aux) {
    const L = ({ '20/6': 'A', '20/12': 'J', '64/6': 'V', '64/12': 'N', 'X/12': 'X' } as Record<string, string>)[`${S.iface}/${S.aux}`];
    if (L) pos[15] = { c: L, s: S.st.aux === 'assumed' || S.st.iface === 'assumed' ? 'amb' : 'ok' };
    else warn('Extended cable harness is only available with 12 NO + 12 NC.');
  }
  if (S.iface === 'X' && S.harness) codes.add(S.harness);
  // language and frequency
  const f = isAC(S) ? S.freq : (S.freq || '50');
  if (S.lang && f) pos[16] = { c: String(LANG[S.lang][1] + (f === '60' ? 1 : 0)), s: 'ok' };
  // racking concept
  if (S.panel === 'SIMOPRIME-WORLD') {
    codes.add('W66'); codes.add('F20');
    const must = r ? SIMOPRIME_WORLD[r[0]] : undefined;
    if (must?.[0]) codes.add('D50');
    if (must?.[1]) codes.add('D59');
    if (!cand.length) warn('None of the 3AE5 types SIMOPRIME World takes matches these ratings.');
  }
  if (S.gear === 'simo') {
    codes.add('W66');
    if (S.inst && S.inst !== '0') warn('W66 (SIMOPRIME) is for fixed mounting – 13th position should be 0.');
  }
  if (['w88', 'w89'].includes(S.gear ?? '')) {
    codes.add(S.gear!.toUpperCase()); codes.add('D93');
    if (S.inst && !['1', '2'].includes(S.inst)) warn('W88/W89 need 13th position 1 or 2.');
    notes.push({ text: 'W88/W89 is only released for some ratings (see the primary-data tables) and always needs insulating shell D93.' });
  }
  if (S.shell && S.shell !== 'D93') codes.add(S.shell);
  if (S.shell === 'D92' && S.inst && S.inst !== '0') warn('D92 (GT4 shell) is for fixed mounting only.');
  if (S.kv === 24 && !S.shell && !['w88', 'w89'].includes(S.gear ?? '')) warn('Every 24 kV 3AE5 needs an insulating shell (D9x); NXAIR uses D91.');
  // additional order codes
  const has = (c: string) => S.extras.includes(c);
  S.extras.forEach(c => codes.add(c));
  if (has('A29') && has('A30')) warn('A29 and A30 cannot be combined.');
  if (has('A47') && has('J60')) warn('A47 and J60 cannot be combined.');
  if (has('F32') && S.inst === '0') warn('F32 is only useful with a withdrawable part.');
  if (has('S49') && S.inst && S.inst !== '0') warn('S49 (fully wired aux. switch) is only possible for fixed mounting.');
  if (has('M13') && ((S.ir && S.ir > 1250) || (S.ka && S.ka > 31.5))) warn('M13 is only for ≤1250 A and ≤31.5 kA.');
  if (has('M30') && r && !(r[5] >= 2000)) warn('M30 is listed only for some ratings – check the primary-data table.');
  if (['E13', 'E95', 'E46'].some(has) && S.kv && S.kv !== 12) warn('E13 / E95 / E46 are for 12 kV only.');
  if (has('E16') && S.kv && S.kv !== 7.2) warn('E16 is for 7.2 kV only.');
  if (has('E65') && S.kv && S.kv !== 24) warn('E65 is for 24 kV only.');
  if (['B06', 'B07', 'B08'].includes(S.harness ?? '') && (['vClose', 'vRel1', 'vRel2', 'vMotor'] as const).some(k => S[k] === 'DC24')) {
    warn('Harness ≥2500 mm is not allowed with DC 24 V.');
  }
  (S.custom || '').toUpperCase().split(/[\s,+;]+/).filter(Boolean).forEach(c => {
    if (/^[A-Z]\d{2}$/.test(c)) codes.add(c);
    else warn(`“${c}” is not a valid order code (format letter + 2 digits).`);
  });

  // What the engineer took off stays off — said once, not hidden.
  const removed = (S.off ?? []).filter(c => codes.delete(c));
  if (removed.length) notes.push({ text: `Taken off by hand: ${removed.join(', ')} — tick again to restore.` });
  const codeList = [...codes].sort();
  const n = needs(S);
  const status: Record<string, FieldStatus> = {};
  QUESTION_ORDER.forEach(fl => { status[fl] = statusOf(S, fl, n); });
  const questions: Question[] = QUESTION_ORDER
    .filter(fl => status[fl] === 'miss' || status[fl] === 'amb' || status[fl] === 'conflict')
    .map(fl => ({
      field: fl,
      label: FIELD_LABEL[fl],
      status: status[fl] as Question['status'],
      why: status[fl] === 'conflict' ? 'This value doesn’t exist together with the other ratings.' : (WHY[fl] ?? ''),
    }));

  const p = (i: number) => pos[i].c;
  let code = `${p(1)}${p(2)}${p(3)}${p(4)}${p(5)}${p(6)}${p(7)}-${p(8)}${p(9)}${p(10)}${p(11)}${p(12)}-${p(13)}${p(14)}${p(15)}${p(16)}`;
  if (codeList.length) code += '-Z ' + codeList.join('+');

  return {
    pos, codes: codeList, notes, primary: r, candidates: cand.length, questions, status, code,
    description: describe(S, r), state: S, removed,
  };
}

function describe(S: SionState, r: PrimaryRow | null): string {
  const V = (k: string | null) => (k ? VMAP[k][1] : '?');
  const L: string[] = [];
  L.push(`SION vacuum circuit-breaker 3AE5${r ? ` (${r[0]})` : ''}`);
  L.push(`Rated voltage ${S.kv ?? '?'} kV, 50/60 Hz; rated short-circuit breaking current ${S.ka ?? '?'} kA; rated continuous current ${S.ir ?? '?'} A`);
  L.push(`Pole-center distance ${S.pcd ?? '?'} mm; vertical distance between terminals ${S.vdt ?? '?'} mm`);
  if (S.inst) L.push(INST[S.inst][2]);
  L.push(`Closing solenoid ${V(S.vClose)}`);
  L.push(`1st release: shunt release 30 ms, ${V(S.vRel1)}`);
  if (S.rel2 && S.rel2 !== 'none') L.push(`2nd release: ${REL[S.rel2]}${S.vRel2 && ['sh30', 'sh45', 'uv'].includes(S.rel2) ? ', ' + V(S.vRel2) : ''}`);
  if (S.rel3 && S.rel3 !== 'none') L.push(`3rd release: ${REL[S.rel3]}${S.rel3 === 'sh45' && S.vRel3 ? ', ' + V(S.vRel3) : ''}`);
  L.push(`Motor-operating mechanism (stored-energy spring) ${V(S.vMotor)}${S.extras.includes('F30') ? ', manual charging with hand crank' : ''}`);
  L.push(`Low-voltage interface: ${IFACE[S.iface] || '?'}${S.iface === 'X' && S.harness ? ' ' + HARNESS[S.harness] : ''}; auxiliary switch ${S.aux ? labelOf('aux', S.aux) : '?'}`);
  L.push('Mechanical interlocking, circuit-breaker tripping signal, anti-pumping and operation counter included');
  L.push(`Operating instructions and nameplate: ${(LANG[S.lang] || ['?'])[0]}`);
  const ex = EXTRAS.filter(([c]) => S.extras.includes(c) && c !== 'F30').map(([c, l]) => `${l} (${c})`);
  if (ex.length) L.push('Options: ' + ex.join('; '));
  return L.join('\n');
}

// ── Answers ─────────────────────────────────────────────────────────────
export function labelOf(f: string, v: any): string {
  if (v == null || v === '') return '';
  if (isPrim(f)) return `${v} ${UNIT[f]}`;
  if (f.startsWith('v')) return VMAP[v]?.[1] ?? String(v);
  if (f === 'rel2' || f === 'rel3') return REL[v];
  if (f === 'inst') return INST[v][2];
  if (f === 'iface') return IFACE[v];
  if (f === 'aux') return v === '6' ? '6 NO + 6 NC' : '12 NO + 12 NC';
  if (f === 'harness') return HARNESS[v];
  if (f === 'lang') return LANG[v][0];
  if (f === 'freq') return `${v} Hz`;
  if (f === 'gear') return GEAR[v];
  if (f === 'shell') return SHELL[v];
  return String(v);
}

/** The choices for a field, as [value, label]. */
export function fieldOptions(S: SionState, f: string): [string, string][] {
  if (isPrim(f)) {
    const all = [...new Set(baseRows(S).map(r => val(r, f)))].sort((a, b) => a - b);
    const ok = optionsFor(S, f);
    return all.map(v => [String(v), labelOf(f, v) + (ok.includes(v) ? '' : ' (not with current choices)')]);
  }
  if (f.startsWith('v')) {
    return VOLTS.map(v => [v[0], v[1] + (v[4] || ((f === 'vClose' || f === 'vMotor') && 'MNPQRSUVW'.includes(v[2])) ? ' (special)' : '')]);
  }
  if (f === 'rel2') return [...new Set(COMBOS.map(c => c[0]))].map(k => [k, REL[k]]);
  if (f === 'rel3') return (S.rel2 ? valid3(S.rel2) : ['none']).map(k => [k, REL[k]]);
  if (f === 'inst') return Object.keys(INST).map(k => [k, `${INST[k][0]} – ${INST[k][2]}`]);
  if (f === 'iface') return Object.entries(IFACE);
  if (f === 'aux') return [['6', '6 NO + 6 NC'], ['12', '12 NO + 12 NC']];
  if (f === 'harness') return Object.entries(HARNESS);
  if (f === 'lang') return Object.keys(LANG).map(k => [k, LANG[k][0]]);
  if (f === 'freq') return [['50', '50 Hz'], ['60', '60 Hz']];
  if (f === 'gear') return Object.entries(GEAR);
  if (f === 'shell') return Object.entries(SHELL);
  return [];
}

/** One answer. Ratings are numbers; an empty answer clears the field. */
export function setField(input: SionState, f: string, raw: string | null): SionState {
  const S = clone(input);
  let v: any = raw === '' ? null : raw;
  if (isPrim(f) && v != null) v = parseFloat(v);
  if (f === 'shell' && v == null) v = '';
  (S as any)[f] = v;
  S.st[f] = v == null ? null : 'user';
  if (f === 'rel2') {
    const ok = valid3(S.rel2);
    if (!ok.includes(S.rel3 ?? '')) { S.rel3 = ok.length === 1 ? ok[0] : null; S.st.rel3 = ok.length === 1 ? 'derived' : null; }
  }
  return S;
}

/** An assumed value, taken as right. */
export function confirm(input: SionState, f: string): SionState {
  const S = clone(input);
  S.st[f] = 'user';
  return S;
}

export function toggleExtra(input: SionState, code: string, on: boolean): SionState {
  const S = clone(input);
  S.extras = on ? [...new Set([...S.extras, code])] : S.extras.filter(c => c !== code);
  if (on) S.off = (S.off ?? []).filter(c => c !== code);
  return S;
}

/** An order code in the result ticked on or off — the rules' own as well. */
export function toggleCode(input: SionState, code: string, on: boolean): SionState {
  const S = clone(input);
  S.off = on ? (S.off ?? []).filter(c => c !== code) : [...new Set([...(S.off ?? []), code])];
  if (!on) S.extras = S.extras.filter(c => c !== code);
  return S;
}

/** The fields shown in the form, by group. */
export const FORM_GROUPS: { label: string; fields: string[] }[] = [
  { label: 'Ratings', fields: ['kv', 'ka', 'ir', 'pcd', 'vdt'] },
  { label: 'Releases and coils', fields: ['rel2', 'rel3', 'vClose', 'vRel1', 'vRel2', 'vRel3', 'vMotor'] },
  { label: 'Installation', fields: ['gear', 'inst', 'shell'] },
  { label: 'Secondary interface and documents', fields: ['iface', 'aux', 'harness', 'lang', 'freq'] },
];
