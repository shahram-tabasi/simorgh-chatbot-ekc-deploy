import React, { useState } from 'react';
import {
  AlertTriangleIcon, CheckIcon, ChevronDownIcon, CodeIcon, CpuIcon,
  FactoryIcon, LayersIcon, SendIcon,
} from 'lucide-react';

import { LadderQuestion, ladderService } from '../../services/projectService';
import { DIALECTS, Dialect, dialectBriefing, dialectOf } from '../../utils/ladder/dialects';
import { LadderProgram, readProgram } from '../../utils/ladder/model';

// Asking for a ladder program: the chips, the task, and the questions it asks
// back.
//
// One component because there are two places to ask from — the Simorgh Logic
// workspace, and the assistant panel inside the drawing editor — and the part
// that has to be right is the same in both: that the vendor is answered before
// anything is written, and that a question the model asks comes back as
// options to click rather than prose to answer.
//
// Two copies of that would be two copies of the rule, and the second one to be
// changed would be the one somebody is using.

export interface LadderAskResult {
  program: LadderProgram;
  /** Anything in the answer that could not be drawn as a rung. */
  dropped: string[];
  dialect: Dialect;
  controller: string;
  language: string;
}

interface Props {
  /** True in the narrow panel inside the drawing editor. */
  compact?: boolean;
  onProgram: (result: LadderAskResult) => void;
  /** Shown under the button; the workspace and the panel say different things. */
  footnote?: React.ReactNode;
}

const LANGUAGE_NOTE =
  'Ladder is what is drawn whichever language you pick — the choice tells the assistant which one you will type it into, so it explains in those terms.';

export const LadderAsk: React.FC<Props> = ({ compact = false, onProgram, footnote }) => {
  // Nothing is chosen to begin with, and the button stays out of reach until
  // it is. Defaulting to the first vendor in the table would be friendlier for
  // four seconds and wrong afterwards: a program written for an S7-1200
  // because nobody noticed the box already said so cannot be typed into the
  // machine it was asked for.
  const [vendor, setVendor] = useState('');
  const [dialectId, setDialectId] = useState('');
  const [controller, setController] = useState('');
  const [language, setLanguage] = useState('');
  const [style, setStyle] = useState<'teach' | 'brief'>('teach');
  const dialect = dialectOf(dialectId);
  const chosen = Boolean(vendor && dialectId && controller && language);

  const [task, setTask] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState<string | null>(null);

  const [questions, setQuestions] = useState<LadderQuestion[] | null>(null);
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [settled, setSettled] = useState<{ ask: string; chose: string }[]>([]);

  const families = DIALECTS.filter(d => d.vendor === vendor);
  const allAnswered = questions
    ? questions.every((_, i) => (picked[i] ?? []).length > 0)
    : false;

  // Choosing one thing clears what hung off it rather than filling it in. An
  // unanswered chip is a question; a pre-answered one is a trap.
  const chooseVendor = (v: string) => {
    setVendor(v); setDialectId(''); setController(''); setLanguage('');
  };
  const chooseFamily = (id: string) => {
    setDialectId(id); setController(''); setLanguage('');
  };

  const ask = async (withAnswers = settled) => {
    if (task.trim().length < 3 || working || !chosen) return;
    setWorking(true);
    setError(null);
    setRaw(null);

    const answer = await ladderService.generate({
      task: task.trim(),
      // Written here, from the table in this browser, and sent with the
      // request. The server never holds a copy to go stale.
      briefing: dialectBriefing(dialect),
      controller,
      language,
      style,
      answers: withAnswers,
    });

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

    setQuestions(null);
    setWorking(false);
    onProgram({
      program: read.program, dropped: read.dropped, dialect, controller, language,
    });
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

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        <Chip Icon={FactoryIcon} label="Vendor" value={vendor}
          options={[...new Set(DIALECTS.map(d => d.vendor))]} onChange={chooseVendor} />
        {vendor && (
          <Chip Icon={LayersIcon} label="Family" value={dialectId}
            options={families.map(d => d.id)} display={id => dialectOf(id).family}
            onChange={chooseFamily} />
        )}
        {dialectId && (
          <Chip Icon={CpuIcon} label="Controller" value={controller}
            options={dialect.controllers} onChange={setController} />
        )}
        {dialectId && (
          <Chip Icon={CodeIcon} label="Language" value={language}
            options={dialect.languages} onChange={setLanguage} note={LANGUAGE_NOTE} />
        )}
      </div>

      {dialectId && !compact && (
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
          rows={compact ? 3 : 5}
          placeholder={'Start and stop a conveyor from two push buttons, with a seal-in and an overload.'}
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
          data-ladder-go
          className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-violet-700 text-white text-sm font-medium hover:bg-violet-800 disabled:opacity-40"
        >
          <SendIcon className="w-4 h-4" />
          {working ? 'Writing…' : 'Write the program'}
        </button>
      </div>

      <p className="text-[11px] text-gray-400">
        {!chosen
          ? 'Answer the chips first — the vendor decides what the blocks are called.'
          : 'Ctrl+Enter sends it.'}
      </p>
      {footnote}

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

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-2.5">
          <p className="flex items-start gap-2 text-[12px] text-red-800">
            <AlertTriangleIcon className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </p>
          {raw && (
            <pre className="mt-2 text-[10px] leading-snug text-gray-700 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
              {raw}
            </pre>
          )}
        </div>
      )}

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
    </div>
  );
};

/**
 * One of the answers the assistant cannot work without.
 *
 * A chip rather than a labelled dropdown: unanswered it reads as a question
 * sitting there waiting, answered it reads as a fact. A row of dropdowns with
 * plausible values already in them reads as neither.
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
