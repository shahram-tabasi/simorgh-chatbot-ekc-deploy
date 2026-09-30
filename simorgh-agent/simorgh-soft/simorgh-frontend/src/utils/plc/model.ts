// src/utils/plc/model.ts
//
// What a PLC program is, in this app.
//
// The shape here is the one every IEC 61131-3 tool uses, because it is the one
// the standard describes and the one an engineer already has in their head:
// a controller holds **blocks**, a block has an **interface** (what it is
// given, what it gives back, what it remembers) and a **body** (what it does),
// and beside the blocks are the **tags** that name the wires into the rack and
// the **data types** the office declares once and uses everywhere.
//
// Two kinds of body, and only two:
//
//   * **text** — SCL (Structured Text) and STL (statement list) are a string.
//     Everything an editor needs is in the string; the parts that matter for
//     checking are pulled out of it on demand rather than kept twice.
//   * **networks** — LAD and FBD are a list of rungs. A rung is the ladder
//     model this app already has (`utils/ladder/model.ts`): groups in series,
//     branches in parallel, elements in series inside a branch. FBD is the
//     same tree drawn as boxes rather than as rails, which is why it is a view
//     of this and not a second model.
//
// Keeping those two and refusing a third is deliberate. A graphical language
// stored as free geometry cannot be checked, cannot be compiled to text, and
// cannot be handed to anything that did not draw it. Stored as a tree it can
// be all three — which is what makes the LAD editor, the SCL export and the
// assistant the same program rather than three that drift.
//
// **Nothing here talks to a controller.** This writes, checks and exports
// programs; it does not claim to produce a file a vendor's software will
// import unchanged, and it does not download to a rack. Saying that plainly in
// the model is worth more than an apology in a dialog later.

import { Rung, Tag as LadderTag } from '../ladder/model';

// ── The languages ───────────────────────────────────────────────────────────

/**
 * The five IEC languages, as the software an engineer opens spells them.
 *
 * SCL is Siemens' name for Structured Text and is what this suite writes by
 * default: it is the one language that survives being generated, reviewed in a
 * diff and pasted into a mail. LAD is what most panels are actually programmed
 * in, so it is edited graphically. FBD is LAD's logic drawn as boxes and is a
 * view of the same networks. STL is kept as text for the blocks that still
 * need it. GRAPH is listed because a sequencer is a real thing an engineer
 * asks for, and it is declared here as text until it is drawn.
 */
export type PlcLanguage = 'SCL' | 'LAD' | 'FBD' | 'STL' | 'GRAPH';

export const PLC_LANGUAGES: { id: PlcLanguage; label: string; note: string; graphical: boolean }[] = [
  { id: 'LAD', label: 'LAD', note: 'Ladder — contacts and coils, drawn', graphical: true },
  { id: 'FBD', label: 'FBD', note: 'Function block diagram — the same logic as boxes', graphical: true },
  { id: 'SCL', label: 'SCL', note: 'Structured Text — the written language', graphical: false },
  { id: 'STL', label: 'STL', note: 'Statement list — one instruction a line', graphical: false },
  { id: 'GRAPH', label: 'GRAPH', note: 'Sequencer — steps and transitions', graphical: false },
];

/** True where the body is a list of networks rather than a string. */
export const isGraphical = (lang: PlcLanguage): boolean => lang === 'LAD' || lang === 'FBD';

// ── The blocks ──────────────────────────────────────────────────────────────

/**
 * What kind of block this is.
 *
 * The four are not interchangeable and the difference is the whole of how a
 * program is organised:
 *
 *   * **OB** — an organisation block. The controller calls it; nothing else
 *     does. OB1 is the cyclic program, and the rest are the events — startup,
 *     a hardware interrupt, a cyclic interrupt, an error.
 *   * **FC** — a function. It is given values and gives one back, and it
 *     remembers nothing between calls. Anything it needs to keep, it is
 *     handed.
 *   * **FB** — a function block. Same, except that it remembers: its static
 *     variables live in an instance data block, one per call site, so two
 *     motors driven by the same FB each keep their own timer.
 *   * **DB** — a data block. Values, no code. Global when anybody may read it,
 *     an instance when it belongs to one call of one FB.
 *   * **UDT** — a user data type. Not a block at all in the strict sense, but
 *     it is declared beside them, filed beside them and edited in the same
 *     grid, so it is one here.
 */
export type PlcBlockKind = 'OB' | 'FC' | 'FB' | 'DB' | 'UDT';

export const BLOCK_KINDS: { id: PlcBlockKind; label: string; note: string }[] = [
  { id: 'OB', label: 'Organization block', note: 'The controller calls it — the cyclic program and the events' },
  { id: 'FB', label: 'Function block', note: 'Has a memory: its statics live in an instance data block' },
  { id: 'FC', label: 'Function', note: 'Given values, gives one back, remembers nothing' },
  { id: 'DB', label: 'Data block', note: 'Values with no code — global, or the instance of one FB' },
  { id: 'UDT', label: 'PLC data type', note: 'A structure declared once and used as a type' },
];

/**
 * Which part of the interface a variable belongs to.
 *
 * This is not decoration: where a variable is declared decides when it exists
 * and who may write it, and the commonest real bug in a first program is a
 * value kept in Temp that was meant to survive the scan.
 *
 *   * `Input`    — read-only inside the block, supplied by the caller.
 *   * `Output`   — written here, read by the caller after the call.
 *   * `InOut`    — handed in by reference: written here, seen by the caller.
 *   * `Static`   — **FB and DB only.** Survives the call. This is the memory.
 *   * `Temp`     — exists for one call and starts as rubbish. Never assume it
 *                  is zero; the compiler will not warn you and the controller
 *                  will not either.
 *   * `Constant` — a name for a number, fixed at compile time.
 *   * `Return`   — the single value an FC gives back (`Ret_Val`).
 */
export type PlcSection =
  | 'Input' | 'Output' | 'InOut' | 'Static' | 'Temp' | 'Constant' | 'Return';

export const SECTIONS: { id: PlcSection; label: string; note: string }[] = [
  { id: 'Input', label: 'Input', note: 'Given by the caller; read-only in here' },
  { id: 'Output', label: 'Output', note: 'Written in here; read by the caller' },
  { id: 'InOut', label: 'InOut', note: 'Handed in by reference — written here, seen by the caller' },
  { id: 'Static', label: 'Static', note: 'Survives the call. FB and DB only — this is the memory' },
  { id: 'Temp', label: 'Temp', note: 'One call only, and starts as rubbish. Never assume zero' },
  { id: 'Constant', label: 'Constant', note: 'A name for a fixed value' },
  { id: 'Return', label: 'Return', note: 'The one value a function gives back' },
];

/** Which sections a block of this kind may declare. */
export function sectionsFor(kind: PlcBlockKind): PlcSection[] {
  switch (kind) {
    // An OB's interface is given by the controller: the event it answers
    // decides what it is handed, and nothing may be added to that. Temp and
    // Constant are the engineer's own and are allowed.
    case 'OB': return ['Temp', 'Constant'];
    case 'FC': return ['Input', 'Output', 'InOut', 'Temp', 'Constant', 'Return'];
    case 'FB': return ['Input', 'Output', 'InOut', 'Static', 'Temp', 'Constant'];
    // A data block is static values and nothing else; a type is its members,
    // which are declared in the same place for the same reason.
    case 'DB': return ['Static'];
    case 'UDT': return ['Static'];
  }
}

/** One declared variable — one row of the interface grid. */
export interface PlcVar {
  id: string;
  name: string;
  /** As the engineer wrote it: `Bool`, `Int`, `Array[1..10] of Real`, `"Motor"`. */
  dataType: string;
  section: PlcSection;
  /** The start value, as typed. Empty means the type's own default. */
  defaultValue?: string;
  comment?: string;
  /** Kept through a power cycle. Only meaningful in Static. */
  retain?: boolean;
  /** Reachable from HMI / OPC UA. Defaults to true where it is not said. */
  visible?: boolean;
  /** Writable from HMI / OPC UA. */
  writable?: boolean;
  /** Members, for a row that is a structure declared in place. */
  members?: PlcVar[];
}

/**
 * One network of a graphical block.
 *
 * A network is one rung: one path from the left rail to the right, however
 * many branches it takes on the way and however many coils stack at the end.
 * TIA calls it a network, ladder calls it a rung, and they are the same thing
 * — which is why `rung` here is the model the rest of this app already draws.
 *
 * The title and the comment are not decoration. A program is read far more
 * often than it is written, and the difference between one that can be read
 * and one that cannot is almost entirely whether its networks say what they
 * are for.
 */
export interface PlcNetwork {
  id: string;
  title: string;
  comment?: string;
  rung: Rung;
  /** Left in the block but not executed — how a network is put aside safely. */
  disabled?: boolean;
}

export interface PlcBlock {
  id: string;
  /** `Main`, `Motor_Control`, `Recipe_DB`. What the program calls it. */
  name: string;
  kind: PlcBlockKind;
  /**
   * The number, where the kind has one: OB1, FC10, FB20, DB30.
   *
   * Symbolic access made this stop mattering for most work and it is still
   * what an OB *is* — OB100 is startup and OB35 is a cyclic interrupt because
   * of the number, not because of the name.
   */
  number?: number;
  language: PlcLanguage;
  comment?: string;
  /** What the block declares — every section, in one list. */
  interface: PlcVar[];
  /** The body of a graphical block. */
  networks?: PlcNetwork[];
  /** The body of a text block. */
  code?: string;
  /** For a DB: global, or the instance of one FB. */
  dbKind?: 'global' | 'instance';
  /** The FB this is the instance of, by block id. Instance DBs only. */
  instanceOf?: string;
  /** Written into the header the exporter emits. */
  author?: string;
  family?: string;
  version?: string;
  createdAt: string;
  changedAt: string;
}

// ── The tags ────────────────────────────────────────────────────────────────

/**
 * One PLC tag — a name for an address in the rack.
 *
 * This is the one table that is not about the program at all: it is about the
 * wiring. `%I0.0` is a terminal somebody landed a wire on, and `Start_PB` is
 * what that wire is for. Every program worth reading is written against the
 * second and every program that is hard to fix was written against the first.
 */
export interface PlcTag {
  id: string;
  name: string;
  dataType: string;
  /** `%I0.0`, `%QW64`, `%MD100`. Empty for a tag that is only a name. */
  address: string;
  comment?: string;
  retain?: boolean;
  visible?: boolean;
  writable?: boolean;
}

export interface PlcTagTable {
  id: string;
  name: string;
  tags: PlcTag[];
  /** The one table new tags land in when nobody said which. */
  isDefault?: boolean;
}

// ── The controller ──────────────────────────────────────────────────────────

export interface PlcDevice {
  /** `PLC_1` — what the project calls this controller. */
  name: string;
  /** `CPU 1512C-1 PN`. Free text: the catalogue is the customer's, not ours. */
  cpu: string;
  vendor: string;
  /** The dialect id from `utils/ladder/dialects.ts`, so the vocabulary agrees. */
  dialect: string;
}

export interface PlcProject {
  device: PlcDevice;
  blocks: PlcBlock[];
  tagTables: PlcTagTable[];
  /** Bumped on every change, so a view can tell it is looking at old data. */
  changedAt: string;
}

// ── Making one ──────────────────────────────────────────────────────────────

/**
 * A new id.
 *
 * Time alone is not enough: two blocks made in a loop — pasting a folder,
 * importing a program — land in the same millisecond and collide, and two
 * blocks with one id is a tree that loses one of them and a call that goes to
 * the wrong place. The counter is what makes that impossible in one session,
 * and the timestamp is what keeps it ordered between them.
 */
let idSeq = 0;
export const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${(idSeq += 1).toString(36)}`;

const now = (): string => new Date().toISOString();

export function newVar(section: PlcSection, over: Partial<PlcVar> = {}): PlcVar {
  return {
    id: newId('v'),
    name: '',
    dataType: 'Bool',
    section,
    visible: true,
    writable: true,
    ...over,
  };
}

export function newNetwork(n: number, over: Partial<PlcNetwork> = {}): PlcNetwork {
  return {
    id: newId('n'),
    title: `Network ${n}`,
    rung: { number: n, groups: [], outputs: [] },
    ...over,
  };
}

export function newBlock(kind: PlcBlockKind, over: Partial<PlcBlock> = {}): PlcBlock {
  const language: PlcLanguage = over.language ?? (kind === 'DB' || kind === 'UDT' ? 'SCL' : 'LAD');
  const base: PlcBlock = {
    id: newId('b'),
    name: '',
    kind,
    language,
    interface: [],
    createdAt: now(),
    changedAt: now(),
  };
  if (kind === 'DB') base.dbKind = 'global';
  if (kind !== 'DB' && kind !== 'UDT') {
    if (isGraphical(language)) base.networks = [newNetwork(1)];
    else base.code = '';
  }
  return { ...base, ...over };
}

/**
 * The program a brand-new controller starts with.
 *
 * Not empty. An empty tree is a question — where does the program go? — and
 * the answer is the same in every project ever written: OB1, called once a
 * scan, which is why every vendor ships it and none of them makes you create
 * it. The two tags are there so the first network has something real to hang
 * on and so the tag table is a table rather than a blank invitation.
 */
export function newPlcProject(over: Partial<PlcProject> = {}): PlcProject {
  const main = newBlock('OB', {
    name: 'Main',
    number: 1,
    language: 'LAD',
    comment: 'Main program sweep (cycle) — called once every scan.',
    networks: [newNetwork(1, { title: 'Network 1', comment: '' })],
  });
  return {
    device: { name: 'PLC_1', cpu: 'CPU 1512C-1 PN', vendor: 'Siemens', dialect: 's7-1500' },
    blocks: [main],
    tagTables: [{
      id: newId('tt'),
      name: 'Default tag table',
      isDefault: true,
      tags: [
        { id: newId('t'), name: 'Start_PB', dataType: 'Bool', address: '%I0.0', comment: 'Start push button (NO)' },
        { id: newId('t'), name: 'Stop_PB', dataType: 'Bool', address: '%I0.1', comment: 'Stop push button (NC)' },
        { id: newId('t'), name: 'Motor', dataType: 'Bool', address: '%Q0.0', comment: 'Motor contactor' },
      ],
    }],
    changedAt: now(),
    ...over,
  };
}

// ── Asking things of a program ──────────────────────────────────────────────

/** The block a name refers to, whatever its case. Names are not case-sensitive. */
export function blockByName(project: PlcProject, name: string): PlcBlock | undefined {
  const want = name.trim().toLowerCase().replace(/^"|"$/g, '');
  return project.blocks.find(b => b.name.trim().toLowerCase() === want);
}

/** How a block is written where it is called: `"Motor_Control"` or `%FC10`. */
export function callName(block: PlcBlock): string {
  return `"${block.name}"`;
}

/** `OB1`, `FB20`, `DB30` — the absolute name, where the block has a number. */
export function absoluteName(block: PlcBlock): string {
  return block.number === undefined ? block.name : `${block.kind}${block.number}`;
}

/** Every tag in the project, across all tables, in table order. */
export function allTags(project: PlcProject): PlcTag[] {
  return project.tagTables.flatMap(t => t.tags);
}

/** The variables of one section, in declaration order. */
export function sectionVars(block: PlcBlock, section: PlcSection): PlcVar[] {
  return block.interface.filter(v => v.section === section);
}

/**
 * The next free number for a new block of this kind.
 *
 * Numbers are per kind — FC1 and FB1 are different blocks and both are
 * allowed — and the first free one is taken rather than the highest plus one,
 * so deleting FC3 and adding a function gives FC3 back instead of drifting
 * upwards forever.
 */
export function nextNumber(project: PlcProject, kind: PlcBlockKind, from = 1): number {
  const used = new Set(project.blocks.filter(b => b.kind === kind).map(b => b.number));
  let n = from;
  while (used.has(n)) n += 1;
  return n;
}

/** A name nothing else in the project has. */
export function freeName(project: PlcProject, want: string): string {
  const taken = new Set(project.blocks.map(b => b.name.toLowerCase()));
  if (!taken.has(want.toLowerCase())) return want;
  let n = 1;
  while (taken.has(`${want}_${n}`.toLowerCase())) n += 1;
  return `${want}_${n}`;
}

/**
 * Which blocks this one calls, by name.
 *
 * Read out of the body rather than kept in a list beside it, because a list
 * beside it is a list that goes stale the first time somebody edits the code
 * and does not update it — and a call graph that is wrong is worse than none.
 */
export function callsOf(block: PlcBlock): string[] {
  const found = new Set<string>();
  if (block.code) {
    // `"Motor_Control"(...)` and `"IEC_Timer"(...)`: a quoted name followed by
    // an open bracket is a call in SCL and is not anything else.
    for (const m of block.code.matchAll(/"([^"\n]{1,80})"\s*\(/g)) found.add(m[1]);
  }
  for (const net of block.networks ?? []) {
    for (const group of net.rung.groups) {
      for (const branch of group.branches) {
        for (const el of branch.elements) {
          if (el.k === 'block' && el.type) found.add(el.type);
        }
      }
    }
  }
  return [...found];
}

// ── Reading one back ────────────────────────────────────────────────────────
// Everything below is for a project arriving from storage or from a file.
// Nothing is trusted: what cannot be read is dropped and the rest still opens,
// because a program that will not open because one row of one table is wrong
// is a program somebody has lost.

const str = (v: unknown, limit = 200): string =>
  typeof v === 'string' ? v.trim().slice(0, limit) : '';

const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

const KINDS: PlcBlockKind[] = ['OB', 'FC', 'FB', 'DB', 'UDT'];
const LANGS: PlcLanguage[] = ['SCL', 'LAD', 'FBD', 'STL', 'GRAPH'];
const SECTION_IDS: PlcSection[] = ['Input', 'Output', 'InOut', 'Static', 'Temp', 'Constant', 'Return'];

/**
 * One declared row.
 *
 * **A row with no name is kept.** That looks like a hole in the validation and
 * is the opposite: every edit in this app goes out through the project and
 * comes back in through this reader, so a row dropped for having no name yet
 * is a row that cannot be added at all — press Add, get nothing, every time.
 * A half-typed declaration is the normal state of a grid somebody is working
 * in; it is the checker's job to say it is not finished, not the reader's job
 * to throw it away.
 */
function readVar(raw: unknown, depth = 0): PlcVar | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name, 128);
  const section = SECTION_IDS.find(s => s === r.section) ?? 'Static';
  const members = depth < 6 && Array.isArray(r.members)
    ? r.members.slice(0, 512).map(m => readVar(m, depth + 1)).filter((v): v is PlcVar => v !== null)
    : undefined;
  return {
    id: str(r.id, 64) || newId('v'),
    name,
    dataType: str(r.dataType, 160) || 'Bool',
    section,
    defaultValue: str(r.defaultValue, 200) || undefined,
    comment: str(r.comment, 400) || undefined,
    retain: bool(r.retain),
    visible: bool(r.visible),
    writable: bool(r.writable),
    members: members && members.length > 0 ? members : undefined,
  };
}

/**
 * A rung as it arrived.
 *
 * `readProgram` in the ladder model does this for a whole program and drops
 * rungs it cannot use; here one network is one rung and an empty one is
 * perfectly legal — a network somebody has just inserted and not filled is the
 * normal state of a program being written — so this is the looser reader.
 */
function readRung(raw: unknown, number: number): Rung {
  const r = (raw ?? {}) as Record<string, unknown>;
  const groups = (Array.isArray(r.groups) ? r.groups : []).map(g => {
    const gr = (g ?? {}) as Record<string, unknown>;
    const branches = (Array.isArray(gr.branches) ? gr.branches : []).map(b => {
      const br = (b ?? {}) as Record<string, unknown>;
      const elements = (Array.isArray(br.elements) ? br.elements : [])
        .filter(e => e && typeof e === 'object') as Rung['groups'][0]['branches'][0]['elements'];
      return { elements };
    });
    return { branches: branches.length > 0 ? branches : [{ elements: [] }] };
  });
  const outputs = (Array.isArray(r.outputs) ? r.outputs : [])
    .filter(o => o && typeof o === 'object') as Rung['outputs'];
  return { number, comment: str(r.comment, 400) || undefined, groups, outputs };
}

function readNetwork(raw: unknown, n: number): PlcNetwork {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: str(r.id, 64) || newId('n'),
    title: str(r.title, 200) || `Network ${n}`,
    comment: str(r.comment, 2000) || undefined,
    rung: readRung(r.rung, n),
    disabled: bool(r.disabled),
  };
}

function readBlock(raw: unknown): PlcBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name, 128);
  if (!name) return null;
  const kind = KINDS.find(k => k === r.kind) ?? 'FC';
  const language = LANGS.find(l => l === r.language) ?? 'SCL';
  const number = Number.isFinite(Number(r.number)) && r.number !== null && r.number !== ''
    ? Math.max(0, Math.round(Number(r.number))) : undefined;
  const iface = (Array.isArray(r.interface) ? r.interface : [])
    .slice(0, 4000).map(v => readVar(v)).filter((v): v is PlcVar => v !== null);
  const networks = Array.isArray(r.networks)
    ? r.networks.slice(0, 2000).map((n, i) => readNetwork(n, i + 1))
    : undefined;
  return {
    id: str(r.id, 64) || newId('b'),
    name,
    kind,
    number,
    language,
    comment: str(r.comment, 2000) || undefined,
    interface: iface,
    networks,
    code: typeof r.code === 'string' ? r.code.slice(0, 500_000) : undefined,
    dbKind: r.dbKind === 'instance' ? 'instance' : (kind === 'DB' ? 'global' : undefined),
    instanceOf: str(r.instanceOf, 64) || undefined,
    author: str(r.author, 64) || undefined,
    family: str(r.family, 64) || undefined,
    version: str(r.version, 24) || undefined,
    createdAt: str(r.createdAt, 40) || now(),
    changedAt: str(r.changedAt, 40) || now(),
  };
}

/** One tag. Nameless is kept, for the same reason a nameless variable is. */
function readTag(raw: unknown): PlcTag | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name, 128);
  return {
    id: str(r.id, 64) || newId('t'),
    name,
    dataType: str(r.dataType, 64) || 'Bool',
    address: str(r.address, 64),
    comment: str(r.comment, 400) || undefined,
    retain: bool(r.retain),
    visible: bool(r.visible),
    writable: bool(r.writable),
  };
}

/** A project as it arrived. Never throws; what cannot be read is left out. */
export function readPlcProject(raw: unknown): PlcProject {
  if (!raw || typeof raw !== 'object') return newPlcProject();
  const r = raw as Record<string, unknown>;
  const d = (r.device ?? {}) as Record<string, unknown>;

  const blocks = (Array.isArray(r.blocks) ? r.blocks : [])
    .slice(0, 4000).map(readBlock).filter((b): b is PlcBlock => b !== null);

  const tagTables = (Array.isArray(r.tagTables) ? r.tagTables : [])
    .slice(0, 200).map((t): PlcTagTable | null => {
      const tt = (t ?? {}) as Record<string, unknown>;
      const name = str(tt.name, 128);
      if (!name) return null;
      return {
        id: str(tt.id, 64) || newId('tt'),
        name,
        isDefault: bool(tt.isDefault),
        tags: (Array.isArray(tt.tags) ? tt.tags : [])
          .slice(0, 20_000).map(readTag).filter((x): x is PlcTag => x !== null),
      };
    })
    .filter((t): t is PlcTagTable => t !== null);

  // A project with no blocks at all is one that never got started, not one
  // that lost them — so it opens as a fresh controller rather than as an empty
  // tree with nowhere to type.
  if (blocks.length === 0 && tagTables.length === 0) return newPlcProject();

  return {
    device: {
      name: str(d.name, 64) || 'PLC_1',
      cpu: str(d.cpu, 128) || 'CPU 1512C-1 PN',
      vendor: str(d.vendor, 64) || 'Siemens',
      dialect: str(d.dialect, 64) || 's7-1500',
    },
    blocks,
    tagTables: tagTables.length > 0 ? tagTables : newPlcProject().tagTables,
    changedAt: str(r.changedAt, 40) || now(),
  };
}

/** The ladder model's own tag shape, for the parts of this app that speak it. */
export function toLadderTags(project: PlcProject): LadderTag[] {
  return allTags(project).map(t => ({
    at: t.address || t.name,
    name: t.name,
    type: t.dataType,
    comment: t.comment,
    kind: t.address.startsWith('%I') ? 'input'
      : t.address.startsWith('%Q') ? 'output'
        : t.address.startsWith('%M') ? 'memory' : 'data',
  }));
}
