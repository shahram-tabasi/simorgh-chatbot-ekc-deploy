// src/utils/plc/sclExport.ts
//
// Every block, written out as text.
//
// Two reasons this exists, and the second is the larger one.
//
// The first is the obvious one: an engineer wants the program out of this app
// and into theirs, and an external source file is how a Siemens program
// travels. What is produced here follows the shape of a TIA external source —
// block header, declaration sections, `BEGIN`, body — closely enough to be
// pasted in and read. **It is not certified to import unchanged**, and this
// app does not claim it is; what it is certified to do is say exactly what the
// program is, in a form an engineer can check line by line.
//
// The second is that **text is what can be reviewed**. A ladder network drawn
// on a canvas cannot go in a mail, cannot be diffed against last week's, and
// cannot be handed to a model to look at. The same network as six lines of SCL
// can be all three. So every graphical network is compiled here too, and the
// compilation is exact rather than approximate: series is AND, parallel is OR,
// a coil is an assignment, and a set coil is an assignment under a condition.
//
// The one thing that does not survive the trip is an edge. `-|P|-` keeps its
// state in a memory bit chosen on the rung, and there is no honest one-line
// SCL for it — so it is written as the two lines it really is, with the memory
// named, rather than as something shorter that would be wrong.

import { Block, Contact, Coil, Element, Group, Rung } from '../ladder/model';
import {
  PlcBlock, PlcNetwork, PlcProject, PlcVar, PlcSection, sectionVars,
} from './model';
import { isArrayType } from './dataTypes';

const INDENT = '    ';

/** A comment block, wrapped so it reads in a narrow editor. */
function comment(text: string | undefined, indent = ''): string[] {
  if (!text?.trim()) return [];
  const out: string[] = [];
  for (const line of text.split('\n')) {
    let rest = line.trimEnd();
    if (!rest) { out.push(`${indent}//`); continue; }
    while (rest.length > 88) {
      let cut = rest.lastIndexOf(' ', 88);
      if (cut < 40) cut = 88;
      out.push(`${indent}// ${rest.slice(0, cut)}`);
      rest = rest.slice(cut).trimStart();
    }
    out.push(`${indent}// ${rest}`);
  }
  return out;
}

// ── One rung, as an expression ──────────────────────────────────────────────

/**
 * What a contact contributes to the condition.
 *
 * An edge contact is not an expression — it is a comparison against what the
 * operand was last scan — so it comes back as a term that names the memory and
 * a line that has to run afterwards. `edges` collects those; the caller emits
 * them under the network.
 */
function contactTerm(c: Contact, edges: string[]): string {
  const at = operand(c.at);
  switch (c.k) {
    case 'no': return at;
    case 'nc': return `NOT ${at}`;
    case 'p': {
      const mem = `#${safeName(c.at)}_Last`;
      edges.push(`${mem} := ${at};`);
      return `(${at} AND NOT ${mem})`;
    }
    case 'n': {
      const mem = `#${safeName(c.at)}_Last`;
      edges.push(`${mem} := ${at};`);
      return `(NOT ${at} AND ${mem})`;
    }
  }
}

/** A block inside the condition — a comparator, or a timer read for its Q. */
function blockTerm(b: Block, calls: string[]): string {
  const instr = b.type.toUpperCase();

  // The comparators are the one family that really is an expression, and
  // writing them as one is what makes a compiled network readable.
  const cmp: Record<string, string> = {
    'CMP ==': '=', 'CMP <>': '<>', 'CMP >=': '>=', 'CMP <=': '<=', 'CMP >': '>', 'CMP <': '<',
    EQ: '=', NE: '<>', GE: '>=', LE: '<=', GT: '>', LT: '<',
  };
  const op = cmp[b.type] ?? cmp[instr];
  if (op) {
    const ins = b.pins.filter(p => !p.out);
    return `(${operand(ins[0]?.value)} ${op} ${operand(ins[1]?.value)})`;
  }
  if (instr === 'IN_RANGE') {
    const v = (n: string) => operand(b.pins.find(p => p.name === n)?.value);
    return `(${v('MIN')} <= ${v('VAL')} AND ${v('VAL')} <= ${v('MAX')})`;
  }
  if (instr === 'OUT_RANGE') {
    const v = (n: string) => operand(b.pins.find(p => p.name === n)?.value);
    return `(${v('VAL')} < ${v('MIN')} OR ${v('MAX')} < ${v('VAL')})`;
  }

  // Everything else is a call: it runs, and the term is one of its outputs.
  const instance = b.name ? `#${safeName(b.name)}` : `"${b.type}"`;
  const args = b.pins
    .filter(p => p.value)
    .map(p => `${p.name} ${p.out ? '=>' : ':='} ${operand(p.value)}`)
    .join(', ');
  calls.push(`${instance}(${args});`);
  const q = b.pins.find(p => p.out && (p.name === 'Q' || p.name === 'OUT' || p.name === 'QU'));
  return q ? `${instance}.${q.name}` : 'TRUE';
}

function elementTerm(el: Element, edges: string[], calls: string[]): string {
  return el.k === 'block' ? blockTerm(el, calls) : contactTerm(el, edges);
}

function groupTerm(g: Group, edges: string[], calls: string[]): string {
  const branches = g.branches.map(b => {
    if (b.elements.length === 0) return 'TRUE';   // a wire straight through
    return b.elements.map(e => elementTerm(e, edges, calls)).join(' AND ');
  });
  if (branches.length === 1) return branches[0];
  return `(${branches.join(' OR ')})`;
}

/** The whole left-hand side of a rung, as one expression. */
export function rungCondition(rung: Rung, edges: string[], calls: string[]): string {
  if (rung.groups.length === 0) return 'TRUE';
  const terms = rung.groups.map(g => groupTerm(g, edges, calls)).filter(Boolean);
  return terms.length === 0 ? 'TRUE' : terms.join(' AND ');
}

/** What one output on the right of a rung becomes. */
function outputLines(out: Coil, condition: string, indent: string): string[] {
  const at = operand(out.at);
  switch (out.k) {
    case 'coil':
      return [`${indent}${at} := ${condition};`];
    case 'set':
      return [
        `${indent}IF ${condition} THEN`,
        `${indent}${INDENT}${at} := TRUE;`,
        `${indent}END_IF;`,
      ];
    case 'reset':
      return [
        `${indent}IF ${condition} THEN`,
        `${indent}${INDENT}${at} := FALSE;`,
        `${indent}END_IF;`,
      ];
    case 'pulse-p': {
      const mem = `#${safeName(out.at)}_Trig`;
      return [
        `${indent}${at} := ${condition} AND NOT ${mem};`,
        `${indent}${mem} := ${condition};`,
      ];
    }
    case 'pulse-n': {
      const mem = `#${safeName(out.at)}_Trig`;
      return [
        `${indent}${at} := NOT (${condition}) AND ${mem};`,
        `${indent}${mem} := ${condition};`,
      ];
    }
  }
}

/**
 * How an operand is written in SCL.
 *
 * A tag keeps its quotes, a local keeps its `#`, an address is written as it
 * is, and a bare name is assumed to be a tag and quoted — which is what an
 * engineer typing `Motor` into a contact meant.
 */
function operand(v: string | undefined): string {
  const s = (v ?? '').trim();
  if (!s) return 'FALSE';
  if (s.startsWith('%') || s.startsWith('#') || s.startsWith('"')) return s;
  if (/^(TRUE|FALSE)$/i.test(s)) return s.toUpperCase();
  if (/^[-+]?\d/.test(s)) return s;                     // a number or a literal
  if (/^[A-Za-z_]\w*#/.test(s)) return s;               // T#5s, 16#FF
  return `"${s}"`;
}

/** A name that can be part of an identifier. */
const safeName = (v: string): string =>
  (v ?? '').replace(/^[%#"]+|"+$/g, '').replace(/[^A-Za-z0-9_]/g, '_') || 'X';

/** One network, as SCL. */
export function networkToScl(net: PlcNetwork, indent = ''): string[] {
  const lines: string[] = [];
  const head = `Network ${net.rung.number}${net.title ? `: ${net.title}` : ''}`;
  lines.push(`${indent}// ── ${head} ${'─'.repeat(Math.max(0, 60 - head.length))}`);
  lines.push(...comment(net.comment, indent));
  if (net.disabled) {
    lines.push(`${indent}// (this network is switched off in the editor)`);
  }

  const edges: string[] = [];
  const calls: string[] = [];
  const condition = rungCondition(net.rung, edges, calls);

  // The calls run before the condition that reads their outputs, which is the
  // order the ladder itself has: a box on the rung has already executed by the
  // time current reaches what is after it.
  for (const call of calls) lines.push(`${indent}${call}`);

  if (net.rung.outputs.length === 0) {
    if (calls.length === 0) lines.push(`${indent}// nothing driven by this network yet`);
  } else {
    for (const out of net.rung.outputs) lines.push(...outputLines(out, condition, indent));
  }

  // The edge memories are written last, after everything that read them —
  // which is what makes "what it was last scan" true.
  for (const edge of edges) lines.push(`${indent}${edge}`);
  lines.push('');
  return lines;
}

// ── One block ───────────────────────────────────────────────────────────────

const SECTION_HEADER: Record<PlcSection, string> = {
  Input: 'VAR_INPUT',
  Output: 'VAR_OUTPUT',
  InOut: 'VAR_IN_OUT',
  Static: 'VAR',
  Temp: 'VAR_TEMP',
  Constant: 'VAR CONSTANT',
  Return: '',           // written on the FUNCTION line, not in a section
};

function declaration(v: PlcVar, indent: string): string[] {
  const out: string[] = [];
  const attrs: string[] = [];
  if (v.visible === false) attrs.push("S7_HMI_Accessible := 'False'");
  if (v.writable === false) attrs.push("S7_HMI_Writeable := 'False'");
  if (attrs.length > 0) out.push(`${indent}{ ${attrs.join(' ; ')} }`);
  const init = v.defaultValue?.trim() ? ` := ${v.defaultValue.trim()}` : '';
  const note = v.comment?.trim() ? `   // ${v.comment.trim().replace(/\n/g, ' ')}` : '';
  out.push(`${indent}${v.name} : ${v.dataType}${init};${note}`);
  if (v.members?.length) {
    // A structure declared in place. The members are one level in, and the
    // section it is in is closed by the caller.
    out.pop();
    out.push(`${indent}${v.name} : Struct${note}`);
    for (const m of v.members) out.push(...declaration(m, `${indent}${INDENT}`));
    out.push(`${indent}END_STRUCT;`);
  }
  return out;
}

function interfaceLines(block: PlcBlock): string[] {
  const lines: string[] = [];
  const order: PlcSection[] = ['Input', 'Output', 'InOut', 'Static', 'Temp', 'Constant'];
  for (const section of order) {
    const vars = sectionVars(block, section);
    if (vars.length === 0) continue;
    const header = SECTION_HEADER[section];
    // Retentive statics are declared in their own VAR RETAIN section, which is
    // how the compiler is told and how a reader sees at a glance what survives.
    const retain = vars.filter(v => v.retain);
    const plain = vars.filter(v => !v.retain);
    if (plain.length > 0) {
      lines.push(`${INDENT}${header}`);
      for (const v of plain) lines.push(...declaration(v, INDENT + INDENT));
      lines.push(`${INDENT}END_VAR`);
    }
    if (retain.length > 0) {
      lines.push(`${INDENT}${header} RETAIN`);
      for (const v of retain) lines.push(...declaration(v, INDENT + INDENT));
      lines.push(`${INDENT}END_VAR`);
    }
  }
  return lines;
}

/** The body, whichever language it is in. */
function bodyLines(block: PlcBlock): string[] {
  if (block.networks?.length) {
    const lines: string[] = [];
    lines.push(`${INDENT}// Compiled from ${block.language}. Series is AND, parallel is OR;`);
    lines.push(`${INDENT}// a coil is an assignment and a set coil is one under a condition.`);
    lines.push('');
    for (const net of block.networks) lines.push(...networkToScl(net, INDENT));
    return lines;
  }
  const code = (block.code ?? '').replace(/\s+$/, '');
  if (!code.trim()) return [`${INDENT};`];
  return code.split('\n').map(l => (l.trim() ? `${INDENT}${l}` : ''));
}

function header(block: PlcBlock): string[] {
  const lines: string[] = [];
  lines.push(...comment(block.comment));
  const name = `"${block.name}"`;
  const ret = sectionVars(block, 'Return')[0];
  switch (block.kind) {
    case 'OB': lines.push(`ORGANIZATION_BLOCK ${name}`); break;
    case 'FB': lines.push(`FUNCTION_BLOCK ${name}`); break;
    case 'FC': lines.push(`FUNCTION ${name} : ${ret?.dataType ?? 'Void'}`); break;
    case 'DB': lines.push(`DATA_BLOCK ${name}`); break;
    case 'UDT': lines.push(`TYPE ${name}`); break;
  }
  lines.push("{ S7_Optimized_Access := 'TRUE' }");
  lines.push(`VERSION : ${block.version ?? '0.1'}`);
  if (block.author) lines.push(`AUTHOR : ${block.author}`);
  if (block.family) lines.push(`FAMILY : ${block.family}`);
  return lines;
}

function footer(kind: PlcBlock['kind']): string {
  switch (kind) {
    case 'OB': return 'END_ORGANIZATION_BLOCK';
    case 'FB': return 'END_FUNCTION_BLOCK';
    case 'FC': return 'END_FUNCTION';
    case 'DB': return 'END_DATA_BLOCK';
    case 'UDT': return 'END_TYPE';
  }
}

/** One block as an external source. */
export function blockToScl(block: PlcBlock): string {
  const lines: string[] = [...header(block)];

  if (block.kind === 'UDT') {
    lines.push(`${INDENT}STRUCT`);
    for (const v of block.interface) lines.push(...declaration(v, INDENT + INDENT));
    lines.push(`${INDENT}END_STRUCT;`);
    lines.push(footer(block.kind));
    return lines.join('\n');
  }

  if (block.kind === 'DB') {
    if (block.dbKind === 'instance' && block.instanceOf) {
      // An instance DB has no declarations of its own: it *is* the FB's
      // interface, and writing it out again would be a second copy to go
      // stale.
      lines.push(`${INDENT}"${block.instanceOf}"`);
      lines.push('BEGIN');
      lines.push('');
      lines.push(footer(block.kind));
      return lines.join('\n');
    }
    lines.push(`${INDENT}VAR`);
    for (const v of block.interface) lines.push(...declaration(v, INDENT + INDENT));
    lines.push(`${INDENT}END_VAR`);
    lines.push('BEGIN');
    lines.push('');
    lines.push(footer(block.kind));
    return lines.join('\n');
  }

  lines.push(...interfaceLines(block));
  lines.push('');
  lines.push('BEGIN');
  lines.push(...bodyLines(block));
  lines.push(footer(block.kind));
  return lines.join('\n');
}

/**
 * The whole program as one source file.
 *
 * In the order a compiler wants it: types first, because everything may use
 * them; then the data blocks; then the functions and function blocks; then the
 * organisation blocks, which call the rest. A file in this order compiles in
 * one pass, and a file in tree order does not.
 */
export function projectToScl(project: PlcProject): string {
  const order: PlcBlock['kind'][] = ['UDT', 'DB', 'FC', 'FB', 'OB'];
  const parts: string[] = [
    `// ${project.device.name} — ${project.device.cpu}`,
    `// Written by Simorgh Soft on ${new Date().toISOString().slice(0, 10)}.`,
    '//',
    '// An external source, for reading and for importing by hand. It is not',
    '// claimed to import unchanged into any vendor\'s software, and nothing in',
    '// it has been checked against a controller.',
    '',
  ];
  for (const kind of order) {
    const blocks = project.blocks.filter(b => b.kind === kind);
    if (blocks.length === 0) continue;
    for (const b of blocks) {
      parts.push(blockToScl(b));
      parts.push('');
    }
  }
  return parts.join('\n');
}

// ── The tag table ───────────────────────────────────────────────────────────

/**
 * The tags, as the .sdf-style CSV Siemens reads.
 *
 * Quoted, comma separated, one tag a line: name, path, data type, logical
 * address, comment, and the HMI flags. The path is `""` for a tag in the
 * default table.
 */
export function tagsToCsv(project: PlcProject): string {
  const rows: string[] = [];
  const q = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`;
  for (const table of project.tagTables) {
    for (const t of table.tags) {
      rows.push([
        q(t.name), q(table.name), q(t.dataType), q(t.address), q(t.comment ?? ''),
        t.visible === false ? 'False' : 'True',
        t.writable === false ? 'False' : 'True',
        t.retain ? 'True' : 'False',
      ].join(','));
    }
  }
  return rows.join('\r\n');
}

/** A readable table, for a document or a mail. */
export function tagsToText(project: PlcProject): string {
  const lines: string[] = [];
  for (const table of project.tagTables) {
    lines.push(`# ${table.name}`);
    const width = Math.max(4, ...table.tags.map(t => t.name.length));
    for (const t of table.tags) {
      lines.push(`  ${t.name.padEnd(width)}  ${t.address.padEnd(12)}  ${t.dataType.padEnd(10)}  ${t.comment ?? ''}`.trimEnd());
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** True where a declared type needs the array brackets kept as written. */
export const keepsBrackets = isArrayType;
