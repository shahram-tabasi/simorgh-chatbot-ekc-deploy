import React, { useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import { useProject } from '../../context/ProjectContext';
import {
  FileSpreadsheetIcon, FileTextIcon, FileCode2Icon,
  DownloadIcon, CheckCircleIcon, ChevronDownIcon, ChevronRightIcon
} from 'lucide-react';
import { ProjectData, Revision } from '../../types/project';
import { projectService } from '../../services/projectService';
import {
  LV_TEMPLATE_PROPERTIES, MV_TEMPLATE_PROPERTIES,
  LV_DEVICE_COLS, MV_DEVICE_COLS,
  buildTierMatrix,
} from '../../utils/tierEquipmentMatrix';
import { BpmsTier, buildBpmsSheets, sheetName, styleBpmsSheet } from '../../utils/bpmsExport';
import { RevisionDiff, diffProjectSnapshots, buildDiffRows } from '../../utils/revisionDiff';
// The specification's field labels live with the specification itself, so the
// Device Library breakdown and these sheets always read the same names.
import { DEVICE_PROP_LABELS } from '../../utils/deviceProperties';
import { TIERS, TIER_PILL, LAYOUT_OF, type Tier } from '../../utils/tiers';
import { appAlert } from '../shared/AppDialog';


// ── Helpers ──────────────────────────────────────────────────────────────────
const v = (val: any) => (val == null || val === '' ? '—' : String(val));
const boolStr = (val: any) => (val ? '✓' : '—');

// ─── Per-section Excel export ─────────────────────────────────────────────────
function exportTierExcel(data: ProjectData, tier: 'LV' | 'MV') {
  const { headers, rows } = buildTierMatrix(data, tier);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  XLSX.utils.book_append_sheet(wb, ws, `${tier} Equipment`);
  XLSX.writeFile(wb, `${data.projectName}_${tier}_Equipment.xlsx`);
}

// ─── BPMS export ──────────────────────────────────────────────────────────────
// The BPMS sheet for one switchgear, laid out like the hand-made workbook: the
// line columns from Device Selection, then one row per part on that line's
// template from Create Template. One switchgear per file, because that is what
// a BPMS sheet is — it is read beside one panel's own drawing set, and a
// workbook holding every switchgear in the project is a different document.
function exportBpmsExcel(
  data: ProjectData, tier: BpmsTier, equipmentId: string, revisionNumber?: string,
) {
  const sheets = buildBpmsSheets(data, { revisionNumber, tier, equipmentId });
  if (sheets.length === 0) {
    void appAlert(`No ${tier} switchgear to report on — pick one first.`);
    return;
  }
  const wb = XLSX.utils.book_new();
  const taken = new Set<string>();
  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    styleBpmsSheet(ws, sheet);
    XLSX.utils.book_append_sheet(wb, ws, sheetName(sheet.name, taken));
  }
  const rev = revisionNumber ? `_REV${revisionNumber}` : '';
  const who = (sheets[0].name || tier).replace(/[^\w.-]+/g, '_');
  XLSX.writeFile(wb, `${data.projectName || 'project'}_${who}_BPMS${rev}.xlsx`);
}

/**
 * The BPMS report, one switchgear at a time.
 *
 * A BPMS sheet belongs to a panel: it is read beside that panel's drawings and
 * checked against them. So the switchgear is picked and the file holds that
 * one — LV and MV alike, each with its own layout. The MV sheet is the same
 * sheet without Position and Size, which are the LV modular frame's own.
 */
const BpmsSection: React.FC<{
  projectData: ProjectData;
  revisionNumber?: string;
  downloading: string | null;
  trigger: (key: string, fn: () => void) => void;
}> = ({ projectData, revisionNumber, downloading, trigger }) => {
  const [chosen, setChosen] = useState<Record<BpmsTier, string>>({ LV: '', MV: '' });

  const row = (tier: BpmsTier) => {
    const equipments = (projectData.equipments ?? []).filter(e => e.type === tier);
    // One switchgear, and when there is only one it needs no picking.
    const id = chosen[tier] || (equipments.length === 1 ? equipments[0].id : '');
    const sheet = id
      ? buildBpmsSheets(projectData, { tier, equipmentId: id })[0]
      : undefined;
    const key = `bpms-${tier}`;

    return (
      <div
        key={tier}
        className="border border-gray-200 rounded-lg mb-3 px-4 py-3 flex items-center justify-between gap-4 bg-gray-50"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span
            className="text-xs font-bold px-2 py-0.5 rounded-full text-white"
            style={{ background: tier === 'LV' ? '#0f766e' : '#b45309' }}
          >
            BPMS
          </span>
          <div className="min-w-0">
            <p className="font-medium text-sm text-gray-800">BPMS Report — {tier}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {equipments.length === 0
                ? `No ${tier} switchgear yet.`
                : sheet
                  ? `${sheet.lineCount} line${sheet.lineCount === 1 ? '' : 's'} · `
                    + `${sheet.partRowCount} row${sheet.partRowCount === 1 ? '' : 's'} — one row per part.`
                  : `Pick one of the ${equipments.length} ${tier} switchgears.`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {equipments.length > 1 && (
            <select
              value={id}
              onChange={e => setChosen(prev => ({ ...prev, [tier]: e.target.value }))}
              className="border border-gray-300 rounded-lg px-2 py-2 text-sm bg-white max-w-[200px]"
            >
              <option value="">Switchgear…</option>
              {equipments.map(eq => (
                <option key={eq.id} value={eq.id}>{eq.name}</option>
              ))}
            </select>
          )}
          <button
            disabled={!!downloading || !id}
            onClick={() => trigger(key, () =>
              exportBpmsExcel(projectData, tier, id, revisionNumber))}
            className={`flex items-center gap-2 px-4 py-2 text-white rounded-lg disabled:opacity-50 shadow-sm font-medium text-sm whitespace-nowrap ${
              tier === 'LV' ? 'bg-teal-700 hover:bg-teal-800' : 'bg-amber-700 hover:bg-amber-800'}`}
            title={id ? `Export the BPMS sheet for this switchgear` : 'Pick a switchgear first'}
          >
            {downloading === key
              ? <span className="animate-spin">⏳</span>
              : <FileSpreadsheetIcon className="w-4 h-4" />}
            BPMS Excel
          </button>
        </div>
      </div>
    );
  };

  return <>{(['LV', 'MV'] as BpmsTier[]).map(row)}</>;
};

// ─── EPLAN single line ────────────────────────────────────────────────────────
// The device list EPLAN imports (one sheet per switchgear, one row per device
// on a feeder), and the schematic drawing of the same lines.



// ─── Layout (جانمایی) ─────────────────────────────────────────────────────────


// ─── Mechanical items (اقلام مکانیکال) ────────────────────────────────────────

// ─── Revision comparison ──────────────────────────────────────────────────────
function exportDiffExcel(diff: RevisionDiff, meta: { projectName: string; base: string; target: string }) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(buildDiffRows(diff, meta));
  ws['!cols'] = [{ wch: 14 }, { wch: 28 }, { wch: 10 }, { wch: 22 }, { wch: 30 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, ws, `REV ${meta.base} to ${meta.target}`.slice(0, 31));
  XLSX.writeFile(wb, `${meta.projectName || 'project'}_REV${meta.base}_vs_REV${meta.target}.xlsx`);
}

// ─── Per-section PDF (print-to-PDF window) ────────────────────────────────────
function exportTierPDF(data: ProjectData, tier: 'LV' | 'MV') {
  const { headers, rows } = buildTierMatrix(data, tier);
  const accent = tier === 'LV' ? '#065f46' : '#92400e';
  const accentSoft = tier === 'LV' ? '#d1fae5' : '#fef3c7';

  const thHtml = headers
    .map(h => `<th style="background:${accent};color:#fff;padding:5px 7px;font-size:10px;text-align:left;border:1px solid #fff;white-space:nowrap">${h}</th>`)
    .join('');
  const rowsHtml = rows.map((r, i) => `<tr style="background:${i % 2 ? '#fafafa' : '#fff'}">${
    r.map((cell, ci) => {
      const safe = String(cell ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;');
      const isFirst = ci === 0;
      return `<td style="padding:4px 6px;border:1px solid #e5e7eb;font-size:9.5px;vertical-align:top;white-space:pre-wrap;${isFirst ? 'font-weight:600' : ''}">${safe}</td>`;
    }).join('')
  }</tr>`).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>${data.projectName} — ${tier} Equipment</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',Arial,sans-serif;background:#fff;color:#111;padding:12px}
    @page{size:A2 landscape;margin:10mm}
    @media print{.no-print{display:none}body{padding:0}}
    table{page-break-inside:auto;border-collapse:collapse;width:100%}
    tr{page-break-inside:avoid}
  </style></head><body>
  <div style="background:${accent};color:#fff;padding:14px 18px;border-radius:6px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center">
    <div>
      <div style="font-size:9px;letter-spacing:.8px;opacity:.8">SIMORGH DESIGN — ${tier} EQUIPMENT REPORT</div>
      <div style="font-size:17px;font-weight:800;margin-top:2px">${data.projectName}</div>
    </div>
    <div style="text-align:right;font-size:10px;opacity:.85">
      <div>${new Date().toLocaleString()}</div>
      <div>${rows.length} rows × ${headers.length} cols</div>
    </div>
  </div>
  <div class="no-print" style="margin-bottom:10px;text-align:right">
    <button onclick="window.print()" style="background:${accent};color:#fff;border:none;padding:6px 16px;border-radius:5px;cursor:pointer;font-size:12px;font-weight:600">🖨 Print / Save as PDF</button>
  </div>
  <div style="overflow-x:auto"><table>
    <thead><tr>${thHtml}</tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table></div>
  <div style="margin-top:12px;border-top:1px solid #e5e7eb;padding-top:6px;font-size:9px;color:#9ca3af">
    Generated by Simorgh Design Software — ${tier} section export
  </div>
  <script>window.onload=()=>{window.focus();window.print();}<\/script>
  </body></html>`;

  const win = window.open('', '_blank', 'width=1400,height=900');
  if (win) { win.document.write(html); win.document.close(); }
  // also silence the unused-variable warning if accentSoft is not used elsewhere
  void accentSoft;
}

function buildProjectRows(p: ProjectData) {
  return [
    ['Project Name',          v(p.projectName)],
    ['Project ID (PID)',      v(p.projectId)],
    ['Project Number (OE)',   v(p.projectNumber)],
    ['Description',           v(p.projectDescription)],
    ['Client',                v(p.client)],
    ['Location',              v(p.location)],
    ['Standard',              v(p.standard)],
    ['Country',               v(p.country)],
    ['Language',              v(p.language)],
    ['Planner',               v(p.planner)],
    ['Design Office',         v(p.designOffice)],
    ['Notice to Proceed',     v(p.noticeToProceedDate)],
    ['Delivery Date',         v(p.deliveryDate)],
    ['Created On',            v(p.createdOn)],
    ['Last Modified',         v(p.changedOn)],
    ['Comment',               v(p.comment)],
  ];
}

function buildTechRows(p: ProjectData) {
  const ts = p.techSettings;
  if (!ts) return [];
  return [
    // General
    ['General', ''],
    ['Altitude Above Sea Level (m)',  v(ts.general.altitudeAboveSeaLevel)],
    ['Design Temperature (°C)',       v(ts.general.designTemperature)],
    // Wire Size
    ['Wire Size *', ''],
    ['Control Circuit',   v(ts.wireSize.controlCircuit)],
    ['CT Secondary',      v(ts.wireSize.ctSecondary)],
    ['PT Secondary',      v(ts.wireSize.ptSecondary)],
    ['PLC Power Supply',  v(ts.wireSize.plcPowerSupply)],
    // Wire Color
    ['Wire Color *', ''],
    ['AC Phase',     v(ts.wireColor.acPhase)],
    ['DC +',         v(ts.wireColor.dcPlus)],
    ['AC Neutral',   v(ts.wireColor.acNeutral)],
    ['DC –',         v(ts.wireColor.dcMinus)],
    ['PLC Input',    v(ts.wireColor.plcInput)],
    ['PLC Output',   v(ts.wireColor.plcOutput)],
    ['3 Phase',      v(ts.wireColor.threePhase)],
    // Manufacturer
    ['Wire / Cable Manufacturer *', ''],
    ['LV', v(ts.wireManufacturer.lv)],
    ['MV', v(ts.wireManufacturer.mv)],
    // Others
    ['Others', ''],
    ['Thickness of Painting (μm)', v(ts.others.thicknessOfPainting)],
    ['Color Type',        v(ts.others.colorType)],
    ['Background Color',  v(ts.others.backgroundColor)],
    ['Writing Color',     v(ts.others.writingColor)],
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT: EXCEL
// ─────────────────────────────────────────────────────────────────────────────
function exportExcel(data: ProjectData) {
  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Project Overview ──────────────────────────────────────────────
  const projRows = [['Field', 'Value'], ...buildProjectRows(data)];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(projRows), 'Project Overview');

  // ── Sheet 2: Technical Settings ────────────────────────────────────────────
  const techRows = [['Parameter', 'Value'], ...buildTechRows(data)];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(techRows), 'Technical Settings');

  // ── Sheet 3: Device Library ─────────────────────────────────────────────
  const propKeys = Object.keys(DEVICE_PROP_LABELS);
  const devHeaders = ['#', 'Name', 'Type', ...propKeys.map(k => DEVICE_PROP_LABELS[k])];
  const devRows: any[][] = [devHeaders];
  let idx = 1;
  for (const tier of TIERS) {
    for (const dev of (data.deviceLibrary?.[tier] ?? [])) {
      const p = dev.properties as Record<string, any>;
      devRows.push([
        idx++, dev.name, dev.type,
        ...propKeys.map(k =>
          typeof p[k] === 'boolean' ? boolStr(p[k]) : v(p[k])
        )
      ]);
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(devRows), 'Device Library');

  // ── Sheet 4: Equipment & Selections ────────────────────────────────────────
  const eqHeaders = [
    '#', 'Equipment', 'Type', 'Device (Library)',
    'Row', 'Template', 'Bus Section', 'Feeder No', 'Wiring Type', 'Rating Power', 'FLC (A)'
  ];
  const eqRows: any[][] = [eqHeaders];
  let eqIdx = 1;
  for (const eq of (data.equipments ?? [])) {
    const libItemId  = eq.properties?.deviceLibraryItemId as string | undefined;
    const libItem    = libItemId
      ? TIERS.flatMap(t => data.deviceLibrary?.[t] ?? []).find(d => d.id === libItemId)
      : null;

    if (!eq.devices || eq.devices.length === 0) {
      eqRows.push([eqIdx++, eq.name, eq.type, libItem ? libItem.name : '—', '—', '—', '—', '—', '—', '—', '—']);
    } else {
      eq.devices.forEach((row, ri) => {
        eqRows.push([
          ri === 0 ? eqIdx++ : '', ri === 0 ? eq.name : '', ri === 0 ? eq.type : '', ri === 0 ? (libItem ? libItem.name : '—') : '',
          row.rowNumber, v(row.templateName), v(row.busSection), v(row.feederNo), v(row.wiringType), v(row.ratingPower), v(row.flc)
        ]);
      });
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(eqRows), 'Equipment & Selections');

  // ── Sheet 5: Template Components Breakdown (only used templates) ──────────
  const usedTemplateIds = new Set<string>();
  (data.equipments ?? []).forEach(eq => eq.devices?.forEach(d => { if (d.templateId) usedTemplateIds.add(d.templateId); }));
  const usedTemplates = TIERS.flatMap(t => data.templates?.[t] ?? []).filter(t => usedTemplateIds.has(t.id));

  const tmplHeaders = ['Template', 'Type', 'Property', 'Part Number', 'Manufacturer', 'Rating', 'Label', 'Qty', 'Priority', 'Locked'];
  const tmplRows: any[][] = [tmplHeaders];
  for (const tmpl of usedTemplates) {
    const props = (tmpl.properties ?? {}) as Record<string, any>;
    const displayNames: Record<string, string> = props.__displayNames || {};
    const lockedRows: string[]                  = props.__locked || [];
    const entries = Object.entries(props).filter(
      ([k, val]) => k !== '__displayNames' && k !== '__locked'
        && val && Array.isArray((val as any).parts) && (val as any).parts.length > 0
    );
    if (entries.length === 0) {
      tmplRows.push([tmpl.name, tmpl.type, '—', '—', '—', '—', '—', '—', '—', '—']);
      continue;
    }
    for (const [propName, propVal] of entries) {
      const label = displayNames[propName] || propName;
      const locked = lockedRows.includes(propName) ? 'yes' : '';
      const parts = (propVal as any).parts as any[];
      parts.forEach((part, pi) => {
        tmplRows.push([
          pi === 0 ? tmpl.name : '',
          pi === 0 ? tmpl.type : '',
          pi === 0 ? label : '',
          v(part.partNumber),
          v(part.fullData?.Manufacturer),
          v(part.fullData?.Designation3),
          v(part.label),
          part.quantity ?? 1,
          part.priority ?? 1,
          pi === 0 ? locked : '',
        ]);
      });
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(tmplRows), 'Template Components');

  XLSX.writeFile(wb, `${data.projectName}_Report.xlsx`);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT: PDF  (via browser print-to-PDF — no external library needed)
// Opens a styled print-ready window; user clicks Print → Save as PDF
// ─────────────────────────────────────────────────────────────────────────────
function exportPDF(data: ProjectData) {
  const propKeys  = Object.keys(DEVICE_PROP_LABELS);
  const allDevices = TIERS.flatMap(t => (data.deviceLibrary?.[t] ?? []).map(d => ({ ...d, tier: t })));

  const th  = (label: string, bg = '#1e50a2') =>
    `<th style="background:${bg};color:#fff;padding:6px 10px;text-align:left;font-size:11px;white-space:nowrap">${label}</th>`;
  const td  = (val: any, bold = false) =>
    `<td style="padding:5px 10px;border-bottom:1px solid #e5e7eb;font-size:11px;${bold ? 'font-weight:600;' : ''}">${val ?? '—'}</td>`;

  const secHd = (n: string, title: string, color: string) =>
    `<div style="background:${color};color:#fff;padding:6px 14px;border-radius:4px;margin:20px 0 8px;font-size:13px;font-weight:700;letter-spacing:.4px">${n}. ${title}</div>`;

  const table = (rows: string, cols: number) =>
    `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;margin-bottom:4px">${rows}</table></div>`;

  // ── Project overview table ────────────────────────────────────────────────
  const projTable = table(
    `<thead><tr>${th('Field')}${th('Value')}</tr></thead><tbody>` +
    buildProjectRows(data).map((r, i) =>
      `<tr style="background:${i%2?'#f7f9fc':'#fff'}">${td(r[0], true)}${td(r[1])}</tr>`
    ).join('') + '</tbody>',
    2
  );

  // ── Technical settings table ──────────────────────────────────────────────
  const techRows = buildTechRows(data);
  const techTable = techRows.length === 0 ? '' : table(
    `<thead><tr>${th('Parameter', '#277548')}${th('Value', '#277548')}</tr></thead><tbody>` +
    techRows.map((r, i) =>
      r[1] === ''
        ? `<tr><td colspan="2" style="padding:5px 10px;font-weight:700;font-size:11px;background:#d1fae5;color:#065f46">${r[0]}</td></tr>`
        : `<tr style="background:${i%2?'#f7f9fc':'#fff'}">${td(r[0], true)}${td(r[1])}</tr>`
    ).join('') + '</tbody>',
    2
  );

  // ── Device library table ──────────────────────────────────────────────────
  const devTable = allDevices.length === 0 ? '<p style="color:#9ca3af;font-size:12px">No devices defined.</p>' : table(
    `<thead><tr>${th('#','#277548')}${th('Name','#277548')}${th('Type','#277548')}${propKeys.map(k => th(DEVICE_PROP_LABELS[k],'#277548')).join('')}</tr></thead><tbody>` +
    allDevices.map((dev, i) => {
      const p = dev.properties as Record<string, any>;
      const tc = dev.tier==='LV'?'#065f46':dev.tier==='MV'?'#92400e':'#991b1b';
      const bg = dev.tier==='LV'?'#d1fae5':dev.tier==='MV'?'#fef3c7':'#fee2e2';
      return `<tr style="background:${i%2?'#f7f9fc':'#fff'}">${td(i+1)}${td(dev.name, true)}` +
        `<td style="padding:5px 10px;border-bottom:1px solid #e5e7eb"><span style="background:${bg};color:${tc};padding:1px 6px;border-radius:10px;font-size:10px;font-weight:700">${dev.tier}</span></td>` +
        propKeys.map(k => td(typeof p[k]==='boolean' ? (p[k]?'✓':'—') : v(p[k]))).join('') + '</tr>';
    }).join('') + '</tbody>',
    3 + propKeys.length
  );

  // ── Equipment & selections table ──────────────────────────────────────────
  const eqs = data.equipments ?? [];
  const allLib = TIERS.flatMap(t => data.deviceLibrary?.[t] ?? []);
  const eqTable = eqs.length === 0 ? '<p style="color:#9ca3af;font-size:12px">No equipment defined.</p>' : table(
    `<thead><tr>${['Equipment','Type','Device (Library)','Row','Template','Bus Section','Feeder No','Wiring Type','Rating Power','FLC (A)'].map(h=>th(h,'#b45309')).join('')}</tr></thead><tbody>` +
    eqs.flatMap((eq, eqi) => {
      const libItem = allLib.find(d => d.id === (eq.properties?.deviceLibraryItemId as string));
      if (!eq.devices || eq.devices.length === 0) {
        return [`<tr style="background:${eqi%2?'#fff7ed':'#fff'}">${td(eq.name,true)}${td(eq.type)}${td(libItem?.name??'—')}${Array(7).fill(td('—')).join('')}</tr>`];
      }
      return eq.devices.map((row, ri) =>
        `<tr style="background:${eqi%2?'#fff7ed':'#fff'}">${td(ri===0?eq.name:'',true)}${td(ri===0?eq.type:'')}${td(ri===0?(libItem?.name??'—'):'')}${td(row.rowNumber)}${td(v(row.templateName))}${td(v(row.busSection))}${td(v(row.feederNo))}${td(v(row.wiringType))}${td(v(row.ratingPower))}${td(v(row.flc))}</tr>`
      );
    }).join('') + '</tbody>',
    10
  );

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>${data.projectName} — PDF Report</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',Arial,sans-serif;background:#fff;color:#111;padding:20px}
    @page{size:A3 landscape;margin:15mm}
    @media print{.no-print{display:none}body{padding:0}}
    table{page-break-inside:auto}tr{page-break-inside:avoid}
  </style></head><body>
  <div style="background:linear-gradient(135deg,#1e50a2,#3b82f6);color:#fff;padding:20px 24px;border-radius:8px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center">
    <div>
      <div style="font-size:10px;letter-spacing:1px;opacity:.8;margin-bottom:4px">SIMORGH DESIGN SOFTWARE — PROJECT REPORT</div>
      <div style="font-size:20px;font-weight:800">${data.projectName}</div>
      <div style="font-size:12px;opacity:.85;margin-top:4px">${v(data.client)} &nbsp;|&nbsp; ${v(data.location)} &nbsp;|&nbsp; ${v(data.standard)}</div>
    </div>
    <div style="text-align:right;font-size:11px;opacity:.8">
      <div>PID: ${v(data.projectId)}</div><div>OE: ${v(data.projectNumber)}</div>
      <div style="margin-top:4px">${new Date().toLocaleDateString()}</div>
    </div>
  </div>
  <div class="no-print" style="margin-bottom:16px;text-align:right">
    <button onclick="window.print()" style="background:#1e50a2;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">
      🖨&nbsp; Print / Save as PDF
    </button>
  </div>
  ${secHd('01','Project Overview','#1e50a2')}${projTable}
  ${techRows.length>0 ? secHd('02','Technical Settings','#277548')+techTable : ''}
  ${secHd('03','Device Library','#277548')}${devTable}
  ${secHd('04','Equipment & Device Selections','#b45309')}${eqTable}
  ${(() => {
    const usedIds = new Set<string>();
    eqs.forEach(eq => eq.devices?.forEach(d => { if (d.templateId) usedIds.add(d.templateId); }));
    const used = TIERS.flatMap(t => data.templates?.[t] ?? []).filter(t => usedIds.has(t.id));
    if (used.length === 0) return '';
    let html = '<h3 style="margin:18px 0 6px;font-size:13px;color:#b45309;font-weight:700">Template Components Breakdown</h3>';
    for (const tmpl of used) {
      const props = (tmpl.properties ?? {}) as Record<string, any>;
      const displayNames: Record<string, string> = props.__displayNames || {};
      const lockedRows: string[]                  = props.__locked || [];
      const entries = Object.entries(props).filter(
        ([k, val]) => k !== '__displayNames' && k !== '__locked'
          && val && Array.isArray((val as any).parts) && (val as any).parts.length > 0
      );
      html += `<div style="margin:6px 0 12px;border:1px solid #fed7aa;border-radius:4px">
        <div style="background:#fff7ed;padding:4px 10px;font-size:11px;font-weight:700;color:#9a3412">
          ${tmpl.name} <span style="font-weight:500;color:#b45309">[${tmpl.type}]</span>
        </div>`;
      if (entries.length === 0) {
        html += `<div style="padding:6px 10px;font-size:10px;color:#9ca3af;font-style:italic">No parts assigned.</div>`;
      } else {
        html += `<table style="width:100%;border-collapse:collapse;font-size:10px">
          <thead><tr>${['Property','Part Number','Manufacturer','Rating','Label','Qty','Priority']
            .map(h => `<th style="background:#fef3c7;padding:4px 8px;text-align:left;color:#92400e">${h}</th>`).join('')}</tr></thead><tbody>`;
        for (const [propName, propVal] of entries) {
          const label = displayNames[propName] || propName;
          const locked = lockedRows.includes(propName);
          const parts = (propVal as any).parts as any[];
          parts.forEach((part, pi) => {
            html += `<tr>${
              pi === 0
                ? `<td style="padding:3px 8px;border-bottom:1px solid #f3f4f6;font-weight:600${locked ? ';text-decoration:line-through;color:#9ca3af' : ''}" rowspan="${parts.length}">${label}${locked ? ' 🔒' : ''}</td>`
                : ''
            }<td style="padding:3px 8px;border-bottom:1px solid #f3f4f6;font-family:monospace">${v(part.partNumber)}</td>` +
              `<td style="padding:3px 8px;border-bottom:1px solid #f3f4f6">${v(part.fullData?.Manufacturer)}</td>` +
              `<td style="padding:3px 8px;border-bottom:1px solid #f3f4f6">${v(part.fullData?.Designation3)}</td>` +
              `<td style="padding:3px 8px;border-bottom:1px solid #f3f4f6">${v(part.label)}</td>` +
              `<td style="padding:3px 8px;border-bottom:1px solid #f3f4f6;text-align:center">${part.quantity ?? 1}</td>` +
              `<td style="padding:3px 8px;border-bottom:1px solid #f3f4f6;text-align:center">${part.priority ?? 1}</td></tr>`;
          });
        }
        html += '</tbody></table>';
      }
      html += '</div>';
    }
    return html;
  })()}
  <div style="margin-top:30px;border-top:1px solid #e5e7eb;padding-top:10px;font-size:10px;color:#9ca3af;display:flex;justify-content:space-between">
    <span>Simorgh Design Software</span><span>Generated: ${new Date().toLocaleString()}</span>
  </div>
  <script>window.onload=()=>{ window.focus(); window.print(); }<\/script>
  </body></html>`;

  const win = window.open('', '_blank', 'width=1200,height=900');
  if (win) { win.document.write(html); win.document.close(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT: HTML
// ─────────────────────────────────────────────────────────────────────────────
function exportHTML(data: ProjectData) {
  const projRows = buildProjectRows(data);
  const techRows = buildTechRows(data);

  const tableStyle = `
    border-collapse:collapse;width:100%;margin-bottom:24px;font-size:13px;
    box-shadow:0 1px 4px rgba(0,0,0,.1);border-radius:6px;overflow:hidden;
  `;
  const thStyle  = (bg: string) => `background:${bg};color:#fff;padding:8px 12px;text-align:left;font-weight:600;letter-spacing:.3px;`;
  const tdStyle  = `padding:7px 12px;border-bottom:1px solid #eee;`;
  const tdBStyle = `padding:7px 12px;border-bottom:1px solid #eee;font-weight:600;`;
  const altStyle = `background:#f7f9fc;`;

  const kv2rows = (rows: string[][], headerBg: string) =>
    `<table style="${tableStyle}">
      <thead><tr><th style="${thStyle(headerBg)}">Parameter</th><th style="${thStyle(headerBg)}">Value</th></tr></thead>
      <tbody>${rows.map((r, i) => {
        const isSection = r[1] === '';
        if (isSection) return `<tr style="background:#edf2fb"><td colspan="2" style="${tdBStyle}color:#2a5298">${r[0]}</td></tr>`;
        return `<tr style="${i % 2 === 1 ? altStyle : ''}">`
          + `<td style="${tdBStyle}">${r[0]}</td><td style="${tdStyle}">${r[1]}</td></tr>`;
      }).join('')}
      </tbody></table>`;

  const sectionHd = (n: string, title: string, color: string) =>
    `<div style="display:flex;align-items:center;gap:10px;margin:32px 0 10px">
      <span style="background:${color};color:#fff;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700">${n}</span>
      <h2 style="margin:0;font-size:16px;color:#222;font-weight:700">${title}</h2>
     </div>`;

  // Device Library table
  const allDevices = TIERS.flatMap(t => (data.deviceLibrary?.[t] ?? []).map(d => ({ ...d, tier: t })));
  const propKeys = Object.keys(DEVICE_PROP_LABELS);
  const devLibTable = allDevices.length === 0 ? '<p style="color:#888">No devices defined.</p>' :
    `<div style="overflow-x:auto"><table style="${tableStyle}">
      <thead><tr>
        <th style="${thStyle('#277548')}">#</th>
        <th style="${thStyle('#277548')}">Name</th>
        <th style="${thStyle('#277548')}">Type</th>
        ${propKeys.map(k => `<th style="${thStyle('#277548')}">${DEVICE_PROP_LABELS[k]}</th>`).join('')}
      </tr></thead>
      <tbody>${allDevices.map((dev, i) => {
        const p = dev.properties as Record<string, any>;
        return `<tr style="${i % 2 === 1 ? altStyle : ''}">
          <td style="${tdStyle}">${i + 1}</td>
          <td style="${tdBStyle}">${dev.name}</td>
          <td style="${tdStyle}"><span style="background:${dev.tier==='LV'?'#d1fae5':dev.tier==='MV'?'#fde68a':'#fee2e2'};padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700">${dev.tier}</span></td>
          ${propKeys.map(k => `<td style="${tdStyle}">${typeof p[k] === 'boolean' ? boolStr(p[k]) : v(p[k])}</td>`).join('')}
        </tr>`;
      }).join('')}
      </tbody></table></div>`;

  // Equipment & Selections table
  const equipments = data.equipments ?? [];
  const eqTable = equipments.length === 0 ? '<p style="color:#888">No equipment defined.</p>' :
    `<table style="${tableStyle}">
      <thead><tr>
        ${['Equipment','Type','Device (Library)','Row','Template','Bus Section','Feeder No','Wiring Type','Rating Power','FLC (A)']
          .map(h => `<th style="${thStyle('#b45309')}">${h}</th>`).join('')}
      </tr></thead>
      <tbody>${equipments.flatMap((eq, eqi) => {
        const libItemId = eq.properties?.deviceLibraryItemId as string | undefined;
        const libItem   = libItemId
          ? TIERS.flatMap(t => data.deviceLibrary?.[t] ?? []).find(d=>d.id===libItemId)
          : null;
        if (!eq.devices || eq.devices.length === 0) {
          return [`<tr style="${eqi%2===1?altStyle:''}">
            <td style="${tdBStyle}">${eq.name}</td>
            <td style="${tdStyle}">${eq.type}</td>
            <td style="${tdStyle}">${libItem?.name??'—'}</td>
            ${Array(7).fill(`<td style="${tdStyle}">—</td>`).join('')}
          </tr>`];
        }
        return eq.devices.map((row, ri) =>
          `<tr style="${(eqi*100+ri)%2===1?altStyle:''}">
            <td style="${tdBStyle}">${ri===0?eq.name:''}</td>
            <td style="${tdStyle}">${ri===0?eq.type:''}</td>
            <td style="${tdStyle}">${ri===0?(libItem?.name??'—'):''}</td>
            <td style="${tdStyle}">${row.rowNumber}</td>
            <td style="${tdStyle}">${v(row.templateName)}</td>
            <td style="${tdStyle}">${v(row.busSection)}</td>
            <td style="${tdStyle}">${v(row.feederNo)}</td>
            <td style="${tdStyle}">${v(row.wiringType)}</td>
            <td style="${tdStyle}">${v(row.ratingPower)}</td>
            <td style="${tdStyle}">${v(row.flc)}</td>
          </tr>`
        );
      }).join('')}
      </tbody></table>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>${data.projectName} — Project Report</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:'Segoe UI',Arial,sans-serif;margin:0;background:#f3f4f6;color:#1a1a2e}
    .page{max-width:1200px;margin:0 auto;padding:32px 24px}
    @media print{body{background:#fff}.no-print{display:none}.page{max-width:100%;padding:16px}}
  </style>
</head>
<body>
<div class="page">
  <!-- Header -->
  <div style="background:linear-gradient(135deg,#1e50a2 0%,#3b82f6 100%);color:#fff;border-radius:12px;padding:28px 32px;margin-bottom:32px;display:flex;justify-content:space-between;align-items:center">
    <div>
      <div style="font-size:11px;letter-spacing:1px;opacity:.8;margin-bottom:4px">SIMORGH DESIGN SOFTWARE</div>
      <h1 style="margin:0;font-size:24px;font-weight:800">${data.projectName}</h1>
      <div style="margin-top:6px;font-size:13px;opacity:.85">${v(data.client)} &nbsp;|&nbsp; ${v(data.location)} &nbsp;|&nbsp; ${v(data.standard)}</div>
    </div>
    <div style="text-align:right;font-size:12px;opacity:.8">
      <div>Generated: ${new Date().toLocaleString()}</div>
      <div>PID: ${v(data.projectId)} &nbsp; OE: ${v(data.projectNumber)}</div>
    </div>
  </div>

  <!-- Print button -->
  <div class="no-print" style="margin-bottom:24px;text-align:right">
    <button onclick="window.print()" style="background:#1e50a2;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:13px">
      🖨 Print / Save as PDF
    </button>
  </div>

  ${sectionHd('01', 'Project Overview', '#1e50a2')}
  ${kv2rows(projRows, '#1e50a2')}

  ${techRows.length > 0 ? sectionHd('02', 'Technical Settings', '#277548') + kv2rows(techRows, '#277548') : ''}

  ${sectionHd('03', 'Device Library', '#277548')}
  ${devLibTable}

  ${sectionHd('04', 'Equipment &amp; Device Selections', '#b45309')}
  ${eqTable}

  <div style="margin-top:40px;border-top:1px solid #e5e7eb;padding-top:12px;font-size:11px;color:#9ca3af;display:flex;justify-content:space-between">
    <span>Simorgh Design Software — Electrical Engineering Design Platform</span>
    <span>Report date: ${new Date().toLocaleDateString()}</span>
  </div>
</div>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `${data.projectName}_Report.html`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────────────────────
// TIER SECTION — wide equipment × template-property matrix table
// One section per tier (LV → 04, MV → 05) with its own Excel/PDF buttons.
// ─────────────────────────────────────────────────────────────────────────────
interface TierEquipmentSectionProps {
  tier: 'LV' | 'MV';
  badge: string;
  color: string;
  equipments: any[];
  projectData: ProjectData;
}

const TierEquipmentSection: React.FC<TierEquipmentSectionProps> = ({
  tier, badge, color, equipments, projectData,
}) => {
  const [expanded, setExpanded] = useState(true);
  const { headers, rows } = buildTierMatrix(projectData, tier);
  const deviceColCount = (tier === 'LV' ? LV_DEVICE_COLS : MV_DEVICE_COLS).length;
  const propCols = tier === 'LV' ? LV_TEMPLATE_PROPERTIES : MV_TEMPLATE_PROPERTIES;
  const totalRows = rows.length;
  const totalEquipments = equipments.length;

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden mb-3">
      <div className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100">
        <button
          className="flex items-center gap-3 text-left flex-1"
          onClick={() => setExpanded(e => !e)}
        >
          <span className="text-xs font-bold px-2 py-0.5 rounded-full text-white" style={{ background: color }}>{badge}</span>
          <span className="font-medium text-sm text-gray-800">
            {tier} Equipment &amp; Templates ({totalEquipments} units, {totalRows} rows)
          </span>
          {expanded
            ? <ChevronDownIcon className="w-4 h-4 text-gray-400" />
            : <ChevronRightIcon className="w-4 h-4 text-gray-400" />}
        </button>
        <div className="flex gap-2">
          <button
            onClick={() => exportTierExcel(projectData, tier)}
            disabled={totalEquipments === 0}
            className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 text-white rounded text-xs hover:bg-emerald-700 disabled:opacity-50"
            title={`Export ${tier} section to Excel`}
          >
            <FileSpreadsheetIcon className="w-3.5 h-3.5" /> Excel
          </button>
          <button
            onClick={() => exportTierPDF(projectData, tier)}
            disabled={totalEquipments === 0}
            className="flex items-center gap-1 px-3 py-1.5 bg-red-600 text-white rounded text-xs hover:bg-red-700 disabled:opacity-50"
            title={`Export ${tier} section to PDF`}
          >
            <FileTextIcon className="w-3.5 h-3.5" /> PDF
          </button>
        </div>
      </div>

      {expanded && (
        <div className="p-3 border-t border-gray-100 bg-white">
          {totalEquipments === 0 ? (
            <p className="text-sm text-gray-400">No {tier} equipment defined.</p>
          ) : (
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="text-[10px] border-collapse" style={{ minWidth: '1400px' }}>
                <thead className="sticky top-0 z-10">
                  <tr>
                    {headers.map((h, i) => (
                      <th
                        key={h + i}
                        className="px-2 py-1.5 border border-gray-300 text-left whitespace-nowrap font-semibold"
                        style={{
                          background: i === 0 || i <= deviceColCount ? color : '#374151',
                          color: '#fff',
                          minWidth: i === 0 ? '120px' : i <= deviceColCount ? '90px' : '130px',
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, ri) => (
                    <tr key={ri} className={ri % 2 ? 'bg-gray-50' : 'bg-white'}>
                      {r.map((cell, ci) => (
                        <td
                          key={ci}
                          className="px-2 py-1 border border-gray-200 align-top whitespace-pre-wrap"
                          style={{ fontWeight: ci === 0 ? 600 : 400 }}
                        >
                          {String(cell ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-2 text-[10px] text-gray-500">
                {propCols.length} property columns × {totalRows} device rows. Empty cells indicate the row's template doesn't define that property.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN TAB COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export const OutputTypesTab: React.FC = () => {
  const { projectData, currentRevision, isCurrentRevisionEditable } = useProject();
  const [downloading, setDownloading] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['project', 'tech', 'devices', 'equipment']));
  const [showCompareModal, setShowCompareModal] = useState(false);
  const [compareBaseRevision, setCompareBaseRevision] = useState<string>('');
  const [compareTargetRevision, setCompareTargetRevision] = useState<string>('');
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [loadingRevisions, setLoadingRevisions] = useState(false);
  const [diff, setDiff] = useState<RevisionDiff | null>(null);
  const [diffError, setDiffError] = useState<string>('');

  // Load revisions on mount
  React.useEffect(() => {
    loadRevisions();
  }, []);

  const loadRevisions = async () => {
    if (!projectData._id) return;
    try {
      setLoadingRevisions(true);
      const revisionsData = await projectService.getRevisions(projectData._id!);
      setRevisions(revisionsData);
      // Older → newer: the previous revision is the base and the latest the
      // target, so what was added reads as added. Latest-first put them the
      // other way round, and every addition was reported as a removal.
      // A choice already made is kept as long as it still exists.
      const exists = (id: string) => revisionsData.some(r => r._id === id);
      if (revisionsData.length > 1) {
        setCompareBaseRevision(prev => (prev && exists(prev) ? prev : revisionsData[1]._id!));
        setCompareTargetRevision(prev => (prev && exists(prev) ? prev : revisionsData[0]._id!));
      } else if (revisionsData.length === 1) {
        setCompareBaseRevision(prev => (prev && exists(prev) ? prev : revisionsData[0]._id!));
      }
    } catch (err) {
      console.error('Failed to load revisions:', err);
    } finally {
      setLoadingRevisions(false);
    }
  };

  const trigger = async (key: string, fn: () => void) => {
    setDownloading(key);
    await new Promise(r => setTimeout(r, 80)); // let UI update
    try { fn(); } finally { setDownloading(null); }
  };

  const toggleSection = (key: string) =>
    setExpandedSections(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const lib     = projectData.deviceLibrary;
  const devices = TIERS.flatMap(t => lib?.[t] ?? []);
  const eqs     = projectData.equipments ?? [];
  const rowTotal = eqs.reduce((s, eq) => s + (eq.devices?.length ?? 0), 0);

  const revisionById = (id: string) => revisions.find(r => r._id === id);
  const revisionLabel = (r?: Revision) =>
    r ? `REV ${r.revisionNumber}${r.source === 'tpms' ? ' (TPMS)' : ''}` : '—';

  // The comparison is computed here, from the snapshots the revisions carry:
  // a revision holds the whole project as it stood, so two of them can be
  // compared without asking the server for anything.
  const runComparison = () => {
    setDiffError('');
    setDiff(null);
    let base = revisionById(compareBaseRevision);
    let target = revisionById(compareTargetRevision);
    if (!base || !target) { setDiffError('Pick two revisions to compare.'); return; }
    if (base._id === target._id) { setDiffError('Pick two different revisions.'); return; }
    // Always older → newer, whichever way round they were picked.
    const num = (r: Revision) => parseInt(r.revisionNumber, 10) || 0;
    if (num(base) > num(target)) {
      [base, target] = [target, base];
      setCompareBaseRevision(base._id!);
      setCompareTargetRevision(target._id!);
    }
    // The revision being worked on is compared as it is on screen. Its stored
    // snapshot is only as new as the last save, so an edit made a minute ago
    // was missing from the comparison.
    const snapshotOf = (r: Revision) =>
      r._id && currentRevision?._id === r._id && isCurrentRevisionEditable ? projectData : r.projectSnapshot;
    const from = snapshotOf(base);
    const to = snapshotOf(target);
    if (!from || !to) {
      setDiffError('One of these revisions has no snapshot stored, so it cannot be compared.');
      return;
    }
    setDiff(diffProjectSnapshots(from, to));
  };

  const downloadComparison = () => {
    const base = revisionById(compareBaseRevision);
    const target = revisionById(compareTargetRevision);
    if (!diff || !base || !target) return;
    exportDiffExcel(diff, {
      projectName: projectData.projectName,
      base: base.revisionNumber,
      target: target.revisionNumber,
    });
  };

  const Section: React.FC<{ id: string; title: string; badge: string; color: string; children: React.ReactNode }> = ({ id, title, badge, color, children }) => {
    const open = expandedSections.has(id);
    return (
      <div className="border border-gray-200 rounded-lg overflow-hidden mb-3">
        <button
          className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 text-left"
          onClick={() => toggleSection(id)}
        >
          <div className="flex items-center gap-3">
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full text-white`} style={{ background: color }}>{badge}</span>
            <span className="font-medium text-sm text-gray-800">{title}</span>
          </div>
          {open ? <ChevronDownIcon className="w-4 h-4 text-gray-400" /> : <ChevronRightIcon className="w-4 h-4 text-gray-400" />}
        </button>
        {open && <div className="p-4 border-t border-gray-100 bg-white">{children}</div>}
      </div>
    );
  };

  const Row: React.FC<{ label: string; value?: string }> = ({ label, value }) => (
    <div className="flex gap-2 py-1 border-b border-gray-50 text-sm">
      <span className="w-48 text-gray-500 flex-shrink-0">{label}</span>
      <span className="text-gray-800 font-medium">{value || '—'}</span>
    </div>
  );

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-800">Project Report &amp; Export</h2>
          <p className="text-sm text-gray-500 mt-0.5">{projectData.projectName}</p>
        </div>
        {/* Export Buttons */}
        <div className="flex gap-3 items-center">
          <button
            disabled={!!downloading}
            onClick={() => trigger('xlsx', () => exportExcel(projectData))}
            className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-60 shadow-sm font-medium text-sm transition-colors"
          >
            {downloading === 'xlsx'
              ? <span className="animate-spin">⏳</span>
              : <FileSpreadsheetIcon className="w-4 h-4" />}
            Excel (.xlsx)
          </button>
          <button
            disabled={!!downloading}
            onClick={() => trigger('pdf', () => exportPDF(projectData))}
            className="flex items-center gap-2 px-5 py-2.5 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-60 shadow-sm font-medium text-sm transition-colors"
          >
            {downloading === 'pdf'
              ? <span className="animate-spin">⏳</span>
              : <FileTextIcon className="w-4 h-4" />}
            PDF Report
          </button>
          <button
            disabled={!!downloading}
            onClick={() => trigger('html', () => exportHTML(projectData))}
            className="flex items-center gap-2 px-5 py-2.5 bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-60 shadow-sm font-medium text-sm transition-colors"
          >
            {downloading === 'html'
              ? <span className="animate-spin">⏳</span>
              : <FileCode2Icon className="w-4 h-4" />}
            HTML Report
          </button>
          <div className="h-8 w-px bg-gray-300 mx-1"></div>
          <button
            onClick={() => { setShowCompareModal(true); setDiff(null); loadRevisions(); }}
            className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 shadow-sm font-medium text-sm transition-colors"
          >
            🔄 Compare Revisions
          </button>
        </div>
      </div>

      {/* Summary Strip */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        {[
          { label: 'Project',   value: projectData.projectName, color: 'bg-blue-50 border-blue-200 text-blue-700' },
          { label: 'Devices',   value: `${devices.length} in library`, color: 'bg-green-50 border-green-200 text-green-700' },
          { label: 'Equipment', value: `${eqs.length} units`,           color: 'bg-orange-50 border-orange-200 text-orange-700' },
          { label: 'Rows',      value: `${rowTotal} selection rows`,    color: 'bg-purple-50 border-purple-200 text-purple-700' },
        ].map(c => (
          <div key={c.label} className={`border rounded-lg px-4 py-3 ${c.color}`}>
            <div className="text-xs font-semibold uppercase tracking-wide opacity-70">{c.label}</div>
            <div className="text-sm font-bold mt-0.5">{c.value}</div>
          </div>
        ))}
      </div>

      {/* Data Preview */}
      <Section id="project" title="Project Overview" badge="01" color="#1e50a2">
        <div className="grid grid-cols-2 gap-x-8">
          <div>
            <Row label="Project Name"         value={projectData.projectName} />
            <Row label="Project ID (PID)"     value={projectData.projectId} />
            <Row label="Project Number (OE)"  value={projectData.projectNumber} />
            <Row label="Client"               value={projectData.client} />
            <Row label="Location"             value={projectData.location} />
            <Row label="Standard"             value={projectData.standard} />
            <Row label="Country"              value={projectData.country} />
            <Row label="Language"             value={projectData.language} />
          </div>
          <div>
            <Row label="Planner"              value={projectData.planner} />
            <Row label="Design Office"        value={projectData.designOffice} />
            <Row label="Notice to Proceed"    value={projectData.noticeToProceedDate} />
            <Row label="Delivery Date"        value={projectData.deliveryDate} />
            <Row label="Created On"           value={projectData.createdOn} />
            <Row label="Last Modified"        value={projectData.changedOn} />
            <Row label="Description"          value={projectData.projectDescription} />
            <Row label="Comment"              value={projectData.comment} />
          </div>
        </div>
      </Section>

      <Section id="tech" title="Technical Settings" badge="02" color="#277548">
        {!projectData.techSettings
          ? <p className="text-sm text-gray-400">No technical settings defined.</p>
          : (() => {
            const ts = projectData.techSettings!;
            return (
              <div className="grid grid-cols-2 gap-x-8">
                <div>
                  <p className="text-xs font-bold uppercase text-gray-400 mb-2">General</p>
                  <Row label="Altitude (m)"              value={ts.general.altitudeAboveSeaLevel} />
                  <Row label="Design Temperature (°C)"   value={ts.general.designTemperature} />
                  <p className="text-xs font-bold uppercase text-gray-400 mt-3 mb-2">Wire Size *</p>
                  <Row label="Control Circuit"  value={ts.wireSize.controlCircuit} />
                  <Row label="CT Secondary"     value={ts.wireSize.ctSecondary} />
                  <Row label="PT Secondary"     value={ts.wireSize.ptSecondary} />
                  <Row label="PLC Power Supply" value={ts.wireSize.plcPowerSupply} />
                  <p className="text-xs font-bold uppercase text-gray-400 mt-3 mb-2">Wire / Cable Manufacturer *</p>
                  <Row label="LV" value={ts.wireManufacturer.lv} />
                  <Row label="MV" value={ts.wireManufacturer.mv} />
                </div>
                <div>
                  <p className="text-xs font-bold uppercase text-gray-400 mb-2">Wire Color *</p>
                  <Row label="AC Phase"    value={ts.wireColor.acPhase} />
                  <Row label="DC +"        value={ts.wireColor.dcPlus} />
                  <Row label="AC Neutral"  value={ts.wireColor.acNeutral} />
                  <Row label="DC –"        value={ts.wireColor.dcMinus} />
                  <Row label="PLC Input"   value={ts.wireColor.plcInput} />
                  <Row label="PLC Output"  value={ts.wireColor.plcOutput} />
                  <Row label="3 Phase"     value={ts.wireColor.threePhase} />
                  <p className="text-xs font-bold uppercase text-gray-400 mt-3 mb-2">Others</p>
                  <Row label="Thickness of Painting (μm)" value={ts.others.thicknessOfPainting} />
                  <Row label="Color Type"       value={ts.others.colorType} />
                  <Row label="Background Color" value={ts.others.backgroundColor} />
                  <Row label="Writing Color"    value={ts.others.writingColor} />
                </div>
              </div>
            );
          })()
        }
      </Section>

      <Section id="devices" title={`Device Library (${devices.length} devices)`} badge="03" color="#277548">
        {devices.length === 0
          ? <p className="text-sm text-gray-400">No devices defined in library.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-green-700 text-white">
                    <th className="px-3 py-2 text-left">#</th>
                    <th className="px-3 py-2 text-left">Name</th>
                    <th className="px-3 py-2 text-left">Type</th>
                    {Object.values(DEVICE_PROP_LABELS).map(l => <th key={l} className="px-3 py-2 text-left whitespace-nowrap">{l}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {devices.map((dev, i) => {
                    const p = dev.properties as Record<string, any>;
                    const tierColor = TIER_PILL[dev.type as Tier] ?? TIER_PILL.OTHER;
                    return (
                      <tr key={dev.id} className={i % 2 === 1 ? 'bg-gray-50' : 'bg-white'}>
                        <td className="px-3 py-1.5 border-b border-gray-100">{i + 1}</td>
                        <td className="px-3 py-1.5 border-b border-gray-100 font-semibold">{dev.name}</td>
                        <td className="px-3 py-1.5 border-b border-gray-100">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${tierColor}`}>{dev.type}</span>
                        </td>
                        {Object.keys(DEVICE_PROP_LABELS).map(k => (
                          <td key={k} className="px-3 py-1.5 border-b border-gray-100 whitespace-nowrap">
                            {typeof p[k] === 'boolean' ? boolStr(p[k]) : v(p[k])}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        }
      </Section>

      {/* ── BPMS export — one switchgear at a time, LV and MV ───────────── */}
      <BpmsSection
        projectData={projectData}
        revisionNumber={currentRevision?.revisionNumber}
        downloading={downloading}
        trigger={trigger}
      />

      {/* The single line, the layout and the mechanical items live in their
          own tab now — Simorgh Draw — where each one is previewed before it is
          downloaded. */}
      <div className="border border-gray-200 rounded-lg mb-3 px-4 py-3 flex items-center gap-3 bg-blue-50/40">
        <span className="text-xs font-bold px-2 py-0.5 rounded-full text-white bg-blue-700">SIMORGH DRAW</span>
        <p className="text-sm text-gray-700">
          Single line, panel layout and mechanical items have moved to the <strong>Simorgh Draw</strong> tab.
        </p>
        <span className="text-sm text-gray-600 ml-auto" dir="rtl">
          Single line, panel layout and mechanical items have moved to the Simorgh Draw tab.
        </span>
      </div>

      {/* ── Section 04: LV Equipment & Template Matrix ─────────────────────
          Wide table — every row is one device-row from an LV equipment, and
          every template property becomes its own column. Empty cells mean
          that row's template doesn't define that property. */}
      <TierEquipmentSection
        tier="LV"
        badge="04"
        color="#065f46"
        equipments={eqs.filter(e => LAYOUT_OF[e.type] === 'LV')}
        projectData={projectData}
      />

      {/* ── Section 05: MV Equipment & Template Matrix ───────────────────── */}
      <TierEquipmentSection
        tier="MV"
        badge="05"
        color="#92400e"
        equipments={eqs.filter(e => LAYOUT_OF[e.type] === 'MV')}
        projectData={projectData}
      />

      {/* (HV equipment breakdown intentionally omitted — covered by the full
          Excel/PDF export buttons at the top.) */}

      <div className="mt-4 flex items-center gap-2 text-xs text-gray-400">
        <CheckCircleIcon className="w-3.5 h-3.5 text-green-500" />
        All three formats contain identical data — Project Overview, Technical Settings, Device Library, and Equipment & Selections.
        <DownloadIcon className="w-3.5 h-3.5 ml-2" />
        HTML report includes a "Print / Save as PDF" button for browser-based PDF export.
      </div>

      {/* Compare revisions — for a TPMS project these are TPMS's own
          revisions, so this is where its changes are read. */}
      {showCompareModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-6">
          <div className="bg-white rounded-lg shadow-2xl w-[900px] max-w-full max-h-[88vh] flex flex-col">
            <div className="px-6 py-4 border-b">
              <h3 className="font-semibold text-lg">Compare revisions</h3>
              <p className="text-xs text-gray-500 mt-1">
                What changed between two revisions of this project — master data, technical settings,
                panel specifications, feeder lines and the parts on their templates.
                {projectData.tpmsSync
                  ? ' The revisions marked TPMS are the revisions TPMS holds, so this is also how TPMS changes are read.'
                  : ''}
              </p>
            </div>

            <div className="px-6 py-4 border-b bg-gray-50 grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Base revision</label>
                <select
                  value={compareBaseRevision}
                  onChange={e => { setCompareBaseRevision(e.target.value); setDiff(null); }}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                  disabled={loadingRevisions}
                >
                  <option value="">Select…</option>
                  {revisions.map((rev, idx) => (
                    <option key={rev._id || idx} value={rev._id}>
                      {revisionLabel(rev)} — {rev.revisionName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Compare with</label>
                <select
                  value={compareTargetRevision}
                  onChange={e => { setCompareTargetRevision(e.target.value); setDiff(null); }}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                  disabled={loadingRevisions}
                >
                  <option value="">Select…</option>
                  {revisions.map((rev, idx) => (
                    <option key={rev._id || idx} value={rev._id}>
                      {revisionLabel(rev)} — {rev.revisionName}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
              {diffError && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded mb-3">{diffError}</div>
              )}

              {!diff && !diffError && (
                <p className="text-sm text-gray-500">Pick two revisions and press Compare.</p>
              )}

              {diff && (
                <div className="space-y-4">
                  <div className="flex gap-3 text-sm">
                    <span className="px-2 py-1 rounded bg-green-100 text-green-800">{diff.totals.added} added</span>
                    <span className="px-2 py-1 rounded bg-red-100 text-red-800">{diff.totals.removed} removed</span>
                    <span className="px-2 py-1 rounded bg-amber-100 text-amber-800">{diff.totals.changed} changed</span>
                  </div>

                  {diff.isEmpty && (
                    <p className="text-sm text-gray-600">These two revisions are identical.</p>
                  )}

                  {(diff.project.length > 0 || diff.techSettings.length > 0) && (
                    <div className="border rounded">
                      <div className="px-3 py-2 bg-gray-50 border-b text-sm font-medium">Project &amp; technical settings</div>
                      <table className="w-full text-sm">
                        <tbody>
                          {[...diff.project, ...diff.techSettings].map((c, i) => (
                            <tr key={i} className="border-t border-gray-100">
                              <td className="px-3 py-1.5 text-gray-600 w-56">{c.field}</td>
                              <td className="px-3 py-1.5 text-red-700 line-through">{c.from || '—'}</td>
                              <td className="px-3 py-1.5 text-green-700">{c.to || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {diff.equipments.map(eq => (
                    <div key={`${eq.type}-${eq.name}`} className="border rounded">
                      <div className="px-3 py-2 bg-gray-50 border-b text-sm flex items-center gap-2">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                          TIER_PILL[eq.type as Tier] ?? TIER_PILL.OTHER}`}>{eq.type}</span>
                        <span className="font-medium">{eq.name}</span>
                        {eq.kind !== 'changed' && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                            eq.kind === 'added' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                            {eq.kind}
                          </span>
                        )}
                        <span className="text-gray-500 ml-auto">
                          {eq.counts.added} added · {eq.counts.removed} removed · {eq.counts.changed} changed
                          {eq.panel.length > 0 ? ` · ${eq.panel.length} panel field(s)` : ''}
                        </span>
                      </div>
                      <table className="w-full text-sm">
                        <tbody>
                          {eq.panel.map((c, i) => (
                            <tr key={`p${i}`} className="border-t border-gray-100 bg-amber-50/40">
                              <td className="px-3 py-1.5 text-gray-500 w-28">panel</td>
                              <td className="px-3 py-1.5 text-gray-700 w-48">{c.field}</td>
                              <td className="px-3 py-1.5 text-red-700 line-through">{c.from || '—'}</td>
                              <td className="px-3 py-1.5 text-green-700">{c.to || '—'}</td>
                            </tr>
                          ))}
                          {eq.lines.map(line => (
                            <React.Fragment key={line.key}>
                              <tr className="border-t border-gray-200">
                                <td className="px-3 py-1.5 w-28">
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                                    line.kind === 'added' ? 'bg-green-100 text-green-700'
                                    : line.kind === 'removed' ? 'bg-red-100 text-red-700'
                                    : 'bg-amber-100 text-amber-700'}`}>{line.kind}</span>
                                </td>
                                <td className="px-3 py-1.5 font-medium text-gray-800" colSpan={3}>
                                  {line.feederNo || line.key}
                                  {line.description ? <span className="text-gray-500 font-normal"> — {line.description}</span> : null}
                                </td>
                              </tr>
                              {line.kind === 'changed' && line.changes.map((c, i) => (
                                <tr key={`${line.key}-${i}`} className="border-t border-gray-50">
                                  <td className="px-3 py-1"></td>
                                  <td className="px-3 py-1 text-gray-600 w-48">{c.field}</td>
                                  <td className="px-3 py-1 text-red-700 line-through">{c.from || '—'}</td>
                                  <td className="px-3 py-1 text-green-700">{c.to || '—'}</td>
                                </tr>
                              ))}
                            </React.Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}

                  {diff.templates.length > 0 && (
                    <div className="border rounded">
                      <div className="px-3 py-2 bg-gray-50 border-b text-sm font-medium">Templates</div>
                      <table className="w-full text-sm">
                        <tbody>
                          {diff.templates.map(t => (
                            <React.Fragment key={`${t.type}-${t.name}`}>
                              <tr className="border-t border-gray-200">
                                <td className="px-3 py-1.5 w-28">
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                                    t.kind === 'added' ? 'bg-green-100 text-green-700'
                                    : t.kind === 'removed' ? 'bg-red-100 text-red-700'
                                    : 'bg-amber-100 text-amber-700'}`}>{t.kind}</span>
                                </td>
                                <td className="px-3 py-1.5 font-medium text-gray-800" colSpan={3}>
                                  {t.name} <span className="text-gray-400">({t.type})</span>
                                </td>
                              </tr>
                              {t.changes.map((c, i) => (
                                <tr key={`${t.name}-${i}`} className="border-t border-gray-50">
                                  <td className="px-3 py-1"></td>
                                  <td className="px-3 py-1 text-gray-600 w-48">{c.field}</td>
                                  <td className="px-3 py-1 text-red-700 line-through whitespace-pre-wrap">{c.from || '—'}</td>
                                  <td className="px-3 py-1 text-green-700 whitespace-pre-wrap">{c.to || '—'}</td>
                                </tr>
                              ))}
                            </React.Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex justify-between gap-2 px-6 py-4 border-t bg-gray-50">
              <button
                className="px-4 py-2 border rounded text-sm hover:bg-gray-100"
                onClick={() => { setShowCompareModal(false); setDiff(null); setDiffError(''); }}
              >
                Close
              </button>
              <div className="flex gap-2">
                <button
                  className="px-4 py-2 border border-emerald-300 text-emerald-800 rounded text-sm hover:bg-emerald-50 disabled:opacity-40"
                  disabled={!diff}
                  onClick={downloadComparison}
                >
                  Excel (.xlsx)
                </button>
                <button
                  className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
                  disabled={!compareBaseRevision || !compareTargetRevision}
                  onClick={runComparison}
                >
                  Compare
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
