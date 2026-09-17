import React, { useMemo, useState } from 'react';
import {
  ChevronLeftIcon, ChevronRightIcon, CpuIcon, DownloadIcon, FilesIcon,
  PrinterIcon, XIcon,
} from 'lucide-react';

import logoMark from '../../assets/logo-mark.png';
import { LadderAsk } from './LadderAsk';
import { useProject } from '../../context/ProjectContext';
import { PageNavigator } from '../SimorghDraw/PageNavigator';
import { DrawingPage, readPages } from '../../utils/cad/pages';
import { renderFragment } from '../../utils/cad/svg';
import { renderDxf } from '../../utils/cad/dxf';
import { renderPdf } from '../../utils/cad/pdf';
import { downloadBlob, downloadText, fileSafe } from '../../utils/download';
import { LadderProgram, Tag } from '../../utils/ladder/model';
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
  // The vendor, the task and the questions all live in LadderAsk — the same
  // component the assistant panel in the drawing editor uses. What is left
  // here is what this workspace adds: the pages, the steps and the tags.
  const [program, setProgram] = useState<LadderProgram | null>(null);
  const [dropped, setDropped] = useState<string[]>([]);
  const [controller, setController] = useState('');
  const [page, setPage] = useState(0);
  const [openStep, setOpenStep] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const drawPages: DrawingPage[] = useMemo(
    () => readPages(projectData.drawingPages), [projectData.drawingPages]);

  const pages = useMemo(
    () => (program ? renderProgram(program) : []), [program]);
  const sheet = pages[Math.min(page, Math.max(0, pages.length - 1))];

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
          <div className="p-3 border-b">
            <LadderAsk
              onProgram={({ program: made, dropped: lost, controller: on }) => {
                setProgram(made);
                setDropped(lost);
                setController(on);
                setPage(0);
                setOpenStep(made.steps?.length ? 0 : null);
              }}
              footnote={
                <p className="text-[11px] text-amber-700 leading-relaxed">
                  What it writes is a draft for an engineer to read, not a program to
                  download to a running machine.
                </p>
              }
            />
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3">
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
            ) : !program && (
              <p className="text-[12px] text-gray-500 leading-relaxed">
                Answer the chips, say what the machine should do, and the assistant writes
                the rungs and walks through them. Where it is unsure of something that
                would change the program, it asks rather than guessing — and asks in
                options you can pick.
              </p>
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
