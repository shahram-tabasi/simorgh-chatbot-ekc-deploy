// src/utils/cad/symbolLibraries.ts
//
// The three symbol libraries a drawing office keeps, and what goes in each.
//
// A symbol is drawn for one kind of document and is wrong in the others. A
// contactor on a single line is one rectangle on the branch; the same
// contactor on a wiring diagram is a coil and three main contacts and however
// many auxiliaries, each on its own path; on a layout it is neither, it is a
// footprint 45 mm wide on a mounting plate. One list holding all three is a
// list where two thirds of what it offers is the wrong answer — which is why
// they are three libraries and not three folders.
//
//   SLD — single line      one line for the whole circuit
//   WD  — wiring diagram   every conductor drawn, the multi-line set
//   OLD — layout           what the panel looks like, to scale
//
// The codes are the ones already on the drawing set, so a person who knows
// which sheet they are on knows which library they want. Everything in the app
// that lists symbols reads the groups from here rather than keeping its own
// copy, so a group added for the office's own symbols shows up everywhere at
// once.

export type LibraryKind = 'sld' | 'wd' | 'old';

export interface SymbolLibraryDef {
  kind: LibraryKind;
  /** What the drawing set calls it. */
  code: 'SLD' | 'WD' | 'OLD';
  name: string;
  nameFa: string;
  /** One line on what belongs here, for the person filing a new symbol. */
  note: string;
  noteFa: string;
  /**
   * The shelves inside it.
   *
   * Different per library on purpose: "Coils" means nothing on a single line
   * and "Busbars" means nothing on a wiring diagram, and a shared list of
   * groups would offer both everywhere.
   */
  groups: string[];
}

export const SYMBOL_LIBRARIES: SymbolLibraryDef[] = [
  {
    kind: 'sld',
    code: 'SLD',
    name: 'Single line',
    nameFa: 'تک‌خطی',
    note: 'One line for the whole circuit — the feeder as it is issued.',
    noteFa: 'یک خط برای کل مدار — همان‌طور که فیدر صادر می‌شود.',
    groups: ['Switching', 'Protection', 'Measuring', 'Loads', 'Connections'],
  },
  {
    kind: 'wd',
    code: 'WD',
    name: 'Wiring diagram',
    nameFa: 'مولتی‌لاین',
    note: 'Every conductor drawn — coils, contacts and terminals on their paths.',
    noteFa: 'همه‌ی هادی‌ها کشیده می‌شوند — بوبین، کنتاکت و ترمینال روی مسیر خودشان.',
    groups: [
      'Contacts', 'Coils and actuators', 'Protection', 'Motors and drives',
      'Measuring', 'Terminals and plugs', 'Cables and shields', 'Power supply',
      'Control and signalling', 'Cross references',
    ],
  },
  {
    kind: 'old',
    code: 'OLD',
    name: 'Layout',
    nameFa: 'جانمایی',
    note: 'What the panel looks like, to scale — footprints, not circuits.',
    noteFa: 'شکل واقعی تابلو با مقیاس — ابعاد تجهیز، نه مدار.',
    groups: [
      'Cubicles and frames', 'Mounting plates and rails', 'Devices',
      'Busbars and supports', 'Doors and fronts', 'Cable entries',
      'Dimensions and notes',
    ],
  },
];

const BY_KIND = new Map(SYMBOL_LIBRARIES.map(l => [l.kind, l]));

export const libraryOf = (kind: LibraryKind): SymbolLibraryDef =>
  BY_KIND.get(kind) ?? SYMBOL_LIBRARIES[0];

/**
 * Which library a value names, whatever it was written as.
 *
 * `sld`, `SLD`, `single line`, `single-line` all mean the same shelf. Anything
 * else is the single line, because that is the library everything in this app
 * drew from before there were three of them, and a symbol filed before the
 * question was asked belongs where it already was.
 */
export function readKind(v: unknown): LibraryKind {
  const s = String(v ?? '').trim().toLowerCase().replace(/[^a-z]+/g, '');
  if (s === 'wd' || s === 'multiline' || s === 'wiringdiagram' || s === 'wiring') return 'wd';
  if (s === 'old' || s === 'layout' || s === 'arrangement') return 'old';
  return 'sld';
}

/** The group to file something under when none was picked. */
export const defaultGroup = (kind: LibraryKind): string => {
  const groups = libraryOf(kind).groups;
  // The last shelf in each library is the general one — Connections, cross
  // references, notes — which is where something unfiled does least harm.
  return groups[groups.length - 1];
};

/** Is this one of the library's own shelves, or a name someone typed? */
export const knownGroup = (kind: LibraryKind, group: string): boolean =>
  libraryOf(kind).groups.includes(group);
