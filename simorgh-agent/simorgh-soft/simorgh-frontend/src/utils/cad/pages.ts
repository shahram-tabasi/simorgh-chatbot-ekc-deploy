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
  pages: DrawingPage[], type: PageType, description = '',
): DrawingPage {
  return {
    id: newId(),
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
