// src/utils/plc/analyze.ts
//
// Reading a program back and saying what is wrong with it.
//
// This is not a compiler and does not pretend to be one. It is the set of
// checks that are worth making **while somebody is typing**, chosen by one
// test: does finding this now save a download? An unclosed `IF`, a variable
// that was renamed in the interface and not in the code, a block called by a
// name nothing answers to, a coil driving nothing — each of those is found in
// milliseconds here and in twenty minutes on a running panel.
//
// What it deliberately does **not** do is decide whether the logic is right.
// No checker can, and one that suggested it could would be worse than none:
// an interlock that compiles is not an interlock that is safe, and the green
// tick is not the engineer's signature.
//
// Every problem carries a place. A list of complaints with no line numbers is
// a list nobody reads twice.

import {
  PlcBlock, PlcNetwork, PlcProject, PlcVar, allTags, sectionsFor,
} from './model';
import {
  addressProblem, assignable, baseTypeName, dataTypeInfo, isUserType, userTypeName,
} from './dataTypes';
import { instructionByName } from './instructions';
import { SCL_CONTROL, SCL_DECL, SCL_LITERALS, SCL_OPERATORS, SCL_TYPES } from './sclLanguage';
import { CHECK_STRINGS, CheckStrings } from './checkLang';

export type Severity = 'error' | 'warning' | 'info';

export interface Problem {
  severity: Severity;
  /** What is wrong, in words somebody can act on. */
  message: string;
  /** A short code, so a problem can be recognised across runs. */
  code: string;
  /** Which block it is in. */
  blockId: string;
  blockName: string;
  /** In a text block: the line, 1-based. */
  line?: number;
  column?: number;
  endColumn?: number;
  /** In a graphical block: which network. */
  networkId?: string;
  networkNumber?: number;
}

// ── Words that are not identifiers ──────────────────────────────────────────

const RESERVED = new Set<string>([
  ...SCL_CONTROL, ...SCL_DECL, ...SCL_OPERATORS, ...SCL_LITERALS, ...SCL_TYPES,
  // The forms of an assignment's right-hand side that look like calls.
  'THEN', 'DO', 'OF', 'TO', 'BY', 'UNTIL',
].map(w => w.toUpperCase()));

/**
 * Functions that are part of the language rather than the catalogue.
 *
 * The conversions are generated — `INT_TO_REAL`, `DWORD_TO_DINT`, and one for
 * every ordered pair — so they are matched by shape rather than listed, which
 * is both shorter and right for the pairs nobody has thought of yet.
 */
const BUILTIN_FUNCTIONS = new Set([
  'ABS', 'SQR', 'SQRT', 'LN', 'EXP', 'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN',
  'MIN', 'MAX', 'LIMIT', 'MUX', 'SEL', 'SHL', 'SHR', 'ROL', 'ROR', 'DECO', 'ENCO',
  'TRUNC', 'ROUND', 'CEIL', 'FLOOR', 'FRAC', 'SCALE_X', 'NORM_X', 'SWAP',
  'LEN', 'CONCAT', 'LEFT', 'RIGHT', 'MID', 'FIND', 'DELETE', 'INSERT', 'REPLACE',
  'MOVE_BLK', 'UMOVE_BLK', 'FILL_BLK', 'UFILL_BLK', 'MOVE_BLK_VARIANT',
  'RESET_TIMER', 'PRESET_TIMER', 'RE_TRIGR', 'STP', 'GET_ERROR', 'GET_ERR_ID',
  'DIS_AIRT', 'EN_AIRT', 'RD_SYS_T', 'RD_LOC_T', 'WR_SYS_T', 'T_ADD', 'T_SUB',
  'T_DIFF', 'T_COMBINE', 'RUNTIME', 'COUNTOFELEMENTS', 'LOWER_BOUND', 'UPPER_BOUND',
  'IS_NULL', 'NOT_NULL', 'IS_ARRAY', 'TYPEOF', 'TYPEOFELEMENT',
]);

const CONVERSION = /^(BOOL|BYTE|WORD|DWORD|LWORD|SINT|USINT|INT|UINT|DINT|UDINT|LINT|ULINT|REAL|LREAL|TIME|LTIME|DATE|TOD|LTOD|DT|DTL|LDT|CHAR|WCHAR|STRING|WSTRING|BCD16|BCD32)_TO_(BOOL|BYTE|WORD|DWORD|LWORD|SINT|USINT|INT|UINT|DINT|UDINT|LINT|ULINT|REAL|LREAL|TIME|LTIME|DATE|TOD|LTOD|DT|DTL|LDT|CHAR|WCHAR|STRING|WSTRING|BCD16|BCD32)$/;

// ── Taking the code apart ───────────────────────────────────────────────────

/**
 * The code with its comments and strings blanked out, line structure kept.
 *
 * Every check below looks for words, and a word inside a comment is not a
 * word — an `IF` in a sentence explaining the network would otherwise be
 * counted as an unclosed statement, which teaches an engineer to ignore the
 * problem list, which is the worst thing a problem list can do. Blanking
 * rather than removing keeps every line number and column exactly where it
 * was.
 */
export function stripNonCode(code: string): string {
  let out = '';
  let i = 0;
  let state: 'code' | 'line' | 'block' | 'str' | 'name' = 'code';
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '(' && next === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'str'; out += ' '; i += 1; continue; }
      if (c === '"') { state = 'name'; out += '"'; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; } else out += ' ';
      i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && next === ')') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' '; i += 1; continue;
    }
    if (state === 'str') {
      // `$'` is the escape for a quote inside an SCL string.
      if (c === '$' && next) { out += '  '; i += 2; continue; }
      if (c === "'") { state = 'code'; out += ' '; i += 1; continue; }
      out += c === '\n' ? '\n' : ' '; i += 1; continue;
    }
    // A quoted name is code — it is how a block or a tag is written — so it is
    // kept, and only the newline case needs guarding.
    if (c === '"') { state = 'code'; out += '"'; i += 1; continue; }
    if (c === '\n') { state = 'code'; out += '\n'; i += 1; continue; }
    out += c; i += 1;
  }
  return out;
}

interface Word { text: string; line: number; column: number; }

/** Every bare word in the code, with where it is. */
function words(code: string): Word[] {
  const found: Word[] = [];
  const lines = code.split('\n');
  lines.forEach((text, li) => {
    for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      found.push({ text: m[0], line: li + 1, column: (m.index ?? 0) + 1 });
    }
  });
  return found;
}

// ── What a block knows the names of ─────────────────────────────────────────

export interface Scope {
  /** Names declared in this block — without the `#`. */
  locals: Set<string>;
  /** Block and PLC-data-type names, without the quotes. */
  blocks: Set<string>;
  /** PLC tag names. */
  tags: Set<string>;
  /** The declared variables by lower-cased name, for type questions. */
  varsByName: Map<string, PlcVar>;
}

export function scopeOf(project: PlcProject, block: PlcBlock): Scope {
  const locals = new Set<string>();
  const varsByName = new Map<string, PlcVar>();
  const walk = (vars: PlcVar[]) => {
    for (const v of vars) {
      if (v.name) { locals.add(v.name.toLowerCase()); varsByName.set(v.name.toLowerCase(), v); }
      if (v.members) walk(v.members);
    }
  };
  walk(block.interface);
  return {
    locals,
    blocks: new Set(project.blocks.map(b => b.name.toLowerCase())),
    tags: new Set(allTags(project).map(t => t.name.toLowerCase())),
    varsByName,
  };
}

// ── The checks on a text block ──────────────────────────────────────────────

interface Open { word: string; line: number; column: number; }

/**
 * The statements that were opened and never closed, and the reverse.
 *
 * Counted with a stack rather than by tallying, so the message can name the
 * line the `IF` was on — which is the one piece of information that turns
 * "something is unbalanced" into a fix.
 */
function checkStructure(
  code: string, say: CheckStrings, add: (p: Omit<Problem, 'blockId' | 'blockName'>) => void,
): void {
  const stack: Open[] = [];
  const opens = new Set(['IF', 'CASE', 'FOR', 'WHILE', 'REPEAT', 'REGION', 'STRUCT']);
  const closeOf: Record<string, string> = {
    END_IF: 'IF', END_CASE: 'CASE', END_FOR: 'FOR', END_WHILE: 'WHILE',
    END_REPEAT: 'REPEAT', END_REGION: 'REGION', END_STRUCT: 'STRUCT',
  };

  for (const w of words(code)) {
    const upper = w.text.toUpperCase();
    if (opens.has(upper)) {
      // `END_IF` tokenizes as one word, so an `IF` here is always an opening
      // one. `ELSIF` does not open a new statement and does not reach here.
      stack.push({ word: upper, line: w.line, column: w.column });
      continue;
    }
    const wants = closeOf[upper];
    if (!wants) continue;
    const top = stack[stack.length - 1];
    if (!top) {
      add({
        severity: 'error', code: 'scl.unopened',
        message: say.unopened(upper, wants),
        line: w.line, column: w.column, endColumn: w.column + w.text.length,
      });
      continue;
    }
    if (top.word !== wants) {
      add({
        severity: 'error', code: 'scl.mismatch',
        message: say.mismatch(upper, wants, top.word, top.line),
        line: w.line, column: w.column, endColumn: w.column + w.text.length,
      });
      // Popped anyway: carrying a wrong pairing forward turns one real problem
      // into a cascade of invented ones.
      stack.pop();
      continue;
    }
    stack.pop();
  }

  for (const open of stack) {
    add({
      severity: 'error', code: 'scl.unclosed',
      message: say.unclosed(open.word, open.line),
      line: open.line, column: open.column, endColumn: open.column + open.word.length,
    });
  }
}

/** Names used in the code that nothing in the project answers to. */
function checkNames(
  code: string, scope: Scope, say: CheckStrings,
  add: (p: Omit<Problem, 'blockId' | 'blockName'>) => void,
): void {
  const lines = code.split('\n');

  lines.forEach((text, li) => {
    // Locals: #Name
    for (const m of text.matchAll(/#([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = m[1];
      if (scope.locals.has(name.toLowerCase())) continue;
      add({
        severity: 'error', code: 'scl.undeclared',
        message: say.undeclared(name),
        line: li + 1, column: (m.index ?? 0) + 1, endColumn: (m.index ?? 0) + 2 + name.length,
      });
    }

    // Quoted names: blocks, PLC data types and tags.
    for (const m of text.matchAll(/"([^"\n]{1,120})"/g)) {
      const raw = m[1];
      // `"Motor_DB".Speed` — only the part before the dot is the block.
      const name = raw.split('.')[0].trim();
      const low = name.toLowerCase();
      if (scope.blocks.has(low) || scope.tags.has(low)) continue;
      add({
        severity: 'warning', code: 'scl.unknown-name',
        message: say.unknownName(name),
        line: li + 1, column: (m.index ?? 0) + 1, endColumn: (m.index ?? 0) + 2 + raw.length,
      });
    }
  });
}

/** Calls to something with a name no instruction and no block has. */
function checkCalls(
  code: string, scope: Scope, say: CheckStrings,
  add: (p: Omit<Problem, 'blockId' | 'blockName'>) => void,
): void {
  const lines = code.split('\n');
  lines.forEach((text, li) => {
    for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const name = m[1];
      const upper = name.toUpperCase();
      if (RESERVED.has(upper)) continue;
      if (BUILTIN_FUNCTIONS.has(upper)) continue;
      if (CONVERSION.test(upper)) continue;
      if (instructionByName(name)) continue;
      if (scope.locals.has(name.toLowerCase())) continue;   // a local instance
      if (scope.blocks.has(name.toLowerCase())) continue;
      add({
        severity: 'warning', code: 'scl.unknown-call',
        message: say.unknownCall(name),
        line: li + 1, column: (m.index ?? 0) + 1, endColumn: (m.index ?? 0) + 1 + name.length,
      });
    }
  });
}

/** Writing to something that may not be written. */
function checkWrites(
  code: string, scope: Scope, say: CheckStrings,
  add: (p: Omit<Problem, 'blockId' | 'blockName'>) => void,
): void {
  const lines = code.split('\n');
  lines.forEach((text, li) => {
    // `#Name := ...` at the start of a statement. The base name before any
    // `.field` or `[index]` is the one that carries the section.
    const m = /^\s*#([A-Za-z_][A-Za-z0-9_]*)[^:=<>]*:=/.exec(text);
    if (!m) return;
    const v = scope.varsByName.get(m[1].toLowerCase());
    if (!v) return;
    if (v.section === 'Input') {
      add({
        severity: 'error', code: 'scl.write-input',
        message: say.writeInput(v.name),
        line: li + 1, column: (m.index ?? 0) + 1, endColumn: text.length + 1,
      });
    }
    if (v.section === 'Constant') {
      add({
        severity: 'error', code: 'scl.write-constant',
        message: say.writeConstant(v.name),
        line: li + 1, column: 1, endColumn: text.length + 1,
      });
    }
  });
}

/** The two arithmetic traps that are always worth saying out loud. */
function checkArithmetic(
  code: string, scope: Scope, say: CheckStrings,
  add: (p: Omit<Problem, 'blockId' | 'blockName'>) => void,
): void {
  const lines = code.split('\n');
  lines.forEach((text, li) => {
    // Dividing by a literal zero. Not a guess — it is a CPU fault every time.
    for (const m of text.matchAll(/\/\s*0(?![.\d])/g)) {
      add({
        severity: 'error', code: 'scl.div-zero',
        message: say.divZero(),
        line: li + 1, column: (m.index ?? 0) + 1, endColumn: (m.index ?? 0) + 2,
      });
    }

    // Comparing two Reals for equality. Found by looking at the declared types
    // of the two sides, so a comparison of two Ints is left alone.
    for (const m of text.matchAll(/#([A-Za-z_]\w*)\s*(=|<>)\s*#([A-Za-z_]\w*)/g)) {
      const a = scope.varsByName.get(m[1].toLowerCase());
      const b = scope.varsByName.get(m[3].toLowerCase());
      if (!a || !b) continue;
      if (dataTypeInfo(a.dataType)?.group !== 'real') continue;
      if (dataTypeInfo(b.dataType)?.group !== 'real') continue;
      add({
        severity: 'warning', code: 'scl.real-equality',
        message: say.realEquality(),
        line: li + 1, column: (m.index ?? 0) + 1, endColumn: (m.index ?? 0) + 1 + m[0].length,
      });
    }
  });
}

// ── The checks on a graphical block ─────────────────────────────────────────

function checkNetwork(
  net: PlcNetwork, scope: Scope, say: CheckStrings,
  add: (p: Omit<Problem, 'blockId' | 'blockName'>) => void,
): void {
  const at = { networkId: net.id, networkNumber: net.rung.number };
  const known = (operand: string): boolean => {
    const s = (operand ?? '').trim();
    if (!s) return false;
    if (s.startsWith('%')) return true;                       // an address
    if (s.startsWith('#')) return scope.locals.has(s.slice(1).split(/[.[]/)[0].toLowerCase());
    if (s.startsWith('"')) return scope.blocks.has(s.replace(/"/g, '').split('.')[0].toLowerCase())
      || scope.tags.has(s.replace(/"/g, '').split('.')[0].toLowerCase());
    return scope.tags.has(s.split(/[.[]/)[0].toLowerCase());
  };

  let elements = 0;
  for (const [gi, group] of net.rung.groups.entries()) {
    // A parallel path with nothing in it is a wire, and a wire in parallel
    // with a contact means the contact is never tested: the whole column is
    // true every scan. It draws as an empty rectangle and reads as a branch
    // somebody is half way through, which is exactly when it is worth saying
    // out loud.
    if (group.branches.length > 1 && group.branches.some(b => b.elements.length === 0)) {
      add({
        severity: 'warning', code: 'lad.empty-branch', ...at,
        message: say.ladEmptyBranch(net.rung.number, gi + 1),
      });
    }
    for (const branch of group.branches) {
      for (const el of branch.elements) {
        elements += 1;
        if (el.k === 'block') {
          if (el.type && el.type !== '???' && !instructionByName(el.type) && !scope.blocks.has(el.type.toLowerCase())) {
            add({
              severity: 'warning', code: 'lad.unknown-block', ...at,
              message: say.ladUnknownBlock(net.rung.number, el.type),
            });
          }
          const needsInstance = el.type ? instructionByName(el.type)?.instance : false;
          if (needsInstance && !el.name) {
            add({
              severity: 'error', code: 'lad.no-instance', ...at,
              message: say.ladNoInstance(net.rung.number, el.type ?? '?'),
            });
          }
          continue;
        }
        if (!el.at) {
          add({
            severity: 'error', code: 'lad.no-operand', ...at,
            message: say.ladNoOperand(net.rung.number),
          });
        } else if (!known(el.at)) {
          add({
            severity: 'warning', code: 'lad.unknown-operand', ...at,
            message: say.ladUnknownOperand(net.rung.number, el.at),
          });
        }
      }
    }
  }

  for (const out of net.rung.outputs) {
    if (!out.at) {
      add({
        severity: 'error', code: 'lad.no-coil-operand', ...at,
        message: say.ladNoCoilOperand(net.rung.number),
      });
    } else if (!known(out.at)) {
      add({
        severity: 'warning', code: 'lad.unknown-operand', ...at,
        message: say.ladUnknownOperand(net.rung.number, out.at),
      });
    }
  }

  if (elements > 0 && net.rung.outputs.length === 0) {
    add({
      severity: 'warning', code: 'lad.no-output', ...at,
      message: say.ladNoOutput(net.rung.number),
    });
  }
  if (elements === 0 && net.rung.outputs.length > 0) {
    add({
      severity: 'info', code: 'lad.always-on', ...at,
      message: say.ladAlwaysOn(net.rung.number),
    });
  }
  if (!net.title.trim() && !net.comment?.trim() && elements + net.rung.outputs.length > 0) {
    add({
      severity: 'info', code: 'lad.no-title', ...at,
      message: say.ladNoTitle(net.rung.number),
    });
  }
}

// ── The checks on the declarations ──────────────────────────────────────────

/**
 * True where the type is an instruction that keeps its own state.
 *
 * `TON`, `TOF`, `CTU`, `R_TRIG` and the rest are declared as types — that is
 * how an FB is given a timer of its own — and they are not in the elementary
 * type table because they are not elementary. They are in the instruction
 * catalogue, with `instance` set, which is the same fact written once.
 */
function instanceType(written: string): boolean {
  return instructionByName(baseTypeName(written))?.instance === true;
}

function checkInterface(
  block: PlcBlock, project: PlcProject, say: CheckStrings,
  add: (p: Omit<Problem, 'blockId' | 'blockName'>) => void,
): void {
  const allowed = new Set(sectionsFor(block.kind));
  const seen = new Map<string, PlcVar>();
  const typeNames = new Set(project.blocks.filter(b => b.kind === 'UDT' || b.kind === 'FB')
    .map(b => b.name.toLowerCase()));

  for (const v of block.interface) {
    if (!v.name.trim()) {
      add({ severity: 'error', code: 'iface.no-name', message: say.ifaceNoName() });
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name)) {
      add({
        severity: 'error', code: 'iface.bad-name',
        message: say.ifaceBadName(v.name),
      });
    }
    const low = v.name.toLowerCase();
    if (seen.has(low)) {
      add({
        severity: 'error', code: 'iface.duplicate',
        message: say.ifaceDuplicate(v.name),
      });
    } else seen.set(low, v);

    if (!allowed.has(v.section)) {
      add({
        severity: 'error', code: 'iface.bad-section',
        message: say.ifaceBadSection(v.name, v.section, block.kind, sectionsFor(block.kind).join(', ')),
      });
    }

    if (isUserType(v.dataType)) {
      const want = userTypeName(v.dataType).toLowerCase();
      if (!typeNames.has(want)) {
        add({
          severity: 'warning', code: 'iface.unknown-type',
          message: say.ifaceUnknownUserType(v.name, userTypeName(v.dataType)),
        });
      }
    } else if (!dataTypeInfo(v.dataType) && !instanceType(v.dataType)) {
      add({
        severity: 'warning', code: 'iface.unknown-type',
        message: say.ifaceUnknownType(v.name, v.dataType),
      });
    }

    if (v.section === 'Temp' && v.defaultValue) {
      add({
        severity: 'warning', code: 'iface.temp-default',
        message: say.ifaceTempDefault(v.name),
      });
    }
    if (v.retain && v.section !== 'Static') {
      add({
        severity: 'warning', code: 'iface.retain',
        message: say.ifaceRetain(v.name),
      });
    }
  }

  // An FC that returns something and never sets it.
  const ret = block.interface.find(v => v.section === 'Return');
  if (ret && block.code && !new RegExp(`#${ret.name}\\s*:=`, 'i').test(block.code)
    && !new RegExp(`\\b${block.name}\\s*:=`, 'i').test(block.code)) {
    add({
      severity: 'warning', code: 'fc.no-return',
      message: say.fcNoReturn(block.name, ret.name),
    });
  }
}

// ── Putting it together ─────────────────────────────────────────────────────

/**
 * Everything wrong with one block.
 *
 * `lang` is what the findings are written in. It is a parameter rather than
 * something read from a module global because two of these can be running at
 * once in different languages — the problems list, and the assistant working
 * out what the program would look like after its answer is applied — and a
 * global would hand one of them the other's.
 */
export function analyzeBlock(
  project: PlcProject, block: PlcBlock, lang: 'en' | 'fa' = 'en',
): Problem[] {
  const found: Problem[] = [];
  const say = CHECK_STRINGS[lang];
  const add = (p: Omit<Problem, 'blockId' | 'blockName'>) =>
    found.push({ ...p, blockId: block.id, blockName: block.name });

  checkInterface(block, project, say, add);

  const scope = scopeOf(project, block);

  if (block.code !== undefined && block.code.trim()) {
    const code = stripNonCode(block.code);
    checkStructure(code, say, add);
    checkNames(code, scope, say, add);
    checkCalls(code, scope, say, add);
    checkWrites(code, scope, say, add);
    checkArithmetic(code, scope, say, add);
  }

  for (const net of block.networks ?? []) {
    if (net.disabled) continue;
    checkNetwork(net, scope, say, add);
  }

  return found;
}

/** Everything wrong with the project — blocks, then the tag tables. */
export function analyzeProject(project: PlcProject, lang: 'en' | 'fa' = 'en'): Problem[] {
  const say = CHECK_STRINGS[lang];
  const found: Problem[] = project.blocks.flatMap(b => analyzeBlock(project, b, lang));

  // Two blocks with one name, and two tags on one address. Both are found here
  // rather than per block, because neither is visible from inside one.
  const byName = new Map<string, string[]>();
  for (const b of project.blocks) {
    const low = b.name.toLowerCase();
    byName.set(low, [...(byName.get(low) ?? []), b.name]);
  }
  for (const [, names] of byName) {
    if (names.length < 2) continue;
    found.push({
      severity: 'error', code: 'project.duplicate-block',
      message: say.duplicateBlock(names[0], names.length),
      blockId: '', blockName: names[0],
    });
  }

  const byAddress = new Map<string, string[]>();
  for (const table of project.tagTables) {
    for (const tag of table.tags) {
      const problem = addressProblem(tag.address, say);
      if (problem) {
        found.push({
          severity: 'error', code: 'tag.bad-address',
          message: say.badAddress(tag.name, problem), blockId: '', blockName: table.name,
        });
      }
      if (!tag.address) continue;
      const key = tag.address.toUpperCase();
      byAddress.set(key, [...(byAddress.get(key) ?? []), tag.name]);
    }
  }
  for (const [address, names] of byAddress) {
    if (names.length < 2) continue;
    found.push({
      severity: 'warning', code: 'tag.duplicate-address',
      message: say.duplicateAddress(address, names.length, names.join(', ')),
      blockId: '', blockName: 'PLC tags',
    });
  }

  // A tag whose type cannot hold what its address is. %I0.0 is a bit and a
  // Word tag on it reads three neighbouring bytes as well.
  for (const table of project.tagTables) {
    for (const tag of table.tags) {
      if (!tag.address) continue;
      const bit = /\.\d$/.test(tag.address);
      const info = dataTypeInfo(tag.dataType);
      if (bit && info && info.bits !== 1) {
        found.push({
          severity: 'error', code: 'tag.type-width',
          message: say.tagTypeWidthBit(tag.name, tag.address, tag.dataType),
          blockId: '', blockName: table.name,
        });
      }
      if (!bit && info && info.bits === 1 && /^%[IQM]\d/.test(tag.address)) {
        found.push({
          severity: 'error', code: 'tag.type-width',
          message: say.tagTypeWidthBool(tag.name, tag.address),
          blockId: '', blockName: table.name,
        });
      }
    }
  }

  return found;
}

/** How many of each, for the status bar. */
export function countBySeverity(problems: Problem[]): Record<Severity, number> {
  return problems.reduce(
    (acc, p) => ({ ...acc, [p.severity]: acc[p.severity] + 1 }),
    { error: 0, warning: 0, info: 0 } as Record<Severity, number>,
  );
}

/** True where the assignment would lose something. Used by the grid. */
export function assignmentWarning(from: string, to: string): string | null {
  if (assignable(from, to)) return null;
  return `${from} does not fit in ${to} without a conversion — use CONVERT, or one of the `
    + `${from.toUpperCase()}_TO_${to.toUpperCase()} functions.`;
}
