// src/utils/sion3ae5/simoprimeA4Scope.ts
//
// A SIMOPRIME A4 scope's specification, held to its design catalogue
// (version 1.4, 04/2007) the way simoprimeWorldScope holds a World scope:
//
//   1    Technical data    Ur 24 kV, Up 125 kV, Ud 50 kV; UN 20 / 22 / 24 kV;
//                          25 kA (62.5 / 65 kA peak), 1 s or 3 s; IP4X / 41 / 42
//   1.1  Busbars           800 / 1250 / 2000 / 2500 A and their cross-sections;
//                          bare, joints silver plated; earth bar 10 x 30 mm
//   1.2  Busbar capacity   what each busbar run carries at 25–55 °C
//   1.3  Design options    single busbar; front cable access; RAL 7032
//   1.5  Supply voltages   as World
//   2.2  Feeder currents   the incomer's panel: width and ventilation
//   2.2.1 Dimensions       depth 1900 mm, height 2250 mm
//
// The same contract: a choice fills only what is empty or was filled the same
// way before, and the engineer's own values are never overwritten.
import type { DeviceLibraryProperties } from '../../types/project';
import { a4Panel } from './simoprimeA4';
import { SUPPLY, OFFICE_CHOICES, type FieldOption, type FieldRule, type WorldSiteInfo } from './simoprimeWorldScope';

type Props = Record<string, any>;

const num = (v: unknown): number | null => {
  const m = String(v ?? '').replace(',', '.').match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};
const opt = (value: string, label = value): FieldOption => ({ value, label });
const tempColumn = (t: number) => Math.min(6, Math.max(0, Math.ceil((t - 25) / 5)));

const UN = ['20 kV', '22 kV', '24 kV'];
const IK = [16, 20, 25];
const BUSBAR_A = [800, 1250, 2000, 2500];
/** 1.1: the cross-sections a busbar current may have. */
const SECTIONS: Record<number, string[]> = {
  800: ['1x80x10'], 1250: ['1x80x10', '1x100x10'], 2000: ['2x80x10'], 2500: ['2x100x10'],
};
/** 1.2: [ventilation, 50 Hz at 25…55 °C, 60 Hz] by busbar run. */
const CAPACITY: Record<string, [string, number[], number[]]> = {
  '1x80x10': ['without ventilation', [1456, 1375, 1284, 1200, 1106, 1008, 900], [1396, 1317, 1230, 1150, 1060, 966, 862]],
  '1x100x10': ['without ventilation', [1821, 1719, 1605, 1500, 1383, 1260, 1125], [1699, 1604, 1498, 1400, 1290, 1176, 1050]],
  '2x80x10': ['natural ventilation', [2913, 2750, 2568, 2400, 2212, 2016, 1800], [2852, 2693, 2514, 2350, 2166, 1974, 1762]],
  '2x100x10': ['forced ventilation', [3787, 3575, 3338, 3120, 2876, 2620, 2340], [3763, 3552, 3317, 3100, 2858, 2604, 2325]],
};
const EARTH_BAR = 'Cu 30x10';
const FRONT = 'Front cable access (free- / wall-standing)';

/** The incomer's panel: a breaker carrying the busbar current (2.2). */
function incomerPanel(p: Props, site: WorldSiteInfo) {
  const busbar = num(p.mainBusbarRatedCurrent);
  if (!busbar) return null;
  return a4Panel('circuit-breaker', busbar, {
    kv: 24, ka: num(p.ratedShortTimeWithstandCurrent) ?? num(p.isc),
    ambientC: num(p.designTemperature) ?? site.ambientC, frequencyHz: num(p.frequency),
  });
}

/** The values a field may take, given the rest of the specification. */
export function a4FieldRule(key: string, p: Props, site: WorldSiteInfo): FieldRule | null {
  const ka = num(p.ratedShortTimeWithstandCurrent) ?? num(p.isc);
  const hz = num(p.frequency);
  const t = num(p.designTemperature) ?? site.ambientC;

  switch (key) {
    case 'ratedInsulationVoltage':
      return { options: [opt('24 kV')] };
    case 'serviceVoltage':
      return { options: UN.map(v => opt(v)) };
    case 'ratedImpulseWithstandVoltage':
      return { options: [opt('125 kV')], note: 'To be checked for sites above 1000 m.' };
    case 'ratedPowerFrequencyWithstandVoltage':
      return { options: [opt('50 kV')] };
    case 'frequency':
      return { options: [opt('50 Hz'), opt('60 Hz')] };
    case 'ratedShortTimeWithstandCurrent':
      return {
        options: IK.map(k => opt(String(k), k === 25 ? '25 kA — switchgear rating' : `${k} kA`)),
        note: ka != null && ka !== 25
          ? 'SIMOPRIME A4 is rated 25 kA; 16 / 20 kA are its breakers’ lower ratings (2.3.2).'
          : 'Peak withstand 62.5 / 65 kA (50 / 60 Hz); 1 s or 3 s — the earthing switch is limited to 1 s.',
      };
    case 'isc':
      return { options: (ka != null && IK.includes(ka) ? [ka] : IK).map(k => opt(String(k), `${k} kA`)) };
    case 'mainBusbarRatedCurrent':
      return {
        options: BUSBAR_A.map(c => opt(String(c), `${c} A`)),
        note: num(p.mainBusbarRatedCurrent) === 2500 ? '2500 A needs forced ventilation.' : 'Rated up to 40 °C ambient (1.1).',
      };
    case 'mainBusbarSize': {
      const c = num(p.mainBusbarRatedCurrent);
      const list = c && SECTIONS[c] ? SECTIONS[c] : Object.keys(CAPACITY);
      const col = tempColumn(t ?? 40);
      return {
        options: list.map(s => {
          const [vent, a50, a60] = CAPACITY[s];
          return opt(s, `${s} mm — ${(hz === 60 ? a60 : a50)[col]} A at ${t ?? 40} °C, ${vent}`);
        }),
        note: 'Cross-section from 1.1; capacity of the busbar alone from 1.2. Bare, joints silver plated.',
      };
    }
    case 'mainBusbarConfiguration':
      return { options: [opt('Single busbar')] };
    case 'busbarType':
      return { options: [opt('Without insulation'), opt('With insulation')] };
    case 'width':
      return {
        options: ['800', '1000'].map(w => opt(w, `${w} mm`)),
        note: 'From the incomer panel (busbar current, table 2.2): 800 mm up to 1250 A, 1000 mm above; each cell’s own width is in Breaker Code.',
      };
    case 'depth':
      return { options: [opt('1900', '1900 mm')], note: 'Without front doors and rear covers (2.2.1).' };
    case 'height':
      return { options: [opt('2250', '2250 mm')], note: 'LV compartment 700 mm (1.3).' };
    case 'ventilationType':
      return { options: [opt('Without'), opt('Natural'), opt('Forced')] };
    case 'ip':
      return { options: [opt('IP4X'), opt('IP41'), opt('IP42')] };
    case 'switchgearAccess':
      return { options: [opt(FRONT)], note: 'At least 600 mm to the rear wall (1.3).' };
    case 'ral':
      return {
        options: OFFICE_CHOICES.ral.options.map(o => (o.value === '7032' ? opt('7032', 'RAL 7032 (SIMOPRIME A4 standard)') : o)),
        note: p.ral && String(p.ral) !== '7032' ? 'SIMOPRIME A4 standard colour is RAL 7032.' : undefined,
      };
    case 'earthBusbarSize':
      return { options: [opt(EARTH_BAR, `${EARTH_BAR} mm`)], note: 'Design catalogue 1.1: earth bar 10 x 30 mm, bare.' };
    case 'coating':
      return { options: OFFICE_CHOICES.coating.options, note: 'Busbars are bare, joints silver plated (1.1).' };
    case 'controlProtectionClosingTrippingSignalling':
      return { options: SUPPLY.map(v => opt(v)), note: 'Closing solenoid, 1st and 2nd shunt release, undervoltage release (1.5).' };
    case 'springChargingMotor':
      return { options: SUPPLY.map(v => opt(v)) };
    case 'switchgearLightingSpaceHeater':
      return { options: ['AC 220 V', 'AC 230 V', 'AC 240 V', 'AC 110 V'].map(v => opt(v)) };
    default:
      return null;
  }
}

/** Fields the A4 catalogue speaks to — the form shows them as dropdowns. */
export const A4_FIELDS = [
  'ratedInsulationVoltage', 'serviceVoltage', 'ratedImpulseWithstandVoltage', 'ratedPowerFrequencyWithstandVoltage',
  'frequency', 'ratedShortTimeWithstandCurrent', 'isc', 'mainBusbarRatedCurrent', 'mainBusbarSize',
  'mainBusbarConfiguration', 'busbarType', 'width', 'depth', 'height', 'ip', 'switchgearAccess', 'ral',
  'controlProtectionClosingTrippingSignalling', 'springChargingMotor', 'switchgearLightingSpaceHeater',
  'ventilationType', 'earthBusbarSize', 'coating',
];

/** One field changed: fill in what it settles (see applyWorldRules). */
export function applyA4Rules(
  input: DeviceLibraryProperties, changed: string | null, autos: Set<string>, site: WorldSiteInfo,
): { props: DeviceLibraryProperties; autos: Set<string> } {
  const p: Props = { ...input };
  const a = new Set([...autos, ...((input as any).catalogueAuto ?? [])]);
  if (changed) a.delete(changed);
  const fill = (key: string, value: string) => {
    if (key === changed) return;
    const cur = p[key];
    if (cur == null || cur === '' || a.has(key)) { p[key] = value; a.add(key); }
  };

  fill('ratedInsulationVoltage', '24 kV');
  fill('ratedImpulseWithstandVoltage', '125 kV');
  fill('ratedPowerFrequencyWithstandVoltage', '50 kV');
  fill('mainBusbarConfiguration', 'Single busbar');
  fill('switchgearAccess', FRONT);
  fill('earthBusbarSize', EARTH_BAR);
  fill('coating', 'Silver (Joint)');
  fill('ral', '7032');
  fill('depth', '1900');
  fill('height', '2250');
  const ka = num(p.ratedShortTimeWithstandCurrent);
  if (ka != null && IK.includes(ka)) fill('isc', String(ka));

  // Width, ventilation and — for 1250 A — the busbar run: the incomer's panel
  // (table 2.2 at the design temperature); ventilation also takes the most
  // demanding of the cells.
  const busbar = num(p.mainBusbarRatedCurrent);
  const incomer = incomerPanel(p, site);
  const rank = (v: unknown) => ['Without', 'Natural', 'Forced'].indexOf(String(v ?? 'Without'));
  if (busbar && SECTIONS[busbar]) {
    const sections = SECTIONS[busbar];
    fill('mainBusbarSize', sections.length === 1 ? sections[0] : incomer?.ventilation === 'Without' ? '1x100x10' : '1x80x10');
  }
  if (incomer?.width) {
    fill('width', String(incomer.width));
    let vent = incomer.ventilation;
    if (site.cellsVentilation && rank(site.cellsVentilation) > rank(vent)) vent = site.cellsVentilation as any;
    fill('ventilationType', vent);
  } else if (site.cellsVentilation) {
    fill('ventilationType', site.cellsVentilation);
  }
  if (changed === 'controlProtectionClosingTrippingSignalling' && p.controlProtectionClosingTrippingSignalling) {
    fill('springChargingMotor', String(p.controlProtectionClosingTrippingSignalling));
  }
  p.catalogueAuto = [...a];
  return { props: p as DeviceLibraryProperties, autos: a };
}
