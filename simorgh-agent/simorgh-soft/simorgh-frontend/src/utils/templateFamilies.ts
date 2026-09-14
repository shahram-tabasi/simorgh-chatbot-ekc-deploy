// src/utils/templateFamilies.ts
//
// The families a tier's templates fall into, above the path they already carry.
//
// LV templates are filed under a path — S8 / FCB1 / OUTGOING — and the office
// reads the top of that path as two different things: OFW (SFD, HFD, the FCB
// switches, MODULLAR, FCB-CAP) and FIX (CCS, OFF, Marshaling, Swing). This
// says which is which so the tree can show them apart.
//
// Both families now start with a root (S8 or 8PT), so that alone can't tell
// them apart — familyOf()'s own fallback (matching ANY node in the path, not
// just the first) is what actually does the work here: neither family lists
// S8/8PT, so the head-node check always falls through to it.
//
// It is worked out from the path a template already has; nothing is written and
// no existing template moves. A template whose path matches no family is not
// hidden — it simply shows where it always did.
// Only the path is needed to place a template, so that is all this asks for.
// Several screens carry their own narrower idea of a hierarchy; none of them
// has to be widened to be filed.
interface HasPath { path?: string[] }

export interface TemplateFamily {
  id: string;
  label: string;
  /** What the office calls it, for the line under the label. */
  note: string;
  /** The path nodes that put a template in this family — see the note above
   *  on why neither list includes S8/8PT. */
  nodes: string[];
}

export const TEMPLATE_FAMILIES: Record<'LV' | 'MV' | 'HV', TemplateFamily[]> = {
  LV: [
    { id: 'OFW', label: 'OFW', note: 'SFD, HFD, FCB1-3, MODULLAR, FCB-CAP', nodes: ['SFD', 'HFD', 'FCB1', 'FCB2', 'FCB3', 'MODULLAR', 'FCB-CAP'] },
    { id: 'FIX', label: 'FIX', note: 'CCS, OFF, Marshaling, Swing', nodes: ['CCS', 'OFF', 'MARSHALING', 'SWING'] },
  ],
  // MV and HV have no families yet. An empty list is not a special case
  // anywhere — those tiers simply list their templates the way they always
  // have, and adding families later is adding rows here.
  MV: [],
  HV: [],
};

/** Which family a template's path puts it in, or null when none does. */
export function familyOf(
  tier: 'LV' | 'MV' | 'HV',
  hierarchy?: HasPath,
): TemplateFamily | null {
  const families = TEMPLATE_FAMILIES[tier] ?? [];
  const path = hierarchy?.path ?? [];
  if (families.length === 0 || path.length === 0) return null;

  const head = String(path[0] ?? '').toUpperCase();
  const byHead = families.find(f => f.nodes.includes(head));
  if (byHead) return byHead;

  // A path that starts somewhere unexpected still belongs somewhere if one of
  // its nodes names a family.
  const rest = path.map(node => String(node ?? '').toUpperCase());
  return families.find(f => rest.some(node => f.nodes.includes(node))) ?? null;
}

/**
 * The templates of a tier, split into its families.
 *
 * Every family is returned whether or not it holds anything. A section is a
 * place, not a summary of what is in it: it is where a template is made, and a
 * section that disappeared when it was empty would leave nowhere to make the
 * first one.
 *
 * Anything the families do not claim comes back last, under no family, and
 * only when there is something — that one is a leftover rather than a place.
 */
export function groupByFamily<T extends { hierarchy?: HasPath }>(
  tier: 'LV' | 'MV' | 'HV',
  templates: T[],
): { family: TemplateFamily | null; templates: T[] }[] {
  const families = TEMPLATE_FAMILIES[tier] ?? [];
  if (families.length === 0) return [{ family: null, templates }];

  const groups: { family: TemplateFamily | null; templates: T[] }[] = families.map(family => ({
    family,
    templates: templates.filter(t => familyOf(tier, t.hierarchy)?.id === family.id),
  }));
  const rest = templates.filter(t => !familyOf(tier, t.hierarchy));
  if (rest.length > 0) groups.push({ family: null, templates: rest });
  return groups;
}

/** True when this tier is split into sections at all. */
export const hasFamilies = (tier: 'LV' | 'MV' | 'HV'): boolean =>
  (TEMPLATE_FAMILIES[tier] ?? []).length > 0;
