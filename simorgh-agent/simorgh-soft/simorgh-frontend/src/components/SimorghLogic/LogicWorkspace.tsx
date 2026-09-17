import React, { useMemo, useState } from 'react';
import {
  AlertTriangleIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon,
  CodeIcon, CpuIcon, DownloadIcon, FactoryIcon, FilesIcon, LayersIcon, PrinterIcon,
  SendIcon, XIcon,
} from 'lucide-react';

import logoMark from '../../assets/logo-mark.png';
import { LadderQuestion, ladderService } from '../../services/projectService';
import { useProject } from '../../context/ProjectContext';
import { PageNavigator } from '../SimorghDraw/PageNavigator';
import { DrawingPage, readPages } from '../../utils/cad/pages';
import { renderFragment } from '../../utils/cad/svg';
import { renderDxf } from '../../utils/cad/dxf';
import { renderPdf } from '../../utils/cad/pdf';
import { downloadBlob, downloadText, fileSafe } from '../../utils/download';
import {
  DIALECTS, Dialect, dialectBriefing, dialectOf,
} from '../../utils/ladder/dialects';
import { LadderProgram, Tag, readProgram } from '../../utils/ladder/model';
import { renderProgram } from '../../utils/ladder/render';

// Simorgh Logic — a room of its own.
//
// This is deliberately not a tab. Ladder is a different job from drawing a
// panel: a different vocabulary, a different unit of work, a different person
// at the keyboard half the time. Putting it beside the single line as one more
// tab would mean every switchgear drawing carries a PLC toolbar it never wants,
// and every ladder program is one mis-click from the busbar. So it takes the
// whole window and hands it back on the way out.
//
// Three columns, which is the shape of the work: what you asked for and what it
// said on the left, the ladder in the middle, the tags on the right. The three
// pickers along the top are answered before anything is written, because the
// vendor decides what the blocks are called and there is no useful answer to
// "write me a program" without one.

interface Props {
  /** Stem for downloaded file names — the project this belongs to. */
  fileBase: string;
  /** Lines for the title block on what is printed. */
  titleBlock: string[];
  onClose: () => void;
}

const LANGUAGE_NOTE =
  'Ladder is what is drawn here whichever language you pick — the choice tells the assistant which one you will type it into, so it explains in those terms.';

type View = 'pages' | 'ladder';

export const LogicWorkspace: React.FC<Props> = ({ fileBase, titleBlock, onClose }) => {
  const [view, setView] = useState<View>('ladder');
  const { projectData, patchProjectData, isCurrentRevisionEditable } = useProject();

  // Nothing is chosen to begin with, and the Write button stays out of reach
  // until it is.
  //
  // Defaulting to the first vendor in the table would have been friendlier for
  // about four seconds and wrong afterwards: a program written for a Siemens
  // S7-1200 because nobody noticed the box already said so is a program that
  // cannot be typed into the machine it was asked for. The empty chip is the
  // question, and the disabled button is what makes it get answered.
  const [vendor, setVendor] = useState('');
  const [dialectId, setDialectId] = useState('');
  const dialect: Dialect = dialectOf(dialectId);
  const [controller, setController] = useState('');
  const [language, setLanguage] = useState('');
  const [style, setStyle] = useState<'teach' | 'brief'>('teach');
  const chosen = Boolean(vendor && dialectId && controller && language);
  const [note, setNote] = useState<string | null>(null);

  const [task, setTask] = useState('');
  const [working, setWorking] = useState(false);
  const [program, setProgram] = useState<LadderProgram | null>(null);
  const [dropped, setDropped] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [openStep, setOpenStep] = useState<number | null>(null);

  // What the assistant asked instead of guessing, and what has been picked.
  const [questions, setQuestions] = useState<LadderQuestion[] | null>(null);
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [settled, setSettled] = useState<{ ask: string; chose: string }[]>([]);

  const drawPages: DrawingPage[] = useMemo(
    () => readPages(projectData.drawingPages), [projectData.drawingPages]);

  const families = DIALECTS.filter(d => d.vendor === vendor);
  const allAnswered = questions
    ? questions.every((_, i) => (picked[i] ?? []).length > 0)
    : false;

  // Choosing one thing clears what hung off it, rather than filling it in.
  //
  // Auto-selecting the first family of a vendor and its first controller would
  // save two clicks and cost the point of asking: the chips would be answered
  // without anybody deciding, and a program for an S7-1211C would go out
  // because that is what came first in a list. An unanswered chip is a
  // question; a pre-answered one is a trap.
  const chooseVendor = (v: string) => {
    setVendor(v);
    setDialectId('');
    setController('');
    setLanguage('');
  };

  const chooseFamily = (id: string) => {
    setDialectId(id);
    setController('');
    setLanguage('');
  };

  const pages = useMemo(
    () => (program ? renderProgram(program) : []), [program]);
  const sheet = pages[Math.min(page, Math.max(0, pages.length - 1))];

  const ask = async (withAnswers = settled) => {
    if (task.trim().length < 3 || working || !chosen) return;
    setWorking(true);
    setError(null);
    setRaw(null);

    const answer = await ladderService.generate({
      task: task.trim(),
      // The vocabulary is written here, from the table in this browser, and
      // sent with the request. The server never holds a copy to go stale.
      briefing: dialectBriefing(dialect),
      controller,
      language,
      style,
      answers: withAnswers,
    });

    // Asked rather than answered. Everything already settled stays settled, so
    // a second round asks about what is left rather than starting again.
    if (answer.success && answer.questions?.length) {
      setQuestions(answer.questions);
      setPicked({});
      setWorking(false);
      return;
    }

    if (!answer.success || !answer.program) {
      setError(answer.error ?? 'The assistant did not answer.');
      setRaw(answer.raw ?? null);
      setWorking(false);
      return;
    }

    // Validated here, by the same reader a saved program is read back through.
    const read = readProgram(answer.program, dialect.id);
    read.program.controller = controller;
    read.program.language = language;
    read.program.dialect = dialect.id;

    if (read.program.rungs.length === 0) {
      setError('Nothing in that answer could be drawn as a rung.');
      setRaw(JSON.stringify(answer.program).slice(0, 1500));
      setWorking(false);
      return;
    }

    setProgram(read.program);
    setDropped(read.dropped);
    setQuestions(null);
    setPage(0);
    setOpenStep(read.program.steps?.length ? 0 : null);
    setWorking(false);
  };

  /** Hand the picked options back and ask again. */
  const answerQuestions = () => {
    if (!questions || !allAnswered) return;
    const next = [
      ...settled,
      ...questions.map((q, i) => ({ ask: q.ask, chose: (picked[i] ?? []).join('; ') })),
    ];
    setSettled(next);
    setQuestions(null);
    ask(next);
  };

  const download = (what: 'dxf' | 'pdf') => {
    if (pages.length === 0) return;
    const stem = fileSafe(`${fileBase}_${program?.title ?? 'ladder'}`);
    if (what === 'dxf') {
      downloadText(`${stem}.dxf`, renderDxf(pages[0].drawing), 'application/dxf');
      return;
    }
    downloadBlob(`${stem}.pdf`, renderPdf(pages.map(p => p.drawing), {
      paper: 'A3',
      frame: true,
      titleBlock: [...titleBlock, program?.title ?? '', controller].filter(Boolean),
    }));
  };

  return (
    <div className="fixed inset-0 z-[300] bg-slate-100 flex flex-col">
      {/* ── The bar ──────────────────────────────────────────────────── */}
      <header className="bg-slate-800 text-white px-4 py-2.5 flex items-center gap-3 shrink-0">
        <img src={logoMark} alt="" aria-hidden className="w-7 h-7 object-contain brightness-0 invert" />
        <div className="min-w-0">
          <h1 className="text-base font-semibold leading-tight">Simorgh Draw</h1>
          <p className="text-[11px] text-slate-300">
            {view === 'ladder' ? 'Ladder, written and explained' : 'The pages of this project'}
          </p>
        </div>

        {/* The switcher, in the far corner.
            Two pictures rather than two words: this bar is read once and then
            lived beside, and by the second day nobody is reading the label —
            they are hitting the icon on the right. */}
        <div className="ms-auto flex items-center gap-1 bg-slate-900/60 rounded-lg p-1">
          <ViewButton
            on={view === 'pages'} onClick={() => setView('pages')}
            title="Pages — the drawing set" Icon={FilesIcon} />
          <ViewButton
            on={view === 'ladder'} onClick={() => setView('ladder')}
            title="Ladder — PLC programming" Icon={CpuIcon} />
        </div>

        <button
          onClick={onClose}
          className="p-1.5 rounded hover:bg-white/20 shrink-0"
          title="Back to the project"
        >
          <XIcon className="w-5 h-5" />
        </button>
      </header>

      {view === 'pages' ? (
        <div className="flex-1 min-h-0 overflow-auto p-5 bg-slate-100">
          <div className="max-w-5xl mx-auto">
            <PageNavigator
              pages={drawPages}
              edits={projectData.drawingEdits}
              onChange={(next, edits) =>
                patchProjectData(() => ({ drawingPages: next, drawingEdits: edits }))}
              // Opening a page belongs to the drawing tab, which is where the
              // editor lives. From here the tree is for getting the set in
              // order — adding, naming, reordering — so a click on a page says
              // where to go rather than pretending to open it.
              onOpen={() => setNote('Open a page from Simorgh Draw → Pages in the project.')}
              canEdit={isCurrentRevisionEditable}
              fileBase={fileBase}
            />
            {note && (
              <p className="mt-3 text-[12px] text-slate-600 bg-white border rounded px-3 py-2">{note}</p>
            )}
          </div>
        </div>
      ) : (
      <div className="flex-1 min-h-0 flex">
        {/* ── What you asked, and what it said ───────────────────────── */}
        <aside className="w-[24rem] shrink-0 border-e border-slate-300 bg-white flex flex-col min-h-0">
          <div className="p-3 border-b space-y-2.5">
            {/* The chips.
                Four things the assistant cannot work without, asked as chips
                above the box rather than as dropdowns in a bar — they belong to
                the question being asked, not to the room. Each one is empty
                until it is answered, and the button below stays out of reach
                while any of them is. */}
            <div className="flex flex-wrap gap-1.5">
              <Chip
                Icon={FactoryIcon} label="Vendor" value={vendor}
                options={[...new Set(DIALECTS.map(d => d.vendor))]}
                onChange={chooseVendor}
              />
              {vendor && (
                <Chip
                  Icon={LayersIcon} label="Family" value={dialectId}
                  options={families.map(d => d.id)}
                  display={id => dialectOf(id).family}
                  onChange={chooseFamily}
                />
              )}
              {dialectId && (
                <Chip
                  Icon={CpuIcon} label="Controller" value={controller}
                  options={dialect.controllers} onChange={setController}
                />
              )}
              {dialectId && (
                <Chip
                  Icon={CodeIcon} label="Language" value={language}
                  options={dialect.languages} onChange={setLanguage}
                  note={LANGUAGE_NOTE}
                />
              )}
            </div>

            {dialectId && (
              <p className="text-[11px] text-gray-500 leading-relaxed">
                {dialect.software} · {dialect.addressing.note}
              </p>
            )}

            <label className="block">
              <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                What should the program do?
              </span>
              <textarea
                value={task}
                onChange={e => setTask(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ask(); }}
                rows={5}
                placeholder={'Start and stop a conveyor from two push buttons, with a seal-in and an overload.\nRun a lamp five seconds after it starts.\nCount the boxes past a sensor and stop at 100.'}
                className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm resize-y"
              />
            </label>

            <div className="flex items-center gap-2">
              <select
                value={style}
                onChange={e => setStyle(e.target.value as 'teach' | 'brief')}
                className="border border-gray-300 rounded px-2 py-1.5 text-sm"
                title="How much to explain"
              >
                <option value="teach">Explain each step</option>
                <option value="brief">Keep it short</option>
              </select>
              <button
                onClick={() => ask()}
                disabled={working || !chosen || task.trim().length < 3}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-violet-700 text-white text-sm font-medium hover:bg-violet-800 disabled:opacity-40"
              >
                <SendIcon className="w-4 h-4" />
                {working ? 'Writing…' : 'Write the program'}
              </button>
            </div>

            <p className="text-[11px] text-gray-400">
              {!chosen
                ? 'Answer the chips above first — the vendor decides what the blocks are called.'
                : 'Ctrl+Enter sends it.'}
            </p>

            {settled.length > 0 && (
              <div className="pt-1 border-t">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Settled</p>
                <ul className="mt-1 space-y-0.5">
                  {settled.map((a, i) => (
                    <li key={i} className="text-[11px] text-gray-600">
                      <span className="text-gray-400">{a.ask}</span> — {a.chose}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {questions && (
              <div className="rounded border border-violet-300 bg-violet-50 p-3 space-y-3">
                <p className="text-[12px] text-violet-900">
                  Before writing it, {questions.length === 1 ? 'one thing' : `${questions.length} things`} that
                  would change the program:
                </p>

                {questions.map((q, i) => (
                  <div key={i} className="space-y-1.5">
                    <p className="text-[12.5px] font-medium text-gray-900">{q.ask}</p>
                    {q.why && <p className="text-[11px] text-gray-600">{q.why}</p>}
                    <div className="space-y-1">
                      {q.options.map(option => {
                        const on = (picked[i] ?? []).includes(option.label);
                        return (
                          <button
                            key={option.label}
                            onClick={() => setPicked(prev => {
                              const was = prev[i] ?? [];
                              // One answer replaces; several toggle.
                              const now = q.multi
                                ? (was.includes(option.label)
                                    ? was.filter(v => v !== option.label)
                                    : [...was, option.label])
                                : [option.label];
                              return { ...prev, [i]: now };
                            })}
                            className={`w-full text-start px-2.5 py-1.5 rounded border text-[12px] flex items-start gap-2 ${
                              on
                                ? 'border-violet-500 bg-white text-violet-900'
                                : 'border-gray-300 bg-white text-gray-800 hover:border-violet-400'}`}
                          >
                            <span className={`mt-0.5 w-3.5 h-3.5 shrink-0 flex items-center justify-center border ${
                              q.multi ? 'rounded-sm' : 'rounded-full'
                            } ${on ? 'border-violet-600 bg-violet-600 text-white' : 'border-gray-400'}`}>
                              {on && <CheckIcon className="w-2.5 h-2.5" />}
                            </span>
                            <span className="min-w-0">
                              <span className="block">{option.label}</span>
                              {option.note && (
                                <span className="block text-[11px] text-gray-500">{option.note}</span>
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}

                <button
                  onClick={answerQuestions}
                  disabled={!allAnswered || working}
                  className="w-full px-3 py-2 rounded-md bg-violet-700 text-white text-sm font-medium hover:bg-violet-800 disabled:opacity-40"
                >
                  {allAnswered ? 'Carry on with these' : 'Pick one of each to carry on'}
                </button>
              </div>
            )}

            {error && (
              <div className="rounded border border-red-200 bg-red-50 p-2.5">
                <p className="flex items-start gap-2 text-[12px] text-red-800">
                  <AlertTriangleIcon className="w-4 h-4 mt-0.5 shrink-0" /> {error}
                </p>
                {raw && (
                  <pre className="mt-2 text-[10px] leading-snug text-gray-700 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                    {raw}
                  </pre>
                )}
              </div>
            )}

            {dropped.length > 0 && (
              <div className="rounded border border-amber-200 bg-amber-50 p-2.5">
                <p className="text-[12px] font-medium text-amber-900">
                  {dropped.length} thing{dropped.length === 1 ? '' : 's'} in that answer could not be drawn
                </p>
                <ul className="mt-1 space-y-0.5">
                  {dropped.map((d, i) => (
                    <li key={i} className="text-[11px] text-amber-800">{d}</li>
                  ))}
                </ul>
              </div>
            )}

            {program?.steps?.length ? (
              <ol className="space-y-1.5">
                {program.steps.map((step, i) => {
                  const open = openStep === i;
                  return (
                    <li key={i} className="border border-gray-200 rounded">
                      <button
                        onClick={() => {
                          setOpenStep(open ? null : i);
                          // Jump to the page this step's first rung is on, so
                          // reading the explanation and looking at the rung are
                          // one action rather than two.
                          const first = step.rungs[0];
                          const at = pages.findIndex(p => p.rungs.includes(first));
                          if (at >= 0) setPage(at);
                        }}
                        className={`w-full text-start px-2.5 py-2 ${open ? 'bg-violet-50' : 'hover:bg-gray-50'}`}
                      >
                        <span className="text-[12px] font-medium text-gray-900">
                          {i + 1}. {step.title}
                        </span>
                        {step.rungs.length > 0 && (
                          <span className="ms-2 text-[10px] text-gray-400">
                            rung{step.rungs.length === 1 ? '' : 's'} {step.rungs.join(', ')}
                          </span>
                        )}
                      </button>
                      {open && step.explain && (
                        <p className="px-2.5 pb-2.5 text-[12px] leading-relaxed text-gray-700 whitespace-pre-wrap">
                          {step.explain}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>
            ) : !program && !error && (
              <div className="text-[12px] text-gray-500 leading-relaxed space-y-2">
                <p>
                  Pick the controller at the top, say what the machine should do, and the
                  assistant writes the rungs and walks through them.
                </p>
                <p className="text-gray-400">
                  It writes with {dialect.vendor}&rsquo;s own blocks — {' '}
                  {Object.values(dialect.blocks).slice(0, 4).map(b => b.type).join(', ')} — and
                  {dialect.vendor === 'IEC 61131-3' ? ' the standard’s' : ' that vendor’s'} addressing.
                </p>
                <p className="text-amber-700">
                  What it writes is a draft for an engineer to read, not a program to
                  download to a running machine.
                </p>
              </div>
            )}
          </div>
        </aside>

        {/* ── The ladder ─────────────────────────────────────────────── */}
        <main className="flex-1 min-w-0 flex flex-col bg-slate-200">
          <div className="px-3 py-2 bg-white border-b flex items-center gap-2 flex-wrap shrink-0">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">
                {program?.title ?? 'No program yet'}
              </p>
              {program && (
                <p className="text-[11px] text-gray-500">
                  {program.rungs.length} rung{program.rungs.length === 1 ? '' : 's'} · {controller}
                </p>
              )}
            </div>

            {pages.length > 1 && (
              <div className="ms-auto flex items-center gap-1">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="p-1.5 rounded border border-gray-300 bg-white disabled:opacity-30"
                >
                  <ChevronLeftIcon className="w-4 h-4" />
                </button>
                <span className="text-[12px] text-gray-600 px-1">
                  {sheet?.index ?? 1} / {pages.length}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(pages.length - 1, p + 1))}
                  disabled={page >= pages.length - 1}
                  className="p-1.5 rounded border border-gray-300 bg-white disabled:opacity-30"
                >
                  <ChevronRightIcon className="w-4 h-4" />
                </button>
              </div>
            )}

            <div className={`flex items-center gap-2 ${pages.length > 1 ? '' : 'ms-auto'}`}>
              <button
                onClick={() => download('dxf')}
                disabled={pages.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-40"
              >
                <DownloadIcon className="w-4 h-4" /> DXF
              </button>
              <button
                onClick={() => download('pdf')}
                disabled={pages.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-40"
              >
                <PrinterIcon className="w-4 h-4" /> PDF
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-auto p-5">
            {sheet ? (
              // Cropped to what is drawn rather than shown as a whole sheet.
              // The drawing is still the full A3 that prints and exports — but
              // a three-rung program shown as an A3 is three rungs in the top
              // corner, and the reader has to squint at the one part that
              // matters.
              <svg
                viewBox={`0 0 ${sheet.drawing.width} ${sheet.used}`}
                preserveAspectRatio="xMidYMin meet"
                className="w-full bg-white shadow"
                style={{ maxHeight: '100%' }}
                dangerouslySetInnerHTML={{ __html: renderFragment(sheet.drawing) }}
              />
            ) : (
              <p className="h-full flex items-center justify-center text-sm text-gray-500 text-center px-8">
                The ladder appears here.
              </p>
            )}
          </div>
        </main>

        {/* ── The tags ───────────────────────────────────────────────── */}
        <aside className="w-[19rem] shrink-0 border-s border-slate-300 bg-white flex flex-col min-h-0">
          <div className="px-3 py-2 border-b bg-gray-50">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Tags {program?.tags.length ? `· ${program.tags.length}` : ''}
            </h2>
          </div>
          {program?.tags.length ? (
            <div className="flex-1 overflow-y-auto">
              <TagTable tags={program.tags} />
            </div>
          ) : (
            <p className="p-3 text-[12px] text-gray-500 leading-relaxed">
              Every address the program uses is listed here, with what it is —
              the table you would type into the controller before the program.
            </p>
          )}
        </aside>
      </div>
      )}
    </div>
  );
};

const ViewButton: React.FC<{
  on: boolean; onClick: () => void; title: string;
  Icon: React.FC<{ className?: string }>;
}> = ({ on, onClick, title, Icon }) => (
  <button
    onClick={onClick}
    title={title}
    aria-pressed={on}
    className={`p-1.5 rounded-md transition ${
      on ? 'bg-white text-slate-900' : 'text-slate-300 hover:text-white hover:bg-white/10'}`}
  >
    <Icon className="w-4 h-4" />
  </button>
);

const KIND_ORDER: Tag['kind'][] = ['input', 'output', 'memory', 'timer', 'counter', 'data'];

const TagTable: React.FC<{ tags: Tag[] }> = ({ tags }) => {
  // Grouped by what the address is, because that is how somebody reads a tag
  // table: all the inputs, then all the outputs.
  const groups = KIND_ORDER
    .map(kind => ({ kind, rows: tags.filter(t => t.kind === kind) }))
    .filter(g => g.rows.length > 0);
  const rest = tags.filter(t => !t.kind || !KIND_ORDER.includes(t.kind));
  if (rest.length) groups.push({ kind: undefined, rows: rest });

  return (
    <table className="w-full text-[11px]">
      <tbody>
        {groups.map(group => (
          <React.Fragment key={group.kind ?? 'other'}>
            <tr>
              <th colSpan={2} className="text-start px-3 py-1 bg-gray-50 border-y text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                {group.kind ?? 'other'}
              </th>
            </tr>
            {group.rows.map((t, i) => (
              <tr key={i} className="border-b border-gray-100 align-top">
                <td className="px-3 py-1.5 font-mono text-gray-900 whitespace-nowrap">{t.at}</td>
                <td className="px-3 py-1.5">
                  {t.name && <span className="block text-gray-800">{t.name}</span>}
                  {t.comment && <span className="block text-gray-500">{t.comment}</span>}
                  {t.type && <span className="block text-gray-400">{t.type}</span>}
                </td>
              </tr>
            ))}
          </React.Fragment>
        ))}
      </tbody>
    </table>
  );
};

/**
 * One of the answers the assistant cannot work without.
 *
 * A chip rather than a labelled dropdown: unanswered it reads as a question
 * sitting there waiting, answered it reads as a fact. A row of dropdowns with
 * plausible values already in them reads as neither, which is how somebody
 * ends up with a program for a controller they never chose.
 */
const Chip: React.FC<{
  Icon: React.FC<{ className?: string }>;
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  display?: (v: string) => string;
  note?: string;
}> = ({ Icon, label, value, options, onChange, display, note }) => {
  const [open, setOpen] = useState(false);
  const shown = value ? (display ? display(value) : value) : label;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        title={note ?? label}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-md border text-[12px] max-w-[15rem] ${
          value
            ? 'border-gray-300 bg-white text-gray-800'
            : 'border-dashed border-violet-400 bg-violet-50 text-violet-800'}`}
      >
        <Icon className="w-3.5 h-3.5 shrink-0 opacity-70" />
        <span className="truncate">{shown}</span>
        <ChevronDownIcon className="w-3 h-3 shrink-0 opacity-50" />
      </button>

      {open && (
        <>
          {/* A click anywhere else closes it, which is what every other menu on
              this machine does. */}
          <div className="fixed inset-0 z-[10]" onClick={() => setOpen(false)} />
          <ul className="absolute z-[20] mt-1 min-w-[14rem] max-h-72 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg py-1">
            {note && (
              <li className="px-3 py-1.5 text-[11px] text-gray-500 border-b leading-relaxed">{note}</li>
            )}
            {options.map(o => (
              <li key={o}>
                <button
                  onClick={() => { onChange(o); setOpen(false); }}
                  className={`w-full text-start px-3 py-1.5 text-[12.5px] hover:bg-violet-50 ${
                    o === value ? 'text-violet-800 font-medium' : 'text-gray-800'}`}
                >
                  {display ? display(o) : o}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
};
