// src/components/PLC/PlcTab.tsx
//
// The PLC page — the controller, its blocks, and everything used to write them.
//
// Three columns and a strip along the bottom, which is the shape every
// programming tool for this work has had for thirty years: **what exists** on
// the left, **what is open** in the middle, **what can be put into it** on the
// right, and **what is wrong with it** underneath. An engineer opening this
// already knows where to look, and that is worth more than any arrangement
// this app could invent.
//
// The middle column is split again, and the split is the point: a block is its
// **interface** and its **body**, and the interface is above because it is what
// decides whether the block can be used twice. A tool that hides the
// declarations behind a tab produces blocks written against global tags, every
// time.
//
// Full screen is the browser's own, taken on this page's frame. Everything
// that appears over the top of it — the menus, the dialogs — is rendered
// inside the React tree rather than portalled to `document.body`, because the
// browser paints only the fullscreen element's own subtree and a portalled
// overlay would mount, take the clicks and be invisible. That has bitten this
// app before; see `components/SimorghDraw/overlayHost.ts` for the other half
// of the story.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PlayIcon, DownloadIcon, MaximizeIcon, MinimizeIcon, ListIcon,
  AlertCircleIcon, AlertTriangleIcon, InfoIcon, XIcon, WandSparklesIcon,
  SearchIcon, ReplaceIcon, CpuIcon, SaveIcon, TerminalIcon, PanelLeftIcon, LanguagesIcon,
} from 'lucide-react';
import { useTheme } from '../../useTheme';
import { useProject } from '../../context/ProjectContext';
import { usePlc } from './usePlc';
import { PlcProjectTree, TreeSelection } from './PlcProjectTree';
import { InstructionCatalog } from './InstructionCatalog';
import { InterfaceTable } from './InterfaceTable';
import { TagTable } from './TagTable';
import { SimorghMark } from '../shared/SimorghMark';
import { LadderEditor } from './LadderEditor';
import { CodeEditor, EditorActions } from './CodeEditor';
import { NewBlockDialog } from './NewBlockDialog';
import { PlcAssistant } from './PlcAssistant';
import {
  PlcBlock, PlcBlockKind, PlcNetwork, PlcTagTable, PlcVar, PLC_LANGUAGES,
  absoluteName, isGraphical, newPlcProject,
} from '../../utils/plc/model';
import { Instruction } from '../../utils/plc/instructions';
import { Problem, analyzeBlock, analyzeProject, countBySeverity } from '../../utils/plc/analyze';
import { blockToScl, projectToScl, tagsToCsv } from '../../utils/plc/sclExport';
import { LadderCursor, placeInstruction } from '../../utils/plc/ladderEdit';
import { downloadText, fileSafe } from '../../utils/download';
import { LANGS, Lang, STRINGS, dirOf, loadLang, saveLang } from './lang';
import { appConfirm } from '../shared/AppDialog';

/**
 * A pane the engineer can drag bigger.
 *
 * Every pane on this page is the wrong size for somebody: an interface with
 * thirty declarations wants the screen, and a block being read wants none of
 * it. Fixed proportions are a guess at which of those is happening, and the
 * guess is wrong about half the time — so the three splits are dragged, and
 * where they are put is remembered per person.
 */
function useDragSize(key: string, initial: number, min: number, max: number) {
  const [size, setSize] = useState<number>(() => {
    try {
      const raw = window.localStorage.getItem(`simorgh-plc-${key}`);
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : initial;
    } catch {
      return initial;
    }
  });

  const start = (e: React.MouseEvent, axis: 'x' | 'y', invert = false) => {
    e.preventDefault();
    const from = axis === 'x' ? e.clientX : e.clientY;
    const was = size;
    const move = (ev: MouseEvent) => {
      const now = axis === 'x' ? ev.clientX : ev.clientY;
      const delta = (now - from) * (invert ? -1 : 1);
      setSize(Math.min(max, Math.max(min, was + delta)));
    };
    const stop = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', stop);
      document.body.style.userSelect = '';
      setSize(current => {
        try { window.localStorage.setItem(`simorgh-plc-${key}`, String(current)); }
        catch { /* a browser that keeps nothing is not an error */ }
        return current;
      });
    };
    // Without this, dragging a splitter selects every label it passes over.
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', stop);
  };

  return { size, start };
}

const HANDLE_X = 'w-1 shrink-0 cursor-col-resize bg-gray-200 hover:bg-blue-400 transition-colors';
const HANDLE_Y = 'h-1 shrink-0 cursor-row-resize bg-gray-200 hover:bg-blue-400 transition-colors';

type RightPanel = 'instructions' | 'assistant' | null;
type BottomPanel = 'problems' | 'output' | null;

export const PlcTab: React.FC = () => {
  const { projectData } = useProject();
  const { theme } = useTheme();
  const { project, editable, setProject, patchBlock, started } = usePlc();

  const [selection, setSelection] = useState<TreeSelection>({ what: 'device' });
  const [rightPanel, setRightPanel] = useState<RightPanel>('instructions');
  // Both side panels can be put away. On a 1366-wide laptop the tree, the
  // catalogue and the block do not all fit at a readable size, and the one
  // that has to win is whichever the engineer is working in — so it is their
  // choice rather than a breakpoint's.
  const [showTree, setShowTree] = useState(true);
  const [bottomPanel, setBottomPanel] = useState<BottomPanel>('problems');
  const [armed, setArmed] = useState<Instruction | null>(null);
  const [adding, setAdding] = useState<PlcBlockKind | null>(null);
  const [tagTableId, setTagTableId] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [cursor, setCursor] = useState<{ line: number; column: number }>({ line: 1, column: 1 });
  const [output, setOutput] = useState<string[]>([]);
  const [interfaceOpen, setInterfaceOpen] = useState(true);
  // Where the ladder cursor is. Here rather than inside the editor because the
  // catalogue inserts too, and an instruction double-clicked there belongs
  // where the engineer last clicked on the rung.
  const [ladderCursor, setLadderCursor] = useState<LadderCursor | null>(null);
  // Which language the person at the keyboard reads. Theirs, not the
  // project's, so it is remembered in the browser and not in the file.
  const [lang, setLang] = useState<Lang>(loadLang);
  const t = STRINGS[lang];
  const dir = dirOf(lang);
  const chooseLang = (next: Lang) => { setLang(next); saveLang(next); };

  const frame = useRef<HTMLDivElement>(null);
  const editorActions = useRef<EditorActions | null>(null);

  const tree = useDragSize('tree', 256, 170, 520);
  const panel = useDragSize('panel', 340, 240, 640);
  const iface = useDragSize('iface', 230, 60, 620);
  const bottom = useDragSize('bottom', 190, 90, 560);

  // ── What is open ─────────────────────────────────────────────────────────

  const block: PlcBlock | null = useMemo(() => {
    if (selection.what !== 'block') return null;
    return project.blocks.find(b => b.id === selection.id) ?? null;
  }, [selection, project.blocks]);

  /**
   * Something sensible is always open.
   *
   * Two cases, and the second is the one that caught this out: the page is
   * opened and nothing has been picked yet, and — the harder one — what was
   * picked is no longer there. Starting a controller replaces the whole
   * program, so the block that was selected a moment ago has an id nothing
   * answers to, and the middle column goes blank on a page that visibly has a
   * program in the tree. So the test is whether the selection still points at
   * something, not whether anything has been picked.
   */
  useEffect(() => {
    if (selection.what === 'tags') return;
    if (selection.what === 'block' && project.blocks.some(b => b.id === selection.id)) return;
    const first = project.blocks.find(b => b.kind === 'OB') ?? project.blocks[0];
    if (first) setSelection({ what: 'block', id: first.id });
  }, [project.blocks, selection]);

  // The findings are written in whichever language is on screen, so the list
  // is rebuilt when that changes as well as when the program does.
  const problems = useMemo(() => analyzeProject(project, lang), [project, lang]);
  const blockProblems = useMemo(
    () => (block ? analyzeBlock(project, block, lang) : []), [project, block, lang]);
  const counts = useMemo(() => countBySeverity(problems), [problems]);

  // ── Full screen ──────────────────────────────────────────────────────────

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === frame.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      // Leaving full screen can be refused — another element holds it, the
      // document lost focus. Nothing on the page depends on it either way.
      document.exitFullscreen().catch(() => { /* still in a window; nothing lost */ });
      return;
    }
    frame.current?.requestFullscreen?.().catch(() => {
      // A browser that will not go full screen is not a failure worth a
      // dialog: the page works exactly as it did, in a window.
    });
  };

  // ── Editing ──────────────────────────────────────────────────────────────

  const start = () => setProject(newPlcProject());

  const setInterface = (next: PlcVar[]) => {
    if (!block) return;
    patchBlock(block.id, { interface: next });
  };

  const setNetworks = (next: PlcNetwork[]) => {
    if (!block) return;
    patchBlock(block.id, { networks: next });
  };

  const setCode = useCallback((next: string) => {
    if (!block) return;
    patchBlock(block.id, { code: next });
  }, [block, patchBlock]);

  const setTagTables = (tables: PlcTagTable[]) =>
    setProject(prev => ({ ...prev, tagTables: tables }));

  /**
   * The armed instruction, put wherever makes sense for the open block.
   *
   * In a drawn block the ladder editor owns the cursor and does the placing;
   * this is the text case, where the instruction's own SCL goes in as a
   * snippet at the caret. Both are the same gesture to the person doing it,
   * which is why the catalogue does not have to know which is which.
   */
  const insertInstruction = (instr: Instruction) => {
    if (!block || !editable) return;
    if (isGraphical(block.language)) {
      const placed = placeInstruction(block.networks ?? [], ladderCursor, instr);
      if (!placed) return;
      setNetworks(placed.networks);
      setLadderCursor(placed.cursor);
      return;
    }
    if (instr.scl) editorActions.current?.insertSnippet(instr.scl);
  };

  // ── Checking and exporting ───────────────────────────────────────────────

  const compile = () => {
    const found = analyzeProject(project, lang);
    const by = countBySeverity(found);
    const lines: string[] = [
      `── ${t.checkRunAt} ${new Date().toLocaleTimeString()} ─────────────`,
      `${project.blocks.length} ${t.blocksCount} · `
      + `${project.tagTables.reduce((n, table) => n + table.tags.length, 0)} ${t.plcTags}`,
      '',
    ];
    for (const p of found) {
      const where = p.line ? `line ${p.line}`
        : p.networkNumber ? `network ${p.networkNumber}` : '';
      lines.push(`${p.severity.toUpperCase().padEnd(7)} ${p.blockName}${where ? ` ${where}` : ''}: ${p.message}`);
    }
    lines.push('');
    lines.push(by.error === 0
      ? `${t.checkSummaryClean} ${by.warning} ${t.warnings} · ${by.info} ${t.notes}`
      : `${by.error} ${t.checkSummaryBad} ${by.warning} ${t.warnings}`);
    lines.push('');
    lines.push(t.checkCaveat);
    setOutput(lines);
    setBottomPanel('output');
  };

  const stem = fileSafe(projectData.projectName || 'project');

  const exportAll = () =>
    downloadText(`${stem}_plc.scl`, projectToScl(project), 'text/plain');

  const exportBlock = (b: PlcBlock) =>
    downloadText(`${fileSafe(b.name)}.scl`, blockToScl(b), 'text/plain');

  const exportTags = () =>
    downloadText(`${stem}_tags.csv`, tagsToCsv(project), 'text/csv');

  // ── The page that has no program yet ─────────────────────────────────────

  if (!started) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="max-w-xl text-center">
          <CpuIcon className="w-12 h-12 mx-auto text-emerald-600" />
          <h2 className="mt-4 text-xl font-semibold">{t.startTitle}</h2>
          <p className="mt-2 text-sm text-gray-600 leading-relaxed">{t.startWhat}</p>
          <button
            onClick={start}
            disabled={!editable}
            className="mt-5 inline-flex items-center gap-2 px-4 py-2 rounded bg-emerald-600 text-white
                       font-medium hover:bg-emerald-700 disabled:opacity-40"
          >
            <PlayIcon className="w-4 h-4" /> {t.startButton}
          </button>
          {!editable && (
            <p className="mt-3 text-xs text-amber-700">{t.startReadOnly}</p>
          )}
          <p className="mt-4 text-[11px] text-gray-500">{t.startNote}</p>
        </div>
      </div>
    );
  }

  // ── The page ─────────────────────────────────────────────────────────────

  const readOnly = !editable;

  return (
    <div ref={frame} dir={dir} className="h-full flex flex-col bg-gray-100 text-gray-900">
      {/* ── Toolbar ──────────────────────────────────────────────────────
          Left to right in either language. A toolbar is a row of pictures and
          not a sentence, and every package a controls engineer here has used
          runs it the same way round — see the drawing editor, which settled
          this argument first. */}
      <div dir="ltr" className="flex items-center gap-1.5 px-2 py-1.5 bg-white border-b border-gray-200 shrink-0">
        <button
          onClick={() => setShowTree(v => !v)}
          className={`p-1.5 rounded shrink-0 ${showTree ? 'hover:bg-gray-100' : 'bg-blue-100 text-blue-800'}`}
          title={showTree ? t.hideTree : t.showTree}
        >
          <PanelLeftIcon className="w-4 h-4" />
        </button>
        <CpuIcon className="w-4 h-4 text-emerald-600 shrink-0" />
        <input
          className="w-28 px-1.5 py-1 text-[12px] font-semibold rounded border border-transparent
                     hover:border-gray-300 focus:border-blue-400 focus:outline-none"
          value={project.device.name}
          readOnly={readOnly}
          title={t.deviceName}
          onChange={e => setProject(prev => ({
            ...prev, device: { ...prev.device, name: e.target.value },
          }))}
        />
        <input
          className="w-48 px-1.5 py-1 text-[12px] rounded border border-transparent
                     hover:border-gray-300 focus:border-blue-400 focus:outline-none text-gray-600"
          value={project.device.cpu}
          readOnly={readOnly}
          title={t.deviceCpu}
          onChange={e => setProject(prev => ({
            ...prev, device: { ...prev.device, cpu: e.target.value },
          }))}
        />

        <div className="w-px h-5 bg-gray-200 mx-1" />

        <ToolButton icon={<PlayIcon className="w-4 h-4" />} label={t.check} onClick={compile}
          title={t.checkTip} />
        <ToolButton icon={<DownloadIcon className="w-4 h-4" />} label={t.exportScl} onClick={exportAll}
          title={t.exportSclTip} />
        <ToolButton icon={<SaveIcon className="w-4 h-4" />} label={t.exportTags} onClick={exportTags}
          title={t.exportTagsTip} />

        <div className="w-px h-5 bg-gray-200 mx-1" />

        {block && !isGraphical(block.language) && (
          <>
            <ToolButton icon={<SearchIcon className="w-4 h-4" />} label=""
              title={t.find} onClick={() => editorActions.current?.find()} />
            <ToolButton icon={<ReplaceIcon className="w-4 h-4" />} label=""
              title={t.replace} onClick={() => editorActions.current?.replace()} />
            <ToolButton icon={<WandSparklesIcon className="w-4 h-4" />} label=""
              title={t.format} onClick={() => editorActions.current?.format()} />
            <ToolButton icon={<TerminalIcon className="w-4 h-4" />} label=""
              title={t.commands} onClick={() => editorActions.current?.commands()} />
          </>
        )}

        <div className="ms-auto flex items-center gap-1.5">
          <button
            onClick={() => setRightPanel(p => (p === 'instructions' ? null : 'instructions'))}
            title={rightPanel === 'instructions' ? t.hideCatalogue : t.instructions}
            className={`px-2 py-1 rounded text-[12px] inline-flex items-center gap-1.5
              ${rightPanel === 'instructions' ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-100'}`}
          >
            <ListIcon className="w-3.5 h-3.5" /> {t.instructions}
          </button>
          <button
            onClick={() => setRightPanel(p => (p === 'assistant' ? null : 'assistant'))}
            title={rightPanel === 'assistant' ? t.hideAssistant : t.assistant}
            className={`px-2 py-1 rounded text-[12px] inline-flex items-center gap-1.5
              ${rightPanel === 'assistant' ? 'bg-purple-100 text-purple-800' : 'hover:bg-gray-100'}`}
          >
            <SimorghMark className="w-4 h-4" /> {t.assistant}
          </button>
          {/* The language, as the two words themselves.
              A flag would be wrong twice over — Persian is not one country's,
              and the toolbar is a row of pictures whose order does not turn. */}
          <div className="flex items-center rounded border border-gray-200 overflow-hidden" title={t.language}>
            <LanguagesIcon className="w-3.5 h-3.5 mx-1 text-gray-500" />
            {LANGS.map(l => (
              <button
                key={l.id}
                onClick={() => chooseLang(l.id)}
                className={`px-1.5 py-1 text-[11px] ${lang === l.id
                  ? 'bg-blue-100 text-blue-800 font-semibold' : 'hover:bg-gray-100 text-gray-600'}`}
              >
                {l.label}
              </button>
            ))}
          </div>
          <button
            onClick={toggleFullscreen}
            className="p-1.5 rounded hover:bg-gray-100"
            title={fullscreen ? t.leaveFullscreen : t.fullscreen}
          >
            {fullscreen ? <MinimizeIcon className="w-4 h-4" /> : <MaximizeIcon className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* ── The three columns ────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex">
        {showTree && (
        <aside className="shrink-0 bg-white" style={{ width: tree.size }}>
          <PlcProjectTree
            project={project}
            selection={selection}
            problems={problems}
            readOnly={readOnly}
            onSelect={s => {
              setSelection(s);
              if (s.what === 'tags') setTagTableId(s.tableId);
            }}
            onAddBlock={kind => setAdding(kind)}
            onChange={setProject}
            onExportBlock={exportBlock}
            t={t}
          />
        </aside>
        )}
        {showTree && (
          <div className={HANDLE_X} onMouseDown={e => tree.start(e, 'x')} title="Drag to resize" />
        )}

        <main className="flex-1 min-w-0 flex flex-col bg-white">
          {selection.what === 'tags' && (
            <TagTable
              project={project}
              readOnly={readOnly}
              tableId={tagTableId}
              onTableId={setTagTableId}
              onChange={setTagTables}
              t={t}
              lang={lang}
            />
          )}

          {block && (
            <>
              {/* The block's own bar */}
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-200 bg-gray-50 shrink-0">
                <span className="text-[12px] font-semibold">{block.name}</span>
                <span className="text-[11px] text-gray-500 font-mono">[{absoluteName(block)}]</span>
                {/* A data block and a data type have no body, so there is
                    nothing to choose a language for. A disabled picker showing
                    "SCL" beside a table of values is a question nobody asked. */}
                {block.kind !== 'DB' && block.kind !== 'UDT' && (
                <select
                  className="text-[11px] px-1.5 py-0.5 rounded border border-gray-300 bg-white"
                  value={block.language}
                  disabled={readOnly}
                  title={t.languageOf}
                  onChange={async e => {
                    const next = e.target.value as PlcBlock['language'];
                    const wasGraphical = isGraphical(block.language);
                    const willBeGraphical = isGraphical(next);
                    if (wasGraphical !== willBeGraphical
                      && !await appConfirm(
                        `"${block.name}": ${block.language} → ${next}\n\n${t.changeLanguageAsk}`)) {
                      return;
                    }
                    patchBlock(block.id, {
                      language: next,
                      networks: willBeGraphical ? (block.networks ?? []) : block.networks,
                      code: willBeGraphical ? block.code : (block.code ?? ''),
                    });
                  }}
                >
                  {PLC_LANGUAGES.map(l => (
                    <option key={l.id} value={l.id}>{l.label}</option>
                  ))}
                </select>
                )}
                <input
                  className="flex-1 min-w-0 px-1.5 py-0.5 text-[11.5px] rounded border border-transparent
                             hover:border-gray-300 focus:border-blue-400 focus:outline-none text-gray-600"
                  value={block.comment ?? ''}
                  readOnly={readOnly}
                  placeholder={t.blockComment}
                  onChange={e => patchBlock(block.id, { comment: e.target.value })}
                />
                <button
                  className="text-[11px] px-2 py-0.5 rounded hover:bg-gray-200 shrink-0"
                  onClick={() => setInterfaceOpen(v => !v)}
                  title={interfaceOpen ? t.hideInterface : t.showInterface}
                >
                  {interfaceOpen ? t.hideInterface : t.showInterface}
                </button>
              </div>

              {/* The declarations */}
              {interfaceOpen && (
                <div className="shrink-0 overflow-auto" style={{ height: iface.size }}>
                  {block.dbKind === 'instance' ? (
                    <p className="px-3 py-3 text-[11.5px] text-gray-600">
                      This is the instance data block of{' '}
                      <span className="font-semibold">
                        {project.blocks.find(b => b.id === block.instanceOf)?.name ?? '(a missing block)'}
                      </span>
                      . Its rows are that function block&apos;s interface — change them there, and they
                      change here. A copy edited in two places is a copy that disagrees with itself.
                    </p>
                  ) : (
                    <InterfaceTable
                      project={project}
                      block={block}
                      readOnly={readOnly}
                      onChange={setInterface}
                      t={t}
                    />
                  )}
                </div>
              )}
              {interfaceOpen && (
                <div
                  className={HANDLE_Y}
                  onMouseDown={e => iface.start(e, 'y')}
                  title="Drag to give the declarations more or less room"
                />
              )}

              {/* The body */}
              <div className="flex-1 min-h-0">
                {block.kind === 'DB' || block.kind === 'UDT' ? (
                  <div className="h-full overflow-auto p-4 text-[12px] text-gray-600">
                    <p>
                      {block.kind === 'DB' ? t.dbIsValues : t.udtIsStruct}
                    </p>
                    <pre className="mt-3 p-3 rounded bg-gray-50 border border-gray-200 font-mono
                                    text-[11px] whitespace-pre-wrap overflow-auto">
                      {blockToScl(block)}
                    </pre>
                  </div>
                ) : isGraphical(block.language) ? (
                  <LadderEditor
                    project={project}
                    block={block}
                    readOnly={readOnly}
                    armed={armed}
                    onInserted={() => setArmed(null)}
                    cursor={ladderCursor}
                    onCursor={setLadderCursor}
                    onChange={setNetworks}
                    t={t}
                  />
                ) : (
                  <CodeEditor
                    documentId={block.id}
                    value={block.code ?? ''}
                    language={block.language === 'STL' ? 'STL' : block.language === 'GRAPH' ? 'GRAPH' : 'SCL'}
                    project={project}
                    block={block}
                    problems={blockProblems}
                    t={t}
                    readOnly={readOnly}
                    dark={theme === 'dark'}
                    onChange={setCode}
                    onSave={compile}
                    onCursor={(line, column) => setCursor({ line, column })}
                    actionsRef={editorActions}
                  />
                )}
              </div>
            </>
          )}

          {selection.what === 'device' && !block && (
            <div className="flex-1 flex items-center justify-center text-[12px] text-gray-500">
              {t.pickABlock}
            </div>
          )}

          {/* ── Problems and output ──────────────────────────────────── */}
          {bottomPanel && (
            <div className={HANDLE_Y} onMouseDown={e => bottom.start(e, 'y', true)} title="Drag to resize" />
          )}
          {bottomPanel && (
            <div className="shrink-0 flex flex-col bg-white" style={{ height: bottom.size }}>
              <div className="flex items-center gap-1 px-2 py-1 border-b border-gray-200 bg-gray-50 shrink-0">
                <button
                  className={`px-2 py-0.5 rounded text-[11.5px] ${bottomPanel === 'problems'
                    ? 'bg-white shadow-sm font-semibold' : 'hover:bg-gray-200'}`}
                  onClick={() => setBottomPanel('problems')}
                >
                  {t.problems}
                  {counts.error > 0 && <span className="ms-1.5 text-red-600 font-semibold">{counts.error}</span>}
                  {counts.warning > 0 && <span className="ms-1.5 text-amber-600">{counts.warning}</span>}
                </button>
                <button
                  className={`px-2 py-0.5 rounded text-[11.5px] ${bottomPanel === 'output'
                    ? 'bg-white shadow-sm font-semibold' : 'hover:bg-gray-200'}`}
                  onClick={() => setBottomPanel('output')}
                >
                  {t.output}
                </button>
                <button
                  className="ms-auto p-1 rounded hover:bg-gray-200"
                  onClick={() => setBottomPanel(null)}
                  title={t.closeStrip}
                >
                  <XIcon className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-auto">
                {bottomPanel === 'problems' && (
                  problems.length === 0 ? (
                    <p className="px-3 py-4 text-[12px] text-emerald-700">
                      {t.nothingWrong}
                    </p>
                  ) : (
                    <table className="w-full text-[11.5px] min-w-[620px]">
                      <tbody>
                        {problems.map((p, i) => (
                          <tr
                            key={i}
                            className="border-b border-gray-100 hover:bg-blue-50 cursor-pointer"
                            onClick={() => {
                              if (p.blockId) setSelection({ what: 'block', id: p.blockId });
                              const { line, column } = p;
                              if (line !== undefined) {
                                // Let the editor swap documents first, then jump.
                                window.setTimeout(() => editorActions.current?.reveal(line, column), 60);
                              }
                            }}
                          >
                            <td className="px-2 py-1 w-6 align-top">{severityIcon(p.severity)}</td>
                            <td className="px-2 py-1 w-36 truncate font-medium align-top">{p.blockName}</td>
                            <td className="px-2 py-1 w-20 text-gray-500 font-mono align-top">
                              {p.line ? `line ${p.line}` : p.networkNumber ? `nw ${p.networkNumber}` : ''}
                            </td>
                            <td className="px-2 py-1">
                              {p.message}
                              {/* The code sits with the message rather than in
                                  a column of its own: it is for searching and
                                  for reporting, and a column for it takes room
                                  from the sentence somebody has to read. */}
                              <span className="ms-2 text-gray-400 font-mono">{p.code}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                )}

                {bottomPanel === 'output' && (
                  <pre className="px-3 py-2 text-[11px] font-mono whitespace-pre-wrap">
                    {output.length === 0
                      ? t.pressCheck
                      : output.join('\n')}
                  </pre>
                )}
              </div>
            </div>
          )}
        </main>

        {rightPanel && (
          <div className={HANDLE_X} onMouseDown={e => panel.start(e, 'x', true)} title="Drag to resize" />
        )}
        {rightPanel && (
        <aside className="shrink-0" style={{ width: panel.size }}>
          {rightPanel === 'instructions' ? (
            <InstructionCatalog
              armed={armed}
              onArm={setArmed}
              onInsert={insertInstruction}
              language={block?.language ?? 'SCL'}
              readOnly={readOnly || !block}
              t={t}
              lang={lang}
            />
          ) : (
            <PlcAssistant
              project={project}
              block={block}
              problems={problems}
              readOnly={readOnly}
              onApply={setProject}
              t={t}
              lang={lang}
            />
          )}
        </aside>
        )}
      </div>

      {/* ── Status bar ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-3 py-1 bg-gray-50 border-t border-gray-200 text-[11px] text-gray-600 shrink-0">
        <span className="inline-flex items-center gap-1">
          <AlertCircleIcon className="w-3.5 h-3.5 text-red-600" /> {counts.error}
        </span>
        <span className="inline-flex items-center gap-1">
          <AlertTriangleIcon className="w-3.5 h-3.5 text-amber-500" /> {counts.warning}
        </span>
        <span className="inline-flex items-center gap-1">
          <InfoIcon className="w-3.5 h-3.5 text-blue-500" /> {counts.info}
        </span>
        {!bottomPanel && (
          <button className="underline hover:text-blue-700" onClick={() => setBottomPanel('problems')}>
            {t.show}
          </button>
        )}
        <span className="ms-auto" />
        {block && !isGraphical(block.language) && block.kind !== 'DB' && block.kind !== 'UDT' && (
          <span className="font-mono">Ln {cursor.line}, Col {cursor.column}</span>
        )}
        {block && block.kind !== 'DB' && block.kind !== 'UDT' && <span>{block.language}</span>}
        <span>{project.blocks.length} {t.blocksCount}</span>
        {readOnly && <span className="text-amber-700 font-medium">{t.readOnlyRevision}</span>}
      </div>

      {adding && (
        <NewBlockDialog
          project={project}
          initialKind={adding}
          t={t}
          onCancel={() => setAdding(null)}
          onCreate={b => {
            setProject(prev => ({ ...prev, blocks: [...prev.blocks, b] }));
            setSelection({ what: 'block', id: b.id });
            setAdding(null);
          }}
        />
      )}
    </div>
  );
};

function severityIcon(s: Problem['severity']): React.ReactNode {
  if (s === 'error') return <AlertCircleIcon className="w-3.5 h-3.5 text-red-600" />;
  if (s === 'warning') return <AlertTriangleIcon className="w-3.5 h-3.5 text-amber-500" />;
  return <InfoIcon className="w-3.5 h-3.5 text-blue-500" />;
}

const ToolButton: React.FC<{
  icon: React.ReactNode; label: string; title: string; onClick: () => void;
}> = ({ icon, label, title, onClick }) => (
  <button
    className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[12px] hover:bg-gray-100"
    title={title}
    onClick={onClick}
  >
    {icon}{label && <span>{label}</span>}
  </button>
);

export default PlcTab;
