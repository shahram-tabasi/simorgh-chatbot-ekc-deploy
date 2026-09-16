// src/utils/outline/index.ts
//
// One feeder, described the way Eplanix describes it.
//
// This is the port of `OutlineService.BuildFeederDataAsync` — the routine that
// produces `CombinedProjectData`, which is both halves of Send to EPLAN: the
// outline drawing's own fields (the cell width, the doors, the floor opening,
// the baffle, the interlocks, the ventilation) and the context the mechanical
// estimate sheets are read with. They come from one description of the feeder
// on purpose, because they are answers about the same cell; splitting them is
// how the two drift apart.
//
// Eplanix asks TPMS eleven questions per feeder. This asks the same eleven of
// the project itself:
//
//   ViewDrafts.Size / CableSize / Designation / Flc   → the Device Selection row
//   ViewDraftEquipments (label, Scode, SecDes, ShrDes) → the parts on its template
//   TechnicalPanelIdentity (Kabus, Ip, AccessFrom …)   → the Device Library entry
//   TechnicalProjectIdentity (AverageTemperature)      → Technical Settings
//
// Nothing here is estimated. Where the project does not state something the
// field comes out empty or "N/A" — which is what the original does with a
// draft whose TPMS record is silent, and what every rule downstream tests for.

import {
  ProjectData, Equipment, DeviceTableRow, TemplateItem, DeviceLibraryProperties,
} from '../../types/project';
import {
  PartFact, partFacts, breakerType, breakerLabel, magnetLabel, feederCurrentByCt,
  hasEarthSwitch, hasDampingResistor, ptStatus, ronisLabels, equipmentLabels,
  determineRonis,
} from './parts';
import { decodePoleCenter, PoleCenter } from './poleCenter';
import { selectWorldPanel, PanelConfig } from './simoprimeWorld';
import {
  FeederPeer, determineBaffle, determineDxfNameAndDescription, determineDxfOpening,
  determineLvDoor, determinePanelWidth, determineVentilation, extractDouble, extractInt,
  extractIntegerStrict, formatCableSize, parsePanelWidth, switchgearCbType,
} from './rules';

export * from './parts';
export * from './poleCenter';
export * from './rules';
export { selectWorldPanel } from './simoprimeWorld';
export { findBestA4Configuration } from './simoprimeA4';

const text = (v: unknown) => (v == null ? '' : String(v).trim());

/**
 * What kind of panel this switchgear is — Eplanix's `feeder.SwType`.
 *
 * There it is one field: the scope's switchgear type, looked up in the coding
 * table. Here that field exists only when the switchgear came from TPMS, so
 * the places it is otherwise written are read in turn — the description it is
 * copied to, and the names, which in this office's naming carry the family at
 * the end.
 */
export function panelTypeOf(data: ProjectData, equipment: Equipment): string {
  const library = data.deviceLibrary?.[equipment.type] ?? [];
  const entry = library.find(d => d.id === equipment.properties?.deviceLibraryItemId)
    ?? library.find(d => d.name === equipment.name);
  const candidates = [
    text(equipment.properties?.tpms?.switchgearType),
    text(equipment.description),
    text(equipment.name),
    text(entry?.name),
  ].filter(Boolean);
  return candidates[0] ?? '';
}

/** The Device Library entry behind a switchgear — Eplanix's panel record. */
export function panelSpecOf(data: ProjectData, equipment: Equipment): DeviceLibraryProperties {
  const library = data.deviceLibrary?.[equipment.type] ?? [];
  return (library.find(d => d.id === equipment.properties?.deviceLibraryItemId)?.properties
    ?? library.find(d => d.name === equipment.name)?.properties
    ?? {}) as DeviceLibraryProperties;
}

/** The facts that belong to the switchgear rather than to one of its feeders. */
export interface PanelFacts {
  panelType: string;
  /** The busbar's short-circuit rating — Eplanix's Kabus. */
  kbus: string;
  ip: string;
  access: string;
  /** The panel's rated current, which the busduct opening rules read. */
  switchAmperage: number;
  ratedVoltageKv: number | null;
  frequency: string;
  designTemperature: string;
}

export function panelFacts(data: ProjectData, equipment: Equipment): PanelFacts {
  const spec = panelSpecOf(data, equipment);
  return {
    panelType: panelTypeOf(data, equipment),
    // TPMS calls it Kabus; here it is the panel's own short-time withstand
    // current, which is the same rating written in the same units.
    kbus: text(spec.ratedShortTimeWithstandCurrent) || text(spec.isc),
    ip: text(spec.ip),
    access: text(spec.switchgearAccess),
    switchAmperage: extractInt(spec.mainBusbarRatedCurrent) ?? 0,
    ratedVoltageKv: extractDouble(spec.ratedInsulationVoltage),
    frequency: text(spec.frequency),
    designTemperature: text(data.techSettings?.general?.designTemperature),
  };
}

/**
 * The cell type of a feeder — what selects its basket on the estimate sheet.
 *
 * Eplanix reads it from one place, the draft's own Size, and so does this: a
 * switchgear imported from TPMS carries the cell type in the SIZE column,
 * because that is the column TPMS filled. Where SIZE holds a module count
 * instead — "1C", "10M", the way a switchgear built here by hand states it —
 * the template's own hierarchy answers, since a bare count is not a cell type
 * and reading it as one would select no basket at all.
 */
export function cellTypeOf(row: DeviceTableRow, template: TemplateItem | undefined): string {
  const size = text(row?.size);
  if (size && !/^\d+(\.\d+)?\s*[MC]?$/i.test(size)) return size;

  const path = template?.hierarchy?.path ?? [];
  const head = text(path[0]);
  if (!head) return '';
  const sub = text(path[1]);
  // The one place the app and the sheet part company: the sheet names the fuse
  // in the cell type, this app keeps it as a sub-type.
  if (/^disconnector link$/i.test(head)) {
    if (/without fuse/i.test(sub)) return 'Disconnector Link wo Fuse';
    if (/with fuse/i.test(sub)) return 'Disconnector Link w Fuse';
    return head;
  }
  return head;
}

/** Everything the outline and the estimate sheets know about one feeder. */
export interface FeederOutline {
  row: DeviceTableRow;
  /** The parts the answers were read from, kept so a report can show them. */
  parts: PartFact[];

  feederNo: string;
  planeType: string;
  kabus: string;
  cbType: string;
  cbLabel: string;
  magnetLabel: string;
  /** The cell type — what the estimate sheet's baskets are keyed on. */
  size: string;
  sldType: string;
  busSection: string;
  cableSize: string;
  /** The cable size as the drawing states it: YES, NO, or the word itself. */
  cableSizeDisplay: string;
  description: string;
  designation: string;
  ptStatus: string;
  panelWidth: string;
  hvDoor: string;
  dxfOpening: string;
  dxfLvDoor: string;
  dxfBaffle: string;
  cableBox: boolean;
  isCoupling: boolean;
  leo: boolean;
  lec: boolean;
  lq: boolean;
  ico: boolean;
  ieb: boolean;
  qc1: boolean;
  qc2: boolean;
  earthSwitch: boolean;
  hasDampingR: boolean;
  feederCurrent: number;
  /** The current the estimate sheets count contact fingers against. */
  cellCurrent: number | null;
  flc: number | null;
  poleCenter: PoleCenter;
  ventilationType: string;
  designTemperature: string;
  frequency: string;
  panelAccess: string;
  panelIp: string;
  labels: string[];
}

export interface OutlineOptions {
  /** "70" or "100" — the SIMOPRIME World LV compartment, from Send to EPLAN. */
  lvCompartmentHeight?: string;
}

/** Every feeder of a switchgear, plus the totals the outline drawing needs. */
export interface SwitchgearOutline {
  equipment: Equipment;
  panel: PanelFacts;
  feeders: FeederOutline[];
  /** The sum of the cell widths — how wide the whole switchgear is. */
  totalWidth: number;
  /** The breaker family the switchgear is built around. */
  cbType: string;
}

export function buildOutline(
  data: ProjectData, equipment: Equipment, options: OutlineOptions = {},
): SwitchgearOutline {
  const panel = panelFacts(data, equipment);
  const templates = new Map(
    (data.templates?.[equipment.type] ?? []).map(t => [t.id, t as TemplateItem]));
  const rows = equipment.devices ?? [];

  const factsFor = (row: DeviceTableRow) =>
    partFacts(row.templateId ? templates.get(row.templateId) : undefined);

  // The width rule asks the riser what the coupling of the same switchgear
  // carries, so every feeder's CT current is read before any width is decided.
  const peers: FeederPeer[] = rows.map(row => ({
    wiringType: text(row.wiringType),
    ctCurrent: feederCurrentByCt(factsFor(row)),
  }));

  const feeders = rows.map(row => buildFeeder(
    row, factsFor(row), templates.get(row.templateId ?? ''), panel, peers, options));

  return {
    equipment,
    panel,
    feeders,
    totalWidth: feeders.reduce((sum, f) => sum + parsePanelWidth(f.panelWidth), 0),
    cbType: switchgearCbType(feeders.map(f => f.cbType)),
  };
}

function buildFeeder(
  row: DeviceTableRow, parts: PartFact[], template: TemplateItem | undefined,
  panel: PanelFacts, peers: FeederPeer[], options: OutlineOptions,
): FeederOutline {
  const feederCurrent = feederCurrentByCt(parts);
  const cbType = breakerType(parts);
  const cbLabel = breakerLabel(parts);
  const pt = ptStatus(parts);
  const cableSize = text(row.cableSize);
  const designation = text(row.description);
  const flc = extractInt(row.flc);
  const poleCenter = decodePoleCenter(parts.find(p => p.label === cbLabel)?.scode);
  const labels = equipmentLabels(parts);
  const ronis = determineRonis(ronisLabels(parts));
  const isCoupling = text(row.busSection).includes('/');

  const worldPanel: PanelConfig | null = selectWorldPanel(
    panel.ratedVoltageKv, extractDouble(panel.kbus), feederCurrent,
    extractInt(panel.designTemperature), extractInt(panel.frequency));

  const panelWidth = determinePanelWidth(
    panel.kbus, poleCenter, cableSize, panel.panelType,
    cbLabel, text(row.wiringType), feederCurrent, flc, peers);

  const { opening, cableBox } = determineDxfOpening(
    panel.panelType, pt, cableSize, designation, cbType,
    panel.switchAmperage, feederCurrent != null);

  const { hvDoor, description } = determineDxfNameAndDescription(
    panel.panelType, cbType, isCoupling, cableSize, cbLabel, pt);

  // The estimate sheets count contact fingers against the rated current of the
  // cell: the breaker's own for a 3AE5, otherwise the CT's, otherwise the FLC.
  const cellCurrent = cbType.toUpperCase().includes('3AE5')
    ? poleCenter.ratedCurrent
    : (feederCurrent ?? flc);

  return {
    row,
    parts,
    feederNo: text(row.feederNo) || 'N/A',
    planeType: panel.panelType || 'N/A',
    kabus: panel.kbus || 'N/A',
    cbType,
    cbLabel,
    magnetLabel: magnetLabel(parts),
    size: cellTypeOf(row, template),
    sldType: text(row.wiringType),
    busSection: text(row.busSection),
    cableSize,
    cableSizeDisplay: formatCableSize(cableSize),
    description,
    designation,
    ptStatus: pt,
    panelWidth,
    hvDoor,
    dxfOpening: opening,
    dxfLvDoor: determineLvDoor(
      panel.panelType, cableSize, ronis.qc2, text(options.lvCompartmentHeight)),
    dxfBaffle: determineBaffle(panel.kbus),
    cableBox,
    isCoupling,
    leo: ronis.leo,
    lec: ronis.lec,
    lq: ronis.lq,
    ico: ronis.ico,
    ieb: ronis.ieb,
    qc1: ronis.qc1,
    qc2: ronis.qc2,
    earthSwitch: hasEarthSwitch(parts),
    hasDampingR: hasDampingResistor(parts),
    feederCurrent: feederCurrent ?? 0,
    cellCurrent: cellCurrent && cellCurrent > 0 ? cellCurrent : null,
    flc,
    poleCenter,
    ventilationType: determineVentilation(
      worldPanel, panel.panelType,
      extractIntegerStrict(panel.designTemperature),
      extractIntegerStrict(panel.frequency), feederCurrent),
    designTemperature: panel.designTemperature,
    frequency: panel.frequency,
    panelAccess: panel.access,
    panelIp: panel.ip,
    labels,
  };
}
