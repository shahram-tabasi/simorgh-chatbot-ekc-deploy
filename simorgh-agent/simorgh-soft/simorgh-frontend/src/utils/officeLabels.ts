// src/utils/officeLabels.ts
//
// The office's device labels — the LABEL sheet ("Device"), as a part is given
// one when it is put in a template. What the sheet numbers is numbered, in its
// own range, after the labels the template already uses:
//
//   Q   VCB, ACB, MCCB, MPCB, fuse switch disconnector, MCB (power)
//   QW  the breaker of a withdrawable SIMOPRIME-WORLD cell
//   K   contactor, relay, timer
//   F1  overload (bimetal) · F30… protection relay · F10–F29 other fuses
//   FB  earth-fault relay · FA surge arrester · FL surge limiter
//   B1–B20 CT · B21–B40 VT · B41–B51 core balance
//   P…  ammeter, voltmeter, wattmeter, multimeter (P1, P2 …)
//   AS  ammeter selector · VS voltmeter selector · TF transducer
//   XD… test block · PA… alarm annunciator · PV… voltage indicator
//   PF… signal lamp · QC… earth switch · MB… magnet · M… motor, fan
//   E… heater · C… capacitor · R… resistor · S… push button, selector
//   TA  converter, soft starter · X terminal
//
// The sheet's own rule: a label written with "…" is never used alone — one
// ammeter is P1, not P.

import type { SymbolId } from './iecSymbols';

type Rule = { prefix: string; from?: number; to?: number };

const RULES: Partial<Record<SymbolId, Rule>> = {
  'circuit-breaker': { prefix: 'Q' }, 'withdrawable-cb': { prefix: 'Q' }, mcb: { prefix: 'Q' },
  vcb: { prefix: 'Q' }, 'vcb-racking': { prefix: 'Q' }, 'vacuum-contactor-fuse': { prefix: 'Q' },
  'switch-disconnector': { prefix: 'Q' }, 'switch-fuse': { prefix: 'Q' }, disconnector: { prefix: 'Q' },
  'motor-starter': { prefix: 'Q' }, ats: { prefix: 'Q' },
  contactor: { prefix: 'K' },
  'thermal-overload': { prefix: 'F1' },
  'protection-relay': { prefix: 'F', from: 30, to: 39 },
  fuse: { prefix: 'F', from: 10, to: 29 }, 'hrc-fuse': { prefix: 'F', from: 10, to: 29 },
  'earth-fault-relay': { prefix: 'FB' },
  'surge-arrester': { prefix: 'FA' }, 'surge-limiter': { prefix: 'FL' },
  'current-transformer': { prefix: 'B', from: 1, to: 20 },
  'voltage-transformer': { prefix: 'B', from: 21, to: 40 },
  'core-balance-ct': { prefix: 'B', from: 41, to: 51 },
  ammeter: { prefix: 'P', from: 1 }, voltmeter: { prefix: 'P', from: 1 }, multimeter: { prefix: 'P', from: 1 },
  'watt-meter': { prefix: 'P', from: 1 }, 'var-meter': { prefix: 'P', from: 1 },
  'power-factor-meter': { prefix: 'P', from: 1 }, 'kwh-meter': { prefix: 'P', from: 1 },
  'kvarh-meter': { prefix: 'P', from: 1 }, 'frequency-meter': { prefix: 'P', from: 1 },
  'hour-meter': { prefix: 'PG', from: 1 },
  'ampere-selector': { prefix: 'AS' }, 'voltage-selector': { prefix: 'VS' },
  transducer: { prefix: 'TF' },
  'test-block': { prefix: 'XD', from: 1 },
  'alarm-annunciator': { prefix: 'PA', from: 1 },
  'capacitive-divider': { prefix: 'PV', from: 1 },
  lamp: { prefix: 'PF', from: 1 },
  'earthing-switch': { prefix: 'QC', from: 1 },
  magnet: { prefix: 'MB', from: 1 },
  motor: { prefix: 'M', from: 1 }, heater: { prefix: 'E', from: 1 },
  capacitor: { prefix: 'C', from: 1 }, 'capacitor-delta': { prefix: 'C', from: 1 },
  resistor: { prefix: 'R', from: 1 }, 'selector-switch': { prefix: 'S', from: 1 },
  drive: { prefix: 'TA' }, 'soft-starter': { prefix: 'TA' },
  terminal: { prefix: 'X' },
};

/** Every number a label of this prefix already takes — "B1-3" takes 1, 2, 3. */
function taken(prefix: string, used: string[]): Set<number> {
  const out = new Set<number>();
  const re = new RegExp(`^${prefix}(\\d+)(?:\\s*-\\s*(\\d+))?$`, 'i');
  for (const l of used) {
    const m = re.exec(String(l ?? '').trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = a; n <= Math.max(a, b) && n - a < 50; n++) out.add(n);
  }
  return out;
}

/**
 * The office's label for a device of this kind, numbered after the labels
 * already in the template. Null when the sheet says nothing about the kind —
 * the caller keeps what it did before.
 */
export function officeLabel(
  kind: SymbolId,
  used: string[],
  cell?: { tier?: string; family?: string; cellType?: string },
): string | null {
  const rule = RULES[kind];
  if (!rule) return null;
  // The breaker of a withdrawable SIMOPRIME-WORLD cell is QW.
  if (rule.prefix === 'Q' && cell?.tier === 'MV' && /SIMOPRIME-WORLD/i.test(cell.family ?? '')
    && /truck|withdraw/i.test(cell.cellType ?? '')) return 'QW';
  if (rule.from == null) return rule.prefix;
  const busy = taken(rule.prefix, used);
  for (let n = rule.from; n <= (rule.to ?? rule.from + 98); n++) {
    if (!busy.has(n)) return `${rule.prefix}${n}`;
  }
  return `${rule.prefix}${rule.from}`;
}
