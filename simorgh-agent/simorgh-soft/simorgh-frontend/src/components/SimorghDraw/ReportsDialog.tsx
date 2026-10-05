import React, { useState } from 'react';
import { FileTextIcon, XIcon } from 'lucide-react';
import { ReportKind } from '../../types/project';
import { REPORT_TITLES } from '../../utils/cad/reportPages';

// Which reports the drawing set carries — EPLAN's Utilities → Reports.
//
// The choice is kept with the project; the pages themselves are worked out
// again every time the set is opened, so the terminal diagram printed with a
// drawing is always the terminal diagram of that drawing.

interface Props {
  value: ReportKind[];
  canEdit: boolean;
  onSave: (next: ReportKind[]) => void;
  onClose: () => void;
}

const GROUPS: { title: string; kinds: ReportKind[] }[] = [
  { title: 'The set', kinds: ['title', 'toc', 'devices', 'parts'] },
  { title: 'Terminals and wiring', kinds: ['terminals', 'strips', 'connections'] },
  { title: 'PLC', kinds: ['plc', 'plcCards'] },
  { title: 'Cables and revisions', kinds: ['cables', 'revisions'] },
];

const NOTES: Record<ReportKind, string> = {
  title: 'Project, client, company and logo',
  toc: 'Every page of the set, the reports included',
  devices: 'Every scope drawn, with its designation and page',
  parts: 'Every part of every row, totalled by order number',
  terminals: 'Each strip, terminal by terminal, and what is on each side',
  strips: 'Each strip, how many terminals and where',
  connections: 'Every wire as drawn: -K1:A1 → -X1:3',
  plc: 'Every channel: address, card, terminal and scope',
  plcCards: 'Each card and how many inputs and outputs it has',
  cables: 'Every feeder row with a cable size',
  revisions: 'The project\'s revisions',
};

export const ReportsDialog: React.FC<Props> = ({ value, canEdit, onSave, onClose }) => {
  const [chosen, setChosen] = useState<Set<ReportKind>>(new Set(value));
  const flip = (k: ReportKind) => setChosen(prev => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const all = GROUPS.flatMap(g => g.kinds);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[220] p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-2xl w-[620px] max-w-full max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="bg-slate-700 text-white px-5 py-3 flex items-center justify-between rounded-t-lg">
          <div>
            <h2 className="text-base font-semibold">Reports</h2>
            <p className="text-[11px] text-slate-200">Generated as pages after your own, with the frame and the signed title block — and printed with them in the PDF.</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/20"><XIcon className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="flex gap-2 text-xs">
            <button onClick={() => setChosen(new Set(all))} disabled={!canEdit} className="px-2 py-1 rounded border border-gray-300 hover:bg-gray-100 disabled:opacity-40">All</button>
            <button onClick={() => setChosen(new Set())} disabled={!canEdit} className="px-2 py-1 rounded border border-gray-300 hover:bg-gray-100 disabled:opacity-40">None</button>
          </div>
          {GROUPS.map(g => (
            <section key={g.title}>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{g.title}</h3>
              <div className="space-y-1">
                {g.kinds.map(k => (
                  <label key={k} className="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer">
                    <input type="checkbox" className="mt-0.5" checked={chosen.has(k)} disabled={!canEdit} onChange={() => flip(k)} data-report={k} />
                    <span>
                      <span className="text-sm text-gray-800">{REPORT_TITLES[k]}</span>
                      <span className="block text-[11px] text-gray-500">{NOTES[k]}</span>
                    </span>
                  </label>
                ))}
              </div>
            </section>
          ))}
        </div>
        <div className="px-5 py-3 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-100">Cancel</button>
          <button
            onClick={() => { onSave(all.filter(k => chosen.has(k))); onClose(); }} disabled={!canEdit}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
          >
            <FileTextIcon className="w-4 h-4" /> Generate
          </button>
        </div>
      </div>
    </div>
  );
};
