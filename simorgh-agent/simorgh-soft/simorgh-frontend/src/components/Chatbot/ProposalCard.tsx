// ProposalCard — preview UI for the `propose_changes` flow.
//
// When the AI reads an uploaded PDF/image/Excel and wants to fill in
// project fields, it doesn't apply changes directly. Instead it returns a
// `propose_changes` tool call carrying a list of regular tool calls
// wrapped with a short summary. We render that list here with a checkbox
// per item; the user picks which ones to commit and the chatbot executes
// only the ticked ones.
//
// Rejected items aren't lost — the user can re-open the chat history and
// click Apply again. Once Apply runs, the card switches to a "Done" state.

import React, { useState } from 'react';
import { CheckCircleIcon, XIcon, Loader2Icon, ListChecksIcon } from 'lucide-react';
import {
  ProposedAction, ChatToolContext, executeChatTool,
} from '../../services/chatbotTools';

export interface ProposalCardProps {
  title:   string;
  actions: ProposedAction[];
  ctx:     ChatToolContext;
  /** Fired after Apply runs so the parent can log results inline. */
  onApplied?: (results: { tool: string; summary: string; ok: boolean }[]) => void;
}

export const ProposalCard: React.FC<ProposalCardProps> = ({ title, actions, ctx, onApplied }) => {
  // Tick everything by default — extraction usually means "yes, fill it all in".
  const [selected, setSelected] = useState<Set<number>>(() => new Set(actions.map((_, i) => i)));
  const [busy, setBusy]         = useState(false);
  const [done, setDone]         = useState<null | { applied: number; failed: number }>(null);

  const toggle = (i: number) => {
    const next = new Set(selected);
    if (next.has(i)) next.delete(i); else next.add(i);
    setSelected(next);
  };

  const allChecked  = actions.length > 0 && selected.size === actions.length;
  const noneChecked = selected.size === 0;
  const toggleAll = () =>
    setSelected(allChecked ? new Set() : new Set(actions.map((_, i) => i)));

  const handleApply = async () => {
    if (noneChecked || busy) return;
    setBusy(true);
    const picked = actions.filter((_, i) => selected.has(i));
    const results: { tool: string; summary: string; ok: boolean }[] = [];
    let applied = 0, failed = 0;
    // Run sequentially so dependent edits (e.g. add_equipment → select_equipment)
    // commit in the same order the AI listed them.
    for (const a of picked) {
      const r = await executeChatTool({ name: a.name, args: a.args }, ctx);
      results.push({ tool: a.name, summary: r.summary, ok: r.ok });
      if (r.ok) applied++; else failed++;
    }
    setBusy(false);
    setDone({ applied, failed });
    onApplied?.(results);
  };

  const handleReject = () => {
    setDone({ applied: 0, failed: 0 });
  };

  if (done) {
    return (
      <div className={`mt-2 border rounded p-3 text-xs ${
        done.applied > 0 ? 'border-emerald-200 bg-emerald-50' : 'border-gray-200 bg-gray-50'
      }`}>
        <div className="flex items-center gap-2">
          {done.applied > 0
            ? <CheckCircleIcon className="w-4 h-4 text-emerald-600" />
            : <XIcon className="w-4 h-4 text-gray-500" />}
          <span className="font-semibold">
            {done.applied > 0
              ? `Applied ${done.applied} change${done.applied > 1 ? 's' : ''}.`
              : 'No changes applied.'}
            {done.failed > 0 && <span className="text-red-600 ml-1">({done.failed} failed)</span>}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 border border-amber-200 bg-gradient-to-br from-amber-50 to-white rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-amber-100/60 border-b border-amber-200 flex items-center justify-between">
        <div className="flex items-center gap-2 text-amber-900">
          <ListChecksIcon className="w-4 h-4" />
          <span className="text-xs font-semibold">{title}</span>
        </div>
        <span className="text-[10px] text-amber-700">
          {selected.size}/{actions.length} selected
        </span>
      </div>

      <ul className="divide-y divide-amber-100 max-h-64 overflow-y-auto">
        <li className="px-3 py-1.5 bg-white/60">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={toggleAll}
              className="accent-amber-600"
            />
            <span className="text-xs font-semibold text-amber-800">
              {allChecked ? 'Deselect all' : 'Select all'}
            </span>
          </label>
        </li>
        {actions.map((a, i) => (
          <li key={i} className="px-3 py-1.5 hover:bg-amber-50/50">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(i)}
                onChange={() => toggle(i)}
                className="mt-0.5 accent-amber-600 flex-shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-800">{a.summary}</div>
                <div className="text-[10px] text-gray-500 font-mono truncate">
                  {a.name}({Object.keys(a.args).slice(0, 4).join(', ')})
                </div>
              </div>
            </label>
          </li>
        ))}
      </ul>

      <div className="px-3 py-2 border-t border-amber-200 flex items-center justify-end gap-2 bg-amber-50/60">
        <button
          onClick={handleReject}
          disabled={busy}
          className="px-3 py-1 text-xs border border-gray-300 bg-white rounded hover:bg-gray-50"
        >
          Reject
        </button>
        <button
          onClick={handleApply}
          disabled={busy || noneChecked}
          className="px-3 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-40 inline-flex items-center gap-1"
        >
          {busy
            ? <><Loader2Icon className="w-3 h-3 animate-spin" /> Applying…</>
            : <>Apply {selected.size > 0 ? `(${selected.size})` : ''}</>}
        </button>
      </div>
    </div>
  );
};

export default ProposalCard;
