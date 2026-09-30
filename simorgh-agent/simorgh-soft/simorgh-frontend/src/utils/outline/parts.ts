// src/utils/outline/parts.ts
//
// The parts on a feeder, read the way Eplanix reads them.
//
// Eplanix asks the same handful of questions of `View_draft_equipment`, one
// query each: which part is the breaker, what its maker's code is, whether
// there is an earth switch, what the CT's ratio says, which Ronis labels are
// on the cell. Every one of those is a filter on four fields — the equipment
// label, and the secondary, engineering and short designations.
//
// A part in this app carries all four. The TPMS import writes them:
//
//   TPMS Label   → part.label                  (Q, QW, K, MB3, QC1, F01 …)
//   TPMS SecDes  → fullData.Designation1       ("MV CURRENT TRANSFORMER" …)
//   TPMS EngDes  → fullData.Designation2
//   TPMS ShrDes  → fullData.Designation3       ("1600-3200/1A" …)
//   TPMS Scode   → fullData.__tpms.scode       the maker's order code
//
// so the questions can be asked here of the same values, rather than of
// something that stands in for them. A part added by hand from the EPLAN parts
// database has no Scode; there its order number is the maker's code, which is
// what an MLFB is.

import { TemplateItem } from '../../types/project';
import { stripLocaleTags } from '../tierEquipmentMatrix';

/** One equipment on a feeder, in the four fields the queries read. */
export interface PartFact {
  /** The equipment label: Q, QW, K, MB3, QC1, F01. Upper-cased. */
  label: string;
  /** The maker's code — TPMS's Scode, else the part's order number. */
  scode: string;
  /** Secondary designation: what kind of thing it is. */
  secDes: string;
  /** Engineering designation. */
  engDes: string;
  /** Short designation — where a CT's ratio is written. */
  shrDes: string;
  /** Which template column it sits under. */
  property: string;
}

const text = (v: unknown) => stripLocaleTags(v == null ? '' : String(v)).trim();

/** Every part on a template, flattened, with the fields the outline reads. */
export function partFacts(template: TemplateItem | undefined): PartFact[] {
  const props = (template?.properties ?? {}) as Record<string, any>;
  const out: PartFact[] = [];
  for (const [property, value] of Object.entries(props)) {
    if (property === '__displayNames' || property === '__locked') continue;
    const parts = value?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const d = part?.fullData ?? {};
      out.push({
        label: text(part?.label).toUpperCase(),
        // The maker's code first, then the order number, which is the same
        // thing for a part that came from the parts database rather than TPMS.
        scode: text(d?.__tpms?.scode) || text(d?.OrderNumber) || text(part?.partNumber),
        secDes: text(d?.Designation1),
        engDes: text(d?.Designation2),
        shrDes: text(d?.Designation3),
        property,
      });
    }
  }
  return out;
}

/** The labels Eplanix reads as the breaker's: `Q`, `QW`, `K`. */
const BREAKER_LABELS = ['Q', 'QW', 'K'];

/** The part that is the cell's breaker, if it has one. */
export const breakerPart = (parts: PartFact[]): PartFact | undefined =>
  parts.find(p => BREAKER_LABELS.includes(p.label));

/**
 * The breaker's type: the first four characters of its order code.
 *
 * "3AE5124-1" is a 3AE5, "3TM…" is a 3TM — three characters, because that is
 * the whole of that family's name. "N/A" when the cell has no breaker, which
 * is the value every rule downstream tests for.
 */
export function breakerType(parts: PartFact[]): string {
  const code = breakerPart(parts)?.scode ?? '';
  if (!code) return 'N/A';
  const upper = code.toUpperCase();
  return upper.includes('3TM') ? code.slice(0, 3) : code.slice(0, 4);
}

/** The breaker's own label — `Q`, `QW` or `K` — or "N/A". */
export const breakerLabel = (parts: PartFact[]): string =>
  breakerPart(parts)?.label || 'N/A';

/** MB3 or MB4, the magnet label, or "N/A". */
export const magnetLabel = (parts: PartFact[]): string =>
  parts.find(p => p.label === 'MB3' || p.label === 'MB4')?.label || 'N/A';

/**
 * The feeder's rated current, as its CT states it.
 *
 * A current transformer's short designation is its ratio — "1600-3200/1A",
 * "800/1A", "2000-4000/5". The primary side is what the cell carries, and
 * where it is a range it is the top of the range. Null when there is no CT or
 * its designation says nothing.
 */
export function feederCurrentByCt(parts: PartFact[]): number | null {
  const ct = parts.find(p => p.secDes.toUpperCase().includes('MV CURRENT TRANSFORMER'));
  if (!ct || !ct.shrDes.trim()) return null;
  const m = /(\d+)(?:-(\d+))?\s*\/\s*[1-5A]/i.exec(ct.shrDes);
  if (!m) return null;
  return Number(m[2] ?? m[1]);
}

// Both of these read the secondary designation, which is a category rather
// than a name — the same test the original makes. Case is ignored because the
// original's is a database comparison, and the collation it runs under ignores
// it too; matching case here would answer "no" to rows Eplanix answers "yes" to.
const hasSecDes = (parts: PartFact[], needle: string): boolean =>
  parts.some(p => p.secDes.toUpperCase().includes(needle.toUpperCase()));

/** The cell carries an earthing switch. */
export const hasEarthSwitch = (parts: PartFact[]): boolean => hasSecDes(parts, 'EARTH SWITCH');

/** The cell carries a damping resistor. */
export const hasDampingResistor = (parts: PartFact[]): boolean => hasSecDes(parts, 'RESISTOR');

/** "YES" when the cell carries a voltage transformer, else "NO". */
export const ptStatus = (parts: PartFact[]): string =>
  (hasSecDes(parts, 'MV Potential Transformer') ? 'YES' : 'NO');

/** The labels the Ronis interlock rules are written against. */
const RONIS_LABELS = ['IEC', 'IEO', 'IQT', 'IQS', 'IEB', 'ICO', 'QC1', 'QC2'];

export const ronisLabels = (parts: PartFact[]): string[] =>
  parts.filter(p => RONIS_LABELS.includes(p.label)).map(p => p.label);

/** Every equipment label on the feeder, once each. */
export const equipmentLabels = (parts: PartFact[]): string[] =>
  [...new Set(parts.map(p => p.label).filter(Boolean))];

/** Which interlocks the labels say the cell has. */
export function determineRonis(labels: string[]): {
  leo: boolean; lec: boolean; lq: boolean;
  ico: boolean; ieb: boolean; qc1: boolean; qc2: boolean;
} {
  const has = (...wanted: string[]) =>
    labels.some(l => wanted.includes(String(l ?? '').toUpperCase()));
  return {
    leo: has('IEO'),
    lec: has('IEC'),
    lq: has('IQT', 'IQS'),
    ico: has('ICO'),
    ieb: has('IEB'),
    qc1: has('QC1'),
    qc2: has('QC2'),
  };
}
