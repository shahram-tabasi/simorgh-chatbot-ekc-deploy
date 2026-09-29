// src/utils/projectMerge.ts
//
// Two people's saves of one project, put together.
//
// The project is one document, and every save used to be all or nothing: the
// second person to save was told the project "was changed on another
// computer" and had to throw one of the two versions away — even when one had
// been filling in a switchgear and the other building a template, and nothing
// either of them did touched the other's work.
//
// This is a three-way merge at the grain people actually work at. `base` is
// the version this copy started from, `mine` is this copy now, `theirs` is
// what the database holds. For every switchgear, template, library entry and
// device row (matched by id), and for every other field of the project:
//
//   changed only here    → mine
//   changed only there   → theirs
//   changed on both, alike → either
//   changed on both, differently → a clash
//
// Locks (see projectLocks) keep two people off the same switchgear or
// template, so a clash is rare; when one happens the caller asks, exactly as
// it always did.

import type { ProjectData } from '../types/project';

/** Bookkeeping that differs between copies without the content differing. */
const META = new Set(['_id', 'rev', 'changedOn', 'projectNameKey', 'baseRev']);

const same = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const hasIds = (v: unknown): v is { id: string }[] =>
  Array.isArray(v) && v.every(x => isRecord(x) && typeof x.id === 'string');

/** Lists merged item by item; these hold one list per tier. */
const PER_TIER = new Set(['templates', 'deviceLibrary']);

export interface MergeResult {
  merged: ProjectData;
  /** What was changed on both sides, differently — for the person to decide. */
  clashes: string[];
}

function mergeList<T extends { id: string }>(
  base: T[], mine: T[], theirs: T[], where: string, clashes: string[],
): T[] {
  const b = new Map(base.map(x => [x.id, x]));
  const m = new Map(mine.map(x => [x.id, x]));
  const t = new Map(theirs.map(x => [x.id, x]));

  const pick = (id: string): T | undefined => {
    const bi = b.get(id), mi = m.get(id), ti = t.get(id);
    if (same(bi, mi)) return ti;          // untouched here: theirs, even gone
    if (same(bi, ti)) return mi;          // untouched there: mine, even gone
    if (same(mi, ti)) return mi;
    const label = (mi ?? ti) as { name?: string; deviceName?: string } | undefined;
    clashes.push(`${where}: ${label?.name ?? label?.deviceName ?? id}`);
    return mi ?? ti;
  };

  // Their order, with what was added here after it in the order it was added.
  const out: T[] = [];
  for (const x of theirs) {
    const kept = pick(x.id);
    if (kept) out.push(kept);
  }
  for (const x of mine) {
    if (t.has(x.id)) continue;
    const kept = pick(x.id);
    if (kept) out.push(kept);
  }
  return out;
}

function mergeValue(
  key: string, base: unknown, mine: unknown, theirs: unknown, clashes: string[],
): unknown {
  if (same(base, mine)) return theirs;
  if (same(base, theirs)) return mine;
  if (same(mine, theirs)) return mine;

  // Both sides changed it. For a list of things with ids, that is usually two
  // people changing *different* things in it, which is no clash at all.
  const list = (v: unknown) => (v === undefined ? [] : v);
  if (hasIds(list(base)) && hasIds(list(mine)) && hasIds(list(theirs))) {
    return mergeList(list(base) as { id: string }[], list(mine) as { id: string }[],
      list(theirs) as { id: string }[], key, clashes);
  }
  if (PER_TIER.has(key) && (isRecord(mine) || isRecord(theirs))) {
    const b = isRecord(base) ? base : {};
    const m = isRecord(mine) ? mine : {};
    const t = isRecord(theirs) ? theirs : {};
    const out: Record<string, unknown> = {};
    for (const tier of new Set([...Object.keys(t), ...Object.keys(m)])) {
      out[tier] = mergeValue(`${key} ${tier}`, b[tier], m[tier], t[tier], clashes);
    }
    return out;
  }
  clashes.push(key);
  return mine;
}

/** Merge `mine` and `theirs`, both descended from `base`. */
export function mergeProjects(base: ProjectData, mine: ProjectData, theirs: ProjectData): MergeResult {
  const clashes: string[] = [];
  const b = base as unknown as Record<string, unknown>;
  const m = mine as unknown as Record<string, unknown>;
  const t = theirs as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(t), ...Object.keys(m)])) {
    if (META.has(key)) {
      out[key] = key in t ? t[key] : m[key];
      continue;
    }
    const value = mergeValue(key, b[key], m[key], t[key], clashes);
    if (value !== undefined) out[key] = value;
  }
  return { merged: out as unknown as ProjectData, clashes };
}

/** The content of a project, without the bookkeeping — for "has anything changed?". */
export function contentKey(project: ProjectData): string {
  // Only the project's own bookkeeping: a row or a revision further down may
  // well have a field called `rev` that is content.
  return JSON.stringify(project, function (this: unknown, key: string, value: unknown) {
    return this === project && META.has(key) ? undefined : value;
  });
}
