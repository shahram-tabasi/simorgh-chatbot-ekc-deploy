// src/utils/layout/s8Drawers.ts
//
// Which SIVACON S8 drawer a feeder goes in.
//
// The office decides it from the FEEDER ASSEMBLY LIST (s8DrawerTable.ts): every
// drawer that has been built and proven, with the breaker, contactor and
// overload it holds, how much current it carries and whether it is SFD or HFD.
// A feeder goes in the smallest drawer whose row holds its equipment. This is
// that look-up, written down: what the feeder has is read off its template's
// parts, and every row it fits is returned with the reason, smallest first, so
// the engineer sees the choice and not only the answer.
import type { DeviceTableRow, ProjectData } from '../../types/project';
import { TIERS } from '../tiers';
import { partKeys, partDescription } from '../eplanSingleLine';
import { feederCurrent } from '../sion3ae5/fromProject';
import { controlCounts } from '../offerControl';
import { S8_DRAWERS, type S8DrawerRow } from './s8DrawerTable';

/** What a feeder holds, as far as choosing its drawer goes. */
export interface FeederFacts {
  /** "3VA21", "3RV S0" — the breaker's frame. */
  breaker?: string;
  /** The breaker's own order code, as the template has it. */
  breakerCode?: string;
  amps?: number;
  poles?: 3 | 4;
  /** Main contactors: 1 direct, 2 reversing, 3 star-delta or Dahlander. */
  contactors: number;
  /** "S0", "S2", "S6" — the largest contactor's size. */
  contactorSize?: string;
  overload: boolean;
  earthFault: boolean;
  ct: boolean;
  motorised: boolean;
  sfdHfd?: 'SFD' | 'HFD';
  /** Control equipment — the offer's list where the template has one. */
  mcb?: number;
  relay?: number;
}

export interface DrawerChoice {
  row: S8DrawerRow;
  /** Height in modules. */
  modules: number;
  /** Why it fits. */
  why: string[];
  /** What the row does not say it takes — to be checked. */
  check: string[];
}

const up = (v: unknown) => String(v ?? '').toUpperCase();

/** 3RV2 / 3RT2 frame from the digit after the series: 1 S00, 2 S0, 3 S2, 4 S3. */
const S_OF: Record<string, string> = { '1': 'S00', '2': 'S0', '3': 'S2', '4': 'S3' };
/** 3RT1 large contactors: 3RT1 05x S6, 06x S10, 07x S12. */
const S_BIG: Record<string, string> = { '5': 'S6', '6': 'S10', '7': 'S12' };
const S_ORDER = ['S00', 'S0', 'S2', 'S3', 'S6', 'S10', 'S12'];

/** The frame an order code is — "3VA2116-…" is 3VA21, "3RV2021-…" is 3RV S0. */
export function frameOf(code: string): string | undefined {
  const c = up(code).replace(/\s/g, '');
  const va = c.match(/3VA(\d)(\d)/);
  if (va) return `3VA${va[1]}${va[2]}`;
  const rv = c.match(/3RV\d\d(\d)/);
  if (rv && S_OF[rv[1]]) return `3RV ${S_OF[rv[1]]}`;
  return undefined;
}

/** A contactor's size from its order code. */
export function contactorSizeOf(code: string): string | undefined {
  const c = up(code).replace(/\s/g, '');
  const big = c.match(/3RT10([567])/);
  if (big) return S_BIG[big[1]];
  const m = c.match(/3RT2\d(\d)/);
  return m ? S_OF[m[1]] : undefined;
}

/** 3VA poles: the fourth character after the dash — 3VA2116-6JQ32 is 3P. */
export function polesOf(code: string): 3 | 4 | undefined {
  const m = up(code).replace(/\s/g, '').match(/3VA\d{4}-\w{3}(\d)/);
  return m ? (m[1] === '4' ? 4 : m[1] === '3' ? 3 : undefined) : undefined;
}

// ── What each row of the list holds ───────────────────────────────────────

interface RowFacts {
  frames: Set<string>;
  amps?: number;
  poles: Set<3 | 4>;
  contactors: number;
  contactorSize?: string;
  overload: boolean;
  motorised: boolean;
  sfdHfd: Set<'SFD' | 'HFD'>;
  earthFault: boolean;
  ct: boolean;
  /** The most control equipment the drawer takes ("MCB 2P: 1 / FINDER90.23 : 2"). */
  mcb?: number;
  relay?: number;
}

const countOf = (text: string, re: RegExp) => {
  const all = [...text.matchAll(re)].map(m => Number(m[1]));
  return all.length ? all.reduce((a, b) => a + b, 0) : undefined;
};

function readRow(r: S8DrawerRow): RowFacts {
  const short = up(r.shortCode);
  const frames = new Set<string>();
  // "3VA10,11", "3VA20,21,22", "3VA10&11", "3VA,21,22", "3VA12,20,21,22".
  for (const m of short.matchAll(/3VA[\s,]*(\d{2}(?:\s*[,&]\s*\d{2})*)/g)) {
    for (const n of m[1].split(/[,&]/)) frames.add(`3VA${n.trim()}`);
  }
  for (const m of short.matchAll(/\bS(00|0|2|3)\b/g)) frames.add(`3RV S${m[1]}`);
  for (const code of up(r.mccb).split(/[\s/]+/)) {
    const f = frameOf(code);
    if (f) frames.add(f);
  }

  // The current: the largest figure in the short code once the frames and the
  // poles are taken out of it, else the DESCRIPTION's "حداکثر جریان 50A".
  const bare = short
    .replace(/3VA[\s,]*\d{2}(?:\s*[,&]\s*\d{2})*/g, ' ')
    .replace(/\b\d{1,2}M\b/g, ' ')
    .replace(/\b[34]P\b/g, ' ');
  const figures = [...bare.matchAll(/(\d{2,4})/g)].map(m => Number(m[1])).filter(n => n >= 10);
  const noted = r.note.match(/(?:حداکثر جریان|تا رنج|تا جریان)\s*(\d{2,4})/);
  const amps = figures.length ? Math.max(...figures) : noted ? Number(noted[1]) : undefined;

  const poles = new Set<3 | 4>();
  if (/3P\+N|4P/.test(short) || /3P\+N/.test(up(r.note))) poles.add(4);
  if (/3P(?!\+)/.test(short) || poles.size === 0) poles.add(3);

  let contactors = 0;
  let contactorSize: string | undefined;
  for (const m of up(r.contactor).matchAll(/(?:(\d)\s*\*\s*)?(3RT\w+)/g)) {
    contactors += Number(m[1] ?? 1);
    const s = contactorSizeOf(m[2]);
    if (s && (!contactorSize || S_ORDER.indexOf(s) > S_ORDER.indexOf(contactorSize))) contactorSize = s;
  }

  const sfdHfd = new Set<'SFD' | 'HFD'>();
  if (/SFD/.test(up(r.sfdHfd))) sfdHfd.add('SFD');
  if (/HFD/.test(up(r.sfdHfd))) sfdHfd.add('HFD');

  return {
    frames, amps, poles, contactors, contactorSize,
    overload: Boolean(r.overload.trim()),
    motorised: /موتور\s*دار/.test(r.note),
    sfdHfd,
    earthFault: Boolean(r.earthFault.trim()),
    ct: Boolean(r.ct.trim()),
    mcb: countOf(up(r.control), /M\.?C\.?B[^:]*:\s*(\d+)/g),
    relay: countOf(up(r.control), /FINDER[^:]*:\s*(\d+)/g),
  };
}

const ROWS = S8_DRAWERS.map(row => ({ row, facts: readRow(row), modules: parseInt(row.size, 10) || 0 }));

/**
 * Every drawer the feeder fits, smallest first.
 *
 * Hard rules: the breaker frame, the current, the poles, the number of main
 * contactors and SFD/HFD must agree. Earth fault, CT and the overload only
 * lower a row in the list — the sheet lists what a drawer was proven with,
 * not everything it can hold — and are reported to be checked.
 */
export function drawersFor(f: FeederFacts): DrawerChoice[] {
  const out: (DrawerChoice & { score: number })[] = [];
  for (const { row, facts, modules } of ROWS) {
    if (!modules) continue;
    const why: string[] = [];
    const check: string[] = [];
    if (f.breaker) {
      if (!facts.frames.has(f.breaker)) continue;
      why.push(f.breaker);
    }
    if (f.amps != null && facts.amps != null) {
      if (f.amps > facts.amps) continue;
      why.push(`${f.amps} A ≤ ${facts.amps} A`);
    }
    if (f.poles) {
      if (!facts.poles.has(f.poles)) continue;
      why.push(`${f.poles}P`);
    }
    if (f.contactors !== facts.contactors) continue;
    if (f.contactors) {
      if (f.contactorSize && facts.contactorSize
        && S_ORDER.indexOf(f.contactorSize) > S_ORDER.indexOf(facts.contactorSize)) continue;
      why.push(f.contactors === 1 ? 'one contactor' : `${f.contactors} contactors`);
    }
    if (f.sfdHfd && facts.sfdHfd.size) {
      if (!facts.sfdHfd.has(f.sfdHfd)) continue;
      why.push(f.sfdHfd);
    }
    // The row is "حداکثر تجهیزات فرمان" — the most control equipment it takes.
    if (f.mcb && facts.mcb != null && f.mcb > facts.mcb) continue;
    if (f.relay && facts.relay != null && f.relay > facts.relay) continue;
    if (f.mcb || f.relay) why.push(`control ${f.mcb ?? 0} MCB / ${f.relay ?? 0} relay`);
    if (f.motorised !== facts.motorised) {
      if (f.motorised) continue;
      check.push('the drawer is for a motorised breaker');
    }
    let score = 0;
    if (f.earthFault && !facts.earthFault) { check.push('earth fault / core balance not in this drawer’s list'); score--; }
    if (f.ct && !facts.ct) { check.push('CT not in this drawer’s list'); score--; }
    if (f.overload && !facts.overload && f.contactors) { check.push('overload relay not in this drawer’s list'); score--; }
    out.push({ row, modules, why, check, score });
  }
  const sorted = out
    .sort((a, b) => a.modules - b.modules || b.score - a.score)
    .map(({ score: _score, ...rest }) => rest);
  // More control equipment than any such drawer was proven with: still the
  // drawer for the power side, with the excess to be checked.
  if (!sorted.length && (f.mcb || f.relay)) {
    return drawersFor({ ...f, mcb: undefined, relay: undefined }).map(c => ({
      ...c, check: [...c.check, `${f.mcb ?? 0} MCB / ${f.relay ?? 0} relay is more control equipment than this drawer’s list`],
    }));
  }
  return sorted;
}

// ── What a feeder holds, read off the project ────────────────────────────

/** Every part of a feeder: its template's, then any picked on the line. */
function partsOf(data: ProjectData, row: DeviceTableRow): { slot: string; part: any }[] {
  const template = TIERS.flatMap(t => data.templates?.[t] ?? []).find(t => t.id === row.templateId);
  const props = (template?.properties ?? {}) as Record<string, any>;
  const fromTemplate = Object.entries(props).flatMap(([slot, v]) =>
    (Array.isArray(v?.parts) ? v.parts : []).map((part: any) => ({ slot, part })));
  const picked = (row.selectedParts ?? []).map(e => ({ slot: e.propertyName, part: e.part }));
  return [...fromTemplate, ...picked];
}

const codeOf = (part: any) => partKeys(part).find(k => /^3(VA|RV|RT|RU|RB|UF|VL|WL)/i.test(k)) ?? partKeys(part)[0] ?? '';

export function feederFacts(data: ProjectData, row: DeviceTableRow): FeederFacts {
  const facts: FeederFacts = { contactors: 0, overload: false, earthFault: false, ct: false, motorised: false };
  for (const { slot, part } of partsOf(data, row)) {
    const code = up(codeOf(part));
    const text = `${slot} ${part?.label ?? ''} ${partDescription(part)}`;
    const qty = Math.max(1, Number(part?.quantity) || 1);
    const frame = frameOf(code);
    if (/^3W[LTA]/.test(code) && !facts.breaker) {
      // An air circuit breaker: not a drawer, a section of its own.
      facts.breaker = 'ACB';
      facts.breakerCode = code;
    } else if (frame && !facts.breaker) {
      facts.breaker = frame;
      facts.breakerCode = code;
      facts.poles = polesOf(code) ?? (part?.sld?.poles === '4P' || part?.sld?.poles === '3P+N' ? 4 : undefined);
    } else if (/^3RT/.test(code)) {
      facts.contactors += qty;
      const s = contactorSizeOf(code);
      if (s && (!facts.contactorSize || S_ORDER.indexOf(s) > S_ORDER.indexOf(facts.contactorSize))) facts.contactorSize = s;
    } else if (/^3(RU|RB|UF)/.test(code) || /OVER ?LOAD/i.test(slot)) {
      facts.overload = true;
    }
    if (/EARTH FAULT|COREBALANCE|core.?balance|earth.?fault/i.test(text)) facts.earthFault = true;
    if (/^CT RATING$/i.test(slot.trim()) || /current.?transformer/i.test(text)) facts.ct = true;
    if (/motor.?operat|3VA9[2-4]67-0HA/i.test(`${text} ${code}`)) facts.motorised = true;
  }
  const template = TIERS.flatMap(t => data.templates?.[t] ?? []).find(t => t.id === row.templateId);
  const control = controlCounts(template);
  if (control.mcb) facts.mcb = control.mcb;
  if (control.relay) facts.relay = control.relay;
  const amps = feederCurrent(data, row);
  if (amps != null) facts.amps = Math.round(amps);
  const sh = up(row.sfdHfd);
  if (sh === 'SFD' || sh === 'HFD') facts.sfdHfd = sh;
  return facts;
}

/** The drawer for a feeder: the size the line already states, else the list's choice. */
export function drawerOfFeeder(data: ProjectData, row: DeviceTableRow): {
  modules: number | null; from: 'line' | 'list' | 'none'; choices: DrawerChoice[]; facts: FeederFacts;
} {
  const facts = feederFacts(data, row);
  const choices = drawersFor(facts);
  const stated = parseInt(String(row.size ?? ''), 10);
  if (Number.isFinite(stated) && stated > 0) return { modules: stated, from: 'line', choices, facts };
  if (choices.length) return { modules: choices[0].modules, from: 'list', choices, facts };
  return { modules: null, from: 'none', choices, facts };
}
