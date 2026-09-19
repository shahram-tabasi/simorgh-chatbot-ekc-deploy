// src/components/PLC/PlcAssistant.tsx
//
// The assistant, working on the program that is already there.
//
// Three things make this different from a chat box with a PLC prompt, and all
// three are the difference between a useful draft and an hour wasted:
//
//   1. **It is told what exists.** Every request carries the program written
//      down — blocks, interfaces, tags, and what the checker says is wrong.
//      A model that cannot see the project invents tags that nearly match the
//      real ones, and "nearly" is what costs the hour.
//
//   2. **It may ask instead of answering.** Whether the stop is maintained,
//      what happens on a fault, how long the delay is — none of that is in the
//      sentence it was given, and guessing produces a block that looks
//      finished and is wrong where nobody can see it. Questions come back as
//      options to click, and the answers go back with the next request.
//
//   3. **Nothing lands without being looked at.** What comes back is read
//      through the project's own reader, checked, and shown as a plan — this
//      many blocks added, this one replaced, these tags new — before a single
//      thing changes. A block that replaces one somebody spent the afternoon
//      on is a different decision from a block that is new, so the two are
//      counted separately and both are on screen before the button.
//
// The banner at the bottom is not boilerplate. A language model writing an
// interlock is a draft for an engineer to read, and the one place that has to
// be said is where the work is handed over.

import React, { useMemo, useState } from 'react';
import {
  SparklesIcon, SendIcon, AlertTriangleIcon, CheckIcon, XIcon, RotateCcwIcon,
  ClipboardCopyIcon, FileTextIcon,
} from 'lucide-react';
import { LadderQuestion, plcService } from '../../services/projectService';
import { PlcBlock, PlcProject } from '../../utils/plc/model';
import { Problem, analyzeProject } from '../../utils/plc/analyze';
import {
  ApplyPlan, Generated, applyGenerated, planApply, problemsForModel, readGenerated, snapshot,
} from '../../utils/plc/aiContext';
import { briefing } from '../../utils/plc/instructions';
import { blockToScl } from '../../utils/plc/sclExport';

interface Props {
  project: PlcProject;
  /** The block that is open, so "this block" means something. */
  block: PlcBlock | null;
  problems: Problem[];
  readOnly?: boolean;
  onApply: (next: PlcProject) => void;
}

type Stage = 'ask' | 'working' | 'questions' | 'review' | 'failed';

/** The three things somebody actually asks for, as one click each. */
const STARTERS: { label: string; task: (b: PlcBlock | null) => string }[] = [
  {
    label: 'Write a motor start/stop block',
    task: () => 'Write a function block for a motor: start, stop, a seal-in, an overload input '
      + 'that stops it and needs a reset, and a run-on timer for the fan.',
  },
  {
    label: 'Explain this block',
    task: b => `Explain what ${b ? `"${b.name}"` : 'the open block'} does, network by network, `
      + 'and say what you would change. Answer in "notes" only — do not rewrite it.',
  },
  {
    label: 'Fix what the checker found',
    task: () => 'Fix the problems the checker listed. Change only what is needed to clear them '
      + 'and say in the notes what you changed.',
  },
];

export const PlcAssistant: React.FC<Props> = ({
  project, block, problems, readOnly, onApply,
}) => {
  const [task, setTask] = useState('');
  const [stage, setStage] = useState<Stage>('ask');
  const [style, setStyle] = useState<'teach' | 'brief'>('brief');
  const [withVocabulary, setWithVocabulary] = useState(true);
  const [scope, setScope] = useState<'block' | 'project'>('block');
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [model, setModel] = useState<string>('');

  const [questions, setQuestions] = useState<LadderQuestion[] | null>(null);
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [settled, setSettled] = useState<{ ask: string; chose: string }[]>([]);

  const [generated, setGenerated] = useState<Generated | null>(null);
  const [takeTags, setTakeTags] = useState(true);

  const plan: ApplyPlan | null = useMemo(
    () => (generated ? planApply(project, generated) : null), [project, generated]);

  /**
   * What the generated program would look like once applied, checked.
   *
   * Run before it is applied, not after. "Three errors" shown next to the
   * Apply button is information; the same three found afterwards is a mess to
   * clean up.
   */
  const wouldBe = useMemo(() => {
    if (!generated) return null;
    const next = applyGenerated(project, generated, { takeTags });
    return analyzeProject(next);
  }, [project, generated, takeTags]);

  const allAnswered = questions
    ? questions.every((_, i) => (picked[i] ?? []).length > 0)
    : false;

  const ask = async (answers = settled) => {
    if (task.trim().length < 3 || stage === 'working') return;
    setStage('working');
    setError(null);
    setRaw(null);

    const answer = await plcService.generate({
      task: task.trim(),
      snapshot: snapshot(project, {
        withCode: true,
        onlyBlocks: scope === 'block' && block ? [block.id] : [],
        withProblems: true,
      }) + (problems.length > 0 ? `\n\n## The checker's list\n${problemsForModel(problems)}` : ''),
      vocabulary: withVocabulary ? briefing(['basic']) : undefined,
      language: block?.language ?? 'SCL',
      style,
      answers,
    });

    setModel(answer.model ?? '');

    if (!answer.success) {
      setError(answer.error ?? 'The assistant did not answer.');
      setRaw(answer.raw ?? null);
      setStage('failed');
      return;
    }

    if (answer.questions && answer.questions.length > 0) {
      setQuestions(answer.questions);
      setPicked({});
      setStage('questions');
      return;
    }

    const read = readGenerated(answer.generated);
    setGenerated(read);
    setStage('review');
  };

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

  const apply = () => {
    if (!generated || readOnly) return;
    onApply(applyGenerated(project, generated, { takeTags }));
    reset();
  };

  const reset = () => {
    setStage('ask');
    setGenerated(null);
    setQuestions(null);
    setPicked({});
    setSettled([]);
    setError(null);
    setRaw(null);
  };

  /** The snapshot on the clipboard, for whoever wants to paste it elsewhere. */
  const copyContext = async () => {
    const text = snapshot(project, {
      withCode: true, withProblems: true, withInstructions: true,
    });
    try {
      await navigator.clipboard.writeText(text);
      window.alert('The program is on the clipboard — blocks, tags, problems and the '
        + 'instruction vocabulary. Paste it into whatever you are asking.');
    } catch {
      window.alert('The clipboard could not be written to. Use "Export SCL" on the toolbar '
        + 'instead.');
    }
  };

  return (
    <div className="h-full flex flex-col bg-white text-[12px]">
      <div className="px-3 py-2 border-b flex items-center gap-2 shrink-0">
        <SparklesIcon className="w-4 h-4 text-violet-600" />
        <span className="font-semibold">Assistant</span>
        {model && <span className="text-[10px] text-gray-400 truncate">{model}</span>}
        <button
          className="ms-auto p-1 rounded hover:bg-gray-100"
          title="Copy the whole program as text, for pasting into another tool"
          onClick={copyContext}
        >
          <ClipboardCopyIcon className="w-4 h-4 text-gray-500" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
        {/* ── Asking ─────────────────────────────────────────────────── */}
        {(stage === 'ask' || stage === 'working' || stage === 'failed') && (
          <>
            <textarea
              className="w-full h-28 px-2 py-2 rounded border border-gray-300 resize-none focus:border-violet-400 focus:outline-none"
              value={task}
              readOnly={stage === 'working'}
              placeholder={block
                ? `What should happen in "${block.name}"? For example: add an interlock so the pump `
                  + 'cannot run with the valve closed.'
                : 'What should the program do?'}
              onChange={e => setTask(e.target.value)}
            />

            <div className="flex flex-wrap gap-1.5">
              {STARTERS.map(s => (
                <button
                  key={s.label}
                  className="px-2 py-1 rounded border border-gray-200 text-[11px]
                    hover:border-violet-400 hover:text-purple-700"
                  onClick={() => setTask(s.task(block))}
                >
                  {s.label}
                </button>
              ))}
            </div>

            <div className="space-y-1.5 text-[11px] text-gray-600">
              <label className="flex items-center gap-2">
                <input
                  type="radio" checked={scope === 'block'} onChange={() => setScope('block')}
                  disabled={!block}
                />
                Only the open block{block ? ` ("${block.name}")` : ' — none is open'}
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={scope === 'project'} onChange={() => setScope('project')} />
                The whole program
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox" checked={withVocabulary} className="mt-0.5"
                  onChange={e => setWithVocabulary(e.target.checked)}
                />
                <span>
                  Send the instruction catalogue
                  <span className="block text-gray-400">
                    Stops it inventing block names this controller has never heard of.
                  </span>
                </span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox" checked={style === 'teach'}
                  onChange={e => setStyle(e.target.checked ? 'teach' : 'brief')}
                />
                Explain from further back
              </label>
            </div>

            <button
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded
                bg-violet-600 text-white font-medium hover:bg-purple-700 disabled:opacity-40"
              disabled={task.trim().length < 3 || stage === 'working' || readOnly}
              onClick={() => ask()}
            >
              {stage === 'working'
                ? <>Working…</>
                : <><SendIcon className="w-4 h-4" /> Ask</>}
            </button>

            {readOnly && (
              <p className="text-[11px] text-amber-700">
                This revision is read-only, so nothing can be written into it.
              </p>
            )}

            {stage === 'failed' && error && (
              <div className="p-2 rounded bg-red-50 border border-red-200">
                <p className="text-red-800">{error}</p>
                {raw && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[11px] text-red-700">
                      What it said
                    </summary>
                    <pre className="mt-1 text-[10.5px] whitespace-pre-wrap max-h-40 overflow-auto">{raw}</pre>
                  </details>
                )}
              </div>
            )}
          </>
        )}

        {/* ── Questions ──────────────────────────────────────────────── */}
        {stage === 'questions' && questions && (
          <div className="space-y-3">
            <p className="text-[11px] text-gray-600">
              It will not guess at these — each one changes the program.
            </p>
            {questions.map((q, qi) => (
              <div key={qi} className="rounded border border-purple-200 p-2">
                <p className="font-medium">{q.ask}</p>
                {q.why && <p className="text-[11px] text-gray-500 mt-0.5">{q.why}</p>}
                <div className="mt-2 space-y-1">
                  {q.options.map(o => {
                    const on = (picked[qi] ?? []).includes(o.label);
                    return (
                      <button
                        key={o.label}
                        className={`w-full text-left px-2 py-1.5 rounded border text-[11.5px]
                          ${on ? 'border-purple-500 bg-purple-50'
                          : 'border-gray-200 hover:border-purple-300'}`}
                        onClick={() => setPicked(prev => {
                          const now = prev[qi] ?? [];
                          if (q.multi) {
                            return {
                              ...prev,
                              [qi]: now.includes(o.label)
                                ? now.filter(x => x !== o.label) : [...now, o.label],
                            };
                          }
                          return { ...prev, [qi]: [o.label] };
                        })}
                      >
                        <span className="font-medium">{o.label}</span>
                        {o.note && <span className="block text-[10.5px] text-gray-500">{o.note}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="flex gap-2">
              <button
                className="flex-1 px-3 py-2 rounded bg-violet-600 text-white font-medium disabled:opacity-40"
                disabled={!allAnswered}
                onClick={answerQuestions}
              >
                Answer and carry on
              </button>
              <button
                className="px-3 py-2 rounded border border-gray-300"
                onClick={reset}
              >
                Start again
              </button>
            </div>
          </div>
        )}

        {/* ── Review ─────────────────────────────────────────────────── */}
        {stage === 'review' && generated && plan && (
          <div className="space-y-3">
            {generated.summary && (
              <p className="text-[12px] text-gray-800">{generated.summary}</p>
            )}

            <div className="rounded border divide-y">
              <Line
                label="New blocks"
                value={plan.added.length}
                detail={plan.added.map(b => `${b.kind} ${b.name}`).join(', ')}
              />
              <Line
                label="Blocks replaced"
                value={plan.replaced.length}
                detail={plan.replaced.map(r => r.existing.name).join(', ')}
                warn={plan.replaced.length > 0}
                note={plan.replaced.length > 0
                  ? 'What is in the project under that name is overwritten.' : undefined}
              />
              <Line label="New tags" value={plan.newTags.length}
                detail={plan.newTags.map(t => `${t.name} ${t.address}`).join(', ')} />
              <Line
                label="Tags whose address differs"
                value={plan.changedTags.length}
                detail={plan.changedTags
                  .map(c => `${c.incoming.name}: ${c.existingAddress} → ${c.incoming.address}`)
                  .join(', ')}
                warn={plan.changedTags.length > 0}
                note={plan.changedTags.length > 0
                  ? 'Left as they are — the wiring is not the assistant\'s to change.' : undefined}
              />
            </div>

            {wouldBe && (
              <p className={`text-[11.5px] ${wouldBe.filter(p => p.severity === 'error').length > 0
                ? 'text-red-700' : 'text-emerald-700'}`}
              >
                After applying, the checker would find{' '}
                {wouldBe.filter(p => p.severity === 'error').length} error(s) and{' '}
                {wouldBe.filter(p => p.severity === 'warning').length} warning(s) in the whole
                program.
              </p>
            )}

            {generated.dropped.length > 0 && (
              <div className="p-2 rounded bg-amber-50 border border-amber-200">
                <p className="flex items-center gap-1.5 font-medium text-amber-900">
                  <AlertTriangleIcon className="w-3.5 h-3.5" /> What could not be used as it arrived
                </p>
                <ul className="mt-1 space-y-0.5 text-[11px] text-amber-900 list-disc ps-5">
                  {generated.dropped.map((d, i) => <li key={i}>{d}</li>)}
                </ul>
              </div>
            )}

            {generated.notes.length > 0 && (
              <div className="p-2 rounded bg-blue-50 border border-blue-200">
                <p className="font-medium text-blue-900">Read before using this</p>
                <ul className="mt-1 space-y-0.5 text-[11px] text-blue-900 list-disc ps-5">
                  {generated.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </div>
            )}

            {/* The blocks themselves, as text, because that is what can be
                read. A summary of a block is not a review of a block. */}
            {generated.blocks.map(b => (
              <details key={b.id} className="rounded border">
                <summary className="px-2 py-1.5 cursor-pointer flex items-center gap-2">
                  <FileTextIcon className="w-3.5 h-3.5 text-gray-400" />
                  <span className="font-medium">{b.kind} {b.name}</span>
                  <span className="text-[10px] text-gray-400">{b.language}</span>
                </summary>
                <pre className="px-2 py-2 text-[10.5px] font-mono whitespace-pre-wrap overflow-auto max-h-72
                  bg-gray-50 border-t">
                  {blockToScl(b)}
                </pre>
              </details>
            ))}

            {plan.newTags.length > 0 && (
              <label className="flex items-center gap-2 text-[11.5px]">
                <input type="checkbox" checked={takeTags} onChange={e => setTakeTags(e.target.checked)} />
                Add the {plan.newTags.length} new tag(s) to the default table
              </label>
            )}

            <div className="flex gap-2">
              <button
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded
                  bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-40"
                disabled={readOnly || (plan.added.length === 0 && plan.replaced.length === 0
                  && (!takeTags || plan.newTags.length === 0))}
                onClick={apply}
              >
                <CheckIcon className="w-4 h-4" /> Put it in the project
              </button>
              <button
                className="px-3 py-2 rounded border border-gray-300"
                title="Throw this away and ask again"
                onClick={reset}
              >
                <RotateCcwIcon className="w-4 h-4" />
              </button>
              <button
                className="px-3 py-2 rounded border border-gray-300"
                onClick={() => setStage('ask')}
              >
                <XIcon className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="px-3 py-2 border-t bg-amber-50 shrink-0">
        <p className="text-[10.5px] leading-snug text-amber-900">
          What comes back is a <strong>draft for an engineer to read</strong>. Nothing here has
          been checked against a controller, and a language model is not the right thing to trust
          with an interlock. Read it, test it, and do not download it because it looked right.
        </p>
      </div>
    </div>
  );
};

const Line: React.FC<{
  label: string; value: number; detail?: string; warn?: boolean; note?: string;
}> = ({ label, value, detail, warn, note }) => (
  <div className="px-2 py-1.5">
    <div className="flex items-center gap-2">
      <span className={warn && value > 0 ? 'text-amber-800 font-medium' : ''}>
        {label}
      </span>
      <span className="ms-auto font-mono font-semibold">{value}</span>
    </div>
    {detail && <p className="text-[10.5px] text-gray-500 truncate" title={detail}>{detail}</p>}
    {note && value > 0 && <p className="text-[10.5px] text-amber-700">{note}</p>}
  </div>
);
