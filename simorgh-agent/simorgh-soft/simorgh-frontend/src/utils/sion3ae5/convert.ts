// src/utils/sion3ae5/convert.ts
//
// A breaker from stock made into the one the project needs: which parts come
// off, which go on. Both article numbers are read back into what they say —
// releases and their voltages, motor, auxiliary switch, interface, options —
// each breaker's secondary parts are listed from the catalogue's spare-part
// tables, and the two lists are compared.
//
//   SION 3AE5  HG 11.02 · 10/2022, pages 33–35 (spare and mounting parts)
//   3AH3       HG 11.03 · 2018, pages 30–31
//
// The primary part (positions 1–8: voltage, short-circuit current, pole-centre
// distance, rated current) is the poles themselves — it is not changed with
// parts, and is said so.
//
// The anti-pumping is where the generations differ: an older SION does it with
// an auxiliary contactor, a SION since 2022 with an electronic module on its
// control board (3AY1420); a 3AH3 uses a contactor, 3TH20 up to serial number
// 3AH3/00015203 and 3RH1122 after. The article number does not say which, so
// it is asked.
import { VOLTS, COMBOS, INST, LANG, REL as AE5_REL } from './engine';
import { AH3_COMBOS, AUX, CLOSE_MECH, CLOSE_MANUAL, DIGITS, MOTOR, SPECIAL_SUFFIX, SPECIAL_V, STD_V, LANGS, RELEASE_LABEL as AH3_REL, type Release } from './ah3';

export type Family = '3AE5' | '3AH3';

/** What generation of anti-pumping a breaker has. */
export const GENERATIONS: Record<Family, [string, string][]> = {
  '3AE5': [
    ['board', 'Since 2022 — electronic module on the control board (3AY1420)'],
    ['contactor', 'Before 2022 — anti-pumping by auxiliary contactor'],
  ],
  '3AH3': [
    ['new2', 'Serial from 3AH3/00016908 — contactor 3RH1122'],
    ['new1', 'Serial 3AH3/00015204 … 00016907 — contactor 3RH1122'],
    ['old', 'Serial up to 3AH3/00015203 — contactor 3TH20 22-7'],
  ],
};

export interface Part {
  /** What it is for — the key the two breakers are compared on. */
  slot: string;
  label: string;
  /** Article number, or null where the catalogue has none for it. */
  article: string | null;
  note?: string;
}

export interface Parsed {
  family: Family;
  base: string;
  primary: string;
  pos: string[];
  codes: string[];
  /** What the positions say, for the reader. */
  reading: { label: string; value: string }[];
  parts: Part[];
  problems: string[];
}

// ── Voltages: "DC 110 V" ⇄ engine key "DC110" ─────────────────────────────
const key = (v: string | null) => (v ? v.replace(/\s/g, '').replace(/V$/, '') : null);
const kind = (k: string) => k.slice(0, 2);
const volts = (k: string) => +k.slice(2);
const label = (k: string | null) => (k ? `${kind(k)} ${volts(k)} V` : '?');
const inRange = (k: string, ac: boolean, lo: number, hi: number) => (kind(k) === 'AC') === ac && volts(k) >= lo && volts(k) <= hi;

// SION 3AE5 (HG 11.02 p. 33–34)
function ae5Solenoid(k: string): string | null { // closing solenoid / shunt release 30 ms
  if (inRange(k, false, 24, 32)) return '3AY1410-0B';
  if (k === 'DC48') return '3AY1410-0C';
  if (k === 'DC60') return '3AY1410-0D';
  if (inRange(k, false, 110, 127)) return '3AY1410-0E';
  if (inRange(k, false, 220, 240)) return '3AY1410-0F';
  if (inRange(k, true, 100, 125)) return '3AY1410-0J';
  if (inRange(k, true, 230, 240)) return '3AY1410-0K';
  return null;
}
function shunt45(k: string, hz60: boolean): string | null { // also the 3AH3's 2nd shunt release
  if (inRange(k, false, 24, 32)) return '3AX1101-2B';
  if (inRange(k, false, 48, 60)) return '3AX1101-2C';
  if (inRange(k, false, 110, 127)) return '3AX1101-2E';
  if (inRange(k, false, 220, 240)) return '3AX1101-2F';
  if (inRange(k, true, 100, 125)) return hz60 ? '3AX1101-3G' : '3AX1101-2G';
  if (inRange(k, true, 230, 240)) return hz60 ? '3AX1101-3J' : '3AX1101-2J';
  return null;
}
function undervoltage(k: string, hz60: boolean, ah3: boolean): string | null {
  const dc: Record<string, string> = { DC24: '2B', DC30: '2L', DC32: '2L', DC48: '2C', DC60: '2D', DC110: '2E', DC120: '2N', DC125: '2N', DC127: '2N', DC220: '2F' };
  if (ah3) dc.DC240 = '2P';
  if (dc[k]) return `3AX1103-${dc[k]}`;
  const ac: Record<number, string> = { 100: 'G', 110: 'H', 120: 'H', 125: 'H', 230: 'J', 240: 'M' };
  if (kind(k) === 'AC' && ac[volts(k)]) return `3AX1103-${hz60 ? 3 : 2}${ac[volts(k)]}`;
  return null;
}
function ae5Motor(k: string): string | null {
  if (inRange(k, false, 24, 32)) return '3AY1411-1B';
  if (inRange(k, false, 48, 60)) return '3AY1411-1C';
  if (inRange(k, false, 110, 127) || inRange(k, true, 100, 125)) return '3AY1411-1E';
  if (inRange(k, false, 220, 240) || inRange(k, true, 220, 240)) return '3AY1411-1F';
  return null;
}
function antiPumpModule(k: string): string | null {
  if (inRange(k, false, 24, 32)) return '3AY1420-2A';
  if (inRange(k, false, 48, 60)) return '3AY1420-2C';
  if (inRange(k, false, 110, 127) || inRange(k, true, 100, 125)) return '3AY1420-2E';
  if (inRange(k, false, 220, 240) || inRange(k, true, 230, 240)) return '3AY1420-2G';
  return null;
}
function closingLockout(k: string): string | null {
  if (inRange(k, false, 24, 32)) return '3AX1405-4B';
  if (inRange(k, false, 48, 60)) return '3AX1405-4C';
  if (inRange(k, false, 110, 127)) return '3AX1405-4E';
  if (inRange(k, false, 220, 240)) return '3AX1405-4F';
  if (inRange(k, true, 100, 125)) return '3AX1405-4G';
  if (inRange(k, true, 230, 240)) return '3AX1405-4J';
  return null;
}
const CT_AE5: Record<string, string> = { ct05: '3AX1102-2A', ct1: '3AX1102-2B', ct5: '3AX1402-2E', ctp: '3AX1104-2B' };

// 3AH3 (HG 11.03 p. 30–31)
function ah3Solenoid(k: string): string | null {
  const m: Record<string, string> = {
    DC24: 'K', DC30: 'M', DC32: 'M', DC48: 'C', DC60: 'D', DC110: 'E', DC120: 'E', DC125: 'L', DC127: 'L', DC220: 'F', DC240: 'F',
    AC100: 'E', AC110: 'E', AC120: 'E', AC125: 'E', AC230: 'F', AC240: 'F',
  };
  return m[k] ? `3AY1510-5${m[k]}` : null;
}
function ah3Motor(k: string): string | null {
  if (inRange(k, false, 24, 32)) return '3AY1511-3B';
  if (k === 'DC48') return '3AY1511-3C';
  if (k === 'DC60') return '3AY1511-3D';
  if (inRange(k, false, 100, 127) || inRange(k, true, 100, 127)) return '3AY1511-3E';
  if (inRange(k, false, 220, 250) || inRange(k, true, 220, 250)) return '3AY1511-3F';
  return null;
}
function contactor3TH20(k: string, hz60: boolean): string | null {
  if (inRange(k, false, 24, 32)) return 'SWB: 48683';
  const dc: Record<string, string> = { DC48: '48687', DC60: '48684', DC100: '48685', DC110: '48685', DC120: '48685', DC125: '47730', DC127: '47730', DC220: '48686', DC240: '48686' };
  if (dc[k]) return `SWB: ${dc[k]}`;
  if (inRange(k, true, 100, 125)) return hz60 ? 'SWB: 48679' : 'SWB: 48680';
  if (inRange(k, true, 230, 240)) return 'SWB: 55550';
  return null;
}
function contactor3RH(k: string): string | null {
  const m: Record<string, string> = {
    DC24: '55656', DC30: '55658', DC32: '55658', DC48: '55659', DC60: '55660', DC110: '55661', DC120: '55662', DC125: '55662', DC127: '55662',
    DC220: '55663', DC240: '55665', AC110: '55666', AC120: '55667', AC125: '55668', AC230: '55669', AC240: '55670',
  };
  return m[k] ? `SWB: ${m[k]}` : null;
}

// ── Reading an article number ────────────────────────────────────────────
/** "3AE5 124-2AE40-0EN2-Z F30+F32" → its 16 positions and order codes. */
function split(code: string): { pos: string[]; codes: string[] } | null {
  const t = code.toUpperCase().replace(/\s+/g, ' ').trim();
  const [main, z = ''] = t.split(/-?\s*Z\s+|-Z\b/);
  const chars = main.replace(/[^0-9A-Z]/g, '');
  if (chars.length !== 16) return null;
  const codes = (z.match(/[A-Z]\d[A-Z0-9]/g) ?? []);
  return { pos: chars.split(''), codes: [...new Set(codes)] };
}

export function parseArticle(code: string, generation: string): Parsed | null {
  const s = split(code);
  if (!s) return null;
  const family = s.pos.slice(0, 4).join('') as Family;
  if (family !== '3AE5' && family !== '3AH3') return null;
  return family === '3AE5' ? parseAe5(s.pos, s.codes, generation) : parseAh3(s.pos, s.codes, generation);
}

function base(pos: string[]) {
  return `${pos.slice(0, 7).join('')}-${pos.slice(7, 12).join('')}-${pos.slice(12, 16).join('')}`;
}

function parseAe5(pos: string[], codes: string[], gen: string): Parsed {
  const parts: Part[] = [];
  const reading: Parsed['reading'] = [];
  const problems: string[] = [];
  const has = (c: string) => codes.includes(c);
  const sixty = +pos[15] % 2 === 1;
  const byLetter = (c: string) => VOLTS.find(v => v[2] === c)?.[0] ?? null;
  const byDigit = (c: string, prefix: string) => {
    if (c === '9') { const sx = codes.find(x => x.startsWith(prefix))?.[2]; return VOLTS.find(v => v[4] === sx)?.[0] ?? null; }
    return VOLTS.find(v => v[3] === c && !v[4])?.[0] ?? null;
  };

  // 9: releases — the combination whose order codes the article carries.
  const combo = COMBOS.filter(c => c[2] === pos[8] && c[3].every(has)).sort((a, b) => b[3].length - a[3].length)[0];
  const [r2, r3] = combo ? [combo[0], combo[1]] : ['?', '?'];
  if (!combo) problems.push(`9th position ${pos[8]} is not a 3AE5 release combination.`);
  const vClose = byLetter(pos[9]);
  const vRel1 = byDigit(pos[10], 'L1');
  const vRel2 = pos[11] === '0' ? null : byDigit(pos[11], 'M1');
  const vRel3 = r3 === 'sh45' ? (VOLTS.find(v => has(v[5]))?.[0] ?? null) : null;
  const vMotor = byLetter(pos[13]);
  const iface = ({ A: ['20', '6'], J: ['20', '12'], V: ['64', '6'], N: ['64', '12'], X: ['X', '12'] } as Record<string, string[]>)[pos[14]];
  const inst = pos[12] === '2' && has('M22') ? 'F2' : pos[12] === '3' && has('M23') ? 'F3' : pos[12];
  const lang = Object.values(LANG).find(l => l[1] === +pos[15] - (sixty ? 1 : 0))?.[0];

  reading.push(
    { label: 'Primary part (ratings, poles)', value: `${pos.slice(0, 7).join('')}-${pos[7]}` },
    { label: 'Releases', value: `1st shunt 30 ms · 2nd ${AE5_REL[r2] ?? '?'} · 3rd ${AE5_REL[r3] ?? '?'}` },
    { label: 'Closing solenoid', value: label(vClose) },
    { label: '1st shunt release', value: label(vRel1) },
    ...(vRel2 ? [{ label: '2nd release voltage', value: label(vRel2) }] : []),
    ...(vRel3 ? [{ label: '3rd release voltage', value: label(vRel3) }] : []),
    { label: 'Installation (13th)', value: INST[inst]?.[2] ?? pos[12] },
    { label: 'Motor', value: label(vMotor) },
    { label: 'Interface / aux. switch', value: iface ? `${iface[0] === 'X' ? 'extended harness, 64-pole plug' : `${iface[0]}-pole`} · ${iface[1]} NO + ${iface[1]} NC` : pos[14] },
    { label: 'Language / frequency', value: `${lang ?? '?'} · ${sixty ? '60 Hz' : '50 Hz or DC'}` },
  );

  const add = (slot: string, l: string, article: string | null, note?: string) => parts.push({ slot, label: l, article, note });
  if (vClose) add('close', `Closing solenoid ${label(vClose)}`, ae5Solenoid(vClose));
  if (vRel1) add('rel1', `1st shunt release 30 ms ${label(vRel1)}`, ae5Solenoid(vRel1));
  const release = (n: '2' | '3', r: string, v: string | null) => {
    if (r === 'none' || r === '?') return;
    if (r === 'sh30') { add(`rel${n}`, `${n === '2' ? '2nd' : '3rd'} shunt release 30 ms ${label(v)}`, v ? ae5Solenoid(v) : null); add(`mount${n}`, 'Mounting parts for 2nd shunt release 30 ms', '3AX1411-7A'); }
    else if (r === 'sh45') { add(`rel${n}`, `${n === '2' ? '2nd' : '3rd'} shunt release 45 ms ${label(v)}`, v ? shunt45(v, sixty) : null); add(`mount${n}`, 'Mounting parts for shunt release 45 ms / c.t. release', '3AX1411-5A'); }
    else if (r === 'uv') { add(`rel${n}`, `Undervoltage release ${label(v)}`, v ? undervoltage(v, sixty, false) : null); add(`mount${n}`, 'Mounting parts for undervoltage release', '3AX1413-5A'); }
    else { add(`rel${n}`, AE5_REL[r], CT_AE5[r] ?? null); add(`mount${n}`, 'Mounting parts for shunt release 45 ms / c.t. release', '3AX1411-5A'); }
  };
  release('2', r2, vRel2);
  release('3', r3, vRel3);
  if (r2 !== 'none' && r3 !== 'none' && r2 !== 'sh30') add('mount23', 'Mounting parts for 2nd and 3rd release', '3AX1411-5B');
  if (vMotor) add('motor', `Drive motor ${label(vMotor)}`, ae5Motor(vMotor));
  if (vClose) {
    if (gen === 'board') add('antipump', `Anti-pumping: electronic module ${label(vClose)}`, antiPumpModule(vClose));
    else add('antipump', `Anti-pumping: auxiliary contactor ${label(vClose)} (older SION)`, null, 'Article number from Siemens Technical Support with the serial number (HG 11.02 p. 34, fn 1).');
  }
  if (iface) {
    add('aux', `Auxiliary switch ${iface[1]} NO + ${iface[1]} NC`, iface[1] === '6' ? '3SV9473-2AA0' : '3SV9474-2AA0');
    add('iface', iface[0] === '20' ? 'Internal 20-pole connection strip' : iface[0] === 'X' ? 'Extended cable harness with 64-pole plug' : '64-pole plug', iface[0] === '20' ? null : '3AX1134-6A');
  }
  if (has('A47') && vClose) add('lockout', `Electrical closing lockout ${label(vClose)}`, gen === 'board' ? closingLockout(vClose) : null, gen === 'board' ? undefined : 'For SION since 03/2022; older devices: Siemens Technical Support.');
  if (has('A29')) add('heater', 'Anti-condensation heater 110 V AC', '3AX1457-5B');
  if (has('A30')) add('heater', 'Anti-condensation heater 230 V AC', '3AX1457-5A');
  if (has('J60')) add('key', 'Key-operated interlock', '3AX1437-4A');
  if (has('F30')) add('crank', 'Hand crank for charging the closing spring', '3AX1530-4B');
  if (has('F31')) add('crankL', 'Hand crank (long) for charging the closing spring', '3AX1430-2B');
  if (has('F32')) add('rack', 'Hand crank for racking the withdrawable part', '3AX1430-2C');
  return { family: '3AE5', base: base(pos), primary: `${pos.slice(0, 7).join('')}-${pos[7]}`, pos, codes, reading, parts, problems };
}

function parseAh3(pos: string[], codes: string[], gen: string): Parsed {
  const parts: Part[] = [];
  const reading: Parsed['reading'] = [];
  const problems: string[] = [];
  const has = (c: string) => codes.includes(c);
  const sixty = +pos[15] % 2 === 1;
  const voltOf = (c: string, table: string, special: string, prefix: string): string | null => {
    if (c === special) { const sx = codes.find(x => x.startsWith(prefix))?.[2]; const j = sx ? SPECIAL_SUFFIX.indexOf(sx) : -1; return j >= 0 ? key(SPECIAL_V[j]) : null; }
    const i = table.indexOf(c);
    return i >= 0 ? key(STD_V[i]) : null;
  };
  const combo = AH3_COMBOS.filter(c => c[0] === pos[8] && c[3].every(has)).sort((a, b) => b[3].length - a[3].length)[0];
  const [r2, r3]: Release[] = combo ? [combo[1], combo[2]] : ['none', 'none'];
  if (!combo) problems.push(`9th position ${pos[8]} is not a 3AH3 release combination.`);
  // A special closing voltage (Z) says mechanical or manual by its order code: K1x / K2x.
  const manual = pos[9] === 'Z' ? codes.some(c => c.startsWith('K2')) : CLOSE_MANUAL.includes(pos[9]);
  const vClose = voltOf(pos[9], manual ? CLOSE_MANUAL : CLOSE_MECH, 'Z', manual ? 'K2' : 'K1');
  const vRel1 = voltOf(pos[10], DIGITS, '9', 'L1');
  const v12 = pos[11] === '0' ? null : voltOf(pos[11], DIGITS, '9', 'M1');
  const v13 = pos[12] === '0' ? null : voltOf(pos[12], DIGITS, '9', 'N1');
  // 12th and 13th positions carry the releases that take a voltage, in turn.
  const fed = ([[2, r2], [3, r3]] as const).filter(([, r]) => r === 'shunt' || r === 'uv').map(([n]) => n);
  const vFor = (n: 2 | 3) => { const i = fed.indexOf(n); return i < 0 ? null : [v12, v13][i]; };
  const vRel2 = vFor(2);
  const vRel3 = vFor(3);
  const motorManual = pos[13] === 'A';
  const vMotor = motorManual ? null : voltOf(pos[13], MOTOR, 'Z', 'P1');
  const aux = AUX.find(a => a[0] === pos[14]);
  const lang = Object.values(LANGS).find(l => l[1] === pos[15] || l[2] === pos[15])?.[0];

  reading.push(
    { label: 'Primary part (ratings, poles)', value: `${pos.slice(0, 7).join('')}-${pos[7]}` },
    { label: 'Releases', value: `1st shunt · 2nd ${AH3_REL[r2]} · 3rd ${AH3_REL[r3]}` },
    { label: 'Closing', value: `${manual ? 'Manual electrical' : 'Mechanical'} closing · solenoid ${label(vClose)}` },
    { label: '1st shunt release', value: label(vRel1) },
    ...(vRel2 ? [{ label: '2nd release voltage', value: label(vRel2) }] : []),
    ...(vRel3 ? [{ label: '3rd release voltage', value: label(vRel3) }] : []),
    { label: 'Operating mechanism', value: motorManual ? 'Manual (hand crank)' : `Motor ${label(vMotor)}` },
    { label: 'Aux. switch / interface', value: aux ? `${aux[2]} NO + ${aux[2]} NC · ${aux[3]}${aux[1] ? ' · mechanical interlocking' : ''}` : pos[14] },
    { label: 'Language / frequency', value: `${lang ?? '?'} · ${sixty ? '60 Hz' : '50 Hz or DC'}` },
  );

  const add = (slot: string, l: string, article: string | null, note?: string) => parts.push({ slot, label: l, article, note });
  if (vClose) add('close', `Closing solenoid ${label(vClose)}`, ah3Solenoid(vClose));
  if (manual) add('manualClose', 'Manual electrical closing at the breaker', null, 'Pushbutton and wiring — ask Siemens for the retrofit kit.');
  if (vRel1) add('rel1', `1st shunt release ${label(vRel1)}`, ah3Solenoid(vRel1));
  // Mounting parts by serial number and how many releases are fitted (p. 31).
  const extra = [r2, r3].filter(r => r !== 'none').length;
  const early = gen === 'old' || gen === 'new1';
  if (extra) add('mount', `Mounting parts for ${extra === 1 ? '1' : '2'} further release(s)`, `3AX1711-${early ? 3 : 4}${extra === 1 ? 'A' : 'B'}`, 'Kit chosen by serial number (up to / as of 3AH3/00016907).');
  const release = (n: 2 | 3, r: Release, v: string | null) => {
    if (r === 'none') return;
    if (r === 'shunt') add(`rel${n}`, `${n === 2 ? '2nd' : '3rd'} shunt release ${label(v)}`, v ? shunt45(v, sixty) : null);
    else if (r === 'uv') {
      add(`rel${n}`, `Undervoltage release ${label(v)}`, v ? undervoltage(v, sixty, true) : null);
      if (gen !== 'old') add('uvKit', 'Mounting kit for the undervoltage release resistor (with 3RH1122)', '3AX1711-0W');
    } else {
      const ct: Record<string, string> = { ct05: '3AX1102-2A', ct1: '3AX1102-2B', ctp10: '3AX1104', ctp20: '3AX1104' };
      add(`rel${n}`, AH3_REL[r], ct[r] ?? null, r.startsWith('ctp') ? 'Pulse release: confirm the variant (10 / 20 Ω) with Siemens.' : undefined);
    }
  };
  release(2, r2, vRel2);
  release(3, r3, vRel3);
  if (vMotor) {
    add('motor', `Drive motor ${label(vMotor)}`, ah3Motor(vMotor));
    if (kind(vMotor) === 'AC') add('rectifier', 'Rectifier element for an AC drive motor', '3AX1525-1F');
  }
  if (vClose) {
    const c = gen === 'old' ? contactor3TH20(vClose, sixty) : contactor3RH(vClose);
    add('antipump', `Anti-pumping auxiliary contactor ${gen === 'old' ? '3TH20 22-7' : '3RH1122-2'} ${label(vClose)}`, c);
  }
  if (aux) {
    add('aux', `Auxiliary switch ${aux[2]} NO + ${aux[2]} NC`, aux[2] === 6 ? '3SV9273-2AA0' : '3SV9274-2AA0');
    add('iface', aux[3] === '64-pole plug' ? 'Complete 64-pole plug' : aux[3] === '24-pole plug' ? 'Complete 24-pole plug' : '24-pole terminal strip', aux[3] === '64-pole plug' ? '3AX1134-6A' : aux[3] === '24-pole plug' ? '3AX1134-7A' : null);
    add('bundle', `Wire bundle, auxiliary switch to the ${aux[3]}`, aux[3] === '64-pole plug' ? '3AX1134-2D' : aux[3] === '24-pole plug' ? '3AX1134-2B' : '3AX1134-2C');
    if (aux[1]) add('interlock', 'Mechanical interlocking', '3AX1520-4C');
  }
  if (motorManual || has('F30')) add('crank', 'Hand crank for charging the closing spring', '3AX1530-4B');
  return { family: '3AH3', base: base(pos), primary: `${pos.slice(0, 7).join('')}-${pos[7]}`, pos, codes, reading, parts, problems };
}

// ── Comparing ───────────────────────────────────────────────────────────
export interface Conversion {
  stock: Parsed;
  wanted: Parsed;
  /** Fatal: a different breaker, not a set of parts. */
  blockers: string[];
  remove: Part[];
  add: Part[];
  keep: Part[];
  notes: string[];
}

const same = (a: Part, b: Part) => a.slot === b.slot && a.label === b.label && a.article === b.article;

export function compare(stockCode: string, stockGen: string, wantedCode: string, wantedGen: string): Conversion | string {
  const wanted = parseArticle(wantedCode, wantedGen);
  if (!wanted) return 'The required code is not complete yet — answer what is still open first.';
  const stock = parseArticle(stockCode, stockGen);
  if (!stock) return 'Not a 3AE5 or 3AH3 article number with 16 positions (e.g. 3AE5124-2AE40-0EN2-Z F30).';
  const blockers: string[] = [];
  const notes: string[] = [];
  if (stock.family !== wanted.family) blockers.push(`Different breaker type: stock ${stock.family}, required ${wanted.family}.`);
  else if (stock.primary !== wanted.primary) {
    blockers.push(`Different primary part: stock ${stock.primary}, required ${wanted.primary} — rated voltage, short-circuit current, pole-centre distance or rated current differ; that is the poles themselves, not a change of parts.`);
  }
  if (wanted.family === '3AE5' && stock.pos[12] !== wanted.pos[12]) {
    notes.push(`Installation (13th position) differs: stock ${stock.pos[12]}, required ${wanted.pos[12]} — contact arms, withdrawable part or mounting frame are ordered separately, not as spare parts.`);
  }
  if (stock.pos[15] !== wanted.pos[15]) notes.push('Language or AC frequency (16th position) differs: rating plate and operating instructions only — unless AC coils change frequency, which the parts below already show.');
  if (wanted.family === '3AE5' && stockGen !== wantedGen) {
    notes.push(stockGen === 'contactor'
      ? 'Stock breaker is an older SION (anti-pumping by contactor): the electronic module 3AY1420 and closing lockout 3AX1405 are for devices since 2022 — a retrofit needs Siemens Technical Support with the serial number.'
      : 'Stock breaker has the 2022 control board: anti-pumping is on the board (3AY1420) — no separate contactor is needed.');
  }
  const remove = stock.parts.filter(p => !wanted.parts.some(q => same(p, q)));
  const add = wanted.parts.filter(p => !stock.parts.some(q => same(p, q)));
  const keep = wanted.parts.filter(p => stock.parts.some(q => same(p, q)));
  const zOnly = wanted.codes.filter(c => !stock.codes.includes(c));
  const zGone = stock.codes.filter(c => !wanted.codes.includes(c));
  if (zOnly.length) notes.push(`Order codes only on the required breaker: ${zOnly.join(', ')} — check each is covered by a part above or is documentation only.`);
  if (zGone.length) notes.push(`Order codes only on the stock breaker: ${zGone.join(', ')}.`);
  notes.push('When releases or solenoids are retrofitted, Siemens asks for the mounting parts too, and type, serial number and year of manufacture with every spare-part order.');
  return { stock, wanted, blockers, remove, add, keep, notes: [...stock.problems, ...wanted.problems, ...notes] };
}
