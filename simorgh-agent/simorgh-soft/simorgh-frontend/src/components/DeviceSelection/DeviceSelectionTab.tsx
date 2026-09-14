import React, { useState, useEffect, useRef, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import * as XLSX from 'xlsx-js-style';
import { PlusIcon, UploadIcon, DownloadIcon, TrashIcon, CopyIcon, ArrowUpIcon, ArrowDownIcon, MaximizeIcon, MinimizeIcon, ChevronDownIcon, ChevronRightIcon, XIcon, InfoIcon, EditIcon, CheckIcon, ClipboardIcon, FilterIcon, PaletteIcon, LayersIcon, PinIcon, RefreshCwIcon } from 'lucide-react';
import { PanelFrame } from '../shared/PanelFrame';
import { usePanel } from '../../context/PanelsContext';
import { ProjectData, Equipment, DeviceTableRow, TemplateItem } from '../../types/project';
import { LV_TEMPLATE_PROPERTIES, MV_TEMPLATE_PROPERTIES, HV_TEMPLATE_PROPERTIES, templateParts, partsCellText } from '../../utils/tierEquipmentMatrix';
import { useProject } from '../../context/ProjectContext';

// ===== PROPS INTERFACES =====
interface DeviceTableProps {
  selectedEquipment: Equipment | null;
  updateEquipment: (id: string, data: Partial<Equipment>) => void;
  projectData: ProjectData;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onShowTemplateProperties?: (templateId: string) => void;
  clipboardRows: DeviceTableRow[];
  onCopyRows: (rows: DeviceTableRow[]) => void;
}

interface EquipmentTreeProps {
  onImportFromTpms?: () => void;
  projectData: ProjectData;
  addEquipment: (equipment: Equipment) => void;
  deleteEquipment: (id: string) => void;
  copyEquipment: (id: string) => void;
  selectedEquipment: Equipment | null;
  setSelectedEquipment: (equipment: Equipment | null) => void;
  onNavigateToDeviceLibrary: (deviceId?: string) => void;
}

interface DeviceSelectionTabProps {
  onImportFromTpms?: () => void;
  projectData: ProjectData;
  selectedEquipment: Equipment | null;
  setSelectedEquipment: (equipment: Equipment | null) => void;
  updateEquipment: (id: string, data: Partial<Equipment>) => void;
  addEquipment: (equipment: Equipment) => void;
  deleteEquipment: (id: string) => void;
  copyEquipment: (id: string) => void;
  onNext: () => void;
  onNavigateToTemplate?: (templateId: string) => void;
  onNavigateToDeviceLibrary?: (deviceId?: string) => void;
}

// ===== TEMPLATE PROPERTIES MODAL =====
interface TemplatePropertiesModalProps {
  template: TemplateItem;
  onClose: () => void;
  onEdit: (templateId: string) => void;
}

const TemplatePropertiesModal: React.FC<TemplatePropertiesModalProps> = ({ template, onClose, onEdit }) => {
  // Layout must mirror TemplateProperties.tsx so the read-only view always
  // matches what the user configured on the editor screen.
  const lvProperties = [
    'CB ORDER', 'ACCESSORY', 'CONTACTOR. ORDER', 'OVER LOAD RELAY',
    'EARTH FAULT', 'COREBALANCE CT', 'PROTECTION RELAY', 'CT RATING',
    'AMMETER', 'AMMETER selector', 'PT RATING', 'VOLTMETER',
    'VOLTMETER selector', 'MULTIMETER', 'TEST BLOCK', 'TRANSDUSER',
    'ALARM ANUNCIATOR',
    'SPARE 1', 'SPARE 2', 'SPARE 3', 'SPARE 4', 'SPARE 5', 'SPARE 6', 'SPARE 7',
  ];
  const mvProperties = [
    'VCB OR VC/FUSE', 'ACCESSORY', 'VOLTAGE INDICATOR', 'COREBALANCE CT',
    'PROTECTION RELAY', 'CT RATING', 'AMMETER', 'AMMETER selector',
    'PT RATING', 'VOLTMETER', 'VOLTMETER selector', 'MULTIMETER',
    'TEST BLOCK', 'TRANSDUSER', 'ALARM WINDDOW', 'SURGE ARRESTER',
    'SPARE 1', 'SPARE 2', 'SPARE 3', 'SPARE 4', 'SPARE 5',
  ];
  const hvProperties = [
    'BREAKER TYPE', 'NOMINAL VOLTAGE', 'NOMINAL CURRENT',
    'SHORT CIRCUIT CURRENT', 'PROTECTION RELAY', 'INSULATION LEVEL'
  ];

  let propertiesToShow: string[] = [];
  switch (template.type) {
    case 'LV': propertiesToShow = lvProperties; break;
    case 'MV': propertiesToShow = mvProperties; break;
    case 'HV': propertiesToShow = hvProperties; break;
  }

  const properties = (template.properties as Record<string, { parts: Array<{ partNumber: string; label: string; quantity: number; priority: number }> }>) || {};
  // Pull display names / locked rows from the same metadata used by the editor.
  const displayNames: Record<string, string> = (template.properties as any)?.__displayNames || {};
  const lockedRows: string[]                  = (template.properties as any)?.__locked || [];

  const getTypeColor = (type: 'LV' | 'MV' | 'HV') => {
    switch (type) {
      case 'LV': return 'bg-green-100 text-green-800';
      case 'MV': return 'bg-orange-100 text-orange-800';
      case 'HV': return 'bg-red-100 text-red-800';
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-[80%] max-h-[85%] flex flex-col">
        {/* Header */}
        <div className="bg-blue-600 text-white px-6 py-4 rounded-t-lg flex justify-between items-center">
          <div>
            <h2 className="text-xl font-semibold">Template Properties</h2>
            <p className="text-sm text-blue-100 mt-1">{template.name}</p>
          </div>
          <div className="flex items-center gap-3">
            <span className={`px-3 py-1 rounded-full text-sm font-semibold ${getTypeColor(template.type)}`}>
              {template.type}
            </span>
            <button onClick={onClose} className="text-white hover:bg-blue-700 rounded-full p-1">
              <XIcon className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mb-4 grid grid-cols-2 gap-4 bg-gray-50 p-4 rounded">
            <div>
              <span className="text-sm font-medium text-gray-600">Template Name:</span>
              <span className="ml-2 text-sm font-semibold">{template.name}</span>
            </div>
            <div>
              <span className="text-sm font-medium text-gray-600">Type:</span>
              <span className={`ml-2 px-2 py-0.5 rounded text-xs font-semibold ${getTypeColor(template.type)}`}>
                {template.type} ({template.type === 'LV' ? 'Low Voltage' : template.type === 'MV' ? 'Medium Voltage' : 'High Voltage'})
              </span>
            </div>
          </div>

          <div className="border border-gray-200 rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50">
                  <th className="px-4 py-2 text-left font-medium text-gray-600 border-b w-36">Property</th>
                  <th className="px-4 py-2 text-left font-medium text-gray-600 border-b">Part Number</th>
                  <th className="px-4 py-2 text-left font-medium text-gray-600 border-b w-40">RATING</th>
                  <th className="px-4 py-2 text-left font-medium text-gray-600 border-b w-28">Label</th>
                  <th className="px-4 py-2 text-center font-medium text-gray-600 border-b w-16">Qty</th>
                  <th className="px-4 py-2 text-center font-medium text-gray-600 border-b w-16">Priority</th>
                </tr>
              </thead>
              <tbody>
                {propertiesToShow.map((propName, idx) => {
                  const propValue = properties[propName] as { parts: Array<{ partNumber: string; label: string; quantity: number; priority: number; fullData?: any }> } | undefined;
                  const parts = propValue?.parts || [];

                  // Collect distinct manufacturers across all parts for this property,
                  // joined with "/" when multiple brands are present.
                  const manufacturers = Array.from(new Set(
                    parts.map(p => p.fullData?.Manufacturer)
                         .filter((m): m is string => Boolean(m && String(m).trim()))
                  ));
                  const manufacturerLabel = manufacturers.join(' / ');
                  const labelText = displayNames[propName] || propName;
                  const isLocked  = lockedRows.includes(propName);

                  if (parts.length === 0) {
                    return (
                      <tr key={idx} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                        <td className="px-4 py-2 border-b font-medium text-gray-700">
                          <div className={isLocked ? 'line-through text-gray-400' : ''}>{labelText}</div>
                          {isLocked && <div className="text-[10px] text-amber-600">🔒 locked</div>}
                        </td>
                        <td className="px-4 py-2 border-b text-gray-400 italic" colSpan={5}>No part assigned</td>
                      </tr>
                    );
                  }
                  return parts.map((part, pIdx) => (
                    <tr key={`${idx}-${pIdx}`} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                      {pIdx === 0 && (
                        <td className="px-4 py-2 border-b font-medium text-gray-700 align-top" rowSpan={parts.length}>
                          <div className={isLocked ? 'line-through text-gray-400' : ''}>{labelText}</div>
                          {isLocked && <div className="text-[10px] text-amber-600">🔒 locked</div>}
                          {manufacturerLabel && (
                            <div className="text-[10px] font-normal text-gray-500 mt-0.5">
                              {manufacturerLabel}
                            </div>
                          )}
                        </td>
                      )}
                      <td className="px-4 py-2 border-b text-xs font-mono">{part.partNumber || '-'}</td>
                      {/* RATING — shows Designation3 of the part */}
                      <td className="px-4 py-2 border-b">
                        <span className="bg-amber-50 text-amber-900 px-2 py-0.5 rounded text-xs">
                          {part.fullData?.Designation3 || '—'}
                        </span>
                      </td>
                      <td className="px-4 py-2 border-b">{part.label || '-'}</td>
                      <td className="px-4 py-2 border-b text-center">{part.quantity}</td>
                      <td className="px-4 py-2 border-b text-center">{part.priority}</td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t flex justify-between items-center bg-gray-50 rounded-b-lg">
          <button
            onClick={() => onEdit(template.id)}
            className="flex items-center px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
          >
            <EditIcon className="w-4 h-4 mr-2" />
            Edit Template
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-50 text-sm"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

// ===== COLUMN DEFINITIONS (per equipment type) =====
type DeviceColumnKey =
  | 'templateName' | 'wiringType' | 'ratingPower' | 'flc' | 'feederNo'
  | 'busSection' | 'sfdHfd' | 'tag' | 'description' | 'moduleNo'
  | 'size' | 'cableSize';

interface DeviceColumnDef {
  key: DeviceColumnKey;
  header: string;
  isTemplate?: boolean;
  width?: string; // tailwind width class
}

const MV_COLUMNS: DeviceColumnDef[] = [
  { key: 'templateName', header: 'Template', isTemplate: true },
  { key: 'wiringType',   header: 'WIRING TYPE' },
  { key: 'ratingPower',  header: 'RATING POWER (kW/KVA)' },
  { key: 'flc',          header: 'FLC (A)' },
  { key: 'feederNo',     header: 'FEEDER NO.' },
  { key: 'busSection',   header: 'BUS SECTION' },
  { key: 'tag',          header: 'TAG' },
  { key: 'description',  header: 'DESCRIPTION' },
  { key: 'cableSize',    header: 'CABLE SIZE' },
];

const LV_COLUMNS: DeviceColumnDef[] = [
  { key: 'templateName', header: 'Template', isTemplate: true },
  { key: 'wiringType',   header: 'WIRING TYPE' },
  { key: 'ratingPower',  header: 'RATING POWER (kW/KVA)' },
  { key: 'flc',          header: 'FLC (A)' },
  { key: 'feederNo',     header: 'FEEDER NO.' },
  { key: 'busSection',   header: 'BUS SECTION' },
  { key: 'sfdHfd',       header: 'SFD/HFD' },
  { key: 'tag',          header: 'TAG' },
  { key: 'description',  header: 'DESCRIPTION' },
  { key: 'moduleNo',     header: 'MODULE NO.' },
  { key: 'size',         header: 'SIZE' },
  { key: 'cableSize',    header: 'CABLE SIZE' },
];

const getColumnsForType = (type: 'LV' | 'MV' | 'HV'): DeviceColumnDef[] =>
  type === 'LV' ? LV_COLUMNS : MV_COLUMNS;

// Row/cell color palette. Includes soft pastels plus saturated red/green/yellow
// (per spec). Empty string = clear color.
const ROW_COLOR_PALETTE: { label: string; value: string }[] = [
  { label: 'No color',     value: '' },
  // Saturated / bold (added per spec — sit at the top for quick access)
  { label: 'Bold Red',     value: '#ef4444' },
  { label: 'Bold Green',   value: '#22c55e' },
  { label: 'Bold Yellow',  value: '#facc15' },
  // Softer pastels
  { label: 'Yellow',       value: '#fef3c7' },
  { label: 'Amber',        value: '#fde68a' },
  { label: 'Orange',       value: '#fed7aa' },
  { label: 'Rose',         value: '#fecdd3' },
  { label: 'Red',          value: '#fecaca' },
  { label: 'Lime',         value: '#d9f99d' },
  { label: 'Green',        value: '#bbf7d0' },
  { label: 'Teal',         value: '#99f6e4' },
  { label: 'Cyan',         value: '#a5f3fc' },
  { label: 'Sky',          value: '#bae6fd' },
  { label: 'Indigo',       value: '#c7d2fe' },
  { label: 'Purple',       value: '#e9d5ff' },
  { label: 'Pink',         value: '#fbcfe8' },
  { label: 'Gray',         value: '#e5e7eb' },
];

// Excel-style per-column dropdown filter. Stores the SET of values kept
// (i.e. only rows whose column value is in the set are shown). `undefined`
// means no filter for this column. No sort capability is exposed — sort is
// intentionally disabled per spec.
//
// Rendered through a portal so it escapes any overflow:auto/hidden parent
// (the table scroll container would otherwise clip it). Position is given
// in viewport coordinates by the caller (the anchor button's bounding rect).
interface ColumnFilterDropdownProps {
  columnHeader: string;
  allValues: string[];           // unique values from the unfiltered dataset
  selectedValues?: Set<string>;  // currently kept values (undefined = all)
  anchorRect: DOMRect;
  onApply: (next: Set<string> | undefined) => void;
  onClose: () => void;
}

const ColumnFilterDropdown: React.FC<ColumnFilterDropdownProps> = ({
  columnHeader, allValues, selectedValues, anchorRect, onApply, onClose,
}) => {
  const initial = selectedValues ? new Set(selectedValues) : new Set(allValues);
  const [draft, setDraft] = useState<Set<string>>(initial);
  const [search, setSearch] = useState('');

  const filteredValues = allValues.filter(v =>
    !search || v.toLowerCase().includes(search.toLowerCase())
  );
  const allChecked = filteredValues.length > 0 && filteredValues.every(v => draft.has(v));

  const toggle = (v: string) => {
    const next = new Set(draft);
    if (next.has(v)) next.delete(v); else next.add(v);
    setDraft(next);
  };
  const toggleAll = () => {
    const next = new Set(draft);
    if (allChecked) filteredValues.forEach(v => next.delete(v));
    else filteredValues.forEach(v => next.add(v));
    setDraft(next);
  };
  const handleApply = () => {
    if (allValues.every(v => draft.has(v))) onApply(undefined);
    else onApply(draft);
    onClose();
  };
  const handleClear = () => { onApply(undefined); onClose(); };

  // Position the dropdown just below the anchor, clamped to viewport.
  const dropdownWidth = 280;
  let left = anchorRect.left;
  if (left + dropdownWidth > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - dropdownWidth - 8);
  }
  const top = anchorRect.bottom + 4;

  return createPortal(
    <>
      {/* Click-catcher behind the dropdown so clicks anywhere else close it. */}
      <div className="fixed inset-0 z-[9998]" onClick={onClose} />
      <div
        className="fixed z-[9999] bg-white border border-gray-300 rounded shadow-2xl text-xs"
        style={{ top, left, width: dropdownWidth }}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b bg-gradient-to-r from-blue-50 to-indigo-50">
          <p className="font-semibold text-gray-700 truncate" title={columnHeader}>
            Filter: {columnHeader}
          </p>
        </div>
        <div className="p-2 border-b">
          <input
            type="text"
            autoFocus
            placeholder="Search…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-400"
          />
        </div>
        <div className="max-h-60 overflow-y-auto">
          <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-100 cursor-pointer border-b">
            <input type="checkbox" checked={allChecked} onChange={toggleAll} />
            <span className="font-semibold">(Select All)</span>
          </label>
          {filteredValues.length === 0 && (
            <div className="px-3 py-2 text-gray-400 italic">No values</div>
          )}
          {filteredValues.map(v => (
            <label key={v} className="flex items-center gap-2 px-3 py-1 hover:bg-gray-100 cursor-pointer">
              <input type="checkbox" checked={draft.has(v)} onChange={() => toggle(v)} />
              <span className="truncate" title={v}>
                {v === '' ? <em className="text-gray-400">(Blanks)</em> : v}
              </span>
            </label>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 p-2 border-t bg-gray-50">
          <button
            className="text-xs text-gray-500 hover:text-red-600 underline"
            onClick={handleClear}
            title="Remove filter for this column"
          >
            Clear Filter
          </button>
          <div className="flex gap-2">
            <button className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-100" onClick={onClose}>
              Cancel
            </button>
            <button className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700" onClick={handleApply}>
              OK
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
};

// Standalone "Filter by color" dropdown. Filters rows by their rowColor field;
// `null` color means "rows with no colour set". Mirrors the same Excel-style
// checkbox UX but operates on a colour palette rather than free-form values.
interface ColorFilterDropdownProps {
  /** Unique row colours currently present in the dataset. `''` = no colour. */
  allColors: string[];
  selectedColors?: Set<string>;
  anchorRect: DOMRect;
  onApply: (next: Set<string> | undefined) => void;
  onClose: () => void;
}

const ColorFilterDropdown: React.FC<ColorFilterDropdownProps> = ({
  allColors, selectedColors, anchorRect, onApply, onClose,
}) => {
  const initial = selectedColors ? new Set(selectedColors) : new Set(allColors);
  const [draft, setDraft] = useState<Set<string>>(initial);

  const colorLabel = (c: string) =>
    ROW_COLOR_PALETTE.find(p => p.value === c)?.label || c || '(No colour)';

  const toggle = (c: string) => {
    const next = new Set(draft);
    if (next.has(c)) next.delete(c); else next.add(c);
    setDraft(next);
  };
  const toggleAll = () => {
    const allChecked = allColors.every(c => draft.has(c));
    if (allChecked) setDraft(new Set());
    else setDraft(new Set(allColors));
  };
  const allChecked = allColors.length > 0 && allColors.every(c => draft.has(c));
  const handleApply = () => {
    if (allColors.every(c => draft.has(c))) onApply(undefined);
    else onApply(draft);
    onClose();
  };

  const width = 240;
  let left = anchorRect.left;
  if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);

  return createPortal(
    <>
      <div className="fixed inset-0 z-[9998]" onClick={onClose} />
      <div
        className="fixed z-[9999] bg-white border border-gray-300 rounded shadow-2xl text-xs"
        style={{ top: anchorRect.bottom + 4, left, width }}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b bg-gradient-to-r from-pink-50 to-amber-50 font-semibold text-gray-700">
          Filter by row colour
        </div>
        <div className="max-h-60 overflow-y-auto">
          <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-100 cursor-pointer border-b">
            <input type="checkbox" checked={allChecked} onChange={toggleAll} />
            <span className="font-semibold">(Select All)</span>
          </label>
          {allColors.length === 0 && (
            <div className="px-3 py-2 text-gray-400 italic">No coloured rows yet</div>
          )}
          {allColors.map(c => (
            <label key={c || 'none'} className="flex items-center gap-2 px-3 py-1 hover:bg-gray-100 cursor-pointer">
              <input type="checkbox" checked={draft.has(c)} onChange={() => toggle(c)} />
              <span
                className="inline-block w-4 h-4 rounded border border-gray-300 flex-shrink-0"
                style={{ background: c || '#fff' }}
              />
              <span className="truncate">{colorLabel(c)}</span>
            </label>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 p-2 border-t bg-gray-50">
          <button
            className="text-xs text-gray-500 hover:text-red-600 underline"
            onClick={() => { onApply(undefined); onClose(); }}
          >
            Clear
          </button>
          <div className="flex gap-2">
            <button className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-100" onClick={onClose}>
              Cancel
            </button>
            <button className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700" onClick={handleApply}>
              OK
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
};

// ===== DEVICE TABLE COMPONENT =====
const DeviceTable: React.FC<DeviceTableProps> = ({
  selectedEquipment,
  updateEquipment,
  projectData,
  isFullscreen,
  onToggleFullscreen,
  onShowTemplateProperties,
  clipboardRows,
  onCopyRows
}) => {
  const [rows, setRowsRaw] = useState<DeviceTableRow[]>([]);
  // Every table edit goes through setRows, so gating it here makes the whole
  // grid read-only on a locked (non-latest) revision — with the warning
  // dialog instead of a silently dropped change.
  const { isCurrentRevisionEditable, notifyRevisionLocked } = useProject();
  const setRows: React.Dispatch<React.SetStateAction<DeviceTableRow[]>> = value => {
    if (!isCurrentRevisionEditable) { notifyRevisionLocked(); return; }
    setRowsRaw(value);
  };
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [lastSelectedIdx, setLastSelectedIdx] = useState<number>(-1);
  // Per-column Excel-style filters. A column has an active filter iff its
  // entry is a Set — and only rows whose value is in that Set are shown.
  // `undefined` / absent entry = no filter for that column.
  const [filters, setFilters] = useState<Partial<Record<DeviceColumnKey, Set<string>>>>({});
  // Filter by row background colour. `undefined` = no colour filter.
  const [colorFilter, setColorFilter] = useState<Set<string> | undefined>(undefined);
  // Master "filtering enabled" switch. When OFF the per-column ▼ icons are
  // hidden and existing filters are bypassed (visually clear, structurally
  // remembered so flipping ON restores them).
  const [filtersEnabled, setFiltersEnabled] = useState(false);
  // Which column's filter dropdown is currently open (null = none).
  const [openFilterCol, setOpenFilterCol] = useState<DeviceColumnKey | null>(null);
  // Anchor rect for the currently-open dropdown (column filter or color filter).
  const [filterAnchor, setFilterAnchor] = useState<DOMRect | null>(null);
  // Whether the global "Filter by colour" popup is open.
  const [colorFilterOpen, setColorFilterOpen] = useState(false);
  // For cell colorize submenu: which cell is being targeted
  const [colorTarget, setColorTarget] = useState<{ rowId: string; colKey: DeviceColumnKey } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    type: 'row' | 'cell' | null;
    cellRowId?: string
  } | null>(null);
  const [moveToRow, setMoveToRow] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedCellRowId, setSelectedCellRowId] = useState<string | null>(null);
  // Appends read-only "template item" columns (one per template property of
  // the CURRENT equipment's type) to the right of the existing columns —
  // same table, more columns, not a separate section.
  const [showTemplateColumns, setShowTemplateColumns] = useState(false);
  // How many columns (from the left, counting the # column) stay pinned in
  // place while the rest of the table scrolls horizontally.
  const [freezeCount, setFreezeCount] = useState(0);

  // Track previous equipment ID to only reload rows when equipment changes
  const prevEquipmentIdRef = useRef<string | null>(null);
  // The exact rows array last loaded from an equipment, so the write-back
  // effect below can tell "freshly loaded" from "edited by the user".
  const loadedRowsRef = useRef<DeviceTableRow[] | null>(null);

  useEffect(() => {
    // Only reload rows when the selected equipment ID changes (different equipment selected)
    // NOT when the same equipment's data is updated (would cause infinite loop)
    if (selectedEquipment?.id !== prevEquipmentIdRef.current) {
      prevEquipmentIdRef.current = selectedEquipment?.id || null;
      // Loading rows for a newly selected equipment is not a user edit —
      // bypass the read-only gate so viewing an old revision still works.
      const loaded = selectedEquipment?.devices || [];
      loadedRowsRef.current = loaded;
      setRowsRaw(loaded);
      setSelectedRows(new Set());
    }
  }, [selectedEquipment]);

  useEffect(() => {
    // Skip the write-back right after loading an equipment's rows: `rows` is
    // still the very array we got from it, so there is nothing to persist.
    if (!selectedEquipment || rows === loadedRowsRef.current) return;
    updateEquipment(selectedEquipment.id, { devices: rows });
  }, [rows]);

  const handleRowClick = (id: string, e: React.MouseEvent) => {
    const displayedRows = getFilteredRows();
    const clickedIdx = displayedRows.findIndex(r => r.id === id);
    if (e.shiftKey && lastSelectedIdx >= 0) {
      const lo = Math.min(lastSelectedIdx, clickedIdx);
      const hi = Math.max(lastSelectedIdx, clickedIdx);
      const rangeIds = displayedRows.slice(lo, hi + 1).map(r => r.id);
      setSelectedRows(prev => new Set([...prev, ...rangeIds]));
    } else if (e.ctrlKey || e.metaKey) {
      const newSelected = new Set(selectedRows);
      if (newSelected.has(id)) { newSelected.delete(id); } else { newSelected.add(id); }
      setSelectedRows(newSelected);
      setLastSelectedIdx(clickedIdx);
    } else {
      setSelectedRows(new Set([id]));
      setLastSelectedIdx(clickedIdx);
    }
  };

  // Returns rows filtered by Excel-style per-column value filters and the
  // optional row-colour filter. Both are bypassed entirely when filtering is
  // disabled at the toolbar level.
  const activeColumns = getColumnsForType(selectedEquipment?.type ?? 'MV');

  // Template-item columns (read-only) — property list matches the CURRENT
  // equipment's type, mirroring TemplateProperties.tsx's per-type layout.
  const templatePropertyNames = !showTemplateColumns ? [] : (
    selectedEquipment?.type === 'LV' ? LV_TEMPLATE_PROPERTIES :
    selectedEquipment?.type === 'MV' ? MV_TEMPLATE_PROPERTIES :
    selectedEquipment?.type === 'HV' ? HV_TEMPLATE_PROPERTIES : []
  );
  const templatesById = useMemo(() => {
    const list = selectedEquipment ? (projectData.templates[selectedEquipment.type] || []) : [];
    return new Map(list.map(t => [t.id, t]));
  }, [projectData.templates, selectedEquipment?.type]);
  const getTemplatePropertyText = (row: DeviceTableRow, propName: string): string => {
    const tmpl = row.templateId ? templatesById.get(row.templateId) : undefined;
    if (!tmpl) return '';
    return partsCellText(templateParts(tmpl)[propName] || []);
  };

  // ── Freeze-columns (sticky panes) ───────────────────────────────────────
  // Column order is: # | ...activeColumns | ...templatePropertyNames (when
  // shown). We measure each header cell's real rendered width (fluid table
  // layout — no fixed widths) and sticky-position the first `freezeCount`
  // columns using those measured offsets, so freeze works whether or not
  // the extra template columns are visible.
  const totalColumnCount = 1 + activeColumns.length + templatePropertyNames.length;
  const colHeaderRefs = useRef<(HTMLTableCellElement | null)[]>([]);
  const [stickyLefts, setStickyLefts] = useState<number[]>([]);

  useLayoutEffect(() => {
    const recompute = () => {
      const lefts: number[] = [];
      let acc = 0;
      for (let i = 0; i < totalColumnCount; i++) {
        lefts[i] = acc;
        acc += colHeaderRefs.current[i]?.offsetWidth || 0;
      }
      setStickyLefts(lefts);
    };
    recompute();
    const observer = new ResizeObserver(recompute);
    colHeaderRefs.current.slice(0, totalColumnCount).forEach(el => el && observer.observe(el));
    return () => observer.disconnect();
  }, [totalColumnCount, freezeCount, rows.length, showTemplateColumns]);

  const stickyStyle = (colIndex: number, bg: string): React.CSSProperties | undefined =>
    colIndex < freezeCount
      ? {
          position: 'sticky',
          left: stickyLefts[colIndex] ?? 0,
          zIndex: 2,
          background: bg,
          boxShadow: colIndex === freezeCount - 1 ? '2px 0 4px -2px rgba(0,0,0,0.25)' : undefined,
        }
      : undefined;
  const getFilteredRows = () => {
    if (!filtersEnabled) return rows;
    return rows.filter(row => {
      if (colorFilter && !colorFilter.has(row.rowColor || '')) return false;
      return activeColumns.every(col => {
        const allowed = filters[col.key];
        if (!allowed) return true;
        const val = String((row as any)[col.key] ?? '');
        return allowed.has(val);
      });
    });
  };

  // Unique values for a column (used to populate the filter dropdown).
  // Note: this looks at the FULL row set, not the filtered one, so users can
  // re-broaden a filter even when other columns are filtered down.
  const getUniqueValuesForColumn = (key: DeviceColumnKey): string[] => {
    const values = new Set<string>();
    rows.forEach(r => values.add(String((r as any)[key] ?? '')));
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  };

  // Unique row colours (incl. '' for "no colour") for the colour-filter popup.
  const getUniqueRowColors = (): string[] => {
    const values = new Set<string>();
    rows.forEach(r => values.add(r.rowColor || ''));
    return Array.from(values);
  };

  const hasAnyFilter = filtersEnabled && (
    !!colorFilter || Object.values(filters).some(f => !!f)
  );
  const clearAllFilters = () => { setFilters({}); setColorFilter(undefined); };

  const handleContextMenu = (e: React.MouseEvent, type: 'row' | 'cell', rowId?: string) => {
    e.preventDefault();
    e.stopPropagation();

    if (type === 'row') {
      // If right-clicking a specific row that isn't selected, select it first
      if (rowId && !selectedRows.has(rowId)) {
        setSelectedRows(new Set([rowId]));
      }
      if (selectedRows.size > 0 || rowId) {
        setContextMenu({ visible: true, x: e.clientX, y: e.clientY, type: 'row' });
      }
    } else if (type === 'cell' && rowId) {
      setSelectedCellRowId(rowId);
      setContextMenu({ visible: true, x: e.clientX, y: e.clientY, type: 'cell', cellRowId: rowId });
    }
  };

  const handleCloseContextMenu = () => {
    setContextMenu(null);
    setMoveToRow('');
    setColorTarget(null);
  };

  useEffect(() => {
    const handleClickOutside = () => handleCloseContextMenu();
    if (contextMenu?.visible) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [contextMenu]);

  // Filter dropdowns are portals with their own click-catcher — no global
  // listener needed here.

  const reorderRows = (newRows: DeviceTableRow[]) => {
    const reordered = newRows.map((row, index) => ({
      ...row,
      rowNumber: index + 1
    }));
    setRows(reordered);
  };

  const handleMoveRows = (direction: 'up' | 'down') => {
    const selectedIds = Array.from(selectedRows);
    const indices = selectedIds.map(id => rows.findIndex(r => r.id === id)).sort((a, b) => a - b);

    if (direction === 'up' && indices[0] > 0) {
      const newRows = [...rows];
      indices.forEach(idx => {
        [newRows[idx], newRows[idx - 1]] = [newRows[idx - 1], newRows[idx]];
      });
      reorderRows(newRows);
    } else if (direction === 'down' && indices[indices.length - 1] < rows.length - 1) {
      const newRows = [...rows];
      indices.reverse().forEach(idx => {
        [newRows[idx], newRows[idx + 1]] = [newRows[idx + 1], newRows[idx]];
      });
      reorderRows(newRows);
    }
    handleCloseContextMenu();
  };

  const handleMoveToRow = () => {
    const targetRowNum = parseInt(moveToRow);
    if (!targetRowNum || targetRowNum < 1 || targetRowNum > rows.length) {
      alert('Invalid row number');
      return;
    }

    const selectedIds = Array.from(selectedRows);
    const selectedRowsData = rows.filter(r => selectedIds.includes(r.id));
    const otherRows = rows.filter(r => !selectedIds.includes(r.id));

    const targetIndex = targetRowNum - 1;
    const newRows = [
      ...otherRows.slice(0, targetIndex),
      ...selectedRowsData,
      ...otherRows.slice(targetIndex)
    ];

    reorderRows(newRows);
    handleCloseContextMenu();
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent, rowId: string) => {
    e.preventDefault();
    const templateId = e.dataTransfer.getData('templateId');

    if (!selectedEquipment) return;

    let templateName = '';
    let templateType: 'LV' | 'MV' | 'HV' | null = null;

    for (const type of ['LV', 'MV', 'HV'] as const) {
      const template = projectData.templates[type].find(t => t.id === templateId);
      if (template) {
        templateName = template.name;
        templateType = type;
        break;
      }
    }

    if (templateType && templateType !== selectedEquipment.type) {
      alert(`Cannot add ${templateType} template to ${selectedEquipment.type} equipment!`);
      return;
    }

    setRows(rows.map(row =>
      row.id === rowId ? { ...row, templateId, templateName } : row
    ));
  };

  const handleAddTemplateToCell = (templateId: string) => {
    if (!selectedCellRowId || !selectedEquipment) return;

    let templateName = '';
    let templateType: 'LV' | 'MV' | 'HV' | null = null;

    for (const type of ['LV', 'MV', 'HV'] as const) {
      const template = projectData.templates[type].find(t => t.id === templateId);
      if (template) {
        templateName = template.name;
        templateType = type;
        break;
      }
    }

    if (templateType && templateType !== selectedEquipment.type) {
      alert(`Cannot add ${templateType} template to ${selectedEquipment.type} equipment!`);
      return;
    }

    setRows(rows.map(row =>
      row.id === selectedCellRowId ? { ...row, templateId, templateName } : row
    ));

    handleCloseContextMenu();
    setSelectedCellRowId(null);
  };

  const handleAddRow = () => {
    if (!selectedEquipment) {
      alert('Please select an equipment first!');
      return;
    }

    const newRow: DeviceTableRow = {
      id: `device-${Date.now()}`,
      rowNumber: rows.length + 1,
      templateId: '',
      templateName: '',
      busSection: '',
      feederNo: '',
      wiringType: '',
      ratingPower: '',
      flc: '',
      tag: '',
      description: '',
      cableSize: '',
      sfdHfd: '',
      moduleNo: '',
      size: '',
      equipmentId: selectedEquipment.id
    };
    setRows([...rows, newRow]);
  };

  /**
   * The Excel this table was last filled from, so it can be read again.
   *
   * Where the browser supports the File System Access API — Chrome and Edge,
   * which is what this office runs — picking a file hands back a *handle*, and
   * a handle can be re-read later. That is what makes Update possible at all:
   * the person edits the same spreadsheet in Excel, saves it, presses Update,
   * and the table catches up without going through the file picker again.
   *
   * Everywhere else the handle is absent and Update falls back to asking for
   * the file, which is honest about what the browser will and will not do.
   */
  const [excelFile, setExcelFile] = useState<{
    name: string;
    /** Present only where the browser can re-read without asking again. */
    handle?: FileSystemFileHandle;
    file?: File;
  } | null>(null);
  const [excelReadAt, setExcelReadAt] = useState<Date | null>(null);
  const [excelNote, setExcelNote] = useState<string | null>(null);

  const handleImportExcel = async () => {
    if (!selectedEquipment) {
      alert('Please select an equipment first!');
      return;
    }
    // Ask for a handle first: it costs the same click and buys Update.
    const picker = (window as unknown as {
      showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]>;
    }).showOpenFilePicker;
    if (picker) {
      try {
        const [handle] = await picker({
          multiple: false,
          types: [{
            description: 'Excel or CSV',
            accept: {
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
              'application/vnd.ms-excel': ['.xls'],
              'text/csv': ['.csv'],
            },
          }],
        });
        if (!handle) return;
        const file = await handle.getFile();
        setExcelFile({ name: file.name, handle });
        setExcelNote(null);
        importExcelFile(file);
        return;
      } catch (err) {
        // The person closed the picker — not an error, and not a reason to
        // open a second one behind it.
        if ((err as DOMException)?.name === 'AbortError') return;
      }
    }
    fileInputRef.current?.click();
  };

  /** Read the same spreadsheet again, after it has been edited in Excel. */
  const handleUpdateExcel = async () => {
    if (!excelFile) return;
    if (excelFile.handle) {
      try {
        const file = await excelFile.handle.getFile();
        setExcelNote(null);
        importExcelFile(file, true);
        return;
      } catch {
        setExcelNote('Could not read the file again — it may have been moved or renamed.');
        return;
      }
    }
    // No handle: this browser cannot re-open a path on its own, so it has to
    // be pointed at the file again. Said plainly rather than failing quietly.
    setExcelNote('This browser cannot re-read the file on its own — choose it again.');
    fileInputRef.current?.click();
  };

  /**
   * Read one Excel or CSV file into the table.
   *
   * Import and Update both come through here, so a re-read cannot drift from
   * the first read — the same columns, the same rules, the same result.
   */
  const importExcelFile = (file: File, quiet = false) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = new Uint8Array(event.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        // Convert to array of arrays (raw) to handle empty cells properly
        const jsonData = XLSX.utils.sheet_to_json<Record<string, string>>(worksheet, {
          defval: '',
          raw: false
        });

        if (jsonData.length === 0) {
          alert('No data found in the Excel file.');
          return;
        }

        // Template column is NEVER imported - only via right-click or drag-and-drop
        // Expected columns: Bus Section, Feeder No, Wiring Type, Rating Power, FLC (A)
        const importedRows: DeviceTableRow[] = jsonData
          .filter(row => {
            // Skip rows where all relevant cells are empty
            const busSection = (row['Bus Section'] || row['busSection'] || row['bus section'] || row['BUS SECTION'] || '').toString().trim();
            const feederNo = (row['Feeder No'] || row['feederNo'] || row['feeder no'] || row['FEEDER NO'] || row['Feeder Number'] || '').toString().trim();
            const wiringType = (row['Wiring Type'] || row['wiringType'] || row['wiring type'] || row['WIRING TYPE'] || '').toString().trim();
            const ratingPower = (row['Rating Power'] || row['ratingPower'] || row['rating power'] || row['RATING POWER'] || row['Rating (kW)'] || '').toString().trim();
            const flc = (row['FLC (A)'] || row['FLC'] || row['flc'] || row['Flc'] || row['FLC(A)'] || '').toString().trim();
            return busSection || feederNo || wiringType || ratingPower || flc;
          })
          .map((row, index) => {
            const pick = (...keys: string[]) => {
              for (const k of keys) {
                if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') {
                  return String(row[k]).trim();
                }
              }
              return '';
            };
            const busSection  = pick('Bus Section', 'busSection', 'bus section', 'BUS SECTION');
            const feederNo    = pick('Feeder No', 'feederNo', 'feeder no', 'FEEDER NO', 'FEEDER NO.', 'Feeder Number');
            const wiringType  = pick('Wiring Type', 'wiringType', 'wiring type', 'WIRING TYPE');
            const ratingPower = pick('Rating Power', 'ratingPower', 'rating power', 'RATING POWER', 'RATING POWER(KW OR KVA)', 'Rating (kW)');
            const flc         = pick('FLC (A)', 'FLC', 'flc', 'Flc', 'FLC(A)');
            const tag         = pick('TAG', 'Tag', 'tag');
            const description = pick('DESCRIPTION', 'Description', 'description');
            const cableSize   = pick('CABLE SIZE', 'Cable Size', 'cableSize', 'CABEL SIZE');
            const sfdHfd      = pick('SFD/HFD', 'sfdHfd', 'SFD HFD');
            const moduleNo    = pick('MODULE NO.', 'MODULE NO', 'Module No', 'moduleNo');
            const size        = pick('SIZE', 'SAIZE', 'Size', 'size');

            return {
              id: `device-${Date.now()}-${index}`,
              rowNumber: index + 1,   // always starts from 1
              templateId: '',
              templateName: '',
              busSection,
              feederNo,
              wiringType,
              ratingPower,
              flc,
              tag,
              description,
              cableSize,
              sfdHfd,
              moduleNo,
              size,
              equipmentId: selectedEquipment!.id
            };
          });

        if (importedRows.length === 0) {
          alert('No valid rows found. Make sure the Excel file has data in columns: Bus Section, Feeder No, Wiring Type, Rating Power, FLC (A)');
          return;
        }

        // Replace all rows with imported data (starting from row 1)
        setRows(importedRows);
        setExcelReadAt(new Date());
        if (quiet) {
          // An Update says how many rows came back and nothing else: it is a
          // button pressed on purpose, not a surprise.
          setExcelNote(`Updated from ${file.name} — ${importedRows.length} row(s)`);
        } else {
          alert(`Imported ${importedRows.length} row(s) — existing rows replaced.\n\nAssign templates via right-click on the Template cell or drag-and-drop.`);
        }
      } catch (error) {
        console.error('Import error:', error);
        alert('Error importing file. Please make sure it is a valid Excel (.xlsx/.xls) or CSV file with columns: Bus Section, Feeder No, Wiring Type, Rating Power, FLC (A)');
      }
    };

    reader.readAsArrayBuffer(file);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Picked through the plain input, so there is no handle to re-read with.
    setExcelFile({ name: file.name, file });
    setExcelNote(null);
    importExcelFile(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Excel export mirrors handleFileUpload's expected headers exactly, so a
  // round-trip (export → fill in Excel → import) works. The Template column
  // is intentionally excluded — templates can only be assigned inside the
  // software (drag-and-drop or right-click), never via Excel.
  const handleExportExcel = () => {
    if (!selectedEquipment) {
      alert('Please select an equipment first!');
      return;
    }
    const fillableColumns = activeColumns.filter(col => !col.isTemplate);
    const headerRow = fillableColumns.map(col => col.header);
    const dataRows = rows.map(row => fillableColumns.map(col => (row as any)[col.key] ?? ''));
    const ws = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Devices');
    XLSX.writeFile(wb, `${selectedEquipment.name}_Devices.xlsx`);
  };

  const updateRowField = (rowId: string, field: keyof DeviceTableRow, value: string) => {
    setRows(rows.map(row =>
      row.id === rowId ? { ...row, [field]: value } : row
    ));
  };

  if (!selectedEquipment) {
    return (
      <div className="flex items-center justify-center h-64 bg-gray-50 border-2 border-dashed border-gray-300 rounded">
        <div className="text-center">
          <p className="text-gray-500">No Equipment Selected</p>
          <p className="text-sm text-gray-400 mt-2">Select equipment to manage devices</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        style={{ display: 'none' }}
        onChange={handleFileUpload}
      />

      <div className="mb-4 flex justify-between items-center">
        <div>
          <h3 className="font-semibold">Device Table: {selectedEquipment.name}</h3>
          <p className="text-xs text-gray-500">Type: <span className="font-semibold">{selectedEquipment.type}</span> | Power: {selectedEquipment.power || 'N/A'}</p>
        </div>
        <div className="flex space-x-2">
          <button
            className="px-3 py-1 bg-purple-600 text-white rounded text-sm hover:bg-purple-700"
            onClick={onToggleFullscreen}
            title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? <MinimizeIcon className="w-4 h-4 inline mr-1" /> : <MaximizeIcon className="w-4 h-4 inline mr-1" />}
            {isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
          </button>
          <button
            className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
            onClick={handleAddRow}
          >
            <PlusIcon className="w-4 h-4 inline mr-1" />
            Add Row
          </button>
          <button
            className="px-3 py-1 bg-green-600 text-white rounded text-sm hover:bg-green-700"
            onClick={handleImportExcel}
            title="Import from Excel (.xlsx, .xls, .csv). Template column will NOT be imported."
          >
            <UploadIcon className="w-4 h-4 inline mr-1" />
            Import Excel
          </button>
          {/* Stub for now — reads a SIMARIS export (a different sheet layout
              than the app's own Import Excel above) to pull MODULE NO. from.
              Behaviour to be specified; this just gets the button in place. */}
          <button
            className="px-3 py-1 bg-orange-600 text-white rounded text-sm hover:bg-orange-700"
            onClick={() => alert('Import from SIMARIS — coming soon.')}
            title="Import a SIMARIS Excel export to pull MODULE NO. from"
          >
            <UploadIcon className="w-4 h-4 inline mr-1" />
            Import from SIMARIS
          </button>
          {/* Shown only once something has been imported: a button that reads
              the same file again, for when the spreadsheet has been edited in
              Excel and saved back to the same place. */}
          {excelNote && (
            <span className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">
              {excelNote}
            </span>
          )}
          {excelFile && (
            <button
              data-update-excel
              className="px-3 py-1 bg-emerald-700 text-white rounded text-sm hover:bg-emerald-800"
              onClick={handleUpdateExcel}
              title={`Read ${excelFile.name} again${
                excelReadAt ? ` — last read at ${excelReadAt.toLocaleTimeString()}` : ''
              }. Edit the spreadsheet in Excel, save it, then press this.`}
            >
              <RefreshCwIcon className="w-4 h-4 inline mr-1" />
              Update from {excelFile.name.length > 22
                ? `${excelFile.name.slice(0, 20)}…`
                : excelFile.name}
            </button>
          )}
          <button
            className="px-3 py-1 bg-teal-600 text-white rounded text-sm hover:bg-teal-700"
            onClick={handleExportExcel}
            title="Export the current device rows to Excel, with the same headers Import Excel expects. Template column is excluded — it can only be assigned inside the software."
          >
            <DownloadIcon className="w-4 h-4 inline mr-1" />
            Export Excel
          </button>
          <button
            className="px-3 py-1 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700"
            onClick={() => setShowTemplateColumns(v => !v)}
            title={`Append read-only ${selectedEquipment.type} template item columns to the right of this table, formatted like the Output Types tab`}
          >
            <LayersIcon className="w-4 h-4 inline mr-1" />
            {showTemplateColumns ? 'Hide Template Items' : 'Show Template Items'}
          </button>
          {clipboardRows.length > 0 && (
            <button
              className="px-3 py-1 bg-yellow-500 text-white rounded text-sm hover:bg-yellow-600"
              title={`Paste ${clipboardRows.length} row(s) from clipboard`}
              onClick={() => {
                const now = Date.now();
                const pasted = clipboardRows.map((r, i) => ({
                  ...r,
                  id: `device-${now}-${i}`,
                  rowNumber: rows.length + i + 1
                }));
                setRows(prev => [...prev, ...pasted]);
              }}
            >
              <ClipboardIcon className="w-4 h-4 inline mr-1" />
              Paste {clipboardRows.length} Row(s)
            </button>
          )}
        </div>
      </div>

      {/* Filter toolbar — toggles whether column ▼ icons + colour filter
          are surfaced. When OFF, all filters are bypassed (kept in memory
          so flipping ON restores them). */}
      <div className="mb-2 flex items-center gap-2 text-xs">
        <button
          onClick={() => {
            // Turning OFF also clears any active filters per the user spec
            // ("with another press, filter is removed").
            if (filtersEnabled) clearAllFilters();
            setFiltersEnabled(e => !e);
          }}
          className={`px-3 py-1.5 rounded border flex items-center gap-1.5 font-medium transition-colors ${
            filtersEnabled
              ? 'bg-blue-600 text-white border-blue-700 hover:bg-blue-700'
              : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
          }`}
          title="Toggle column filters and colour filter on/off"
        >
          <FilterIcon className="w-3.5 h-3.5" />
          {filtersEnabled ? 'Filters: ON' : 'Filters: OFF'}
        </button>

        <div
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded border font-medium ${
            freezeCount > 0
              ? 'bg-amber-500 text-white border-amber-600'
              : 'bg-white text-gray-700 border-gray-300'
          }`}
          title="Freeze this many columns from the left (including #) so they stay put while you scroll the rest horizontally"
        >
          <PinIcon className="w-3.5 h-3.5" />
          <span>Freeze</span>
          <input
            type="number"
            min={0}
            max={totalColumnCount}
            value={freezeCount}
            onChange={e => {
              const n = parseInt(e.target.value, 10);
              setFreezeCount(Number.isNaN(n) ? 0 : Math.max(0, Math.min(totalColumnCount, n)));
            }}
            className="w-12 border border-gray-300 rounded px-1 py-0.5 text-xs text-gray-900"
          />
          <span>/ {totalColumnCount} cols</span>
        </div>

        {filtersEnabled && (
          <button
            onClick={e => {
              setFilterAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
              setColorFilterOpen(true);
            }}
            className={`px-3 py-1.5 rounded border flex items-center gap-1.5 font-medium ${
              colorFilter
                ? 'bg-pink-600 text-white border-pink-700 hover:bg-pink-700'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
            }`}
            title="Filter rows by background colour"
          >
            <PaletteIcon className="w-3.5 h-3.5" />
            Colour Filter
            {colorFilter && <span className="ml-1 px-1.5 rounded-full bg-white/30 text-[10px]">{colorFilter.size}</span>}
          </button>
        )}

        {hasAnyFilter && (
          <div className="flex items-center gap-2 text-blue-700 bg-blue-50 border border-blue-200 rounded px-3 py-1.5">
            <span>Showing {getFilteredRows().length} of {rows.length} rows</span>
            <button className="underline hover:no-underline" onClick={clearAllFilters}>Clear all</button>
          </div>
        )}
      </div>

      <div className="border border-gray-200 rounded overflow-auto" onContextMenu={(e) => handleContextMenu(e, 'row')}>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th
                ref={el => { colHeaderRefs.current[0] = el; }}
                className="px-4 py-2 text-left font-medium text-gray-600 border-b w-12"
                style={stickyStyle(0, '#f9fafb')}
              >
                #
              </th>
              {activeColumns.map((col, i) => {
                const hasActiveFilter = filtersEnabled && !!filters[col.key];
                return (
                  <th
                    key={col.key}
                    ref={el => { colHeaderRefs.current[1 + i] = el; }}
                    className="px-4 py-2 text-left font-medium text-gray-600 border-b whitespace-nowrap"
                    style={stickyStyle(1 + i, '#f9fafb')}
                  >
                    <div className="flex items-center gap-1">
                      <span>{col.header}</span>
                      {filtersEnabled && (
                        <button
                          className={`ml-1 inline-flex items-center justify-center rounded transition-colors ${
                            hasActiveFilter
                              ? 'bg-blue-600 text-white hover:bg-blue-700 px-1.5 py-0.5'
                              : 'text-gray-500 hover:bg-gray-200 px-1 py-0.5'
                          }`}
                          style={{ minWidth: hasActiveFilter ? 'auto' : '20px' }}
                          title={hasActiveFilter ? 'Filter active — click to edit' : 'Filter column'}
                          onClick={e => {
                            e.stopPropagation();
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            setFilterAnchor(rect);
                            setOpenFilterCol(openFilterCol === col.key ? null : col.key);
                          }}
                        >
                          <FilterIcon className="w-3 h-3" />
                          {hasActiveFilter && <span className="ml-0.5 text-[9px] font-bold">●</span>}
                        </button>
                      )}
                    </div>
                  </th>
                );
              })}
              {showTemplateColumns && templatePropertyNames.map((propName, i) => {
                const colIdx = 1 + activeColumns.length + i;
                return (
                  <th
                    key={`tmpl-${propName}`}
                    ref={el => { colHeaderRefs.current[colIdx] = el; }}
                    className="px-3 py-2 text-left font-medium text-gray-600 border-b whitespace-nowrap bg-indigo-50"
                    style={stickyStyle(colIdx, '#eef2ff')}
                    title={`Template item — read-only (${selectedEquipment.type})`}
                  >
                    {propName}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {getFilteredRows().map(row => {
              const rowBg = selectedRows.has(row.id) ? '#dbeafe' : (row.rowColor || '#ffffff');
              return (
                <tr
                  key={row.id}
                  className={`cursor-pointer ${selectedRows.has(row.id) ? 'bg-blue-100' : 'hover:bg-gray-50'}`}
                  style={row.rowColor && !selectedRows.has(row.id) ? { backgroundColor: row.rowColor } : undefined}
                  onClick={(e) => handleRowClick(row.id, e)}
                  onContextMenu={(e) => handleContextMenu(e, 'row', row.id)}
                >
                  <td
                    className="px-4 py-2 border-b text-center font-medium bg-gray-50"
                    style={stickyStyle(0, '#f9fafb')}
                  >
                    {row.rowNumber}
                  </td>
                  {activeColumns.map((col, i) => {
                    const colIdx = 1 + i;
                    const cellBg = row.cellColors?.[col.key];
                    const cellStyle = { ...(cellBg ? { backgroundColor: cellBg } : undefined), ...stickyStyle(colIdx, cellBg || rowBg) };
                    if (col.isTemplate) {
                      return (
                        <td
                          key={col.key}
                          className="px-4 py-2 border-b"
                          style={cellStyle}
                          onDragOver={handleDragOver}
                          onDrop={e => handleDrop(e, row.id)}
                          onContextMenu={(e) => handleContextMenu(e, 'cell', row.id)}
                        >
                          <div className={`px-2 py-1 rounded text-sm ${!row.templateName ? 'bg-gray-100 border border-dashed text-gray-400' : 'bg-blue-50 border border-blue-200'}`}>
                            {row.templateName || 'Drop here or right-click'}
                          </div>
                        </td>
                      );
                    }
                    return (
                      <td
                        key={col.key}
                        className="px-4 py-2 border-b"
                        style={cellStyle}
                        onContextMenu={(e) => {
                          // Right-click on a data cell: open the row context menu
                          // AND mark this cell as the colorize target so the
                          // "Highlight Cell" palette appears alongside row ops.
                          e.preventDefault();
                          e.stopPropagation();
                          if (!selectedRows.has(row.id)) {
                            setSelectedRows(new Set([row.id]));
                          }
                          setColorTarget({ rowId: row.id, colKey: col.key });
                          setContextMenu({ visible: true, x: e.clientX, y: e.clientY, type: 'row' });
                        }}
                      >
                        <input
                          type="text"
                          className="w-full border border-gray-300 rounded px-2 py-1 text-sm bg-transparent"
                          value={(row as any)[col.key] ?? ''}
                          onChange={e => updateRowField(row.id, col.key as any, e.target.value)}
                        />
                      </td>
                    );
                  })}
                  {showTemplateColumns && templatePropertyNames.map((propName, i) => {
                    const colIdx = 1 + activeColumns.length + i;
                    return (
                      <td
                        key={`tmpl-${propName}`}
                        className="px-3 py-2 border-b text-xs text-gray-700 whitespace-pre-wrap bg-indigo-50/40"
                        style={stickyStyle(colIdx, '#eef2ff')}
                      >
                        {getTemplatePropertyText(row, propName)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>

        {rows.length === 0 && (
          <div className="text-center py-8 text-gray-500 text-sm">
            No devices. Click "Add Row" or "Import Excel".
          </div>
        )}
        {rows.length > 0 && getFilteredRows().length === 0 && (
          <div className="text-center py-6 text-gray-400 text-sm">
            No rows match the current filters.
          </div>
        )}
      </div>

      {/* Portal-rendered filter dropdowns (anchored to their trigger button).
          Rendering through a portal so the table's overflow:auto can't clip
          them — this was the previous "filter not visible" bug. */}
      {openFilterCol && filterAnchor && (
        <ColumnFilterDropdown
          columnHeader={activeColumns.find(c => c.key === openFilterCol)?.header || openFilterCol}
          allValues={getUniqueValuesForColumn(openFilterCol)}
          selectedValues={filters[openFilterCol]}
          anchorRect={filterAnchor}
          onApply={next => setFilters(prev => {
            const nextFilters = { ...prev };
            if (next === undefined) delete nextFilters[openFilterCol];
            else nextFilters[openFilterCol] = next;
            return nextFilters;
          })}
          onClose={() => { setOpenFilterCol(null); setFilterAnchor(null); }}
        />
      )}

      {colorFilterOpen && filterAnchor && (
        <ColorFilterDropdown
          allColors={getUniqueRowColors()}
          selectedColors={colorFilter}
          anchorRect={filterAnchor}
          onApply={next => setColorFilter(next)}
          onClose={() => { setColorFilterOpen(false); setFilterAnchor(null); }}
        />
      )}

      {contextMenu?.visible && contextMenu.type === 'row' && selectedEquipment && (
        <div
          className="fixed z-50 w-72 bg-white border shadow-lg rounded py-1 max-h-[80vh] overflow-y-auto"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-4 py-1.5 bg-gray-50 border-b text-xs font-semibold text-gray-500">
            {selectedRows.size} row{selectedRows.size !== 1 ? 's' : ''} selected
          </div>

          {/* Assign template to all selected rows */}
          {projectData.templates[selectedEquipment.type]?.length > 0 && (
            <>
              <div className="px-4 py-2 border-b bg-blue-50">
                <p className="text-xs font-semibold text-blue-700">Assign Template to All Selected</p>
              </div>
              {projectData.templates[selectedEquipment.type].map(tmpl => (
                <button
                  key={tmpl.id}
                  className="w-full text-left px-4 py-2 text-sm hover:bg-blue-50 flex items-center gap-2"
                  onClick={() => {
                    setRows(prev => prev.map(r =>
                      selectedRows.has(r.id) ? { ...r, templateId: tmpl.id, templateName: tmpl.name } : r
                    ));
                    handleCloseContextMenu();
                  }}
                >
                  <CheckIcon className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                  {tmpl.name}
                </button>
              ))}
              <div className="border-t my-1" />
            </>
          )}

          {/* Row color palette */}
          <div className="px-4 py-2 border-b bg-pink-50">
            <p className="text-xs font-semibold text-pink-700 mb-1.5">Row Color</p>
            <div className="flex flex-wrap gap-1.5">
              {ROW_COLOR_PALETTE.map(c => (
                <button
                  key={c.value || 'none'}
                  title={c.label}
                  className="w-5 h-5 rounded border border-gray-300 flex items-center justify-center text-[10px]"
                  style={{ backgroundColor: c.value || '#fff' }}
                  onClick={() => {
                    const targets = selectedRows.size > 0 ? selectedRows : new Set<string>();
                    setRows(prev => prev.map(r =>
                      targets.has(r.id) ? { ...r, rowColor: c.value || undefined } : r
                    ));
                    handleCloseContextMenu();
                  }}
                >
                  {!c.value && '⊘'}
                </button>
              ))}
            </div>
          </div>

          {/* Cell color palette (when a specific cell was shift+right-clicked) */}
          {colorTarget && (
            <div className="px-4 py-2 border-b bg-amber-50">
              <p className="text-xs font-semibold text-amber-700 mb-1.5">
                Highlight Cell: <span className="font-mono">{colorTarget.colKey}</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {ROW_COLOR_PALETTE.map(c => (
                  <button
                    key={c.value || 'none'}
                    title={c.label}
                    className="w-5 h-5 rounded border border-gray-300 flex items-center justify-center text-[10px]"
                    style={{ backgroundColor: c.value || '#fff' }}
                    onClick={() => {
                      const { rowId, colKey } = colorTarget;
                      setRows(prev => prev.map(r => {
                        if (r.id !== rowId) return r;
                        const cellColors = { ...(r.cellColors || {}) };
                        if (c.value) cellColors[colKey] = c.value; else delete cellColors[colKey];
                        return { ...r, cellColors };
                      }));
                      setColorTarget(null);
                      handleCloseContextMenu();
                    }}
                  >
                    {!c.value && '⊘'}
                  </button>
                ))}
              </div>
            </div>
          )}

          <button className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100" onClick={() => handleMoveRows('up')}>
            <ArrowUpIcon className="w-4 h-4 inline mr-2" /> Move Up
          </button>
          <button className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100" onClick={() => handleMoveRows('down')}>
            <ArrowDownIcon className="w-4 h-4 inline mr-2" /> Move Down
          </button>
          <div className="border-t my-1" />
          <button
            className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100"
            onClick={() => { onCopyRows(rows.filter(r => selectedRows.has(r.id))); handleCloseContextMenu(); }}
          >
            <CopyIcon className="w-4 h-4 inline mr-2" /> Copy Selected Rows ({selectedRows.size})
          </button>
          <div className="border-t my-1" />
          <div className="px-4 py-2">
            <input
              type="number" min="1"
              className="w-full border rounded px-2 py-1 text-sm"
              value={moveToRow}
              onChange={e => setMoveToRow(e.target.value)}
              placeholder="Move to row #"
              onClick={e => e.stopPropagation()}
            />
            <button className="w-full mt-1 px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700" onClick={handleMoveToRow}>
              Move
            </button>
          </div>
          <div className="border-t my-1" />
          <button className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 text-gray-600" onClick={handleCloseContextMenu}>
            Cancel
          </button>
        </div>
      )}

      {contextMenu?.visible && contextMenu.type === 'cell' && selectedEquipment && (
        <div
          className="fixed z-50 w-64 bg-white border shadow-lg rounded py-1 max-h-96 overflow-y-auto"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Properties option at top */}
          <button
            className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center"
            onClick={() => {
              const row = rows.find(r => r.id === contextMenu.cellRowId);
              if (row?.templateId && onShowTemplateProperties) {
                onShowTemplateProperties(row.templateId);
              }
              handleCloseContextMenu();
            }}
          >
            <InfoIcon className="w-4 h-4 mr-2" />
            Properties
          </button>
          <div className="border-t my-1"></div>
          <div className="px-4 py-2 border-b bg-gray-50">
            <p className="text-xs font-semibold text-gray-600">Add Template ({selectedEquipment.type})</p>
          </div>
          {projectData.templates[selectedEquipment.type].length > 0 ? (
            projectData.templates[selectedEquipment.type].map(template => (
              <button
                key={template.id}
                className="w-full text-left px-4 py-2 text-sm hover:bg-blue-50"
                onClick={() => handleAddTemplateToCell(template.id)}
              >
                {template.name}
              </button>
            ))
          ) : (
            <div className="px-4 py-3 text-sm text-gray-500 italic">
              No {selectedEquipment.type} templates available
            </div>
          )}
          <div className="border-t my-1"></div>
          <button
            className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 text-gray-600"
            onClick={handleCloseContextMenu}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
};

// ===== EQUIPMENT TREE COMPONENT =====
const EquipmentTree: React.FC<EquipmentTreeProps> = ({
  onImportFromTpms,
  projectData,
  addEquipment,
  deleteEquipment,
  copyEquipment,
  selectedEquipment,
  setSelectedEquipment,
  onNavigateToDeviceLibrary
}) => {
  const [showAddModal,       setShowAddModal]       = useState(false);
  const [selectedLibItemId,  setSelectedLibItemId]  = useState('');
  // Equipment properties modal (read-only view with Edit→navigate)
  const [equipPropsModal, setEquipPropsModal] = useState<{
    visible: boolean; equipment: Equipment | null
  }>({ visible: false, equipment: null });

  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    equipment: Equipment | null
  }>({ visible: false, x: 0, y: 0, equipment: null });
  // Pending equipment removal from the project tree. This direction never
  // touches the Device Library — the dialog says so explicitly.
  const [equipDeleteTarget, setEquipDeleteTarget] = useState<Equipment | null>(null);
  const [expandedEquipment, setExpandedEquipment] = useState<Set<string>>(new Set());
  // key: `${equipmentId}::${templateName}`
  const [expandedTemplates, setExpandedTemplates] = useState<Set<string>>(new Set());
  // key: `${equipmentId}::${templateName}::${busSection}`
  const [expandedBusSections, setExpandedBusSections] = useState<Set<string>>(new Set());

  useEffect(() => {
    const handleClickOutside = () => {
      if (contextMenu.visible) {
        setContextMenu({ visible: false, x: 0, y: 0, equipment: null });
      }
    };

    if (contextMenu.visible) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [contextMenu.visible]);

  const handleCreate = () => {
    if (!selectedLibItemId) return;
    const library = projectData.deviceLibrary ?? { LV: [], MV: [], HV: [] };
    let found: any = null;
    for (const t of ['LV', 'MV', 'HV'] as const) {
      found = (library[t] ?? []).find((d: any) => d.id === selectedLibItemId);
      if (found) break;
    }
    if (!found) return;
    addEquipment({
      id: `eq-${Date.now()}`,
      name: found.name,
      type: found.type,
      power: '',
      properties: { deviceLibraryItemId: found.id },
      devices: []
    });
    setSelectedLibItemId('');
    setShowAddModal(false);
  };

  const toggleExpand = (equipmentId: string) => {
    const newExpanded = new Set(expandedEquipment);
    if (newExpanded.has(equipmentId)) {
      newExpanded.delete(equipmentId);
    } else {
      newExpanded.add(equipmentId);
    }
    setExpandedEquipment(newExpanded);
  };

  const toggleTemplate = (key: string) => {
    const s = new Set(expandedTemplates);
    s.has(key) ? s.delete(key) : s.add(key);
    setExpandedTemplates(s);
  };

  const toggleBusSection = (key: string) => {
    const s = new Set(expandedBusSections);
    s.has(key) ? s.delete(key) : s.add(key);
    setExpandedBusSections(s);
  };

  const getTypeColor = (type: 'LV' | 'MV' | 'HV') => {
    switch (type) {
      case 'LV': return 'text-green-600 bg-green-50';
      case 'MV': return 'text-orange-600 bg-orange-50';
      case 'HV': return 'text-red-600 bg-red-50';
    }
  };

  return (
    <div className="h-full p-4 bg-gray-50">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-semibold text-sm">Equipment</h3>
        <div className="flex gap-1">
          {onImportFromTpms && (
            <button
              className="px-2 py-1 bg-sky-700 text-white rounded text-xs"
              onClick={onImportFromTpms}
              title="Import a switchgear from TPMS — lines, parts and panel specification"
            >
              🗄️ TPMS
            </button>
          )}
          <button
            className="px-2 py-1 bg-blue-600 text-white rounded text-xs"
            onClick={() => setShowAddModal(true)}
          >
            <PlusIcon className="w-3 h-3 inline mr-1" />
            Add
          </button>
        </div>
      </div>

      <div className="space-y-1">
        {/* نمایش نام پروژه در بالا */}
        <div className="p-2 bg-blue-100 border-2 border-blue-300 rounded font-semibold text-sm">
          <div className="flex items-center">
            <span className="text-blue-800">📋 {projectData.projectName}</span>
          </div>
        </div>

        {projectData.equipments.map(eq => {
          const isExpanded = expandedEquipment.has(eq.id);
          const hasDevices = eq.devices && eq.devices.length > 0;

          return (
            <div key={eq.id} className="ml-4">
              <div
                className={`p-2 bg-white border rounded cursor-pointer ${
                  selectedEquipment?.id === eq.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200'
                }`}
                onClick={() => setSelectedEquipment(eq)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({ visible: true, x: e.clientX, y: e.clientY, equipment: eq });
                }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center flex-1">
                    {hasDevices && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpand(eq.id);
                        }}
                        className="mr-1"
                      >
                        {isExpanded ? (
                          <ChevronDownIcon className="w-4 h-4" />
                        ) : (
                          <ChevronRightIcon className="w-4 h-4" />
                        )}
                      </button>
                    )}
                    <div className="text-sm font-medium">{eq.name}</div>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded font-semibold ${getTypeColor(eq.type)}`}>
                    {eq.type}
                  </span>
                </div>
                {eq.power && <div className="text-xs text-gray-500 mt-1 ml-5">{eq.power}</div>}
                {hasDevices && (
                  <div className="text-xs text-gray-400 mt-1 ml-5">{eq.devices.length} device(s)</div>
                )}
              </div>

              {/* نمایش دستگاه‌ها – گروه‌بندی بر اساس تمپلیت → Bus Section → Feeder No */}
              {isExpanded && hasDevices && (() => {
                // ① Group by templateName
                const templateMap = new Map<string, typeof eq.devices>();
                for (const d of eq.devices) {
                  const key = d.templateName || '(No Template)';
                  if (!templateMap.has(key)) templateMap.set(key, []);
                  templateMap.get(key)!.push(d);
                }

                return (
                  <div className="ml-6 mt-1 space-y-1">
                    {Array.from(templateMap.entries()).map(([tmplName, rows]) => {
                      const tmplKey = `${eq.id}::${tmplName}`;
                      const tmplExpanded = expandedTemplates.has(tmplKey);

                      // ② Within this template group, group by busSection
                      const busMap = new Map<string, string[]>();
                      for (const d of rows) {
                        const bus = d.busSection || '(No Bus Section)';
                        if (!busMap.has(bus)) busMap.set(bus, []);
                        if (d.feederNo) busMap.get(bus)!.push(d.feederNo);
                      }

                      return (
                        <div key={tmplKey} className="border border-gray-200 rounded bg-white">
                          {/* Template row – accordion header */}
                          <button
                            className="w-full flex items-center justify-between px-2 py-1.5 text-xs hover:bg-gray-50 rounded"
                            onClick={() => toggleTemplate(tmplKey)}
                          >
                            <div className="flex items-center gap-1 font-medium text-gray-700 truncate">
                              {tmplExpanded
                                ? <ChevronDownIcon className="w-3 h-3 flex-shrink-0" />
                                : <ChevronRightIcon className="w-3 h-3 flex-shrink-0" />}
                              <span className="truncate">{tmplName}</span>
                            </div>
                            {rows.length > 1 && (
                              <span className="ml-1 flex-shrink-0 px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded-full text-[10px] font-semibold">
                                ×{rows.length}
                              </span>
                            )}
                          </button>

                          {/* Accordion body – Bus Section → Feeder No */}
                          {tmplExpanded && (
                            <div className="border-t border-gray-100 px-2 pb-2 pt-1 space-y-1">
                              {Array.from(busMap.entries()).map(([bus, feeders]) => {
                                const busKey = `${tmplKey}::${bus}`;
                                const busExpanded = expandedBusSections.has(busKey);
                                // deduplicate feeders
                                const uniqueFeeders = [...new Set(feeders)].sort();

                                return (
                                  <div key={busKey} className="rounded border border-gray-100 bg-gray-50">
                                    <button
                                      className="w-full flex items-center justify-between px-2 py-1 text-[11px] hover:bg-gray-100 rounded"
                                      onClick={() => toggleBusSection(busKey)}
                                    >
                                      <div className="flex items-center gap-1 text-gray-600 font-medium">
                                        {busExpanded
                                          ? <ChevronDownIcon className="w-3 h-3 flex-shrink-0" />
                                          : <ChevronRightIcon className="w-3 h-3 flex-shrink-0" />}
                                        <span>🔌 {bus}</span>
                                      </div>
                                      <span className="text-gray-400 text-[10px]">
                                        {uniqueFeeders.length} feeder{uniqueFeeders.length !== 1 ? 's' : ''}
                                      </span>
                                    </button>

                                    {busExpanded && uniqueFeeders.length > 0 && (
                                      <div className="pl-6 pr-2 pb-1 space-y-0.5">
                                        {uniqueFeeders.map(fn => (
                                          <div
                                            key={fn}
                                            className="flex items-center gap-1 text-[10px] text-gray-500 py-0.5"
                                          >
                                            <span className="text-gray-300">—</span>
                                            <span>Feeder {fn}</span>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                    {busExpanded && uniqueFeeders.length === 0 && (
                                      <div className="pl-6 pr-2 pb-1 text-[10px] text-gray-400 italic">
                                        No feeder assigned
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          );
        })}

        {projectData.equipments.length === 0 && (
          <div className="text-center text-gray-400 text-xs py-8">
            No equipment
          </div>
        )}
      </div>

      {contextMenu.visible && contextMenu.equipment && (
        <div
          className="fixed z-50 w-48 bg-white border shadow-lg rounded py-1"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100"
            onClick={() => {
              setEquipPropsModal({ visible: true, equipment: contextMenu.equipment });
              setContextMenu({ visible: false, x: 0, y: 0, equipment: null });
            }}
          >
            <InfoIcon className="w-4 h-4 inline mr-2" />
            Show Properties
          </button>
          <div className="border-t my-1"></div>
          <button
            className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 text-red-600"
            onClick={() => {
              setEquipDeleteTarget(contextMenu.equipment);
              setContextMenu({ visible: false, x: 0, y: 0, equipment: null });
            }}
          >
            <TrashIcon className="w-4 h-4 inline mr-2" />
            Delete
          </button>
          <div className="border-t my-1"></div>
          <button
            className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 text-gray-600"
            onClick={() => setContextMenu({ visible: false, x: 0, y: 0, equipment: null })}
          >
            <XIcon className="w-4 h-4 inline mr-2" />
            Cancel
          </button>
        </div>
      )}

      {/* ── Delete equipment from the project arrangement ── */}
      {equipDeleteTarget && (() => {
        const rowCount = equipDeleteTarget.devices?.length ?? 0;
        return (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[100]">
            <div className="bg-white rounded-lg shadow-2xl w-[520px] flex flex-col">
              <div className="flex items-start justify-between px-6 py-4 border-b bg-red-50 rounded-t-lg">
                <div>
                  <h3 className="font-semibold text-lg text-red-800">Delete Equipment</h3>
                  <p className="text-sm text-red-700 mt-0.5">{equipDeleteTarget.name}</p>
                </div>
                <button className="p-1 hover:bg-red-100 rounded" onClick={() => setEquipDeleteTarget(null)}>
                  <XIcon className="w-5 h-5 text-red-500" />
                </button>
              </div>
              <div className="px-6 py-4 space-y-3">
                <p className="text-sm text-gray-700">
                  This removes the equipment from the project arrangement together with its{' '}
                  <strong>{rowCount}</strong> device row{rowCount === 1 ? '' : 's'}.
                </p>
                <div className="bg-blue-50 border border-blue-200 rounded px-3 py-2">
                  <p className="text-sm text-blue-900">
                    The Device Library entry it was created from is <strong>kept</strong>, so you can lay
                    the same device out again from <em>Add</em>.
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-2 px-6 py-4 border-t bg-gray-50">
                <button
                  className="px-4 py-2 border rounded text-sm hover:bg-gray-100"
                  onClick={() => setEquipDeleteTarget(null)}
                >
                  Cancel
                </button>
                <button
                  className="px-4 py-2 bg-red-600 text-white rounded text-sm hover:bg-red-700"
                  onClick={() => { deleteEquipment(equipDeleteTarget.id); setEquipDeleteTarget(null); }}
                >
                  Delete from project
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Add Equipment – pick from Device Library ── */}
      {showAddModal && (() => {
        const library = projectData.deviceLibrary ?? { LV: [], MV: [], HV: [] };
        const allItems = (['LV', 'MV', 'HV'] as const).flatMap(t =>
          (library[t] ?? []).map(d => ({ ...d, typeLabel: t }))
        );
        return (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg p-6 w-[480px] max-h-[80vh] flex flex-col">
              <h3 className="font-semibold mb-1">Add Equipment from Device Library</h3>
              <p className="text-xs text-gray-500 mb-4">Select a device and click Add.</p>
              {allItems.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center text-gray-500 py-8 gap-3">
                  <p className="text-sm">Device Library is empty.</p>
                  <p className="text-xs">Go to <strong>Project Definition → Device Library</strong> and add devices first.</p>
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto border rounded mb-4 min-h-0">
                  {(['LV', 'MV', 'HV'] as const).map(t => {
                    const items = library[t] ?? [];
                    if (items.length === 0) return null;
                    const typeColor = t === 'LV' ? 'text-green-700 bg-green-50' : t === 'MV' ? 'text-orange-700 bg-orange-50' : 'text-red-700 bg-red-50';
                    return (
                      <div key={t}>
                        <div className={`px-3 py-1.5 text-xs font-bold uppercase border-b ${typeColor}`}>{t} – {t === 'LV' ? 'Low Voltage' : t === 'MV' ? 'Medium Voltage' : 'High Voltage'}</div>
                        {items.map(item => (
                          <div
                            key={item.id}
                            className={`px-4 py-2.5 cursor-pointer text-sm border-b flex items-center justify-between ${
                              selectedLibItemId === item.id ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-50'
                            }`}
                            onClick={() => setSelectedLibItemId(item.id)}
                          >
                            <span>🔧 {item.name}</span>
                            {selectedLibItemId === item.id && <CheckIcon className="w-4 h-4 text-blue-600" />}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="flex justify-end space-x-2 mt-2">
                <button
                  className="px-4 py-2 border rounded text-sm"
                  onClick={() => { setShowAddModal(false); setSelectedLibItemId(''); }}
                >
                  Cancel
                </button>
                <button
                  className="px-4 py-2 bg-blue-600 text-white rounded text-sm disabled:opacity-40"
                  disabled={!selectedLibItemId}
                  onClick={handleCreate}
                >
                  Add
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Equipment Properties Modal ── */}
      {equipPropsModal.visible && equipPropsModal.equipment && (() => {
        const eq       = equipPropsModal.equipment!;
        const libId    = eq.properties?.deviceLibraryItemId as string | undefined;
        const library  = projectData.deviceLibrary ?? { LV: [], MV: [], HV: [] };
        let libItem: any = null;
        if (libId) {
          for (const t of ['LV', 'MV', 'HV'] as const) {
            libItem = (library[t] ?? []).find((d: any) => d.id === libId);
            if (libItem) break;
          }
        }
        const p = libItem?.properties ?? {};
        const Row = ({ label, val }: { label: string; val?: string }) => (
          val ? <div className="grid grid-cols-2 gap-2 py-1 border-b border-gray-50 text-sm">
            <span className="text-gray-500">{label}</span>
            <span className="font-medium">{val}</span>
          </div> : null
        );
        const typeColor = eq.type === 'LV' ? 'bg-green-100 text-green-700' : eq.type === 'MV' ? 'bg-orange-100 text-orange-700' : 'bg-red-100 text-red-700';
        return (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg shadow-2xl w-[640px] max-h-[85vh] flex flex-col">
              <div className="flex items-center justify-between px-6 py-4 border-b">
                <div className="flex items-center gap-3">
                  <h3 className="font-semibold text-lg">{eq.name}</h3>
                  <span className={`text-xs px-2 py-0.5 rounded font-semibold ${typeColor}`}>{eq.type}</span>
                </div>
                <button className="p-1 hover:bg-gray-100 rounded" onClick={() => setEquipPropsModal({ visible: false, equipment: null })}>
                  <XIcon className="w-5 h-5 text-gray-500" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
                {!libItem ? (
                  <p className="text-sm text-gray-400 italic">No device library record linked to this equipment.</p>
                ) : (
                  <div className="space-y-4">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-2">Electrical / Mechanical</p>
                      <Row label="Frequency"                           val={p.frequency} />
                      <Row label="Main Busbar Configuration"           val={p.mainBusbarConfiguration} />
                      <Row label="Main Busbar Rated Current"           val={p.mainBusbarRatedCurrent} />
                      <Row label="Rated Short Time Withstand Current"  val={p.ratedShortTimeWithstandCurrent} />
                      <Row label="Isc"                                 val={p.isc} />
                      <Row label="Height (mm)"                         val={p.height} />
                      <Row label="Width (mm)"                          val={p.width} />
                      <Row label="Depth (mm)"                          val={p.depth} />
                      <Row label="Rated Impulse Withstand Voltage"     val={p.ratedImpulseWithstandVoltage} />
                    </div>
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-2">Control & Auxiliary</p>
                      <Row label="Control/Protection/Closing/Tripping & Signalling" val={p.controlProtectionClosingTrippingSignalling} />
                      <Row label="Rated Insulation Voltage"            val={p.ratedInsulationVoltage} />
                      <Row label="Service Voltage"                     val={p.serviceVoltage} />
                      <Row label="Spring Charging Motor"               val={p.springChargingMotor} />
                      <Row label="Switchgear Lighting & Space Heater"  val={p.switchgearLightingSpaceHeater} />
                      <Row label="Motors Space Heater"                 val={p.motorsSpaceHeater} />
                      <Row label="Rated Power-Frequency Withstand Voltage" val={p.ratedPowerFrequencyWithstandVoltage} />
                    </div>
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-2">Busbar & Construction</p>
                      <Row label="Main Busbar Size"       val={p.mainBusbarSize} />
                      <Row label="Earth Busbar Size"      val={p.earthBusbarSize} />
                      <Row label="Neutral Busbar Size"    val={p.neutralBusbarSize} />
                      <Row label="RAL"                    val={p.ral} />
                      <Row label="Incoming Connection"    val={p.incomingConnection} />
                      <Row label="Outgoing Connection"    val={p.outgoingConnection} />
                      <Row label="IP"                     val={p.ip} />
                      <Row label="Switchgear Access"      val={p.switchgearAccess} />
                      <Row label="Switchgear Arrangement" val={p.switchgearArrangement} />
                      <Row label="Busbar Type"            val={p.busbarType} />
                      <Row label="Thermofit Cover"        val={p.thermoFitCover} />
                      <Row label="Coating"                val={p.coating} />
                    </div>
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-2">Pad Lock</p>
                      {[['C.B ON / OFF', p.padLockCbOnOff], ['C.B Test / Service', p.padLockCbTestService], ['HV Door', p.padLockHvDoor]].map(([lbl, val]) => (
                        <div key={lbl as string} className="flex items-center gap-2 py-1 border-b border-gray-50 text-sm">
                          <span className={`w-4 h-4 rounded border flex items-center justify-center text-xs ${val ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-300'}`}>
                            {val ? '✓' : ''}
                          </span>
                          <span className="text-gray-700">{lbl as string}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-2 px-6 py-4 border-t bg-gray-50">
                <button
                  className="px-4 py-2 border rounded text-sm hover:bg-gray-100"
                  onClick={() => setEquipPropsModal({ visible: false, equipment: null })}
                >
                  Close
                </button>
                <button
                  className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 flex items-center gap-1"
                  onClick={() => {
                    const libItemId = eq.properties?.deviceLibraryItemId as string | undefined;
                    setEquipPropsModal({ visible: false, equipment: null });
                    onNavigateToDeviceLibrary(libItemId);
                  }}
                >
                  <EditIcon className="w-4 h-4" /> Edit in Device Library
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

// ===== DEVICE SELECTION TAB (MAIN COMPONENT) =====
const DeviceSelectionTab: React.FC<DeviceSelectionTabProps> = ({
  onImportFromTpms,
  projectData,
  selectedEquipment,
  setSelectedEquipment,
  updateEquipment,
  addEquipment,
  deleteEquipment,
  copyEquipment,
  onNext,
  onNavigateToTemplate,
  onNavigateToDeviceLibrary
}) => {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [clipboardRows, setClipboardRows] = useState<DeviceTableRow[]>([]);

  // Template right-click context menu state (left panel)
  const [templateContextMenu, setTemplateContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    templateId: string | null;
  }>({ visible: false, x: 0, y: 0, templateId: null });

  // Template properties modal state
  const [propertiesModal, setPropertiesModal] = useState<{
    visible: boolean;
    templateId: string | null;
  }>({ visible: false, templateId: null });

  // Derive current equipment from projectData (always up-to-date after updates)
  const currentEquipment = selectedEquipment
    ? (projectData.equipments.find(eq => eq.id === selectedEquipment.id) ?? null)
    : null;

  const handleToggleFullscreen = () => {
    setIsFullscreen(!isFullscreen);
  };

  // Close template context menu on outside click
  useEffect(() => {
    const handleClickOutside = () => {
      if (templateContextMenu.visible) {
        setTemplateContextMenu({ visible: false, x: 0, y: 0, templateId: null });
      }
    };
    if (templateContextMenu.visible) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [templateContextMenu.visible]);

  const handleTemplateContextMenu = (e: React.MouseEvent, templateId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setTemplateContextMenu({ visible: true, x: e.clientX, y: e.clientY, templateId });
  };

  const handleShowProperties = () => {
    setPropertiesModal({ visible: true, templateId: templateContextMenu.templateId });
    setTemplateContextMenu({ visible: false, x: 0, y: 0, templateId: null });
  };

  const handleEditTemplate = (templateId: string) => {
    setPropertiesModal({ visible: false, templateId: null });
    if (onNavigateToTemplate) {
      onNavigateToTemplate(templateId);
    }
  };

  // Find full template data for the properties modal
  const getTemplateById = (templateId: string): TemplateItem | null => {
    for (const type of ['LV', 'MV', 'HV'] as const) {
      const found = projectData.templates[type].find(t => t.id === templateId);
      if (found) return found;
    }
    return null;
  };

  const propertiesTemplate = propertiesModal.templateId
    ? getTemplateById(propertiesModal.templateId)
    : null;

  // Which of the two side columns are on screen. Asking here rather than
  // inside the panels themselves, because the grid has to be built from the
  // answer — a closed panel that still held a 220px track would have put its
  // width into a gap instead of into the table.
  const templatesPanel = usePanel({
    id: 'ds-templates', label: 'Templates', group: 'Device Selection',
    note: 'The templates a device row can be dropped onto',
  });
  const treePanel = usePanel({
    id: 'ds-equipment-tree', label: 'Equipment Tree', group: 'Device Selection',
    note: 'The switchgears of this project, by voltage level',
  });
  // `auto` rather than a fixed width: the panel carries its own width now, so
  // the track follows it down to 36px when it is folded to a rail and
  // disappears altogether when it is closed. A fixed track would have left the
  // rail sitting in a 220px hole.
  const columns = [
    templatesPanel.open ? 'auto' : null,
    'minmax(0,1fr)',
    treePanel.open ? 'auto' : null,
  ].filter(Boolean).join(' ');

  // Left panel templates section with right-click support
  const renderTemplateLeftPanel = () => (
    <PanelFrame
      id="ds-templates"
      title="Templates"
      group="Device Selection"
      note="The templates a device row can be dropped onto"
      side="left"
      className="w-[220px]"
    >
      <div className="p-2 max-h-96 overflow-y-auto">
        {(['LV', 'MV', 'HV'] as const).map(type => (
          <div key={type} className="mb-3">
            <div className="text-xs font-semibold text-gray-600 mb-1">{type}</div>
            {projectData.templates[type].length === 0 && (
              <div className="text-xs text-gray-400 italic p-1">No templates</div>
            )}
            {projectData.templates[type].map(template => (
              <div
                key={template.id}
                className="p-2 text-sm bg-white border rounded mb-1 cursor-move hover:bg-blue-50 select-none"
                draggable
                onDragStart={(e) => e.dataTransfer.setData('templateId', template.id)}
                onContextMenu={(e) => handleTemplateContextMenu(e, template.id)}
              >
                {template.name}
              </div>
            ))}
          </div>
        ))}
      </div>
    </PanelFrame>
  );

  if (isFullscreen) {
    return (
      // `right` leaves room for the chatbot column (var set by Chatbot.tsx;
      // falls back to 48px when the chatbot is not mounted). This way the
      // assistant stays visible and usable while the device table is maximised.
      <div
        className="fixed top-0 left-0 bottom-0 bg-white z-40 overflow-auto shadow-xl"
        style={{ right: 'var(--simorgh-chat-w, 0px)' }}
      >
        <div className="p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold">Device Specifications — Fullscreen</h2>
            <button
              className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700 flex items-center"
              onClick={handleToggleFullscreen}
            >
              <MinimizeIcon className="w-4 h-4 mr-2" />
              Exit Fullscreen
            </button>
          </div>

          <DeviceTable
            selectedEquipment={currentEquipment}
            updateEquipment={updateEquipment}
            projectData={projectData}
            isFullscreen={isFullscreen}
            onToggleFullscreen={handleToggleFullscreen}
            onShowTemplateProperties={(templateId) => setPropertiesModal({ visible: true, templateId })}
            clipboardRows={clipboardRows}
            onCopyRows={setClipboardRows}
          />
        </div>

        {/* Template context menu (also in fullscreen) */}
        {templateContextMenu.visible && (
          <div
            className="fixed z-50 w-48 bg-white border shadow-lg rounded py-1"
            style={{ top: templateContextMenu.y, left: templateContextMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center"
              onClick={handleShowProperties}
            >
              <InfoIcon className="w-4 h-4 mr-2" />
              Properties
            </button>
            <div className="border-t my-1"></div>
            <button
              className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 text-gray-600"
              onClick={() => setTemplateContextMenu({ visible: false, x: 0, y: 0, templateId: null })}
            >
              Cancel
            </button>
          </div>
        )}

        {/* Properties modal */}
        {propertiesModal.visible && propertiesTemplate && (
          <TemplatePropertiesModal
            template={propertiesTemplate}
            onClose={() => setPropertiesModal({ visible: false, templateId: null })}
            onEdit={handleEditTemplate}
          />
        )}
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-xl font-semibold mb-4">Device Selection - {projectData.projectName}</h2>

      {/* Templates and Equipment Tree get just enough fixed width for their
          content (names/tree labels); Device Specifications takes all the
          remaining space so the wide device table isn't squeezed into a
          fixed 50% column.
          The columns are built from which panels are open: a closed one leaves
          no track behind it, so its width becomes table rather than a gap. */}
      <div
        className="grid grid-cols-1 gap-3 items-start"
        style={{ gridTemplateColumns: columns }}
      >
        {renderTemplateLeftPanel()}

        <div className="border rounded min-w-0">
          <div className="bg-gray-50 px-4 py-2 border-b">
            <h3 className="font-medium">Device Specifications</h3>
          </div>
          <div className="p-3">
            <DeviceTable
              selectedEquipment={currentEquipment}
              updateEquipment={updateEquipment}
              projectData={projectData}
              isFullscreen={isFullscreen}
              onToggleFullscreen={handleToggleFullscreen}
              onShowTemplateProperties={(templateId) => setPropertiesModal({ visible: true, templateId })}
              clipboardRows={clipboardRows}
              onCopyRows={setClipboardRows}
            />
          </div>
        </div>

        <PanelFrame
          id="ds-equipment-tree"
          title="Equipment Tree"
          group="Device Selection"
          note="The switchgears of this project, by voltage level"
          side="right"
          className="w-[260px]"
        >
          <EquipmentTree
            onImportFromTpms={onImportFromTpms}
            projectData={projectData}
            addEquipment={addEquipment}
            deleteEquipment={deleteEquipment}
            copyEquipment={copyEquipment}
            selectedEquipment={selectedEquipment}
            setSelectedEquipment={setSelectedEquipment}
            onNavigateToDeviceLibrary={onNavigateToDeviceLibrary ?? ((_id?: string) => {})}
          />
        </PanelFrame>
      </div>

      {/* Template right-click context menu */}
      {templateContextMenu.visible && (
        <div
          className="fixed z-50 w-48 bg-white border shadow-lg rounded py-1"
          style={{ top: templateContextMenu.y, left: templateContextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center"
            onClick={handleShowProperties}
          >
            <InfoIcon className="w-4 h-4 mr-2" />
            Properties
          </button>
          <div className="border-t my-1"></div>
          <button
            className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 text-gray-600"
            onClick={() => setTemplateContextMenu({ visible: false, x: 0, y: 0, templateId: null })}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Template Properties Modal */}
      {propertiesModal.visible && propertiesTemplate && (
        <TemplatePropertiesModal
          template={propertiesTemplate}
          onClose={() => setPropertiesModal({ visible: false, templateId: null })}
          onEdit={handleEditTemplate}
        />
      )}

      <div className="flex justify-end mt-6">
        <button
          className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          onClick={onNext}
        >
          Next →
        </button>
      </div>
    </div>
  );
};

export default DeviceSelectionTab;
