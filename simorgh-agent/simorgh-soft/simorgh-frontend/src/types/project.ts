// ==============================
// Device Library Types
// ==============================

// A sheet edited in Simorgh Draw is kept as its own geometry — see DrawingEdits.
import { Shape } from '../utils/cad/shapes';

export interface DeviceLibraryProperties {
  // Electrical / Mechanical — the three voltages lead the tab: they are the
  // ratings the rest of the panel is sized against.
  ratedInsulationVoltage?: string;
  serviceVoltage?: string;
  ratedPowerFrequencyWithstandVoltage?: string;
  frequency?: string;
  mainBusbarConfiguration?: string;
  mainBusbarRatedCurrent?: string;
  ratedShortTimeWithstandCurrent?: string;
  isc?: string;
  height?: string;
  width?: string;
  depth?: string;
  ratedImpulseWithstandVoltage?: string;
  // Control & Auxiliary
  controlProtectionClosingTrippingSignalling?: string;
  springChargingMotor?: string;
  switchgearLightingSpaceHeater?: string;
  motorsSpaceHeater?: string;
  // Busbar & Construction
  mainBusbarSize?: string;
  earthBusbarSize?: string;
  neutralBusbarSize?: string;
  ral?: string;
  incomingConnection?: string;
  outgoingConnection?: string;
  ip?: string;
  switchgearAccess?: string;
  switchgearArrangement?: string;
  busbarType?: string;
  thermoFitCover?: string;
  coating?: string;
  // Pad Lock Checkboxes
  padLockCbOnOff?: boolean;
  padLockCbTestService?: boolean;
  padLockHvDoor?: boolean;
}

export interface DeviceLibraryItem {
  id: string;
  name: string;
  type: 'LV' | 'MV' | 'HV';
  properties: DeviceLibraryProperties;
  /** 'tpms' when this entry was read from TPMS rather than typed here. */
  source?: 'tpms';
  tpmsScopeId?: number;
}

// ==============================
// Technical Settings (new structure)
// ==============================

export interface TechSettings {
  general: {
    altitudeAboveSeaLevel: string;
    designTemperature: string;
  };
  wireSize: {
    controlCircuit: string;
    ctSecondary: string;
    ptSecondary: string;
    plcPowerSupply: string;
  };
  wireColor: {
    acPhase: string;
    dcPlus: string;
    acNeutral: string;
    dcMinus: string;
    plcInput: string;
    plcOutput: string;
    threePhase: string;
  };
  wireManufacturer: {
    lv: string;
    mv: string;
  };
  others: {
    thicknessOfPainting: string;
    colorType: string;
    backgroundColor: string;
    writingColor: string;
  };
}

// ==============================
// Core Project Data
// ==============================

export interface ProjectData {
  _id?: string;
  projectName: string;
  // New master data fields
  projectId?: string;           // PID
  projectNumber?: string;       // OE
  noticeToProceedDate?: string;
  deliveryDate?: string;
  projectDescription: string;
  planner: string;
  designOffice: string;
  createdOn: string;
  changedOn: string;
  location: string;
  client: string;
  standard: string;
  country: string;
  language: string;
  comment: string;
  // Old technical settings kept for backward compatibility (not shown in UI)
  technicalSettings: {
    mediumVoltage: {
      nominalVoltage: string;
      maxShortCircuitPower: string;
      minShortCircuitPower: string;
      maxCrossSection: string;
      minCrossSection: string;
    };
    lowVoltage: {
      nominalVoltage: string;
      frequency: string;
      permissibleTouchVoltage: string;
      ambientTemperature: string;
      numberOfPoles: string;
      earthFaultDetection: string;
      referencePoint: string;
      relativeOperatingVoltage: string;
      maxPermissibleVoltage: string;
      maxCrossSection: string;
      minCrossSection: string;
      enableReducedCrossSection: boolean;
    };
  };
  // New technical settings structure
  techSettings?: TechSettings;
  templates: {
    LV: TemplateItem[];
    MV: TemplateItem[];
    HV: TemplateItem[];
  };
  // Device Library (new)
  deviceLibrary?: {
    LV: DeviceLibraryItem[];
    MV: DeviceLibraryItem[];
    HV: DeviceLibraryItem[];
  };
  devices: DeviceItem[];
  equipments: Equipment[];
  outputTypes?: OutputType[];
  /** Set on a project that came from TPMS — see TpmsSyncState. */
  tpmsSync?: TpmsSyncState;
  /** Sheets edited in Simorgh Draw — see DrawingEdits. */
  drawingEdits?: DrawingEdits;
  /** Symbols redrawn for this project — see SymbolArtOverride. */
  symbolOverrides?: Record<string, SymbolArtOverride>;
}

// ── Redrawn symbols ──────────────────────────────────────────────────────────
// A symbol edited on the graphic page is kept with the project, so the office's
// own drawing of a device travels with the job rather than with the machine it
// was drawn on. It takes the place of the library's symbol everywhere that
// symbol is used, exactly as a file in the symbol pack does — the difference
// is only where it lives and how far it reaches.

export interface SymbolArtOverride {
  /** The geometry, as markup with no `<svg>` around it. */
  art: string;
  /** The box it is placed by, and where its conductor runs inside that box. */
  width: number;
  height: number;
  pinX: number;
  /** How many cells down the branch it takes. */
  cells: number;
  editedAt: string;
}

// ── Edited sheets ────────────────────────────────────────────────────────────
// A sheet is drawn from the project every time it is shown, so an edit made on
// the canvas has nowhere to live unless the project keeps it. What is kept is
// the sheet itself — the whole array of shapes, not a list of changes — because
// an edited sheet is a document, and a document that quietly redraws itself
// underneath its own corrections is worse than one that does not move.
//
// The key says which sheet: the switchgear, how many feeders were on a sheet
// when it was drawn, and which sheet of the set. Changing the feeders per sheet
// therefore repaginates into different keys and leaves the old edits alone
// rather than dropping them onto sheets they were never made against.
//
// `drawnAs` is what the sheet looked like when it was edited. When the project
// changes underneath it the fingerprint stops matching, and the tab says so
// instead of showing corrections against numbers that have moved on.

export interface SheetEdit {
  /** The sheet as edited. */
  shapes: Shape[];
  /** Fingerprint of the sheet as it was drawn when the edits were made. */
  drawnAs: string;
  editedAt: string;
}

/** Keyed `switchgearId#feedersPerSheet#sheetIndex`. */
export type DrawingEdits = Record<string, SheetEdit>;

// ── TPMS-linked projects ─────────────────────────────────────────────────────
// A project opened from TPMS keeps a link back to it. While `master` is
// 'tpms', TPMS owns the data: every time the project is opened it is read from
// TPMS again, and the app refuses edits. Raising a revision inside Design Suite
// hands ownership over ('suite'): syncing stops and the new revision is the
// one being worked on.
export interface TpmsSyncState {
  projectMainId: number;
  oeNumber: string;
  projectName: string;
  master: 'tpms' | 'suite';
  lastSyncedAt: string;
  /** The TPMS revisions that became revisions on this side. */
  revisions: number[];
  /** Switchgear (scope) ids and names last read from TPMS. */
  switchgears: { scopeId: number; scopeName: string; panelType: 'LV' | 'MV' | 'HV' }[];
  /** When and at which revision the suite took over. */
  detachedAt?: string;
  detachedAtRevision?: string;
}

// ── Hierarchical template path ───────────────────────────────────────────────
// Templates are organised in a category tree the user explored when
// authoring them. This metadata lets the chatbot (and a forthcoming browser
// UI) propose similar templates that already exist at the same path.
//
// LV path example (root always first, OFW and FIX both carry one):
//   ['S8', 'FCB1', 'OUTGOING']   ← top → leaf, OFW family
//   ['8PT', 'CCS']               ← FIX family
//   ['S8', 'SFD']                ← OFW family
//
// MV path is a cell type, plus a sub-type for the two that have one:
//   ['Feeder Truck', 'Circuit Breaker'] | ['Feeder Truck', 'Contactor Fuse Combination']
//   ['Disconnector Link', 'With Fuse'] | ['Incoming VT Cell'] | ['Metering'] | …
//
// `leafKind` describes what equipment family this template is for, so the
// suggestion engine can short-list templates with matching power/current.

export type TemplateLeafKind = 'motor' | 'transformer' | 'capacitor' | 'feeder' | 'other';

export interface TemplateHierarchy {
  path: string[];                  // top → leaf nodes
  leafKind?: TemplateLeafKind;
  params?: {
    kw?: string;                   // rated power (kW or kVA)
    currentA?: string;             // rated full-load current
    notes?: string;
  };
}

export interface TemplateItem {
  id: string;
  name: string;
  type: 'LV' | 'MV' | 'HV';
  properties: Record<string, string>;
  /** Optional hierarchical classification used by recommendations / AI tools. */
  hierarchy?: TemplateHierarchy;
  /** 'tpms' when this template was built from a TPMS draft. */
  source?: 'tpms';
  tpmsScopeId?: number;
  /** Answered at template creation: should Simorgh Draw be used for this
   *  template's equipment? Either way the equipment draws — this only gates
   *  whether the extra per-equipment questions (a separate, later piece)
   *  are asked. */
  useSimorghDraw?: boolean;
  /**
   * The few mechanical facts about the cell that its own columns do not
   * state — the earth switches and the magnet label — plus overrides for
   * the ones they do. Read by the estimate sheets; see
   * `utils/mechanical/template.ts`.
   */
  mechanical?: TemplateMechanical;
}

/**
 * What a template is asked about its mechanics, and what it is allowed to
 * overrule.
 *
 * Breaker, VT and CT are read from the template's own columns — an empty
 * `CB ORDER` says the cell has no breaker — so they are not asked, only
 * overridden. The earth switches and the magnet label are written nowhere,
 * so they are asked; once the office's labelling is standardised they can be
 * read too, and the answer becomes an override like the rest.
 */
export interface TemplateMechanical {
  /** QC1 — a cable earth switch on this cell. */
  cableEarthSwitch?: boolean;
  /** QC2 — a bus earth switch. */
  busEarthSwitch?: boolean;
  /** MB3 / MB4, or empty for neither. */
  magnetLabel?: string;
  /** Overrules the reading of the breaker column. */
  hasBreaker?: boolean;
  /** Overrules the breaker's order number. */
  breakerType?: string;
  /** Overrules the reading of the PT column. */
  hasVt?: boolean;
  /** Overrules the reading of the CT column. */
  hasCt?: boolean;
}

export interface DeviceItem {
  id: string;
  rowNumber: number;
  templateId: string;
  deviceName: string;
  parentDeviceId?: string;
  equipmentId?: string;
  children?: DeviceRow[];
  flc: string;
  ratingPower: string;
  wiringType: string;
  feederNo: string;
  busSection: string;
  isExpanded?: boolean;
  selectedParts?: SelectedPartEntry[];
}

export interface SelectedPartEntry {
  propertyName: string;
  part: Record<string, any>;
}

export interface DeviceRow {
  id: string;
  rowNumber: number;
  deviceId: string;
  templateId: string;
  flc: string;
  ratingPower: string;
  wiringType: string;
  feederNo: string;
  busSection: string;
}

export interface DeviceTableRow {
  id: string;
  rowNumber: number;
  templateId: string;
  templateName: string;
  busSection: string;
  feederNo: string;
  wiringType: string;
  ratingPower: string;
  flc: string;
  equipmentId: string;
  selectedParts?: SelectedPartEntry[];

  // ── MV / LV specific extra columns (Device Selection) ──
  tag?: string;          // MV + LV
  description?: string;  // MV + LV
  cableSize?: string;    // MV + LV
  // LV-only
  sfdHfd?: string;
  moduleNo?: string;
  size?: string;

  // ── Visual customizations ──
  rowColor?: string;                 // background color for the whole row (tailwind hex like '#fde68a')
  cellColors?: Record<string, string>; // per-column background color overrides; key = column field name
}

export interface Equipment {
  id: string;
  name: string;
  power?: string;
  type: 'LV' | 'MV' | 'HV';
  deviceCount?: number;
  description?: string;
  properties: Record<string, any>;  // deviceLibraryItemId stored here
  devices: DeviceTableRow[];
}

export interface OutputType {
  id: string;
  name: string;
  format: 'PDF' | 'Excel' | 'Word' | 'DWG';
  template: string;
  enabled: boolean;
}

// ==============================
// Revision Management
// ==============================

export interface Revision {
  _id?: string;
  projectId: string;
  revisionNumber: string;
  revisionName: string;
  description: string;
  createdOn: string;
  changedOn: string;
  createdBy: string;
  projectSnapshot: ProjectData;
  isLocked: boolean;
  parentRevisionId?: string;
  /** 'tpms' for a revision that mirrors a TPMS revision, 'suite' for one
   *  raised here. Absent on revisions created before this existed. */
  source?: 'tpms' | 'suite';
  /** The TPMS revision number this revision mirrors. */
  tpmsRevision?: number;
}

export interface RevisionComparison {
  baseRevision: Revision;
  targetRevision: Revision;
  differences: {
    added: string[];
    removed: string[];
    modified: Array<{
      field: string;
      oldValue: any;
      newValue: any;
    }>;
  };
}
