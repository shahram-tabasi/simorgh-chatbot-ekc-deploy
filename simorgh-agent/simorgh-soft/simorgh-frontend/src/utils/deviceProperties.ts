// src/utils/deviceProperties.ts
//
// What a panel's specification is called, and what order it reads in.
//
// A DeviceLibraryItem carries its properties as a flat record of field names.
// Those names are for the code; a drawing office reads "Rated Insulation
// Voltage (V)", grouped the way the specification sheet groups it. Both the
// Device Library breakdown and the Output Types sheets read from here, so a
// field renamed once is renamed everywhere.

/** Human-readable labels for DeviceLibraryProperties fields. */
export const DEVICE_PROP_LABELS: Record<string, string> = {
  frequency:                                    'Frequency',
  mainBusbarConfiguration:                      'Main Busbar Configuration',
  mainBusbarRatedCurrent:                       'Main Busbar Rated Current (A)',
  ratedShortTimeWithstandCurrent:               'Rated Short Time Withstand Current (kA)',
  isc:                                          'ISC (kA)',
  height:                                       'Height (mm)',
  width:                                        'Width (mm)',
  depth:                                        'Depth (mm)',
  ratedImpulseWithstandVoltage:                 'Rated Impulse Withstand Voltage (kV)',
  controlProtectionClosingTrippingSignalling:   'Control / Protection / Closing / Tripping / Signalling',
  ratedInsulationVoltage:                       'Rated Insulation Voltage (V)',
  serviceVoltage:                               'Service Voltage',
  springChargingMotor:                          'Spring Charging Motor',
  switchgearLightingSpaceHeater:                'Switchgear Lighting / Space Heater',
  motorsSpaceHeater:                            'Motors Space Heater',
  ratedPowerFrequencyWithstandVoltage:          'Rated Power Frequency Withstand Voltage',
  mainBusbarSize:                               'Main Busbar Size',
  earthBusbarSize:                              'Earth Busbar Size',
  neutralBusbarSize:                            'Neutral Busbar Size',
  ral:                                          'RAL',
  incomingConnection:                           'Incoming Connection',
  outgoingConnection:                           'Outgoing Connection',
  ip:                                           'IP Rating',
  switchgearAccess:                             'Switchgear Access',
  switchgearArrangement:                        'Switchgear Arrangement',
  busbarType:                                   'Busbar Type',
  thermoFitCover:                               'Thermo-Fit Cover',
  coating:                                      'Coating',
  padLockCbOnOff:                               'Pad Lock CB On / Off',
  padLockCbTestService:                         'Pad Lock CB Test / Service',
  padLockHvDoor:                                'Pad Lock HV Door',
};

/** The specification, in the four groups the device sheet is written in. */
export const DEVICE_PROP_GROUPS: { id: string; label: string; keys: string[] }[] = [
  {
    id: 'electrical',
    label: 'Electrical / Mechanical',
    keys: [
      'ratedInsulationVoltage', 'serviceVoltage', 'ratedPowerFrequencyWithstandVoltage',
      'frequency', 'mainBusbarConfiguration', 'mainBusbarRatedCurrent',
      'ratedShortTimeWithstandCurrent', 'isc', 'height', 'width', 'depth',
      'ratedImpulseWithstandVoltage',
    ],
  },
  {
    id: 'control',
    label: 'Control & Auxiliary',
    keys: [
      'controlProtectionClosingTrippingSignalling', 'springChargingMotor',
      'switchgearLightingSpaceHeater', 'motorsSpaceHeater',
    ],
  },
  {
    id: 'busbar',
    label: 'Busbar & Construction',
    keys: [
      'mainBusbarSize', 'earthBusbarSize', 'neutralBusbarSize', 'ral',
      'incomingConnection', 'outgoingConnection', 'ip', 'switchgearAccess',
      'switchgearArrangement', 'busbarType', 'thermoFitCover', 'coating',
    ],
  },
  { id: 'padlock', label: 'Pad Locks', keys: ['padLockCbOnOff', 'padLockCbTestService', 'padLockHvDoor'] },
];

/** How many of a device's specification fields have been filled in. */
export function filledPropertyCount(properties: Record<string, unknown> | undefined): number {
  if (!properties) return 0;
  return Object.keys(DEVICE_PROP_LABELS).filter(key => {
    const value = properties[key];
    return typeof value === 'boolean' ? value : value != null && String(value).trim() !== '';
  }).length;
}

/** The whole specification, as one number, so "all filled in" can be shown. */
export const DEVICE_PROP_TOTAL = Object.keys(DEVICE_PROP_LABELS).length;
