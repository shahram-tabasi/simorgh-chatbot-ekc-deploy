// src/utils/sion3ae5/ah3.ts
//
// The 3AH3 vacuum circuit-breaker's order number, from Siemens catalog
// HG 11.03 · 2018 (pages 14–28) — the breaker EK36 takes.
//
//   3 A H 3 n n n – n a a n n – n a a n – Z  order codes
//   1–8   primary part: rated voltage, short-circuit current, pole-centre
//         distance, rated normal current (pages 15–17)
//   9     release combination (19)
//   10    closing solenoid voltage, mechanical or manual electrical closing (20)
//   11    1st shunt release voltage (21)
//   12    2nd release voltage — shunt or undervoltage; 0 for c.t.-operated (22)
//   13    3rd release voltage, the same way (23)
//   14    operating mechanism (motor) voltage, or manual (24)
//   15    auxiliary switch, low-voltage interface, mechanical interlocking (25)
//   16    language, and the frequency of AC secondary voltages (26)
//   -Z    order codes: special voltages (K/L/M/N/P), release variants
//         (A44/A45/A46/F15), gold-plated contacts, options (27–28)
//
// Like the 3AE5 builder, nothing is guessed silently: what is still open is
// listed, and what the project only suggested is marked.

// [base, kV, Up, Ud, kA, Ima, pole-centre mm, Ir A]
export type Ah3Primary = [string, number, number, number, number, string, number, number];
const P = (b: string, kv: number, up: number, ud: number, ka: number, ima: string, pcd: number, ir: number): Ah3Primary =>
  [b, kv, up, ud, ka, ima, pcd, ir];

/** Pages 15–17: the circuit-breakers to IEC 62271-100. */
export const AH3_PRIMARY: Ah3Primary[] = [
  // 7.2 / 12 / 17.5 kV: 50 kA at 210 mm (4000 A at 275 mm), 63 kA at 275 mm.
  ...([[7.2, 60, 20, '05', '07'], [12, 75, 28, '11', '12'], [17.5, 95, 38, '21', '22']] as const).flatMap(([kv, up, ud, a, b]) => [
    ...[[1250, 2], [2000, 4], [2500, 6], [3150, 7]].map(([ir, c]) => P(`3AH3${a}7-${c}`, kv, up, ud, 50, '125/130', 210, ir)),
    P(`3AH3${b}7-8`, kv, up, ud, 50, '125/130', 275, 4000),
    ...[[1250, 2], [2500, 6], [3150, 7], [4000, 8]].map(([ir, c]) => P(`3AH3${b}8-${c}`, kv, up, ud, 63, '160/164', 275, ir)),
  ]),
  P('3AH3266-6', 24, 125, 50, 40, '100/104', 275, 2500),
  P('3AH3266-7', 24, 125, 50, 40, '100/104', 275, 3150),
  P('3AH3267-7', 24, 110, 50, 50, '125/130', 275, 3150),
  P('3AH3367-8', 24, 125, 50, 50, '125/130', 300, 4000),
  ...[[1250, 2], [2000, 4], [2500, 6], [3150, 7], [4000, 8]].map(([ir, c]) => P(`3AH3305-${c}`, 36, 170, 70, 31.5, '80/82', 350, ir)),
  ...[[2500, 6], [3150, 7], [4000, 8]].map(([ir, c]) => P(`3AH3306-${c}`, 36, 170, 70, 40, '100/104', 350, ir)),
];
export const AH3_KV = [7.2, 12, 17.5, 24, 36, 40.5];

// ── 9th position: release combinations ──────────────────────────────────
export type Release = 'none' | 'shunt' | 'ct05' | 'ct1' | 'ctp10' | 'ctp20' | 'uv';
export const RELEASE_LABEL: Record<Release, string> = {
  none: 'None', shunt: 'Shunt release', ct05: 'C.t.-operated release 0.5 A', ct1: 'C.t.-operated release 1 A',
  ctp10: 'C.t.-operated release, pulse ≥ 0.1 Ws (10 Ω)', ctp20: 'C.t.-operated release, pulse ≥ 0.1 Ws (20 Ω)',
  uv: 'Undervoltage release',
};
// [9th position, 2nd release, 3rd release, order codes]
export const AH3_COMBOS: [string, Release, Release, string[]][] = [
  ['M', 'none', 'none', []],
  ['N', 'shunt', 'none', []],
  ['N', 'shunt', 'shunt', ['F15']],
  ['P', 'shunt', 'ct05', []],
  ['P', 'shunt', 'ct1', ['A46']],
  ['P', 'shunt', 'ctp10', ['A44']],
  ['P', 'shunt', 'ctp20', ['A45']],
  ['T', 'shunt', 'uv', []],
  ['Q', 'ct05', 'none', []],
  ['R', 'uv', 'none', []],
  ['S', 'ct05', 'uv', []],
  ['S', 'ct1', 'uv', ['A46']],
  ['S', 'ctp10', 'uv', ['A44']],
  ['S', 'ctp20', 'uv', ['A45']],
  // The catalogue also lists U with the 0.5 A c.t.-operated release (as Q);
  // U is the row its 1 A variant (A46) belongs to.
  ['U', 'ct1', 'none', ['A46']],
  ['V', 'ctp10', 'none', []],
  ['V', 'ctp20', 'none', ['A45']],
];
/** The 3rd releases the catalogue pairs with a 2nd one. */
export const thirdOptions = (r2: Release): Release[] => [...new Set(AH3_COMBOS.filter(c => c[1] === r2).map(c => c[2]))];
export const SECOND_OPTIONS: Release[] = [...new Set(AH3_COMBOS.map(c => c[1]))];

// ── 10th–14th positions: voltages ───────────────────────────────────────
export const STD_V = ['DC 24 V', 'DC 48 V', 'DC 60 V', 'DC 110 V', 'DC 220 V', 'AC 100 V', 'AC 110 V', 'AC 230 V'];
export const SPECIAL_V = ['DC 30 V', 'DC 32 V', 'DC 120 V', 'DC 125 V', 'DC 127 V', 'DC 240 V', 'AC 120 V', 'AC 125 V', 'AC 240 V'];
export const SPECIAL_SUFFIX = 'ABCDEFKLM';
export const CLOSE_MECH = 'BCDEFHJK';
export const CLOSE_MANUAL = 'MNPQRTUV';
export const DIGITS = '12345678';
export const MOTOR = 'BCDEFHJK';

/** "110V DC", "DC110", "110 VDC" → "DC 110 V" — or null when it is not one. */
export function normVoltage(v: unknown): string | null {
  const t = String(v ?? '').toUpperCase();
  const m = t.match(/(\d{2,3})\s*V?\s*(AC|DC)/) || t.match(/(AC|DC)\s*(\d{2,3})/);
  if (!m) return null;
  const [n, kind] = /^\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
  return `${kind} ${n} V`;
}

// ── 15th position ───────────────────────────────────────────────────────
// [letter, mechanical interlocking, 6 or 12 NO+NC, interface]
export const AUX: [string, boolean, 6 | 12, string][] = [
  ['A', false, 6, '64-pole plug'], ['E', false, 6, '24-pole plug'], ['G', false, 6, '24-pole terminal strip'],
  ['C', false, 12, '64-pole plug'], ['M', false, 12, '24-pole terminal strip'],
  ['B', true, 6, '64-pole plug'], ['F', true, 6, '24-pole plug'], ['H', true, 6, '24-pole terminal strip'],
  ['D', true, 12, '64-pole plug'], ['N', true, 12, '24-pole terminal strip'],
];
export const auxLabel = (a: (typeof AUX)[number]) =>
  `${a[2]} NO + ${a[2]} NC, ${a[3]}${a[1] ? ', mechanical interlocking' : ''}`;

// ── 16th position ───────────────────────────────────────────────────────
export const LANGS: Record<string, [string, string | null, string | null]> = {
  // [label, code at 50 Hz / DC, code at 60 Hz] — standard digits, or an order code
  de: ['German', '0', '1'], en: ['English', '2', '3'], fr: ['French', '4', '5'], es: ['Spanish', '6', '7'],
  pt: ['Portuguese', 'R1C', 'R1D'], it: ['Italian', 'R1F', null], ru: ['Russian', 'R1G', 'R1H'], pl: ['Polish', 'R1K', null],
};

// ── Additional equipment (27–28) ────────────────────────────────────────
export const AH3_EXTRAS: [string, string][] = [
  ['A05', 'Wire ends with marking at the plug'], ['A06', 'Wiring cable AWG14 SIS Gray (UL-listed)'],
  ['A10', 'Wiring cables, halogen-free and flame-retardant'], ['A11', 'Destination end marking at wire ends + ferrules, pulled out without plug'],
  ['A12', 'Wiring cables, tinned (and halogen-free, flame-retardant)'],
  ['A17', 'Gold-plated aux. switch 6 NO + 6 NC, 24-pole terminal strip (G or H)'],
  ['A18', 'Gold-plated aux. switch 12 NO + 12 NC, 24-pole terminal strip (M or N)'],
  ['A20', 'Gold-plated aux. switch 6 NO + 6 NC, 64-pole plug (A or B)'],
  ['A21', 'Gold-plated aux. switch 12 NO + 12 NC, 64-pole plug (C or D)'],
  ['A26', 'Auxiliary switch 12 NO + 12 NC and 24-pole plug (E or F)'],
  ['A29', 'Protection against condensed water, heating 110 V AC, 50 W'], ['A30', 'Protection against condensed water, heating 230 V AC, 50 W'],
  ['A31', 'Silicone-free design'], ['A40', 'Operation down to −25 °C ambient (on request)'],
  ['A47', 'Electrical closing lockout without measuring element'], ['A61', 'Spring-dump (energy store released when the plug is disconnected)'],
  ['A62', 'Prevalent trip (opening prevents closing)'], ['A64', 'Prevalent trip, spring-dump and "closed breaker" interrogation'],
  ['A65', 'Prevalent trip and spring-dump'], ['B00', 'Additional rating plate, loose'],
  ['B01', 'Cable harness 800 mm, pulled out'], ['B02', 'Cable harness 500 mm, pulled out'], ['B03', 'Cable harness 2000 mm, pulled out'],
  ['B04', 'Cable harness 1200 mm, pulled out'], ['B05', 'Cable harness 1500 mm, pulled out'], ['B06', 'Cable harness 2500 mm, pulled out'],
  ['B07', 'Cable harness 3000 mm, pulled out'], ['B08', 'Cable harness 3500 mm, pulled out'],
  ['B20', 'Without cover'], ['B23', 'Without upper part of plug'], ['B42', '30-pole terminal strip'],
  ['B47', 'Close-open solenoids with thermo switch (60 / 110 / 220 V DC only)'], ['B60', '2 x 24-pole terminal strip'], ['B65', '2 x 24-pole plug'],
  ['B99', 'Special circuit diagram'], ['D10', 'Silver-plated primary circuits for external connections'],
  ['D20', 'For environments containing H2S (on request)'],
  ['E13', 'Ud 42 kV (for 12 kV)'], ['E14', 'Up 185 kV (as of 36 kV)'], ['E15', 'Ud 85 kV (as of 36 kV)'],
  ['E16', 'Ud 32 kV (for 7.2 kV)'], ['E24', 'Up 195 kV (as of 36 kV)'], ['E25', 'Ud 95 kV (as of 36 kV)'],
  ['F02', 'Seaworthy transport for Germany'], ['F19', 'Routine test certificate enclosed with stamp and passport'],
  ['F20', 'Routine test certificate enclosed'], ['F21', 'Routine test certificate with stamp and signature'],
  ['F23', 'Routine test certificate (to orderer)'],
  ['F27', 'Operating sequence O – 3 min – CO – 3 min – CO (IEC only)'], ['F28', 'Operating sequence O – 0.3 s – CO – 15 s – CO (up to 31.5 kA)'],
  ['F30', 'Hand crank for manual charging of the closing spring'], ['J62', 'Mounted cover for CLOSING (lockable)'],
  ['W70', 'Warranty 24 months'], ['W71', 'Warranty 36 months'], ['W72', 'Warranty 60 months'],
  ['Y09', 'Rated voltage 40.5 kV (with E14/E15 or E24/E25)'], ['Y12', 'Additional specifications on the rating plate'],
  ['Y40', 'Operating instructions and product designation for USA'], ['Y45', 'Adhesive label yellow / green – ON / OFF'],
  ['Y99', 'Other special design (clear text)'],
];

// ── State and evaluation ────────────────────────────────────────────────
export type Mark = 'found' | 'assumed' | 'default' | 'user';
export interface Ah3State {
  kv: number | null; ka: number | null; ir: number | null; pcd: number | null;
  rel2: Release; rel3: Release;
  closing: 'mech' | 'manual';
  vClose: string | null; vRel1: string | null; vRel2: string | null; vRel3: string | null;
  /** 'manual' for the hand-charged mechanism. */
  vMotor: string | null;
  aux: string | null;
  lang: string;
  freq: '50' | '60';
  extras: string[];
  /** Where each value came from. */
  st: Record<string, Mark>;
  /** Order codes the engineer took off, though the rules add them. */
  off?: string[];
}

export interface Ah3Result {
  /** 16 characters, '?' where still open. */
  pos: string[];
  code: string;
  orderCodes: string[];
  /** Order codes the rules gave but the engineer took off. */
  removed: string[];
  primary: Ah3Primary | null;
  missing: string[];
  notes: string[];
}

export function primaryOptions(s: Pick<Ah3State, 'kv' | 'ka' | 'ir' | 'pcd'>, field: 'kv' | 'ka' | 'ir' | 'pcd'): number[] {
  const idx = { kv: 1, ka: 4, ir: 7, pcd: 6 } as const;
  const kv40 = s.kv === 40.5;
  const rows = AH3_PRIMARY.filter(r => (['kv', 'ka', 'ir', 'pcd'] as const)
    .every(f => f === field || s[f] == null || (f === 'kv' ? r[1] === (kv40 ? 36 : s.kv) : r[idx[f]] === s[f])));
  const vals = [...new Set(rows.map(r => r[idx[field]] as number))].sort((a, b) => a - b);
  return field === 'kv' ? AH3_KV.filter(k => vals.includes(k) || (k === 40.5 && vals.includes(36))) : vals;
}

function voltageCode(v: string | null, std: string, prefix: string, specialChar: string): { c: string; code?: string } | null {
  if (!v) return null;
  const i = STD_V.indexOf(v);
  if (i >= 0) return { c: std[i] };
  const j = SPECIAL_V.indexOf(v);
  if (j >= 0) return { c: specialChar, code: `${prefix}${SPECIAL_SUFFIX[j]}` };
  return null;
}

export function evaluateAh3(s: Ah3State): Ah3Result {
  const pos = '3AH3???????????'.split('').concat('?');
  const codes: string[] = [];
  const missing: string[] = [];
  const notes: string[] = [];
  const kv40 = s.kv === 40.5;

  // 1–8: the primary part.
  const rows = AH3_PRIMARY.filter(r => r[1] === (kv40 ? 36 : s.kv) && (s.ka == null || r[4] === s.ka)
    && (s.ir == null || r[7] === s.ir) && (s.pcd == null || r[6] === s.pcd));
  const primary = s.kv != null && s.ka != null && s.ir != null && rows.length === 1 ? rows[0] : null;
  if (primary) {
    primary[0].slice(4).replace('-', '').split('').forEach((c, i) => { pos[4 + i] = c; });
    if (kv40) { codes.push('Y09', 'E14', 'E15'); notes.push('40.5 kV: the 36 kV breaker with Y09 + E14 + E15 (Up 185 / Ud 85 kV).'); }
  } else {
    if (s.kv == null) missing.push('Rated voltage');
    if (s.ka == null) missing.push('Short-circuit breaking current');
    if (s.ir == null) missing.push('Rated normal current');
    if (s.kv != null && s.ka != null && s.ir != null && !rows.length) notes.push(`No 3AH3 of ${s.kv} kV / ${s.ka} kA / ${s.ir} A in HG 11.03.`);
  }

  // 9: release combination.
  const combo = AH3_COMBOS.find(c => c[1] === s.rel2 && c[2] === s.rel3);
  if (combo) { pos[8] = combo[0]; codes.push(...combo[3]); }
  else missing.push('Release combination');
  if (combo?.[0] === 'Q') notes.push('9th position Q; the catalogue lists U with the same 0.5 A c.t.-operated release — confirm with Siemens if U is meant.');

  // 10: closing solenoid.
  const close = voltageCode(s.vClose, s.closing === 'manual' ? CLOSE_MANUAL : CLOSE_MECH, s.closing === 'manual' ? 'K2' : 'K1', 'Z');
  if (close) { pos[9] = close.c; if (close.code) codes.push(close.code); } else missing.push('Closing solenoid voltage');
  // 11: 1st shunt release.
  const r1 = voltageCode(s.vRel1, DIGITS, 'L1', '9');
  if (r1) { pos[10] = r1.c; if (r1.code) codes.push(r1.code); } else missing.push('1st shunt release voltage');
  // 12 / 13: the voltages of the further releases that take one — shunt or
  // undervoltage — in turn; a c.t.-operated release takes none, so it leaves
  // a 0 (the catalogue's own example, page 28: c.t. + undervoltage release →
  // 12th position the undervoltage release's voltage, 13th 0).
  const voltaged = (r: Release) => r === 'shunt' || r === 'uv';
  const fed = ([[s.rel2, s.vRel2, '2nd release voltage'], [s.rel3, s.vRel3, '3rd release voltage']] as const)
    .filter(([rel]) => voltaged(rel));
  ([[11, 'M1'], [12, 'N1']] as const).forEach(([i, prefix], k) => {
    const f = fed[k];
    if (!f) { pos[i] = '0'; return; }
    const r = voltageCode(f[1], DIGITS, prefix, '9');
    if (r) { pos[i] = r.c; if (r.code) codes.push(r.code); } else missing.push(f[2]);
  });
  if (s.rel2 === 'uv' || s.rel3 === 'uv') notes.push('An undervoltage release on an energy store (AN 1901/1902, Bender) is ordered with M2x/M3x (2nd) or N2x/N3x (3rd) — page 22–23.');
  // 14: operating mechanism.
  if (s.vMotor === 'manual') pos[13] = 'A';
  else {
    const m = voltageCode(s.vMotor, MOTOR, 'P1', 'Z');
    if (m) { pos[13] = m.c; if (m.code) codes.push(m.code); } else missing.push('Operating mechanism voltage');
  }
  // 15: auxiliary switch, interface, interlocking.
  if (s.aux && AUX.some(a => a[0] === s.aux)) pos[14] = s.aux; else missing.push('Auxiliary switch / interface');
  // 16: language and AC frequency.
  const ac = [s.vClose, s.vRel1, voltaged(s.rel2) ? s.vRel2 : null, voltaged(s.rel3) ? s.vRel3 : null, s.vMotor]
    .some(v => v?.startsWith('AC'));
  const sixty = ac && s.freq === '60';
  const lang = LANGS[s.lang];
  const l = lang?.[sixty ? 2 : 1];
  if (!l) missing.push(lang ? `${lang[0]} is not available at 60 Hz` : 'Language');
  else if (l.length === 1) pos[15] = l;
  else { pos[15] = '9'; codes.push(l); }

  codes.push(...s.extras.filter(e => !codes.includes(e)));
  const off = new Set(s.off ?? []);
  const removed = [...new Set(codes)].filter(c => off.has(c));
  if (removed.length) notes.push(`Taken off by hand: ${removed.join(', ')} — tick again to restore.`);
  const uniq = [...new Set(codes)].filter(c => !off.has(c));
  const base = `${pos.slice(0, 7).join('')}-${pos.slice(7, 12).join('')}-${pos.slice(12, 16).join('')}`;
  return {
    pos, primary, missing, notes, orderCodes: uniq, removed,
    code: uniq.length ? `${base}-Z ${uniq.join('+')}` : base,
  };
}

/** A setting's choices for the form. */
export const stepUp = (v: number, steps: number[]) => steps.find(x => x >= v - 1e-9) ?? null;

/** A 3AH3 as the project gives it: the cell's ratings, the scope's voltages. */
export function ah3FromProject(p: Record<string, unknown>, cell: { ka?: number | null; ir?: number | null }): Ah3State {
  const st: Record<string, Mark> = {};
  const num = (v: unknown) => { const m = String(v ?? '').replace(',', '.').match(/\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; };
  let kv = num(p.ratedInsulationVoltage) ?? num(p.serviceVoltage);
  if (kv != null && kv > 100) kv /= 1000;
  const kvStep = kv != null ? stepUp(kv, AH3_KV) : null;
  if (kvStep != null) st.kv = kvStep === kv ? 'found' : 'assumed';
  const kaWant = cell.ka ?? num(p.isc) ?? num(p.ratedShortTimeWithstandCurrent);
  const kaList = kvStep != null ? primaryOptions({ kv: kvStep, ka: null, ir: null, pcd: null }, 'ka') : [];
  const ka = kaWant != null ? stepUp(kaWant, kaList) : null;
  if (ka != null) st.ka = ka === kaWant ? 'found' : 'assumed';
  const irWant = cell.ir ?? num(p.mainBusbarRatedCurrent);
  const irList = kvStep != null && ka != null ? primaryOptions({ kv: kvStep, ka, ir: null, pcd: null }, 'ir') : [];
  const ir = irWant != null ? stepUp(irWant, irList) : null;
  if (ir != null) st.ir = ir === irWant ? 'found' : 'assumed';
  const control = normVoltage(p.controlProtectionClosingTrippingSignalling);
  const motor = normVoltage(p.springChargingMotor);
  if (control) { st.vClose = 'found'; st.vRel1 = 'found'; }
  if (motor) st.vMotor = 'found';
  st.rel2 = 'default'; st.rel3 = 'default'; st.lang = 'default'; st.closing = 'default';
  return {
    kv: kvStep, ka, ir, pcd: null, rel2: 'none', rel3: 'none', closing: 'mech',
    vClose: control, vRel1: control, vRel2: null, vRel3: null, vMotor: motor,
    aux: null, lang: 'en', freq: num(p.frequency) === 60 ? '60' : '50', extras: [], st,
  };
}
