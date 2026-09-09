import React, { useMemo, useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import { DownloadIcon, PrinterIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useProject } from '../../context/ProjectContext';
import { ProjectData, Equipment } from '../../types/project';
import { sheetName } from '../../utils/bpmsExport';
import {
  EPLAN_HEADERS, buildEplanRows, buildSingleLinePages, buildSingleLineHtml,
  buildSingleLineDxf,
} from '../../utils/eplanSingleLine';
import {
  LAYOUT_HEADERS, buildPanelLayout, buildLayoutRows, buildLayoutSvg, buildLayoutHtml,
  buildLayoutDxf,
} from '../../utils/panelLayout';
import {
  MECHANICAL_HEADERS, buildMechanicalItems, buildMechanicalRows,
} from '../../utils/mechanicalItems';

// The Eplanix tab: the three drawings-and-lists outputs that come off the
// switchgear itself — the single line, the panel layout, and the mechanical
// items. Each one is previewed here before it is downloaded or printed, so
// what leaves the app has been looked at first.

type View = 'single-line' | 'layout' | 'mechanical';

// Anything unsafe in a file name, and the runs of spaces around it, collapse
// to a single underscore — the same file has to survive Windows and Linux.
const fileSafe = (s: string) =>
  (s || 'project').replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '') || 'project';

function downloadText(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked late: Safari reads the blob after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** One DXF per switchgear, spaced out so the browser does not block the run. */
function downloadDxfSet(files: { name: string; dxf: string }[]) {
  files.forEach((file, i) => {
    setTimeout(() => downloadText(file.name, file.dxf, 'image/vnd.dxf'), i * 250);
  });
}

function exportSingleLineDxf(data: ProjectData, equipments: Equipment[], perPage: number) {
  downloadDxfSet(equipments.map(eq => ({
    name: `${fileSafe(data.projectName)}_${fileSafe(eq.name)}_single_line.dxf`,
    dxf: buildSingleLineDxf(data, eq, perPage),
  })));
}

function openPrintable(html: string, what: string) {
  const w = window.open('', '_blank');
  if (!w) { alert(`Allow pop-ups to open the ${what}.`); return; }
  w.document.write(html);
  w.document.close();
}

function exportEplanExcel(data: ProjectData, equipments: Equipment[]) {
  const wb = XLSX.utils.book_new();
  const taken = new Set<string>();
  for (const eq of equipments) {
    const ws = XLSX.utils.aoa_to_sheet([EPLAN_HEADERS, ...buildEplanRows(data, eq)]);
    ws['!cols'] = [
      { wch: 6 }, { wch: 16 }, { wch: 18 }, { wch: 10 }, { wch: 28 }, { wch: 22 },
      { wch: 20 }, { wch: 16 }, { wch: 6 }, { wch: 12 }, { wch: 12 }, { wch: 16 },
      { wch: 18 }, { wch: 28 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, sheetName(eq.name, taken));
  }
  XLSX.writeFile(wb, `${data.projectName || 'project'}_EPLAN_single_line.xlsx`);
}

function exportLayoutExcel(data: ProjectData, equipments: Equipment[]) {
  const layouts = equipments.map(eq => buildPanelLayout(data, eq));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([LAYOUT_HEADERS, ...buildLayoutRows(layouts)]);
  ws['!cols'] = LAYOUT_HEADERS.map((h, i) => ({ wch: i === 9 ? 30 : Math.max(10, h.length + 2) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Layout');
  XLSX.writeFile(wb, `${data.projectName || 'project'}_Layout.xlsx`);
}

function exportMechanicalExcel(data: ProjectData, equipments: Equipment[]) {
  const rows = buildMechanicalRows(data, equipments);
  if (rows.length === 0) {
    alert('Nothing to list yet — these switchgears have no panel specification in Device Library.');
    return;
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([MECHANICAL_HEADERS, ...rows]);
  ws['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 26 }, { wch: 34 }, { wch: 6 }, { wch: 10 }, { wch: 46 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Mechanical items');
  XLSX.writeFile(wb, `${data.projectName || 'project'}_Mechanical_items.xlsx`);
}

export const EplanixTab: React.FC = () => {
  const { projectData } = useProject();
  const [view, setView] = useState<View>('single-line');
  const [selected, setSelected] = useState<string>('');   // equipment id, '' = all
  const [perPage, setPerPage] = useState(8);
  const [sheet, setSheet] = useState(0);

  const equipments = projectData.equipments ?? [];
  const withLines = equipments.filter(e => (e.devices ?? []).length > 0);
  const chosen = selected ? equipments.filter(e => e.id === selected) : equipments;
  const chosenWithLines = chosen.filter(e => (e.devices ?? []).length > 0);
  // Previews show one switchgear; the first of the chosen ones.
  const preview = chosenWithLines[0];

  const pages = useMemo(
    () => (preview ? buildSingleLinePages(projectData, preview, perPage) : []),
    [projectData, preview, perPage]);
  const current = pages[Math.min(sheet, Math.max(0, pages.length - 1))];

  const layout = useMemo(
    () => (preview ? buildPanelLayout(projectData, preview) : null),
    [projectData, preview]);

  const mechanical = useMemo(
    () => chosen.flatMap(eq => buildMechanicalItems(projectData, eq)),
    [projectData, chosen]);

  const Btn: React.FC<{
    onClick: () => void; icon?: 'download' | 'print'; children: React.ReactNode;
    className?: string; disabled?: boolean;
  }> = ({ onClick, icon = 'download', children, className = '', disabled }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-2 px-4 py-2 rounded-lg shadow-sm font-medium text-sm whitespace-nowrap disabled:opacity-40 ${className}`}
    >
      {icon === 'download' ? <DownloadIcon className="w-4 h-4" /> : <PrinterIcon className="w-4 h-4" />}
      {children}
    </button>
  );

  const Tab: React.FC<{ id: View; label: string; note: string }> = ({ id, label, note }) => (
    <button
      onClick={() => { setView(id); setSheet(0); }}
      className={`px-4 py-2 rounded-lg text-sm text-left border ${
        view === id ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
      }`}
    >
      <div className="font-medium">{label}</div>
      <div className={`text-[11px] ${view === id ? 'text-blue-100' : 'text-gray-500'}`}>{note}</div>
    </button>
  );

  return (
    <div>
      <div className="flex justify-between items-start mb-5 gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-800">Eplanix</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {projectData.projectName} — single line, panel layout and mechanical items,
            drawn from Device Selection and the templates behind it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">Switchgear</label>
          <select
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
            value={selected}
            onChange={e => { setSelected(e.target.value); setSheet(0); }}
          >
            <option value="">All ({equipments.length})</option>
            {equipments.map(eq => (
              <option key={eq.id} value={eq.id}>{eq.name} — {eq.type}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-5">
        <Tab id="single-line" label="Single line — تک‌خطی" note="Busbar, feeders, devices, data blocks" />
        <Tab id="layout" label="Layout — جانمایی" note="Front elevation, column by column" />
        <Tab id="mechanical" label="Mechanical — اقلام مکانیکال" note="Enclosure, busbars, compartments" />
      </div>

      {/* ── Single line ───────────────────────────────────────────────── */}
      {view === 'single-line' && (
        <div className="border border-gray-200 rounded-lg">
          <div className="flex items-center justify-between gap-3 px-4 py-3 bg-gray-50 border-b">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-xs font-bold px-2 py-0.5 rounded-full text-white bg-blue-700">EPLAN</span>
              <div className="min-w-0">
                <p className="font-medium text-sm text-gray-800">
                  {preview ? `${preview.name} — ${preview.devices?.length ?? 0} feeders` : 'No switchgear with feeder lines'}
                </p>
                <p className="text-xs text-gray-500">
                  One sheet per {perPage} feeders · supply, busbar, device chain and a data block per feeder.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <select
                className="border border-gray-300 rounded px-2 py-1.5 text-sm"
                value={perPage}
                onChange={e => { setPerPage(Number(e.target.value)); setSheet(0); }}
              >
                {[4, 6, 8, 10, 12].map(n => <option key={n} value={n}>{n} feeders / sheet</option>)}
              </select>
              <Btn
                onClick={() => openPrintable(buildSingleLineHtml(projectData, chosenWithLines, perPage), 'single-line diagram')}
                icon="print"
                className="bg-slate-700 text-white hover:bg-slate-800"
                disabled={chosenWithLines.length === 0}
              >
                Print / PDF
              </Btn>
              <Btn
                onClick={() => exportEplanExcel(projectData, chosenWithLines)}
                className="bg-blue-700 text-white hover:bg-blue-800"
                disabled={chosenWithLines.length === 0}
              >
                EPLAN device list
              </Btn>
              <Btn
                onClick={() => exportSingleLineDxf(projectData, chosenWithLines, perPage)}
                className="bg-teal-700 text-white hover:bg-teal-800"
                disabled={chosenWithLines.length === 0}
              >
                DXF (CAD)
              </Btn>
            </div>
          </div>

          {current ? (
            <>
              <div className="p-3 overflow-x-auto bg-white">
                <div dangerouslySetInnerHTML={{ __html: current.svg }} />
              </div>
              {pages.length > 1 && (
                <div className="flex items-center justify-center gap-3 px-4 py-2 border-t bg-gray-50 text-sm">
                  <button
                    className="p-1 rounded hover:bg-gray-200 disabled:opacity-30"
                    onClick={() => setSheet(s => Math.max(0, s - 1))}
                    disabled={sheet === 0}
                  >
                    <ChevronLeftIcon className="w-4 h-4" />
                  </button>
                  <span className="text-gray-600">Sheet {current.page} of {current.of}</span>
                  <button
                    className="p-1 rounded hover:bg-gray-200 disabled:opacity-30"
                    onClick={() => setSheet(s => Math.min(pages.length - 1, s + 1))}
                    disabled={sheet >= pages.length - 1}
                  >
                    <ChevronRightIcon className="w-4 h-4" />
                  </button>
                </div>
              )}
            </>
          ) : (
            <p className="p-6 text-sm text-gray-500">
              Nothing to draw yet — add feeder lines in Device Selection, or import a switchgear from TPMS.
            </p>
          )}
        </div>
      )}

      {/* ── Layout ────────────────────────────────────────────────────── */}
      {view === 'layout' && (
        <div className="border border-gray-200 rounded-lg">
          <div className="flex items-center justify-between gap-3 px-4 py-3 bg-gray-50 border-b">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-xs font-bold px-2 py-0.5 rounded-full text-white bg-violet-600">LAYOUT</span>
              <div className="min-w-0">
                <p className="font-medium text-sm text-gray-800">
                  {layout ? `${layout.equipment.name} — ${layout.columns.length} column(s), tallest ${layout.tallest}${layout.unit}` : 'No switchgear with feeder lines'}
                </p>
                <p className="text-xs text-gray-500">
                  From MODULE NO. (column.position) and SIZE — each column stacked in position order.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Btn
                onClick={() => openPrintable(
                  buildLayoutHtml(projectData, chosenWithLines.map(eq => buildPanelLayout(projectData, eq))), 'layout')}
                icon="print"
                className="bg-slate-700 text-white hover:bg-slate-800"
                disabled={chosenWithLines.length === 0}
              >
                Print / PDF
              </Btn>
              <Btn
                onClick={() => exportLayoutExcel(projectData, chosenWithLines)}
                className="bg-violet-600 text-white hover:bg-violet-700"
                disabled={chosenWithLines.length === 0}
              >
                Layout Excel
              </Btn>
              <Btn
                onClick={() => downloadText(
                  `${fileSafe(projectData.projectName)}_layout.dxf`,
                  buildLayoutDxf(projectData, chosenWithLines.map(eq => buildPanelLayout(projectData, eq))),
                  'image/vnd.dxf')}
                className="bg-teal-700 text-white hover:bg-teal-800"
                disabled={chosenWithLines.length === 0}
              >
                DXF (CAD)
              </Btn>
            </div>
          </div>

          {layout ? (
            <div className="p-3 overflow-x-auto bg-white">
              <div dangerouslySetInnerHTML={{ __html: buildLayoutSvg(layout) }} />
            </div>
          ) : (
            <p className="p-6 text-sm text-gray-500">
              Nothing to lay out yet — feeder lines carry the module numbers this is built from.
            </p>
          )}
        </div>
      )}

      {/* ── Mechanical items ──────────────────────────────────────────── */}
      {view === 'mechanical' && (
        <div className="border border-gray-200 rounded-lg">
          <div className="flex items-center justify-between gap-3 px-4 py-3 bg-gray-50 border-b">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-xs font-bold px-2 py-0.5 rounded-full text-white bg-amber-700">MECH</span>
              <div className="min-w-0">
                <p className="font-medium text-sm text-gray-800">
                  {mechanical.length} item{mechanical.length === 1 ? '' : 's'} across {chosen.length} switchgear(s)
                </p>
                <p className="text-xs text-gray-500">
                  Counted from the panel specification and the feeders — every row says what it was derived from.
                </p>
              </div>
            </div>
            <Btn
              onClick={() => exportMechanicalExcel(projectData, chosen)}
              className="bg-amber-700 text-white hover:bg-amber-800"
              disabled={mechanical.length === 0}
            >
              Mechanical Excel
            </Btn>
          </div>

          {mechanical.length > 0 ? (
            <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-amber-700 text-white">
                  <tr>
                    {MECHANICAL_HEADERS.map(h => (
                      <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mechanical.map((r, i) => (
                    <tr key={i} className={i % 2 ? 'bg-gray-50' : 'bg-white'}>
                      <td className="px-3 py-1.5 whitespace-nowrap text-gray-800">{r.switchgear}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-gray-600">{r.section}</td>
                      <td className="px-3 py-1.5 text-gray-800">{r.item}</td>
                      <td className="px-3 py-1.5 text-gray-600">{r.specification || '—'}</td>
                      <td className="px-3 py-1.5 text-gray-600">{r.unit || '—'}</td>
                      <td className="px-3 py-1.5 font-medium text-gray-900">{r.quantity || '—'}</td>
                      <td className="px-3 py-1.5 text-gray-500">{r.basis}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="p-6 text-sm text-gray-500">
              Nothing to list yet — the switchgears need a panel specification in Device Library.
            </p>
          )}
        </div>
      )}

      <p className="mt-4 text-xs text-gray-400">
        {withLines.length} switchgear{withLines.length === 1 ? '' : 's'} with feeder lines ·
        {' '}the drawings are schematic: they show what the project holds, they are not a substitute for the EPLAN drawing set.
        {' '}DXF carries the same sheets as CAD geometry, on named layers, for customers who do not run EPLAN.
      </p>
    </div>
  );
};
