// src/utils/outline/rules.ts
//
// The outline's decisions: how wide a cell is, which DXF blocks it is drawn
// from, and what ventilation it needs.
//
// Ported rule for rule from `Eplanix/Services/OutlineService.cs` —
// DeterminePanelWidth, DetermineDxfOpening, DetermineDxfNameAndDescription,
// DetermineLvDoorAsync and GetVENTILATION. The order of the tests inside each
// is part of the rule and is kept: in the width rules the compound wiring
// types are tested before the bare ones, because "Metering Riser Connection"
// contains "Riser" and would otherwise be answered by the riser rule.
//
// Everything here is pure. What it is asked about a feeder — the breaker's
// code, the CT's current, the labels — is read in `parts.ts`, and `feeder.ts`
// puts the two together.

import { PoleCenter } from './poleCenter';
import { PanelConfig } from './simoprimeWorld';
import { findBestA4Configuration } from './simoprimeA4';

const up = (v: unknown) => String(v ?? '').toUpperCase();
const squash = (v: unknown) => up(v).replace(/\s+/g, '');

/** First whole number in a string, or null. */
export const extractInt = (v: unknown): number | null => {
  const m = /\d+/.exec(String(v ?? ''));
  return m ? Number(m[0]) : null;
};

/** First number, decimals included. */
export const extractDouble = (v: unknown): number | null => {
  const m = /\d+(\.\d+)?/.exec(String(v ?? ''));
  return m ? Number(m[0]) : null;
};

/** A number only when the string starts with one — "40°C" is 40, "IP40" is not. */
export const extractIntegerStrict = (v: unknown): number | null => {
  const m = /^-?\d+/.exec(String(v ?? '').trim());
  return m ? Number(m[0]) : null;
};

/** The cable size as the drawing states it: has one, or has not. */
export const formatCableSize = (cableSize: string): string => {
  if (!cableSize) return 'NO';
  return /\d/.test(cableSize) ? 'YES' : cableSize;
};

/** "800mm" → 800. "N/A" and empty → 0. */
export const parsePanelWidth = (panelWidth: string): number => {
  if (!panelWidth || panelWidth === 'N/A') return 0;
  const n = Number(panelWidth.replace(/mm/gi, '').trim());
  return Number.isFinite(n) ? n : 0;
};

/** One feeder, as the width rule needs to see the others of its switchgear. */
export interface FeederPeer {
  wiringType: string;
  /** What that feeder's CT says its current is. */
  ctCurrent: number | null;
}

/**
 * How wide the cell is.
 *
 * EK36 is 1100 mm unless the cable-size column names a width for a dummy,
 * riser or metering cell. SIMOPRIME Truck and WDA go by the breaker's pole
 * centre where there is a breaker, and by the wiring type where there is not.
 * Everything else goes by the pole centre, falling back to the same named
 * widths.
 */
export function determinePanelWidth(
  kbus: string, poleCenter: PoleCenter | null, cableSize: string, panelType: string,
  cbLabel: string, wiringType: string, feederCurrent: number | null, flc: number | null,
  peers: FeederPeer[],
): string {
  const lower = String(cableSize ?? '').toLowerCase().trim();
  const pt = up(panelType);

  // A named width inside the cable-size column — "DUMMY 800" and the like.
  const namedWidth = (fallback: string): string => {
    if (lower.includes('dummy') || lower.includes('riser') || lower.includes('metering')) {
      if (lower.includes('400')) return '400mm';
      if (lower.includes('600')) return '600mm';
      if (lower.includes('800')) return '800mm';
      if (lower.includes('1100')) return '1100mm';
      if (lower.includes('1000')) return '1000mm';
      return fallback;
    }
    return fallback;
  };

  const byPoleCenter = (pc: PoleCenter | null): string | null => {
    if (!pc || !pc.valid) return null;
    if (pc.poleCenterDistance === 150 || pc.poleCenterDistance === 160) return '600mm';
    if (pc.poleCenterDistance === 210) return '800mm';
    if (pc.poleCenterDistance === 275) return '1000mm';
    if (pc.poleCenterDistance === 350) return '1100mm';
    return null;
  };

  if (pt.includes('EK36')) {
    return namedWidth('1100mm');
  }

  if (pt === 'AIS-SIMOPRIME - TRUCK TYPE' || pt === 'AIS-SIMOPRIME - WDA TYPE') {
    // A 40 kA busbar needs the wider cell whatever else is true of it.
    if ((extractDouble(kbus) ?? 0) >= 40) return '800mm';

    const hasCb = !!cbLabel && cbLabel.toUpperCase() !== 'N/A';
    if (hasCb) return byPoleCenter(poleCenter) ?? 'N/A';

    // No breaker: the wiring type decides. The compound forms are tested
    // first so the bare "RISER" rule below does not swallow them.
    const wt = up(wiringType);

    if (wt.includes('METERING RISER CONNECTION') || wt.includes('MET/RISER CONNECTION')
        || wt.includes('DISCONNECTOR LINK')) {
      if (feederCurrent != null) return feederCurrent > 1000 ? '800mm' : '600mm';
      if (flc != null) return flc > 1000 ? '800mm' : '600mm';
      return '600mm';
    }

    if (wt.includes('RISER') || wt.includes('RIZER')) {
      // A riser is as wide as the coupling it rises to.
      const coupling = peers.find(f => f.wiringType && up(f.wiringType).includes('COUP'));
      if (coupling?.ctCurrent != null && coupling.ctCurrent > 3000) return '800mm';
      return '600mm';
    }

    if (wt.includes('MET')) return '600mm';

    return 'N/A';
  }

  return byPoleCenter(poleCenter) ?? namedWidth('800mm');
}

/**
 * The opening cut in the cell's floor, and whether it gets a cable box.
 *
 * A cell that carries no cable out of the bottom — a coupling, a riser, a
 * metering, a dummy, a busduct or an adaptor — is cut for nothing.
 */
export function determineDxfOpening(
  panelType: string, ptStatus: string, cableSize: string, designation: string,
  cbType: string, currentA: number, hasCt: boolean,
): { opening: string; cableBox: boolean } {
  const pt = up(panelType);
  // Squashed so "BUS DUCT", "BUSDUCT" and "Bus Duct" are one thing.
  const cs = squash(cableSize);
  const des = squash(designation);

  const isUtilityCell = !!cableSize && (
    cs.includes('COUPLING') || des.includes('BUSDUCT') || cs.includes('METERING')
    || cs.includes('RISER') || cs.includes('DUMMY') || des.includes('ADAPTOR'));

  if (pt === 'EK36' || pt === 'AIS-SIMOPRIME-A4') {
    if (isUtilityCell) return { opening: 'no-cut-opening', cableBox: false };
    if (ptStatus && ptStatus.trim().toUpperCase() === 'YES' && cbType !== 'N/A') {
      return { opening: 'cable-cut-opening-with-pt', cableBox: true };
    }
    return { opening: 'cable-cut-opening', cableBox: true };
  }

  if (pt.includes('AIS-SIMOPRIME')) {
    if (cs.includes('BUSDUCT')) {
      if ((currentA > 2500 && currentA <= 4000) || (currentA === 2500 && hasCt)) {
        return { opening: 'cable-cut-opening with bus duc-3150 with ct', cableBox: true };
      }
      if (currentA === 2500) return { opening: 'cable-cut-opening with bus duct', cableBox: true };
      return { opening: 'cable-cut-opening', cableBox: true };
    }
    if (isUtilityCell) return { opening: 'no-cut-opening', cableBox: false };
    return { opening: 'cable-cut-opening', cableBox: true };
  }

  if (des.includes('BUSDUCT')) {
    return { opening: 'cable-cut-opening-with-bus duct', cableBox: true };
  }
  return { opening: 'no-cut-opening', cableBox: false };
}

/** The HV door block, and what the drawing calls it. */
export function determineDxfNameAndDescription(
  planeType: string, cbType: string, isCoupling: boolean,
  cableSize: string, cbLabel: string, ptStatus: string,
): { hvDoor: string; description: string } {
  const plane = String(planeType ?? '');
  const lowerCable = String(cableSize ?? '').toLowerCase();

  const other = (): { hvDoor: string; description: string } =>
    (lowerCable.includes('dummy')
      ? { hvDoor: 'hv-door-dummy', description: 'HV DOOR OTHER' }
      : { hvDoor: 'hv-door-for-met-riser', description: 'HV DOOR OTHER' });

  const pair = (coup: string, feeder: string) => (isCoupling
    ? { hvDoor: coup, description: 'HV DOOR COUPLING' }
    : { hvDoor: feeder, description: 'HV DOOR FEEDER' });

  if (plane.includes('EK36')) {
    if (cbType === '3AH3') return pair('hv-door-for-coup', 'hv-door-for-inc-out');
    if (cbType === '3AH5') return pair('824-5905.0-2.0', '824-5900.0-2.0');
    return other();
  }

  if (plane.includes('A4')) {
    if (cbType === '3AE5') return pair('hv-door-for-coup', 'hv-door-for-inc-out');
    if (cbType === '3AE3') return pair('824-5905.0-2.0', '824-5900.0-2.0');
    return other();
  }

  if (up(plane).includes('SIMOPRIME')) {
    if (cbType === '3AE5' || cbType === '3TM') {
      if (isCoupling) return { hvDoor: 'hv-door-for-coup', description: 'HV DOOR COUPLING' };
      // A withdrawable incomer that also carries a VT needs the door with the
      // VT cut-out in it.
      const isQwWithPt = String(cbLabel ?? '').toUpperCase() === 'QW'
        && !!ptStatus && ptStatus.trim().toUpperCase() === 'YES';
      return {
        hvDoor: isQwWithPt ? 'hv-door-for-inc-out+PT' : 'hv-door-for-inc-out',
        description: 'HV DOOR FEEDER',
      };
    }
    return other();
  }

  return { hvDoor: '', description: '' };
}

/**
 * The low-voltage compartment door.
 *
 * EK36 and A4 have one door and it is the same door. A SIMOPRIME World's
 * depends on how tall its LV compartment was ordered, and a metering or riser
 * cell with a bus earth switch gets the door with the switch in it.
 */
export function determineLvDoor(
  panelType: string, cableSize: string, hasQc2: boolean, lvCompartmentHeight: string,
): string {
  const pt = up(panelType);
  if (pt.includes('EK36') || pt === 'AIS-SIMOPRIME-A4') return 'lv-door';

  const height = String(lvCompartmentHeight ?? '').trim() || '70';
  const cs = String(cableSize ?? '').trim();
  const isMetOrRiser = cs.toUpperCase() === 'METERING' || cs.toUpperCase() === 'RISER';

  if (isMetOrRiser && hasQc2) return `lv-door-${height}+ES`;
  return `lv-door-${height}`;
}

/** The baffle, from the busbar's short-circuit rating. */
export const determineBaffle = (kbus: string): string => {
  const k = String(kbus ?? '');
  if (k.includes('31.5')) return 'buffel-two-line';
  if (k.includes('25')) return 'buffel-one-line';
  return 'N/A';
};

/**
 * What ventilation the cell needs.
 *
 * A SIMOPRIME Truck or WDA takes the answer from the World selection table,
 * which was chosen for the whole panel; anything else is looked up in the A4
 * busbar table at this temperature, frequency and current. Unanswerable
 * without all three, and the original says so the same way: "N/A".
 */
export function determineVentilation(
  worldPanel: PanelConfig | null, panelType: string,
  temperature: number | null, frequency: number | null, current: number | null,
): string {
  if (temperature == null || frequency == null || current == null) return 'N/A';

  const pt = up(panelType);
  if (pt === 'AIS-SIMOPRIME - TRUCK TYPE' || pt === 'AIS-SIMOPRIME - WDA TYPE') {
    return worldPanel?.ventilation ?? 'N/A';
  }

  return findBestA4Configuration(temperature, frequency, current)?.ventilation ?? 'N/A';
}

/** The breaker family the whole switchgear is built around. */
export const switchgearCbType = (cbTypes: string[]): string =>
  cbTypes.find(t => t === '3AH3' || t === '3AH5' || t === '3AE3' || t === '3AE5') ?? 'Unknown';
