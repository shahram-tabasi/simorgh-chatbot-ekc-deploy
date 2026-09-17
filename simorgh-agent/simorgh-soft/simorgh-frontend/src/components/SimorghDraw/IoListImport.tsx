import React, { useRef, useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import { AlertTriangleIcon, FileSpreadsheetIcon, XIcon } from 'lucide-react';
import { DrawingEdits } from '../../types/project';
import { IoPoint, ReadResult, numberTerminals, readIoList } from '../../utils/ioList';
import { buildIoPages } from '../../utils/cad/ioPages';
import { DrawingPage, nextName, pageKey } from '../../utils/cad/pages';

// An I/O list becomes wiring pages.
//
// The dialog exists because the alternative — pick a file, pages appear — is
// only pleasant while it works. A list has a heading row somewhere, columns
// called whatever the customer calls them, and rows that are notes rather than
// signals. What is shown here is what was *understood*: which column was read
// as which field, how many points came out, and every row that could not be
// read and why. Somebody can then say "no, Module is the card" and fix the
// file, rather than finding out at the panel that four signals are missing.

interface Props {
  pages: DrawingPage[];
  edits?: DrawingEdits;
  onDone: (pages: DrawingPage[], edits: DrawingEdits, made: number) => void;
  onClose: () => void;
}

const FIELD_NAMES: Record<string, string> = {
  address: 'Address', tag: 'Device tag', description: 'Description',
  card: 'Card', strip: 'Terminal strip', terminal: 'Terminal', symbol: 'Symbol',
};

export const IoListImport: React.FC<Props> = ({ pages, edits, onDone, onClose }) => {
  const file = useRef<HTMLInputElement>(null);
  const [read, setRead] = useState<ReadResult | null>(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [perPage, setPerPage] = useState(8);
  const [strip, setStrip] = useState('-X1');
  const [autoNumber, setAutoNumber] = useState(true);

  const take = async (f: File) => {
    setError(null);
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const first = wb.Sheets[wb.SheetNames[0]];
      if (!first) { setError('That file has no sheets in it.'); return; }
      // Raw rows, not objects: the heading row is found rather than assumed,
      // so a file with a title and a blank line above the headings still reads.
      const rows = XLSX.utils.sheet_to_json<unknown[]>(first, { header: 1, blankrows: true });
      setRead(readIoList(rows));
      setFileName(f.name);
    } catch {
      setError('That file could not be opened as a spreadsheet.');
    }
  };

  const points: IoPoint[] = read
    ? (autoNumber ? numberTerminals(read.points, strip) : read.points)
    : [];

  const create = () => {
    if (points.length === 0) return;
    const built = buildIoPages(points, { perPage });
    const nextPages = [...pages];
    const nextEdits: DrawingEdits = { ...(edits ?? {}) };
    const now = new Date().toISOString();

    for (const page of built) {
      const made: DrawingPage = {
        id: `p${Date.now().toString(36)}${nextPages.length.toString(36)}`,
        name: nextName(nextPages, 'wd'),
        // What is on it, so the page tree says something useful before it is
        // opened: which card, and which addresses.
        description: describe(page.points),
        type: 'wd',
        width: page.width,
        height: page.height,
        createdAt: now,
      };
      nextPages.push(made);
      // 'page' and not a fingerprint of the list: from here on this is a page
      // somebody owns and draws on, not a view of the spreadsheet that goes
      // stale when the spreadsheet changes. Bringing in a newer list makes new
      // pages; it does not reach into these and overwrite the work on them.
      nextEdits[pageKey(made.id)] = { shapes: page.shapes, drawnAs: 'page', editedAt: now };
    }

    onDone(nextPages, nextEdits, built.length);
  };

  const pageCount = points.length === 0 ? 0 : buildIoPages(points, { perPage }).length;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[320]" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-2xl w-[900px] max-w-[95vw] max-h-[92vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="bg-slate-700 text-white px-5 py-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Wiring pages from an I/O list</h2>
            <p className="text-[11px] text-slate-200">
              One path per signal: field device, terminal, PLC channel, between the two rails.
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/20" title="Close">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => file.current?.click()}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700"
            >
              <FileSpreadsheetIcon className="w-4 h-4" />
              {read ? 'Choose another file' : 'Choose the I/O list'}
            </button>
            {fileName && <span className="text-sm text-gray-600 truncate">{fileName}</span>}
            <input
              ref={file}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) take(f); e.target.value = ''; }}
            />
          </div>

          {error && (
            <p className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
              <AlertTriangleIcon className="w-4 h-4 mt-0.5 shrink-0" /> {error}
            </p>
          )}

          {read && (
            <>
              <div className="rounded border border-gray-200">
                <p className="px-3 py-2 bg-gray-50 border-b text-sm font-medium text-gray-800">
                  What was read
                </p>
                <div className="p-3 space-y-2">
                  <p className="text-sm text-gray-700">
                    <span className="font-semibold text-gray-900">{read.points.length}</span> signals
                    {read.points.length > 0 && <> · {pageCount} page{pageCount === 1 ? '' : 's'} at {perPage} paths each</>}
                  </p>
                  {Object.keys(read.columns).length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(read.columns).map(([field, column]) => (
                        <span key={field} className="text-[11px] px-2 py-0.5 rounded bg-blue-50 text-blue-800 border border-blue-200">
                          {FIELD_NAMES[field] ?? field} ← {column}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {read.skipped.length > 0 && (
                <div className="rounded border border-amber-200">
                  <p className="px-3 py-2 bg-amber-50 border-b border-amber-200 text-sm font-medium text-amber-900">
                    {read.skipped.length} row{read.skipped.length === 1 ? '' : 's'} could not be read
                  </p>
                  <ul className="p-3 space-y-1 max-h-40 overflow-auto">
                    {read.skipped.map((s, i) => (
                      <li key={i} className="text-[12px] text-gray-700">
                        <span className="font-medium text-gray-900">Row {s.row}</span> — {s.why}
                        {s.text && <span className="text-gray-500"> · {s.text.slice(0, 70)}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {points.length > 0 && (
                <div className="rounded border border-gray-200 overflow-hidden">
                  <p className="px-3 py-2 bg-gray-50 border-b text-sm font-medium text-gray-800">
                    The first {Math.min(points.length, 10)} of {points.length}
                  </p>
                  <table className="w-full text-[12px]">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        {['Address', 'Kind', 'Tag', 'Terminal', 'Card', 'Description'].map(h => (
                          <th key={h} className="text-start font-medium px-3 py-1.5">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {points.slice(0, 10).map((p, i) => (
                        <tr key={i}>
                          <td className="px-3 py-1 font-mono">{p.address}</td>
                          <td className="px-3 py-1">{p.kind}</td>
                          <td className="px-3 py-1">{p.tag}</td>
                          <td className="px-3 py-1">{[p.strip, p.terminal].filter(Boolean).join(':')}</td>
                          <td className="px-3 py-1">{p.card}</td>
                          <td className="px-3 py-1 text-gray-600">{p.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-4 text-sm">
                <label className="flex items-center gap-2">
                  Paths per page
                  <select
                    className="border border-gray-300 rounded px-2 py-1"
                    value={perPage}
                    onChange={e => setPerPage(Number(e.target.value))}
                  >
                    {[4, 6, 8, 10].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={autoNumber}
                    onChange={e => setAutoNumber(e.target.checked)}
                  />
                  Number the terminals the list left blank
                </label>
                {autoNumber && (
                  <label className="flex items-center gap-2">
                    on strip
                    <input
                      value={strip}
                      onChange={e => setStrip(e.target.value)}
                      className="border border-gray-300 rounded px-2 py-1 w-20"
                    />
                  </label>
                )}
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t bg-gray-50 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm border border-gray-300 bg-white">
            Cancel
          </button>
          <button
            onClick={create}
            disabled={points.length === 0}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
          >
            {pageCount > 0 ? `Draw ${pageCount} page${pageCount === 1 ? '' : 's'}` : 'Draw the pages'}
          </button>
        </div>
      </div>
    </div>
  );
};

/** What a page holds, in one line for the page tree. */
function describe(points: IoPoint[]): string {
  if (points.length === 0) return '';
  const card = points[0].card;
  const first = points[0].address;
  const last = points[points.length - 1].address;
  const range = first === last ? first : `${first} – ${last}`;
  return [card, range].filter(Boolean).join('  ·  ');
}
