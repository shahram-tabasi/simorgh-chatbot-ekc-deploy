import React, { useMemo, useState } from 'react';
import {
  AlertTriangleIcon, ChevronLeftIcon, ChevronRightIcon, DownloadIcon,
  PrinterIcon, SendIcon, XIcon,
} from 'lucide-react';

import logoMark from '../../assets/logo-mark.png';
import { ladderService } from '../../services/projectService';
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

export const LogicWorkspace: React.FC<Props> = ({ fileBase, titleBlock, onClose }) => {
  const [vendor, setVendor] = useState(DIALECTS[0].vendor);
  const [dialectId, setDialectId] = useState(DIALECTS[0].id);
  const dialect: Dialect = dialectOf(dialectId);
  const [controller, setController] = useState(dialect.controllers[0]);
  const [language, setLanguage] = useState(dialect.languages[0]);
  const [style, setStyle] = useState<'teach' | 'brief'>('teach');

  const [task, setTask] = useState('');
  const [working, setWorking] = useState(false);
  const [program, setProgram] = useState<LadderProgram | null>(null);
  const [dropped, setDropped] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [openStep, setOpenStep] = useState<number | null>(null);

  const families = DIALECTS.filter(d => d.vendor === vendor);

  const chooseVendor = (v: string) => {
    setVendor(v);
    const first = DIALECTS.find(d => d.vendor === v);
    if (!first) return;
    setDialectId(first.id);
    setController(first.controllers[0]);
    setLanguage(first.languages[0]);
  };

  const chooseFamily = (id: string) => {
    const d = dialectOf(id);
    setDialectId(id);
    setController(d.controllers[0]);
    setLanguage(d.languages[0]);
  };

  const pages = useMemo(
    () => (program ? renderProgram(program) : []), [program]);
  const sheet = pages[Math.min(page, Math.max(0, pages.length - 1))];

  const ask = async () => {
    if (task.trim().length < 3 || working) return;
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
    });

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
    setPage(0);
    setOpenStep(read.program.steps?.length ? 0 : null);
    setWorking(false);
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
      <header className="bg-slate-800 text-white px-4 py-2.5 flex items-center gap-3 flex-wrap shrink-0">
        <img src={logoMark} alt="" aria-hidden className="w-6 h-6 object-contain brightness-0 invert" />
        <div className="min-w-0">
          <h1 className="text-base font-semibold leading-tight">Simorgh Logic</h1>
          <p className="text-[11px] text-slate-300">Ladder, written and explained</p>
        </div>

        <div className="ms-auto flex items-center gap-2 flex-wrap">
          <Picker label="Vendor" value={vendor} onChange={chooseVendor}
            options={[...new Set(DIALECTS.map(d => d.vendor))]} />
          <Picker label="Family" value={dialectId} onChange={chooseFamily}
            options={families.map(d => d.id)}
            display={id => dialectOf(id).family} />
          <Picker label="Controller" value={controller} onChange={setController}
            options={dialect.controllers} />
          <Picker label="Language" value={language} onChange={setLanguage}
            options={dialect.languages} title={LANGUAGE_NOTE} />
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-white/20"
            title="Back to the project"
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>
      </header>

      <p className="px-4 py-1.5 bg-slate-700 text-[11px] text-slate-200 shrink-0">
        {dialect.software} · {dialect.addressing.note}
      </p>

      <div className="flex-1 min-h-0 flex">
        {/* ── What you asked, and what it said ───────────────────────── */}
        <aside className="w-[24rem] shrink-0 border-e border-slate-300 bg-white flex flex-col min-h-0">
          <div className="p-3 border-b space-y-2">
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
                onClick={ask}
                disabled={working || task.trim().length < 3}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-violet-700 text-white text-sm font-medium hover:bg-violet-800 disabled:opacity-40"
              >
                <SendIcon className="w-4 h-4" />
                {working ? 'Writing…' : 'Write the program'}
              </button>
            </div>
            <p className="text-[11px] text-gray-400">Ctrl+Enter sends it.</p>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3">
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
    </div>
  );
};

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

const Picker: React.FC<{
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  display?: (v: string) => string;
  title?: string;
}> = ({ label, value, options, onChange, display, title }) => (
  <label className="flex items-center gap-1.5" title={title}>
    <span className="text-[11px] text-slate-300">{label}</span>
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="border border-slate-600 bg-slate-700 text-white rounded px-2 py-1.5 text-sm max-w-[13rem]"
    >
      {options.map(o => (
        <option key={o} value={o} className="bg-white text-gray-900">
          {display ? display(o) : o}
        </option>
      ))}
    </select>
  </label>
);
