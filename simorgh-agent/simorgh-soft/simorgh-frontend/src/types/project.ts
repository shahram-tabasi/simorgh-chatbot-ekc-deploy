// ==============================
// Device Library Types
// ==============================

// A sheet edited in Simorgh Draw is kept as its own geometry — see DrawingEdits.
import type { SymbolPin } from '../utils/cad/symbolFrame';
import { Shape } from '../utils/cad/shapes';
import { DrawingGroups, DrawingPage } from '../utils/cad/pages';
import { type Tier } from '../utils/tiers';

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
  /** Without / Natural / Forced — for SIMOPRIME World worked out from the
   *  cells (design catalogue table 3.7), the most demanding one. */
  ventilationType?: string;
  /** Fields the catalogue filled itself (not the engineer) — they keep
   *  following the catalogue until someone picks a value by hand. */
  catalogueAuto?: string[];
  /** The scope's own design (ambient) temperature, °C — the project's unless
   *  set otherwise. */
  designTemperature?: string;
  /** How many cells the switchgear has. */
  numberOfCells?: string;
  // Pad Lock Checkboxes
  padLockCbOnOff?: boolean;
  padLockCbTestService?: boolean;
  padLockHvDoor?: boolean;
}

export interface DeviceLibraryItem {
  id: string;
  name: string;
  type: Tier;
  properties: DeviceLibraryProperties;
  /** 'tpms' when this entry was read from TPMS rather than typed here. */
  source?: 'tpms';
  tpmsScopeId?: number;
  /** For an MV (AIS) scope: the switchgear family it is filed under —
   *  SIMOPRIME-WORLD, SIMOPRIME-A4 or EK36. */
  family?: string;
  /** SION 3AE5 breaker codes worked out for this scope, by feeder row id
   *  ('' for the switchgear as a whole) — see utils/sion3ae5. */
  breakerCodes?: Record<string, BreakerCodeRecord>;
  /** Order codes the engineer took off every breaker of this scope, though
   *  the rules add them (W66 on a project at home, for one). */
  codeOff?: string[];
  /** A cell's current as the engineer set it, by feeder row id — it beats
   *  what the row's power, name or FLC would say. */
  cellCurrents?: Record<string, number>;
  /** A cell's panel width / ventilation as the engineer set it, by feeder row
   *  id — the table's choice otherwise. */
  cellPanels?: Record<string, { width?: number; ventilation?: 'Without' | 'Natural' | 'Forced' }>;
}

/** A breaker code as it was saved: the text, every answer, the result. */
export interface BreakerCodeRecord {
  spec: string;
  /** The builder's state (utils/sion3ae5/engine SionState), kept whole. */
  state: unknown;
  code: string;
  savedAt: string;
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
  // One list per tier — see utils/tiers.ts. A project saved before GIS and
  // OTHER existed has no list for them; ProjectContext fills them in on load
  // (withAllTiers), and anything reading a snapshot directly reads `?? []`.
  templates: Record<Tier, TemplateItem[]>;
  // Device Library (new)
  deviceLibrary?: Record<Tier, DeviceLibraryItem[]>;
  devices: DeviceItem[];
  equipments: Equipment[];
  outputTypes?: OutputType[];
  /** Set on a project that came from TPMS — see TpmsSyncState. */
  tpmsSync?: TpmsSyncState;
  /** Sheets edited in Simorgh Draw — see DrawingEdits. */
  drawingEdits?: DrawingEdits;
  /** Symbols redrawn for this project — see SymbolArtOverride. */
  symbolOverrides?: Record<string, SymbolArtOverride>;
  /** The drawing set's sign-off and its reports — see DrawingDocs. */
  drawingDocs?: DrawingDocs;
  /**
   * Pages drawn by hand in Simorgh Draw — the WD / SLD / OLD set.
   *
   * Only the page's identity lives here; its geometry is in `drawingEdits`
   * under `page#<id>`, which is the same store every other sheet uses and so
   * the same thing the backup and the history already carry.
   */
  drawingPages?: DrawingPage[];
  /**
   * Headings in the page tree that hold nothing yet.
   *
   * A group is normally an accident of the pages inside it — the tree reads
   * the paths and the headings appear. That leaves nowhere to keep the group
   * somebody has just made and not filled, which would vanish between being
   * named and being used, so those live here until a page joins them.
   */
  drawingGroups?: DrawingGroups;
  /**
   * The controller's program — see `utils/plc/model.ts`.
   *
   * It lives with the project rather than in a file beside it for the same
   * reason the drawings do: a panel's logic and a panel's wiring are one
   * document in every way that matters, and a program kept somewhere else is
   * the one that is a revision behind when the job ships. Kept here it is
   * carried by the backup, the history and the revision like everything else.
   *
   * Optional, because every project that existed before this page did has no
   * program and must still open.
   */
  plc?: unknown;
}

// ── Redrawn symbols ──────────────────────────────────────────────────────────
// A symbol edited on the graphic page is kept with the project, so the office's
// own drawing of a device travels with the job rather than with the machine it
// was drawn on. It takes the place of the library's symbol everywhere that
// symbol is used, exactly as a file in the symbol pack does — the difference
// is only where it lives and how far it reaches.

// `SymbolPin` is the drawing side's idea of a connection point — a place, a
// name and the way the wire leaves it. Imported rather than restated so the
// symbol page, the library and the project all mean the same thing by it.

export interface SymbolArtOverride {
  /** The geometry, as markup with no `<svg>` around it. */
  art: string;
  /**
   * When it was saved. The office's redraw and a project's own are both kept;
   * the newer one is drawn, so a symbol corrected today replaces an older
   * project's copy instead of hiding behind it. Absent on older saves, which
   * count as older than any stamped one.
   */
  savedAt?: string;
  /** The box it is placed by, and where its conductor runs inside that box. */
  width: number;
  height: number;
  pinX: number;
  /** How many cells down the branch it takes. */
  cells: number;
  /**
   * Where a wire may land on it, in the art's own coordinates.
   *
   * Kept with the drawing because it belongs to the drawing. Before this, a
   * redrawn symbol had its connection points worked out for it — two, on the
   * conductor, at the top and bottom of whatever box the new art happened to
   * have. That is right for a breaker and wrong for everything fed from the
   * side, and it is why a wire drawn to a redrawn CT joined nothing: the
   * terminal the software had invented was somewhere up the middle of the
   * symbol, not where the office draws the tap.
   *
   * Absent on a symbol redrawn before this existed, which still has to open —
   * those fall back to the two the library would have given it.
   */
  terminals?: SymbolPin[];
  /**
   * Drawn lying on its side — the conductor across, current in on the left
   * and out on the right.
   *
   * The drawing above is still kept upright, turned a quarter back, so every
   * place that hangs a symbol on a vertical branch (the single-line sheets,
   * replacing a redrawn symbol on them) reads it exactly as before. This only
   * tells the symbol page to show it lying down and the library to place it
   * that way — what EPLAN calls the symbol's variant.
   */
  orientation?: 'horizontal';
  editedAt: string;
}

// ── The drawing set's sign-off and reports ───────────────────────────────────

/** One person in the title block: their name and, if given, their signature. */
export interface Signer {
  name?: string;
  /** A picture of the signature, as a data URL (PNG keeps its transparency). */
  sign?: string;
}

/**
 * What every page's title block carries beyond the page itself.
 *
 * Kept with the project, so a PDF printed on any machine is signed the same
 * way, and set once rather than retyped into each page's DRAWN box.
 */
export interface TitleBlockSettings {
  /** Whose drawing this is — printed in the OWNER cell. */
  company?: string;
  /** The company's logo, as a data URL. */
  logo?: string;
  drawn?: Signer;
  checked?: Signer;
  /** Shown as its own APPROVED cell only when somebody is named or signed. */
  approved?: Signer;
}

/** The reports a drawing set can carry, after EPLAN's report types. */
export type ReportKind =
  | 'title' | 'toc' | 'devices' | 'parts'
  | 'terminals' | 'strips' | 'connections'
  | 'plc' | 'plcCards'
  | 'cables' | 'revisions';

export interface DrawingDocs {
  titleBlock?: TitleBlockSettings;
  /** Which reports are generated as pages of the set, in this order. */
  reports?: ReportKind[];
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
  switchgears: { scopeId: number; scopeName: string; panelType: Tier }[];
  /** When and at which revision the suite took over. */
  detachedAt?: string;
  detachedAtRevision?: string;
  /**
   * What TPMS last delivered — the common ancestor the next read is merged
   * against.
   *
   * Without it, reading the project again overwrites every specification with
   * the value TPMS has always had, and an engineer who corrected a panel here
   * loses that correction for no reason. With it, only a field TPMS itself has
   * changed since the last read comes across; everything else is left as the
   * engineer left it.
   */
  baseline?: {
    techSettings?: Record<string, Record<string, unknown>>;
    /** Panel specification per TPMS scope id. */
    devices?: Record<string, Record<string, unknown>>;
  };
}

// ── Hierarchical template path ───────────────────────────────────────────────
// Templates are organised in a category tree the user explored when
// authoring them. This metadata lets the chatbot (and a forthcoming browser
// UI) propose similar templates that already exist at the same path.
//
// LV path example (root always first, OFW and FIX both carry one):
//   ['S8', 'FCB1', 'OUTGOING']   ← top → leaf, FIX family (FCB1-3, FCB-CAP)
//   ['8PT', 'CCS']               ← FIX family
//   ['S8', 'MOTOR']              ← OFW family
//
// MV path is the switchgear family, a cell type, and VT for the two feeders:
//   ['EK36', 'Feeder Truck', 'w VT'] | ['SIMOPRIME-A4', 'Metering'] | …
// (MV templates made before that, and GIS, have no family:
//   ['Feeder Truck', 'Circuit Breaker'] | ['Disconnector Link', 'With Fuse'] | …)
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

/**
 * A control part the offer counted for a template — the MCBs, relays and the
 * rest the quotation priced. Kept apart from the template's rows on purpose:
 * it sizes the first drawer and prices the offer, and tells the engineer later
 * what was quoted, but it is never bought and never sent to EPLAN.
 */
export interface OfferControlPart {
  partNumber: string;
  label?: string;
  /** Per feeder of the template. */
  quantity: number;
  fullData?: any;
}

export interface TemplateItem {
  id: string;
  name: string;
  type: Tier;
  properties: Record<string, string>;
  /** What the offer counted for control equipment — see OfferControlPart. */
  offerControl?: OfferControlPart[];
  /** Optional hierarchical classification used by recommendations / AI tools. */
  hierarchy?: TemplateHierarchy;
  /** 'tpms' when this template was built from a TPMS draft. */
  source?: 'tpms';
  tpmsScopeId?: number;
  /** The part set TPMS built it from — how a later read finds it again. */
  tpmsSignature?: string;
  /** The name TPMS gives it. One name is one template, whatever it is called here. */
  tpmsName?: string;
  /** Every TPMS switchgear that uses it — it goes only when all of them have. */
  tpmsScopeIds?: number[];
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
  /**
   * What the single line needs to know about the cell and cannot read from
   * its parts: the switch, the interlocks, the CT's cores and what each is
   * for, the relay's functions, what hangs on the breaker and the relay, the
   * PT truck. Asked on the template screen; see `utils/singleLineCell.ts`.
   */
  singleLine?: TemplateSingleLine;
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

/**
 * What the single line needs to know about one part of a template — asked
 * in the part's own window when it is entered, and editable after. Kept on
 * the part (`part.sld`). Every key is optional; left out, the drawing reads
 * the part as it always did.
 */
/** A signal's arrow at the foot of the cell: down (going out) or up (coming in). */
export type SignalDir = 'down' | 'up';

export interface PartSingleLine {
  /** A second part in a row: an accessory of the device above it (only its
   *  SIM-TABLE is written, under that device's), or a device of its own. */
  role?: 'main' | 'accessory';
  /** A device of its own: on the line (series) or beside it (parallel). */
  placement?: 'series' | 'parallel';
  /** A relay: the main one, which the CTs and core-balance CT go into, or an
   *  auxiliary one. */
  relayRole?: 'main' | 'auxiliary';
  /** An auxiliary relay: what it is wired to. */
  relayConnect?: 'breaker' | 'relay' | 'both';
  /** A relay's ANSI functions, written in its box in place of "PROTECTION
   *  RELAY" — "50, 50N, 51, 51N". Empty keeps the plain relay. */
  functions?: string;
  /** A relay with a serial link: a dashed line down to the foot of the cell,
   *  its text written along it. */
  serialLink?: boolean;
  serialText?: string;
  /** Which way the serial link's arrow points at the foot of the cell. */
  serialDir?: SignalDir;
  /** Status signals out of a relay or a breaker — each a dashed line down to
   *  the foot of the cell with its text along it. */
  statuses?: string[];
  /** Which way each status's arrow points at the foot of the cell, by
   *  position in `statuses`: down (out, the default) or up (in). */
  statusDirs?: SignalDir[];
  /** A CT's cores, top to bottom, and what each one feeds. */
  cores?: CtCore[];
  /** Drawn with one of the office's new symbols (its id) rather than the
   *  library's drawing of its kind — still connected as its kind is. */
  drawing?: string;
  /** A relay: everything it is wired to — 'breaker', 'relay' (the main
   *  one), or another part of the template by its key (`slot#index`), such
   *  as the alarm window. Replaces `relayConnect`, which is read when this
   *  is absent. */
  connects?: string[];
  /** The breaker: interlocked with the feeder upstream (a key interlock),
   *  and what that is written as. */
  upstreamInterlock?: boolean;
  upstreamText?: string;
  upstreamDir?: SignalDir;
  /** The breaker: the boxes stacked beside it — 94, CR, 74, 86. */
  attachments?: string[];
  /** The magnet: interlocked with the feeder downstream, and its name
   *  written along the line (OUTGOING FEEDER). False draws no line. */
  downstreamInterlock?: boolean;
  downstreamText?: string;
  downstreamDir?: SignalDir;
  /** The VT: drawn with its HRC fuses (default) or without. */
  vtFuses?: boolean;
  /** The VT on SIMOPRIME: the incoming has a PT truck — the PT after the
   *  breaker, on a socket. */
  ptTruck?: boolean;
  /** LV main switch: its trip unit's protection, and how many poles. */
  protection?: LvProtection;
  poles?: LvPoles;
}

/** What one core of a CT is for. */
export type CtCorePurpose = 'protection' | 'measurement' | 'remark';

export interface CtCore {
  purpose: CtCorePurpose;
  /** For a remark: what is written at the arrow on the end of the core. */
  text?: string;
}

/** Something that hangs on the breaker or the relay — serial, link, status. */
export interface DeviceAttachment {
  kind: 'serial' | 'link' | 'status' | 'other';
  /** What is written in its box; for `other`, the whole of it. */
  text?: string;
}

/** The single-line questions a template is asked. Every key is optional:
 *  a key left out means the drawing works it out from the parts. */
export interface TemplateSingleLine {
  /** The main switch of the cell, when the parts do not say it well. */
  switchType?: 'vcb' | 'vc-fuse' | 'none';
  /** Interlocked with the feeder below it — the magnet's line, and its text. */
  downstreamInterlock?: boolean;
  downstreamText?: string;
  /** Which way the downstream line's arrow points at the foot. */
  downstreamDir?: SignalDir;
  /** Interlocked with the feeder above it — on the key interlock's line. */
  upstreamInterlock?: boolean;
  upstreamText?: string;
  /** Which way the upstream interlock's arrow points at the foot: down (out, the default) or up (in). */
  upstreamDir?: SignalDir;
  /** The CT's cores, in order, and what each one feeds. */
  ctCores?: CtCore[];
  /** 'plain' draws only "protection relay"; 'functions' lists them. */
  relayMode?: 'plain' | 'functions';
  /** ANSI functions, comma separated: "50, 50N, 51, 51N". */
  relayFunctions?: string;
  /** What hangs on the breaker, along the key interlock's line. */
  breakerAttachments?: DeviceAttachment[];
  /** What hangs on the relay. */
  relayAttachments?: DeviceAttachment[];
  /** SIMOPRIME: the incoming has a PT truck, so the PT is drawn after the
   *  breaker, on a socket. */
  ptTruck?: boolean;
  /** The VT drawn with its HRC fuses (true) or without (false). */
  vtFuses?: boolean;
  /** Coupling: the bus section on the far side of the riser — "BUS B". */
  otherSection?: string;
  /** Riser / adaptor / busduct / cable connection: what it goes to,
   *  written at the end of its line. */
  connectedTo?: string;
  /** Neutral panel: earthed through a resistor or solidly. */
  neutralEarthing?: 'resistor' | 'solid';
  /** LV: drawn as a single line, or every conductor (multi-line). */
  lvLines?: 'single' | 'multi';
  /** LV: the system the feeder carries — single phase and neutral, three
   *  phases, or three phases and neutral. */
  phases?: LvPhases;
  /** LV multi-line: neutral and protective earth combined in one PEN
   *  conductor (TN-C) rather than drawn apart. */
  pen?: boolean;
}

export type LvPhases = '1PH+N' | '3PH' | '3PH+N';
/** An LV breaker's trip unit: overload (L), short-time (S), instantaneous
 *  (I), neutral (N), earth fault (G). */
export type LvProtection = 'L' | 'LI' | 'LSI' | 'LSIN' | 'LSIG' | 'LSING';
export type LvPoles = '1P' | '1P+N' | '2P' | '3P' | '3P+N' | '4P';

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
  // Ratings TPMS states on the draft line (cb_rating, contactor_rating,
  // overLoad_rating) — sent to EPLAN as Eplanix sends them. Absent on a row
  // made here, where the rating is the part's own.
  cbRating?: string;
  contactorRating?: string;
  overloadRating?: string;

  // ── Visual customizations ──
  rowColor?: string;                 // background color for the whole row (tailwind hex like '#fde68a')
  cellColors?: Record<string, string>; // per-column background color overrides; key = column field name
}

export interface Equipment {
  id: string;
  name: string;
  power?: string;
  type: Tier;
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
