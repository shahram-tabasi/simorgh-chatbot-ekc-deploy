// src/utils/templateFamilies.ts
//
// The families a tier's templates fall into, above the path they already carry.
//
// LV templates are filed under a path — S8 / OFW / FCB1 / OUTGOING — and the
// office reads the top of that path as two different things: the SIVACON
// switchgear systems (S8 and 8PT) and the CCS side (OFW, marshaling and the
// rest). This says which is which so the tree can show them apart.
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
  /**
   * The path nodes that put a template in this family. The first node of a
   * path decides; a family listed earlier wins, so `8PT / CCS` is SIVACON —
   * the CCS group of a SIVACON board, not the CCS side of the works.
   */
  nodes: string[];
}

export const TEMPLATE_FAMILIES: Record<'LV' | 'MV' | 'HV', TemplateFamily[]> = {
  LV: [
    { id: 'SIVACON', label: 'SIVACON', note: '8PT and S8', nodes: ['8PT', 'S8'] },
    { id: 'CCS', label: 'CCS', note: 'OFW, marshaling and the rest', nodes: ['OFW', 'MARSHALING', 'OFF', 'SWING', 'CCS'] },
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

/** The templates of a tier, split into families with the rest kept aside. */
export function groupByFamily<T extends { hierarchy?: HasPath }>(
  tier: 'LV' | 'MV' | 'HV',
  templates: T[],
): { family: TemplateFamily | null; templates: T[] }[] {
  const families = TEMPLATE_FAMILIES[tier] ?? [];
  if (families.length === 0) return [{ family: null, templates }];

  const groups = families.map(family => ({
    family: family as TemplateFamily | null,
    templates: templates.filter(t => familyOf(tier, t.hierarchy)?.id === family.id),
  }));
  // Anything the families do not claim is listed on its own rather than lost.
  const rest = templates.filter(t => !familyOf(tier, t.hierarchy));
  if (rest.length > 0) groups.push({ family: null, templates: rest });
  return groups.filter(g => g.templates.length > 0);
}
