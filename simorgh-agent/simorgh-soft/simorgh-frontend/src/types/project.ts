// ==============================
// Device Library Types
// ==============================

export interface DeviceLibraryProperties {
  // Electrical / Mechanical
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
  ratedInsulationVoltage?: string;
  serviceVoltage?: string;
  springChargingMotor?: string;
  switchgearLightingSpaceHeater?: string;
  motorsSpaceHeater?: string;
  ratedPowerFrequencyWithstandVoltage?: string;
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
}

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
// LV path example:
//   ['S8', 'OFW', 'FCB1', 'OUTGOING']  ← top → leaf
//   ['8PT', 'CCS']
//   ['S8', 'OFW', 'SFD']
//
// MV path is simpler:
//   ['INCOMING'] | ['COUPLING'] | ['METERING'] | ['RISER'] | ['MET&RISER'] | ['OUTGOING']
//
// `leafKind` describes what equipment family this template is for, so the
// suggestion engine can short-list templates with matching power/current.

export type TemplateLeafKind = 'motor' | 'transformer' | 'lighting' | 'other';

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
