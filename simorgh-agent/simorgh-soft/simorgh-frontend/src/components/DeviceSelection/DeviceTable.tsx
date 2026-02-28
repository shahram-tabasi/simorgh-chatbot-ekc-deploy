import React, { useState, useRef } from 'react';
import { PlusIcon, UploadIcon, MoveIcon, Trash2Icon, ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { DeviceItem, DeviceRow } from '../../types/project';
import * as XLSX from 'xlsx';

interface DeviceTableProps {
  devices: DeviceItem[];
  onDevicesUpdate: (devices: DeviceItem[]) => void;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  deviceId: string | null;
  rowId: string | null;
}

export const DeviceTable: React.FC<DeviceTableProps> = ({ devices, onDevicesUpdate }) => {
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false, x: 0, y: 0, deviceId: null, rowId: null
  });
  const [moveToRowNumber, setMoveToRowNumber] = useState<string>('');
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleMoveRows = () => {
    const targetRow = parseInt(moveToRowNumber);
    if (isNaN(targetRow) || targetRow < 1) { alert('Please enter a valid row number'); return; }
    const newDevices = [...devices];
    const selectedDevices = newDevices.filter(d => selectedRows.has(d.id));
    const unselectedDevices = newDevices.filter(d => !selectedRows.has(d.id));
    const updatedDevices = unselectedDevices.slice(0, targetRow - 1)
      .concat(selectedDevices)
      .concat(unselectedDevices.slice(targetRow - 1));
    const reindexedDevices = updatedDevices.map((d, index) => ({ ...d, rowNumber: index + 1 }));
    onDevicesUpdate(reindexedDevices);
    setSelectedRows(new Set());
    setShowMoveDialog(false);
    setMoveToRowNumber('');
  };

  const handleAddRow = () => {
    const newDevice: DeviceItem = {
      id: `device-${Date.now()}`,
      rowNumber: devices.length + 1,
      templateId: '',
      deviceName: `Device ${devices.length + 1}`,
      flc: '', ratingPower: '', wiringType: '', feederNo: '', busSection: '',
      children: [],
      selectedParts: []
    };
    onDevicesUpdate([...devices, newDevice]);
  };

  const handleAddSubRow = (deviceId: string) => {
    const newDevices = devices.map(device => {
      if (device.id === deviceId) {
        const newSubRow: DeviceRow = {
          id: `row-${Date.now()}`,
          rowNumber: (device.children?.length || 0) + 1,
          deviceId,
          templateId: '',
          flc: '', ratingPower: '', wiringType: '', feederNo: '', busSection: ''
        };
        return { ...device, children: [...(device.children || []), newSubRow] };
      }
      return device;
    });
    onDevicesUpdate(newDevices);
  };

  const handleDeleteSelected = () => {
    if (selectedRows.size === 0) return;
    onDevicesUpdate(devices.filter(d => !selectedRows.has(d.id)));
    setSelectedRows(new Set());
  };

  const handleImportExcel = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = new Uint8Array(event.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet) as any[];
        const importedDevices: DeviceItem[] = jsonData.map((row, index) => ({
          id: `imported-${Date.now()}-${index}`,
          rowNumber: devices.length + index + 1,
          deviceName: row['Device Name'] || row['deviceName'] || `Imported Device ${index + 1}`,
          templateId: row['Template'] || row['templateId'] || '',
          busSection: row['Bus Section'] || row['busSection'] || '',
          feederNo: row['Feeder No'] || row['feederNo'] || '',
          wiringType: row['Wiring Type'] || row['wiringType'] || '',
          ratingPower: row['Rating Power'] || row['ratingPower'] || '',
          flc: row['FLC'] || row['flc'] || '',
          children: [],
          selectedParts: []
        }));
        onDevicesUpdate([...devices, ...importedDevices]);
        alert(`Successfully imported ${importedDevices.length} devices`);
      } catch (error) {
        console.error('Error importing Excel:', error);
        alert('Error importing Excel file. Please check the format.');
      }
    };
    reader.readAsArrayBuffer(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleContextMenu = (e: React.MouseEvent, deviceId: string, rowId?: string) => {
    e.preventDefault();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, deviceId, rowId: rowId || null });
  };

  const handleRowSelect = (deviceId: string, isCtrlPressed: boolean) => {
    if (isCtrlPressed) {
      const newSelected = new Set(selectedRows);
      if (newSelected.has(deviceId)) newSelected.delete(deviceId);
      else newSelected.add(deviceId);
      setSelectedRows(newSelected);
    } else {
      setSelectedRows(new Set([deviceId]));
    }
  };

  const toggleDeviceExpand = (deviceId: string) => {
    onDevicesUpdate(devices.map(d => d.id === deviceId ? { ...d, isExpanded: !d.isExpanded } : d));
  };

  const handleDragOver = (e: React.DragEvent) => e.preventDefault();

  const handleDrop = (e: React.DragEvent, deviceId: string, rowId?: string) => {
    e.preventDefault();
    const templateId = e.dataTransfer.getData('templateId');
    if (rowId) {
      onDevicesUpdate(devices.map(d => d.id === deviceId ? {
        ...d,
        children: d.children?.map(c => c.id === rowId ? { ...c, templateId } : c)
      } : d));
    } else {
      onDevicesUpdate(devices.map(d => d.id === deviceId ? { ...d, templateId } : d));
    }
  };

  const updateDeviceField = (deviceId: string, field: keyof DeviceItem, value: any) => {
    onDevicesUpdate(devices.map(d => d.id === deviceId ? { ...d, [field]: value } : d));
  };

  const updateSubRowField = (deviceId: string, rowId: string, field: keyof DeviceRow, value: any) => {
    onDevicesUpdate(devices.map(d => {
      if (d.id !== deviceId) return d;
      return { ...d, children: d.children?.map(c => c.id === rowId ? { ...c, [field]: value } : c) };
    }));
  };

  return (
    <div>
      {/* Toolbar */}
      <div className="mb-4 flex justify-between items-center">
        <div className="flex space-x-2">
          <button className="px-3 py-1 bg-blue-600 text-white rounded-md text-sm flex items-center" onClick={handleAddRow}>
            <PlusIcon className="w-4 h-4 mr-1" /> Add Device
          </button>
          <button className="px-3 py-1 bg-green-600 text-white rounded-md text-sm flex items-center" onClick={() => fileInputRef.current?.click()}>
            <UploadIcon className="w-4 h-4 mr-1" /> Import Excel
          </button>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleImportExcel} className="hidden" />
          <button className="px-3 py-1 bg-purple-600 text-white rounded-md text-sm flex items-center"
            onClick={() => setShowMoveDialog(true)} disabled={selectedRows.size === 0}>
            <MoveIcon className="w-4 h-4 mr-1" /> Move Selected ({selectedRows.size})
          </button>
          <button className="px-3 py-1 bg-red-600 text-white rounded-md text-sm flex items-center"
            onClick={handleDeleteSelected} disabled={selectedRows.size === 0}>
            <Trash2Icon className="w-4 h-4 mr-1" /> Delete Selected
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="border border-gray-200 rounded-md overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-gray-50">
              <th className="px-2 py-2 text-left text-sm font-medium text-gray-600 border-b w-8">#</th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-600 border-b">Device Name</th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-600 border-b">Template</th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-600 border-b">Bus Section</th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-600 border-b">Feeder No</th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-600 border-b">Wiring Type</th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-600 border-b">Rating Power</th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-600 border-b">FLC (A)</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => (
              <React.Fragment key={device.id}>
                {/* Main device row */}
                <tr
                  className={`${selectedRows.has(device.id) ? 'bg-blue-100' : 'hover:bg-gray-50'} cursor-pointer`}
                  onClick={(e) => handleRowSelect(device.id, e.ctrlKey || e.metaKey)}
                  onContextMenu={(e) => handleContextMenu(e, device.id)}
                >
                  <td className="px-2 py-2 text-sm border-b text-center font-medium">{device.rowNumber}</td>
                  <td className="px-4 py-2 text-sm border-b">
                    <div className="flex items-center">
                      <button onClick={(e) => { e.stopPropagation(); toggleDeviceExpand(device.id); }} className="mr-2">
                        {device.isExpanded ? <ChevronDownIcon className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
                      </button>
                      <input type="text" className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                        value={device.deviceName}
                        onChange={(e) => updateDeviceField(device.id, 'deviceName', e.target.value)}
                        onClick={(e) => e.stopPropagation()} />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm border-b" onDragOver={handleDragOver} onDrop={(e) => handleDrop(e, device.id)}>
                    <div className={`h-8 flex items-center ${!device.templateId ? 'bg-gray-100 border border-dashed border-gray-300 rounded' : 'bg-blue-50 border border-blue-200 rounded px-2'}`}>
                      {device.templateId || 'Drop template here'}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-sm border-b">
                    <input type="text" className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                      value={device.busSection}
                      onChange={(e) => updateDeviceField(device.id, 'busSection', e.target.value)}
                      onClick={(e) => e.stopPropagation()} />
                  </td>
                  <td className="px-4 py-2 text-sm border-b">
                    <input type="text" className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                      value={device.feederNo}
                      onChange={(e) => updateDeviceField(device.id, 'feederNo', e.target.value)}
                      onClick={(e) => e.stopPropagation()} />
                  </td>
                  <td className="px-4 py-2 text-sm border-b">
                    <input type="text" className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                      value={device.wiringType}
                      onChange={(e) => updateDeviceField(device.id, 'wiringType', e.target.value)}
                      onClick={(e) => e.stopPropagation()} />
                  </td>
                  <td className="px-4 py-2 text-sm border-b">
                    <input type="text" className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                      value={device.ratingPower}
                      onChange={(e) => updateDeviceField(device.id, 'ratingPower', e.target.value)}
                      onClick={(e) => e.stopPropagation()} />
                  </td>
                  <td className="px-4 py-2 text-sm border-b">
                    <input type="text" className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                      value={device.flc}
                      onChange={(e) => updateDeviceField(device.id, 'flc', e.target.value)}
                      onClick={(e) => e.stopPropagation()} />
                  </td>
                </tr>

                {/* Sub-rows */}
                {device.isExpanded && device.children && device.children.map((row) => (
                  <tr key={row.id} className="bg-gray-50" onContextMenu={(e) => handleContextMenu(e, device.id, row.id)}>
                    <td className="px-2 py-2 text-sm border-b text-center text-gray-500">{device.rowNumber}.{row.rowNumber}</td>
                    <td className="px-4 py-2 text-sm border-b pl-12 text-gray-500">Sub-row {row.rowNumber}</td>
                    <td className="px-4 py-3 text-sm border-b" onDragOver={handleDragOver} onDrop={(e) => handleDrop(e, device.id, row.id)}>
                      <div className={`h-8 flex items-center ${!row.templateId ? 'bg-gray-100 border border-dashed border-gray-300 rounded' : 'bg-blue-50 border border-blue-200 rounded px-2'}`}>
                        {row.templateId || 'Drop template'}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-sm border-b">
                      <input type="text" className="w-full border border-gray-300 rounded px-2 py-1 text-sm bg-white"
                        value={row.busSection} onChange={(e) => updateSubRowField(device.id, row.id, 'busSection', e.target.value)} />
                    </td>
                    <td className="px-4 py-2 text-sm border-b">
                      <input type="text" className="w-full border border-gray-300 rounded px-2 py-1 text-sm bg-white"
                        value={row.feederNo} onChange={(e) => updateSubRowField(device.id, row.id, 'feederNo', e.target.value)} />
                    </td>
                    <td className="px-4 py-2 text-sm border-b">
                      <input type="text" className="w-full border border-gray-300 rounded px-2 py-1 text-sm bg-white"
                        value={row.wiringType} onChange={(e) => updateSubRowField(device.id, row.id, 'wiringType', e.target.value)} />
                    </td>
                    <td className="px-4 py-2 text-sm border-b">
                      <input type="text" className="w-full border border-gray-300 rounded px-2 py-1 text-sm bg-white"
                        value={row.ratingPower} onChange={(e) => updateSubRowField(device.id, row.id, 'ratingPower', e.target.value)} />
                    </td>
                    <td className="px-4 py-2 text-sm border-b">
                      <input type="text" className="w-full border border-gray-300 rounded px-2 py-1 text-sm bg-white"
                        value={row.flc} onChange={(e) => updateSubRowField(device.id, row.id, 'flc', e.target.value)} />
                    </td>
                  </tr>
                ))}

                {/* Add sub-row button */}
                {device.isExpanded && (
                  <tr>
                    <td colSpan={8} className="px-4 py-2 border-b">
                      <button className="text-sm text-blue-600 hover:text-blue-800 flex items-center pl-8" onClick={() => handleAddSubRow(device.id)}>
                        <PlusIcon className="w-4 h-4 mr-1" /> Add Sub-row
                      </button>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Context Menu */}
      {contextMenu.visible && (
        <div className="fixed z-50 w-48 bg-white border border-gray-200 shadow-lg rounded-md py-1"
          style={{ top: contextMenu.y, left: contextMenu.x }}>
          <button className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100"
            onClick={() => { if (contextMenu.deviceId) handleAddSubRow(contextMenu.deviceId); setContextMenu({ ...contextMenu, visible: false }); }}>
            Add Sub-row
          </button>
          <button className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100"
            onClick={() => { setShowMoveDialog(true); setContextMenu({ ...contextMenu, visible: false }); }}>
            Move Row
          </button>
          <button className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 text-red-600"
            onClick={() => {
              if (contextMenu.deviceId && !contextMenu.rowId) onDevicesUpdate(devices.filter(d => d.id !== contextMenu.deviceId));
              setContextMenu({ ...contextMenu, visible: false });
            }}>
            Delete Row
          </button>
        </div>
      )}

      {/* Move Dialog */}
      {showMoveDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded-lg shadow-xl w-96">
            <h3 className="text-lg font-semibold mb-4">Move Rows</h3>
            <p className="text-sm text-gray-600 mb-4">Moving {selectedRows.size} selected row(s)</p>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">Move to row number:</label>
              <input type="number" min="1" className="w-full border border-gray-300 rounded px-3 py-2"
                value={moveToRowNumber} onChange={(e) => setMoveToRowNumber(e.target.value)} autoFocus />
            </div>
            <div className="flex justify-end space-x-3">
              <button className="px-4 py-2 border border-gray-300 rounded text-sm hover:bg-gray-50"
                onClick={() => { setShowMoveDialog(false); setMoveToRowNumber(''); }}>Cancel</button>
              <button className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700" onClick={handleMoveRows}>Move</button>
            </div>
          </div>
        </div>
      )}

      {/* Click outside context menu */}
      {contextMenu.visible && (
        <div className="fixed inset-0 z-40" onClick={() => setContextMenu({ ...contextMenu, visible: false })} />
      )}

    </div>
  );
};
