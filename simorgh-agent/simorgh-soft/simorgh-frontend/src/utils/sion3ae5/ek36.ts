// src/utils/sion3ae5/ek36.ts
//
// EK36 (Electro Kavir, 36 kV truck-type, manual EK-MS-04, 09.2025): the
// scope's specification and each cell's panel, held to the manual the way
// SIMOPRIME World and A4 are held to their design catalogues.
//
//   10.1   Technical data     Ur 36 kV, Ud 70 kV, Up 170 kV, 50 Hz; Ik 25 /
//                             31.5 kA, max. 3 s; Ip 80 kA; IAC 31.5 kA 1 s;
//                             busbar up to 4000 A, feeders 1250–2500 A;
//                             every panel 1100 mm wide, 2250 mm high (2650
//                             with the arc fault duct), 2850 mm deep (3380
//                             with the rear PT box); IP4X, IP41 option
//   7.4 / 17.3  Busbars       1250 A 1x100x10, 2500 A 2x100x10,
//                             4000 A 3x120x10 — bare copper, insulated option
//   17.4   Earthing busbar    25 kA Cu 30x5, 31.5 kA Cu 40x5
//   7.5    Cable compartment  cables from the rear
//   10.3   Breaker            3AH3; motor DC 24 / 48 / 60 / 110 / 220 V,
//                             AC 110 / 230 V
//
// The breaker is the 3AH3, not the SION 3AE5: its order number is built by
// ah3.ts (Siemens HG 11.03) from the rating each cell gives here.
import type { DeviceLibraryProperties } from '../../types/project';
import type { PanelChoice, PanelKind, WorldPanel, WorldSite } from './simoprimeWorld';
import type { FieldOption, FieldRule, WorldSiteInfo } from './simoprimeWorldScope';

type Props = Record<string, any>;

const num = (v: unknown): number | null => {
  const m = String(v ?? '').replace(',', '.').match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};
const opt = (value: string, label = value): FieldOption => ({ value, label });

const IK = [25, 31.5];
const BUSBAR: Record<number, string> = { 1250: '1x100x10', 2500: '2x100x10', 4000: '3x120x10' };
const EARTH: Record<string, string> = { '25': 'Cu 30x5', '31.5': 'Cu 40x5' };
/** 10.3: the 3AH3's motor and release voltages. */
const SUPPLY = ['DC 24 V', 'DC 48 V', 'DC 60 V', 'DC 110 V', 'DC 220 V', 'AC 110 V', 'AC 230 V'];
const REAR = 'Rear cable access (free-standing)';

export const EK36_WIDTHS = [1100];

// ── Cells ────────────────────────────────────────────────────────────────
export function ek36Panel(kind: PanelKind, feederA: number | null, site: WorldSite, choice: PanelChoice = {}): WorldPanel {
  const notes: string[] = [];
  const p: WorldPanel = {
    kind, feederA, typicalA: null, width: 1100, ventilation: 'Without',
    breakerA: null, breaker: null, permissibleA: null, withdrawableVT: null, notes,
  };
  const ka = site.ka != null ? IK.find(s => s >= site.ka! - 1e-9) ?? null : null;
  if (site.ka != null && ka == null) notes.push(`${site.ka} kA is above EK36's 31.5 kA.`);
  switch (kind) {
    case 'circuit-breaker':
      if (feederA == null) { notes.push('No current for this cell — enter it, or the row’s power.'); break; }
      // 10.1: incoming and outgoing feeders 1250–2500 A.
      p.typicalA = feederA <= 1250 ? 1250 : 2500;
      if (feederA > 2500) notes.push(`${feederA} A is above EK36's 2500 A feeder rating (10.1).`);
      if (site.busbarA && feederA > site.busbarA) notes.push(`${feederA} A is more than the main busbar's ${site.busbarA} A.`);
      p.breakerA = p.typicalA;
      p.breakerText = `3AH3 · 36 kV · ${ka ?? '?'} kA · ${p.typicalA} A`;
      p.withdrawableVT = true;
      notes.unshift(`EK36 10.1: ${p.typicalA} A circuit-breaker panel, 1100 mm; 3AH3 vacuum circuit-breaker on truck.`);
      break;
    case 'metering':
      p.withdrawableVT = true;
      notes.push('Metering truck with VTs and primary fuses (6.4).');
      break;
    case 'bus-riser':
    case 'bus-connection':
      p.typicalA = feederA;
      notes.push('Bus sectionalizer = circuit-breaker panel + bus riser panel, 1100 mm each (6.3, 10.1).');
      break;
    default:
      p.width = null;
      notes.push('Not an EK36 panel type — width as the layout needs.');
  }
  if (choice.width) { p.width = choice.width; p.manual = { ...p.manual, width: true }; }
  if (choice.ventilation) { p.ventilation = choice.ventilation; p.manual = { ...p.manual, ventilation: true }; }
  return p;
}

// ── Scope ────────────────────────────────────────────────────────────────
export function ek36FieldRule(key: string, p: Props, _site: WorldSiteInfo): FieldRule | null {
  const ka = num(p.ratedShortTimeWithstandCurrent) ?? num(p.isc);
  switch (key) {
    case 'ratedInsulationVoltage':
      return { options: [opt('36 kV')] };
    case 'serviceVoltage':
      return { options: ['30 kV', '33 kV', '34.5 kV', '35 kV', '36 kV'].map(v => opt(v)), note: 'Operating voltages up to the 36 kV rating.' };
    case 'ratedImpulseWithstandVoltage':
      return { options: [opt('170 kV')] };
    case 'ratedPowerFrequencyWithstandVoltage':
      return { options: [opt('70 kV')] };
    case 'frequency':
      return { options: [opt('50 Hz')], note: 'EK36 is rated 50 Hz (10.1).' };
    case 'ratedShortTimeWithstandCurrent':
      return {
        options: IK.map(k => opt(String(k), `${k} kA`)),
        note: 'Max. 3 s; peak withstand 80 kA, making 78.75 kA; internal arc 31.5 kA / 1 s (10.1).',
      };
    case 'isc':
      return { options: (ka != null && IK.includes(ka) ? [ka] : IK).map(k => opt(String(k), `${k} kA`)) };
    case 'mainBusbarRatedCurrent':
      return { options: [1250, 2500, 4000].map(c => opt(String(c), `${c} A`)) };
    case 'mainBusbarSize': {
      const c = num(p.mainBusbarRatedCurrent);
      return {
        options: (c && BUSBAR[c] ? [BUSBAR[c]] : Object.values(BUSBAR)).map(s => opt(s, `${s} mm`)),
        note: 'EK36 17.3: 1250 A 1x100x10, 2500 A 2x100x10, 4000 A 3x120x10 — bare copper.',
      };
    }
    case 'earthBusbarSize':
      return {
        options: (ka != null && EARTH[String(ka)] ? [EARTH[String(ka)]] : Object.values(EARTH)).map(v => opt(v, `${v} mm`)),
        note: 'EK36 17.4: 25 kA Cu 30x5, 31.5 kA Cu 40x5.',
      };
    case 'mainBusbarConfiguration':
      return { options: [opt('Single busbar'), opt('Double busbar'), opt('Triplex busbar')] };
    case 'busbarType':
      return { options: [opt('Without insulation'), opt('With insulation')] };
    case 'width':
      return { options: [opt('1100', '1100 mm')], note: 'Circuit-breaker and bus sectionalizer panels (10.1).' };
    case 'height':
      return {
        options: [opt('2650', '2650 mm — with arc fault duct'), opt('2250', '2250 mm — without arc fault duct')],
        note: 'Switchgear room at least 3150 mm high (10.1).',
      };
    case 'depth':
      return {
        options: [opt('2850', '2850 mm'), opt('3380', '3380 mm — with rear PT box')],
        note: num(p.depth) === 3380 ? 'With the rear PT box (7.2).' : undefined,
      };
    case 'ip':
      return { options: [opt('IP4X'), opt('IP41', 'IP41 — option')] };
    case 'switchgearAccess':
      return { options: [opt(REAR)], note: 'Cables from the rear; > 800 mm behind, control aisle ≥ 2000 mm for panel replacement (16.5).' };
    case 'controlProtectionClosingTrippingSignalling':
      return { options: SUPPLY.map(v => opt(v)), note: '3AH3 closing solenoid 3AY1510, 1st shunt release 3AY1510, 2nd 3AX1101 (10.3).' };
    case 'springChargingMotor':
      return { options: SUPPLY.map(v => opt(v)), note: '3AH3 motor: 500 W DC / 650 VA AC (10.3).' };
    case 'switchgearLightingSpaceHeater':
    case 'motorsSpaceHeater':
      return { options: [opt('AC 230 V'), opt('AC 110 V')], note: key === 'switchgearLightingSpaceHeater' ? 'Heaters in the switching-device and cable compartments, thermostat ≥ +5 °C, hygrostat ≤ 85 % (10.1).' : undefined };
    case 'ventilationType':
      return { options: [opt('Without')], note: 'EK36 panels are not ventilated (10.1).' };
    default:
      return null;
  }
}

export const EK36_FIELDS = [
  'ratedInsulationVoltage', 'ratedImpulseWithstandVoltage', 'ratedPowerFrequencyWithstandVoltage', 'frequency',
  'ratedShortTimeWithstandCurrent', 'isc', 'mainBusbarRatedCurrent', 'mainBusbarSize', 'earthBusbarSize',
  'mainBusbarConfiguration', 'busbarType', 'width', 'height', 'depth', 'ip', 'switchgearAccess',
  'controlProtectionClosingTrippingSignalling', 'springChargingMotor', 'serviceVoltage',
  'switchgearLightingSpaceHeater', 'motorsSpaceHeater', 'ventilationType',
];

/** One field changed: fill in what it settles (see applyWorldRules). */
export function applyEk36Rules(
  input: DeviceLibraryProperties, changed: string | null, autos: Set<string>, _site: WorldSiteInfo,
): { props: DeviceLibraryProperties; autos: Set<string> } {
  const p: Props = { ...input };
  const a = new Set([...autos, ...((input as any).catalogueAuto ?? [])]);
  if (changed) a.delete(changed);
  const fill = (key: string, value: string) => {
    if (key === changed) return;
    const cur = p[key];
    if (cur == null || cur === '' || a.has(key)) { p[key] = value; a.add(key); }
  };
  fill('ratedInsulationVoltage', '36 kV');
  fill('ratedImpulseWithstandVoltage', '170 kV');
  fill('ratedPowerFrequencyWithstandVoltage', '70 kV');
  fill('frequency', '50 Hz');
  fill('width', '1100');
  fill('height', '2650');
  fill('depth', '2850');
  fill('switchgearAccess', REAR);
  fill('ventilationType', 'Without');
  const ka = num(p.ratedShortTimeWithstandCurrent);
  if (ka != null && IK.includes(ka)) {
    fill('isc', String(ka));
    fill('earthBusbarSize', EARTH[String(ka)]);
  }
  const c = num(p.mainBusbarRatedCurrent);
  if (c && BUSBAR[c]) fill('mainBusbarSize', BUSBAR[c]);
  if (changed === 'controlProtectionClosingTrippingSignalling' && p.controlProtectionClosingTrippingSignalling) {
    fill('springChargingMotor', String(p.controlProtectionClosingTrippingSignalling));
  }
  p.catalogueAuto = [...a];
  return { props: p as DeviceLibraryProperties, autos: a };
}
