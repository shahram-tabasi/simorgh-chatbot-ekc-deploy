import React, { useState } from 'react';
import * as XLSX from 'xlsx';
import { useProject } from '../../context/ProjectContext';
import {
  FileSpreadsheetIcon, FileTextIcon, FileCode2Icon,
  DownloadIcon, CheckCircleIcon, ChevronDownIcon, ChevronRightIcon
} from 'lucide-react';
import { ProjectData } from '../../types/project';

// ── Human-readable labels for DeviceLibraryProperties fields ──
const DEVICE_PROP_LABELS: Record<string, string> = {
  frequency:                                    'Frequency',
  mainBusbarConfiguration:                      'Main Busbar Configuration',
  mainBusbarRatedCurrent:                       'Main Busbar Rated Current (A)',
  ratedShortTimeWithstandCurrent:               'Rated Short Time Withstand Current (kA)',
  isc:                                          'ISC (kA)',
  height:                                       'Height (mm)',
  width:                                        'Width (mm)',
  depth:                                        'Depth (mm)',
  ratedImpulseWithstandVoltage:                 'Rated Impulse Withstand Voltage (kV)',
  controlProtectionClosingTrippingSignalling:   'Control / Protection / Closing / Tripping / Signalling',
  ratedInsulationVoltage:                       'Rated Insulation Voltage (V)',
  serviceVoltage:                               'Service Voltage',
  springChargingMotor:                          'Spring Charging Motor',
  switchgearLightingSpaceHeater:                'Switchgear Lighting / Space Heater',
  motorsSpaceHeater:                            'Motors Space Heater',
  ratedPowerFrequencyWithstandVoltage:          'Rated Power Frequency Withstand Voltage',
  mainBusbarSize:                               'Main Busbar Size',
  earthBusbarSize:                              'Earth Busbar Size',
  neutralBusbarSize:                            'Neutral Busbar Size',
  ral:                                          'RAL',
  incomingConnection:                           'Incoming Connection',
  outgoingConnection:                           'Outgoing Connection',
  ip:                                           'IP Rating',
  switchgearAccess:                             'Switchgear Access',
  switchgearArrangement:                        'Switchgear Arrangement',
  busbarType:                                   'Busbar Type',
  thermoFitCover:                               'Thermo-Fit Cover',
  coating:                                      'Coating',
  padLockCbOnOff:                               'Pad Lock CB On / Off',
  padLockCbTestService:                         'Pad Lock CB Test / Service',
  padLockHvDoor:                                'Pad Lock HV Door',
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const v = (val: any) => (val == null || val === '' ? '—' : String(val));
const boolStr = (val: any) => (val ? '✓' : '—');

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
  for (const tier of ['LV', 'MV', 'HV'] as const) {
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
      ? [...(data.deviceLibrary?.LV ?? []), ...(data.deviceLibrary?.MV ?? []), ...(data.deviceLibrary?.HV ?? [])].find(d => d.id === libItemId)
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

  XLSX.writeFile(wb, `${data.projectName}_Report.xlsx`);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT: PDF  (via browser print-to-PDF — no external library needed)
// Opens a styled print-ready window; user clicks Print → Save as PDF
// ─────────────────────────────────────────────────────────────────────────────
function exportPDF(data: ProjectData) {
  const propKeys  = Object.keys(DEVICE_PROP_LABELS);
  const allDevices = [
    ...(data.deviceLibrary?.LV ?? []).map(d => ({ ...d, tier: 'LV' })),
    ...(data.deviceLibrary?.MV ?? []).map(d => ({ ...d, tier: 'MV' })),
    ...(data.deviceLibrary?.HV ?? []).map(d => ({ ...d, tier: 'HV' })),
  ];

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
  const allLib = [...(data.deviceLibrary?.LV??[]),...(data.deviceLibrary?.MV??[]),...(data.deviceLibrary?.HV??[])];
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
  const allDevices = [
    ...(data.deviceLibrary?.LV ?? []).map(d => ({ ...d, tier: 'LV' })),
    ...(data.deviceLibrary?.MV ?? []).map(d => ({ ...d, tier: 'MV' })),
    ...(data.deviceLibrary?.HV ?? []).map(d => ({ ...d, tier: 'HV' })),
  ];
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
          ? [...(data.deviceLibrary?.LV??[]),...(data.deviceLibrary?.MV??[]),...(data.deviceLibrary?.HV??[])].find(d=>d.id===libItemId)
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
// MAIN TAB COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export const OutputTypesTab: React.FC = () => {
  const { projectData } = useProject();
  const [downloading, setDownloading] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['project', 'tech', 'devices', 'equipment']));

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
  const devices = [...(lib?.LV ?? []), ...(lib?.MV ?? []), ...(lib?.HV ?? [])];
  const eqs     = projectData.equipments ?? [];
  const rowTotal = eqs.reduce((s, eq) => s + (eq.devices?.length ?? 0), 0);

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
        <div className="flex gap-3">
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
                    const tierColor = dev.type === 'LV' ? 'bg-green-100 text-green-800' : dev.type === 'MV' ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800';
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

      <Section id="equipment" title={`Equipment & Device Selections (${eqs.length} units, ${rowTotal} rows)`} badge="04" color="#b45309">
        {eqs.length === 0
          ? <p className="text-sm text-gray-400">No equipment defined.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-orange-700 text-white">
                    {['Equipment','Type','Device (Library)','Row','Template','Bus Section','Feeder No','Wiring Type','Rating Power','FLC (A)']
                      .map(h => <th key={h} className="px-3 py-2 text-left whitespace-nowrap">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {eqs.flatMap((eq, eqi) => {
                    const libItemId = eq.properties?.deviceLibraryItemId as string | undefined;
                    const libItem   = libItemId
                      ? [...(lib?.LV??[]),...(lib?.MV??[]),...(lib?.HV??[])].find(d=>d.id===libItemId)
                      : null;
                    const rowBg = eqi % 2 === 1 ? 'bg-orange-50' : 'bg-white';
                    if (!eq.devices || eq.devices.length === 0) {
                      return [(
                        <tr key={eq.id} className={rowBg}>
                          <td className="px-3 py-1.5 border-b font-semibold">{eq.name}</td>
                          <td className="px-3 py-1.5 border-b">{eq.type}</td>
                          <td className="px-3 py-1.5 border-b">{libItem?.name ?? '—'}</td>
                          {Array(7).fill(null).map((_, i) => <td key={i} className="px-3 py-1.5 border-b text-gray-400">—</td>)}
                        </tr>
                      )];
                    }
                    return eq.devices.map((row, ri) => (
                      <tr key={row.id} className={rowBg}>
                        <td className="px-3 py-1.5 border-b font-semibold">{ri === 0 ? eq.name : ''}</td>
                        <td className="px-3 py-1.5 border-b">{ri === 0 ? eq.type : ''}</td>
                        <td className="px-3 py-1.5 border-b">{ri === 0 ? (libItem?.name ?? '—') : ''}</td>
                        <td className="px-3 py-1.5 border-b">{row.rowNumber}</td>
                        <td className="px-3 py-1.5 border-b">{v(row.templateName)}</td>
                        <td className="px-3 py-1.5 border-b">{v(row.busSection)}</td>
                        <td className="px-3 py-1.5 border-b">{v(row.feederNo)}</td>
                        <td className="px-3 py-1.5 border-b">{v(row.wiringType)}</td>
                        <td className="px-3 py-1.5 border-b">{v(row.ratingPower)}</td>
                        <td className="px-3 py-1.5 border-b">{v(row.flc)}</td>
                      </tr>
                    ));
                  })}
                </tbody>
              </table>
            </div>
          )
        }
      </Section>

      <div className="mt-4 flex items-center gap-2 text-xs text-gray-400">
        <CheckCircleIcon className="w-3.5 h-3.5 text-green-500" />
        All three formats contain identical data — Project Overview, Technical Settings, Device Library, and Equipment & Selections.
        <DownloadIcon className="w-3.5 h-3.5 ml-2" />
        HTML report includes a "Print / Save as PDF" button for browser-based PDF export.
      </div>
    </div>
  );
};
