// src/utils/ladder/model.ts
//
// What a ladder program is, in this app.
//
// Ladder is a graph in principle and a grid in practice. Every rung anybody
// actually writes is a *series of parallel groups* feeding one or more outputs:
// start and stop in series, the seal-in contact in parallel with start, the
// contactor coil on the right. So that is the shape modelled here — a rung is a
// list of groups, a group is a list of branches, a branch is a series of
// elements — rather than a general network.
//
// That choice is not a shortcut, it is what makes the rest possible: a grid can
// be drawn without a layout engine, checked without a solver, and explained to
// somebody step by step. A rung that genuinely cannot be written this way (a
// bridged network, current flowing two ways through the middle) is rare enough
// in an industrial program that it is better refused than half-drawn — see
// `fitsGrid`.
//
// Nothing here knows any vendor. What a contact is called, what pins a timer
// shows and how an address is written all live in `dialects.ts`, because those
// are the things that differ between Siemens and Rockwell while the shape of a
// rung is the same in both.

/** A contact: what it tests, and how. */
export interface Contact {
  k: 'no' | 'nc' | 'p' | 'n';
  /** The address or tag it reads — `%I0.0`, `X0`, `Start_PB`. */
  at: string;
  /** What it is, in words, written above the address. */
  label?: string;
}

/** An output on the right-hand side of a rung. */
export interface Coil {
  k: 'coil' | 'set' | 'reset' | 'pulse-p' | 'pulse-n';
  at: string;
  label?: string;
}

/** One pin of a function block, and what is wired to it. */
export interface Pin {
  /** The vendor's own name for it — IN, PT, Q, ET, Preset, Accum. */
  name: string;
  /** The tag, address or constant on it. Empty is allowed: an unused pin. */
  value?: string;
  /** True for a pin that leaves the block. */
  out?: boolean;
}

/** A function block in the rung — a timer, a counter, a move, a compare. */
export interface Block {
  k: 'block';
  /** The vendor's own name for the block: TON, CTU, MOVE, TMR, XIC. */
  type: string;
  /** The instance, where the vendor needs one — `T1`, `Motor_Timer`. */
  name?: string;
  pins: Pin[];
  /** What it does, in words. */
  label?: string;
}

export type Element = Contact | Block;

/** A series of elements — one path through a group. */
export interface Branch {
  elements: Element[];
}

/** Branches side by side: current gets through if any one of them does. */
export interface Group {
  branches: Branch[];
}

export interface Rung {
  /** As numbered in the program. 1-based, and its own field because a rung
   *  inserted in the middle renumbers everything after it. */
  number: number;
  /** The rung comment — the line every readable program has and every
   *  unreadable one does not. */
  comment?: string;
  /** The condition, left to right. */
  groups: Group[];
  /** What it drives. More than one when several coils stack on the right. */
  outputs: Coil[];
}

/** One line of the tag table. */
export interface Tag {
  /** The address, as the vendor writes it. */
  at: string;
  /** The symbolic name, where the program uses one. */
  name?: string;
  /** BOOL, INT, TIME, REAL… as the vendor spells it. */
  type?: string;
  comment?: string;
  /** Where it comes from, for the table's own grouping. */
  kind?: 'input' | 'output' | 'memory' | 'timer' | 'counter' | 'data';
}

export interface LadderProgram {
  /** What the program is for, in a sentence. */
  title: string;
  /** Which dialect it is written in — see `dialects.ts`. */
  dialect: string;
  /** The controller it was written for, as the user chose it. */
  controller?: string;
  /** The language the user asked for; ladder is what is drawn either way. */
  language?: string;
  rungs: Rung[];
  tags: Tag[];
  /** What the model said, step by step, as it built this. */
  steps?: Step[];
}

/** One step of the explanation, and what the program looked like after it. */
export interface Step {
  title: string;
  /** Why this rung, in the words somebody learning would want. */
  explain: string;
  /** Which rungs this step added, by number. */
  rungs: number[];
}

// ── Reading one back ───────────────────────────────────────────────────────
// Everything below is for what arrives from the model or out of a saved file.
// Nothing is trusted: a program that is half-read is drawn as far as it was
// understood and the rest is reported, never guessed at.

const text = (v: unknown, limit = 120): string =>
  (typeof v === 'string' ? v.trim().slice(0, limit) : '');

const CONTACT_KINDS: Contact['k'][] = ['no', 'nc', 'p', 'n'];
const COIL_KINDS: Coil['k'][] = ['coil', 'set', 'reset', 'pulse-p', 'pulse-n'];

function readContact(raw: Record<string, unknown>): Contact | null {
  const k = CONTACT_KINDS.find(x => x === raw.k);
  const at = text(raw.at, 48);
  if (!k || !at) return null;
  return { k, at, label: text(raw.label) || undefined };
}

function readBlock(raw: Record<string, unknown>): Block | null {
  const type = text(raw.type, 24).toUpperCase();
  if (!type) return null;
  const pins = Array.isArray(raw.pins)
    ? raw.pins.slice(0, 12).map((p): Pin | null => {
        const pin = p as Record<string, unknown>;
        const name = text(pin.name, 16);
        return name ? { name, value: text(pin.value, 48), out: pin.out === true } : null;
      }).filter((p): p is Pin => p !== null)
    : [];
  return { k: 'block', type, name: text(raw.name, 32) || undefined, pins, label: text(raw.label) || undefined };
}

function readElement(raw: unknown): Element | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return r.k === 'block' ? readBlock(r) : readContact(r);
}

function readCoil(raw: unknown): Coil | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const k = COIL_KINDS.find(x => x === r.k) ?? 'coil';
  const at = text(r.at, 48);
  if (!at) return null;
  return { k, at, label: text(r.label) || undefined };
}

export interface ReadReport {
  program: LadderProgram;
  /** What could not be read, in words somebody can act on. */
  dropped: string[];
}

/** A program as it arrived, kept to what can actually be drawn. */
export function readProgram(raw: unknown, fallbackDialect = 'iec'): ReadReport {
  const dropped: string[] = [];
  const r = (raw ?? {}) as Record<string, unknown>;

  const rungs: Rung[] = [];
  const rawRungs = Array.isArray(r.rungs) ? r.rungs : [];
  rawRungs.forEach((rawRung, i) => {
    const rr = (rawRung ?? {}) as Record<string, unknown>;
    const groups: Group[] = [];

    for (const rawGroup of Array.isArray(rr.groups) ? rr.groups : []) {
      const rg = (rawGroup ?? {}) as Record<string, unknown>;
      const branches: Branch[] = [];
      for (const rawBranch of Array.isArray(rg.branches) ? rg.branches : []) {
        const rb = (rawBranch ?? {}) as Record<string, unknown>;
        const elements = (Array.isArray(rb.elements) ? rb.elements : [])
          .map(readElement).filter((e): e is Element => e !== null);
        // An empty branch is a wire straight through, which is a real thing on
        // a ladder — a group with one empty branch beside a contact is how
        // "or nothing" is drawn. So it is kept.
        branches.push({ elements });
      }
      if (branches.length > 0) groups.push({ branches });
    }

    const outputs = (Array.isArray(rr.outputs) ? rr.outputs : [])
      .map(readCoil).filter((c): c is Coil => c !== null);

    if (groups.length === 0 && outputs.length === 0) {
      dropped.push(`Rung ${i + 1} had nothing in it.`);
      return;
    }
    if (outputs.length === 0) {
      dropped.push(`Rung ${i + 1} drives nothing — a condition with no output.`);
      return;
    }

    rungs.push({
      number: rungs.length + 1,
      comment: text(rr.comment, 200) || undefined,
      groups,
      outputs,
    });
  });

  const tags: Tag[] = (Array.isArray(r.tags) ? r.tags : [])
    .map((rawTag): Tag | null => {
      const t = (rawTag ?? {}) as Record<string, unknown>;
      const at = text(t.at, 48);
      if (!at) return null;
      const kind = ['input', 'output', 'memory', 'timer', 'counter', 'data']
        .find(x => x === t.kind) as Tag['kind'];
      return {
        at,
        name: text(t.name, 48) || undefined,
        type: text(t.type, 24) || undefined,
        comment: text(t.comment, 160) || undefined,
        kind,
      };
    })
    .filter((t): t is Tag => t !== null);

  const steps: Step[] = (Array.isArray(r.steps) ? r.steps : [])
    .map((rawStep): Step | null => {
      const s = (rawStep ?? {}) as Record<string, unknown>;
      const title = text(s.title, 120);
      if (!title) return null;
      return {
        title,
        explain: text(s.explain, 1200),
        rungs: (Array.isArray(s.rungs) ? s.rungs : [])
          .map(n => Number(n)).filter(n => Number.isFinite(n)),
      };
    })
    .filter((s): s is Step => s !== null);

  return {
    program: {
      title: text(r.title, 160) || 'Ladder program',
      dialect: text(r.dialect, 24) || fallbackDialect,
      controller: text(r.controller, 80) || undefined,
      language: text(r.language, 40) || undefined,
      rungs,
      tags,
      steps,
    },
    dropped,
  };
}

// ── Asking things of a program ─────────────────────────────────────────────

/** Every address the program touches, in the order it first meets them. */
export function addressesUsed(program: LadderProgram): string[] {
  const seen = new Set<string>();
  const add = (v?: string) => { const s = (v ?? '').trim(); if (s) seen.add(s); };
  for (const rung of program.rungs) {
    for (const group of rung.groups) {
      for (const branch of group.branches) {
        for (const el of branch.elements) {
          if (el.k === 'block') {
            for (const pin of el.pins) add(pin.value);
            add(el.name);
          } else {
            add(el.at);
          }
        }
      }
    }
    for (const out of rung.outputs) add(out.at);
  }
  return [...seen];
}

/** How many elements wide the widest rung is — what the sheet has to hold. */
export function widestRung(program: LadderProgram): number {
  let most = 0;
  for (const rung of program.rungs) {
    const width = rung.groups.reduce(
      (sum, g) => sum + Math.max(1, ...g.branches.map(b => b.elements.length)), 0);
    if (width > most) most = width;
  }
  return most;
}
