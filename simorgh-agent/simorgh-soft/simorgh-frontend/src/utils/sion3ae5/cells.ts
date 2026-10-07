// src/utils/sion3ae5/cells.ts
//
// What a MV cell is and what it has to carry, from what a project has at the
// start: the template name ("C23 (6KV)OUT MOTOR 500A"), the row's power and
// FLC, and the scope's busbar current.
//
// The current decides the panel (typical, width, ventilation) and the breaker,
// so where it came from is kept beside it: the engineer's own figure beats
// everything, an incomer or coupler carries the busbar, an outgoing feeder
// carries its load — worked out from its power, else read from its name — and
// a bare FLC from TPMS comes last, flagged, because on many projects it holds
// the panel rating rather than the load.
import type { DeviceLibraryItem, DeviceTableRow } from '../../types/project';

export type CellRole =
  | 'incomer' | 'coupler' | 'motor' | 'transformer' | 'capacitor' | 'outgoing'
  | 'metering' | 'bus-riser' | 'bus-connection' | 'contactor' | 'load-break' | 'fused-load-break' | 'dummy';

export const ROLE_LABEL: Record<CellRole, string> = {
  incomer: 'Incomer', coupler: 'Bus coupler', motor: 'Motor feeder', transformer: 'Transformer feeder',
  capacitor: 'Capacitor feeder', outgoing: 'Outgoing feeder', metering: 'Metering', 'bus-riser': 'Bus riser',
  'bus-connection': 'Bus connection', contactor: 'Contactor (CFC)', 'load-break': 'Load-break switch',
  'fused-load-break': 'Fused load-break switch', dummy: 'Dummy',
};

/** Roles whose panel carries a circuit-breaker. */
export const HAS_BREAKER: Record<CellRole, boolean> = {
  incomer: true, coupler: true, motor: true, transformer: true, capacitor: true, outgoing: true,
  metering: false, 'bus-riser': false, 'bus-connection': false, contactor: false,
  'load-break': false, 'fused-load-break': false, dummy: false,
};

/** What the template name says the cell is. */
export function cellRole(templateName = ''): CellRole {
  const t = ` ${templateName.toUpperCase()} `;
  if (/RISER/.test(t)) return 'bus-riser';
  if (/BUS\s*-?\s*CONNECTION|BUSBAR\s*CONNECTION/.test(t)) return 'bus-connection';
  if (/\bMET(ER(ING)?)?\b|\bMEASUR/.test(t)) return 'metering';
  if (/\bDUMMY\b/.test(t)) return 'dummy';
  if (/CONTACTOR|\bCFC\b/.test(t)) return 'contactor';
  if (/\bFLBS\b|FUSED\s*(LOAD|LBS|SWITCH)|SWITCH\s*-?\s*FUSE/.test(t)) return 'fused-load-break';
  if (/\bLBS\b|LOAD\s*-?\s*BREAK/.test(t)) return 'load-break';
  if (/\bINC(OMING|OMER)?\b|\bINCOMMING\b/.test(t)) return 'incomer';
  if (/\bCOUP(LER|LING)?\b|\bB\.?\s*C\b|SECTIONALI[SZ]ER|BUS\s*SECTION/.test(t)) return 'coupler';
  if (/MOTOR|\bMOT\b/.test(t)) return 'motor';
  if (/TRANS(FORMER)?\b|TRAFO|\bTR\b/.test(t)) return 'transformer';
  if (/\bCAP(ACITOR)?\b|CAP\s*BANK/.test(t)) return 'capacitor';
  return 'outgoing';
}

export type CurrentSource = 'engineer' | 'busbar' | 'power' | 'name' | 'flc' | 'breaker part';

export const SOURCE_LABEL: Record<CurrentSource, string> = {
  engineer: 'entered', busbar: 'busbar', power: 'from power', name: 'from name', flc: 'TPMS FLC', 'breaker part': 'breaker part',
};

export interface CellCurrent {
  value: number | null;
  source: CurrentSource | null;
  /** How it was worked out, when that is worth saying. */
  note?: string;
  /** Read rather than known — the engineer should look. */
  uncertain: boolean;
}

const num = (v: unknown): number | null => {
  const m = String(v ?? '').replace(',', '.').match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};

/** The service voltage in kV: the scope's, else the one in the template name. */
function serviceKv(item: DeviceLibraryItem, templateName: string): number | null {
  const p = (item.properties ?? {}) as Record<string, unknown>;
  let kv = num(p.serviceVoltage);
  if (kv != null && kv > 100) kv /= 1000;
  if (kv != null && kv > 0) return kv;
  const m = templateName.toUpperCase().match(/(\d+(?:[.,]\d+)?)\s*KV/);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
}

export function cellCurrent(
  item: DeviceLibraryItem, row: DeviceTableRow, role: CellRole,
  breakerPartText = '', override?: number | null,
): CellCurrent {
  if (override != null && override > 0) return { value: override, source: 'engineer', uncertain: false };
  const p = (item.properties ?? {}) as Record<string, unknown>;
  const busbar = num(p.mainBusbarRatedCurrent);
  const flc = num(row.flc);

  if (role === 'incomer' || role === 'coupler') {
    if (busbar) return { value: busbar, source: 'busbar', uncertain: false, note: 'An incomer or coupler carries the busbar current.' };
    if (flc) return { value: flc, source: 'flc', uncertain: true, note: 'No busbar current in the scope specification — TPMS FLC used.' };
    return { value: null, source: null, uncertain: true };
  }
  if (!HAS_BREAKER[role]) return { value: null, source: null, uncertain: false };

  // An outgoing feeder carries its load.
  const kw = num(row.ratingPower);
  const kv = serviceKv(item, row.templateName ?? '');
  if (kw && kv) {
    // Motors: cos φ · η ≈ 0.8; transformers and capacitors: kVA / kvar.
    const factor = role === 'motor' ? 0.8 : 1;
    const value = Math.ceil(kw / (Math.sqrt(3) * kv * factor));
    return {
      value, source: 'power', uncertain: false,
      note: `${kw} ${role === 'motor' ? 'kW' : 'kVA'} at ${kv} kV${role === 'motor' ? ', cos φ·η 0.8' : ''} → ${value} A.`,
    };
  }
  const named = (row.templateName ?? '').toUpperCase().match(/(\d{2,4})\s*A\b/);
  if (named) return { value: +named[1], source: 'name', uncertain: false, note: `The template name says ${named[1]} A.` };
  if (flc) return { value: flc, source: 'flc', uncertain: true, note: 'TPMS FLC — on many projects it is the panel rating, not the load: check it.' };
  const part = breakerPartText.toUpperCase().match(/(\d{3,4})\s*A\b/);
  if (part) return { value: +part[1], source: 'breaker part', uncertain: true };
  return { value: null, source: null, uncertain: true };
}
