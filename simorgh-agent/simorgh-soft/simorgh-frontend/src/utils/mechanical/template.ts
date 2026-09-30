// src/utils/mechanical/template.ts
//
// What a template already says about itself, and the little it does not.
//
// The estimate sheets test a handful of facts about a cell: does it carry a
// breaker, and which one; a VT; a CT; an earth switch; a magnet label. The
// first three are already written down — a template has a column for each of
// them, and a column with no parts under it means the cell has not got one:
//
//   MV   VCB OR VC/FUSE · CT RATING · PT RATING
//   LV   CB ORDER · CONTACTOR. ORDER · CT RATING · PT RATING
//
// So those are read, not asked. Asking again would be asking somebody to
// repeat themselves and then deciding which of the two answers to believe.
//
// What is genuinely not written down anywhere is the earth switch and the
// magnet label, which the office marks with a label on the feeder. Those are
// asked — and once the labelling is standardised they can be read too, at
// which point the question becomes an override rather than an input, which is
// why every derived fact carries an override from the start.

import { TemplateItem, TemplateMechanical } from '../../types/project';

// The shape of the answers lives with the template it is stored on; it is
// re-exported here so that everything reading the sheets can take it from
// the one module that interprets it.
export type { TemplateMechanical };

/** A fact, what it was read from, and whether somebody overruled it. */
export interface Fact<T> {
  value: T;
  /** The column it came from, or why it was not read. */
  from: string;
  overridden: boolean;
}

export interface TemplateFacts {
  hasBreaker: Fact<boolean>;
  breakerType: Fact<string>;
  hasVt: Fact<boolean>;
  hasCt: Fact<boolean>;
  cableEarthSwitch: boolean;
  busEarthSwitch: boolean;
  magnetLabel: string;
}

import { type Tier } from '../tiers';

/** The columns each fact is read from, per tier, most particular first. */
const COLUMNS: Record<Tier, { breaker: string[]; vt: string[]; ct: string[] }> = {
  MV: { breaker: ['VCB OR VC/FUSE'], vt: ['PT RATING'], ct: ['CT RATING', 'COREBALANCE CT'] },
  LV: { breaker: ['CB ORDER'], vt: ['PT RATING'], ct: ['CT RATING', 'COREBALANCE CT'] },
  HV: { breaker: ['BREAKER TYPE'], vt: ['PT RATING'], ct: ['CT RATING'] },
  // GIS cells carry MV's columns (see LAYOUT_OF); OTHER carries LV's.
  GIS: { breaker: ['VCB OR VC/FUSE'], vt: ['PT RATING'], ct: ['CT RATING', 'COREBALANCE CT'] },
  OTHER: { breaker: ['CB ORDER'], vt: ['PT RATING'], ct: ['CT RATING', 'COREBALANCE CT'] },
};

const key = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
const text = (v: unknown) => String(v ?? '').trim();

interface PartLike { partNumber?: unknown; label?: unknown }

/** The parts under one of these columns, and which column they were under. */
function partsUnder(
  template: TemplateItem | undefined, columns: string[],
): { column: string; parts: PartLike[] } | null {
  const props = (template?.properties ?? {}) as Record<string, unknown>;
  const wanted = columns.map(key);
  for (const [name, value] of Object.entries(props)) {
    if (name === '__displayNames' || name === '__locked') continue;
    if (!wanted.includes(key(name))) continue;
    const parts = (value as { parts?: unknown[] })?.parts;
    if (Array.isArray(parts) && parts.length > 0) {
      return { column: name, parts: parts as PartLike[] };
    }
  }
  return null;
}

/**
 * Everything the sheets need from a template: read where it is written,
 * taken from the answers where it is not, and overruled where somebody said so.
 */
export function templateFacts(
  template: TemplateItem | undefined, tier: Tier,
): TemplateFacts {
  const cols = COLUMNS[tier] ?? COLUMNS.MV;
  const mech: TemplateMechanical = template?.mechanical ?? {};

  const breaker = partsUnder(template, cols.breaker);
  const vt = partsUnder(template, cols.vt);
  const ct = partsUnder(template, cols.ct);

  const derived = <T,>(override: T | undefined, value: T, column: string | null, empty: string): Fact<T> =>
    (override !== undefined
      ? { value: override, from: 'set by hand', overridden: true }
      : { value, from: column ? `from ${column}` : empty, overridden: false });

  // The breaker's type is its order number — "3AH5…", "3AE5…" — which is what
  // the sheets' own rules test for.
  const breakerType = breaker
    ? text(breaker.parts[0]?.partNumber) || text(breaker.parts[0]?.label)
    : '';

  return {
    hasBreaker: derived(mech.hasBreaker, !!breaker, breaker?.column ?? null,
      `${cols.breaker[0]} is empty`),
    breakerType: derived(mech.breakerType, breakerType, breaker?.column ?? null,
      `${cols.breaker[0]} is empty`),
    hasVt: derived(mech.hasVt, !!vt, vt?.column ?? null, `${cols.vt[0]} is empty`),
    hasCt: derived(mech.hasCt, !!ct, ct?.column ?? null, `${cols.ct[0]} is empty`),
    cableEarthSwitch: mech.cableEarthSwitch === true,
    busEarthSwitch: mech.busEarthSwitch === true,
    magnetLabel: text(mech.magnetLabel),
  };
}
