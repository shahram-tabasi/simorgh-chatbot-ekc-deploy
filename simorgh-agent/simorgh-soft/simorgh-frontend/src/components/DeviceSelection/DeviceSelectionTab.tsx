import React, { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import { PlusIcon, UploadIcon, TrashIcon, CopyIcon, ArrowUpIcon, ArrowDownIcon, MaximizeIcon, MinimizeIcon, ChevronDownIcon, ChevronRightIcon, XIcon, InfoIcon, EditIcon, CheckIcon, ClipboardIcon } from 'lucide-react';
import { ProjectData, Equipment, DeviceTableRow, TemplateItem } from '../../types/project';

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
  projectData: ProjectData;
  addEquipment: (equipment: Equipment) => void;
  deleteEquipment: (id: string) => void;
  copyEquipment: (id: string) => void;
  selectedEquipment: Equipment | null;
  setSelectedEquipment: (equipment: Equipment | null) => void;
  onNavigateToDeviceLibrary: (deviceId?: string) => void;
}

interface DeviceSelectionTabProps {
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
  const lvProperties = [
    'CB ORDER', 'CONTACTOR. ORDER',
    'OVER LOAD RELAY', 'EARTH FAULT', 'COREBALANCE CT',
    'PROTECTION RELAY', 'CT RATING', 'AMMETER', 'AMMETER selector',
    'PT RATING', 'VOLTMETER', 'VOLTMETER selector'
  ];
  const mvProperties = [
    'BREAKER TYPE', 'NOMINAL CURRENT', 'SHORT CIRCUIT CURRENT',
    'PROTECTION RELAY', 'CT RATIO', 'VT RATIO'
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
                  if (parts.length === 0) {
                    return (
                      <tr key={idx} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                        <td className="px-4 py-2 border-b font-medium text-gray-700">{propName}</td>
                        <td className="px-4 py-2 border-b text-gray-400 italic" colSpan={5}>No part assigned</td>
                      </tr>
                    );
                  }
                  return parts.map((part, pIdx) => (
                    <tr key={`${idx}-${pIdx}`} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                      {pIdx === 0 && (
                        <td className="px-4 py-2 border-b font-medium text-gray-700 align-top" rowSpan={parts.length}>
                          {propName}
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
  const [rows, setRows] = useState<DeviceTableRow[]>([]);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [lastSelectedIdx, setLastSelectedIdx] = useState<number>(-1);
  const [filters, setFilters] = useState({ templateName: '', busSection: '', feederNo: '', wiringType: '', ratingPower: '', flc: '' });
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

  // Track previous equipment ID to only reload rows when equipment changes
  const prevEquipmentIdRef = useRef<string | null>(null);

  useEffect(() => {
    // Only reload rows when the selected equipment ID changes (different equipment selected)
    // NOT when the same equipment's data is updated (would cause infinite loop)
    if (selectedEquipment?.id !== prevEquipmentIdRef.current) {
      prevEquipmentIdRef.current = selectedEquipment?.id || null;
      setRows(selectedEquipment?.devices || []);
      setSelectedRows(new Set());
    }
  }, [selectedEquipment]);

  useEffect(() => {
    if (selectedEquipment) {
      updateEquipment(selectedEquipment.id, { devices: rows });
    }
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

  // Returns rows filtered by column search inputs
  const getFilteredRows = () => rows.filter(row =>
    (!filters.templateName || row.templateName.toLowerCase().includes(filters.templateName.toLowerCase())) &&
    (!filters.busSection  || row.busSection.toLowerCase().includes(filters.busSection.toLowerCase())) &&
    (!filters.feederNo    || row.feederNo.toLowerCase().includes(filters.feederNo.toLowerCase())) &&
    (!filters.wiringType  || row.wiringType.toLowerCase().includes(filters.wiringType.toLowerCase())) &&
    (!filters.ratingPower || row.ratingPower.toLowerCase().includes(filters.ratingPower.toLowerCase())) &&
    (!filters.flc         || row.flc.toLowerCase().includes(filters.flc.toLowerCase()))
  );

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
  };

  useEffect(() => {
    const handleClickOutside = () => handleCloseContextMenu();
    if (contextMenu?.visible) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [contextMenu]);

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
      equipmentId: selectedEquipment.id
    };
    setRows([...rows, newRow]);
  };

  const handleImportExcel = () => {
    if (!selectedEquipment) {
      alert('Please select an equipment first!');
      return;
    }
    fileInputRef.current?.click();
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

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
            const busSection = (row['Bus Section'] || row['busSection'] || row['bus section'] || row['BUS SECTION'] || '').toString().trim();
            const feederNo = (row['Feeder No'] || row['feederNo'] || row['feeder no'] || row['FEEDER NO'] || row['Feeder Number'] || '').toString().trim();
            const wiringType = (row['Wiring Type'] || row['wiringType'] || row['wiring type'] || row['WIRING TYPE'] || '').toString().trim();
            const ratingPower = (row['Rating Power'] || row['ratingPower'] || row['rating power'] || row['RATING POWER'] || row['Rating (kW)'] || '').toString().trim();
            const flc = (row['FLC (A)'] || row['FLC'] || row['flc'] || row['Flc'] || row['FLC(A)'] || '').toString().trim();

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
              equipmentId: selectedEquipment!.id
            };
          });

        if (importedRows.length === 0) {
          alert('No valid rows found. Make sure the Excel file has data in columns: Bus Section, Feeder No, Wiring Type, Rating Power, FLC (A)');
          return;
        }

        // Replace all rows with imported data (starting from row 1)
        setRows(importedRows);
        alert(`Imported ${importedRows.length} row(s) — existing rows replaced.\n\nAssign templates via right-click on the Template cell or drag-and-drop.`);
      } catch (error) {
        console.error('Import error:', error);
        alert('Error importing file. Please make sure it is a valid Excel (.xlsx/.xls) or CSV file with columns: Bus Section, Feeder No, Wiring Type, Rating Power, FLC (A)');
      }
    };

    reader.readAsArrayBuffer(file);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
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

      {/* Active filter indicator */}
      {Object.values(filters).some(f => f) && (
        <div className="mb-2 flex items-center gap-2 text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded px-3 py-1.5">
          <span>Filters active — showing {getFilteredRows().length} of {rows.length} rows</span>
          <button className="ml-auto underline hover:no-underline" onClick={() => setFilters({ templateName: '', busSection: '', feederNo: '', wiringType: '', ratingPower: '', flc: '' })}>Clear all</button>
        </div>
      )}

      <div className="border border-gray-200 rounded overflow-hidden" onContextMenu={(e) => handleContextMenu(e, 'row')}>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="px-4 py-2 text-left font-medium text-gray-600 border-b w-12">#</th>
              <th className="px-4 py-2 text-left font-medium text-gray-600 border-b">Template</th>
              <th className="px-4 py-2 text-left font-medium text-gray-600 border-b">Bus Section</th>
              <th className="px-4 py-2 text-left font-medium text-gray-600 border-b">Feeder No</th>
              <th className="px-4 py-2 text-left font-medium text-gray-600 border-b">Wiring Type</th>
              <th className="px-4 py-2 text-left font-medium text-gray-600 border-b">Rating Power</th>
              <th className="px-4 py-2 text-left font-medium text-gray-600 border-b">FLC (A)</th>
            </tr>
            {/* Per-column filter row */}
            <tr className="bg-white border-b border-gray-200">
              <td className="px-2 py-1 w-12" />
              {(['templateName', 'busSection', 'feederNo', 'wiringType', 'ratingPower', 'flc'] as const).map(col => (
                <td key={col} className="px-2 py-1">
                  <input
                    type="text"
                    placeholder="🔍"
                    className="w-full border border-gray-200 rounded px-2 py-0.5 text-xs focus:outline-none focus:border-blue-400 bg-gray-50"
                    value={filters[col]}
                    onChange={e => setFilters(prev => ({ ...prev, [col]: e.target.value }))}
                    onClick={e => e.stopPropagation()}
                  />
                </td>
              ))}
            </tr>
          </thead>
          <tbody>
            {getFilteredRows().map(row => (
              <tr
                key={row.id}
                className={`cursor-pointer ${selectedRows.has(row.id) ? 'bg-blue-100' : 'hover:bg-gray-50'}`}
                onClick={(e) => handleRowClick(row.id, e)}
                onContextMenu={(e) => handleContextMenu(e, 'row', row.id)}
              >
                <td className="px-4 py-2 border-b text-center font-medium bg-gray-50">
                  {row.rowNumber}
                </td>
                <td
                  className="px-4 py-2 border-b"
                  onDragOver={handleDragOver}
                  onDrop={e => handleDrop(e, row.id)}
                  onContextMenu={(e) => handleContextMenu(e, 'cell', row.id)}
                >
                  <div className={`px-2 py-1 rounded text-sm ${!row.templateName ? 'bg-gray-100 border border-dashed text-gray-400' : 'bg-blue-50 border border-blue-200'}`}>
                    {row.templateName || 'Drop here or right-click'}
                  </div>
                </td>
                <td className="px-4 py-2 border-b">
                  <input
                    type="text"
                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                    value={row.busSection}
                    onChange={e => updateRowField(row.id, 'busSection', e.target.value)}
                  />
                </td>
                <td className="px-4 py-2 border-b">
                  <input
                    type="text"
                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                    value={row.feederNo}
                    onChange={e => updateRowField(row.id, 'feederNo', e.target.value)}
                  />
                </td>
                <td className="px-4 py-2 border-b">
                  <input
                    type="text"
                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                    value={row.wiringType}
                    onChange={e => updateRowField(row.id, 'wiringType', e.target.value)}
                  />
                </td>
                <td className="px-4 py-2 border-b">
                  <input
                    type="text"
                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                    value={row.ratingPower}
                    onChange={e => updateRowField(row.id, 'ratingPower', e.target.value)}
                  />
                </td>
                <td className="px-4 py-2 border-b">
                  <input
                    type="text"
                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                    value={row.flc}
                    onChange={e => updateRowField(row.id, 'flc', e.target.value)}
                  />
                </td>
              </tr>
            ))}
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
        <button
          className="px-2 py-1 bg-blue-600 text-white rounded text-xs"
          onClick={() => setShowAddModal(true)}
        >
          <PlusIcon className="w-3 h-3 inline mr-1" />
          Add
        </button>
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
              if (confirm('Delete this equipment?')) {
                deleteEquipment(contextMenu.equipment!.id);
              }
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

  // Left panel templates section with right-click support
  const renderTemplateLeftPanel = () => (
    <div className="border rounded">
      <div className="bg-gray-50 px-4 py-2 border-b">
        <h3 className="font-medium">Templates</h3>
      </div>
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
    </div>
  );

  if (isFullscreen) {
    return (
      <div className="fixed inset-0 bg-white z-50 overflow-auto">
        <div className="p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold">Device Specifications - Fullscreen</h2>
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

      <div className="grid grid-cols-4 gap-4">
        {renderTemplateLeftPanel()}

        <div className="col-span-2 border rounded">
          <div className="bg-gray-50 px-4 py-2 border-b">
            <h3 className="font-medium">Device Specifications</h3>
          </div>
          <div className="p-4">
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

        <div className="border rounded">
          <div className="bg-gray-50 px-4 py-2 border-b">
            <h3 className="font-medium">Equipment Tree</h3>
          </div>
          <EquipmentTree
            projectData={projectData}
            addEquipment={addEquipment}
            deleteEquipment={deleteEquipment}
            copyEquipment={copyEquipment}
            selectedEquipment={selectedEquipment}
            setSelectedEquipment={setSelectedEquipment}
            onNavigateToDeviceLibrary={onNavigateToDeviceLibrary ?? ((_id?: string) => {})}
          />
        </div>
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
