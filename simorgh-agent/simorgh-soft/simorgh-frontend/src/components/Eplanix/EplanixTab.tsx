import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import {
  DownloadIcon, PrinterIcon, ChevronLeftIcon, ChevronRightIcon, PencilRulerIcon, FileIcon } from 'lucide-react';
import { useProject } from '../../context/ProjectContext';
import { ProjectData, Equipment } from '../../types/project';
import { sheetName } from '../../utils/bpmsExport';
import { eplanSymbolService } from '../../services/projectService';
import { templateParts } from '../../utils/tierEquipmentMatrix';
import {
  EPLAN_HEADERS, EplanSymbolMap, buildEplanRows, buildSingleLinePages, buildSingleLineHtml,
  buildSymbolLibraryHtml, partKeys,
} from '../../utils/eplanSingleLine';
import {
  IEC_SYMBOLS, SYMBOL_GROUPS, CELL, SymbolId, SymbolOverride,
  setSymbolOverrides, setProjectSymbolOverrides, symbolOverride, symbolHeight,
  drawIecSymbol,
} from '../../utils/iecSymbols';

// The library's own ids, to match a file in the pack against by name.
const SYMBOL_IDS = new Map(Object.keys(IEC_SYMBOLS).map(id => [id.toLowerCase(), id as SymbolId]));
import {
  LAYOUT_HEADERS, buildPanelLayout, buildLayoutRows, buildLayoutSvg, buildLayoutHtml,
  buildLayoutDxf,
} from '../../utils/panelLayout';
import { sheetsToDxf } from '../../utils/cad/sheetDxf';
import { Drawing } from '../../utils/cad/shapes';
import { drawingFromSvg, svgSize } from '../../utils/cad/fromSvg';
import { fingerprint } from '../../utils/cad/edit';
import { EditorSheet } from '../SimorghDraw/DrawingEditor';
import { SheetEditorWindow } from '../SimorghDraw/SheetEditorWindow';
import { DxfSymbolPack } from '../SimorghDraw/DxfSymbolPack';
import { SymbolGraphicEditor } from '../SimorghDraw/SymbolGraphicEditor';
import { DxfSymbol, loadDxfSymbols, saveDxfSymbols, symbolFromDxf } from '../../utils/cad/dxfSymbols';
import { LEGIBLE_MM, PaperChoice, textHeightOn } from '../../utils/cad/paper';
import { toSymbolOverrides } from '../../utils/cad/projectSymbols';
import { DrawingEdits, SymbolArtOverride } from '../../types/project';
import { downloadText, fileSafe } from '../../utils/download';
import {
  MECHANICAL_HEADERS, buildMechanicalItems, buildMechanicalRows,
} from '../../utils/mechanicalItems';
import { DrawingPage, pageKey, readPages } from '../../utils/cad/pages';
import { PageNavigator } from '../SimorghDraw/PageNavigator';

// The Simorgh Draw tab: the drawings-and-lists outputs that come off the
// switchgear itself — the single line, the panel layout, and the mechanical
// items. Each one is previewed here before it is downloaded or printed, so
// what leaves the app has been looked at first.

type View = 'single-line' | 'pages' | 'layout' | 'mechanical' | 'symbols';

/**
 * The single line as CAD, one file per switchgear — the output for a customer
 * who has no EPLAN. The downloads are spaced out so the browser does not treat
 * the run as a pop-up storm.
 */
function exportSingleLineDxf(
  data: ProjectData, equipments: Equipment[], perPage: number, paper: PaperChoice,
  symbols?: EplanSymbolMap,
) {
  equipments.forEach((eq, i) => {
    const sheets = buildSingleLinePages(data, eq, perPage, symbols).map(page => page.svg);
    const dxf = sheetsToDxf(sheets, [
      eq.name || 'SWITCHGEAR',
      [data.projectName, data.projectNumber && `OE ${data.projectNumber}`].filter(Boolean).join('   ·   '),
      `Single line diagram · ${eq.type} · ${sheets.length} sheet(s)`,
      new Date().toLocaleDateString(),
    ].filter(Boolean), `${eq.name} single line`, { paper });
    setTimeout(
      () => downloadText(`${fileSafe(data.projectName)}_${fileSafe(eq.name)}_single_line.dxf`,
        dxf, 'image/vnd.dxf'),
      i * 250);
  });
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
  const { projectData, currentRevision, patchProjectData, isCurrentRevisionEditable } = useProject();
  const [view, setView] = useState<View>('single-line');
  // The drawing editor is a window over the single line, not a tab of its own:
  // you look at the sheet, then open it for editing where it already is.
  const [editing, setEditing] = useState(false);
  // A sheet with nothing on it. The editor beside this one always opens onto
  // a generated single line, which is most of the work but not all of it —
  // a sketch for the workshop, a detail to send with an order, a cover sheet.
  // Those need somewhere to start from that is not a switchgear.
  const [blank, setBlank] = useState(false);
  // The page the editor is opened on, or null when it is not open on a page.
  const [openPage, setOpenPage] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');   // equipment id, '' = all
  const [perPage, setPerPage] = useState(8);
  const [sheet, setSheet] = useState(0);
  // What EPLAN says each part is — the symbol it places for it. Without this
  // the drawing falls back to the slot the part sits in.
  const [symbols, setSymbols] = useState<EplanSymbolMap>({});
  const [packReplaced, setPackReplaced] = useState(0);
  // The pack's own symbols and the office's DXF ones are separate sources that
  // have to reach the library as one map, or whichever arrives last wins.
  const [packOverrides, setPackOverrides] = useState<Partial<Record<SymbolId, SymbolOverride>>>({});
  const [dxfSymbols, setDxfSymbols] = useState<DxfSymbol[]>(loadDxfSymbols);
  // The library keeps its overrides outside React, so the sheet needs telling
  // when they change.
  const [symbolVersion, setSymbolVersion] = useState(0);
  const [paper, setPaper] = useState<PaperChoice>('auto');
  // Bumped when a symbol is sent to the pack, so the pack is read again
  // without waiting for the parts on the sheet to change.
  const [packVersion, setPackVersion] = useState(0);
  // The library symbol the graphic page is open on, when one is.
  const [editingSymbol, setEditingSymbol] = useState<SymbolId | null>(null);
  const [symbolNote, setSymbolNote] = useState('Reading the EPLAN symbols…');

  const equipments = projectData.equipments ?? [];

  // Every part on the project's templates, by the codes EPLAN might know it
  // under. Looked up once per project, not once per sheet.
  const partCodes = useMemo(() => {
    const keys = new Set<string>();
    for (const tier of ['LV', 'MV', 'HV'] as const) {
      for (const template of projectData.templates?.[tier] ?? []) {
        for (const parts of Object.values(templateParts(template))) {
          for (const part of parts) for (const key of partKeys(part)) keys.add(key);
        }
      }
    }
    return [...keys].slice(0, 500);
  }, [projectData.templates]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (partCodes.length === 0) { setSymbols({}); setSymbolNote('No parts on the templates yet.'); return; }
      setSymbolNote('Reading the EPLAN symbols…');
      const [found, pack] = await Promise.all([
        eplanSymbolService.lookup(partCodes),
        eplanSymbolService.pack(),
      ]);
      if (cancelled) return;
      // A symbol the office exported from EPLAN is used as it is; the rest are
      // drawn here, from what EPLAN says the part is.
      const packLower = new Map(pack.map(entry => [entry.name.toLowerCase(), entry]));
      const map: EplanSymbolMap = {};
      let fromPack = 0;
      for (const [key, entry] of Object.entries(found)) {
        const exported = packLower.get(String(entry.symbol || '').toLowerCase());
        if (exported) fromPack += 1;
        map[key] = {
          ...entry,
          packUrl: exported ? eplanSymbolService.svgUrl(exported.name) : undefined,
          packWidth: exported?.width,
          packHeight: exported?.height,
          packPinX: exported?.pinX,
        };
      }
      setSymbols(map);

      // A file named after one of the library's own symbols — `vcb.svg`,
      // `circuit-breaker.dxf` — replaces that symbol everywhere, with no part
      // number and no EPLAN look-up involved.
      //
      // An SVG is placed as a picture, by the box the server read out of its
      // opening tag. A DXF is read here into geometry, and its box, its
      // conductor and how many cells it takes all come out of the drawing —
      // including the terminals on its CONN layer, which is what puts the
      // branch line through the device rather than beside it.
      const overrides: Partial<Record<SymbolId, SymbolOverride>> = {};
      let replaced = 0;
      let fromDrawings = 0;
      for (const entry of pack) {
        const id = SYMBOL_IDS.get(entry.name.toLowerCase());
        if (!id) continue;

        if (entry.kind === 'dxf') {
          const text = await eplanSymbolService.dxf(entry.name);
          if (cancelled) return;
          const drawn = text ? symbolFromDxf(text, `${entry.name}.dxf`, id) : null;
          // A file that holds nothing this reader understands is left out
          // rather than replacing a good symbol with an empty one.
          if (!drawn) continue;
          overrides[id] = {
            url: '', art: drawn.art, width: drawn.width, height: drawn.height,
            pinX: drawn.pinX, cells: drawn.cells, title: entry.title || `${entry.name}.dxf`,
          };
          replaced += 1;
          fromDrawings += 1;
          continue;
        }

        overrides[id] = {
          url: eplanSymbolService.svgUrl(entry.name),
          width: entry.width, height: entry.height, pinX: entry.pinX,
          cells: entry.cells, title: entry.title,
        };
        replaced += 1;
      }
      setPackOverrides(overrides);
      setPackReplaced(replaced);
      const matched = new Set(Object.values(found).map(e => e.partNumber || e.symbol)).size;
      const replacedNote = Object.keys(overrides).length > 0
        ? ` ${Object.keys(overrides).length} library symbol(s) replaced by the pack`
          + (fromDrawings > 0 ? `, ${fromDrawings} of them read from DXF as geometry.` : '.')
        : '';
      setSymbolNote(
        (Object.keys(found).length === 0
          ? 'EPLAN parts database has no symbol for these parts (or is out of reach) — symbols come from the template slots.'
          : `EPLAN symbols: ${matched} part(s) matched${fromPack > 0 ? `, ${fromPack} drawn with symbols exported from EPLAN` : ''}.`)
        + replacedNote);
    })();
    return () => { cancelled = true; };
  }, [partCodes, packVersion]);
  useEffect(() => {
    const fromDxf: Partial<Record<SymbolId, SymbolOverride>> = {};
    for (const s of dxfSymbols) {
      fromDxf[s.id as SymbolId] = {
        url: '', art: s.art, width: s.width, height: s.height,
        pinX: s.pinX, cells: s.cells, title: s.fileName,
      };
    }
    // The office's own drawing wins over the pack's picture of the same device.
    setSymbolOverrides({ ...packOverrides, ...fromDxf });
    setSymbolVersion(v => v + 1);
    saveDxfSymbols(dxfSymbols);
  }, [packOverrides, dxfSymbols]);

  // Symbols this project draws its own way, redrawn on the graphic page in the
  // template tab. Its own layer above the pack, so neither screen's symbols
  // depend on which of the two was opened last.
  useEffect(() => {
    setProjectSymbolOverrides(toSymbolOverrides(projectData.symbolOverrides));
    setSymbolVersion(v => v + 1);
  }, [projectData.symbolOverrides]);

  const withLines = equipments.filter(e => (e.devices ?? []).length > 0);
  const chosen = selected ? equipments.filter(e => e.id === selected) : equipments;
  const chosenWithLines = chosen.filter(e => (e.devices ?? []).length > 0);
  // Previews show one switchgear; the first of the chosen ones.
  const preview = chosenWithLines[0];

  const pages = useMemo(
    () => (preview ? buildSingleLinePages(projectData, preview, perPage, symbols) : []),
    [projectData, preview, perPage, symbols, symbolVersion]);
  const current = pages[Math.min(sheet, Math.max(0, pages.length - 1))];

  // A device label is 9 units on these sheets; what it plots at says whether
  // the chosen paper is readable before anyone sends it to a plotter.
  const exportLabelMm = useMemo(() => {
    if (paper === 'auto' || pages.length === 0) return null;
    const { width, height } = svgSize(pages[0].svg);
    return textHeightOn(width, height, paper, 0.5, 9);
  }, [paper, pages]);

  // The drawn sheets read back as geometry, which is what the editor edits and
  // what DXF and PDF are written from. Only built while the window is open —
  // the parse is quick, but there is no reason to do it while nobody is editing.
  /** An empty sheet at the chosen paper size, drawn on like any other. */
  const blankSheets = useMemo<EditorSheet[]>(() => {
    if (!blank) return [];
    // A3 landscape in millimetres — the size most of this office's drawings
    // are issued at, and the paper box in the editor can change it after.
    const width = 420, height = 297;
    return [{
      name: 'Blank sheet',
      // Drawing is a builder, not a bag of fields — the editor calls methods on
      // it, so it has to be a real one even when there is nothing on it yet.
      drawing: new Drawing(width, height, 'Blank sheet'),
      // Keyed apart from any switchgear's sheets, so edits to a free drawing
      // are never confused with edits to a generated one.
      key: 'blank#1',
      drawnAs: 'blank',
    }];
  }, [blank]);

  // ── The page set ──────────────────────────────────────────────────────
  // Read rather than taken: a project saved before pages existed has none, and
  // a project edited by hand could have anything.
  const drawPages = useMemo<DrawingPage[]>(
    () => readPages(projectData.drawingPages), [projectData.drawingPages]);

  const setPages = (next: DrawingPage[], edits: DrawingEdits) =>
    patchProjectData(() => ({ drawingPages: next, drawingEdits: edits }));

  /**
   * The page set as sheets the editor can page through.
   *
   * Every page, not just the one that was opened — the editor already has a
   * sheet strip, and turning it into the page tree costs nothing and means the
   * draughtsman can move between pages without closing anything.
   *
   * `drawnAs` is the constant 'page' because a hand-drawn page is not drawn
   * from anything: there is no project data underneath it that could move on
   * and leave the edits stale.
   */
  const pageSheets = useMemo<EditorSheet[]>(
    () => drawPages.map(page => ({
      name: page.name,
      drawing: new Drawing(page.width, page.height, page.name),
      key: pageKey(page.id),
      drawnAs: 'page',
      kind: page.type,
    })),
    [drawPages]);

  const editorSheets = useMemo<EditorSheet[]>(
    () => (editing && preview
      ? pages.map(page => ({
          name: `Sheet ${page.page} of ${page.of}`,
          drawing: drawingFromSvg(page.svg, `${preview.name} ${page.page}/${page.of}`),
          // Where the project keeps this sheet's edits. The pagination is part
          // of it, so changing the feeders per sheet leaves the old edits where
          // they are rather than dropping them onto sheets they never matched.
          key: `${preview.id}#${perPage}#${page.page}`,
          drawnAs: fingerprint(page.svg),
        }))
      : []),
    [editing, pages, preview, perPage]);

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
          <h2 className="text-xl font-bold text-gray-800">Simorgh Draw</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {projectData.projectName} — single line, panel layout and mechanical items,
            drawn from Device Selection and the templates behind it.
          </p>
        </div>
        <div className="flex items-center flex-wrap gap-2">
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

      <div className="grid grid-cols-5 gap-3 mb-5">
        <Tab id="single-line" label="Single line" note="Busbar, feeders, devices, data blocks" />
        <Tab id="pages" label="Pages" note="Wiring diagrams, single lines, layouts" />
        <Tab id="layout" label="Layout" note="Front elevation, column by column" />
        <Tab id="mechanical" label="Mechanical" note="Enclosure, busbars, compartments" />
        <Tab id="symbols" label="Symbols" note="The IEC single-line library" />
      </div>

      {/* ── Pages ─────────────────────────────────────────────────────── */}
      {view === 'pages' && (
        <PageNavigator
          pages={drawPages}
          edits={projectData.drawingEdits}
          onChange={setPages}
          onOpen={id => { setOpenPage(id); setBlank(false); setEditing(true); }}
          canEdit={isCurrentRevisionEditable}
          fileBase={fileSafe(projectData.projectName || 'project')}
        />
      )}

      {/* ── Single line ───────────────────────────────────────────────── */}
      {view === 'single-line' && (
        <div className="border border-gray-200 rounded-lg">
          <div className="px-4 py-3 bg-gray-50 border-b space-y-2.5">
            <div className="flex items-start gap-3 min-w-0">
              <span className="text-xs font-bold px-2 py-0.5 rounded-full text-white bg-blue-700">EPLAN</span>
              <div className="min-w-0">
                <p className="font-medium text-sm text-gray-800">
                  {preview ? `${preview.name} — ${preview.devices?.length ?? 0} feeders` : 'No switchgear with feeder lines'}
                </p>
                <p className="text-xs text-gray-500">
                  One sheet per {perPage} feeders · supply, busbar, device chain and a data block per feeder.
                </p>
                <p className="text-[11px] text-blue-700 mt-0.5">{symbolNote}</p>
              </div>
            </div>
            <div className="flex items-center flex-wrap gap-2">
              <select
                className="border border-gray-300 rounded px-2 py-1.5 text-sm"
                value={perPage}
                onChange={e => { setPerPage(Number(e.target.value)); setSheet(0); }}
              >
                {/* Two to a sheet is what an A4 holds and stays readable. */}
                {[2, 3, 4, 6, 8, 10, 12].map(n => <option key={n} value={n}>{n} feeders / sheet</option>)}
              </select>
              <button
                onClick={() => { setBlank(true); setEditing(true); }}
                title="Open an empty sheet — draw anything from scratch and write DXF / PDF / SVG"
                className="flex items-center gap-2 px-4 py-2 rounded-lg shadow-sm font-medium text-sm whitespace-nowrap border border-gray-300 bg-white text-gray-700 hover:bg-gray-100"
              >
                <FileIcon className="w-4 h-4" /> Blank sheet
              </button>
              {/* Editing starts from the sheet itself. */}
              <button
                onClick={() => { setBlank(false); setEditing(true); }}
                disabled={!preview}
                title={preview
                  ? 'Open this single line in Simorgh Draw — move, retype, draw lines and text, and write DXF / PDF / SVG'
                  : 'Add feeder lines in Device Selection first'}
                className="flex items-center gap-2 px-4 py-2 rounded-lg shadow-sm font-medium text-sm whitespace-nowrap bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40"
              >
                <PencilRulerIcon className="w-4 h-4" />
                Edit drawing
              </button>
              <Btn
                onClick={() => openPrintable(
                  buildSingleLineHtml(projectData, chosenWithLines, perPage, symbols), 'single-line diagram')}
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
              <select
                className="border border-gray-300 rounded px-2 py-1.5 text-sm"
                value={paper}
                onChange={e => setPaper(e.target.value as PaperChoice)}
                title="The sheet DXF and PDF are put on. 'Fit the drawing' keeps the scale and lets the sheet grow."
              >
                <option value="auto">fit the drawing</option>
                {(['A4', 'A3', 'A2', 'A1', 'A0'] as const).map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              {exportLabelMm != null && exportLabelMm < LEGIBLE_MM && (
                <span
                  className="text-[11px] text-amber-700 font-medium tabular-nums"
                  title={`A device label plots at ${exportLabelMm.toFixed(2)} mm on ${paper}, under the ${LEGIBLE_MM} mm a drawing stays readable at. Fewer feeders to a sheet, or a bigger sheet.`}
                >
                  labels {exportLabelMm.toFixed(1)} mm
                </span>
              )}
              <Btn
                onClick={() => exportSingleLineDxf(projectData, chosenWithLines, perPage, paper, symbols)}
                className="bg-teal-700 text-white hover:bg-teal-800"
                disabled={chosenWithLines.length === 0}
              >
                DXF (CAD)
              </Btn>
            </div>
          </div>

          {current ? (
            <>
              <div
                className="p-3 overflow-x-auto bg-white cursor-pointer"
                onDoubleClick={() => setEditing(true)}
                title="Double-click to edit this drawing"
              >
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

      {/* ── A page of the set, opened from the page tree ──────────────── */}
      {editing && openPage && (
        <SheetEditorWindow
          title={`Simorgh Draw — ${drawPages.find(p => p.id === openPage)?.name ?? 'page'}`}
          note={`${drawPages.length} page(s) in this project · the sheet list at the top right turns between them`}
          sheets={pageSheets}
          startAt={Math.max(0, drawPages.findIndex(p => p.id === openPage))}
          fileBase={`${projectData.projectName || 'project'}_pages`}
          paper={paper}
          savedEdits={projectData.drawingEdits}
          canEdit={isCurrentRevisionEditable}
          onSaveEdits={next => patchProjectData(() => ({ drawingEdits: next }))}
          titleBlock={[
            drawPages.find(p => p.id === openPage)?.name ?? 'DRAWING',
            [projectData.projectName, projectData.projectNumber && `OE ${projectData.projectNumber}`]
              .filter(Boolean).join('   ·   '),
            drawPages.find(p => p.id === openPage)?.description ?? '',
            new Date().toLocaleDateString(),
          ].filter(Boolean)}
          onClose={() => { setEditing(false); setOpenPage(null); }}
        />
      )}

      {/* ── An empty sheet, opened from Blank sheet ─────────────────── */}
      {editing && blank && !openPage && (
        <SheetEditorWindow
          title="Blank sheet"
          note="An empty sheet — draw anything, and write DXF / PDF / SVG"
          sheets={blankSheets}
          fileBase={`${projectData.projectName || 'project'}_drawing`}
          paper={paper}
          savedEdits={projectData.drawingEdits}
          canEdit={isCurrentRevisionEditable}
          onSaveEdits={next => patchProjectData(() => ({ drawingEdits: next }))}
          titleBlock={[
            'DRAWING',
            [projectData.projectName, projectData.projectNumber && `OE ${projectData.projectNumber}`]
              .filter(Boolean).join('   ·   '),
            '',
            new Date().toLocaleDateString(),
          ].filter(Boolean)}
          onClose={() => { setEditing(false); setBlank(false); }}
        />
      )}

      {/* ── The drawing editor, opened from the single line ─────────── */}
      {editing && !blank && !openPage && (
        editorSheets.length > 0 && preview ? (
          <SheetEditorWindow
            title={`Edit drawing — ${preview.name}`}
            note={`Single line · ${pages.length} sheet(s) at ${perPage} feeders each · move, retype, draw, and write DXF / PDF / SVG`}
            sheets={editorSheets}
            fileBase={`${projectData.projectName || 'project'}_${preview.name}`}
            paper={paper}
            savedEdits={projectData.drawingEdits}
            canEdit={isCurrentRevisionEditable}
            onSaveEdits={next => patchProjectData(() => ({ drawingEdits: next }))}
            titleBlock={[
              preview.name || 'SWITCHGEAR',
              [projectData.projectName, projectData.projectNumber && `OE ${projectData.projectNumber}`]
                .filter(Boolean).join('   ·   '),
              `Single line diagram · ${preview.type ?? ''}`,
              new Date().toLocaleDateString(),
            ].filter(Boolean)}
            onClose={() => setEditing(false)}
          />
        ) : null
      )}

      {/* ── Layout ────────────────────────────────────────────────────── */}
      {view === 'layout' && (
        <div className="border border-gray-200 rounded-lg">
          <div className="px-4 py-3 bg-gray-50 border-b space-y-2.5">
            <div className="flex items-start gap-3 min-w-0">
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
            <div className="flex items-center flex-wrap gap-2">
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
          <div className="px-4 py-3 bg-gray-50 border-b space-y-2.5">
            <div className="flex items-start gap-3 min-w-0">
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

      {/* ── The symbol library ────────────────────────────────────────── */}
      {view === 'symbols' && (
        <div className="space-y-4">
        <DxfSymbolPack
          symbols={dxfSymbols}
          onChange={setDxfSymbols}
          onPackChanged={() => setPackVersion(v => v + 1)}
        />
        <div className="border border-gray-200 rounded-lg">
          <div className="px-4 py-3 bg-gray-50 border-b space-y-2.5">
            <div className="flex items-start gap-3 min-w-0">
              <span className="text-xs font-bold px-2 py-0.5 rounded-full text-white bg-slate-700">IEC</span>
              <div className="min-w-0">
                <p className="font-medium text-sm text-gray-800">
                  {Object.keys(IEC_SYMBOLS).length} single-line symbols
                </p>
                <p className="text-xs text-gray-500">
                  What the drawing uses for each device. Click one to redraw it for this
                  project. An SVG or DXF dropped into the symbol pack under one of these
                  names replaces the symbol here, everywhere.
                  {packReplaced > 0 && (
                    <span className="text-emerald-700 font-medium">
                      {' '}{packReplaced} replaced by the pack.
                    </span>
                  )}
                </p>
              </div>
            </div>
            <Btn
              onClick={() => openPrintable(buildSymbolLibraryHtml(), 'symbol library')}
              icon="print"
              className="bg-slate-700 text-white hover:bg-slate-800"
            >
              Print / PDF
            </Btn>
          </div>

          <div className="p-4 space-y-5">
            {SYMBOL_GROUPS.map(group => (
              <div key={group}>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{group}</p>
                <div className="grid grid-cols-6 gap-3">
                  {Object.values(IEC_SYMBOLS).filter(sym => sym.group === group).map(sym => {
                    // Drawn the way a sheet draws it, so a symbol the pack has
                    // replaced shows here as what the drawing will use.
                    const replaced = !!symbolOverride(sym.id);
                    const tall = symbolHeight(sym.id) / CELL;
                    return (
                      <button key={sym.id}
                           onClick={() => setEditingSymbol(sym.id)}
                           title={`Open ${sym.title} on the graphic page`}
                           className={`text-left border rounded p-2 bg-white hover:border-blue-400 hover:shadow-sm transition ${
                             replaced ? 'border-emerald-400' : 'border-gray-200'}`}>
                        <svg width="100%" height={CELL + 16} viewBox={`0 0 90 ${CELL + 16}`}>
                          <g transform={tall > 1 ? `translate(28 8) scale(${1 / tall}) translate(-28 -8)` : undefined}
                             dangerouslySetInnerHTML={{ __html: drawIecSymbol(sym.id, 28, 8) }} />
                        </svg>
                        <p className="text-[11px] text-gray-800 leading-tight mt-1">{sym.title}</p>
                        {replaced && (
                          <p className="text-[10px] text-emerald-700 leading-tight">
                            {projectData.symbolOverrides?.[sym.id] ? 'redrawn for this project' : 'from the pack'}
                          </p>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
        </div>
      )}

      {editingSymbol && (
        <SymbolGraphicEditor
          symbolId={editingSymbol}
          override={projectData.symbolOverrides?.[editingSymbol]}
          onSave={(art: SymbolArtOverride) => patchProjectData(prev => {
            const next = { ...(prev.symbolOverrides ?? {}) };
            next[editingSymbol] = art;
            return { symbolOverrides: next };
          })}
          onReset={() => patchProjectData(prev => {
            const next = { ...(prev.symbolOverrides ?? {}) };
            delete next[editingSymbol];
            return { symbolOverrides: next };
          })}
          onClose={() => setEditingSymbol(null)}
        />
      )}

      <p className="mt-4 text-xs text-gray-400">
        {withLines.length} switchgear{withLines.length === 1 ? '' : 's'} with feeder lines ·
        {' '}the drawings are schematic: they show what the project holds, they are not a substitute for the EPLAN drawing set.
      </p>
    </div>
  );
};
