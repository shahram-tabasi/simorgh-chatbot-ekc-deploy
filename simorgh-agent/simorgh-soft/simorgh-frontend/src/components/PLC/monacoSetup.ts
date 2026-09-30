// src/components/PLC/monacoSetup.ts
//
// Bringing the editor in, once, and teaching it the language.
//
// Monaco is three megabytes and this is the only page that wants it, so it is
// **loaded on demand**: nothing in this file is reached until somebody opens a
// block, and the rest of the suite is the same size as it was. That is the
// whole reason for a loader rather than a plain import.
//
// What is pulled in is the editor and its own contributions — find and
// replace, folding, multiple cursors, the suggestion widget, the command
// palette — and **not** the eighty bundled languages or the TypeScript,
// JSON, CSS and HTML services that come with the package root. A PLC page has
// no use for any of them, and leaving them out is most of the weight.
//
// Registration happens once per page load and is idempotent: a second call
// returns the same promise. Registering a language twice gives two tokenizers
// racing for the same file, which shows up as highlighting that flickers
// between two colourings and is very hard to recognise for what it is.

import type * as Monaco from 'monaco-editor';
import {
  SCL_CONTROL, SCL_DECL, SCL_LANGUAGE_ID, SCL_LITERALS, SCL_OPERATORS, SCL_TYPES,
  STL_LANGUAGE_ID, defineThemes, sclLanguageConfiguration, sclMonarchLanguage,
  stlMonarchLanguage,
} from '../../utils/plc/sclLanguage';

export type MonacoApi = typeof Monaco;

let pending: Promise<MonacoApi> | null = null;

/**
 * The editor, loaded and taught SCL.
 *
 * Call it as often as you like; it does the work once.
 */
export function loadMonaco(): Promise<MonacoApi> {
  if (pending) return pending;
  pending = (async () => {
    // Order matters: `editor.all` registers the contributions, and the api
    // module is what exports the namespace. Loading them the other way round
    // gives an editor with no find widget and no suggestions — which looks
    // like a plain textarea and is very confusing to debug.
    await import('monaco-editor/esm/vs/editor/editor.all.js');
    await import('monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js');
    const monaco = (await import('monaco-editor/esm/vs/editor/editor.api')) as unknown as MonacoApi;

    // Even with no language services, Monaco wants a worker for the work it
    // does off the main thread. Vite bundles this one next to the app, so it
    // is served from the same origin and needs no CDN — which matters, because
    // this suite runs on machines that cannot reach one.
    const EditorWorker = (await import('monaco-editor/esm/vs/editor/editor.worker?worker')).default;
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker: () => new EditorWorker(),
    };

    register(monaco);
    return monaco;
  })();
  return pending;
}

function register(monaco: MonacoApi): void {
  const already = new Set(monaco.languages.getLanguages().map(l => l.id));

  if (!already.has(SCL_LANGUAGE_ID)) {
    monaco.languages.register({ id: SCL_LANGUAGE_ID, extensions: ['.scl'], aliases: ['SCL', 'Structured Text', 'ST'] });
    monaco.languages.setLanguageConfiguration(SCL_LANGUAGE_ID, sclLanguageConfiguration());
    monaco.languages.setMonarchTokensProvider(SCL_LANGUAGE_ID, sclMonarchLanguage());
    monaco.languages.registerDocumentFormattingEditProvider(SCL_LANGUAGE_ID, {
      provideDocumentFormattingEdits: (model) => [{
        range: model.getFullModelRange(),
        text: formatScl(model.getValue()),
      }],
    });
  }

  if (!already.has(STL_LANGUAGE_ID)) {
    monaco.languages.register({ id: STL_LANGUAGE_ID, extensions: ['.awl'], aliases: ['STL', 'AWL'] });
    monaco.languages.setLanguageConfiguration(STL_LANGUAGE_ID, {
      comments: { lineComment: '//' },
      brackets: [['(', ')'], ['[', ']']],
    });
    monaco.languages.setMonarchTokensProvider(STL_LANGUAGE_ID, stlMonarchLanguage());
  }

  defineThemes(monaco);
}

/**
 * SCL, indented.
 *
 * Only the indentation, on purpose. A formatter that rewrites expressions,
 * moves comments and re-wraps declarations is one an engineer stops using the
 * first time it touches a line they had lined up deliberately — and the thing
 * that is actually wrong with hand-written SCL is almost always the depth,
 * because that is what changes when a condition is added around an existing
 * block.
 *
 * Everything else about the line is kept exactly: its text, its trailing
 * comment, its blank lines.
 */
export function formatScl(code: string): string {
  const OPENS = /^(IF\b.*\bTHEN\s*(\/\/.*)?$|CASE\b.*\bOF\s*(\/\/.*)?$|FOR\b.*\bDO\s*(\/\/.*)?$|WHILE\b.*\bDO\s*(\/\/.*)?$|REPEAT\s*(\/\/.*)?$|REGION\b.*$|VAR(_\w+)?(\s+(RETAIN|CONSTANT))?\s*(\/\/.*)?$|STRUCT\s*(\/\/.*)?$|BEGIN\s*(\/\/.*)?$)/i;
  const CLOSES = /^(END_IF|END_CASE|END_FOR|END_WHILE|END_REPEAT|UNTIL|END_REGION|END_VAR|END_STRUCT|END_FUNCTION|END_FUNCTION_BLOCK|END_ORGANIZATION_BLOCK|END_DATA_BLOCK|END_TYPE)\b/i;
  const MIDDLE = /^(ELSE|ELSIF)\b/i;
  // A CASE label — `1:`, `0, 2:`, `ELSE:` — which is one in from the CASE and
  // one out from the statements under it.
  const CASE_LABEL = /^(\d+(\s*,\s*\d+)*|\d+\s*\.\.\s*\d+|ELSE)\s*:/i;

  const lines = code.split('\n');
  const out: string[] = [];
  let depth = 0;
  let inCase = 0;          // how many of the open levels are CASE statements
  const caseStack: boolean[] = [];
  let labelOpen = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { out.push(''); continue; }

    if (CLOSES.test(line)) {
      if (/^END_CASE/i.test(line)) {
        if (labelOpen) { depth -= 1; labelOpen = false; }
        caseStack.pop();
        inCase = caseStack.length;
      }
      depth = Math.max(0, depth - 1);
    } else if (MIDDLE.test(line) && !CASE_LABEL.test(line)) {
      depth = Math.max(0, depth - 1);
    } else if (inCase > 0 && CASE_LABEL.test(line)) {
      // A new label closes the previous label's body.
      if (labelOpen) depth = Math.max(0, depth - 1);
    }

    out.push('    '.repeat(depth) + line);

    if (OPENS.test(line)) {
      depth += 1;
      const isCase = /^CASE\b/i.test(line);
      if (isCase) { caseStack.push(true); inCase = caseStack.length; labelOpen = false; }
    } else if (MIDDLE.test(line) && !CASE_LABEL.test(line)) {
      depth += 1;
    } else if (inCase > 0 && CASE_LABEL.test(line)) {
      depth += 1;
      labelOpen = true;
    }
  }
  return out.join('\n');
}

/** The keyword list, as completion items. Built once and reused. */
export function keywordItems(monaco: MonacoApi, range: Monaco.IRange): Monaco.languages.CompletionItem[] {
  const K = monaco.languages.CompletionItemKind;
  const items: Monaco.languages.CompletionItem[] = [];
  for (const w of SCL_CONTROL) items.push({ label: w, kind: K.Keyword, insertText: w, range });
  for (const w of SCL_DECL) items.push({ label: w, kind: K.Keyword, insertText: w, range });
  for (const w of SCL_OPERATORS) items.push({ label: w, kind: K.Operator, insertText: w, range });
  for (const w of SCL_LITERALS) items.push({ label: w, kind: K.Constant, insertText: w, range });
  for (const w of SCL_TYPES) items.push({ label: w, kind: K.TypeParameter, insertText: w, range });
  return items;
}

/**
 * The statements, as snippets.
 *
 * Typing `if` and getting the whole `IF … THEN … END_IF` with the cursor in
 * the condition is the single thing that stops an unclosed statement being
 * written in the first place — which is better than finding it afterwards,
 * however good the checker is.
 */
export function statementSnippets(
  monaco: MonacoApi, range: Monaco.IRange,
): Monaco.languages.CompletionItem[] {
  const K = monaco.languages.CompletionItemKind;
  const rule = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  const snip = (label: string, detail: string, insertText: string): Monaco.languages.CompletionItem =>
    ({ label, kind: K.Snippet, detail, insertText, insertTextRules: rule, range });

  return [
    snip('IF', 'IF … THEN … END_IF', 'IF ${1:condition} THEN\n    ${2}\nEND_IF;'),
    snip('IFELSE', 'IF … THEN … ELSE … END_IF', 'IF ${1:condition} THEN\n    ${2}\nELSE\n    ${3}\nEND_IF;'),
    snip('CASE', 'CASE … OF … END_CASE', 'CASE ${1:selector} OF\n    ${2:0}:\n        ${3}\n    ELSE\n        ;\nEND_CASE;'),
    snip('FOR', 'FOR … DO … END_FOR', 'FOR #${1:i} := ${2:1} TO ${3:10} DO\n    ${4}\nEND_FOR;'),
    snip('WHILE', 'WHILE … DO … END_WHILE', 'WHILE ${1:condition} DO\n    ${2}\nEND_WHILE;'),
    snip('REPEAT', 'REPEAT … UNTIL … END_REPEAT', 'REPEAT\n    ${1}\nUNTIL ${2:condition}\nEND_REPEAT;'),
    snip('REGION', 'A folding region with a name', 'REGION ${1:name}\n    ${2}\nEND_REGION'),
  ];
}
