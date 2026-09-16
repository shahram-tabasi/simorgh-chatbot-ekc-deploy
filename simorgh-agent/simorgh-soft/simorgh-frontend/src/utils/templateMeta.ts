// src/utils/templateMeta.ts
//
// The one line that says what a template is.
//
// A template's name is whatever somebody typed — "22kW MOTOR", "COPY OF
// FCB1", "TEST2". What it actually is lives in the hierarchy underneath it:
// the path it was filed at, the kind of equipment it is for, the power and
// the current it was sized against. That line was on the tree and nowhere
// else, so every other list of templates — and there are four — asked people
// to pick between names that do not distinguish themselves.
//
// Kept to one short line on purpose: it sits under a name in a list, not in
// a properties panel, and a line that wraps is worse than no line at all.

import { foldedPath } from './templateFamilies';

/**
 * Anything with a hierarchy.
 *
 * Several screens carry their own narrower idea of a template, so this asks
 * for the one field it reads and nothing else — and spells it loosely, since
 * those screens type the leaf kind as a plain string.
 */
export interface HasHierarchy {
  hierarchy?: {
    path?: readonly string[];
    leafKind?: string;
    params?: { kw?: string; currentA?: string };
  };
}

/**
 * What a template is, in one line: `S8 / MOTOR · motor · 22 kW · 44 A`.
 *
 * Empty when the template has no hierarchy at all, which is what a template
 * made before the wizard existed looks like — the caller shows nothing rather
 * than an empty bullet.
 */
export function templateMeta(template: HasHierarchy | undefined): string {
  const h = template?.hierarchy;
  if (!h) return '';
  const parts: string[] = [];
  const path = foldedPath(h.path);
  if (path.length > 0) parts.push(path.join(' / '));
  if (h.leafKind) parts.push(String(h.leafKind));
  if (h.params?.kw) parts.push(`${h.params.kw} kW`);
  if (h.params?.currentA) parts.push(`${h.params.currentA} A`);
  return parts.join(' · ');
}
