// src/components/PLC/CodeEditor.tsx
//
// The text editor, and everything it knows about the program around it.
//
// An editor that only colours words is a text box with opinions. What makes
// this one worth three megabytes is that it is **told about the project**: the
// completion list holds this block's own variables, this project's tags and
// this controller's instructions, the hover explains the instruction under the
// pointer, and the red underlines are the checker's, with the same message the
// problems list shows.
//
// Two things are deliberate and worth not undoing.
//
// **The model is not controlled.** React owns the value only when the open
// block changes; between those, Monaco owns it and reports out. An editor
// whose value is pushed back in on every keystroke loses the cursor, the
// selection and the undo stack, and does it most noticeably when somebody is
// typing fast — which is exactly when it is least forgivable.
//
// **The providers are registered once.** Monaco's providers are per language,
// not per editor, so registering them on mount stacks a new copy on every
// block that is opened and the suggestion list starts showing everything four
// times. They are registered on first load and read the live context out of a
// map keyed by the model, which is what keeps one editor's tags out of
// another's list.

import React, { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import { MonacoApi, keywordItems, loadMonaco, statementSnippets } from './monacoSetup';
import { SCL_LANGUAGE_ID, STL_LANGUAGE_ID } from '../../utils/plc/sclLanguage';
import { ALL_INSTRUCTIONS, instructionByName } from '../../utils/plc/instructions';
import { PlcBlock, PlcProject, PlcVar, allTags } from '../../utils/plc/model';
import { Problem } from '../../utils/plc/analyze';
import { dataTypeInfo } from '../../utils/plc/dataTypes';

/** What the editor is allowed to know about, for completion and hover. */
interface EditorContext {
  project: PlcProject;
  block: PlcBlock;
}

/**
* Which context belongs to which open document.
*
* Keyed by the model's URI, because that is the one thing a provider is handed
* and the one thing that is stable for the life of a document.
*/
const contexts = new Map<string, EditorContext>();

let providersRegistered = false;

function flatVars(vars: PlcVar[], prefix = ''): { path: string; v: PlcVar }[] {
  const out: { path: string; v: PlcVar }[] = [];
  for (const v of vars) {
    if (!v.name) continue;
    const path = prefix ? `${prefix}.${v.name}` : v.name;
    out.push({ path, v });
    if (v.members) out.push(...flatVars(v.members, path));
  }
  return out;
}

function registerProviders(monaco: MonacoApi): void {
  if (providersRegistered) return;
  providersRegistered = true;

  const K = monaco.languages.CompletionItemKind;
  const asSnippet = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;

  monaco.languages.registerCompletionItemProvider([SCL_LANGUAGE_ID, STL_LANGUAGE_ID], {
    // `#` opens the local list and `"` the project list, so the suggestion
    // appears as the engineer types the character that means it rather than
    // after a letter — which is how it is done in the software they came from.
    triggerCharacters: ['#', '"', '.', '(', ','],

    provideCompletionItems(model, position) {
      const ctx = contexts.get(model.uri.toString());
      const word = model.getWordUntilPosition(position);
      const line = model.getLineContent(position.lineNumber);
      const before = line.slice(0, position.column - 1);

      // The range the item replaces. Taking the `#` or `"` in as well is what
      // stops `#` plus a chosen name coming out as `##Motor`.
      const prefixChar = /[#"]$/.test(before) ? 1
        : /[#"][A-Za-z0-9_]*$/.test(before) ? (before.length - before.search(/[#"][A-Za-z0-9_]*$/)) : 0;
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: prefixChar > 0 ? position.column - prefixChar : word.startColumn,
        endColumn: position.column,
      };

      const items: Monaco.languages.CompletionItem[] = [];
      const wantsLocal = /#[A-Za-z0-9_]*$/.test(before);
      const wantsProject = /"[^"\n]*$/.test(before);

      if (ctx) {
        // This block's own declarations, sorted so the interface comes before
        // the temporaries — what a block is given matters more than what it
        // scribbles on.
        const order: Record<string, string> = {
          Input: '0', Output: '1', InOut: '2', Static: '3', Return: '4', Constant: '5', Temp: '6',
        };
        for (const { path, v } of flatVars(ctx.block.interface)) {
          items.push({
            label: `#${path}`,
            kind: v.members ? K.Struct : K.Variable,
            detail: `${v.section} · ${v.dataType}`,
            documentation: v.comment,
            insertText: `#${path}`,
            sortText: `${order[v.section] ?? '7'}${path}`,
            range,
          });
        }
      }

      if (ctx && !wantsLocal) {
        for (const tag of allTags(ctx.project)) {
          items.push({
            label: `"${tag.name}"`,
            kind: K.Field,
            detail: `${tag.dataType}${tag.address ? ` @ ${tag.address}` : ''}`,
            documentation: tag.comment,
            insertText: `"${tag.name}"`,
            sortText: `8${tag.name}`,
            range,
          });
        }
        for (const b of ctx.project.blocks) {
          if (b.id === ctx.block.id) continue;
          items.push({
            label: `"${b.name}"`,
            kind: b.kind === 'DB' ? K.Module : b.kind === 'UDT' ? K.Interface : K.Function,
            detail: `${b.kind}${b.number ?? ''} · ${b.language}`,
            documentation: b.comment,
            insertText: `"${b.name}"`,
            sortText: `9${b.name}`,
            range,
          });
        }
      }

      if (!wantsLocal && !wantsProject) {
        for (const x of ALL_INSTRUCTIONS) {
          if (x.form === 'editor' || !x.scl) continue;
          items.push({
            label: x.name,
            kind: K.Function,
            detail: x.title,
            documentation: { value: instructionMarkdown(x.name) },
            insertText: x.scl,
            insertTextRules: asSnippet,
            sortText: `2${x.name}`,
            range,
          });
        }
        items.push(...statementSnippets(monaco, range));
        items.push(...keywordItems(monaco, range));
      }

      return { suggestions: items };
    },
  });

  monaco.languages.registerHoverProvider([SCL_LANGUAGE_ID, STL_LANGUAGE_ID], {
    provideHover(model, position) {
      const ctx = contexts.get(model.uri.toString());
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const line = model.getLineContent(position.lineNumber);
      const before = line.slice(0, word.startColumn - 1);

      // A local — the `#` is not part of the word, so it is looked for behind.
      if (/#$/.test(before) && ctx) {
        const found = flatVars(ctx.block.interface).find(x => x.path === word.word
          || x.path.endsWith(`.${word.word}`));
        if (found) {
          const info = dataTypeInfo(found.v.dataType);
          return {
            contents: [
              { value: `**#${found.path}** — ${found.v.section}` },
              { value: `\`${found.v.dataType}\`${found.v.defaultValue ? ` := ${found.v.defaultValue}` : ''}` },
              ...(found.v.comment ? [{ value: found.v.comment }] : []),
              ...(info ? [{ value: `_${info.note}_` }] : []),
            ],
          };
        }
      }

      // A tag or a block, inside quotes.
      if (/"[^"\n]*$/.test(before) && ctx) {
        const tag = allTags(ctx.project).find(t => t.name === word.word);
        if (tag) {
          return {
            contents: [
              { value: `**"${tag.name}"** — PLC tag` },
              { value: `\`${tag.dataType}\`${tag.address ? ` at \`${tag.address}\`` : ''}` },
              ...(tag.comment ? [{ value: tag.comment }] : []),
            ],
          };
        }
        const block = ctx.project.blocks.find(b => b.name === word.word);
        if (block) {
          const ins = block.interface.filter(v => v.section === 'Input' || v.section === 'InOut');
          const outs = block.interface.filter(v => v.section === 'Output' || v.section === 'Return');
          return {
            contents: [
              { value: `**"${block.name}"** — ${block.kind}${block.number ?? ''}, ${block.language}` },
              ...(block.comment ? [{ value: block.comment }] : []),
              ...(ins.length ? [{ value: `**in:** ${ins.map(v => `${v.name} : ${v.dataType}`).join(', ')}` }] : []),
              ...(outs.length ? [{ value: `**out:** ${outs.map(v => `${v.name} : ${v.dataType}`).join(', ')}` }] : []),
            ],
          };
        }
      }

      const md = instructionMarkdown(word.word);
      return md ? { contents: [{ value: md }] } : null;
    },
  });
}

/** An instruction's help, as the hover shows it. */
function instructionMarkdown(name: string): string {
  const x = instructionByName(name);
  if (!x) return '';
  const out = [`**${x.name}** — ${x.title}`];
  if (x.pins?.length) {
    const ins = x.pins.filter(p => !p.out).map(p => `\`${p.name}: ${p.type}\``).join(' ');
    const outs = x.pins.filter(p => p.out).map(p => `\`${p.name}: ${p.type}\``).join(' ');
    if (ins) out.push(`**in** ${ins}`);
    if (outs) out.push(`**out** ${outs}`);
  }
  if (x.instance) out.push('_Keeps its own state — it needs an instance._');
  out.push(x.help);
  return out.join('\n\n');
}

// ── The component ───────────────────────────────────────────────────────────

/**
* What a toolbar button outside the editor can ask it to do.
*
* Handed out through a ref rather than reached for in the DOM: the commands
* are Monaco's own, they need the editor instance, and a button that guesses
* at the focused element works until there are two editors on the screen.
*/
export interface EditorActions {
  format: () => void;
  find: () => void;
  replace: () => void;
  gotoLine: () => void;
  commands: () => void;
  /** Put the cursor on a line and scroll to it — for the problems list. */
  reveal: (line: number, column?: number) => void;
  focus: () => void;
  /** Type text in at the cursor, as a snippet. For the instruction catalogue. */
  insertSnippet: (text: string) => void;
}

interface Props {
  /** Which document this is. Changing it replaces the editor's content. */
  documentId: string;
  value: string;
  language: 'SCL' | 'STL' | 'GRAPH';
  project: PlcProject;
  block: PlcBlock;
  problems: Problem[];
  readOnly?: boolean;
  dark?: boolean;
  onChange: (next: string) => void;
  /** Ctrl+S inside the editor. */
  onSave?: () => void;
  /** Told when the cursor moves, for the status bar. */
  onCursor?: (line: number, column: number) => void;
  /** Filled in once the editor is up, so the toolbar can drive it. */
  actionsRef?: React.MutableRefObject<EditorActions | null>;
}

export const CodeEditor: React.FC<Props> = ({
  documentId, value, language, project, block, problems,
  readOnly, dark, onChange, onSave, onCursor, actionsRef,
}) => {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onCursorRef = useRef(onCursor);
  const [failed, setFailed] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onCursorRef.current = onCursor;

  // ── Mount ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    let editor: Monaco.editor.IStandaloneCodeEditor | null = null;

    loadMonaco().then(monaco => {
      if (!alive || !host.current) return;
      monacoRef.current = monaco;
      registerProviders(monaco);

      editor = monaco.editor.create(host.current, {
        value: '',
        language: SCL_LANGUAGE_ID,
        automaticLayout: true,
        minimap: { enabled: true, maxColumn: 70 },
        fontSize: 13,
        fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, "Courier New", monospace',
        lineNumbers: 'on',
        renderWhitespace: 'selection',
        rulers: [100],
        tabSize: 4,
        insertSpaces: true,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        bracketPairColorization: { enabled: true },
        wordBasedSuggestions: 'off',
        suggestOnTriggerCharacters: true,
        quickSuggestions: { other: true, comments: false, strings: false },
        folding: true,
        foldingStrategy: 'auto',
        showFoldingControls: 'always',
        glyphMargin: true,
        occurrencesHighlight: 'singleFile',
        renderLineHighlight: 'all',
        multiCursorModifier: 'ctrlCmd',
        find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: 'selection' },
        unicodeHighlight: { ambiguousCharacters: false },
      });
      editorRef.current = editor;

      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => onSaveRef.current?.(),
      );

      editor.onDidChangeModelContent(() => {
        const model = editor?.getModel();
        if (model) onChangeRef.current(model.getValue());
      });

      editor.onDidChangeCursorPosition(e => {
        onCursorRef.current?.(e.position.lineNumber, e.position.column);
      });

      if (actionsRef) {
        const run = (id: string) => () => { editor?.focus(); editor?.trigger('toolbar', id, null); };
        actionsRef.current = {
          format: run('editor.action.formatDocument'),
          find: run('actions.find'),
          replace: run('editor.action.startFindReplaceAction'),
          gotoLine: run('editor.action.gotoLine'),
          commands: run('editor.action.quickCommand'),
          focus: () => editor?.focus(),
          reveal: (line, column = 1) => {
            editor?.revealLineInCenter(line);
            editor?.setPosition({ lineNumber: line, column });
            editor?.focus();
          },
          insertSnippet: (text: string) => {
            editor?.focus();
            const contribution = editor?.getContribution<Monaco.editor.IEditorContribution & {
              insert?: (t: string) => void;
            }>('snippetController2');
            if (contribution?.insert) contribution.insert(text);
            else editor?.trigger('toolbar', 'type', { text });
          },
        };
      }

      setReady(true);
    }).catch(err => {
      // The editor not loading must not take the page with it: the interface
      // grid, the tree and the catalogue are all still useful, and the block
      // can still be read in the box below.
      if (alive) setFailed(err instanceof Error ? err.message : String(err));
    });

    return () => {
      alive = false;
      if (actionsRef) actionsRef.current = null;
      const model = editor?.getModel();
      if (model) contexts.delete(model.uri.toString());
      editor?.dispose();
      model?.dispose();
      editorRef.current = null;
    };
    // `actionsRef` is a ref the caller owns and is filled in once. Listing it
    // would tear the editor down and build it again on any render that handed
    // in a new ref object — three megabytes of editor, an empty document and a
    // lost cursor, for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── The open document ────────────────────────────────────────────────────
  // A model per block, named after it, so the tab strip, the markers and the
  // undo stack all follow the block rather than the editor.
  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;

    const langId = language === 'STL' ? STL_LANGUAGE_ID : SCL_LANGUAGE_ID;
    const uri = monaco.Uri.parse(`plc://block/${documentId}.${language.toLowerCase()}`);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(value, langId, uri);
    if (model.getValue() !== value) model.setValue(value);
    if (model.getLanguageId() !== langId) monaco.editor.setModelLanguage(model, langId);
    editor.setModel(model);
    editor.updateOptions({ readOnly: !!readOnly });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, language, readOnly]);

  // The value only pushed in when it changed underneath — an assistant writing
  // the block, an undo at the project level. Comparing first is what keeps the
  // cursor where it was during ordinary typing.
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!model) return;
    if (model.getValue() === value) return;
    const position = editor?.getPosition();
    model.setValue(value);
    if (position) editor?.setPosition(position);
  }, [value]);

  // ── What the completion and hover are told ───────────────────────────────
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    contexts.set(model.uri.toString(), { project, block });
  }, [project, block, ready, documentId]);

  // ── The underlines ───────────────────────────────────────────────────────
  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;
    const severity = (s: Problem['severity']) =>
      s === 'error' ? monaco.MarkerSeverity.Error
        : s === 'warning' ? monaco.MarkerSeverity.Warning
          : monaco.MarkerSeverity.Info;
    monaco.editor.setModelMarkers(model, 'plc', problems
      .filter(p => p.line !== undefined)
      .map(p => ({
        severity: severity(p.severity),
        message: p.message,
        code: p.code,
        startLineNumber: p.line ?? 1,
        startColumn: p.column ?? 1,
        endLineNumber: p.line ?? 1,
        endColumn: p.endColumn ?? (p.column ?? 1) + 1,
      })));
  }, [problems, ready, documentId]);

  // ── Light and dark ───────────────────────────────────────────────────────
  useEffect(() => {
    monacoRef.current?.editor.setTheme(dark ? 'simorgh-plc-dark' : 'simorgh-plc-light');
  }, [dark, ready]);

  if (failed) {
    return (
      <div className="h-full flex flex-col">
        <div className="px-3 py-2 text-xs bg-amber-50 border-b border-amber-200 text-amber-900">
          The code editor could not be loaded ({failed}). The block is still here and still
          editable in the plain box below — nothing has been lost.
        </div>
        <textarea
          className="flex-1 w-full p-3 font-mono text-[13px] outline-none resize-none"
          value={value}
          readOnly={readOnly}
          onChange={e => onChange(e.target.value)}
          spellCheck={false}
        />
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <div ref={host} className="absolute inset-0" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-500 bg-gray-50">
          Opening the editor…
        </div>
      )}
    </div>
  );
};

