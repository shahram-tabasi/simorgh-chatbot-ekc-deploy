// src/utils/cad/pages.ts
//
// The pages of a project, as a set somebody keeps rather than a sheet that
// happens to be open.
//
// Until now a drawing in this app was either generated from the project — the
// single line, the layout — or it was "the blank sheet", singular, with nowhere
// to put a second one. That is enough for a switchgear set, where the pages are
// a consequence of the feeder list; it is not enough for a control panel, where
// the pages *are* the work and somebody adds one because the circuit ran off
// the bottom of the last.
//
// A page has a type, and there are three of them, because the drawing set has
// three and no more:
//
//   WD   wiring diagram — every conductor, the multi-line set
//   SLD  single line    — one line for the whole circuit
//   OLD  layout         — the panel to scale
//
// The type is not decoration. It picks the symbol library (a coil offered on a
// layout page is the wrong answer), and it picks the paper the page starts at.
// It is the same three codes as the symbol libraries, and deliberately the same
// union, so the two can never drift apart.
//
// Where the geometry lives: in the project's existing sheet-edit store, under
// the key this module gives out. A page is a document whose whole content is
// its shapes, and that store already keeps exactly that, already saves, already
// travels in the project file and the history. A second store would be a second
// thing to back up and a second thing to lose.

import { LibraryKind, libraryOf } from './symbolLibraries';

/** A page is one of the three kinds of document the office issues. */
export type PageType = LibraryKind;

export interface DrawingPage {
  /** Stable for the life of the page — the edits are keyed on it. */
  id: string;
  /**
   * The groups this page sits under, outermost first.
   *
   * `['SLD', 'Main board']` puts it two levels down; an empty path puts it
   * straight under the project. Names and not ids, because a group here is a
   * heading somebody typed rather than a thing with a life of its own — a
   * group is renamed by renaming it on every page under it, which is what the
   * tree does, and it disappears when the last page leaves it unless somebody
   * made it deliberately (see `DrawingGroups`).
   */
  path?: string[];
  /** What the page tree shows. Free text: the office's own numbering. */
  name: string;
  /** The line under the name — what the page is for. */
  description?: string;
  type: PageType;
  /** Sheet size in millimetres. */
  width: number;
  height: number;
  createdAt: string;
}

/**
 * Groups made but not yet filled.
 *
 * A group exists because pages are in it — except for the one somebody has
 * just made and not put anything in, which would otherwise vanish between
 * being created and being used. Those are kept here, as paths, and drop out of
 * the list the moment a page joins them.
 */
export type DrawingGroups = string[][];

/** Where a page's shapes are kept in `projectData.drawingEdits`. */
export const pageKey = (id: string): string => `page#${id}`;

/** True for an edit key belonging to a page rather than a generated sheet. */
export const isPageKey = (key: string): boolean => key.startsWith('page#');

/**
 * The paper a page of this type starts on, in millimetres.
 *
 * A3 landscape for the schematic types: it is what the office issues, and a
 * wiring diagram at A4 fits about four paths, which is not a page, it is a
 * fragment. A layout starts at A2 because a panel drawn to scale needs the
 * room — 2000 mm of cubicle at 1:10 is 200 mm of paper before any dimension
 * is written beside it.
 */
export function defaultSize(type: PageType): { width: number; height: number } {
  return type === 'old' ? { width: 594, height: 420 } : { width: 420, height: 297 };
}

let counter = 0;

/** An id that is unique within a session and readable in a saved file. */
function newId(): string {
  counter += 1;
  return `p${Date.now().toString(36)}${counter.toString(36)}`;
}

/**
 * The next free name for a page of this type — `WD 3` after `WD 1` and `WD 2`.
 *
 * Numbered per type rather than across the set, because the three types are
 * three documents that happen to live in one project: a wiring diagram is
 * sheet 4 of the wiring diagrams whatever else was drawn in between.
 */
export function nextName(pages: DrawingPage[], type: PageType): string {
  const code = libraryOf(type).code;
  const used = new Set<number>();
  const pattern = new RegExp(`^${code}\\s*(\\d+)$`, 'i');
  for (const p of pages) {
    const m = pattern.exec(p.name.trim());
    if (m) used.add(Number(m[1]));
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return `${code} ${n}`;
}

/** A new, empty page of this type, named after the ones already there. */
export function newPage(
  pages: DrawingPage[], type: PageType, description = '', path: string[] = [],
): DrawingPage {
  return {
    id: newId(),
    path,
    name: nextName(pages, type),
    description,
    type,
    ...defaultSize(type),
    createdAt: new Date().toISOString(),
  };
}

/**
 * A copy of `page`, named clear of everything already in the set.
 *
 * The caller copies the shapes across under the new id — this only settles
 * identity and naming, which is the part that has to be got right in one place.
 */
export function copyOfPage(pages: DrawingPage[], page: DrawingPage): DrawingPage {
  return {
    ...page,
    id: newId(),
    name: nextName(pages, page.type),
    createdAt: new Date().toISOString(),
  };
}

/** The set with `page` moved `by` places, clamped to the ends. */
export function movePage(pages: DrawingPage[], id: string, by: number): DrawingPage[] {
  const from = pages.findIndex(p => p.id === id);
  if (from < 0) return pages;
  const to = Math.max(0, Math.min(pages.length - 1, from + by));
  if (to === from) return pages;
  const next = [...pages];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * The pages in the order they are issued: by type, then as the user arranged
 * them.
 *
 * Grouping by type is not a sort the user can lose — it is how the set is
 * bound. Within a type the order is theirs, which is why `movePage` works on
 * the stored array and this only groups.
 */
const TYPE_ORDER: PageType[] = ['sld', 'wd', 'old'];

export function inIssueOrder(pages: DrawingPage[]): DrawingPage[] {
  return TYPE_ORDER.flatMap(type => pages.filter(p => p.type === type));
}

/** Anything stored on the project read back as a page set. */
export function readPages(v: unknown): DrawingPage[] {
  if (!Array.isArray(v)) return [];
  const out: DrawingPage[] = [];
  for (const raw of v) {
    const p = raw as Partial<DrawingPage>;
    if (!p || typeof p.id !== 'string' || !p.id) continue;
    const type: PageType = p.type === 'wd' || p.type === 'old' ? p.type : 'sld';
    const size = defaultSize(type);
    out.push({
      id: p.id,
      path: Array.isArray(p.path)
        ? p.path.map(n => String(n ?? '').trim()).filter(Boolean).slice(0, 8)
        : [],
      name: String(p.name ?? '').trim() || nextName(out, type),
      description: typeof p.description === 'string' ? p.description : '',
      type,
      width: Number.isFinite(p.width) ? Number(p.width) : size.width,
      height: Number.isFinite(p.height) ? Number(p.height) : size.height,
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
    });
  }
  return out;
}

// ── The tree ───────────────────────────────────────────────────────────────

export type PageNode =
  | { kind: 'group'; name: string; path: string[]; children: PageNode[]; pages: number }
  | { kind: 'page'; page: DrawingPage };

const samePath = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Pages and groups as the tree the navigator draws.
 *
 * At each level the pages come first, in the order they are stored — which is
 * the order the up and down buttons set — and then the groups, in the order
 * they were first seen. Sorting by name instead would have the arrows do
 * nothing, and a set of drawings has an order somebody chose.
 *
 * `pages` on a group counts everything under it, at any depth: it is what a
 * confirmation has to say before a group is deleted.
 */
export function pageTree(pages: DrawingPage[], groups: DrawingGroups = []): PageNode[] {
  const build = (prefix: string[]): PageNode[] => {
    const here = pages.filter(p => samePath(p.path ?? [], prefix));

    // The next name down each path that starts with this prefix, in the order
    // they turn up — pages first, then groups made and still empty.
    const names: string[] = [];
    const note = (path: string[]) => {
      if (path.length <= prefix.length) return;
      if (!samePath(path.slice(0, prefix.length), prefix)) return;
      const next = path[prefix.length];
      if (next && !names.includes(next)) names.push(next);
    };
    for (const p of pages) note(p.path ?? []);
    for (const g of groups) note(g);

    const children: PageNode[] = here.map(page => ({ kind: 'page' as const, page }));
    for (const name of names) {
      const path = [...prefix, name];
      const inside = build(path);
      children.push({
        kind: 'group',
        name,
        path,
        children: inside,
        pages: countPages(inside),
      });
    }
    return children;
  };

  return build([]);
}

/** How many pages are under these nodes, at any depth. */
export function countPages(nodes: PageNode[]): number {
  return nodes.reduce(
    (n, node) => n + (node.kind === 'page' ? 1 : countPages(node.children)), 0);
}

/** Every group path in the set, for a "move to…" list. */
export function groupPaths(pages: DrawingPage[], groups: DrawingGroups = []): string[][] {
  const seen: string[][] = [];
  const add = (path: string[]) => {
    for (let i = 1; i <= path.length; i++) {
      const slice = path.slice(0, i);
      if (!seen.some(s => samePath(s, slice))) seen.push(slice);
    }
  };
  for (const p of pages) add(p.path ?? []);
  for (const g of groups) add(g);
  return seen;
}

/** Anything stored on the project read back as group paths. */
export function readGroups(v: unknown): DrawingGroups {
  if (!Array.isArray(v)) return [];
  const out: DrawingGroups = [];
  for (const raw of v) {
    if (!Array.isArray(raw)) continue;
    const path = raw.map(n => String(n ?? '').trim()).filter(Boolean).slice(0, 8);
    if (path.length && !out.some(p => samePath(p, path))) out.push(path);
  }
  return out;
}

/**
 * A group renamed, on every page under it and on every group path through it.
 *
 * Renaming a heading is not renaming one thing — it is renaming the same word
 * wherever it appears in a path, and missing one leaves a second group with
 * the old name holding half the drawings.
 */
export function renameGroup(
  pages: DrawingPage[], groups: DrawingGroups, path: string[], name: string,
): { pages: DrawingPage[]; groups: DrawingGroups } {
  const at = path.length - 1;
  const under = (p: string[]) => p.length > at && samePath(p.slice(0, path.length), path);
  const swap = (p: string[]) => p.map((v, i) => (i === at ? name : v));

  return {
    pages: pages.map(p => (under(p.path ?? []) ? { ...p, path: swap(p.path ?? []) } : p)),
    groups: groups.map(g => (under(g) ? swap(g) : g)),
  };
}

/** Everything under a group, gone — pages, sub-groups and the group itself. */
export function removeGroup(
  pages: DrawingPage[], groups: DrawingGroups, path: string[],
): { pages: DrawingPage[]; groups: DrawingGroups; removed: DrawingPage[] } {
  const under = (p: string[]) =>
    p.length >= path.length && samePath(p.slice(0, path.length), path);
  return {
    pages: pages.filter(p => !under(p.path ?? [])),
    groups: groups.filter(g => !under(g)),
    removed: pages.filter(p => under(p.path ?? [])),
  };
}

/**
 * The set with `page` moved `by` places among its own siblings.
 *
 * The stored array is flat and the tree is not: two pages side by side in
 * storage can sit in different groups, and moving one "up" past a page in
 * another group moves it nowhere anybody can see. This swaps with the nearest
 * page that shares its path and leaves the rest of the array alone, so the
 * arrows do on screen what they say.
 */
export function movePageInGroup(pages: DrawingPage[], id: string, by: number): DrawingPage[] {
  const at = pages.findIndex(p => p.id === id);
  if (at < 0 || !by) return pages;
  const path = pages[at].path ?? [];
  const sibs = pages
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => samePath(p.path ?? [], path));
  const where = sibs.findIndex(s => s.p.id === id);
  const to = where + (by < 0 ? -1 : 1);
  if (to < 0 || to >= sibs.length) return pages;
  const next = [...pages];
  const a = sibs[where].i;
  const b = sibs[to].i;
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}

/** `Group`, then `Group 2` — a name free at this level of the tree. */
export function nextGroupName(
  pages: DrawingPage[], groups: DrawingGroups, prefix: string[], stem = 'Group',
): string {
  const taken = new Set<string>();
  const note = (path: string[]) => {
    if (path.length > prefix.length && samePath(path.slice(0, prefix.length), prefix)) {
      taken.add(path[prefix.length].toLowerCase());
    }
  };
  for (const p of pages) note(p.path ?? []);
  for (const g of groups) note(g);
  if (!taken.has(stem.toLowerCase())) return stem;
  let n = 2;
  while (taken.has(`${stem} ${n}`.toLowerCase())) n += 1;
  return `${stem} ${n}`;
}

/**
 * `groups` with `path` in it, and with any ancestor of `path` taken back out.
 *
 * A group is remembered here only while it is empty; the moment something is
 * inside it — a page or a sub-group — the tree finds it on its own, and a
 * second copy of the same heading in this list is a heading that outlives
 * being emptied. Adding a sub-group therefore forgets the parent.
 */
export function addGroup(groups: DrawingGroups, path: string[]): DrawingGroups {
  const ancestor = (g: string[]) => g.length < path.length && samePath(path.slice(0, g.length), g);
  const kept = groups.filter(g => !ancestor(g) && !samePath(g, path));
  return [...kept, path];
}

/** The path of a group as one string, for a key or a menu line. */
export const pathLabel = (path: string[]): string => path.join(' / ');

/**
 * `groups` with every heading the tree can already find on its own dropped.
 *
 * This list exists only to keep an empty group alive. Once a page is inside
 * it — or a sub-group is — the tree reads the heading off the paths, and a
 * leftover entry here is a heading that would survive being emptied and
 * reappear after the last page was moved out of it.
 */
export function settleGroups(pages: DrawingPage[], groups: DrawingGroups): DrawingGroups {
  const under = (path: string[], g: string[]) =>
    path.length >= g.length && samePath(path.slice(0, g.length), g);
  return groups.filter(g =>
    !pages.some(p => under(p.path ?? [], g))
    && !groups.some(o => o.length > g.length && samePath(o.slice(0, g.length), g)));
}
