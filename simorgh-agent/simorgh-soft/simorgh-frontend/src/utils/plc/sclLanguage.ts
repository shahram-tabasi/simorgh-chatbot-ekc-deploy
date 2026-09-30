// src/utils/plc/sclLanguage.ts
//
// SCL and STL, described well enough for an editor to be useful in them.
//
// "Syntax highlighting" undersells what this is for. An editor that knows the
// language can say, while the engineer is still typing, that `END_IF` is
// missing, that `#Motor` is not declared, that `TIMER_ON` is not an
// instruction this controller has — and each of those is half an hour saved
// against finding it after a download. So the language is described once,
// here, and the editor, the checker and the assistant all read the same
// description.
//
// Nothing in this file imports Monaco. It exports plain data and takes the
// Monaco namespace as an argument where it needs it, so the catalogue, the
// checker and the exporter can use it without dragging three megabytes of
// editor into a bundle that only wanted the keyword list.
//
// What is described is Siemens SCL — Structured Text as TIA Portal spells it,
// with `#` on locals, `"` around blocks and tags, and the S7 literal forms.
// The IEC core underneath is the same in every vendor's Structured Text, which
// is why the keyword list below is most of what any of them needs.

import type * as Monaco from 'monaco-editor';

// ── The words ───────────────────────────────────────────────────────────────

/** Statements and structure — what shapes the program. */
export const SCL_CONTROL = [
  'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
  'CASE', 'OF', 'END_CASE',
  'FOR', 'TO', 'BY', 'DO', 'END_FOR',
  'WHILE', 'END_WHILE',
  'REPEAT', 'UNTIL', 'END_REPEAT',
  'CONTINUE', 'EXIT', 'RETURN', 'GOTO',
  'REGION', 'END_REGION',
];

/** Block and declaration headers. */
export const SCL_DECL = [
  'FUNCTION', 'END_FUNCTION',
  'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK',
  'ORGANIZATION_BLOCK', 'END_ORGANIZATION_BLOCK',
  'DATA_BLOCK', 'END_DATA_BLOCK',
  'TYPE', 'END_TYPE', 'STRUCT', 'END_STRUCT',
  'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP', 'VAR_STAT',
  'VAR_GLOBAL', 'VAR_CONSTANT', 'END_VAR',
  'CONSTANT', 'RETAIN', 'NON_RETAIN', 'AT',
  'BEGIN', 'END',
  'ARRAY', 'VERSION', 'TITLE', 'AUTHOR', 'FAMILY', 'NAME',
];

/** Operators spelled as words. */
export const SCL_OPERATORS = ['AND', 'OR', 'XOR', 'NOT', 'MOD', 'DIV'];

export const SCL_LITERALS = ['TRUE', 'FALSE', 'NULL'];

/** The elementary types, upper-cased, for the tokenizer. */
export const SCL_TYPES = [
  'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
  'SINT', 'USINT', 'INT', 'UINT', 'DINT', 'UDINT', 'LINT', 'ULINT',
  'REAL', 'LREAL',
  'TIME', 'LTIME', 'DATE', 'TIME_OF_DAY', 'TOD', 'DATE_AND_TIME', 'DT', 'DTL', 'LDT',
  'CHAR', 'WCHAR', 'STRING', 'WSTRING',
  'VARIANT', 'ANY', 'POINTER', 'BLOCK_FC', 'BLOCK_FB', 'BLOCK_DB',
  'IEC_TIMER', 'IEC_COUNTER', 'IEC_LTIMER', 'TON', 'TOF', 'TP', 'TONR',
  'CTU', 'CTD', 'CTUD', 'R_TRIG', 'F_TRIG',
  'HW_ANY', 'HW_DEVICE', 'HW_IO', 'HW_IOSYSTEM', 'HW_SUBMODULE',
  'EVENT_ATT', 'OB_ANY', 'OB_ATT', 'OB_DELAY', 'ERROR_STRUCT',
];

/**
 * The word the editor should offer after `END_`.
 *
 * Structured Text closes every construct by name, which is what makes it
 * readable and what makes an unclosed one so easy to leave behind. The pairing
 * is written out so the checker can say which one is missing rather than that
 * something is.
 */
export const SCL_PAIRS: Record<string, string> = {
  IF: 'END_IF',
  CASE: 'END_CASE',
  FOR: 'END_FOR',
  WHILE: 'END_WHILE',
  REPEAT: 'END_REPEAT',
  REGION: 'END_REGION',
  STRUCT: 'END_STRUCT',
  VAR: 'END_VAR',
  VAR_INPUT: 'END_VAR',
  VAR_OUTPUT: 'END_VAR',
  VAR_IN_OUT: 'END_VAR',
  VAR_TEMP: 'END_VAR',
  VAR_STAT: 'END_VAR',
  VAR_CONSTANT: 'END_VAR',
};

// ── Monaco ──────────────────────────────────────────────────────────────────

export const SCL_LANGUAGE_ID = 'scl';
export const STL_LANGUAGE_ID = 'stl';

/**
 * Brackets, comments and auto-closing.
 *
 * `(* *)` is the IEC block comment and `//` the line comment; both are real and
 * both are used, so both are here. The indentation rules are what make typing
 * `IF` and pressing Enter put the cursor where the statement goes — small, and
 * the difference between an editor that helps and one that is a text box.
 */
export function sclLanguageConfiguration(): Monaco.languages.LanguageConfiguration {
  return {
    comments: { lineComment: '//', blockComment: ['(*', '*)'] },
    brackets: [['(', ')'], ['[', ']'], ['{', '}']],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: '(*', close: '*)' },
    ],
    surroundingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    folding: {
      markers: {
        start: /^\s*(REGION|IF|FOR|WHILE|REPEAT|CASE|VAR(_\w+)?|STRUCT)\b/i,
        end: /^\s*(END_REGION|END_IF|END_FOR|END_WHILE|END_REPEAT|END_CASE|END_VAR|END_STRUCT)\b/i,
      },
    },
    indentationRules: {
      increaseIndentPattern:
        /^\s*(IF\b.*\bTHEN\s*$|ELSIF\b.*\bTHEN\s*$|ELSE\s*$|CASE\b.*\bOF\s*$|FOR\b.*\bDO\s*$|WHILE\b.*\bDO\s*$|REPEAT\s*$|REGION\b|VAR(_\w+)?\s*$|STRUCT\s*$|\d+\s*:\s*$)/i,
      decreaseIndentPattern:
        /^\s*(END_IF|ELSIF|ELSE|END_CASE|END_FOR|END_WHILE|UNTIL|END_REPEAT|END_REGION|END_VAR|END_STRUCT)\b/i,
    },
    // No onEnterRules. Continuing a `//` comment onto the next line was tried
    // and is wrong: a comment is almost always the last thing typed before the
    // statement it describes, so Enter turned the next line of code into a
    // comment. The engineer notices when the block does not do what it says.
    // A block comment is opened and closed explicitly and needs no help either.
    wordPattern: /(-?\d*\.\d\w*)|([^`~!@#%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g,
  };
}

/**
 * The tokenizer.
 *
 * Written against what SCL actually contains rather than against a generic
 * Pascal, because the parts that are specific are the parts an engineer reads
 * fastest: `#Motor` is a local and `"Motor_DB"` is a block, and colouring
 * those two differently is most of what makes a listing scannable. The time
 * literals get their own colour for the same reason — `T#5s` is a value, and
 * it looks nothing like one until it is coloured as one.
 */
export function sclMonarchLanguage(): Monaco.languages.IMonarchLanguage {
  return {
    ignoreCase: true,
    defaultToken: '',
    control: SCL_CONTROL,
    decl: SCL_DECL,
    operators: SCL_OPERATORS,
    literals: SCL_LITERALS,
    typeKeywords: SCL_TYPES,

    tokenizer: {
      root: [
        // Absolute addresses: %I0.0, %QW64, %MD100, %DB1.DBX0.0
        [/%(DB\d+\.DB[XBWD]\d+(\.\d)?|[IQM][XBWD]?\d+(\.\d)?)/i, 'variable.predefined'],

        // A local: #Motor, #arr[#i].value
        [/#[A-Za-z_][\w$]*/, 'variable.name'],

        // Time and date literals, before the number rule can take the digits.
        [/\b(L?T|LTOD|TOD|LDT|DTL?|D)#[\dA-Za-z_:.\-+]+/i, 'number.time'],

        // Based numbers: 16#FF, 2#1010_1010, 8#777
        [/\b(16|8|2)#[0-9A-Fa-f_]+/, 'number.hex'],

        // Typed constants: INT#5, REAL#1.5, WORD#16#FF
        [/\b[A-Za-z_]\w*#[\w#.]+/, 'number'],

        // A quoted name — a block, a tag, a user type. Not a string: SCL
        // strings are in single quotes, which is the rule that makes this
        // unambiguous and is worth colouring differently.
        [/"[^"\n]*"/, 'type.identifier'],

        // Strings and chars, single quoted, with $ as the escape.
        [/'([^'\\]|\$.)*'/, 'string'],
        [/'/, 'string.invalid'],

        // Comments
        [/\/\/.*$/, 'comment'],
        [/\(\*/, 'comment', '@blockComment'],
        [/\{/, 'annotation', '@attribute'],

        // Words
        [/[A-Za-z_][\w$]*/, {
          cases: {
            '@control': 'keyword.control',
            '@decl': 'keyword',
            '@operators': 'keyword.operator',
            '@literals': 'constant.language',
            '@typeKeywords': 'type',
            '@default': 'identifier',
          },
        }],

        // Numbers, after the literal forms above.
        [/\b\d+\.\d+([eE][-+]?\d+)?\b/, 'number.float'],
        [/\b\d[\d_]*\b/, 'number'],

        // Operators and punctuation
        [/:=|=>|<>|<=|>=|\*\*|[-+*/<>=]/, 'operator'],
        [/[;,.]/, 'delimiter'],
        [/[()[\]]/, '@brackets'],
      ],

      blockComment: [
        [/[^*(]+/, 'comment'],
        [/\*\)/, 'comment', '@pop'],
        [/[*(]/, 'comment'],
      ],

      // { S7_HMI_Accessible := 'True' } — the pragmas on a declaration.
      attribute: [
        [/[^}]+/, 'annotation'],
        [/\}/, 'annotation', '@pop'],
      ],
    },
  } as Monaco.languages.IMonarchLanguage;
}

/**
 * STL — statement list.
 *
 * One instruction a line, an operand after it, and labels in the first column.
 * It is highlighted rather than understood: STL is kept in this app for the
 * blocks that already exist in it, not as a language to start new work in, and
 * an editor that colours it and leaves it alone is the honest amount of help.
 */
export function stlMonarchLanguage(): Monaco.languages.IMonarchLanguage {
  return {
    ignoreCase: true,
    defaultToken: '',
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/^\s*[A-Za-z_]\w*\s*:(?!=)/, 'type.identifier'],     // a label
        [/%?(DB\d+\.DB[XBWD]\d+(\.\d)?|[IQML][XBWDB]?\d+(\.\d)?)/i, 'variable.predefined'],
        [/#[A-Za-z_][\w$]*/, 'variable.name'],
        [/"[^"\n]*"/, 'type.identifier'],
        [/\b(A|AN|O|ON|X|XN|=|S|R|NOT|SET|CLR|SAVE|JU|JC|JCN|JZ|JN|JL|CALL|UC|CC|BE|BEC|BEU|L|T|LAR1|LAR2|TAR1|TAR2|\+I|-I|\*I|\/I|\+D|-D|\*D|\/D|\+R|-R|\*R|\/R|ITD|DTR|RND|TRUNC|AW|OW|XOW|AD|OD|XOD|SLW|SRW|SLD|SRD|RLD|RRD|CU|CD|SD|SS|SE|SF|SP|FR|NOP)\b/i, 'keyword'],
        [/\b(L?T|TOD|D|DT)#[\dA-Za-z_:.\-+]+/i, 'number.time'],
        [/\b(16|8|2)#[0-9A-Fa-f_]+/, 'number.hex'],
        [/\b\d+\.\d+\b/, 'number.float'],
        [/\b\d+\b/, 'number'],
        [/'([^'\\]|\$.)*'/, 'string'],
        [/[;,.]/, 'delimiter'],
      ],
    },
  } as Monaco.languages.IMonarchLanguage;
}

/**
 * The two themes.
 *
 * Built rather than borrowed, because the colours have to carry the meanings
 * this language has and a general-purpose theme has no idea that `%I0.0` and
 * `#Motor` are different kinds of thing. Both are given: the app has a light
 * and a dark mode and an editor that ignores it is the one panel on the screen
 * that glares at two in the morning.
 */
export function defineThemes(monaco: typeof Monaco): void {
  monaco.editor.defineTheme('simorgh-plc-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'keyword.control', foreground: '7c3aed', fontStyle: 'bold' },
      { token: 'keyword', foreground: '1d4ed8', fontStyle: 'bold' },
      { token: 'keyword.operator', foreground: '9333ea' },
      { token: 'type', foreground: '0f766e' },
      { token: 'type.identifier', foreground: 'b45309' },
      { token: 'variable.predefined', foreground: 'be123c' },
      { token: 'variable.name', foreground: '0369a1' },
      { token: 'number.time', foreground: 'c2410c' },
      { token: 'constant.language', foreground: '9333ea', fontStyle: 'bold' },
      { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
      { token: 'annotation', foreground: '78716c' },
    ],
    colors: { 'editor.background': '#ffffff' },
  });

  monaco.editor.defineTheme('simorgh-plc-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword.control', foreground: 'c4b5fd', fontStyle: 'bold' },
      { token: 'keyword', foreground: '93c5fd', fontStyle: 'bold' },
      { token: 'keyword.operator', foreground: 'd8b4fe' },
      { token: 'type', foreground: '5eead4' },
      { token: 'type.identifier', foreground: 'fcd34d' },
      { token: 'variable.predefined', foreground: 'fda4af' },
      { token: 'variable.name', foreground: '7dd3fc' },
      { token: 'number.time', foreground: 'fdba74' },
      { token: 'constant.language', foreground: 'd8b4fe', fontStyle: 'bold' },
      { token: 'comment', foreground: '94a3b8', fontStyle: 'italic' },
      { token: 'annotation', foreground: 'a8a29e' },
    ],
    colors: { 'editor.background': '#0f172a' },
  });
}
