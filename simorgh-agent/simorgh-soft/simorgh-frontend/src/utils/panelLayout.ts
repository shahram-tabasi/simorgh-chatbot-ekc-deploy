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
import { Drawing } from './cad/shapes';
import { renderSvg } from './cad/svg';
import { renderDxf, mergeDrawings } from './cad/dxf';

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

/** The front elevation as geometry: one box per column, one band per feeder. */
export function buildLayoutDrawing(layout: PanelLayout): Drawing {
  const colWidth = 150;
  const gap = 10;
  const top = 76;
  const bodyHeight = 480;
  const perModule = bodyHeight / Math.max(1, layout.tallest);
  const width = Math.max(560, layout.columns.length * (colWidth + gap) + 60);
  const height = top + bodyHeight + 90;

  const d = new Drawing(width, height, `${text(layout.equipment.name)} — panel layout`);

  const dims = [
    layout.spec.height && `H ${layout.spec.height}`,
    layout.spec.width && `W ${layout.spec.width}`,
    layout.spec.depth && `D ${layout.spec.depth}`,
  ].filter(Boolean).join(' × ');
  d.text(30, 22, text(layout.equipment.name), 13, { layer: 'TITLE', color: '#111', bold: true });
  d.text(30, 40, [
    layout.equipment.type,
    dims && `${dims} mm`,
    layout.statedCells && `${layout.statedCells} cells (TPMS)`,
    `${layout.columns.length} column(s)`,
    `tallest ${layout.tallest}${layout.unit}`,
  ].filter(Boolean).join(' · '), 10, { layer: 'TITLE', color: '#555' });

  layout.columns.forEach((column, i) => {
    const x = 30 + i * (colWidth + gap);
    d.rect(x, top, colWidth, bodyHeight,
      { layer: 'PANEL', color: '#111', fill: '#f8fafc', width: 1.6 });
    d.text(x + colWidth / 2, top - 10, `COLUMN ${column.column}`, 10,
      { layer: 'TITLE', color: '#111', anchor: 'middle', bold: true });

    for (const slot of column.slots) {
      const y = top + slot.offset * perModule;
      const h = Math.max(14, slot.modules * perModule);
      const busy = slot.row.busSection ? '#dbeafe' : '#e2e8f0';
      d.rect(x + 3, y + 1.5, colWidth - 6, h - 3,
        { layer: 'SLOT', color: '#334155', fill: busy, width: 1 });
      d.text(x + 9, y + 14, text(slot.row.feederNo) || '—', 10,
        { layer: 'TAG', color: '#0f172a', bold: true });
      d.text(x + colWidth - 9, y + 14, `${slot.modules}${layout.unit}`, 9,
        { layer: 'TEXT', color: '#475569', anchor: 'end' });
      if (h > 28) {
        d.text(x + 9, y + 26, text(slot.row.description).slice(0, 24), 8.5,
          { layer: 'TEXT', color: '#475569' });
      }
      if (h > 42) {
        d.text(x + 9, y + 38, [
          text(slot.row.templateName),
          text(slot.row.ratingPower) && `${slot.row.ratingPower} kW`,
        ].filter(Boolean).join(' · ').slice(0, 26), 8.5, { layer: 'TEXT', color: '#64748b' });
      }
    }

    const free = layout.tallest - column.modules;
    if (free > 0) {
      const y = top + column.modules * perModule;
      d.rect(x + 3, y + 1.5, colWidth - 6, Math.max(0, free * perModule - 3),
        { layer: 'FREE', color: '#cbd5e1', fill: '#ffffff', width: 1, dash: '4 3' });
      d.text(x + colWidth / 2, y + Math.min(20, free * perModule),
        `free ${free}${layout.unit}`, 9, { layer: 'FREE', color: '#94a3b8', anchor: 'middle' });
    }

    d.text(x + colWidth / 2, top + bodyHeight + 16,
      `${column.modules}${layout.unit} used · ${column.slots.length} feeder(s)`, 9,
      { layer: 'TEXT', color: '#475569', anchor: 'middle' });
  });

  return d;
}

/** The front elevation drawn: one box per column, one band per feeder. */
export function buildLayoutSvg(layout: PanelLayout): string {
  return renderSvg(buildLayoutDrawing(layout));
}

/**
 * The elevation as a DXF file — the layout equivalent of the single line's CAD
 * output, for the customer who works in AutoCAD rather than EPLAN.
 */
export function buildLayoutDxf(data: ProjectData, layouts: PanelLayout[]): string {
  const drawings = layouts.map(buildLayoutDrawing);
  const drawing = drawings.length === 1
    ? drawings[0]
    : mergeDrawings(drawings, 60, `${text(data.projectName)} — panel layout`);

  return renderDxf(drawing, {
    titleBlock: [
      layouts.length === 1 ? text(layouts[0].equipment.name) : `${layouts.length} switchgears`,
      text(data.projectName) || 'PROJECT',
      'Panel layout — front elevation',
      new Date().toLocaleDateString(),
    ].filter(Boolean),
  });
}

/** A print-ready page: one elevation per switchgear. */
export function buildLayoutHtml(data: ProjectData, layouts: PanelLayout[]): string {
  const pages = layouts.map(layout => `
    <section style="page-break-after:always;padding:10px 0">
      <div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #111;padding-bottom:6px;margin-bottom:10px">
        <div>
          <div style="font-size:9px;letter-spacing:.8px;color:#666">PANEL LAYOUT — ${esc(data.projectName || '')}</div>
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
