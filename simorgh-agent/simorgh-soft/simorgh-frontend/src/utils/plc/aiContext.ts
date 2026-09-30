// src/utils/plc/aiContext.ts
//
// The program, described so that something that cannot see the screen can work
// on it — and the way back in for what it writes.
//
// A model asked to "add an interlock" with no context invents tag names, calls
// blocks that do not exist and declares variables that are already there under
// another name. Every one of those is the same failure: it was not told what
// is already true. So this file does two things, and keeps them apart on
// purpose:
//
//   * **out** — `snapshot()` writes the project down. What blocks exist, what
//     each one declares, what the tags are, what the instruction vocabulary is,
//     and what is currently wrong with it. Compact, because a context window is
//     not free, and complete in the parts that get invented when they are
//     missing.
//
//   * **in** — `readGenerated()` takes what came back and turns it into blocks,
//     dropping anything it cannot make sense of and **saying what it dropped**.
//     Nothing arriving from a model is trusted: not the block kind, not the
//     data types, not the instruction names. A generated program that is
//     quietly half-applied is worse than one that is refused, because the half
//     that landed looks reviewed.
//
// The other half of "usable by a model" is not in this file at all: it is that
// every block has a text form (`sclExport.ts`), every check has a line number
// (`analyze.ts`), and the instruction catalogue is data rather than a drawing
// (`instructions.ts`). A model can read all three without being given a single
// screenshot.

import {
  PlcBlock, PlcBlockKind, PlcLanguage, PlcNetwork, PlcProject, PlcSection, PlcVar,
  isGraphical, newBlock, newId, newVar, sectionsFor,
} from './model';
import { Problem, analyzeProject } from './analyze';
import { blockToScl } from './sclExport';
import { briefing, instructionByName } from './instructions';
import { DATA_TYPE_NAMES, dataTypeInfo } from './dataTypes';

// ── Out: what the model is told ─────────────────────────────────────────────

export interface SnapshotOptions {
  /** Write the bodies out, not just the interfaces. Costs the most room. */
  withCode?: boolean;
  /** Only these blocks, by id. Empty means all of them. */
  onlyBlocks?: string[];
  /** Include what is currently wrong with the program. */
  withProblems?: boolean;
  /** Include the instruction vocabulary. */
  withInstructions?: boolean;
}

function varLine(v: PlcVar): string {
  const init = v.defaultValue ? ` := ${v.defaultValue}` : '';
  const note = v.comment ? `  // ${v.comment.replace(/\n/g, ' ')}` : '';
  return `    ${v.section}  ${v.name} : ${v.dataType}${init};${note}`;
}

function blockSummary(b: PlcBlock, withCode: boolean): string {
  const out: string[] = [];
  const num = b.number === undefined ? '' : ` [${b.kind}${b.number}]`;
  out.push(`### ${b.kind} "${b.name}"${num} — ${b.language}`);
  if (b.comment) out.push(`  ${b.comment.replace(/\n/g, ' ')}`);
  if (b.dbKind === 'instance') out.push(`  instance data block of "${b.instanceOf}"`);
  if (b.interface.length > 0) {
    out.push('  interface:');
    for (const v of b.interface) out.push(varLine(v));
  } else {
    out.push('  interface: (nothing declared)');
  }
  if (withCode) {
    out.push('  body:');
    out.push(blockToScl(b).split('\n').map(l => `    ${l}`).join('\n'));
  } else if (b.networks?.length) {
    out.push(`  body: ${b.networks.length} network(s) — `
      + b.networks.map(n => `${n.rung.number}:${n.title}`).join(', '));
  } else if (b.code?.trim()) {
    out.push(`  body: ${b.code.split('\n').length} lines of ${b.language}`);
  } else {
    out.push('  body: empty');
  }
  return out.join('\n');
}

/**
 * The project, written for a model.
 *
 * Markdown rather than JSON, and deliberately: every model reads prose with
 * headings better than it reads a nested object, and the parts that have to be
 * exact — names, types, addresses — are exact either way. JSON is what comes
 * *back*, where being exact is the whole job.
 */
export function snapshot(project: PlcProject, opts: SnapshotOptions = {}): string {
  const {
    withCode = false, onlyBlocks = [], withProblems = true, withInstructions = false,
  } = opts;

  const out: string[] = [];
  out.push(`# ${project.device.name} — ${project.device.cpu} (${project.device.vendor})`);
  out.push('');

  out.push('## PLC tags');
  out.push('These name the wiring. Write programs against these names, not against addresses.');
  for (const table of project.tagTables) {
    out.push(`### ${table.name}`);
    if (table.tags.length === 0) out.push('  (empty)');
    for (const t of table.tags) {
      out.push(`  ${t.name} : ${t.dataType} @ ${t.address || '(no address)'}`
        + `${t.comment ? `  // ${t.comment}` : ''}`);
    }
  }
  out.push('');

  out.push('## Blocks');
  const blocks = onlyBlocks.length > 0
    ? project.blocks.filter(b => onlyBlocks.includes(b.id))
    : project.blocks;
  if (blocks.length === 0) out.push('(none)');
  for (const b of blocks) { out.push(blockSummary(b, withCode)); out.push(''); }

  if (withProblems) {
    const problems = analyzeProject(project);
    out.push('## What is currently wrong');
    if (problems.length === 0) out.push('Nothing the checker can see.');
    for (const p of problems.slice(0, 60)) {
      const where = p.line ? `line ${p.line}` : p.networkNumber ? `network ${p.networkNumber}` : '';
      out.push(`- [${p.severity}] ${p.blockName}${where ? ` ${where}` : ''}: ${p.message}`);
    }
    if (problems.length > 60) out.push(`- …and ${problems.length - 60} more.`);
    out.push('');
  }

  if (withInstructions) {
    out.push('## The instruction vocabulary');
    out.push('Use these and nothing else. A block name not in this list and not in');
    out.push('the block list above does not exist on this controller.');
    out.push('');
    out.push(briefing(['basic']));
    out.push('');
  }

  out.push('## The types');
  out.push(DATA_TYPE_NAMES.join(', '));

  return out.join('\n');
}

/**
 * What the answer has to look like, written as an example.
 *
 * A worked example beats a schema for every model small enough to run on a
 * machine in an office, and this one is a real block — an interlock with a
 * declared interface and two networks — so copying its shape produces
 * something that works rather than something that merely parses.
 */
export const ANSWER_SHAPE = `{
  "summary": "one sentence on what was written and why",
  "blocks": [
    {
      "name": "Motor_Control",
      "kind": "FB",
      "language": "SCL",
      "comment": "Start/stop with a seal-in and a run-on timer.",
      "interface": [
        { "section": "Input",  "name": "Start",   "dataType": "Bool", "comment": "Start button" },
        { "section": "Input",  "name": "Stop",    "dataType": "Bool", "comment": "Stop button, NC contact" },
        { "section": "Output", "name": "Running", "dataType": "Bool" },
        { "section": "Static", "name": "OffDelay","dataType": "TOF",  "comment": "run-on" }
      ],
      "code": "IF #Stop AND #Start THEN\\n    #Running := TRUE;\\nELSIF NOT #Stop THEN\\n    #Running := FALSE;\\nEND_IF;"
    }
  ],
  "tags": [
    { "name": "Start_PB", "dataType": "Bool", "address": "%I0.0", "comment": "Start push button" }
  ],
  "notes": ["anything the engineer must check before this is used"]
}`;

/** The same, for a block that should be drawn as ladder rather than written. */
export const LADDER_SHAPE = `A LAD or FBD block has "networks" instead of "code":

  "networks": [
    {
      "title": "Start and stop with seal-in",
      "comment": "why it is built this way",
      "rung": {
        "groups": [
          { "branches": [ { "elements": [ {"k":"no","at":"\\"Start_PB\\"","label":"Start"} ] },
                          { "elements": [ {"k":"no","at":"\\"Motor\\"","label":"Seal-in"} ] } ] },
          { "branches": [ { "elements": [ {"k":"no","at":"\\"Stop_PB\\"","label":"Stop"} ] } ] }
        ],
        "outputs": [ {"k":"coil","at":"\\"Motor\\"","label":"Motor contactor"} ]
      }
    }
  ]

"groups" are in SERIES — current must pass every one.
"branches" inside a group are in PARALLEL — any one of them passing is enough.
"elements" inside a branch are in SERIES with each other.
A contact's "k" is "no", "nc", "p" or "n"; an output's is "coil", "set",
"reset", "pulse-p" or "pulse-n". A box is
{"k":"block","type":"TON","name":"#Timer","pins":[{"name":"IN","value":"..."},
{"name":"PT","value":"T#5s"},{"name":"Q","out":true}]}.`;

// ── In: what comes back ─────────────────────────────────────────────────────

export interface GeneratedTag {
  name: string; dataType: string; address: string; comment?: string;
}

export interface Generated {
  summary: string;
  blocks: PlcBlock[];
  tags: GeneratedTag[];
  notes: string[];
  /** What could not be used, in words an engineer can act on. */
  dropped: string[];
}

const text = (v: unknown, limit = 400): string =>
  typeof v === 'string' ? v.trim().slice(0, limit) : '';

const KINDS: PlcBlockKind[] = ['OB', 'FC', 'FB', 'DB', 'UDT'];
const LANGS: PlcLanguage[] = ['SCL', 'LAD', 'FBD', 'STL', 'GRAPH'];
const SECTIONS: PlcSection[] = ['Input', 'Output', 'InOut', 'Static', 'Temp', 'Constant', 'Return'];

function readGeneratedVar(raw: unknown, kind: PlcBlockKind, dropped: string[]): PlcVar | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = text(r.name, 128);
  if (!name) return null;
  if (!/^[A-Za-z_]\w*$/.test(name)) {
    dropped.push(`"${name}" is not a name a controller will take, so that declaration was left out.`);
    return null;
  }
  let section = SECTIONS.find(s => s === r.section) ?? 'Static';
  const allowed = sectionsFor(kind);
  if (!allowed.includes(section)) {
    // Not dropped: a model putting a working variable in Static on an FC has
    // the right variable and the wrong home, and Temp is where it belongs.
    const moved: PlcSection = allowed.includes('Temp') ? 'Temp' : allowed[0];
    dropped.push(`${name} was declared ${section}, which a ${kind} does not have — moved to ${moved}.`);
    section = moved;
  }
  const dataType = text(r.dataType, 160) || 'Bool';
  if (!dataTypeInfo(dataType) && !/^"|^array/i.test(dataType) && !instructionByName(dataType)) {
    dropped.push(`${name} was declared as "${dataType}", which is not a type this controller has — `
      + 'kept as written, so it can be corrected in the grid.');
  }
  return newVar(section, {
    name,
    dataType,
    defaultValue: text(r.defaultValue, 200) || undefined,
    comment: text(r.comment, 400) || undefined,
  });
}

function readGeneratedNetwork(raw: unknown, n: number, dropped: string[]): PlcNetwork | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const rr = (r.rung ?? r) as Record<string, unknown>;

  const groups = (Array.isArray(rr.groups) ? rr.groups : []).map(g => {
    const gr = (g ?? {}) as Record<string, unknown>;
    const branches = (Array.isArray(gr.branches) ? gr.branches : []).map(b => {
      const br = (b ?? {}) as Record<string, unknown>;
      const elements = (Array.isArray(br.elements) ? br.elements : [])
        .map(e => {
          const el = (e ?? {}) as Record<string, unknown>;
          if (el.k === 'block') {
            const type = text(el.type, 32).toUpperCase();
            if (!type) return null;
            if (!instructionByName(type)) {
              dropped.push(`Network ${n} used a box called ${type}, which is not an instruction — `
                + 'it is drawn so it can be corrected, but it will not compile.');
            }
            return {
              k: 'block' as const,
              type,
              name: text(el.name, 32) || undefined,
              label: text(el.label, 120) || undefined,
              pins: (Array.isArray(el.pins) ? el.pins : []).slice(0, 12).map(p => {
                const pin = (p ?? {}) as Record<string, unknown>;
                return {
                  name: text(pin.name, 16),
                  value: text(pin.value, 64) || undefined,
                  out: pin.out === true,
                };
              }).filter(p => p.name),
            };
          }
          const k = ['no', 'nc', 'p', 'n'].find(x => x === el.k) as 'no' | 'nc' | 'p' | 'n' | undefined;
          const at = text(el.at, 64);
          if (!k || !at) return null;
          return { k, at, label: text(el.label, 120) || undefined };
        })
        .filter(Boolean);
      return { elements: elements as never[] };
    });
    return { branches: branches.length > 0 ? branches : [{ elements: [] as never[] }] };
  });

  const outputs = (Array.isArray(rr.outputs) ? rr.outputs : [])
    .map(o => {
      const out = (o ?? {}) as Record<string, unknown>;
      const k = ['coil', 'set', 'reset', 'pulse-p', 'pulse-n'].find(x => x === out.k) ?? 'coil';
      const at = text(out.at, 64);
      if (!at) return null;
      return { k: k as 'coil', at, label: text(out.label, 120) || undefined };
    })
    .filter(Boolean) as { k: 'coil'; at: string; label?: string }[];

  return {
    id: newId('n'),
    title: text(r.title, 200) || `Network ${n}`,
    comment: text(r.comment, 2000) || undefined,
    rung: { number: n, groups, outputs },
  };
}

/**
 * A generated answer, turned into blocks.
 *
 * Never throws and never half-applies: what it returns is what may be written
 * into the project, and everything it refused is in `dropped` with a reason.
 */
export function readGenerated(raw: unknown): Generated {
  const dropped: string[] = [];
  const r = (raw ?? {}) as Record<string, unknown>;

  const blocks: PlcBlock[] = [];
  for (const rawBlock of Array.isArray(r.blocks) ? r.blocks.slice(0, 40) : []) {
    const b = (rawBlock ?? {}) as Record<string, unknown>;
    const name = text(b.name, 128);
    if (!name) { dropped.push('A block with no name was left out.'); continue; }
    if (!/^[A-Za-z_]\w*$/.test(name)) {
      dropped.push(`"${name}" is not a block name a controller will take — left out.`);
      continue;
    }
    const kind = KINDS.find(k => k === b.kind) ?? 'FC';
    const language = LANGS.find(l => l === b.language) ?? 'SCL';

    const iface = (Array.isArray(b.interface) ? b.interface.slice(0, 500) : [])
      .map(v => readGeneratedVar(v, kind, dropped))
      .filter((v): v is PlcVar => v !== null);

    const networks = Array.isArray(b.networks)
      ? b.networks.slice(0, 200)
        .map((n, idx) => readGeneratedNetwork(n, idx + 1, dropped))
        .filter((n): n is PlcNetwork => n !== null)
      : undefined;

    const code = typeof b.code === 'string' ? b.code.slice(0, 200_000) : undefined;

    // A block that claims a graphical language and arrives as text is taken at
    // its body rather than at its word: the body is the thing that exists.
    const realLanguage: PlcLanguage = networks?.length
      ? (isGraphical(language) ? language : 'LAD')
      : (isGraphical(language) ? 'SCL' : language);
    if (realLanguage !== language) {
      dropped.push(`"${name}" said it was ${language} and arrived as ${networks?.length ? 'networks' : 'text'} `
        + `— opened as ${realLanguage}.`);
    }

    blocks.push(newBlock(kind, {
      name,
      language: realLanguage,
      comment: text(b.comment, 2000) || undefined,
      interface: iface,
      networks: networks?.length ? networks : (isGraphical(realLanguage) ? [] : undefined),
      code: networks?.length ? undefined : (code ?? ''),
      number: Number.isFinite(Number(b.number)) ? Math.max(0, Math.round(Number(b.number))) : undefined,
    }));
  }

  const tags: GeneratedTag[] = [];
  for (const t of Array.isArray(r.tags) ? r.tags.slice(0, 500) : []) {
    const tag = (t ?? {}) as Record<string, unknown>;
    const name = text(tag.name, 128);
    if (!name) continue;
    tags.push({
      name,
      dataType: text(tag.dataType, 64) || 'Bool',
      address: text(tag.address, 64),
      comment: text(tag.comment, 400) || undefined,
    });
  }

  const notes = (Array.isArray(r.notes) ? r.notes.slice(0, 20) : [])
    .map(n => text(n, 600)).filter(Boolean);

  if (blocks.length === 0 && tags.length === 0) {
    dropped.push('Nothing in the answer was a block or a tag.');
  }

  return { summary: text(r.summary, 600), blocks, tags, notes, dropped };
}

/**
 * What applying this would change, said before it is applied.
 *
 * The one thing a generated program must never do is overwrite work without
 * saying so. A block whose name is already taken is a replacement, and a
 * replacement of something an engineer spent the afternoon on is a different
 * decision from adding something new — so the two are counted separately and
 * the panel shows both before the button is pressed.
 */
export interface ApplyPlan {
  added: PlcBlock[];
  replaced: { incoming: PlcBlock; existing: PlcBlock }[];
  newTags: GeneratedTag[];
  /** Tags whose name is taken and whose address differs from the one on file. */
  changedTags: { incoming: GeneratedTag; existingAddress: string }[];
}

export function planApply(project: PlcProject, generated: Generated): ApplyPlan {
  const byName = new Map(project.blocks.map(b => [b.name.toLowerCase(), b]));
  const added: PlcBlock[] = [];
  const replaced: ApplyPlan['replaced'] = [];
  for (const b of generated.blocks) {
    const existing = byName.get(b.name.toLowerCase());
    if (existing) replaced.push({ incoming: b, existing });
    else added.push(b);
  }

  const tagByName = new Map(
    project.tagTables.flatMap(t => t.tags).map(t => [t.name.toLowerCase(), t]));
  const newTags: GeneratedTag[] = [];
  const changedTags: ApplyPlan['changedTags'] = [];
  for (const t of generated.tags) {
    const existing = tagByName.get(t.name.toLowerCase());
    if (!existing) newTags.push(t);
    else if (t.address && existing.address !== t.address) {
      changedTags.push({ incoming: t, existingAddress: existing.address });
    }
  }
  return { added, replaced, newTags, changedTags };
}

/**
 * The project with the generated work in it.
 *
 * A replaced block keeps its **id**, so everything pointing at it — an
 * instance DB, the tab that is open, the tree's selection — still points at
 * it. Replacing by deleting and adding would give a new id and quietly detach
 * all three.
 */
export function applyGenerated(
  project: PlcProject, generated: Generated, opts: { takeTags: boolean } = { takeTags: true },
): PlcProject {
  const byName = new Map(project.blocks.map(b => [b.name.toLowerCase(), b]));
  const blocks = [...project.blocks];

  for (const incoming of generated.blocks) {
    const existing = byName.get(incoming.name.toLowerCase());
    if (existing) {
      const at = blocks.findIndex(b => b.id === existing.id);
      blocks[at] = {
        ...incoming,
        id: existing.id,
        number: incoming.number ?? existing.number,
        createdAt: existing.createdAt,
        changedAt: new Date().toISOString(),
      };
    } else {
      blocks.push(incoming);
    }
  }

  let tagTables = project.tagTables;
  if (opts.takeTags && generated.tags.length > 0) {
    const defaultTable = tagTables.find(t => t.isDefault) ?? tagTables[0];
    if (defaultTable) {
      const have = new Set(tagTables.flatMap(t => t.tags).map(t => t.name.toLowerCase()));
      const fresh = generated.tags
        .filter(t => !have.has(t.name.toLowerCase()))
        .map(t => ({
          id: newId('t'), name: t.name, dataType: t.dataType,
          address: t.address, comment: t.comment,
        }));
      if (fresh.length > 0) {
        tagTables = tagTables.map(t =>
          t.id === defaultTable.id ? { ...t, tags: [...t.tags, ...fresh] } : t);
      }
    }
  }

  return { ...project, blocks, tagTables, changedAt: new Date().toISOString() };
}

/** The problems, as a list a model can be handed to fix. */
export function problemsForModel(problems: Problem[]): string {
  return problems.map(p => {
    const where = p.line ? `:${p.line}` : p.networkNumber ? ` network ${p.networkNumber}` : '';
    return `${p.severity.toUpperCase()} ${p.blockName}${where} [${p.code}] ${p.message}`;
  }).join('\n');
}
