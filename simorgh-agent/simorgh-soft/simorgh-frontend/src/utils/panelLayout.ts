// src/utils/panelLayout.ts
//
// Layout (جانمایی): where each feeder sits in the switchgear.
//
// The data says it already. MODULE NO. is "column.position" — 2.6 is the sixth
// position of the second column — and SIZE is how tall the feeder is, in
// modules for LV (10M) or in cells for MV (1C). Read together they are the
// front elevation of the panel, which is what this builds: per column, the
// feeders stacked in position order, each as tall as its size.
//
// Nothing is assumed about module heights or cabinet internals: the column
// height is the tallest column in the project's own data, and the cabinet
// dimensions come from the Device Library entry for that switchgear.
import { ProjectData, Equipment, DeviceTableRow, DeviceLibraryProperties } from '../types/project';

export interface LayoutSlot {
  row: DeviceTableRow;
  column: number;
  position: number;
  modules: number;
  /** Where it ends up once the column is stacked in position order. */
  offset: number;
}

export interface LayoutColumn {
  column: number;
  slots: LayoutSlot[];
  modules: number;
}

export interface PanelLayout {
  equipment: Equipment;
  columns: LayoutColumn[];
  spec: DeviceLibraryProperties;
  /** The tallest column, in modules — what the drawing is scaled to. */
  tallest: number;
  /** Cell count as TPMS states it for this switchgear, when it does. */
  statedCells: string;
  unit: 'M' | 'C';
}

const text = (v: any) => (v == null ? '' : String(v).trim());

/** "10M" → 10, "1C" → 1, "6" → 6, "" → 1. */
export function parseSize(size: any): { modules: number; unit: 'M' | 'C' | '' } {
  const s = text(size).toUpperCase();
  const m = s.match(/(\d+(?:\.\d+)?)\s*([MC])?/);
  if (!m) return { modules: 1, unit: '' };
  const value = Number(m[1]);
  return { modules: Number.isFinite(value) && value > 0 ? value : 1, unit: (m[2] as 'M' | 'C') || '' };
}

/** "2.6" → column 2, position 6. A bare "3" is column 3, position 0. */
export function parseModuleNo(moduleNo: any): { column: number; position: number } | null {
  const s = text(moduleNo);
  if (!s) return null;
  const m = s.match(/^(\d+)(?:[.\-/](\d+(?:\.\d+)?))?$/);
  if (!m) return null;
  return { column: Number(m[1]), position: m[2] ? Number(m[2]) : 0 };
}

export function buildPanelLayout(data: ProjectData, equipment: Equipment): PanelLayout {
  const library = data.deviceLibrary?.[equipment.type] ?? [];
  const spec =
    library.find(d => d.id === equipment.properties?.deviceLibraryItemId)?.properties ??
    library.find(d => d.name === equipment.name)?.properties ?? {};

  const byColumn = new Map<number, LayoutSlot[]>();
  let unit: 'M' | 'C' = equipment.type === 'MV' ? 'C' : 'M';
  let fallbackColumn = 1;

  for (const row of equipment.devices ?? []) {
    const size = parseSize(row.size);
    if (size.unit) unit = size.unit;
    const place = parseModuleNo(row.moduleNo);
    // A line with no module number is put after the last one that had a
    // column, rather than silently dropped from the elevation.
    const column = place?.column ?? fallbackColumn;
    fallbackColumn = column;
    const slot: LayoutSlot = {
      row, column,
      position: place?.position ?? (byColumn.get(column)?.length ?? 0) + 1,
      modules: size.modules,
      offset: 0,
    };
    if (!byColumn.has(column)) byColumn.set(column, []);
    byColumn.get(column)!.push(slot);
  }

  const columns: LayoutColumn[] = [...byColumn.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([column, slots]) => {
      slots.sort((a, b) => a.position - b.position);
      let offset = 0;
      for (const slot of slots) { slot.offset = offset; offset += slot.modules; }
      return { column, slots, modules: offset };
    });

  return {
    equipment,
    columns,
    spec,
    tallest: Math.max(1, ...columns.map(c => c.modules)),
    statedCells: text(equipment.properties?.tpms?.cellCount),
    unit,
  };
}

export const LAYOUT_HEADERS = [
  'Switchgear', 'Column', 'Position', 'From', 'To', 'Size', 'Feeder no.',
  'Bus section', 'Tag', 'Description', 'Template', 'Rating power', 'FLC', 'Cable size', 'SFD/HFD',
];

/** The elevation as a table: one row per feeder, in column and position order. */
export function buildLayoutRows(layouts: PanelLayout[]): (string | number)[][] {
  const rows: (string | number)[][] = [];
  for (const layout of layouts) {
    for (const column of layout.columns) {
      for (const slot of column.slots) {
        const r = slot.row;
        rows.push([
          layout.equipment.name,
          column.column,
          slot.position,
          slot.offset,
          slot.offset + slot.modules,
          `${slot.modules}${layout.unit}`,
          text(r.feederNo), text(r.busSection), text(r.tag), text(r.description),
          text(r.templateName), text(r.ratingPower), text(r.flc), text(r.cableSize), text(r.sfdHfd),
        ]);
      }
      rows.push([
        layout.equipment.name, column.column, '', '', '',
        `${column.modules}${layout.unit} used`, '', '', '', 'COLUMN TOTAL', '', '', '', '', '',
      ]);
    }
  }
  return rows;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The front elevation drawn: one box per column, one band per feeder. */
export function buildLayoutSvg(layout: PanelLayout): string {
  const colWidth = 150;
  const gap = 10;
  const top = 76;
  const bodyHeight = 480;
  const perModule = bodyHeight / Math.max(1, layout.tallest);
  const width = Math.max(560, layout.columns.length * (colWidth + gap) + 60);
  const height = top + bodyHeight + 90;

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Segoe UI, Arial, sans-serif">`);
  out.push(`<rect width="${width}" height="${height}" fill="#fff"/>`);

  const dims = [
    layout.spec.height && `H ${layout.spec.height}`,
    layout.spec.width && `W ${layout.spec.width}`,
    layout.spec.depth && `D ${layout.spec.depth}`,
  ].filter(Boolean).join(' × ');
  out.push(`<text x="30" y="22" font-size="13" font-weight="700" fill="#111">${esc(layout.equipment.name)}</text>`);
  out.push(`<text x="30" y="40" font-size="10" fill="#555">${esc([
    layout.equipment.type,
    dims && `${dims} mm`,
    layout.statedCells && `${layout.statedCells} cells (TPMS)`,
    `${layout.columns.length} column(s)`,
    `tallest ${layout.tallest}${layout.unit}`,
  ].filter(Boolean).join(' · '))}</text>`);

  layout.columns.forEach((column, i) => {
    const x = 30 + i * (colWidth + gap);
    out.push(`<rect x="${x}" y="${top}" width="${colWidth}" height="${bodyHeight}" fill="#f8fafc" stroke="#111" stroke-width="1.6"/>`);
    out.push(`<text x="${x + colWidth / 2}" y="${top - 10}" font-size="10" font-weight="600" text-anchor="middle" fill="#111">COLUMN ${column.column}</text>`);

    for (const slot of column.slots) {
      const y = top + slot.offset * perModule;
      const h = Math.max(14, slot.modules * perModule);
      const busy = slot.row.busSection ? '#dbeafe' : '#e2e8f0';
      out.push(`<rect x="${x + 3}" y="${y + 1.5}" width="${colWidth - 6}" height="${h - 3}" fill="${busy}" stroke="#334155" stroke-width="1"/>`);
      out.push(`<text x="${x + 9}" y="${y + 14}" font-size="10" font-weight="700" fill="#0f172a">${esc(text(slot.row.feederNo) || '—')}</text>`);
      out.push(`<text x="${x + colWidth - 9}" y="${y + 14}" font-size="9" text-anchor="end" fill="#475569">${slot.modules}${layout.unit}</text>`);
      if (h > 28) {
        out.push(`<text x="${x + 9}" y="${y + 26}" font-size="8.5" fill="#475569">${esc(text(slot.row.description).slice(0, 24))}</text>`);
      }
      if (h > 42) {
        out.push(`<text x="${x + 9}" y="${y + 38}" font-size="8.5" fill="#64748b">${esc([text(slot.row.templateName), text(slot.row.ratingPower) && `${slot.row.ratingPower} kW`].filter(Boolean).join(' · ').slice(0, 26))}</text>`);
      }
    }

    const free = layout.tallest - column.modules;
    if (free > 0) {
      const y = top + column.modules * perModule;
      out.push(`<rect x="${x + 3}" y="${y + 1.5}" width="${colWidth - 6}" height="${Math.max(0, free * perModule - 3)}" fill="#ffffff" stroke="#cbd5e1" stroke-dasharray="4 3"/>`);
      out.push(`<text x="${x + colWidth / 2}" y="${y + Math.min(20, free * perModule)}" font-size="9" text-anchor="middle" fill="#94a3b8">free ${free}${layout.unit}</text>`);
    }

    out.push(`<text x="${x + colWidth / 2}" y="${top + bodyHeight + 16}" font-size="9" text-anchor="middle" fill="#475569">${column.modules}${layout.unit} used · ${column.slots.length} feeder(s)</text>`);
  });

  out.push('</svg>');
  return out.join('\n');
}

/** A print-ready page: one elevation per switchgear. */
export function buildLayoutHtml(data: ProjectData, layouts: PanelLayout[]): string {
  const pages = layouts.map(layout => `
    <section style="page-break-after:always;padding:10px 0">
      <div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #111;padding-bottom:6px;margin-bottom:10px">
        <div>
          <div style="font-size:9px;letter-spacing:.8px;color:#666">PANEL LAYOUT / جانمایی — ${esc(data.projectName || '')}</div>
          <div style="font-size:16px;font-weight:800">${esc(layout.equipment.name)}</div>
        </div>
        <div style="font-size:10px;color:#666">${new Date().toLocaleString()}</div>
      </div>
      <div style="overflow-x:auto">${buildLayoutSvg(layout)}</div>
    </section>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>${esc(data.projectName || 'Project')} — Layout</title>
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
