import React, { useState, useEffect } from 'react';
import { useProject } from '../../context/ProjectContext';
import { DeviceLibraryItem, DeviceLibraryProperties, TechSettings } from '../../types/project';
import {
  findDeviceLibraryUsage, removeDeviceLibraryItemEverywhere, UsageReport,
} from '../../utils/cascadeDelete';
import { CascadeDeleteModal } from '../shared/CascadeDeleteModal';
import { MenuBox } from '../shared/MenuBox';
import {
  PlusIcon, EditIcon, TrashIcon, XIcon,
  ChevronDownIcon, ChevronRightIcon, CheckIcon, SaveIcon, CopyIcon, ClipboardIcon,
  Maximize2Icon, Minimize2Icon, RefreshCwIcon, DatabaseIcon
} from 'lucide-react';
import {
  DEVICE_PROP_GROUPS, DEVICE_PROP_LABELS, DEVICE_PROP_TOTAL, filledPropertyCount,
} from '../../utils/deviceProperties';
import { readSpecUpdateFromTpms, TpmsSpecUpdate } from '../../services/tpmsSync';
import { type Tier, TIERS, TIER_LABEL, TIER_BADGE, TIER_PILL, emptyTiers } from '../../utils/tiers';
import { TEMPLATE_FAMILIES } from '../../utils/templateFamilies';
import { BreakerCodeTab } from './BreakerCodeTab';
import {
  applyWorldRules, isAllowed, worldFieldRule, WORLD_FIELDS, type FieldRule, type WorldSiteInfo,
} from '../../utils/sion3ae5/simoprimeWorldScope';
import { appConfirm } from '../shared/AppDialog';

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

/**
 * A field held to a catalogue: a dropdown of what the catalogue allows, given
 * the rest of the specification. A value it no longer allows stays visible,
 * in red, until it is changed; one the form filled itself says so.
 */
interface CatalogueFieldProps {
  label: string;
  value: string;
  isEditable: boolean;
  rule: FieldRule;
  allowed: boolean;
  auto: boolean;
  onChange: (v: string) => void;
}
const CatalogueField: React.FC<CatalogueFieldProps> = ({ label, value, isEditable, rule, allowed, auto, onChange }) => {
  const known = rule.options.some(o => o.value === value);
  return (
    <div className="grid grid-cols-2 gap-3 items-start py-1 border-b border-gray-50">
      <label className="text-sm text-gray-600 pt-1">{label}</label>
      <div>
        {isEditable ? (
          <select
            className={`${FIELD_CLS} bg-white ${!allowed ? 'border-red-400 text-red-700' : ''}`}
            value={value}
            onChange={e => onChange(e.target.value)}
          >
            <option value="">Choose…</option>
            {!known && value && <option value={value}>{value} — not in the catalogue</option>}
            {rule.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : (
          <span className={`${READ_CLS} ${!allowed ? 'text-red-700' : ''}`}>{value || '—'}</span>
        )}
        {(auto || !allowed || rule.note) && (
          <p className={`text-[11px] mt-0.5 ${!allowed ? 'text-red-700' : 'text-gray-500'}`}>
            {!allowed ? 'Not allowed with the rest of this specification. ' : ''}
            {auto && allowed ? 'Set by the catalogue. ' : ''}
            {rule.note ?? ''}
          </p>
        )}
      </div>
    </div>
  );
};

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
type SubTab = 'project-data' | 'device-library' | 'breaker-code';

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
  addType?:  Tier;
  onSave:    (item: DeviceLibraryItem) => void;
  onClose:   () => void;
  /** The device whose specification was copied, if any — see SpecClipboard. */
  clip:      DeviceLibraryItem | null;
  onCopy:    (item: DeviceLibraryItem) => void;
  /** The AIS family the scope is filed under — SIMOPRIME-WORLD holds the
   *  form to that catalogue. */
  family?:   string | null;
  site?:     WorldSiteInfo;
}

// Copying a specification is copying the whole device's; pasting it is either
// the whole of it or one tab — the tabs are the groups in DEVICE_PROP_GROUPS,
// so "paste Busbar & Construction" writes exactly the fields that tab shows
// and leaves the other three as they were.
type SpecGroupId = 'electrical' | 'control' | 'busbar' | 'padlock';

function pasteSpec(
  into: DeviceLibraryProperties, from: DeviceLibraryProperties, group?: SpecGroupId,
): DeviceLibraryProperties {
  const keys = group
    ? DEVICE_PROP_GROUPS.find(g => g.id === group)?.keys ?? []
    : DEVICE_PROP_GROUPS.flatMap(g => g.keys);
  const next = { ...into } as Record<string, unknown>;
  const src = from as Record<string, unknown>;
  for (const key of keys) {
    if (src[key] === undefined) delete next[key];
    else next[key] = src[key];
  }
  return next as DeviceLibraryProperties;
}

const DevicePropertiesModal: React.FC<DevicePropertiesModalProps> = ({
  item, mode: initialMode, addType, onSave, onClose, clip, onCopy, family, site = { ambientC: null },
}) => {
  const [mode,  setMode]  = useState<ModalMode>(initialMode);
  const [name,  setName]  = useState(item?.name ?? '');
  const [type,  setType]  = useState<Tier>(item?.type ?? addType ?? 'LV');
  const [props, setProps] = useState<DeviceLibraryProperties>(item?.properties ?? {});
  const [activeSection, setActiveSection] = useState<'electrical' | 'control' | 'busbar' | 'padlock'>('electrical');
  // A panel specification is a long form; full screen gives it the whole
  // window (and two columns of fields) instead of a 760px dialog.
  const [fullScreen, setFullScreen] = useState(false);

  // SIMOPRIME World: the catalogue's dropdowns, and what one choice settles.
  const world = family === 'SIMOPRIME-WORLD' && type === 'MV';
  const [autos, setAutos] = useState<Set<string>>(new Set());

  const setProp = (key: keyof DeviceLibraryProperties, value: string | boolean) => {
    const next = { ...props, [key]: value };
    if (!world) { setProps(next); return; }
    const r = applyWorldRules(next, key as string, autos, site);
    setProps(r.props);
    setAutos(r.autos);
  };

  // Opening a World scope to edit fills in what the catalogue alone decides.
  useEffect(() => {
    if (!world || initialMode === 'view') return;
    const r = applyWorldRules(props, null, new Set(), site);
    setProps(r.props);
    setAutos(r.autos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world]);

  /** One specification field: the catalogue's dropdown where it speaks, else text. */
  const F = (key: keyof DeviceLibraryProperties, label: string) => {
    const rule = world && WORLD_FIELDS.includes(key as string) ? worldFieldRule(key as string, props, site) : null;
    const value = String((props as any)[key] ?? '');
    if (!rule) {
      return <PropField key={key as string} label={label} value={value} isEditable={isEditable} onChange={v => setProp(key, v)} />;
    }
    return (
      <CatalogueField
        key={key as string} label={label} value={value} isEditable={isEditable} rule={rule}
        allowed={isAllowed(key as string, props, site)} auto={autos.has(key as string)}
        onChange={v => setProp(key, v)}
      />
    );
  };

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

  const typeColor = TIER_PILL[type] ?? TIER_PILL.OTHER;

  // Paste from the copied device, all of it or the tab on screen. A paste
  // into a device being viewed turns the dialog to editing, so the change is
  // seen and saved (or cancelled) like any other edit.
  const canPaste = !!clip && clip.id !== item?.id;
  const paste = (group?: SpecGroupId) => {
    if (!clip) return;
    setProps(prev => pasteSpec(prev, clip.properties ?? {}, group));
    if (mode === 'view') setMode('edit');
  };

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
              {mode === 'add' ? 'Add Scope to Library' : name}
            </h3>
            {mode !== 'add' && (
              <span className={`text-xs px-2 py-0.5 rounded font-semibold ${typeColor}`}>{type}</span>
            )}
            {world && (
              <span className="text-xs text-gray-600"
                title="SIMOPRIME World design catalogue (issue 23, 06/2026): each field offers only what the catalogue allows with the rest, and one choice fills in what it settles (1.1 technical data, 1.2 busbars, 1.3 design, 1.5 supply voltages, 3.2 dimensions, 3.8 busbar currents)">
                SIMOPRIME World catalogue
              </span>
            )}
          </div>
          <div className="flex gap-2 items-center">
            <button
              className="px-2.5 py-1.5 border rounded text-xs flex items-center gap-1 hover:bg-gray-50"
              onClick={() => onCopy({ id: item?.id ?? 'new', name: name || 'this scope', type, properties: props })}
              title="Copy this scope's whole specification"
            >
              <CopyIcon className="w-3 h-3" /> Copy spec
            </button>
            {canPaste && (
              <button
                className="px-2.5 py-1.5 border border-blue-300 bg-blue-50 text-blue-800 rounded text-xs flex items-center gap-1 hover:bg-blue-100"
                onClick={() => paste()}
                title={`Paste every tab of ${clip!.name}'s specification here`}
              >
                <ClipboardIcon className="w-3 h-3" /> Paste all from {clip!.name}
              </button>
            )}
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
                placeholder="Scope name"
                autoFocus={mode === 'add'}
              />
            </div>
            {mode === 'add' && (
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium">Type:</label>
                <select
                  className="border border-gray-300 rounded px-2 py-1 text-sm"
                  value={type}
                  onChange={e => setType(e.target.value as Tier)}
                >
                  {TIERS.map(t => (
                    <option key={t} value={t}>{t} – {TIER_LABEL[t]}</option>
                  ))}
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
          {canPaste && (
            <button
              className="ml-auto my-1.5 px-2 py-1 text-xs text-blue-700 hover:bg-blue-50 rounded flex items-center gap-1"
              onClick={() => paste(activeSection)}
              title={`Paste only this tab from ${clip!.name}`}
            >
              <ClipboardIcon className="w-3 h-3" />
              Paste this tab from {clip!.name}
            </button>
          )}
        </div>

        {/* ── Section content ── */}
        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
          {activeSection === 'electrical' && (
            <div className={fullScreen ? 'grid grid-cols-2 gap-x-10' : ''}>
              {F('ratedInsulationVoltage', 'Rated Insulation Voltage')}
              {F('serviceVoltage', 'Service Voltage')}
              {F('ratedPowerFrequencyWithstandVoltage', 'Rated Power-Frequency Withstand Voltage')}
              {F('frequency', 'Frequency')}
              {F('mainBusbarConfiguration', 'Main Busbar Configuration')}
              {F('mainBusbarRatedCurrent', 'Main Busbar Rated Current')}
              {F('ratedShortTimeWithstandCurrent', 'Rated Short Time Withstand Current')}
              {F('isc', 'Isc')}
              {F('height', 'Height (mm)')}
              {F('width', 'Width (mm)')}
              {F('depth', 'Depth (mm)')}
              {F('ratedImpulseWithstandVoltage', 'Rated Impulse Withstand Voltage')}
            </div>
          )}
          {/* The three voltages that used to sit here now open the
              Electrical / Mechanical tab — they belong with the ratings. */}
          {activeSection === 'control' && (
            <div className={fullScreen ? 'grid grid-cols-2 gap-x-10' : ''}>
              {F('controlProtectionClosingTrippingSignalling', 'Control, Protection, Closing, Tripping & Signalling')}
              {F('springChargingMotor', 'Spring Charging Motor')}
              {F('switchgearLightingSpaceHeater', 'Switchgear Lighting & Space Heater')}
              {F('motorsSpaceHeater', 'Motors Space Heater')}
            </div>
          )}
          {activeSection === 'busbar' && (
            <div className={fullScreen ? 'grid grid-cols-2 gap-x-10' : ''}>
              {F('mainBusbarSize', 'Main Busbar Size')}
              {F('earthBusbarSize', 'Earth Busbar Size')}
              {F('neutralBusbarSize', 'Neutral Busbar Size')}
              {F('ral', 'RAL')}
              {F('incomingConnection', 'Incoming Connection')}
              {F('outgoingConnection', 'Outgoing Connection')}
              {F('ip', 'IP')}
              {F('switchgearAccess', 'Switchgear Access')}
              {F('switchgearArrangement', 'Switchgear Arrangement')}
              {F('busbarType', 'Busbar Type')}
              {F('thermoFitCover', 'Thermofit Cover')}
              {F('coating', 'Coating')}
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
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 flex items-center gap-1"
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
  const [expandedTypes,      setExpandedTypes]      = useState<Set<string>>(
    new Set([...TIERS, 'MV/AIS', 'MV/GIS', ...TEMPLATE_FAMILIES.MV.map(f => `MV/AIS/${f.id}`)]));

  const [ctxMenu, setCtxMenu] = useState<{
    visible: boolean; x: number; y: number;
    typeNode: Tier | null;
    itemId:   string | null;
    /** The AIS family a right-click on MV was under, if any. */
    family?:  string;
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
    visible: boolean; targetType: Tier | null; suggestedName: string; targetFamily?: string;
  }>({ visible: false, targetType: null, suggestedName: '' });

  const [deviceModal, setDeviceModal] = useState<{
    visible:  boolean;
    item:     DeviceLibraryItem | null;
    mode:     ModalMode;
    addType?: Tier;
    /** The AIS family a scope is being added under. */
    addFamily?: string;
  }>({ visible: false, item: null, mode: 'add' });

  // Pending Device Library deletion — held until the user confirms in the
  // cascade dialog, which lists everywhere the device is used.
  const [libDeleteTarget, setLibDeleteTarget] = useState<{
    item: DeviceLibraryItem; type: Tier; usage: UsageReport;
  } | null>(null);

  // Navigate here from DeviceSelection → Device Library
  useEffect(() => {
    if (requestedSubTab) setActiveSubTab(requestedSubTab);
  }, [requestedSubTab]);

  // Auto-open a specific device in edit mode when navigated from DeviceSelection
  useEffect(() => {
    if (requestedDeviceId && requestedSubTab === 'device-library') {
      const library = projectData.deviceLibrary ?? emptyTiers();
      for (const t of TIERS) {
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
  const deviceLibrary = projectData.deviceLibrary ?? emptyTiers();

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
  const deleteLib = (id: string, t: Tier) => {
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
  const handleDeviceSave = (item: DeviceLibraryItem) => {
    // The AIS family the scope was added under (or already had) stays with
    // it while it is MV.
    const family = deviceModal.mode === 'add' ? deviceModal.addFamily : deviceModal.item?.family;
    const kept = item.type === 'MV' && family ? { ...item, family } : item;
    return deviceModal.mode === 'add' ? addLib(kept) : updateLib(kept);
  };

  const handlePasteDevice = (newName: string) => {
    if (!copiedDevice || !pasteNameModal.targetType) return;
    const pasted: DeviceLibraryItem = {
      ...copiedDevice,
      id:   `lib-${Date.now()}`,
      name: newName.trim() || `${copiedDevice.name} (Copy)`,
      type: pasteNameModal.targetType,
      family: pasteNameModal.targetType === 'MV' ? pasteNameModal.targetFamily : undefined,
    };
    addLib(pasted);
    setPasteNameModal({ visible: false, targetType: null, suggestedName: '' });
  };

  const typeColor = (t: Tier) => TIER_BADGE[t] ?? TIER_BADGE.OTHER;

  // Paste a copied specification over an existing device — all of it, or one
  // tab. What is overwritten is said first: a paste has no undo here.
  const pasteSpecInto = async (target: DeviceLibraryItem, group?: SpecGroupId) => {
    if (!copiedDevice) return;
    const what = group
      ? `the "${DEVICE_PROP_GROUPS.find(g => g.id === group)?.label}" tab`
      : 'the whole specification';
    if (!await appConfirm(`Replace ${what} of ${target.name} with ${copiedDevice.name}'s?`,
      { title: 'Paste specification', confirmLabel: 'Replace' })) return;
    updateLib({ ...target, properties: pasteSpec(target.properties ?? {}, copiedDevice.properties ?? {}, group) });
  };

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
    const props = (item.properties ?? {}) as Record<string, any>;
    const show = (key: string) => {
      const value = props[key];
      if (typeof value === 'boolean') return value ? 'Yes' : 'No';
      return value == null || String(value).trim() === '' ? '' : String(value);
    };

    return (
      <div className="pl-9 pr-4 py-3 border-b border-gray-100 bg-gray-50">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-gray-600 mb-3">
          {/* Switchgear type, cells and feeders are on the scope's own row. */}
          {item.tpmsScopeId != null && <span><span className="text-gray-500">TPMS scope</span> <strong>{item.tpmsScopeId}</strong></span>}
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

  // ── Scope Library tree pieces ─────────────────────────────────────────
  // GIS is not a top-level group here: it sits under MV, beside AIS.
  const TOP_TIERS = TIERS.filter(t => t !== 'GIS');
  const MV_FAMILIES = TEMPLATE_FAMILIES.MV;

  /** The AIS family a MV scope belongs to: the one it was added under, or
   *  what its TPMS switchgear type or its name says. */
  const scopeFamily = (item: DeviceLibraryItem): string | null => {
    if (item.family && MV_FAMILIES.some(f => f.id === item.family)) return item.family;
    const text = `${tpmsFactsFor(item).switchgearType} ${item.name}`.toUpperCase();
    if (/EK\s*-?\s*36/.test(text)) return 'EK36';
    if (/SIMOPRIME\s*-?\s*A4|\bA4\b/.test(text)) return 'SIMOPRIME-A4';
    if (/SIMOPRIME|WORLD/.test(text)) return 'SIMOPRIME-WORLD';
    return null;
  };

  const isOpen = (key: string) => expandedTypes.has(key);
  const toggleOpen = (key: string) => {
    const next = new Set(expandedTypes);
    next.has(key) ? next.delete(key) : next.add(key);
    setExpandedTypes(next);
  };

  /** A group row: level 0 is a voltage level, 1 is AIS / GIS, 2 an AIS family. */
  const groupRow = (
    key: string, level: 0 | 1 | 2, count: number,
    target: { tier: Tier; family?: string }, label: string, pill?: Tier,
  ) => (
    <div
      className={`flex items-center justify-between pr-4 py-2 border-b cursor-pointer select-none ${
        level === 0 ? 'px-3 bg-gray-100 border-gray-200 hover:bg-gray-200'
          : level === 1 ? 'pl-3 bg-gray-50 border-gray-100 hover:bg-gray-100'
          : 'pl-3 bg-white border-gray-100 hover:bg-gray-50'}`}
      onClick={() => toggleOpen(key)}
      onContextMenu={e => {
        e.preventDefault();
        setCtxMenu({ visible: true, x: e.clientX, y: e.clientY, typeNode: target.tier, itemId: null, family: target.family });
      }}
    >
      <div className="flex items-center gap-2">
        {isOpen(key)
          ? <ChevronDownIcon  className="w-4 h-4 text-gray-500" />
          : <ChevronRightIcon className="w-4 h-4 text-gray-500" />}
        {pill && <span className={`text-xs px-2 py-0.5 rounded font-bold ${typeColor(pill)}`}>{pill}</span>}
        <span className={`${
          level === 0 ? 'text-xs font-bold uppercase tracking-wide'
            : level === 1 ? 'text-[13px] font-semibold' : 'text-[13px] font-medium'} ${
          count ? 'text-gray-800' : 'text-gray-500'}`}>
          {label}
        </span>
      </div>
      <span className="text-xs text-gray-500">{count}</span>
    </div>
  );

  const scopeRow = (item: DeviceLibraryItem, t: Tier, family?: string) => {
    const facts = tpmsFactsFor(item);
    const filled = filledPropertyCount(item.properties as Record<string, unknown>);
    const open = expandedDevices.has(item.id);
    // The family is the group it sits in; saying it again on the row is noise.
    const type = facts.switchgearType && facts.switchgearType.toUpperCase() !== family ? facts.switchgearType : '';
    return (
      <React.Fragment key={item.id}>
        <div
          className="flex items-center gap-3 pl-3 pr-4 py-2 bg-white border-b border-gray-100 hover:bg-gray-50 cursor-pointer text-sm group"
          onClick={() => toggleDevice(item.id)}
          onDoubleClick={() => setDeviceModal({ visible: true, item, mode: 'view' })}
          onContextMenu={e => {
            e.preventDefault();
            e.stopPropagation();
            setCtxMenu({ visible: true, x: e.clientX, y: e.clientY, typeNode: t, itemId: item.id, family });
          }}
        >
          {open
            ? <ChevronDownIcon  className="w-4 h-4 text-gray-400 shrink-0" />
            : <ChevronRightIcon className="w-4 h-4 text-gray-400 shrink-0" />}
          <span className="shrink-0 text-gray-800">{item.name}</span>
          {type && <span className="text-xs text-gray-500 truncate">{type}</span>}
          {item.source === 'tpms' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200 shrink-0">
              TPMS
            </span>
          )}
          <span className="ml-auto flex items-center gap-3 shrink-0 text-xs">
            {facts.cellCount && <span className="text-gray-500">{facts.cellCount} cell(s)</span>}
            <span className="text-gray-500">{facts.rows} feeder(s)</span>
            <span className={filled === 0 ? 'text-amber-600' : 'text-gray-500'}>
              {filled}/{DEVICE_PROP_TOTAL} spec
            </span>
          </span>
        </div>
        {open && renderDeviceBreakdown(item)}
      </React.Fragment>
    );
  };

  const renderDeviceLibrary = () => (
    <div>
      {/* No heading and no instructions line: the sub-tab already says Scope
          Library, and how to use it is on hover and in Help. The voltage
          levels are grey bands; the scopes under them are white rows set in,
          so a group never reads as one of its own scopes. */}
      <div
        className="border border-gray-200 rounded-md overflow-hidden"
        title="Right-click a group to add a scope; right-click a scope to copy its specification and paste it into another, whole or tab by tab. Click a scope to break out its specification, double-click to open it."
      >

        {TOP_TIERS.map(t => {
          const items = deviceLibrary[t] ?? [];
          if (t !== 'MV') {
            return (
              <div key={t}>
                {groupRow(t, 0, items.length, { tier: t }, TIER_LABEL[t], t)}
                {isOpen(t) && items.length > 0 && (
                  <div className="ml-8 border-l-2 border-gray-300">{items.map(item => scopeRow(item, t))}</div>
                )}
              </div>
            );
          }
          // MV is AIS and GIS; AIS is split by switchgear family, the way the
          // Create Template tree files MV templates.
          const gis = deviceLibrary.GIS ?? [];
          const byFamily = MV_FAMILIES.map(fam => ({ fam, list: items.filter(i => scopeFamily(i) === fam.id) }));
          const loose = items.filter(i => scopeFamily(i) === null);
          return (
            <div key={t}>
              {groupRow('MV', 0, items.length + gis.length, { tier: 'MV' }, TIER_LABEL.MV, 'MV')}
              {isOpen('MV') && (
                <div className="ml-8 border-l-2 border-gray-300">
                  {groupRow('MV/AIS', 1, items.length, { tier: 'MV' }, 'AIS — Air Insulated Switchgear')}
                  {isOpen('MV/AIS') && (
                    <div className="ml-8 border-l-2 border-gray-200">
                      {byFamily.map(({ fam, list }) => (
                        <div key={fam.id}>
                          {groupRow(`MV/AIS/${fam.id}`, 2, list.length, { tier: 'MV', family: fam.id }, fam.label)}
                          {isOpen(`MV/AIS/${fam.id}`) && list.length > 0 && (
                            <div className="ml-8 border-l-2 border-gray-200">{list.map(item => scopeRow(item, 'MV', fam.id))}</div>
                          )}
                        </div>
                      ))}
                      {/* MV scopes no family can be read from stay in AIS, not lost. */}
                      {loose.map(item => scopeRow(item, 'MV'))}
                    </div>
                  )}
                  {groupRow('MV/GIS', 1, gis.length, { tier: 'GIS' }, 'GIS — Gas Insulated Switchgear')}
                  {isOpen('MV/GIS') && gis.length > 0 && (
                    <div className="ml-8 border-l-2 border-gray-200">{gis.map(item => scopeRow(item, 'GIS'))}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Context Menu */}
      {ctxMenu.visible && (
        <MenuBox
          x={ctxMenu.x}
          y={ctxMenu.y}
          className="z-50 bg-white border shadow-lg rounded py-1 w-60 max-h-[90vh] overflow-y-auto"
        >
          {/* Add Device / Paste – shown when right-clicking on type header */}
          {!ctxMenu.itemId && ctxMenu.typeNode && (
            <>
              <button
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center"
                onClick={() => {
                  setDeviceModal({ visible: true, item: null, mode: 'add', addType: ctxMenu.typeNode!, addFamily: ctxMenu.family });
                  setCtxMenu(prev => ({ ...prev, visible: false }));
                }}
              >
                <PlusIcon className="w-4 h-4 mr-2" /> Add Scope
              </button>
              {copiedDevice && (
                <button
                  className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center"
                  onClick={() => {
                    setPasteNameModal({
                      visible: true,
                      targetType: ctxMenu.typeNode,
                      targetFamily: ctxMenu.family,
                      suggestedName: `${copiedDevice.name} (Copy)`
                    });
                    setCtxMenu(prev => ({ ...prev, visible: false }));
                  }}
                >
                  <ClipboardIcon className="w-4 h-4 mr-2" /> Paste as new scope "{copiedDevice.name}"
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
                {copiedDevice && copiedDevice.id !== found.id && (
                  <>
                    <div className="border-t my-1" />
                    <p className="px-4 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-gray-400">
                      Specification from {copiedDevice.name}
                    </p>
                    <button
                      className="w-full text-left px-4 py-1.5 text-sm hover:bg-gray-100 flex items-center"
                      onClick={() => {
                        setCtxMenu(prev => ({ ...prev, visible: false }));
                        pasteSpecInto(found);
                      }}
                    >
                      <ClipboardIcon className="w-4 h-4 mr-2" /> Paste all tabs
                    </button>
                    {DEVICE_PROP_GROUPS.map(g => (
                      <button
                        key={g.id}
                        className="w-full text-left pl-10 pr-4 py-1 text-xs hover:bg-gray-100 text-gray-700"
                        onClick={() => {
                          setCtxMenu(prev => ({ ...prev, visible: false }));
                          pasteSpecInto(found, g.id as SpecGroupId);
                        }}
                      >
                        Paste {g.label} only
                      </button>
                    ))}
                    <div className="border-t my-1" />
                  </>
                )}
                {copiedDevice && (
                  <button
                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center"
                    onClick={() => {
                      setPasteNameModal({
                        visible: true,
                        targetType: ctxMenu.typeNode,
                        targetFamily: ctxMenu.family,
                        suggestedName: `${copiedDevice.name} (Copy)`
                      });
                      setCtxMenu(prev => ({ ...prev, visible: false }));
                    }}
                  >
                    <ClipboardIcon className="w-4 h-4 mr-2" /> Paste as new scope "{copiedDevice.name}"
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
        </MenuBox>
      )}

      {/* Device Properties Modal */}
      {deviceModal.visible && (
        <DevicePropertiesModal
          item={deviceModal.item}
          mode={deviceModal.mode}
          addType={deviceModal.addType}
          onSave={handleDeviceSave}
          onClose={closeDeviceModal}
          clip={copiedDevice}
          onCopy={setCopiedDevice}
          family={deviceModal.mode === 'add'
            ? deviceModal.addFamily ?? null
            : deviceModal.item ? scopeFamily(deviceModal.item) : null}
          site={{ ambientC: parseFloat(String(projectData.techSettings?.general?.designTemperature ?? '')) || null }}
        />
      )}

      {/* Device Library cascade-delete confirmation */}
      {libDeleteTarget && (
        <CascadeDeleteModal
          itemName={libDeleteTarget.item.name}
          itemKind="Scope"
          usage={libDeleteTarget.usage}
          cascadeNote={
            'Deleting it here removes it from the Scope Library AND from Scope Selection — ' +
            'the equipment above and all of its scope rows are deleted too.'
          }
          onConfirm={confirmDeleteLib}
          onCancel={() => setLibDeleteTarget(null)}
        />
      )}

      {/* Paste Name Modal */}
      {pasteNameModal.visible && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-96">
            <h3 className="text-lg font-semibold mb-4">Paste Scope</h3>
            <label className="block text-sm mb-1 text-gray-600">New Scope Name:</label>
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
      {/* Sub-tab Navigation — with the TPMS update beside it, above both tabs:
          it brings across both the project data (master data, technical
          settings) and every panel's specification in the Device Library. It
          stays until TPMS is retired and the whole project starts here. */}
      <div className="flex items-end border-b mb-6">
        {([
          { id: 'project-data'   as SubTab, label: '📋 Project Data' },
          { id: 'device-library' as SubTab, label: '📦 Scope Library' },
          { id: 'breaker-code'   as SubTab, label: '⚡ Breaker Code' },
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
        {tpmsLink?.projectMainId ? (
          <button
            className="ml-auto mb-1.5 shrink-0 px-3 py-1.5 border border-gray-300 bg-white text-gray-700 rounded text-xs
                       hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1.5"
            onClick={runTpmsUpdate}
            disabled={tpmsUpdate.busy}
            title="Bring across what TPMS has changed — project data, technical settings and each panel's specification — and leave your own work alone"
          >
            <RefreshCwIcon className={`w-3.5 h-3.5 ${tpmsUpdate.busy ? 'animate-spin' : ''}`} />
            {tpmsUpdate.busy ? 'Reading TPMS…' : 'Update from TPMS'}
          </button>
        ) : null}
      </div>

      {activeSubTab === 'project-data'   && renderProjectData()}
      {activeSubTab === 'device-library' && renderDeviceLibrary()}
      {activeSubTab === 'breaker-code' && (
        <BreakerCodeTab
          projectData={projectData}
          onSave={(item, key, record) => updateLib({
            ...item, breakerCodes: { ...(item.breakerCodes ?? {}), [key]: record },
          })}
          onUpdate={updateLib}
        />
      )}

      {/* What TPMS would change, before it changes it. */}
      {(tpmsUpdate.busy || tpmsUpdate.result || tpmsUpdate.error) && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-6">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[80vh] flex flex-col">
            <div className="flex items-center gap-2 px-6 py-4 border-b">
              <DatabaseIcon className="w-5 h-5 text-gray-600" />
              <h3 className="font-semibold">Update from TPMS — project data and scope specifications</h3>
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
                  className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 flex items-center gap-1"
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
