import React, { useState, useEffect } from 'react';
import { useProject } from '../../context/ProjectContext';
import { DeviceLibraryItem, DeviceLibraryProperties, TechSettings } from '../../types/project';
import {
  findDeviceLibraryUsage, removeDeviceLibraryItemEverywhere, UsageReport,
} from '../../utils/cascadeDelete';
import { CascadeDeleteModal } from '../shared/CascadeDeleteModal';
import {
  PlusIcon, EditIcon, TrashIcon, XIcon,
  ChevronDownIcon, ChevronRightIcon, CheckIcon, SaveIcon, CopyIcon, ClipboardIcon,
  Maximize2Icon, Minimize2Icon, RefreshCwIcon, DatabaseIcon
} from 'lucide-react';
import {
  DEVICE_PROP_GROUPS, DEVICE_PROP_LABELS, DEVICE_PROP_TOTAL, filledPropertyCount,
} from '../../utils/deviceProperties';
import { readSpecUpdateFromTpms, TpmsSpecUpdate } from '../../services/tpmsSync';

// ──────────────────────────────────────────────────────────────
// Stable helper components — MUST live outside any other component
// so React never unmounts/remounts inputs during typing (focus fix)
// ──────────────────────────────────────────────────────────────
const FIELD_CLS = 'text-sm border border-gray-300 rounded px-2 py-1 w-full focus:outline-none focus:border-blue-400';
const READ_CLS  = 'text-sm text-gray-800 py-1';

interface PropFieldProps {
  label: string;
  value: string;
  isEditable: boolean;
  onChange: (v: string) => void;
}
const PropField: React.FC<PropFieldProps> = ({ label, value, isEditable, onChange }) => (
  <div className="grid grid-cols-2 gap-3 items-center py-1 border-b border-gray-50">
    <label className="text-sm text-gray-600">{label}</label>
    {isEditable
      ? <input className={FIELD_CLS} value={value} onChange={e => onChange(e.target.value)} />
      : <span className={READ_CLS}>{value || '—'}</span>
    }
  </div>
);

interface PropCheckboxProps {
  propKey: string;
  label: string;
  checked: boolean;
  isEditable: boolean;
  onChange: (v: boolean) => void;
}
const PropCheckbox: React.FC<PropCheckboxProps> = ({ propKey, label, checked, isEditable, onChange }) => (
  <div className="flex items-center gap-3 py-2">
    <input
      type="checkbox"
      id={`chk-${propKey}`}
      className="w-4 h-4 accent-blue-600"
      checked={checked}
      onChange={e => onChange(e.target.checked)}
      disabled={!isEditable}
    />
    <label htmlFor={`chk-${propKey}`} className="text-sm select-none">{label}</label>
  </div>
);

// ──────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────
type SubTab = 'project-data' | 'device-library';

const DEFAULT_TECH_SETTINGS: TechSettings = {
  general:          { altitudeAboveSeaLevel: '1000', designTemperature: '45' },
  wireSize:         { controlCircuit: '1.5', ctSecondary: '2.5', ptSecondary: '2.5', plcPowerSupply: '1.5' },
  wireColor:        { acPhase: 'Brown', dcPlus: 'Red', acNeutral: 'Blue', dcMinus: 'Black', plcInput: 'Green', plcOutput: 'Yellow', threePhase: 'Brown/Black/Grey' },
  wireManufacturer: { lv: '', mv: '' },
  others:           { thicknessOfPainting: '80', colorType: 'RAL', backgroundColor: '7035', writingColor: '9005' },
};

// ──────────────────────────────────────────────────────────────
// Device Properties Modal
// ──────────────────────────────────────────────────────────────
type ModalMode = 'view' | 'edit' | 'add';

interface DevicePropertiesModalProps {
  item:      DeviceLibraryItem | null;
  mode:      ModalMode;
  addType?:  'LV' | 'MV' | 'HV';
  onSave:    (item: DeviceLibraryItem) => void;
  onClose:   () => void;
}

const DevicePropertiesModal: React.FC<DevicePropertiesModalProps> = ({
  item, mode: initialMode, addType, onSave, onClose
}) => {
  const [mode,  setMode]  = useState<ModalMode>(initialMode);
  const [name,  setName]  = useState(item?.name ?? '');
  const [type,  setType]  = useState<'LV' | 'MV' | 'HV'>(item?.type ?? addType ?? 'LV');
  const [props, setProps] = useState<DeviceLibraryProperties>(item?.properties ?? {});
  const [activeSection, setActiveSection] = useState<'electrical' | 'control' | 'busbar' | 'padlock'>('electrical');
  // A panel specification is a long form; full screen gives it the whole
  // window (and two columns of fields) instead of a 760px dialog.
  const [fullScreen, setFullScreen] = useState(false);

  const setProp = (key: keyof DeviceLibraryProperties, value: string | boolean) =>
    setProps(prev => ({ ...prev, [key]: value }));

  // F11 toggles full screen, Esc steps back out of it before it closes the
  // dialog — so leaving full screen never loses what was typed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F11') { e.preventDefault(); setFullScreen(v => !v); }
      if (e.key === 'Escape' && fullScreen) { e.preventDefault(); setFullScreen(false); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fullScreen]);

  const isEditable = mode !== 'view';

  const handleSave = () => {
    if (!name.trim()) return;
    onSave({ id: item?.id ?? `dev-${Date.now()}`, name: name.trim(), type, properties: props });
  };

  // PropField and PropCheckbox are defined at module level to prevent focus loss

  const typeColor = type === 'LV' ? 'bg-green-100 text-green-700'
    : type === 'MV' ? 'bg-orange-100 text-orange-700'
    : 'bg-red-100 text-red-700';

  const sections = [
    { id: 'electrical' as const, label: 'Electrical / Mechanical' },
    { id: 'control'    as const, label: 'Control & Auxiliary' },
    { id: 'busbar'     as const, label: 'Busbar & Construction' },
    { id: 'padlock'    as const, label: 'Pad Lock' },
  ];

  return (
    <div className={`fixed inset-0 bg-black bg-opacity-50 flex z-50 ${
      fullScreen ? 'p-0' : 'items-center justify-center'
    }`}>
      <div className={`bg-white shadow-2xl flex flex-col ${
        fullScreen
          ? 'w-screen h-screen rounded-none'
          : 'rounded-lg w-[760px] max-h-[92vh]'
      }`}>

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-3">
            <h3 className="font-semibold text-lg">
              {mode === 'add' ? 'Add Device to Library' : name}
            </h3>
            {mode !== 'add' && (
              <span className={`text-xs px-2 py-0.5 rounded font-semibold ${typeColor}`}>{type}</span>
            )}
          </div>
          <div className="flex gap-2">
            {mode === 'view' && (
              <button
                className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm flex items-center gap-1 hover:bg-blue-700"
                onClick={() => setMode('edit')}
              >
                <EditIcon className="w-3 h-3" /> Edit
              </button>
            )}
            <button
              className="p-1 hover:bg-gray-100 rounded"
              onClick={() => setFullScreen(v => !v)}
              title={fullScreen ? 'Exit full screen (F11)' : 'Full screen (F11)'}
            >
              {fullScreen
                ? <Minimize2Icon className="w-5 h-5 text-gray-500" />
                : <Maximize2Icon className="w-5 h-5 text-gray-500" />}
            </button>
            <button className="p-1 hover:bg-gray-100 rounded" onClick={onClose} title="Close">
              <XIcon className="w-5 h-5 text-gray-500" />
            </button>
          </div>
        </div>

        {/* ── Name / Type row (add or edit) ── */}
        {isEditable && (
          <div className="px-6 py-3 border-b bg-gray-50 flex gap-4 flex-wrap">
            <div className="flex items-center gap-2 flex-1 min-w-48">
              <label className="text-sm font-medium whitespace-nowrap">Name:</label>
              <input
                type="text"
                className="border border-gray-300 rounded px-2 py-1 text-sm flex-1"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Device name"
                autoFocus={mode === 'add'}
              />
            </div>
            {mode === 'add' && (
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium">Type:</label>
                <select
                  className="border border-gray-300 rounded px-2 py-1 text-sm"
                  value={type}
                  onChange={e => setType(e.target.value as 'LV' | 'MV' | 'HV')}
                >
                  <option value="LV">LV – Low Voltage</option>
                  <option value="MV">MV – Medium Voltage</option>
                  <option value="HV">HV – High Voltage</option>
                </select>
              </div>
            )}
          </div>
        )}

        {/* ── Section tabs ── */}
        <div className="flex border-b px-4 gap-0">
          {sections.map(sec => (
            <button
              key={sec.id}
              className={`px-4 py-2.5 text-sm border-b-2 -mb-px transition-colors ${
                activeSection === sec.id
                  ? 'border-blue-600 text-blue-600 font-medium'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
              onClick={() => setActiveSection(sec.id)}
            >
              {sec.label}
            </button>
          ))}
        </div>

        {/* ── Section content ── */}
        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
          {activeSection === 'electrical' && (
            <div className={fullScreen ? 'grid grid-cols-2 gap-x-10' : ''}>
              <PropField label="Rated Insulation Voltage"              value={props.ratedInsulationVoltage ?? ''}              isEditable={isEditable} onChange={v => setProp('ratedInsulationVoltage', v)} />
              <PropField label="Service Voltage"                       value={props.serviceVoltage ?? ''}                       isEditable={isEditable} onChange={v => setProp('serviceVoltage', v)} />
              <PropField label="Rated Power-Frequency Withstand Voltage" value={props.ratedPowerFrequencyWithstandVoltage ?? ''} isEditable={isEditable} onChange={v => setProp('ratedPowerFrequencyWithstandVoltage', v)} />
              <PropField label="Frequency"                              value={props.frequency ?? ''}                              isEditable={isEditable} onChange={v => setProp('frequency', v)} />
              <PropField label="Main Busbar Configuration"             value={props.mainBusbarConfiguration ?? ''}             isEditable={isEditable} onChange={v => setProp('mainBusbarConfiguration', v)} />
              <PropField label="Main Busbar Rated Current"             value={props.mainBusbarRatedCurrent ?? ''}             isEditable={isEditable} onChange={v => setProp('mainBusbarRatedCurrent', v)} />
              <PropField label="Rated Short Time Withstand Current"    value={props.ratedShortTimeWithstandCurrent ?? ''}    isEditable={isEditable} onChange={v => setProp('ratedShortTimeWithstandCurrent', v)} />
              <PropField label="Isc"                                   value={props.isc ?? ''}                                   isEditable={isEditable} onChange={v => setProp('isc', v)} />
              <PropField label="Height (mm)"                           value={props.height ?? ''}                           isEditable={isEditable} onChange={v => setProp('height', v)} />
              <PropField label="Width (mm)"                            value={props.width ?? ''}                            isEditable={isEditable} onChange={v => setProp('width', v)} />
              <PropField label="Depth (mm)"                            value={props.depth ?? ''}                            isEditable={isEditable} onChange={v => setProp('depth', v)} />
              <PropField label="Rated Impulse Withstand Voltage"       value={props.ratedImpulseWithstandVoltage ?? ''}       isEditable={isEditable} onChange={v => setProp('ratedImpulseWithstandVoltage', v)} />
            </div>
          )}
          {/* The three voltages that used to sit here now open the
              Electrical / Mechanical tab — they belong with the ratings. */}
          {activeSection === 'control' && (
            <div className={fullScreen ? 'grid grid-cols-2 gap-x-10' : ''}>
              <PropField label="Control, Protection, Closing, Tripping & Signalling" value={props.controlProtectionClosingTrippingSignalling ?? ''} isEditable={isEditable} onChange={v => setProp('controlProtectionClosingTrippingSignalling', v)} />
              <PropField label="Spring Charging Motor"                 value={props.springChargingMotor ?? ''}                 isEditable={isEditable} onChange={v => setProp('springChargingMotor', v)} />
              <PropField label="Switchgear Lighting & Space Heater"    value={props.switchgearLightingSpaceHeater ?? ''}    isEditable={isEditable} onChange={v => setProp('switchgearLightingSpaceHeater', v)} />
              <PropField label="Motors Space Heater"                   value={props.motorsSpaceHeater ?? ''}                   isEditable={isEditable} onChange={v => setProp('motorsSpaceHeater', v)} />
            </div>
          )}
          {activeSection === 'busbar' && (
            <div className={fullScreen ? 'grid grid-cols-2 gap-x-10' : ''}>
              <PropField label="Main Busbar Size"       value={props.mainBusbarSize ?? ''}       isEditable={isEditable} onChange={v => setProp('mainBusbarSize', v)} />
              <PropField label="Earth Busbar Size"      value={props.earthBusbarSize ?? ''}      isEditable={isEditable} onChange={v => setProp('earthBusbarSize', v)} />
              <PropField label="Neutral Busbar Size"    value={props.neutralBusbarSize ?? ''}    isEditable={isEditable} onChange={v => setProp('neutralBusbarSize', v)} />
              <PropField label="RAL"                    value={props.ral ?? ''}                    isEditable={isEditable} onChange={v => setProp('ral', v)} />
              <PropField label="Incoming Connection"    value={props.incomingConnection ?? ''}    isEditable={isEditable} onChange={v => setProp('incomingConnection', v)} />
              <PropField label="Outgoing Connection"    value={props.outgoingConnection ?? ''}    isEditable={isEditable} onChange={v => setProp('outgoingConnection', v)} />
              <PropField label="IP"                     value={props.ip ?? ''}                     isEditable={isEditable} onChange={v => setProp('ip', v)} />
              <PropField label="Switchgear Access"      value={props.switchgearAccess ?? ''}      isEditable={isEditable} onChange={v => setProp('switchgearAccess', v)} />
              <PropField label="Switchgear Arrangement" value={props.switchgearArrangement ?? ''} isEditable={isEditable} onChange={v => setProp('switchgearArrangement', v)} />
              <PropField label="Busbar Type"            value={props.busbarType ?? ''}            isEditable={isEditable} onChange={v => setProp('busbarType', v)} />
              <PropField label="Thermofit Cover"        value={props.thermoFitCover ?? ''}        isEditable={isEditable} onChange={v => setProp('thermoFitCover', v)} />
              <PropField label="Coating"                value={props.coating ?? ''}                isEditable={isEditable} onChange={v => setProp('coating', v)} />
            </div>
          )}
          {activeSection === 'padlock' && (
            <div className="pt-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Pad Lock Options</p>
              <div className="space-y-1 pl-2">
                <PropCheckbox propKey="padLockCbOnOff"      label="C.B ON / OFF"      checked={!!props.padLockCbOnOff}      isEditable={isEditable} onChange={v => setProp('padLockCbOnOff', v)} />
                <PropCheckbox propKey="padLockCbTestService" label="C.B Test / Service" checked={!!props.padLockCbTestService} isEditable={isEditable} onChange={v => setProp('padLockCbTestService', v)} />
                <PropCheckbox propKey="padLockHvDoor"        label="HV Door"            checked={!!props.padLockHvDoor}        isEditable={isEditable} onChange={v => setProp('padLockHvDoor', v)} />
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t bg-gray-50">
          <button className="px-4 py-2 border rounded text-sm hover:bg-gray-100" onClick={onClose}>
            Close
          </button>
          {isEditable && (
            <button
              className="px-4 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-700 flex items-center gap-1"
              onClick={handleSave}
            >
              <SaveIcon className="w-4 h-4" /> Save
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────
// Main Component
// ──────────────────────────────────────────────────────────────
interface ProjectDefinitionTabProps {
  onComplete:        () => void;
  requestedSubTab?:  SubTab;
  requestedDeviceId?: string; // auto-open this device in edit mode from DeviceSelection
}

export const ProjectDefinitionTab: React.FC<ProjectDefinitionTabProps> = ({
  onComplete, requestedSubTab, requestedDeviceId
}) => {
  const {
    projectData, updateProjectData,
    selectedEquipment, setSelectedEquipment,
  } = useProject();

  const [activeSubTab,       setActiveSubTab]       = useState<SubTab>('project-data');
  const [projectNameEditing, setProjectNameEditing] = useState(false);
  const [expandedTypes,      setExpandedTypes]      = useState<Set<string>>(new Set(['LV', 'MV', 'HV']));

  const [ctxMenu, setCtxMenu] = useState<{
    visible: boolean; x: number; y: number;
    typeNode: 'LV' | 'MV' | 'HV' | null;
    itemId:   string | null;
  }>({ visible: false, x: 0, y: 0, typeNode: null, itemId: null });

  // Which devices in the library have their specification open. The breakdown
  // is the point of this screen for a project that came from TPMS: the panels
  // arrive named and empty, and the engineer fills them in from here.
  const [expandedDevices, setExpandedDevices] = useState<Set<string>>(new Set());

  // Reading the specifications from TPMS again. Nothing is written until the
  // engineer has seen what would change.
  const [tpmsUpdate, setTpmsUpdate] = useState<{
    busy: boolean; progress: string;
    result: TpmsSpecUpdate | null; error: string | null;
  }>({ busy: false, progress: '', result: null, error: null });

  const [copiedDevice, setCopiedDevice] = useState<DeviceLibraryItem | null>(null);
  const [pasteNameModal, setPasteNameModal] = useState<{
    visible: boolean; targetType: 'LV' | 'MV' | 'HV' | null; suggestedName: string;
  }>({ visible: false, targetType: null, suggestedName: '' });

  const [deviceModal, setDeviceModal] = useState<{
    visible:  boolean;
    item:     DeviceLibraryItem | null;
    mode:     ModalMode;
    addType?: 'LV' | 'MV' | 'HV';
  }>({ visible: false, item: null, mode: 'add' });

  // Pending Device Library deletion — held until the user confirms in the
  // cascade dialog, which lists everywhere the device is used.
  const [libDeleteTarget, setLibDeleteTarget] = useState<{
    item: DeviceLibraryItem; type: 'LV' | 'MV' | 'HV'; usage: UsageReport;
  } | null>(null);

  // Navigate here from DeviceSelection → Device Library
  useEffect(() => {
    if (requestedSubTab) setActiveSubTab(requestedSubTab);
  }, [requestedSubTab]);

  // Auto-open a specific device in edit mode when navigated from DeviceSelection
  useEffect(() => {
    if (requestedDeviceId && requestedSubTab === 'device-library') {
      const library = projectData.deviceLibrary ?? { LV: [], MV: [], HV: [] };
      for (const t of ['LV', 'MV', 'HV'] as const) {
        const found = (library[t] ?? []).find(d => d.id === requestedDeviceId);
        if (found) {
          setDeviceModal({ visible: true, item: found, mode: 'edit' });
          break;
        }
      }
    }
  }, [requestedDeviceId, requestedSubTab]);

  // Close context menu on outside click
  useEffect(() => {
    const close = () => setCtxMenu(prev => ({ ...prev, visible: false }));
    if (ctxMenu.visible) {
      document.addEventListener('click', close);
      return () => document.removeEventListener('click', close);
    }
  }, [ctxMenu.visible]);

  const techSettings  = projectData.techSettings  ?? DEFAULT_TECH_SETTINGS;
  const deviceLibrary = projectData.deviceLibrary ?? { LV: [], MV: [], HV: [] };

  // ── helpers ──────────────────────────────────────────────────
  const setMain  = (field: string, val: string)  => updateProjectData({ [field]: val });
  const setTech  = (section: keyof TechSettings, field: string, val: string) =>
    updateProjectData({
      techSettings: {
        ...techSettings,
        [section]: { ...(techSettings[section] as Record<string,string>), [field]: val }
      }
    });

  // ── Device Library CRUD ──────────────────────────────────────
  const addLib = (item: DeviceLibraryItem) => {
    updateProjectData({
      deviceLibrary: {
        ...deviceLibrary,
        [item.type]: [...(deviceLibrary[item.type] ?? []), item]
      }
    });
    closeDeviceModal();
  };

  const updateLib = (item: DeviceLibraryItem) => {
    updateProjectData({
      deviceLibrary: {
        ...deviceLibrary,
        [item.type]: (deviceLibrary[item.type] ?? []).map(d => d.id === item.id ? item : d)
      }
    });
    closeDeviceModal();
  };

  // Deleting from the Device Library is the "delete everywhere" direction:
  // the entry disappears from the library AND from the Device Selection tree
  // — the equipment created from it and every row that equipment holds go
  // with it. The user sees exactly what will be removed first.
  const deleteLib = (id: string, t: 'LV' | 'MV' | 'HV') => {
    const item = (deviceLibrary[t] ?? []).find(d => d.id === id);
    if (!item) return;
    setLibDeleteTarget({ item, type: t, usage: findDeviceLibraryUsage(projectData, id, t) });
  };

  const confirmDeleteLib = () => {
    if (!libDeleteTarget) return;
    const { item, type, usage } = libDeleteTarget;

    // Drop the selection first if it points at an equipment about to vanish.
    if (selectedEquipment && usage.equipments.some(eq => eq.id === selectedEquipment.id)) {
      setSelectedEquipment(null);
    }
    updateProjectData(removeDeviceLibraryItemEverywhere(projectData, item.id, type));
    setLibDeleteTarget(null);
  };

  // ── Reading the specifications from TPMS again ───────────────────────
  //
  // The project was opened from TPMS and the engineer has been working in it
  // since: specifications entered, templates defined, panels built up in
  // Device Selection. Meanwhile TPMS may have corrected a rated voltage or an
  // IP class. This brings those corrections across and leaves everything else
  // exactly as it is — a field the engineer changed is never overwritten by a
  // value TPMS has not moved. What would change is listed first.
  const tpmsLink = projectData.tpmsSync;

  const runTpmsUpdate = async () => {
    setTpmsUpdate({ busy: true, progress: 'Reading the project from TPMS…', result: null, error: null });
    try {
      const result = await readSpecUpdateFromTpms(
        projectData, message => setTpmsUpdate(prev => ({ ...prev, progress: message })));
      setTpmsUpdate({ busy: false, progress: '', result, error: null });
    } catch (err) {
      setTpmsUpdate({ busy: false, progress: '', result: null, error: (err as Error).message });
    }
  };

  const applyTpmsUpdate = () => {
    if (tpmsUpdate.result) updateProjectData(tpmsUpdate.result.patch);
    setTpmsUpdate({ busy: false, progress: '', result: null, error: null });
  };

  const closeTpmsUpdate = () => setTpmsUpdate({ busy: false, progress: '', result: null, error: null });

  // What TPMS said about a panel beyond its ratings: the switchgear it is, how
  // many cells, its tag. It rides on the equipment, which is where the import
  // puts it, so the breakdown can show it beside the specification.
  const tpmsFactsFor = (item: DeviceLibraryItem) => {
    const equipment = (projectData.equipments ?? []).find(
      eq => eq.properties?.deviceLibraryItemId === item.id ||
        (item.tpmsScopeId != null && (eq.properties?.tpms as any)?.scopeId === item.tpmsScopeId));
    const tpms = (equipment?.properties?.tpms ?? {}) as Record<string, any>;
    return {
      equipment,
      switchgearType: String(tpms.switchgearType ?? equipment?.description ?? ''),
      cellCount: String(tpms.cellCount ?? ''),
      rows: equipment?.devices?.length ?? 0,
    };
  };

  const toggleDevice = (id: string) => {
    const next = new Set(expandedDevices);
    next.has(id) ? next.delete(id) : next.add(id);
    setExpandedDevices(next);
  };

  const closeDeviceModal = () => setDeviceModal({ visible: false, item: null, mode: 'add' });
  const handleDeviceSave = (item: DeviceLibraryItem) =>
    deviceModal.mode === 'add' ? addLib(item) : updateLib(item);

  const handlePasteDevice = (newName: string) => {
    if (!copiedDevice || !pasteNameModal.targetType) return;
    const pasted: DeviceLibraryItem = {
      ...copiedDevice,
      id:   `lib-${Date.now()}`,
      name: newName.trim() || `${copiedDevice.name} (Copy)`,
      type: pasteNameModal.targetType
    };
    addLib(pasted);
    setPasteNameModal({ visible: false, targetType: null, suggestedName: '' });
  };

  const typeColor = (t: 'LV' | 'MV' | 'HV') =>
    t === 'LV' ? 'text-green-600 bg-green-50'
    : t === 'MV' ? 'text-orange-600 bg-orange-50'
    : 'text-red-600 bg-red-50';

  // ── Style shortcuts ──────────────────────────────────────────
  const inp   = 'col-span-2 border border-gray-300 rounded px-2 py-1 text-sm';
  const secHd = 'text-xs font-bold uppercase tracking-wide text-gray-500 mt-5 mb-2 pb-1 border-b border-gray-200';

  // ── Render: Technical Settings ────────────────────────────────
  const renderTechSettings = () => (
    <div className="border border-gray-200 rounded-md p-4">
      <h2 className="text-lg font-semibold mb-2">Technical Settings</h2>

      <p className={secHd}>General</p>
      <div className="space-y-3">
        {[['Altitude Above Sea Level (m)', 'altitudeAboveSeaLevel'], ['Design Temperature (°C)', 'designTemperature']].map(([label, key]) => (
          <div key={key} className="grid grid-cols-3 gap-4 items-center">
            <label className="text-sm">{label}:</label>
            <input className={inp} value={(techSettings.general as Record<string,string>)[key] ?? ''} onChange={e => setTech('general', key, e.target.value)} />
          </div>
        ))}
      </div>

      <p className={secHd}>Wire Size *</p>
      <div className="space-y-3">
        {[['Control Circuit', 'controlCircuit'], ['CT Secondary', 'ctSecondary'], ['PT Secondary', 'ptSecondary'], ['PLC Power Supply', 'plcPowerSupply']].map(([label, key]) => (
          <div key={key} className="grid grid-cols-3 gap-4 items-center">
            <label className="text-sm">{label}:</label>
            <input className={inp} value={(techSettings.wireSize as Record<string,string>)[key] ?? ''} onChange={e => setTech('wireSize', key, e.target.value)} />
          </div>
        ))}
      </div>

      <p className={secHd}>Wire Color *</p>
      <div className="space-y-3">
        {[['AC Phase', 'acPhase'], ['DC +', 'dcPlus'], ['AC Neutral', 'acNeutral'], ['DC –', 'dcMinus'], ['PLC Input', 'plcInput'], ['PLC Output', 'plcOutput'], ['3 Phase', 'threePhase']].map(([label, key]) => (
          <div key={key} className="grid grid-cols-3 gap-4 items-center">
            <label className="text-sm">{label}:</label>
            <input className={inp} value={(techSettings.wireColor as Record<string,string>)[key] ?? ''} onChange={e => setTech('wireColor', key, e.target.value)} />
          </div>
        ))}
      </div>

      <p className={secHd}>Wire / Cable Manufacturer *</p>
      <div className="space-y-3">
        {[['LV', 'lv'], ['MV', 'mv']].map(([label, key]) => (
          <div key={key} className="grid grid-cols-3 gap-4 items-center">
            <label className="text-sm">{label}:</label>
            <input className={inp} value={(techSettings.wireManufacturer as Record<string,string>)[key] ?? ''} onChange={e => setTech('wireManufacturer', key, e.target.value)} />
          </div>
        ))}
      </div>

      <p className={secHd}>Others</p>
      <div className="space-y-3">
        {[['Thickness of Painting (μm)', 'thicknessOfPainting'], ['Color Type', 'colorType'], ['Background Color', 'backgroundColor'], ['Writing Color', 'writingColor']].map(([label, key]) => (
          <div key={key} className="grid grid-cols-3 gap-4 items-center">
            <label className="text-sm">{label}:</label>
            <input className={inp} value={(techSettings.others as Record<string,string>)[key] ?? ''} onChange={e => setTech('others', key, e.target.value)} />
          </div>
        ))}
      </div>
    </div>
  );

  // ── Render: Project Data tab ──────────────────────────────────
  const renderProjectData = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* ── Left col ── */}
      <div className="space-y-6">
        {/* Master Data */}
        <div className="border border-gray-200 rounded-md p-4">
          <h2 className="text-lg font-semibold mb-4">Master Data</h2>
          <div className="space-y-3">

            {/* Project Name with lock/edit toggle */}
            <div className="grid grid-cols-3 gap-4 items-center">
              <label className="text-sm">Project name:</label>
              <div className="col-span-2 flex items-center gap-2">
                {projectNameEditing ? (
                  <>
                    <input
                      type="text"
                      className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm"
                      value={projectData.projectName}
                      onChange={e => setMain('projectName', e.target.value)}
                      autoFocus
                      onKeyDown={e => { if (e.key === 'Enter') setProjectNameEditing(false); }}
                    />
                    <button
                      className="p-1 text-green-600 hover:bg-green-50 rounded"
                      title="Confirm name"
                      onClick={() => setProjectNameEditing(false)}
                    >
                      <CheckIcon className="w-4 h-4" />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-sm font-medium py-1 px-2 bg-gray-50 border border-gray-200 rounded truncate">
                      {projectData.projectName}
                    </span>
                    <button
                      className="p-1 text-gray-500 hover:bg-gray-100 rounded"
                      title="Edit project name"
                      onClick={() => setProjectNameEditing(true)}
                    >
                      <EditIcon className="w-4 h-4" />
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4 items-center">
              <label className="text-sm">Project ID (PID):</label>
              <input type="text" className={inp} value={projectData.projectId ?? ''} onChange={e => setMain('projectId', e.target.value)} />
            </div>
            <div className="grid grid-cols-3 gap-4 items-center">
              <label className="text-sm">Project Number (OE):</label>
              <input type="text" className={inp} value={projectData.projectNumber ?? ''} onChange={e => setMain('projectNumber', e.target.value)} />
            </div>
            <div className="grid grid-cols-3 gap-4 items-center">
              <label className="text-sm">Project description:</label>
              <input type="text" className={inp} value={projectData.projectDescription} onChange={e => setMain('projectDescription', e.target.value)} />
            </div>
            <div className="grid grid-cols-3 gap-4 items-center">
              <label className="text-sm">Client:</label>
              <input type="text" className={inp} value={projectData.client} onChange={e => setMain('client', e.target.value)} />
            </div>
            <div className="grid grid-cols-3 gap-4 items-center">
              <label className="text-sm">Notice to Proceed Date:</label>
              <input type="date" className={inp} value={projectData.noticeToProceedDate ?? ''} onChange={e => setMain('noticeToProceedDate', e.target.value)} />
            </div>
            <div className="grid grid-cols-3 gap-4 items-center">
              <label className="text-sm">Delivery Date:</label>
              <input type="date" className={inp} value={projectData.deliveryDate ?? ''} onChange={e => setMain('deliveryDate', e.target.value)} />
            </div>
            <div className="grid grid-cols-3 gap-4 items-center">
              <label className="text-sm">Planner:</label>
              <input type="text" className={inp} value={projectData.planner} onChange={e => setMain('planner', e.target.value)} />
            </div>
            <div className="grid grid-cols-3 gap-4 items-center">
              <label className="text-sm">Design office:</label>
              <input type="text" className={inp} value={projectData.designOffice} onChange={e => setMain('designOffice', e.target.value)} />
            </div>
            <div className="grid grid-cols-3 gap-4 items-center">
              <label className="text-sm">Created on:</label>
              <div className="col-span-2 text-sm text-gray-500">{projectData.createdOn}</div>
            </div>
            <div className="grid grid-cols-3 gap-4 items-center">
              <label className="text-sm">Changed on:</label>
              <div className="col-span-2 text-sm text-gray-500">{projectData.changedOn}</div>
            </div>
          </div>
        </div>

        {/* Location */}
        <div className="border border-gray-200 rounded-md p-4">
          <h2 className="text-lg font-semibold mb-4">Location</h2>
          <div className="grid grid-cols-3 gap-4 items-center">
            <label className="text-sm">Location:</label>
            <input type="text" className={inp} value={projectData.location} onChange={e => setMain('location', e.target.value)} />
          </div>
        </div>

        {/* Regional Settings */}
        <div className="border border-gray-200 rounded-md p-4">
          <h2 className="text-lg font-semibold mb-4">Regional Settings</h2>
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-4 items-center">
              <label className="text-sm">Standard:</label>
              <select className={inp} value={projectData.standard} onChange={e => setMain('standard', e.target.value)}>
                <option value="IEC">IEC</option>
                <option value="ANSI">ANSI</option>
                <option value="GB">GB</option>
              </select>
            </div>
            <div className="grid grid-cols-3 gap-4 items-center">
              <label className="text-sm">Country:</label>
              <select className={inp} value={projectData.country} onChange={e => setMain('country', e.target.value)}>
                <option value="iranin">Iran</option>
                <option value="United States">United States</option>
                <option value="Germany">Germany</option>
                <option value="France">France</option>
                <option value="China">China</option>
              </select>
            </div>
            <div className="grid grid-cols-3 gap-4 items-center">
              <label className="text-sm">Language:</label>
              <select className={inp} value={projectData.language} onChange={e => setMain('language', e.target.value)}>
                <option value="persian">Persian</option>
                <option value="English">English</option>
              </select>
            </div>
          </div>
        </div>

        {/* Comment */}
        <div className="border border-gray-200 rounded-md p-4">
          <h2 className="text-lg font-semibold mb-4">Comment</h2>
          <textarea
            className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
            rows={4}
            value={projectData.comment}
            onChange={e => setMain('comment', e.target.value)}
          />
        </div>
      </div>

      {/* ── Right col: Technical Settings ── */}
      <div>{renderTechSettings()}</div>
    </div>
  );

  // ── Render: Device Library tab ────────────────────────────────
  // One device, broken out: what TPMS knows about the panel, then the whole
  // specification group by group — the fields that are filled in and the ones
  // still to enter, because a blank the engineer cannot see is a blank that
  // never gets filled.
  const renderDeviceBreakdown = (item: DeviceLibraryItem) => {
    const facts = tpmsFactsFor(item);
    const props = (item.properties ?? {}) as Record<string, any>;
    const show = (key: string) => {
      const value = props[key];
      if (typeof value === 'boolean') return value ? 'Yes' : 'No';
      return value == null || String(value).trim() === '' ? '' : String(value);
    };

    return (
      <div className="pl-12 pr-4 py-3 border-b bg-gray-50/70">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-gray-600 mb-3">
          {facts.switchgearType && <span><span className="text-gray-400">Switchgear</span> <strong>{facts.switchgearType}</strong></span>}
          {facts.cellCount && <span><span className="text-gray-400">Cells</span> <strong>{facts.cellCount}</strong></span>}
          <span><span className="text-gray-400">Feeders</span> <strong>{facts.rows}</strong></span>
          {item.tpmsScopeId != null && <span><span className="text-gray-400">TPMS scope</span> <strong>{item.tpmsScopeId}</strong></span>}
          <button
            className="ml-auto px-2.5 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center gap-1"
            onClick={() => setDeviceModal({ visible: true, item, mode: 'edit' })}
          >
            <EditIcon className="w-3 h-3" /> Enter specification
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8">
          {DEVICE_PROP_GROUPS.map(group => (
            <div key={group.id} className="mb-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1">{group.label}</p>
              <div className="border border-gray-200 rounded bg-white overflow-hidden">
                {group.keys.map(key => {
                  const value = show(key);
                  return (
                    <div key={key} className="grid grid-cols-2 gap-2 px-3 py-1 border-b border-gray-50 last:border-b-0 text-xs">
                      <span className="text-gray-500">{DEVICE_PROP_LABELS[key] ?? key}</span>
                      <span className={value ? 'text-gray-900' : 'text-gray-300 italic'}>{value || 'not entered'}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderDeviceLibrary = () => (
    <div>
      <div className="flex items-start justify-between gap-4 mb-3">
        <p className="text-sm text-gray-500">
          Right-click on a voltage category to add a device. Click a device to break out its
          specification, double-click to open it.
        </p>
        {tpmsLink?.projectMainId ? (
          <button
            className="shrink-0 px-3 py-1.5 border border-purple-300 bg-purple-50 text-purple-800 rounded text-xs
                       hover:bg-purple-100 disabled:opacity-50 flex items-center gap-1.5"
            onClick={runTpmsUpdate}
            disabled={tpmsUpdate.busy}
            title="Bring across any specification TPMS has changed, and leave your own work alone"
          >
            <RefreshCwIcon className={`w-3.5 h-3.5 ${tpmsUpdate.busy ? 'animate-spin' : ''}`} />
            {tpmsUpdate.busy ? 'Reading TPMS…' : 'Update specifications from TPMS'}
          </button>
        ) : null}
      </div>

      <div className="border border-gray-200 rounded-md overflow-hidden">
        {/* Root header */}
        <div className="px-4 py-2 bg-gray-100 border-b font-semibold text-sm flex items-center gap-2 select-none">
          <span>📦</span> Device Library
          <span className="ml-auto text-xs font-normal text-gray-500">
            {(['LV', 'MV', 'HV'] as const).reduce((n, t) => n + (deviceLibrary[t] ?? []).length, 0)} device(s)
          </span>
        </div>

        {(['LV', 'MV', 'HV'] as const).map(t => {
          const items    = deviceLibrary[t] ?? [];
          const expanded = expandedTypes.has(t);

          return (
            <div key={t}>
              {/* Voltage level row */}
              <div
                className="flex items-center justify-between px-4 py-2 border-b cursor-pointer hover:bg-gray-50 select-none"
                onClick={() => {
                  const s = new Set(expandedTypes);
                  s.has(t) ? s.delete(t) : s.add(t);
                  setExpandedTypes(s);
                }}
                onContextMenu={e => {
                  e.preventDefault();
                  setCtxMenu({ visible: true, x: e.clientX, y: e.clientY, typeNode: t, itemId: null });
                }}
              >
                <div className="flex items-center gap-2">
                  {expanded
                    ? <ChevronDownIcon  className="w-4 h-4 text-gray-500" />
                    : <ChevronRightIcon className="w-4 h-4 text-gray-500" />}
                  <span className={`text-xs px-2 py-0.5 rounded font-bold ${typeColor(t)}`}>{t}</span>
                  <span className="text-sm font-medium">
                    {t === 'LV' ? 'Low Voltage' : t === 'MV' ? 'Medium Voltage' : 'High Voltage'}
                  </span>
                </div>
                <span className="text-xs text-gray-400">{items.length} device{items.length !== 1 ? 's' : ''}</span>
              </div>

              {/* Device items */}
              {expanded && (
                <div>
                  {items.length === 0 && (
                    <div className="pl-12 py-2 text-xs text-gray-400 italic border-b bg-white">
                      No devices — right-click to add
                    </div>
                  )}
                  {items.map(item => {
                    const facts = tpmsFactsFor(item);
                    const filled = filledPropertyCount(item.properties as Record<string, unknown>);
                    const open = expandedDevices.has(item.id);
                    return (
                      <React.Fragment key={item.id}>
                        <div
                          className="flex items-center gap-3 pl-8 pr-4 py-2 border-b hover:bg-blue-50 cursor-pointer text-sm group"
                          onClick={() => toggleDevice(item.id)}
                          onDoubleClick={() => setDeviceModal({ visible: true, item, mode: 'view' })}
                          onContextMenu={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            setCtxMenu({ visible: true, x: e.clientX, y: e.clientY, typeNode: t, itemId: item.id });
                          }}
                        >
                          {open
                            ? <ChevronDownIcon  className="w-4 h-4 text-gray-400 shrink-0" />
                            : <ChevronRightIcon className="w-4 h-4 text-gray-400 shrink-0" />}
                          <span className="shrink-0">🔧 {item.name}</span>
                          {facts.switchgearType && (
                            <span className="text-xs text-gray-500 truncate">{facts.switchgearType}</span>
                          )}
                          {item.source === 'tpms' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200 shrink-0">
                              TPMS
                            </span>
                          )}
                          <span className="ml-auto flex items-center gap-3 shrink-0 text-xs">
                            {facts.cellCount && <span className="text-gray-400">{facts.cellCount} cell(s)</span>}
                            <span className="text-gray-400">{facts.rows} feeder(s)</span>
                            <span className={filled === 0 ? 'text-amber-600' : 'text-gray-500'}>
                              {filled}/{DEVICE_PROP_TOTAL} spec
                            </span>
                          </span>
                        </div>
                        {open && renderDeviceBreakdown(item)}
                      </React.Fragment>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Context Menu */}
      {ctxMenu.visible && (
        <div
          className="fixed z-50 bg-white border shadow-lg rounded py-1 w-44"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          {/* Add Device / Paste – shown when right-clicking on type header */}
          {!ctxMenu.itemId && ctxMenu.typeNode && (
            <>
              <button
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center"
                onClick={() => {
                  setDeviceModal({ visible: true, item: null, mode: 'add', addType: ctxMenu.typeNode! });
                  setCtxMenu(prev => ({ ...prev, visible: false }));
                }}
              >
                <PlusIcon className="w-4 h-4 mr-2" /> Add Device
              </button>
              {copiedDevice && (
                <button
                  className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center"
                  onClick={() => {
                    setPasteNameModal({
                      visible: true,
                      targetType: ctxMenu.typeNode,
                      suggestedName: `${copiedDevice.name} (Copy)`
                    });
                    setCtxMenu(prev => ({ ...prev, visible: false }));
                  }}
                >
                  <ClipboardIcon className="w-4 h-4 mr-2" /> Paste "{copiedDevice.name}"
                </button>
              )}
            </>
          )}

          {/* Edit / Copy / Delete – shown when right-clicking on a specific item */}
          {ctxMenu.itemId && ctxMenu.typeNode && (() => {
            const found = (deviceLibrary[ctxMenu.typeNode] ?? []).find(d => d.id === ctxMenu.itemId);
            if (!found) return null;
            return (
              <>
                <button
                  className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center"
                  onClick={() => {
                    setDeviceModal({ visible: true, item: found, mode: 'edit' });
                    setCtxMenu(prev => ({ ...prev, visible: false }));
                  }}
                >
                  <EditIcon  className="w-4 h-4 mr-2" /> Edit
                </button>
                <button
                  className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center"
                  onClick={() => {
                    setCopiedDevice(found);
                    setCtxMenu(prev => ({ ...prev, visible: false }));
                  }}
                >
                  <CopyIcon className="w-4 h-4 mr-2" /> Copy
                </button>
                {copiedDevice && (
                  <button
                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center"
                    onClick={() => {
                      setPasteNameModal({
                        visible: true,
                        targetType: ctxMenu.typeNode,
                        suggestedName: `${copiedDevice.name} (Copy)`
                      });
                      setCtxMenu(prev => ({ ...prev, visible: false }));
                    }}
                  >
                    <ClipboardIcon className="w-4 h-4 mr-2" /> Paste "{copiedDevice.name}"
                  </button>
                )}
                <button
                  className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 text-red-600 flex items-center"
                  onClick={() => {
                    deleteLib(found.id, ctxMenu.typeNode!);
                    setCtxMenu(prev => ({ ...prev, visible: false }));
                  }}
                >
                  <TrashIcon className="w-4 h-4 mr-2" /> Delete
                </button>
              </>
            );
          })()}

          <div className="border-t my-1" />
          <button
            className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 text-gray-500 flex items-center"
            onClick={() => setCtxMenu(prev => ({ ...prev, visible: false }))}
          >
            <XIcon className="w-4 h-4 mr-2" /> Cancel
          </button>
        </div>
      )}

      {/* Device Properties Modal */}
      {deviceModal.visible && (
        <DevicePropertiesModal
          item={deviceModal.item}
          mode={deviceModal.mode}
          addType={deviceModal.addType}
          onSave={handleDeviceSave}
          onClose={closeDeviceModal}
        />
      )}

      {/* Device Library cascade-delete confirmation */}
      {libDeleteTarget && (
        <CascadeDeleteModal
          itemName={libDeleteTarget.item.name}
          itemKind="Device"
          usage={libDeleteTarget.usage}
          cascadeNote={
            'Deleting it here removes it from the Device Library AND from Device Selection — ' +
            'the equipment above and all of its device rows are deleted too.'
          }
          onConfirm={confirmDeleteLib}
          onCancel={() => setLibDeleteTarget(null)}
        />
      )}

      {/* Paste Name Modal */}
      {pasteNameModal.visible && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-96">
            <h3 className="text-lg font-semibold mb-4">Paste Device</h3>
            <label className="block text-sm mb-1 text-gray-600">New Device Name:</label>
            <input
              type="text"
              autoFocus
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm mb-4"
              value={pasteNameModal.suggestedName}
              onChange={e => setPasteNameModal(prev => ({ ...prev, suggestedName: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') handlePasteDevice(pasteNameModal.suggestedName); }}
            />
            <div className="flex justify-end gap-2">
              <button
                className="px-4 py-2 border rounded text-sm hover:bg-gray-100"
                onClick={() => setPasteNameModal({ visible: false, targetType: null, suggestedName: '' })}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
                disabled={!pasteNameModal.suggestedName.trim()}
                onClick={() => handlePasteDevice(pasteNameModal.suggestedName)}
              >
                Paste
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  // ── Main render ───────────────────────────────────────────────
  return (
    <div>
      {/* Sub-tab Navigation */}
      <div className="flex border-b mb-6">
        {([
          { id: 'project-data'   as SubTab, label: '📋 Project Data' },
          { id: 'device-library' as SubTab, label: '📦 Device Library' },
        ] as const).map(tab => (
          <button
            key={tab.id}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeSubTab === tab.id
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
            onClick={() => setActiveSubTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeSubTab === 'project-data'   && renderProjectData()}
      {activeSubTab === 'device-library' && renderDeviceLibrary()}

      {/* What TPMS would change, before it changes it. */}
      {(tpmsUpdate.busy || tpmsUpdate.result || tpmsUpdate.error) && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-6">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[80vh] flex flex-col">
            <div className="flex items-center gap-2 px-6 py-4 border-b">
              <DatabaseIcon className="w-5 h-5 text-purple-600" />
              <h3 className="font-semibold">Update specifications from TPMS</h3>
              <button className="ml-auto text-gray-400 hover:text-gray-600" onClick={closeTpmsUpdate}>
                <XIcon className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
              {tpmsUpdate.busy && (
                <p className="text-sm text-gray-600 flex items-center gap-2">
                  <RefreshCwIcon className="w-4 h-4 animate-spin" /> {tpmsUpdate.progress || 'Reading…'}
                </p>
              )}

              {tpmsUpdate.error && (
                <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
                  {tpmsUpdate.error}
                </p>
              )}

              {tpmsUpdate.result && (
                <>
                  {tpmsUpdate.result.changes.length === 0 ? (
                    <p className="text-sm text-gray-600">
                      Nothing has changed in TPMS — the specifications here are up to date.
                    </p>
                  ) : (
                    <>
                      <p className="text-sm text-gray-600 mb-3">
                        {tpmsUpdate.result.changes.length} specification(s) have changed in TPMS. Everything
                        you have entered yourself stays as it is — only these fields are written.
                      </p>
                      <table className="w-full text-xs border border-gray-200">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-3 py-2 text-left">Where</th>
                            <th className="px-3 py-2 text-left">Field</th>
                            <th className="px-3 py-2 text-left">Here now</th>
                            <th className="px-3 py-2 text-left">In TPMS</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tpmsUpdate.result.changes.map((c, i) => (
                            <tr key={`${c.where}-${c.field}-${i}`} className="border-t border-gray-100">
                              <td className="px-3 py-1.5 text-gray-500">{c.where}</td>
                              <td className="px-3 py-1.5">{DEVICE_PROP_LABELS[c.field] ?? c.field}</td>
                              <td className="px-3 py-1.5 text-gray-400 line-through">{c.from}</td>
                              <td className="px-3 py-1.5 text-green-700 font-medium">{c.to}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}

                  {tpmsUpdate.result.newSwitchgears.length > 0 && (
                    <p className="mt-4 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                      TPMS has {tpmsUpdate.result.newSwitchgears.length} switchgear(s) this project does not:{' '}
                      {tpmsUpdate.result.newSwitchgears.join(', ')}. Adding a panel is more than a
                      specification change — open the project from TPMS again to bring them in.
                    </p>
                  )}

                  {tpmsUpdate.result.problems.length > 0 && (
                    <ul className="mt-4 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 list-disc pl-6">
                      {tpmsUpdate.result.problems.map((p, i) => <li key={i}>{p}</li>)}
                    </ul>
                  )}
                </>
              )}
            </div>

            <div className="flex justify-end gap-2 px-6 py-4 border-t bg-gray-50">
              <button className="px-4 py-2 border rounded text-sm hover:bg-gray-100" onClick={closeTpmsUpdate}>
                {tpmsUpdate.result && tpmsUpdate.result.changes.length === 0 ? 'Close' : 'Cancel'}
              </button>
              {tpmsUpdate.result && tpmsUpdate.result.changes.length > 0 && (
                <button
                  className="px-4 py-2 bg-purple-600 text-white rounded text-sm hover:bg-purple-700 flex items-center gap-1"
                  onClick={applyTpmsUpdate}
                >
                  <CheckIcon className="w-4 h-4" /> Apply {tpmsUpdate.result.changes.length} change(s)
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Next. Saving is not a button here: the project saves itself as it is
          edited, and File → Save is there for anybody who wants to say so
          outright. A Save on one tab of five suggested the other four did
          not save, which was never true. */}
      <div className="flex justify-end gap-3 mt-6">
        <button
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          onClick={onComplete}
        >
          Next →
        </button>
      </div>
    </div>
  );
};
