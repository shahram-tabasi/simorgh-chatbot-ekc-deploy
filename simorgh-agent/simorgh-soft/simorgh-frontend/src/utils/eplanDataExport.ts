// src/utils/eplanDataExport.ts
//
// The project as the EPLAN add-in reads it: one `EplanData` record per feeder
// line, in the exact shape of SharedLibrary.Models.EplanData on the EPLAN
// side. The add-in gets a flat list — the project, switchboard, busbar, wire
// and drawing values are the same on every record, and the per-feeder values
// (line number, tag, size, orders) are what differ.
//
// Where each group comes from:
//
//   draft values      Device Selection rows + the parts on the template behind
//                     each row (the order numbers EPLAN places).
//   header (h*)       the table header captions — the TPMS column names when
//                     the switchgear came from TPMS, otherwise the standard
//                     captions.
//   switchboard       the Device Library entry for the switchgear (the panel
//                     specification) plus the project's Technical Settings.
//   drawing options   what the Eplanix tab is previewing (feeders per sheet)
//                     and the revision the project is on.
//
// Fields the project genuinely does not hold are sent empty rather than
// guessed — the add-in treats an empty string as "not stated".
//
// Pure: no network. `services/eplanApi.ts` does the sending.
import { ProjectData, Equipment } from '../types/project';
import { getEplanixValue, stripLocaleTags, equipmentFeeders } from './tierEquipmentMatrix';
import { buildPanelLayout } from './panelLayout';
import { buildOutline } from './outline';
import { LAYOUT_OF } from './tiers';

const text = (v: any) => (v == null ? '' : String(v).trim());

// ── The table, as Eplanix builds it ─────────────────────────────────────
//
// Everything below mirrors EplanixController (GroupAndPivotEquipment,
// TransformToEplanDataAsync, FormatHeader, FormatDualInfo) so the add-in is
// handed the same table Eplanix hands it — the same headings, the same cells
// — only filled from this project instead of from TPMS.

/** Which Eplanix equipment slot a template row is, per column layout. */
const SLOT_OF: Record<'LV' | 'MV', Record<number, string>> = {
  LV: {
    1: 'CB ORDER', 3: 'CONTACTOR. ORDER', 4: 'OVER LOAD RELAY', 5: 'EARTH FAULT',
    6: 'COREBALANCE CT', 7: 'PROTECTION RELAY', 8: 'CT RATING', 9: 'AMMETER',
    10: 'AMMETER selector', 11: 'PT RATING', 12: 'VOLTMETER', 13: 'VOLTMETER selector',
    14: 'MULTIMETER', 15: 'TEST BLOCK', 16: 'TRANSDUSER', 17: 'ALARM ANUNCIATOR',
    18: 'SPARE 6', 19: 'SPARE 7',
    20: 'SPARE 1', 21: 'SPARE 2', 22: 'SPARE 3', 23: 'SPARE 4', 24: 'SPARE 5',
  },
  MV: {
    1: 'VCB OR VC/FUSE', 5: 'VOLTAGE INDICATOR', 6: 'COREBALANCE CT', 7: 'PROTECTION RELAY',
    8: 'CT RATING', 9: 'AMMETER', 10: 'AMMETER selector', 11: 'PT RATING', 12: 'VOLTMETER',
    13: 'VOLTMETER selector', 14: 'MULTIMETER', 15: 'TEST BLOCK', 16: 'TRANSDUSER',
    17: 'ALARM WINDDOW', 19: 'SURGE ARRESTER',
    20: 'SPARE 1', 21: 'SPARE 2', 22: 'SPARE 3', 23: 'SPARE 4', 24: 'SPARE 5',
  },
};

/** The code a part is written with — the SIM-TABLE value of Create Template. */
function partCode(part: any): string {
  if (part?.simTableOverride != null && String(part.simTableOverride).trim() !== '') {
    return stripLocaleTags(part.simTableOverride);
  }
  const d = part?.fullData;
  // A TPMS part carries Eplanix's own FormatSCODE result as its order, or its
  // maker when that is all TPMS had — getEplanixValue reads it back the same.
  if (d?.__tpms) return getEplanixValue(d);
  const order = stripLocaleTags(d?.OrderNumber);
  if (order && order !== '-' && order !== '_') return order;
  return stripLocaleTags(d?.Designation3) || stripLocaleTags(part?.partNumber);
}

/** One equipment cell: "label:code * qty", one part per line, by priority. */
function slotCell(parts: Record<string, any[]>, property?: string): string {
  const list = property ? parts[property] ?? [] : [];
  return [...list]
    .sort((a, b) => (Number(a?.priority) || 0) - (Number(b?.priority) || 0))
    .map(p => {
      const label = stripLocaleTags(p?.label);
      const qty = Number(p?.quantity) || 1;
      return `${label ? `${label}:` : ''}${partCode(p)}${qty > 1 ? ` * ${qty}` : ''}`;
    })
    .filter(line => line.trim() !== '')
    .join('\n');
}

/** A part's rating, from its RATING column (Designation 3) — not for TPMS parts. */
function partRating(parts: Record<string, any[]>, property?: string): string {
  const list = property ? parts[property] ?? [] : [];
  return list
    .filter(p => !p?.fullData?.__tpms)
    .map(p => stripLocaleTags(p?.fullData?.Designation3))
    .filter(Boolean)
    .join('\n');
}

/** EplanixController.FormatHeader. */
function formatHeader(lvLabel: string, mvLabel: string, headerValue: string, panelType: 'LV' | 'MV'): string {
  const label = panelType === 'LV' ? lvLabel : mvLabel;
  if (!headerValue) return label;
  const parts = headerValue.split('-');
  const value = parts.length === 2 ? (panelType === 'LV' ? parts[0] : parts[1]) : headerValue;
  return value ? `${label}\n${value}` : '';
}

/** EplanixController.FormatDualInfo — "equipment(brand)" split onto two lines. */
function formatDualInfo(input: string, panelType: 'LV' | 'MV'): string {
  if (!input || !input.includes('(') || !input.includes(')')) return '';
  const pieces = input.split(/[()]/).filter(x => x !== '');
  if (pieces.length < 2) return '';
  const [equipmentPart, brandPart] = pieces;
  let equipment: string;
  let brand: string;
  if (equipmentPart.includes('-') && brandPart.includes('-')) {
    const e = equipmentPart.split('-');
    const b = brandPart.split('-');
    equipment = panelType === 'LV' ? (e[0] ?? '') : (e[1] ?? '');
    brand = panelType === 'LV' ? (b[0] ?? '') : (b[1] ?? '');
  } else {
    equipment = equipmentPart.trim();
    brand = brandPart.trim();
  }
  if (!equipment.trim() && !brand.trim()) return '';
  return `${equipment}\n${brand}`;
}

// The EPLAN record. Property names and casing mirror the C# model exactly —
// the add-in deserialises straight into it, so a renamed field is a dropped
// field.
export interface EplanData {
  UserName: string; Id: number;
  // draft value
  OE: string; Revision: string; ProjectName: string; ScopeName: string;
  PanelType: string; BusSection: string; LineNumber: string; WiringType: string;
  RatingPower: string; FLC: string; TagName: string; Description: string;
  ModuleNumber: string; SizeType: string; SFDHFD: string; CableSize: string;
  CBRating: string; CBOrder: string; ContactorRating: string; ContactorOrder: string;
  OverloadRelayRating: string; OverloadRelayOrder: string; EarthFaultOrder: string;
  CorbalanceCTOrder: string; ProtectionRelayOrder: string; CTRating: string;
  AmmeterOrder: string; AmmeterSelectorOrder: string; PTRating: string;
  VoltmeterOrder: string; VoltmeterSelectorOrder: string; MultimeterOrder: string;
  TestBlockOrder: string; Transducer: string; AlarmAnunciatorOrder: string;
  VFD_Soft: string; Surge: string;
  Spare1: string; Spare2: string; Spare3: string; Spare4: string; Spare5: string;
  // header
  hBusSection: string; hLineNumber: string; hWiringType: string; hRatingPower: string;
  hFLC: string; hTagName: string; hDescription: string; hModuleNumber: string;
  hSize: string; hSFD_HFD: string; hCableSize: string; hCBRating: string;
  hCBOrder: string; hContactorRating: string; hContactorOrder: string;
  hOverloadRating: string; hOverloadOrder: string; hEarthFaultOrder: string;
  hCorbalanceCTOrder: string; hProtectionRelayOrder: string; hCTRating: string;
  hAmmeterOrder: string; hAmmeterSelector: string; hPTRating: string;
  hVoltmeter: string; hVoltmeterSelector: string; hMultimeter: string;
  hTestBlock: string; hTransducer: string; hAlarmAnunnciator: string;
  hVFD_Soft: string; hSurge: string;
  hSpare1: string; hSpare2: string; hSpare3: string; hSpare4: string; hSpare5: string;
  // switchboard
  SwitchgearType: string; Standard: string;
  RatedPowerFrequencyWithstandVoltage: string; RatedImpulseWithstandVoltage: string;
  RatedVoltage: string; ServiceVoltage: string; MainBusbarRatedCurrent: string;
  ShortTimeWithstandCurrent: string; Frequency: string; SwitchboardColor: string;
  DegreeOfProtection: string; DesignTemperature: string; ConnectionInPanel: string;
  SheetThickness: string; Altitude: string;
  // type of entrance
  IncomingPanels: string; OutgoingPanels: string;
  // dimension
  Depth: string; Height: string; Width: string; NumberOfCubicle: string;
  // busbar
  Configuration: string; Coating: string; ThermofitCover: string;
  MainBusbarSize: string; NeutralBusbarSize: string; EarthBusbarSize: string;
  // auxiliary voltage
  Control_Protection_Closing_Tripping_Signalling: string;
  SpringChargingMotor: string; PanelLighting_SpaceHeater: string; MotorSpaceHeater: string;
  // wire
  ControlCircuitSize: string; CTSecondarySize: string; PTSecondarySize: string;
  DCCircuitColor: string; ACCircuitColor: string; ThreePhaseColor: string;
  EarthColor: string; PLC_Power_Supply: string; PLC_Input_Output: string;
  // drawing option
  IsSingleCompartment: boolean; FeedersPerPage: number; FeederDistance: number;
  RevName: string; PlotframeFileName: string;
  // optional props
  AdditionalProjectField1Key: string; AdditionalProjectField1Value: string;
  AdditionalProjectField2Key: string; AdditionalProjectField2Value: string;
  AdditionalProjectField3Key: string; AdditionalProjectField3Value: string;
  AdditionalPanelField1Key: string; AdditionalPanelField1Value: string;
  AdditionalPanelField2Key: string; AdditionalPanelField2Value: string;
  AdditionalPanelField3Key: string; AdditionalPanelField3Value: string;
  // outline data
  HV_Door: string; DxfOpening: string; DxfLvDoor: string; DxfBaffle: string;
  PlaneType: string; CbType: string; IsGenrateOLD: boolean; SldType: string;
  PanelWidth: string; CabelBox: boolean; PanelCableSize: string;
  LEO: boolean; LEC: boolean; LQ: boolean; IEB: boolean; ICO: boolean;
  QC1: boolean; QC2: boolean; DraftId: number; DevTotalWidth: string;
  ExhaustType: string; GenerationType: string; TotalWidth: number; CBType: string;
  ExhaustLinePosition: string; ReverseFromLineNumber: string; VentilationType: string;
  HasDampingR: boolean; CtCurrent: number; Cblabel: string; PanelAccess: string;
  LvCompartmentHeightOld: string; LvCompartmentHeightSldOld: string; BuffelType: string;
  // update / markup options
  UpdateExisting: boolean; MarkupChanged: boolean; WiringTypeChanged: boolean;
  /** Delete the project already at this path and draw it again (add-in, Eplanix bf0a6bb). */
  RecreateProject: boolean;
  // EPLAN page "User supplementary field" values, SLD and OLD kept apart
  SldPageUserSupplementaryFields: Record<string, string> | null;
  OldPageUserSupplementaryFields: Record<string, string> | null;
}

/**
 * The draft table, column by column, in the order Eplanix lays it out: each
 * column's heading field and the value field under it. A column whose heading
 * comes out empty is one Eplanix leaves out of the table.
 */
export const EPLAN_TABLE_COLUMNS: { header: keyof EplanData; value: keyof EplanData }[] = [
  { header: 'hBusSection', value: 'BusSection' },
  { header: 'hLineNumber', value: 'LineNumber' },
  { header: 'hWiringType', value: 'WiringType' },
  { header: 'hRatingPower', value: 'RatingPower' },
  { header: 'hFLC', value: 'FLC' },
  { header: 'hTagName', value: 'TagName' },
  { header: 'hDescription', value: 'Description' },
  { header: 'hModuleNumber', value: 'ModuleNumber' },
  { header: 'hSize', value: 'SizeType' },
  { header: 'hSFD_HFD', value: 'SFDHFD' },
  { header: 'hCableSize', value: 'CableSize' },
  { header: 'hCBRating', value: 'CBRating' },
  { header: 'hCBOrder', value: 'CBOrder' },
  { header: 'hContactorRating', value: 'ContactorRating' },
  { header: 'hContactorOrder', value: 'ContactorOrder' },
  { header: 'hOverloadRating', value: 'OverloadRelayRating' },
  { header: 'hOverloadOrder', value: 'OverloadRelayOrder' },
  { header: 'hEarthFaultOrder', value: 'EarthFaultOrder' },
  { header: 'hCorbalanceCTOrder', value: 'CorbalanceCTOrder' },
  { header: 'hProtectionRelayOrder', value: 'ProtectionRelayOrder' },
  { header: 'hCTRating', value: 'CTRating' },
  { header: 'hAmmeterOrder', value: 'AmmeterOrder' },
  { header: 'hAmmeterSelector', value: 'AmmeterSelectorOrder' },
  { header: 'hPTRating', value: 'PTRating' },
  { header: 'hVoltmeter', value: 'VoltmeterOrder' },
  { header: 'hVoltmeterSelector', value: 'VoltmeterSelectorOrder' },
  { header: 'hMultimeter', value: 'MultimeterOrder' },
  { header: 'hTestBlock', value: 'TestBlockOrder' },
  { header: 'hTransducer', value: 'Transducer' },
  { header: 'hAlarmAnunnciator', value: 'AlarmAnunciatorOrder' },
  { header: 'hVFD_Soft', value: 'VFD_Soft' },
  { header: 'hSurge', value: 'Surge' },
  { header: 'hSpare1', value: 'Spare1' },
  { header: 'hSpare2', value: 'Spare2' },
  { header: 'hSpare3', value: 'Spare3' },
  { header: 'hSpare4', value: 'Spare4' },
  { header: 'hSpare5', value: 'Spare5' },
];

export interface EplanDataOptions {
  /** The user the EPLAN server books the job under. */
  userName?: string;
  /** Revision number and name as the project is on, for the drawing frame. */
  revision?: string;
  revisionName?: string;
  /** Feeders per drawing sheet — what the Eplanix preview is showing. */
  feedersPerPage?: number;
  /** Refresh an existing EPLAN project instead of creating a new one. */
  updateExisting?: boolean;
  /** Delete the existing EPLAN project at this path and create it again. */
  recreateProject?: boolean;

  // ── Send to EPLAN tab — Drawing Options, mirroring Eplanix's own
  // ProjectData screen (GenerationType / *Section fields on ProjectFormViewModel).
  /** 'sld' | 'old' | 'sldold' — which drawing(s) the add-in produces. */
  generationType?: 'sld' | 'old' | 'sldold';
  isSingleCompartment?: boolean;
  feederDistance?: number;
  revName?: string;
  plotframeFileName?: string;
  exhaustType?: string;
  reverseFromLineNumber?: string;
  lvCompartmentHeightOld?: string;
  lvCompartmentHeightSldOld?: string;
  buffelType?: string;
  /** Compare against a previous revision and flag every changed feeder. */
  markupChanged?: boolean;
  /** Plotframe "User supplementary field" values, index (1-94, as a string
   *  key) → value, kept separately per drawing type. */
  sldPageUserSupplementaryFields?: Record<string, string> | null;
  oldPageUserSupplementaryFields?: Record<string, string> | null;
}

/**
 * One switchgear as a list of EplanData records — one per feeder line, in the
 * order Device Selection holds them. A switchgear with no lines yields nothing.
 */
export function buildEplanDataForEquipment(
  data: ProjectData,
  equipment: Equipment,
  options: EplanDataOptions = {},
): EplanData[] {
  const lines = equipment.devices ?? [];
  if (lines.length === 0) return [];

  // The outline: the same description of each feeder Eplanix's OutlineService
  // produces — the cell width, the doors, the floor opening, the baffle, the
  // interlocks. It is read per feeder below; only the two totals and the
  // breaker family belong to the switchgear as a whole.
  //
  // MV only, because the rules are MV rules — an HV door, a VCB truck, a pole
  // centre. Eplanix produces an outline for a MV scope and for nothing else,
  // and a LV switchgear run through them would come back with a cell width
  // nobody worked out and a door that does not exist. For those the fields
  // stay empty, which is what the add-in reads as "not stated".
  const outline = LAYOUT_OF[equipment.type] === 'MV'
    ? buildOutline(data, equipment, {
        lvCompartmentHeight: options.generationType === 'old'
          ? options.lvCompartmentHeightOld
          : options.lvCompartmentHeightSldOld,
      })
    : null;

  // The feeders exactly as the Output tab reads them — same rows, same
  // templates, same parts. Nothing here is read from anywhere but the project.
  const feeders = equipmentFeeders(data, equipment);
  const layout = buildPanelLayout(data, equipment);
  const spec = layout.spec;
  const tech = data.techSettings;
  const tpms = equipment.properties?.tpms ?? {};

  const isMv = LAYOUT_OF[equipment.type] === 'MV';
  const panelType: 'LV' | 'MV' = isMv ? 'MV' : 'LV';
  const slots = SLOT_OF[panelType];

  // The project's own column names — what TPMS's View_draft_column holds, and
  // what Eplanix reads into its headings. Kept raw on a TPMS template
  // (__columnNames); a row renamed here (__displayNames) wins over it, and a
  // template made here has only the latter.
  const headerFor = (slot: number): string => {
    const property = slots[slot];
    if (!property) return '';
    for (const { template } of feeders) {
      const props = (template?.properties ?? {}) as any;
      const raw = props.__columnNames?.[property];
      const shown = props.__displayNames?.[property];
      if (shown && (!raw || !String(raw).includes(String(shown)))) return String(shown);
      if (raw) return String(raw);
    }
    return '';
  };

  const cubicles = text(tpms.cellCount) || String(layout.columns.length || '');

  // Everything that is the same on every record of this switchgear.
  const common = {
    UserName: options.userName || text(data.planner) || 'simorgh',
    OE: text(data.projectNumber),
    Revision: text(options.revision),
    ProjectName: text(data.projectName),
    ScopeName: text(equipment.name),
    // LV or MV, as Eplanix's DeterminePanelType gives it: the add-in builds a
    // LV single line for "LV" and a MV one for anything else. GIS goes as MV
    // and OTHER as LV — the columns they are built with (LAYOUT_OF).
    PanelType: panelType,

    // ── header — EplanixController.TransformToEplanDataAsync, heading by heading ──
    hBusSection:           'BUS_SECTION',
    hLineNumber:           panelType === 'LV' ? 'FEEDER_NO' : 'LINE',
    hWiringType:           panelType === 'LV' ? 'WIRING_TYPE' : 'TYPE',
    hRatingPower:          panelType === 'LV' ? 'RATING_POWER(KW/KVA)' : 'POWER(KW OR KVA)',
    hFLC:                  'FLC(A)',
    hTagName:              'TAG',
    hDescription:          'DESCRIPTION',
    hModuleNumber:         'MODULE NO',
    hSize:                 'SIZE',
    hSFD_HFD:              'SFD/HFD',
    hCableSize:            'CABLE SIZE',
    hCBRating:             'CB RATING(A)',
    hContactorRating:      'CONTACTOR RATING(A)',
    hOverloadRating:       'OVERLOAD RATING(A)',
    hCBOrder:              formatHeader('CB ORDER', 'VCB OR VC/FUSE', headerFor(1), panelType),
    hContactorOrder:       'CONTACTOR ORDER\n' + headerFor(3),
    hOverloadOrder:        'OVERLOAD RELAY\n' + headerFor(4),
    hEarthFaultOrder:      formatHeader('EARTH FAULT', 'VOLTAGE INDICATOR', headerFor(5), panelType),
    hCorbalanceCTOrder:    formatHeader('CORBALANCE CT', 'CORBALANCE CT', headerFor(6), panelType),
    hProtectionRelayOrder: formatHeader('PROTECTION RELAY', 'PROTECTION RELAY', headerFor(7), panelType),
    hCTRating:             formatHeader('CT RATING', 'CT RATING', headerFor(8), panelType),
    hAmmeterOrder:         formatHeader('AMMETER', 'AMMETER', headerFor(9), panelType),
    hAmmeterSelector:      formatHeader('AMETER SELECTOR', 'AMETER SELECTOR', headerFor(10), panelType),
    hPTRating:             formatHeader('PT RATING', 'PT/DAMPING RESISTOR', headerFor(11), panelType),
    hVoltmeter:            formatHeader('VOLTMETER', 'VOLTMETER', headerFor(12), panelType),
    hVoltmeterSelector:    formatHeader('VOLTMETER SELECTOR', 'VOLTMETER SELECTOR', headerFor(13), panelType),
    hMultimeter:           formatHeader('MULTIMETER', 'MULTIMETER', headerFor(14), panelType),
    hTestBlock:            formatHeader('TEST BLOCK', 'TEST BOX OR BLOCK', headerFor(15), panelType),
    hTransducer:           formatHeader('TRANSDUCER', 'TRANSDUCER', headerFor(16), panelType),
    hAlarmAnunnciator:     formatHeader('ALARAM ANUNCIATOR', 'ALARM WINDDOW', headerFor(17), panelType),
    hVFD_Soft:             headerFor(18) ? 'F.C/SOFT\n' + headerFor(18) : '',
    hSurge:                formatHeader('SURGE ARRESTER', 'SURGE ARRESTER', headerFor(19), panelType),
    hSpare1:               formatDualInfo(headerFor(20), panelType),
    hSpare2:               formatDualInfo(headerFor(21), panelType),
    hSpare3:               formatDualInfo(headerFor(22), panelType),
    hSpare4:               formatDualInfo(headerFor(23), panelType),
    hSpare5:               formatDualInfo(headerFor(24), panelType),

    // ── switchboard: the Device Library panel specification ──
    SwitchgearType:                      text(tpms.switchgearType) || text(equipment.type),
    Standard:                            text(data.standard),
    RatedPowerFrequencyWithstandVoltage: text(spec.ratedPowerFrequencyWithstandVoltage),
    RatedImpulseWithstandVoltage:        text(spec.ratedImpulseWithstandVoltage),
    RatedVoltage:                        text(spec.ratedInsulationVoltage),
    ServiceVoltage:                      text(spec.serviceVoltage),
    MainBusbarRatedCurrent:              text(spec.mainBusbarRatedCurrent),
    ShortTimeWithstandCurrent:           text(spec.ratedShortTimeWithstandCurrent),
    Frequency:                           text(spec.frequency),
    SwitchboardColor:                    text(spec.ral) || text(tech?.others?.backgroundColor),
    DegreeOfProtection:                  text(spec.ip),
    DesignTemperature:                   text(tech?.general?.designTemperature),
    ConnectionInPanel:                   text(spec.switchgearArrangement),
    SheetThickness:                      text(tech?.others?.thicknessOfPainting),
    Altitude:                            text(tech?.general?.altitudeAboveSeaLevel),

    // ── type of entrance ──
    IncomingPanels: text(spec.incomingConnection),
    OutgoingPanels: text(spec.outgoingConnection),

    // ── dimension ──
    Depth:  text(spec.depth),
    Height: text(spec.height),
    Width:  text(spec.width),
    NumberOfCubicle: cubicles,

    // ── busbar ──
    Configuration:     text(spec.mainBusbarConfiguration),
    Coating:           text(spec.coating),
    ThermofitCover:    text(spec.thermoFitCover),
    MainBusbarSize:    text(spec.mainBusbarSize),
    NeutralBusbarSize: text(spec.neutralBusbarSize),
    EarthBusbarSize:   text(spec.earthBusbarSize),

    // ── auxiliary voltage ──
    Control_Protection_Closing_Tripping_Signalling: text(spec.controlProtectionClosingTrippingSignalling),
    SpringChargingMotor:       text(spec.springChargingMotor),
    PanelLighting_SpaceHeater: text(spec.switchgearLightingSpaceHeater),
    MotorSpaceHeater:          text(spec.motorsSpaceHeater),

    // ── wire ──
    ControlCircuitSize: text(tech?.wireSize?.controlCircuit),
    CTSecondarySize:    text(tech?.wireSize?.ctSecondary),
    PTSecondarySize:    text(tech?.wireSize?.ptSecondary),
    DCCircuitColor:     [tech?.wireColor?.dcPlus, tech?.wireColor?.dcMinus].filter(Boolean).join(' / '),
    ACCircuitColor:     [tech?.wireColor?.acPhase, tech?.wireColor?.acNeutral].filter(Boolean).join(' / '),
    ThreePhaseColor:    text(tech?.wireColor?.threePhase),
    EarthColor:         'Green/Yellow',
    PLC_Power_Supply:   text(tech?.wireSize?.plcPowerSupply),
    PLC_Input_Output:   [tech?.wireColor?.plcInput, tech?.wireColor?.plcOutput].filter(Boolean).join(' / '),

    // ── drawing option ──
    IsSingleCompartment: !!options.isSingleCompartment,
    FeedersPerPage: options.feedersPerPage && options.feedersPerPage > 0 ? options.feedersPerPage : 6,
    FeederDistance: options.feederDistance ?? 0,
    // Eplanix's default when the internal revision number is left empty. It is
    // part of the path EPLAN writes to, so it has to be the same one.
    RevName: text(options.revName) || '00.0',
    PlotframeFileName: text(options.plotframeFileName),

    // ── optional props — the app has no extra project/panel fields yet ──
    AdditionalProjectField1Key: '', AdditionalProjectField1Value: '',
    AdditionalProjectField2Key: '', AdditionalProjectField2Value: '',
    AdditionalProjectField3Key: '', AdditionalProjectField3Value: '',
    AdditionalPanelField1Key: '', AdditionalPanelField1Value: '',
    AdditionalPanelField2Key: '', AdditionalPanelField2Value: '',
    AdditionalPanelField3Key: '', AdditionalPanelField3Value: '',

    // ── outline data that belongs to the whole switchgear ──
    IsGenrateOLD: options.generationType === 'old' || options.generationType === 'sldold',
    DevTotalWidth: '', ExhaustType: text(options.exhaustType),
    GenerationType: options.generationType || 'sld',
    // How wide the switchgear comes out, and the breaker family it is built
    // around — the add-in places the row against these.
    TotalWidth: outline?.totalWidth ?? 0,
    CBType: outline?.cbType ?? '',
    ExhaustLinePosition: '', ReverseFromLineNumber: text(options.reverseFromLineNumber),
    PanelAccess: text(outline?.panel.access) || text(spec.switchgearAccess),
    LvCompartmentHeightOld: text(options.lvCompartmentHeightOld),
    LvCompartmentHeightSldOld: text(options.lvCompartmentHeightSldOld),
    BuffelType: text(options.buffelType),

    // ── update / markup ──
    UpdateExisting: !!options.updateExisting,
    RecreateProject: !options.updateExisting && !!options.recreateProject,
    MarkupChanged: !!options.markupChanged,
    WiringTypeChanged: false,

    SldPageUserSupplementaryFields: options.sldPageUserSupplementaryFields ?? null,
    OldPageUserSupplementaryFields: options.oldPageUserSupplementaryFields ?? null,
  };

  return feeders.map(({ row: line, parts }, index: number): EplanData => {
    // One outline record per line, in the same order — the add-in reads them
    // by position, and so does Eplanix.
    const cell = outline?.feeders[index];
    return {
      ...common,
      Id: index + 1,
      DraftId: 0,

      // ── outline data, per feeder ──
      PlaneType:   cell?.planeType ?? '',
      SldType:     cell?.sldType ?? text(LAYOUT_OF[equipment.type] ?? equipment.type),
      CbType:      cell?.cbType ?? '',
      HV_Door:     cell?.hvDoor ?? '',
      DxfOpening:  cell?.dxfOpening ?? '',
      DxfLvDoor:   cell?.dxfLvDoor ?? '',
      DxfBaffle:   cell?.dxfBaffle ?? '',
      PanelWidth:  cell?.panelWidth ?? text(spec.width),
      CabelBox:    cell?.cableBox ?? false,
      // The cable size as written, not the YES/NO the sheet shows.
      PanelCableSize: cell?.cableSize ?? '',
      LEO: cell?.leo ?? false, LEC: cell?.lec ?? false, LQ: cell?.lq ?? false,
      ICO: cell?.ico ?? false, IEB: cell?.ieb ?? false,
      QC1: cell?.qc1 ?? false, QC2: cell?.qc2 ?? false,
      VentilationType: cell?.ventilationType ?? '',
      HasDampingR: cell?.hasDampingR ?? false,
      CtCurrent:   cell?.feederCurrent ?? 0,
      Cblabel:     cell?.cbLabel ?? '',

      BusSection:  text(line.busSection),
      LineNumber:  text(line.feederNo) || String(index + 1),
      WiringType:  text(line.wiringType),
      RatingPower: text(line.ratingPower),
      FLC:         text(line.flc),
      TagName:     text(line.tag),
      Description: text(line.description),
      ModuleNumber: text(line.moduleNo),
      SizeType:    text(line.size),
      SFDHFD:      text(line.sfdHfd),
      CableSize:   text(line.cableSize),

      // The ratings TPMS gave the line when it came from there; otherwise the
      // RATING column (Designation 3) of the part that fills that slot.
      CBRating: text((line as any).cbRating) || partRating(parts, slots[1]),
      ContactorRating: text((line as any).contactorRating) || partRating(parts, slots[3]),
      OverloadRelayRating: text((line as any).overloadRating) || partRating(parts, slots[4]),
      // The equipment columns, by Eplanix's slot numbers (GetEquipmentColumn).
      // Slot 2, the accessory, has no field in EplanData — as in Eplanix.
      CBOrder: slotCell(parts, slots[1]),
      ContactorOrder: slotCell(parts, slots[3]),
      OverloadRelayOrder: slotCell(parts, slots[4]),
      EarthFaultOrder: slotCell(parts, slots[5]),
      CorbalanceCTOrder: slotCell(parts, slots[6]),
      ProtectionRelayOrder: slotCell(parts, slots[7]),
      CTRating: slotCell(parts, slots[8]),
      AmmeterOrder: slotCell(parts, slots[9]),
      AmmeterSelectorOrder: slotCell(parts, slots[10]),
      PTRating: slotCell(parts, slots[11]),
      VoltmeterOrder: slotCell(parts, slots[12]),
      VoltmeterSelectorOrder: slotCell(parts, slots[13]),
      MultimeterOrder: slotCell(parts, slots[14]),
      TestBlockOrder: slotCell(parts, slots[15]),
      Transducer: slotCell(parts, slots[16]),
      AlarmAnunciatorOrder: slotCell(parts, slots[17]),
      VFD_Soft: slotCell(parts, slots[18]),
      Surge: slotCell(parts, slots[19]),
      Spare1: slotCell(parts, slots[20]),
      Spare2: slotCell(parts, slots[21]),
      Spare3: slotCell(parts, slots[22]),
      Spare4: slotCell(parts, slots[23]),
      Spare5: slotCell(parts, slots[24]),
    };
  });
}

/** Every chosen switchgear, one flat list — what goes over the wire. */
export function buildEplanData(
  data: ProjectData,
  equipments: Equipment[],
  options: EplanDataOptions = {},
): EplanData[] {
  return equipments.flatMap(eq => buildEplanDataForEquipment(data, eq, options));
}
