// src/utils/eplanSingleLine.ts
//
// The single-line side of a project: what EPLAN needs to draw it, and a
// schematic drawing of it for review.
//
// Two outputs, from the same data (Device Selection rows + the templates
// behind them):
//
//   buildEplanRows()      one row per device on a feeder, in the column order
//                         EPLAN's device-list import reads — page, device tag,
//                         function text, part number, location. This is the
//                         file that goes into EPLAN.
//   buildSingleLineSvg()  the same lines drawn as a single-line diagram: a
//                         busbar with one branch per feeder, the devices on it
//                         in slot order. For reading and checking, not a
//                         substitute for the EPLAN drawing.
import { ProjectData, Equipment, TemplateItem } from '../types/project';
import {
  templateParts, formatPartEntry, stripLocaleTags, getEplanixValue,
  LV_TEMPLATE_PROPERTIES, MV_TEMPLATE_PROPERTIES,
} from './tierEquipmentMatrix';

export const EPLAN_HEADERS = [
  'Page', 'Higher-level function', 'Location', 'DT', 'Function text',
  'Part number', 'Type number', 'Manufacturer', 'Quantity',
  'Feeder no.', 'Bus section', 'Template', 'Slot', 'Description',
];

// The device tag letter EPLAN uses for a slot, when the part itself carries
// none. The part's own label wins — TPMS already stores Q, K, F, T…
const SLOT_LETTER: Record<string, string> = {
  'CB ORDER': 'Q', 'VCB OR VC/FUSE': 'Q', 'CONTACTOR. ORDER': 'K',
  'OVER LOAD RELAY': 'F', 'EARTH FAULT': 'F', 'PROTECTION RELAY': 'F',
  'COREBALANCE CT': 'T', 'CT RATING': 'T', 'PT RATING': 'T',
  'AMMETER': 'P', 'VOLTMETER': 'P', 'MULTIMETER': 'P', 'TRANSDUSER': 'P',
  'AMMETER selector': 'S', 'VOLTMETER selector': 'S',
  'TEST BLOCK': 'X', 'ALARM ANUNCIATOR': 'H', 'ALARM WINDDOW': 'H',
  'VOLTAGE INDICATOR': 'H', 'SURGE ARRESTER': 'F', 'ACCESSORY': 'A',
};

const text = (v: any) => (v == null ? '' : String(v).trim());

const propertyOrder = (tier: 'LV' | 'MV' | 'HV') =>
  tier === 'MV' ? MV_TEMPLATE_PROPERTIES : LV_TEMPLATE_PROPERTIES;

/** One row per device on a feeder line, ready for EPLAN's device-list import. */
export function buildEplanRows(
  data: ProjectData,
  equipment: Equipment,
): (string | number)[][] {
  const templates = new Map(
    [...(data.templates?.[equipment.type] ?? [])].map(t => [t.id, t as TemplateItem]));
  const order = propertyOrder(equipment.type);
  const rows: (string | number)[][] = [];
  const project = text(data.projectName) || 'PROJECT';

  (equipment.devices ?? []).forEach((line, index) => {
    const page = index + 1;
    const template = line.templateId ? templates.get(line.templateId) : undefined;
    const parts = template ? templateParts(template) : {};
    // Slots the template actually fills, in the order the tier lays them out;
    // anything unexpected still comes through, after the known ones.
    const slots = [
      ...order.filter(p => parts[p]?.length),
      ...Object.keys(parts).filter(p => !order.includes(p)),
    ];

    const counters: Record<string, number> = {};
    let wrote = false;

    for (const slot of slots) {
      for (const part of parts[slot]) {
        const label = stripLocaleTags(part?.label) || SLOT_LETTER[slot] || 'A';
        counters[label] = (counters[label] ?? 0) + 1;
        const dt = `-${label}${page}${counters[label] > 1 ? `.${counters[label]}` : ''}`;
        rows.push([
          page,
          `=${project}`,
          `+${equipment.name}${text(line.moduleNo) ? `.${text(line.moduleNo)}` : ''}`,
          dt,
          stripLocaleTags(part?.fullData?.Designation1) || slot,
          getEplanixValue(part?.fullData),
          stripLocaleTags(part?.fullData?.TypeNumber),
          stripLocaleTags(part?.fullData?.Manufacturer),
          part?.quantity ?? 1,
          text(line.feederNo),
          text(line.busSection),
          text(line.templateName),
          slot,
          text(line.description),
        ]);
        wrote = true;
      }
    }

    // A line with no parts yet still deserves its page, so the drawing set and
    // the table stay the same length.
    if (!wrote) {
      rows.push([
        page, `=${project}`, `+${equipment.name}`, '', '', '', '', '', 0,
        text(line.feederNo), text(line.busSection), text(line.templateName), '',
        text(line.description),
      ]);
    }
  });

  return rows;
}

// ── The drawing ──────────────────────────────────────────────────────────────

type Symbol = 'breaker' | 'contactor' | 'overload' | 'ct' | 'pt' | 'meter'
            | 'relay' | 'arrester' | 'fuse' | 'box';

// Which symbol stands for a slot. Anything not named here is drawn as a plain
// box carrying its code, which is honest: the part is on the line, and the
// drawing does not pretend to know its schematic shape.
const SLOT_SYMBOL: Record<string, Symbol> = {
  'CB ORDER': 'breaker', 'VCB OR VC/FUSE': 'breaker',
  'CONTACTOR. ORDER': 'contactor',
  'OVER LOAD RELAY': 'overload',
  'CT RATING': 'ct', 'COREBALANCE CT': 'ct', 'PT RATING': 'pt',
  'AMMETER': 'meter', 'VOLTMETER': 'meter', 'MULTIMETER': 'meter', 'TRANSDUSER': 'meter',
  'PROTECTION RELAY': 'relay', 'EARTH FAULT': 'relay',
  'SURGE ARRESTER': 'arrester',
  'TEST BLOCK': 'box', 'ACCESSORY': 'box',
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function drawSymbol(kind: Symbol, x: number, y: number, code: string): string {
  const g: string[] = [];
  // Branches stand one column apart, so a long code is clipped to what fits
  // beside its symbol and carries the whole of itself in a tooltip.
  const shown = code.length > 20 ? `${code.slice(0, 19)}…` : code;
  const label = `<text x="${x + 26}" y="${y + 16}" font-size="9" fill="#111">` +
    `<title>${esc(code)}</title>${esc(shown)}</text>`;
  switch (kind) {
    case 'breaker':
      g.push(`<rect x="${x - 9}" y="${y}" width="18" height="26" fill="#fff" stroke="#111" stroke-width="1.4"/>`);
      g.push(`<line x1="${x - 6}" y1="${y + 4}" x2="${x + 6}" y2="${y + 22}" stroke="#111" stroke-width="1.4"/>`);
      g.push(`<line x1="${x + 6}" y1="${y + 4}" x2="${x - 6}" y2="${y + 22}" stroke="#111" stroke-width="1.4"/>`);
      break;
    case 'contactor':
      g.push(`<line x1="${x}" y1="${y}" x2="${x}" y2="${y + 8}" stroke="#111" stroke-width="1.2"/>`);
      g.push(`<line x1="${x}" y1="${y + 8}" x2="${x + 11}" y2="${y + 20}" stroke="#111" stroke-width="1.4"/>`);
      g.push(`<path d="M ${x - 6} ${y + 20} a 6 6 0 0 0 12 0" fill="none" stroke="#111" stroke-width="1.2"/>`);
      g.push(`<line x1="${x}" y1="${y + 20}" x2="${x}" y2="${y + 26}" stroke="#111" stroke-width="1.2"/>`);
      break;
    case 'overload':
      g.push(`<rect x="${x - 8}" y="${y + 3}" width="16" height="20" fill="#fff" stroke="#111" stroke-width="1.3"/>`);
      g.push(`<path d="M ${x - 4} ${y + 8} q 4 5 0 10" fill="none" stroke="#111" stroke-width="1.3"/>`);
      break;
    case 'ct':
    case 'pt':
      g.push(`<circle cx="${x + 8}" cy="${y + 13}" r="7" fill="#fff" stroke="#111" stroke-width="1.3"/>`);
      g.push(`<line x1="${x}" y1="${y}" x2="${x}" y2="${y + 26}" stroke="#111" stroke-width="1.2"/>`);
      break;
    case 'meter':
      g.push(`<circle cx="${x}" cy="${y + 13}" r="9" fill="#fff" stroke="#111" stroke-width="1.3"/>`);
      g.push(`<text x="${x}" y="${y + 17}" font-size="9" text-anchor="middle" fill="#111">${esc(code.slice(0, 1) || 'M')}</text>`);
      break;
    case 'relay':
      g.push(`<rect x="${x - 10}" y="${y + 2}" width="20" height="22" fill="#fff" stroke="#111" stroke-width="1.3"/>`);
      g.push(`<text x="${x}" y="${y + 17}" font-size="8" text-anchor="middle" fill="#111">F</text>`);
      break;
    case 'arrester':
      g.push(`<rect x="${x - 7}" y="${y + 3}" width="14" height="20" fill="#fff" stroke="#111" stroke-width="1.3"/>`);
      g.push(`<line x1="${x - 4}" y1="${y + 8}" x2="${x + 4}" y2="${y + 18}" stroke="#111" stroke-width="1.3"/>`);
      break;
    case 'fuse':
      g.push(`<rect x="${x - 6}" y="${y + 3}" width="12" height="20" fill="#fff" stroke="#111" stroke-width="1.3"/>`);
      break;
    default:
      g.push(`<rect x="${x - 9}" y="${y + 5}" width="18" height="16" fill="#fff" stroke="#111" stroke-width="1.1" stroke-dasharray="3 2"/>`);
  }
  return g.join('') + label;
}

/**
 * The switchgear drawn as a single line: a busbar across the top, one branch
 * per feeder, the devices of that feeder in slot order down the branch, and
 * the feeder's identity at the foot.
 */
export function buildSingleLineSvg(data: ProjectData, equipment: Equipment): string {
  const templates = new Map(
    [...(data.templates?.[equipment.type] ?? [])].map(t => [t.id, t as TemplateItem]));
  const order = propertyOrder(equipment.type);
  const lines = equipment.devices ?? [];

  const colWidth = 160;
  const top = 70;
  const stepY = 46;
  const maxDevices = Math.max(
    1,
    ...lines.map(l => {
      const t = l.templateId ? templates.get(l.templateId) : undefined;
      const parts = t ? templateParts(t) : {};
      return Object.values(parts).reduce((n, p) => n + p.length, 0);
    }));
  const height = top + maxDevices * stepY + 150;
  const width = Math.max(700, lines.length * colWidth + 80);

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Segoe UI, Arial, sans-serif">`);
  out.push(`<rect width="${width}" height="${height}" fill="#fff"/>`);

  // Busbar
  out.push(`<line x1="30" y1="${top - 26}" x2="${width - 30}" y2="${top - 26}" stroke="#111" stroke-width="4"/>`);
  out.push(`<text x="30" y="${top - 34}" font-size="11" font-weight="600" fill="#111">${esc(equipment.name)} — busbar</text>`);

  lines.forEach((line, i) => {
    const x = 60 + i * colWidth;
    const template = line.templateId ? templates.get(line.templateId) : undefined;
    const parts = template ? templateParts(template) : {};
    const slots = [
      ...order.filter(p => parts[p]?.length),
      ...Object.keys(parts).filter(p => !order.includes(p)),
    ];

    let y = top;
    out.push(`<line x1="${x}" y1="${top - 26}" x2="${x}" y2="${y}" stroke="#111" stroke-width="1.2"/>`);
    for (const slot of slots) {
      for (const part of parts[slot]) {
        out.push(`<line x1="${x}" y1="${y - 6}" x2="${x}" y2="${y}" stroke="#111" stroke-width="1.2"/>`);
        out.push(drawSymbol(SLOT_SYMBOL[slot] ?? 'box', x, y, formatPartEntry(part)));
        y += stepY;
      }
    }
    // The load at the foot: a motor when the line says so, otherwise an arrow.
    const isMotor = /^m/i.test(String(line.wiringType || '')) || /motor|pump|fan/i.test(String(line.description || ''));
    out.push(`<line x1="${x}" y1="${y - 20}" x2="${x}" y2="${y + 6}" stroke="#111" stroke-width="1.2"/>`);
    if (isMotor) {
      out.push(`<circle cx="${x}" cy="${y + 18}" r="12" fill="#fff" stroke="#111" stroke-width="1.4"/>`);
      out.push(`<text x="${x}" y="${y + 22}" font-size="10" text-anchor="middle" fill="#111">M</text>`);
    } else {
      out.push(`<path d="M ${x - 6} ${y + 8} L ${x} ${y + 20} L ${x + 6} ${y + 8} Z" fill="#111"/>`);
    }

    const foot = y + 44;
    out.push(`<text x="${x - 40}" y="${foot}" font-size="10" font-weight="700" fill="#111">${esc(String(line.feederNo || '—'))}</text>`);
    out.push(`<text x="${x - 40}" y="${foot + 13}" font-size="9" fill="#444">${esc(String(line.description || ''))}</text>`);
    out.push(`<text x="${x - 40}" y="${foot + 26}" font-size="9" fill="#666">${esc([line.ratingPower && `${line.ratingPower} kW`, line.flc && `${line.flc} A`, line.cableSize].filter(Boolean).join(' · '))}</text>`);
    out.push(`<text x="${x - 40}" y="${foot + 39}" font-size="9" fill="#666">${esc([line.busSection && `BUS ${line.busSection}`, line.size, line.moduleNo && `M${line.moduleNo}`].filter(Boolean).join(' · '))}</text>`);
  });

  out.push('</svg>');
  return out.join('\n');
}

/** A print-ready page: one single-line diagram per switchgear. */
export function buildSingleLineHtml(data: ProjectData, equipments: Equipment[]): string {
  const pages = equipments.map(eq => `
    <section style="page-break-after:always;padding:10px 0">
      <div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #111;padding-bottom:6px;margin-bottom:10px">
        <div>
          <div style="font-size:9px;letter-spacing:.8px;color:#666">SINGLE LINE DIAGRAM — ${esc(data.projectName || '')}</div>
          <div style="font-size:16px;font-weight:800">${esc(eq.name)} <span style="font-size:11px;font-weight:500;color:#666">${esc(eq.type)} · ${(eq.devices ?? []).length} feeders</span></div>
        </div>
        <div style="font-size:10px;color:#666">${new Date().toLocaleString()}</div>
      </div>
      <div style="overflow-x:auto">${buildSingleLineSvg(data, eq)}</div>
    </section>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>${esc(data.projectName || 'Project')} — Single line</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,sans-serif;background:#fff;color:#111;padding:14px}
  @page{size:A3 landscape;margin:8mm}
  @media print{.no-print{display:none}body{padding:0}}
</style></head><body>
<button class="no-print" onclick="window.print()" style="margin-bottom:10px;padding:8px 14px;background:#1d4ed8;color:#fff;border:0;border-radius:6px;cursor:pointer">Print / Save as PDF</button>
${pages}
</body></html>`;
}
