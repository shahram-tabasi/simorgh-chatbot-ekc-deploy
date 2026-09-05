// src/utils/mechanicalItems.ts
//
// Mechanical items (اقلام مکانیکال): the sheet-metal and busbar side of a
// switchgear, counted from what the project already states.
//
// Every quantity here is derived, and every row says from what — the column
// "Basis" is part of the output, not a footnote. Nothing is estimated from
// outside the project: the counts come from the columns in the layout and the
// feeders in Device Selection, the specifications from the Device Library
// entry for that switchgear. Rows the project has no data for are left out
// rather than filled with a guess.
import { ProjectData, Equipment } from '../types/project';
import { buildPanelLayout, PanelLayout } from './panelLayout';

export interface MechanicalRow {
  switchgear: string;
  section: string;
  item: string;
  specification: string;
  unit: string;
  quantity: string;
  basis: string;
}

export const MECHANICAL_HEADERS = [
  'Switchgear', 'Section', 'Item', 'Specification', 'Unit', 'Qty', 'Basis',
];

const text = (v: any) => (v == null ? '' : String(v).trim());
const num = (v: any) => {
  const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function buildMechanicalItems(data: ProjectData, equipment: Equipment): MechanicalRow[] {
  const layout: PanelLayout = buildPanelLayout(data, equipment);
  const spec = layout.spec;
  const name = equipment.name;
  const rows: MechanicalRow[] = [];
  const add = (section: string, item: string, specification: string, unit: string, quantity: string, basis: string) => {
    if (!specification && !quantity) return;
    rows.push({ switchgear: name, section, item, specification, unit, quantity, basis });
  };

  const columns = layout.columns.length;
  const statedCells = num(layout.statedCells);
  // The cabinet count: what TPMS states, otherwise the columns the layout has.
  const cells = statedCells || columns;
  const cellsBasis = statedCells
    ? `cell count stated by TPMS (${layout.statedCells})`
    : `${columns} column(s) in the layout`;

  const h = num(spec.height);
  const w = num(spec.width);
  const d = num(spec.depth);
  const dims = [h && `H ${h}`, w && `W ${w}`, d && `D ${d}`].filter(Boolean).join(' × ');

  // ── Enclosure ─────────────────────────────────────────────────────────
  if (cells > 0) {
    add('Enclosure', 'Cubicle frame', dims ? `${dims} mm` : '', 'pcs', String(cells), `one per cell — ${cellsBasis}`);
    add('Enclosure', 'Front door', h && w ? `${h} × ${w} mm` : '', 'pcs', String(cells), `one per cell — ${cellsBasis}`);

    const access = text(spec.switchgearAccess);
    if (/rear|back|both|front\s*(&|and)\s*rear/i.test(access)) {
      add('Enclosure', 'Rear door / cover', h && w ? `${h} × ${w} mm` : '', 'pcs', String(cells),
        `switchgear access is "${access}"`);
    }
    add('Enclosure', 'Roof plate', w && d ? `${w} × ${d} mm` : '', 'pcs', String(cells), `one per cell — ${cellsBasis}`);
    add('Enclosure', 'Bottom gland plate', w && d ? `${w} × ${d} mm` : '', 'pcs', String(cells), `one per cell — ${cellsBasis}`);
    add('Enclosure', 'Side cover', h && d ? `${h} × ${d} mm` : '', 'pcs', '2', 'one at each end of the row');
  }

  // ── Busbars ───────────────────────────────────────────────────────────
  const runLength = cells > 0 && w ? `${cells * w} mm` : '';
  const runBasis = cells > 0 && w ? `${cells} cell(s) × ${w} mm cabinet width` : '';
  if (text(spec.mainBusbarSize)) {
    add('Busbar', 'Main busbar', [text(spec.mainBusbarSize), text(spec.mainBusbarConfiguration),
      text(spec.mainBusbarRatedCurrent) && `${spec.mainBusbarRatedCurrent} A`].filter(Boolean).join(' · '),
      'mm', runLength || '—', runBasis || 'busbar size from the panel specification');
  }
  if (text(spec.earthBusbarSize)) {
    add('Busbar', 'Earth busbar', text(spec.earthBusbarSize), 'mm', runLength || '—', runBasis || '—');
  }
  if (text(spec.neutralBusbarSize)) {
    add('Busbar', 'Neutral busbar', text(spec.neutralBusbarSize), 'mm', runLength || '—', runBasis || '—');
  }
  if (text(spec.busbarType)) add('Busbar', 'Busbar type', text(spec.busbarType), '', '', 'panel specification');
  if (text(spec.thermoFitCover)) add('Busbar', 'Thermo-fit cover / insulation', text(spec.thermoFitCover), '', '', 'panel specification');

  // ── Compartments, from the feeders themselves ─────────────────────────
  const lines = equipment.devices ?? [];
  if (lines.length > 0) {
    add('Compartments', 'Feeder compartment', `${layout.unit === 'C' ? 'cell' : 'module'}-mounted`, 'pcs',
      String(lines.length), `one per feeder line in Device Selection`);

    const bySize = new Map<string, number>();
    for (const line of lines) {
      const key = text(line.size) || '—';
      bySize.set(key, (bySize.get(key) ?? 0) + 1);
    }
    for (const [size, count] of [...bySize.entries()].sort()) {
      add('Compartments', `Compartment ${size}`, `size ${size}`, 'pcs', String(count),
        `${count} feeder(s) of size ${size}`);
    }

    const byDrawer = new Map<string, number>();
    for (const line of lines) {
      const key = text(line.sfdHfd);
      if (!key) continue;
      byDrawer.set(key, (byDrawer.get(key) ?? 0) + 1);
    }
    for (const [kind, count] of [...byDrawer.entries()].sort()) {
      add('Compartments', `Withdrawable unit ${kind}`, kind, 'pcs', String(count), `${count} feeder(s) marked ${kind}`);
    }

    const withCable = lines.filter(l => text(l.cableSize)).length;
    if (withCable > 0) {
      add('Cabling', 'Cable gland / entry', 'per outgoing feeder', 'pcs', String(withCable),
        `${withCable} feeder(s) carry a cable size`);
    }
  }

  // ── Finish and hardware ───────────────────────────────────────────────
  // Paint colour and coating belong to the panel; the paint type and its
  // thickness are a project-wide setting (Technical Settings → others).
  const others = data.techSettings?.others;
  const paint = [
    text(others?.colorType), text(spec.ral), text(spec.coating),
    text(others?.thicknessOfPainting) && `${others?.thicknessOfPainting} µm`,
  ].filter(Boolean).join(' · ');
  if (paint) add('Finish', 'Painting', paint, '', '', 'panel specification + technical settings');
  if (text(spec.ip)) add('Finish', 'Degree of protection', text(spec.ip), '', '', 'panel specification');
  if (text(spec.switchgearArrangement)) add('Finish', 'Arrangement', text(spec.switchgearArrangement), '', '', 'panel specification');

  const padlocks = [
    spec.padLockCbOnOff && 'CB on/off',
    spec.padLockCbTestService && 'CB test/service',
    spec.padLockHvDoor && 'HV door',
  ].filter(Boolean) as string[];
  if (padlocks.length > 0) {
    add('Hardware', 'Pad lock', padlocks.join(', '), 'pcs', String(padlocks.length * cells),
      `${padlocks.length} lock(s) per cell × ${cells} cell(s)`);
  }
  if (text(spec.incomingConnection)) add('Hardware', 'Incoming connection', text(spec.incomingConnection), '', '', 'panel specification');
  if (text(spec.outgoingConnection)) add('Hardware', 'Outgoing connection', text(spec.outgoingConnection), '', '', 'panel specification');

  return rows;
}

/** Every switchgear's mechanical items, as spreadsheet rows. */
export function buildMechanicalRows(
  data: ProjectData,
  equipments: Equipment[],
): (string | number)[][] {
  const rows: (string | number)[][] = [];
  for (const equipment of equipments) {
    for (const r of buildMechanicalItems(data, equipment)) {
      rows.push([r.switchgear, r.section, r.item, r.specification, r.unit, r.quantity, r.basis]);
    }
  }
  return rows;
}
