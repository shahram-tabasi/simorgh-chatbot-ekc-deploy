import React, { useMemo, useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import { DownloadIcon, XIcon } from 'lucide-react';
import {
  DrawingReports, REPORT_HEADERS, ReportPage, buildDrawingReports, reportRows,
} from '../../utils/cad/drawingReports';

// The four reports, off the pages.
//
// Shown before they are downloaded, because a report nobody looks at is a
// report nobody notices is empty. An empty one is usually saying something —
// no terminals because nothing was wired to them, no I/O because the pages are
// single lines — and that is worth reading on the screen rather than finding
// in a spreadsheet on somebody else's desk.

type Which = keyof DrawingReports;

const TABS: { id: Which; label: string; note: string }[] = [
  { id: 'io', label: 'I/O list', note: 'Every channel as drawn, with its terminal and what is on the end of it' },
  { id: 'terminals', label: 'Terminal diagram', note: 'Every strip, terminal by terminal' },
  { id: 'connections', label: 'Connection list', note: 'Every wire, end to end' },
  { id: 'devices', label: 'Device list', note: 'Every device, what it is, and where it was drawn' },
];

interface Props {
  pages: ReportPage[];
  fileBase: string;
  onClose: () => void;
}

export const DrawingReportsModal: React.FC<Props> = ({ pages, fileBase, onClose }) => {
  const [which, setWhich] = useState<Which>('io');
  const reports = useMemo(() => buildDrawingReports(pages), [pages]);
  const rows = reportRows(reports, which);
  const headers = REPORT_HEADERS[which];

  const download = () => {
    const wb = XLSX.utils.book_new();
    for (const tab of TABS) {
      const ws = XLSX.utils.aoa_to_sheet([
        [...REPORT_HEADERS[tab.id]], ...reportRows(reports, tab.id),
      ]);
      XLSX.utils.book_append_sheet(wb, ws, tab.label.slice(0, 31));
    }
    XLSX.writeFile(wb, `${fileBase}_reports.xlsx`);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[220]" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-2xl w-[1000px] max-w-[96vw] max-h-[92vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="bg-slate-700 text-white px-5 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Reports from the drawing</h2>
            <p className="text-[11px] text-slate-200">
              Read off {pages.length} page{pages.length === 1 ? '' : 's'} as they stand — not off the tables.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={download}
              className="flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium bg-emerald-600 hover:bg-emerald-700"
            >
              <DownloadIcon className="w-4 h-4" /> All four to Excel
            </button>
            <button onClick={onClose} className="p-1 rounded hover:bg-white/20" title="Close">
              <XIcon className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="px-5 pt-3 flex flex-wrap gap-2 border-b">
          {TABS.map(tab => {
            const count = reportRows(reports, tab.id).length;
            return (
              <button
                key={tab.id}
                onClick={() => setWhich(tab.id)}
                title={tab.note}
                className={`px-3 py-2 rounded-t-lg text-sm border border-b-0 ${
                  which === tab.id
                    ? 'bg-white border-gray-200 text-slate-800 font-medium'
                    : 'bg-gray-100 border-transparent text-gray-600 hover:bg-gray-200'}`}
              >
                {tab.label}
                <span className="ms-2 text-[11px] text-gray-500">{count}</span>
              </button>
            );
          })}
        </div>

        <div className="flex-1 overflow-auto">
          {rows.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">
              Nothing to report here. {which === 'io'
                ? 'No PLC channels are drawn on these pages.'
                : which === 'terminals'
                  ? 'No terminals are drawn on these pages.'
                  : 'Nothing on these pages is connected yet.'}
            </p>
          ) : (
            <table className="w-full text-[12px]">
              <thead className="bg-gray-50 text-gray-600 sticky top-0">
                <tr>
                  {headers.map(h => (
                    <th key={h} className="text-start font-medium px-3 py-2 border-b">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((row, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    {row.map((cell, j) => (
                      <td key={j} className={`px-3 py-1.5 ${j === 0 ? 'font-medium text-gray-900' : 'text-gray-700'}`}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <p className="px-5 py-2 border-t bg-gray-50 text-[11px] text-gray-500">
          {TABS.find(t => t.id === which)?.note}
        </p>
      </div>
    </div>
  );
};
