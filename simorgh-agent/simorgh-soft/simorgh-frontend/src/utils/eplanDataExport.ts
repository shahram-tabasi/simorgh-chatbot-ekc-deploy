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

/** The order numbers under one template property, "a + b" when there are several. */
function slotValue(parts: Record<string, any[]>, ...slots: string[]): string {
  for (const slot of slots) {
    const found = parts[slot];
    if (!found || found.length === 0) continue;
    const codes = found
      .map(p => getEplanixValue(p?.fullData) || stripLocaleTags(p?.label))
      .filter(Boolean);
    if (codes.length > 0) return codes.join(' + ');
  }
  return '';
}

/** The caption a column carries, from the TPMS column names when there are any. */
function caption(names: Record<string, string>, key: string, fallback: string): string {
  return text(names[key]) || fallback;
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

  // The captions the table header carries. A switchgear imported from TPMS
  // brings its own column names along on the template (`__displayNames`);
  // anything else falls back to the caption the app itself uses.
  const displayNames: Record<string, string> = (() => {
    for (const { template } of feeders) {
      const names = (template?.properties as any)?.__displayNames;
      if (names && typeof names === 'object') return names as Record<string, string>;
    }
    return {};
  })();

  const isMv = LAYOUT_OF[equipment.type] === 'MV';
  const cubicles = text(tpms.cellCount) || String(layout.columns.length || '');

  // Everything that is the same on every record of this switchgear.
  const common = {
    UserName: options.userName || text(data.planner) || 'simorgh',
    OE: text(data.projectNumber),
    Revision: text(options.revision),
    ProjectName: text(data.projectName),
    ScopeName: text(equipment.name),
    // The add-in knows LV, MV and HV. A GIS board is drawn as MV and an OTHER
    // one as LV — the columns they are built with (LAYOUT_OF).
    PanelType: text(LAYOUT_OF[equipment.type] ?? equipment.type),

    // ── header ──
    hBusSection:           caption(displayNames, 'BUS SECTION', 'BUS SECTION'),
    hLineNumber:           caption(displayNames, 'FEEDER NO.', 'FEEDER NO.'),
    hWiringType:           caption(displayNames, 'WIRING TYPE', 'WIRING TYPE'),
    hRatingPower:          caption(displayNames, 'RATING POWER', 'RATING POWER (kW/kVA)'),
    hFLC:                  caption(displayNames, 'FLC', 'FLC (A)'),
    hTagName:              caption(displayNames, 'TAG', 'TAG'),
    hDescription:          caption(displayNames, 'DESCRIPTION', 'DESCRIPTION'),
    hModuleNumber:         caption(displayNames, 'MODULE NO.', 'MODULE NO.'),
    hSize:                 caption(displayNames, 'SIZE', 'SIZE'),
    hSFD_HFD:              caption(displayNames, 'SFD/HFD', 'SFD/HFD'),
    hCableSize:            caption(displayNames, 'CABLE SIZE', 'CABLE SIZE'),
    hCBRating:             caption(displayNames, 'CB RATING', 'CB RATING'),
    hCBOrder:              caption(displayNames, isMv ? 'VCB OR VC/FUSE' : 'CB ORDER', isMv ? 'VCB OR VC/FUSE' : 'CB ORDER'),
    hContactorRating:      caption(displayNames, 'CONTACTOR RATING', 'CONTACTOR RATING'),
    hContactorOrder:       caption(displayNames, 'CONTACTOR. ORDER', 'CONTACTOR ORDER'),
    hOverloadRating:       caption(displayNames, 'OVER LOAD RATING', 'OVERLOAD RATING'),
    hOverloadOrder:        caption(displayNames, 'OVER LOAD RELAY', 'OVERLOAD RELAY'),
    hEarthFaultOrder:      caption(displayNames, 'EARTH FAULT', 'EARTH FAULT'),
    hCorbalanceCTOrder:    caption(displayNames, 'COREBALANCE CT', 'COREBALANCE CT'),
    hProtectionRelayOrder: caption(displayNames, 'PROTECTION RELAY', 'PROTECTION RELAY'),
    hCTRating:             caption(displayNames, 'CT RATING', 'CT RATING'),
    hAmmeterOrder:         caption(displayNames, 'AMMETER', 'AMMETER'),
    hAmmeterSelector:      caption(displayNames, 'AMMETER selector', 'AMMETER SELECTOR'),
    hPTRating:             caption(displayNames, 'PT RATING', 'PT RATING'),
    hVoltmeter:            caption(displayNames, 'VOLTMETER', 'VOLTMETER'),
    hVoltmeterSelector:    caption(displayNames, 'VOLTMETER selector', 'VOLTMETER SELECTOR'),
    hMultimeter:           caption(displayNames, 'MULTIMETER', 'MULTIMETER'),
    hTestBlock:            caption(displayNames, 'TEST BLOCK', 'TEST BLOCK'),
    hTransducer:           caption(displayNames, 'TRANSDUSER', 'TRANSDUCER'),
    hAlarmAnunnciator:     caption(displayNames, isMv ? 'ALARM WINDDOW' : 'ALARM ANUNCIATOR', 'ALARM ANUNCIATOR'),
    hVFD_Soft:             caption(displayNames, 'VFD/SOFT STARTER', 'VFD / SOFT STARTER'),
    hSurge:                caption(displayNames, 'SURGE ARRESTER', 'SURGE ARRESTER'),
    hSpare1:               caption(displayNames, 'SPARE 1', 'SPARE 1'),
    hSpare2:               caption(displayNames, 'SPARE 2', 'SPARE 2'),
    hSpare3:               caption(displayNames, 'SPARE 3', 'SPARE 3'),
    hSpare4:               caption(displayNames, 'SPARE 4', 'SPARE 4'),
    hSpare5:               caption(displayNames, 'SPARE 5', 'SPARE 5'),

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
    RevName: text(options.revName) || text(options.revisionName),
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

      // The rating columns are held on the parts themselves here, so only the
      // order numbers are stated; EPLAN reads the rating off the part.
      CBRating: '',
      CBOrder: slotValue(parts, 'CB ORDER', 'VCB OR VC/FUSE'),
      ContactorRating: '',
      ContactorOrder: slotValue(parts, 'CONTACTOR. ORDER'),
      OverloadRelayRating: '',
      OverloadRelayOrder: slotValue(parts, 'OVER LOAD RELAY'),
      EarthFaultOrder: slotValue(parts, 'EARTH FAULT'),
      CorbalanceCTOrder: slotValue(parts, 'COREBALANCE CT'),
      ProtectionRelayOrder: slotValue(parts, 'PROTECTION RELAY'),
      CTRating: slotValue(parts, 'CT RATING'),
      AmmeterOrder: slotValue(parts, 'AMMETER'),
      AmmeterSelectorOrder: slotValue(parts, 'AMMETER selector'),
      PTRating: slotValue(parts, 'PT RATING'),
      VoltmeterOrder: slotValue(parts, 'VOLTMETER'),
      VoltmeterSelectorOrder: slotValue(parts, 'VOLTMETER selector'),
      MultimeterOrder: slotValue(parts, 'MULTIMETER'),
      TestBlockOrder: slotValue(parts, 'TEST BLOCK'),
      Transducer: slotValue(parts, 'TRANSDUSER'),
      AlarmAnunciatorOrder: slotValue(parts, 'ALARM ANUNCIATOR', 'ALARM WINDDOW'),
      VFD_Soft: slotValue(parts, 'VFD/SOFT STARTER'),
      Surge: slotValue(parts, 'SURGE ARRESTER', 'VOLTAGE INDICATOR'),
      Spare1: slotValue(parts, 'SPARE 1'),
      Spare2: slotValue(parts, 'SPARE 2'),
      Spare3: slotValue(parts, 'SPARE 3'),
      Spare4: slotValue(parts, 'SPARE 4'),
      Spare5: slotValue(parts, 'SPARE 5'),
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
