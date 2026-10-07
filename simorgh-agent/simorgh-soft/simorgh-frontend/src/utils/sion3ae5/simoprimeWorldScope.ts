// src/utils/sion3ae5/simoprimeWorldScope.ts
//
// A SIMOPRIME World scope's specification, held to the design catalogue
// (issue 23, 06/2026): which values each field may take, given the others,
// and what one choice settles for the rest.
//
//   1.1  Technical data      Ur → operating voltages, Up, Ud; frequency;
//                            Ik and duration; ambient temperature
//   1.2  Busbars             1250 / 2500 / 4000 A; insulation
//   1.3  Switchgear design   single busbar; cable access; RAL 7035
//   1.5  Supply voltages     breaker motor, closing / shunt, heaters
//   3.2  Dimensions          width by Ik, depth, height by IAC duration
//   3.8  Busbar currents     cross-section by Ik and rated current, and what
//                            the busbar may carry at the site's temperature
//
// Values are written the way the rest of the app reads them: voltages with
// their unit ("12 kV", "DC 110 V"), but the short-circuit current, Isc and the
// busbar current as bare numbers ("25", "2500") — Send to EPLAN and the
// mechanical items add " kA" and " A" themselves.
//
// What a choice settles is filled in — but only into a field that is empty or
// was filled the same way before. A value the engineer picked is never
// overwritten; one the catalogue no longer allows is shown, and flagged.
import type { DeviceLibraryProperties } from '../../types/project';

export interface FieldOption { value: string; label: string }
export interface FieldRule {
  options: FieldOption[];
  /** What the catalogue says about the current choice. */
  note?: string;
}
export interface WorldSiteInfo {
  /** Design (ambient) temperature, °C — Technical Settings. */
  ambientC: number | null;
}

type Props = Record<string, any>;

const num = (v: unknown): number | null => {
  const m = String(v ?? '').replace(',', '.').match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};
const opt = (value: string, label = value): FieldOption => ({ value, label });

// ── 1.1 ─────────────────────────────────────────────────────────────────
const UR = [7.2, 12, 17.5];
const UN: Record<string, number[]> = {
  '7.2': [3.3, 3.6, 4.8, 5.0, 6.0, 6.6, 7.2],
  '12': [6.0, 6.6, 7.2, 10.0, 11.0],
  '17.5': [13.2, 13.8, 15],
};
const UP: Record<string, number> = { '7.2': 60, '12': 75, '17.5': 95 };
const UD: Record<string, { iec: number; gost?: number }> = {
  '7.2': { iec: 20, gost: 32 }, '12': { iec: 28, gost: 42 }, '17.5': { iec: 38 },
};
const IK = [25, 31.5, 40];
const DURATION = [1, 3];
const kvText = (v: number) => `${v % 1 ? v.toFixed(1) : v} kV`;

// ── 1.5 ─────────────────────────────────────────────────────────────────
const SUPPLY = ['DC 24 V', 'DC 30 V', 'DC 32 V', 'DC 48 V', 'DC 60 V', 'DC 110 V', 'DC 120 V', 'DC 125 V',
  'DC 127 V', 'DC 220 V', 'DC 240 V', 'AC 100 V', 'AC 110 V', 'AC 120 V', 'AC 125 V', 'AC 230 V', 'AC 240 V'];
const HEATER = ['AC 220–240 V', 'AC 110 V'];

// ── 3.8 ─────────────────────────────────────────────────────────────────
// [section, 50 Hz at 25…55 °C, 60 Hz]
const BUSBAR: Record<string, [string, number[], number[]]> = {
  '1250/40': ['1x80x10', [1465, 1425, 1380, 1340, 1295, 1245, 1195], [1450, 1410, 1365, 1330, 1285, 1235, 1185]],
  '1250/<40': ['1x100x10', [1510, 1460, 1405, 1350, 1295, 1235, 1170], [1500, 1450, 1395, 1340, 1285, 1225, 1160]],
  '2500': ['2x100x10', [3000, 3000, 3000, 3000, 3000, 2885, 2735], [3000, 3000, 3000, 3000, 2890, 2755, 2615]],
  '4000': ['3x120x10', [4000, 4000, 4000, 4000, 4000, 3960, 3755], [4000, 4000, 4000, 4000, 3970, 3785, 3590]],
};
const busbarRow = (current: number | null, ka: number | null) => {
  if (current === 1250) return ka == null ? null : BUSBAR[ka >= 40 ? '1250/40' : '1250/<40'];
  if (current === 2500) return BUSBAR['2500'];
  if (current === 4000) return BUSBAR['4000'];
  return null;
};
const tempColumn = (t: number) => Math.min(6, Math.max(0, Math.ceil((t - 25) / 5)));

/** The values a field may take, given the rest of the specification. */
export function worldFieldRule(key: string, p: Props, site: WorldSiteInfo): FieldRule | null {
  const ur = num(p.ratedInsulationVoltage);
  const urKey = ur != null && UR.includes(ur) ? String(ur) : null;
  const ka = num(p.ratedShortTimeWithstandCurrent) ?? num(p.isc);
  const hz = num(p.frequency);
  const t = site.ambientC;

  switch (key) {
    case 'ratedInsulationVoltage':
      return { options: UR.map(v => opt(kvText(v))) };
    case 'serviceVoltage': {
      const list = urKey ? UN[urKey] : [...new Set(Object.values(UN).flat())].sort((a, b) => a - b);
      return { options: list.map(v => opt(kvText(v))) };
    }
    case 'ratedImpulseWithstandVoltage':
      return {
        options: (urKey ? [UP[urKey]] : Object.values(UP)).map(v => opt(`${v} kV`)),
        note: 'Up, phase/phase, phase/earth, open contact gap — correct for sites above 1000 m.',
      };
    case 'ratedPowerFrequencyWithstandVoltage': {
      const rows = urKey ? [UD[urKey]] : Object.values(UD);
      const o: FieldOption[] = [];
      rows.forEach(r => {
        o.push(opt(`${r.iec} kV`, `${r.iec} kV — IEC 62271-200`));
        if (r.gost) o.push(opt(`${r.gost} kV`, `${r.gost} kV — GOST`));
      });
      return { options: o };
    }
    case 'frequency':
      return { options: [opt('50 Hz'), opt('60 Hz')] };
    case 'ratedShortTimeWithstandCurrent':
      return {
        options: IK.map(k => opt(String(k), `${k} kA`)),
        note: `Rated duration ${DURATION.join(' s or ')} s; peak withstand ${ka === 40 ? '100 / 104' : ka === 31.5 ? '80 / 82' : '63 / 65'} kA (50 / 60 Hz).`,
      };
    case 'isc':
      return { options: (ka != null && IK.includes(ka) ? [ka] : IK).map(k => opt(String(k), `${k} kA`)) };
    case 'mainBusbarRatedCurrent':
      return {
        options: [1250, 2500, 4000].map(c => {
          const row = busbarRow(c, ka);
          const at = row && t != null ? (hz === 60 ? row[2] : row[1])[tempColumn(t)] : null;
          return opt(String(c), at != null && at !== c ? `${c} A — ${at} A at ${t} °C / ${hz ?? 50} Hz` : `${c} A`);
        }),
        note: num(p.mainBusbarRatedCurrent) === 4000 ? 'A 4000 A busbar needs forced ventilation.' : undefined,
      };
    case 'mainBusbarSize': {
      const row = busbarRow(num(p.mainBusbarRatedCurrent), ka);
      const all = ['1x80x10', '1x100x10', '2x100x10', '3x120x10'];
      return {
        options: (row ? [row[0]] : all).map(s => opt(s, `${s} mm`)),
        note: row ? 'Cross-section from table 3.8.' : undefined,
      };
    }
    case 'mainBusbarConfiguration':
      return { options: [opt('Single busbar')] };
    case 'busbarType':
      return {
        options: [opt('Without insulation'), opt('With insulation')],
        note: /^with insulation/i.test(String(p.busbarType ?? '')) ? 'Insulated busbar is not possible with CTs on the busbar.' : undefined,
      };
    case 'width':
      return {
        options: (ka === 40 ? ['800'] : ['600', '800']).map(w => opt(w, `${w} mm`)),
        note: ka === 40 ? 'At 40 kA every panel is 800 mm.' : 'By cell: 630 / 1000 A cells 600 mm, 1250 A and above 800 mm — see Breaker Code.',
      };
    case 'depth':
      return { options: [opt('1860', '1860 mm (1800 mm footprint without doors and covers)')] };
    case 'height': {
      const high = ka === 40 ? 2460 : 2425;
      return { options: [opt(String(high), `${high} mm — IAC A FLR 1 s (standard)`), opt('2253', '2253 mm — IAC A FLR 0.1 s')] };
    }
    case 'ip':
      return {
        options: [opt('IP4X', 'IP4X'), opt('IP51', 'IP51 — non-ventilated panels only')],
        note: String(p.ip ?? '').toUpperCase().includes('51') ? 'IP51 is possible only on panels without ventilation.' : undefined,
      };
    case 'switchgearAccess':
      return {
        options: [opt('Rear cable access (free-standing)'), opt('Front cable access (free- / wall-standing)')],
        note: /^front/i.test(String(p.switchgearAccess ?? ''))
          ? '100 mm to the rear wall; not with withdrawable VTs in a withdrawable-type switchgear.'
          : /^rear/i.test(String(p.switchgearAccess ?? '')) ? 'At least 500 mm to the rear wall.' : undefined,
      };
    case 'ral':
      return { options: [opt('RAL 7035', 'RAL 7035 (standard)')] };
    case 'controlProtectionClosingTrippingSignalling':
      return { options: SUPPLY.map(v => opt(v)), note: 'Closing solenoid, 1st and 2nd shunt release; an undervoltage release takes the 2nd shunt release’s voltage.' };
    case 'springChargingMotor':
      return { options: SUPPLY.map(v => opt(v)) };
    case 'switchgearLightingSpaceHeater':
      return { options: HEATER.map(v => opt(v)) };
    default:
      return null;
  }
}

/** Fields the catalogue speaks to — the form shows them as dropdowns. */
export const WORLD_FIELDS = [
  'ratedInsulationVoltage', 'serviceVoltage', 'ratedImpulseWithstandVoltage', 'ratedPowerFrequencyWithstandVoltage',
  'frequency', 'ratedShortTimeWithstandCurrent', 'isc', 'mainBusbarRatedCurrent', 'mainBusbarSize',
  'mainBusbarConfiguration', 'busbarType', 'width', 'depth', 'height', 'ip', 'switchgearAccess', 'ral',
  'controlProtectionClosingTrippingSignalling', 'springChargingMotor', 'switchgearLightingSpaceHeater',
];

/** True when a value is one the catalogue allows, given the rest. */
export function isAllowed(key: string, p: Props, site: WorldSiteInfo): boolean {
  const v = p[key];
  if (v == null || v === '') return true;
  const rule = worldFieldRule(key, p, site);
  return !rule || rule.options.some(o => o.value === String(v));
}

/**
 * One field changed: fill in what it settles.
 *
 * `autos` are the fields this form filled itself; only those, and empty
 * ones, are written. The field the engineer just set leaves `autos`.
 */
export function applyWorldRules(
  input: DeviceLibraryProperties, changed: string | null, autos: Set<string>, site: WorldSiteInfo,
): { props: DeviceLibraryProperties; autos: Set<string> } {
  const p: Props = { ...input };
  const a = new Set(autos);
  if (changed) a.delete(changed);
  const fill = (key: string, value: string) => {
    if (key === changed) return;
    const cur = p[key];
    if (cur == null || cur === '' || a.has(key)) { p[key] = value; a.add(key); }
  };
  const only = (key: string) => {
    // A field whose choices have narrowed to one takes it.
    const rule = worldFieldRule(key, p, site);
    if (rule && rule.options.length === 1) fill(key, rule.options[0].value);
  };

  // An operating voltage picks the lowest rated voltage that covers it.
  if (changed === 'serviceVoltage' || (p.serviceVoltage && !p.ratedInsulationVoltage)) {
    const un = num(p.serviceVoltage);
    const ur = UR.find(r => UN[String(r)].some(v => Math.abs(v - (un ?? -1)) < 1e-9));
    if (ur != null) fill('ratedInsulationVoltage', kvText(ur));
  }
  const ur = num(p.ratedInsulationVoltage);
  if (ur != null && UR.includes(ur)) {
    fill('ratedImpulseWithstandVoltage', `${UP[String(ur)]} kV`);
    fill('ratedPowerFrequencyWithstandVoltage', `${UD[String(ur)].iec} kV`);
  }
  const ka = num(p.ratedShortTimeWithstandCurrent);
  if (ka != null && IK.includes(ka)) {
    fill('isc', String(ka));
    if (ka === 40) fill('width', '800');
    fill('height', String(ka === 40 ? 2460 : 2425));
  }
  ['mainBusbarSize', 'mainBusbarConfiguration', 'depth', 'ral', 'ratedImpulseWithstandVoltage'].forEach(only);
  // A control voltage stands for the motor too until the motor is chosen.
  if (changed === 'controlProtectionClosingTrippingSignalling' && p.controlProtectionClosingTrippingSignalling) {
    fill('springChargingMotor', String(p.controlProtectionClosingTrippingSignalling));
  }
  return { props: p as DeviceLibraryProperties, autos: a };
}
