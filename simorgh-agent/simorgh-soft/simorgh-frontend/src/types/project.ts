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
}

export interface TemplateItem {
  id: string;
  name: string;
  type: 'LV' | 'MV' | 'HV';
  properties: Record<string, string>;
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
