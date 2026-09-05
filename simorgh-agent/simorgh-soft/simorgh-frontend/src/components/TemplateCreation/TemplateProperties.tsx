// src/components/TemplateCreation/TemplateProperties.tsx - FIXED SQL CONNECTION
import React, { useEffect, useState } from 'react';
import { useProject } from '../../context/ProjectContext';
import { PlusIcon, TrashIcon, Search, RefreshCw, ChevronLeftIcon, ChevronRightIcon, Edit2Icon, LockIcon, UnlockIcon, CheckIcon, XIcon } from 'lucide-react';

// Reserved keys inside template.properties used to carry per-template metadata.
// These keys are NOT real property rows; the renderer skips them.
const META_DISPLAY_NAMES = '__displayNames';
const META_LOCKED = '__locked';

const PAGE_SIZE = 100;

interface TemplateItem {
  id: string;
  name: string;
  type: 'LV' | 'MV' | 'HV';
  properties: Record<string, PropertyValue>;
}

interface PropertyValue {
  parts: PartInfo[];
}

interface PartInfo {
  partNumber: string;
  label: string;
  quantity: number;
  priority: number;
  fullData?: any;
}

interface TemplatePropertiesProps {
  template: TemplateItem;
}

interface PartSelectionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (part: any) => void;
  propertyName: string;
  currentPart?: PartInfo | null;
}

// دیالوگ انتخاب پارت از SQL Server - با صفحه‌بندی کامل
const PartSelectionDialog: React.FC<PartSelectionDialogProps> = ({
  isOpen,
  onClose,
  onSelect,
  propertyName,
  currentPart
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [parts, setParts] = useState<any[]>([]);
  const [selectedPart, setSelectedPart] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manufacturers, setManufacturers] = useState<string[]>([]);
  const [selectedManufacturer, setSelectedManufacturer] = useState('');

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);

  // Open: reset and load page 1
  useEffect(() => {
    if (isOpen) {
      setCurrentPage(1);
      setSelectedPart(null);
      fetchParts(1);
    }
  }, [isOpen]);

  // Reload when manufacturer changes (reset to page 1)
  useEffect(() => {
    if (isOpen) {
      setCurrentPage(1);
      fetchParts(1);
    }
  }, [selectedManufacturer]);

  const fetchParts = async (page: number = currentPage) => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/eplan-parts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchTerm: searchTerm || undefined,
          manufacturer: selectedManufacturer || undefined,
          page: page,
          pageSize: PAGE_SIZE
        })
      });

      // Parse the body first so we can show the real SQL error message
      const result = await response.json();

      if (!response.ok) {
        // Show the actual error from the server (e.g. SQL connection message)
        throw new Error(result.error || `HTTP ${response.status}`);
      }

      if (result.success && result.data) {
        setParts(result.data);
        setTotalCount(result.total || result.data.length);
        setTotalPages(result.totalPages || 1);
        setCurrentPage(result.page || page);

        if (result.manufacturers && result.manufacturers.length > 0) {
          setManufacturers(result.manufacturers);
        }
        console.log(`✅ Loaded page ${result.page}/${result.totalPages} — ${result.data.length} of ${result.total} parts`);
      } else {
        throw new Error(result.error || 'Server returned an unsuccessful response');
      }

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Connection error';
      setError(errorMsg);
      setParts([]);
      console.error('❌ SQL Server error:', errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = () => {
    setCurrentPage(1);
    fetchParts(1);
  };

  const handlePageChange = (newPage: number) => {
    if (newPage < 1 || newPage > totalPages || loading) return;
    setCurrentPage(newPage);
    fetchParts(newPage);
  };

  const handleOk = async () => {
    if (!selectedPart) return;

    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/save-part-to-mongo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          partData: selectedPart,
          propertyName: propertyName,
          templateId: 'current-template',
          timestamp: new Date().toISOString()
        })
      });
      if (response.ok) console.log('✅ Part saved to MongoDB');
    } catch (err) {
      console.error('❌ MongoDB save error:', err);
    }

    onSelect(selectedPart);
    onClose();
  };

  if (!isOpen) return null;

  // Page number buttons to display
  const pageButtons = () => {
    const buttons: number[] = [];
    const maxButtons = 5;
    let start = Math.max(1, currentPage - Math.floor(maxButtons / 2));
    let end = Math.min(totalPages, start + maxButtons - 1);
    if (end - start < maxButtons - 1) start = Math.max(1, end - maxButtons + 1);
    for (let i = start; i <= end; i++) buttons.push(i);
    return buttons;
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-[90%] h-[90%] flex flex-col">
        {/* Header */}
        <div className="bg-blue-600 text-white px-6 py-4 rounded-t-lg flex justify-between items-center">
          <div>
            <h2 className="text-xl font-semibold">
              {currentPart ? '🔄 Replace Part' : '➕ Select Part'} for {propertyName}
            </h2>
            {currentPart && (
              <p className="text-sm text-blue-100 mt-1">
                Current: {currentPart.partNumber}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-white hover:bg-blue-700 rounded-full p-2">
            ✕
          </button>
        </div>

        {/* Search Bar with Manufacturer Filter */}
        <div className="px-6 py-3 border-b bg-gray-50">
          <div className="flex gap-4">
            <div className="w-48">
              <select
                value={selectedManufacturer}
                onChange={(e) => setSelectedManufacturer(e.target.value)}
                className="w-full py-2 px-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              >
                <option value="">All Manufacturers</option>
                {manufacturers.map((man, idx) => (
                  <option key={idx} value={man}>{man}</option>
                ))}
              </select>
            </div>
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
              <input
                type="text"
                placeholder="Search by part number, type, manufacturer, description..."
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                autoFocus
              />
            </div>
            <button
              onClick={handleSearch}
              disabled={loading}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-400 flex items-center gap-2"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              {loading ? 'Loading...' : 'Search'}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-3 flex-wrap">
            {selectedManufacturer && (
              <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded-full text-sm flex items-center gap-1">
                {selectedManufacturer}
                <button onClick={() => setSelectedManufacturer('')} className="ml-1 text-blue-600 hover:text-blue-800">✕</button>
              </span>
            )}
            {!loading && totalCount > 0 && (
              <span className="text-sm text-gray-500">
                Total: <strong>{totalCount.toLocaleString()}</strong> part(s) — Page <strong>{currentPage}</strong> of <strong>{totalPages}</strong>
              </span>
            )}
            {error && (
              <span className="flex items-center gap-2 text-red-600 text-sm bg-red-50 border border-red-200 rounded px-3 py-1">
                ⚠️ {error}
                <button
                  onClick={() => fetchParts(1)}
                  className="underline hover:no-underline font-medium shrink-0"
                >
                  Retry
                </button>
              </span>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Parts List */}
          <div className="w-1/2 border-r flex flex-col">
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
                    <p className="text-gray-500">Loading parts from SQL Server...</p>
                  </div>
                </div>
              ) : (
                <div className="p-2">
                  {parts.map((part, index) => (
                    <div
                      key={index}
                      className={`p-3 mb-2 border rounded cursor-pointer transition-colors ${
                        selectedPart?.PartNumber === part.PartNumber
                          ? 'bg-blue-100 border-blue-500 shadow-sm'
                          : 'border-gray-200 hover:bg-blue-50 hover:border-blue-300'
                      }`}
                      onClick={() => setSelectedPart(part)}
                    >
                      <div className="flex items-start">
                        <span className="text-red-600 mr-2 text-lg">📦</span>
                        <div className="flex-1">
                          <div className="font-medium text-sm text-gray-900">{part.PartNumber}</div>
                          <div className="text-xs text-gray-600 mt-1">{part.Designation1}</div>
                          <div className="flex gap-2 mt-2 text-xs text-gray-500">
                            <span className="bg-gray-100 px-2 py-0.5 rounded">{part.Manufacturer}</span>
                            {part.OrderNumber && (
                              <span className="bg-gray-100 px-2 py-0.5 rounded">{part.OrderNumber}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                  {parts.length === 0 && !loading && (
                    <div className="text-center text-gray-500 mt-10">
                      <p className="text-lg mb-2">🔍 No parts found</p>
                      <p className="text-sm">Try a different search term</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Pagination Bar */}
            {totalPages > 1 && (
              <div className="border-t px-3 py-2 bg-gray-50 flex items-center justify-center gap-1 flex-wrap">
                <button
                  onClick={() => handlePageChange(1)}
                  disabled={currentPage === 1 || loading}
                  className="px-2 py-1 rounded text-xs border hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="First page"
                >
                  «
                </button>
                <button
                  onClick={() => handlePageChange(currentPage - 1)}
                  disabled={currentPage === 1 || loading}
                  className="p-1 rounded border hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ChevronLeftIcon className="w-4 h-4" />
                </button>

                {pageButtons().map(p => (
                  <button
                    key={p}
                    onClick={() => handlePageChange(p)}
                    disabled={loading}
                    className={`px-3 py-1 rounded text-xs border font-medium ${
                      p === currentPage
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'hover:bg-gray-200'
                    } disabled:cursor-not-allowed`}
                  >
                    {p}
                  </button>
                ))}

                <button
                  onClick={() => handlePageChange(currentPage + 1)}
                  disabled={currentPage === totalPages || loading}
                  className="p-1 rounded border hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ChevronRightIcon className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handlePageChange(totalPages)}
                  disabled={currentPage === totalPages || loading}
                  className="px-2 py-1 rounded text-xs border hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Last page"
                >
                  »
                </button>
                <span className="text-xs text-gray-500 ml-2">
                  {((currentPage - 1) * PAGE_SIZE) + 1}–{Math.min(currentPage * PAGE_SIZE, totalCount)} / {totalCount.toLocaleString()}
                </span>
              </div>
            )}
          </div>

          {/* Part Details */}
          <div className="w-1/2 overflow-y-auto p-6 bg-gray-50">
            {selectedPart ? (
              <div>
                <h3 className="text-lg font-semibold mb-4 text-blue-900">📋 Part Details</h3>
                <div className="space-y-3">
                  <DetailRow label="Product group" value={selectedPart.ProductGroup} />
                  <DetailRow label="Product subgroup" value={selectedPart.ProductSubgroup} />
                  <DetailRow label="Part number" value={selectedPart.PartNumber} highlight />
                  <DetailRow label="ERP number" value={selectedPart.ERPNumber} />
                  <DetailRow label="Type number" value={selectedPart.TypeNumber} />
                  <DetailRow label="Designation 1" value={selectedPart.Designation1} />
                  <DetailRow label="Designation 2" value={selectedPart.Designation2} />
                  <DetailRow label="Designation 3" value={selectedPart.Designation3} />
                  <DetailRow label="Manufacturer" value={selectedPart.Manufacturer} highlight />
                  <DetailRow label="Supplier" value={selectedPart.Supplier} />
                  
                  {/* Eplanix section with Order Number */}
                  <div className="mt-4 border-t pt-3">
                    <div className="text-sm font-semibold text-gray-700 mb-2">Eplanix</div>
                    <DetailRow label="Order Number" value={selectedPart.OrderNumber} />
                    {/* Show Designation 3 if OrderNumber is empty, "-", or "_" */}
                    {(!selectedPart.OrderNumber || 
                      selectedPart.OrderNumber === '-' || 
                      selectedPart.OrderNumber === '_' || 
                      selectedPart.OrderNumber.trim() === '') && (
                      <DetailRow label="Designation 3" value={selectedPart.Designation3} />
                    )}
                  </div>
                  
                  {/* Description from SQL Server */}
                  <div className="mt-4 border-t pt-3">
                    <div className="text-sm font-semibold text-gray-700 mb-2">Description</div>
                    <DetailRow label="" value={selectedPart.Description} multiline />
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-gray-400">
                <div className="text-6xl mb-4">📦</div>
                <p className="text-lg">Select a part to view details</p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t flex justify-between items-center bg-gray-50">
          <div className="text-sm text-gray-600">
            {selectedPart && (
              <span className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full">
                ✓ Selected: {selectedPart.PartNumber}
              </span>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-6 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleOk}
              disabled={!selectedPart}
              className={`px-6 py-2 rounded-lg transition-colors ${
                selectedPart
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-gray-300 text-gray-500 cursor-not-allowed'
              }`}
            >
              {currentPart ? '🔄 Replace Part' : '✓ Select Part'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const DetailRow: React.FC<{
  label: string;
  value?: string;
  multiline?: boolean;
  highlight?: boolean;
}> = ({ label, value, multiline, highlight }) => (
  <div className={`grid grid-cols-3 gap-4 ${highlight ? 'bg-yellow-50 p-2 rounded' : ''}`}>
    <div className="text-sm font-medium text-gray-600">{label}:</div>
    <div className="col-span-2">
      {multiline ? (
        <textarea
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm bg-white"
          value={value || '-'}
          readOnly
          rows={3}
        />
      ) : (
        <input
          type="text"
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm bg-white"
          value={value || '-'}
          readOnly
        />
      )}
    </div>
  </div>
);

export const TemplateProperties: React.FC<TemplatePropertiesProps> = ({
  template
}) => {
  const { updateTemplate } = useProject();
  const [properties, setProperties] = useState<Record<string, PropertyValue>>(
    template.properties || {}
  );
  const [dialogState, setDialogState] = useState<{
    isOpen: boolean;
    propertyName: string;
    currentPart: PartInfo | null;
    partIndex: number | null;
  }>({
    isOpen: false,
    propertyName: '',
    currentPart: null,
    partIndex: null
  });

  useEffect(() => {
    setProperties(template.properties || {});
  }, [template]);

  // ── LV property layout (per spec) ──────────────────────────────────────────
  // All LV rows are now renamable (user can edit all property names)
  const lvFixed = [
    'CB ORDER',          // first row → auto-label "Q" when a part is added
    'ACCESSORY',
    'CONTACTOR. ORDER',
    'OVER LOAD RELAY',
    'EARTH FAULT',
    'COREBALANCE CT',
    'PROTECTION RELAY',
    'CT RATING',
    'AMMETER',
    'AMMETER selector',
    'PT RATING',
    'VOLTMETER',
    'VOLTMETER selector',
    'MULTIMETER',
    'TEST BLOCK',
    'TRANSDUSER',
    'ALARM ANUNCIATOR',
  ];
  // Renamable SPARE rows that fill freely
  const lvRenamableSpares = ['SPARE 1', 'SPARE 2', 'SPARE 3'];
  // Extended SPARE rows: enabled only when an earlier row is empty
  const lvExtendedSpares  = ['SPARE 4', 'SPARE 5', 'SPARE 6', 'SPARE 7'];

  // ── MV property layout (per spec) ──────────────────────────────────────────
  // All MV rows are now renamable (user can edit all property names)
  const mvFixed = [
    'VCB OR VC/FUSE',    // first row → auto-label "Q" when a part is added
    'ACCESSORY',
    'VOLTAGE INDICATOR',
    'COREBALANCE CT',
    'PROTECTION RELAY',
    'CT RATING',
    'AMMETER',
    'AMMETER selector',
    'PT RATING',
    'VOLTMETER',
    'VOLTMETER selector',
    'MULTIMETER',
    'TEST BLOCK',
    'TRANSDUSER',
    'ALARM WINDDOW',
    'SURGE ARRESTER',
  ];
  const mvRenamableSpares = ['SPARE 1', 'SPARE 2', 'SPARE 3'];
  const mvExtendedSpares  = ['SPARE 4', 'SPARE 5'];

  // HV: untouched (existing layout)
  const hvProperties = [
    'BREAKER TYPE', 'NOMINAL VOLTAGE', 'NOMINAL CURRENT',
    'SHORT CIRCUIT CURRENT', 'PROTECTION RELAY', 'INSULATION LEVEL'
  ];

  // Resolve layout for this template
  let fixedRows: string[] = [];
  let renamableSpares: string[] = [];
  let extendedSpares: string[] = [];
  switch (template.type) {
    case 'LV': fixedRows = lvFixed; renamableSpares = lvRenamableSpares; extendedSpares = lvExtendedSpares; break;
    case 'MV': fixedRows = mvFixed; renamableSpares = mvRenamableSpares; extendedSpares = mvExtendedSpares; break;
    case 'HV': fixedRows = hvProperties; break;
  }
  const propertiesToShow = [...fixedRows, ...renamableSpares, ...extendedSpares];
  // Rows that come BEFORE the extended-spare block — used to count empty slots.
  const regularRows = [...fixedRows, ...renamableSpares];
  // The very first fixed row gets "Q" as default label when a part is added.
  const firstQRow = fixedRows[0];

  // ── Metadata accessors (display names + locked rows) ───────────────────────
  const displayNames: Record<string, string> =
    (properties as any)[META_DISPLAY_NAMES] || {};
  const lockedRows: string[] =
    (properties as any)[META_LOCKED] || [];

  const getDisplayName = (rawName: string) => displayNames[rawName] || rawName;
  const isRowLocked = (rawName: string) => lockedRows.includes(rawName);

  // How many extended SPARE rows are filled (have parts)?
  const filledExtendedCount = extendedSpares.filter(
    s => (properties[s]?.parts?.length || 0) > 0
  ).length;
  // Empty regular rows that aren't already locked.
  const emptyUnlockedRegular = regularRows.filter(
    r => !(properties[r]?.parts?.length) && !isRowLocked(r)
  );
  // Extended SPARE N (0-indexed) is enabled iff there are enough empty regular
  // slots to "spend" on it. The total enabled = empty regular + locked count.
  const totalEnabledExtended = Math.min(
    extendedSpares.length,
    emptyUnlockedRegular.length + filledExtendedCount
  );
  const isExtendedEnabled = (spareName: string) => {
    const idx = extendedSpares.indexOf(spareName);
    if (idx < 0) return true;
    return idx < totalEnabledExtended;
  };

  // ── Inline rename state for renamable rows ─────────────────────────────────
  const [renamingRow, setRenamingRow] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const writeMetadata = (
    nextDisplayNames: Record<string, string>,
    nextLocked: string[]
  ) => {
    const updated = {
      ...properties,
      [META_DISPLAY_NAMES]: nextDisplayNames as any,
      [META_LOCKED]: nextLocked as any,
    };
    setProperties(updated);
    updateTemplate(template.id, updated as any);
  };

  const commitRename = (rawName: string, newName: string) => {
    const trimmed = newName.trim();
    const next = { ...displayNames };
    if (!trimmed || trimmed === rawName) {
      delete next[rawName];
    } else {
      next[rawName] = trimmed;
    }
    writeMetadata(next, lockedRows);
    setRenamingRow(null);
    setRenameDraft('');
  };

  const toggleLock = (rawName: string) => {
    if (lockedRows.includes(rawName)) {
      // Unlocking — show the warning required by spec.
      const ok = window.confirm(
        '⚠ Warning: this equipment will not be displayed in the single-line diagrams below.\n\nUnlock anyway?'
      );
      if (!ok) return;
      writeMetadata(displayNames, lockedRows.filter(r => r !== rawName));
    } else {
      writeMetadata(displayNames, [...lockedRows, rawName]);
    }
  };

  const handleOpenPartDialog = (propertyName: string, currentPart?: PartInfo, partIndex?: number) => {
    setDialogState({
      isOpen: true,
      propertyName,
      currentPart: currentPart || null,
      partIndex: partIndex ?? null
    });
  };

  const handlePartSelect = (part: any) => {
    const { propertyName, partIndex } = dialogState;
    const currentProperty = properties[propertyName] || { parts: [] };

    // First row of LV (CB ORDER) / MV (VCB OR VC/FUSE) → default label "Q"
    const isFirstQRow = propertyName === firstQRow;
    const defaultLabel = isFirstQRow ? 'Q' : (part.Designation1 || '');

    const newPart: PartInfo = {
      partNumber: part.PartNumber,
      label: defaultLabel,
      quantity: 1,
      priority: partIndex !== null ? partIndex + 1 : currentProperty.parts.length + 1,
      fullData: part
    };

    let updatedParts;
    if (partIndex !== null) {
      // 🔹 تعویض پارت موجود
      updatedParts = currentProperty.parts.map((p, i) =>
        i === partIndex ? newPart : p
      );
    } else {
      // 🔹 افزودن پارت جدید
      updatedParts = [...currentProperty.parts, newPart];
    }

    const updatedProperty = { parts: updatedParts };
    let updatedProperties: Record<string, PropertyValue> = {
      ...properties,
      [propertyName]: updatedProperty
    };

    // ── Extended-spare substitution rule ─────────────────────────────────────
    // When user fills an extended SPARE (e.g. SPARE 4) and there are still
    // empty unlocked regular rows above, lock the first such row to signify
    // it's been substituted by this spare.
    if (
      extendedSpares.includes(propertyName) &&
      partIndex === null &&
      currentProperty.parts.length === 0 // first part being added to this spare
    ) {
      const firstEmpty = regularRows.find(
        r => !(updatedProperties[r]?.parts?.length) && !isRowLocked(r)
      );
      if (firstEmpty) {
        const nextLocked = [...lockedRows, firstEmpty];
        updatedProperties = {
          ...updatedProperties,
          [META_LOCKED]: nextLocked as any,
        };
      }
    }

    setProperties(updatedProperties);
    updateTemplate(template.id, updatedProperties as any);
  };

  const handleRemovePart = (propertyName: string, partIndex: number) => {
    const currentProperty = properties[propertyName];
    if (!currentProperty) return;

    const updatedProperty = {
      parts: currentProperty.parts.filter((_, index) => index !== partIndex)
    };

    const updatedProperties = {
      ...properties,
      [propertyName]: updatedProperty
    };

    setProperties(updatedProperties);
    updateTemplate(template.id, updatedProperties);
  };

  const handleUpdatePart = (
    propertyName: string,
    partIndex: number,
    field: keyof PartInfo,
    value: any
  ) => {
    const currentProperty = properties[propertyName];
    if (!currentProperty) return;

    const updatedParts = [...currentProperty.parts];
    updatedParts[partIndex] = {
      ...updatedParts[partIndex],
      [field]: value
    };

    const updatedProperty = { parts: updatedParts };
    const updatedProperties = {
      ...properties,
      [propertyName]: updatedProperty
    };

    setProperties(updatedProperties);
    updateTemplate(template.id, updatedProperties);
  };

  return (
    <div className="h-full">
      <div className="mb-4">
        <h3 className="text-lg font-semibold">{template.name}</h3>
        <p className="text-sm text-gray-500">Type: {template.type}</p>
      </div>

      <div className="border border-gray-200 rounded-md overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-gray-50">
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-600 border-b w-36">
                Property
              </th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-600 border-b">
                Part
              </th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-600 border-b w-40">
                RATING
              </th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-600 border-b w-28">
                Label
              </th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-600 border-b w-20">
                Qty
              </th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-600 border-b w-20">
                Priority
              </th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-600 border-b w-32">
                Eplanix
              </th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-600 border-b w-40">
                Description
              </th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-600 border-b w-12">
                Del
              </th>
            </tr>
          </thead>
          <tbody>
            {propertiesToShow.map((property, index) => {
              const propertyValue = properties[property] || { parts: [] };
              const parts = propertyValue.parts || [];

              // Distinct manufacturers under property name, joined with "/"
              const manufacturers = Array.from(new Set(
                parts.map(p => p.fullData?.Manufacturer)
                     .filter((m: any): m is string => Boolean(m && String(m).trim()))
              ));
              const manufacturerLabel = manufacturers.join(' / ');

              const displayLabel = getDisplayName(property);
              // For LV and MV, all rows are renamable (including fixed rows)
              const isRenamable  = template.type === 'LV' || template.type === 'MV';
              const isExtended   = extendedSpares.includes(property);
              const isLocked     = isRowLocked(property);
              const isEnabled    = !isLocked && (!isExtended || isExtendedEnabled(property));

              // Render the property-name cell with optional rename/lock controls.
              const propNameCell = (
                <div>
                  {renamingRow === property ? (
                    <div className="flex items-center gap-1">
                      <input
                        autoFocus
                        type="text"
                        className="flex-1 border border-gray-300 rounded px-1.5 py-0.5 text-xs"
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(property, renameDraft);
                          if (e.key === 'Escape') { setRenamingRow(null); setRenameDraft(''); }
                        }}
                      />
                      <button
                        title="Save"
                        className="text-green-600 hover:text-green-800"
                        onClick={() => commitRename(property, renameDraft)}
                      ><CheckIcon className="w-4 h-4" /></button>
                      <button
                        title="Cancel"
                        className="text-gray-500 hover:text-gray-700"
                        onClick={() => { setRenamingRow(null); setRenameDraft(''); }}
                      ><XIcon className="w-4 h-4" /></button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <span className={isLocked ? 'line-through text-gray-400' : ''}>{displayLabel}</span>
                      {isRenamable && (
                        <button
                          title="Rename"
                          className="text-gray-400 hover:text-blue-600"
                          onClick={() => { setRenamingRow(property); setRenameDraft(displayLabel); }}
                        ><Edit2Icon className="w-3.5 h-3.5" /></button>
                      )}
                      {isLocked && (
                        <button
                          title="Unlock (will warn)"
                          className="text-amber-600 hover:text-amber-800"
                          onClick={() => toggleLock(property)}
                        ><UnlockIcon className="w-3.5 h-3.5" /></button>
                      )}
                      {!isLocked && isExtended && parts.length === 0 && !isEnabled && (
                        <span title="Disabled — fill earlier rows first" className="text-gray-400">
                          <LockIcon className="w-3.5 h-3.5" />
                        </span>
                      )}
                    </div>
                  )}
                  {manufacturerLabel && (
                    <div className="text-[10px] font-normal text-gray-500 mt-0.5">
                      {manufacturerLabel}
                    </div>
                  )}
                </div>
              );

              return (
                <React.Fragment key={index}>
                  {parts.length === 0 ? (
                    <tr className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                      <td className="px-4 py-3 text-sm border-b font-medium text-gray-700">
                        {propNameCell}
                      </td>
                      <td className="px-4 py-2 border-b" colSpan={6}>
                        {isEnabled ? (
                          <button
                            onClick={() => handleOpenPartDialog(property)}
                            className="flex items-center text-blue-600 hover:text-blue-800 text-sm"
                          >
                            <PlusIcon className="w-4 h-4 mr-1" />
                            Add Part from SQL Server
                          </button>
                        ) : (
                          <span className="text-xs text-gray-400 italic">
                            {isLocked
                              ? 'Locked — substituted by an extended spare. Click the unlock icon to re-enable.'
                              : 'Disabled — only available when a regular row above is empty.'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ) : (
                    parts.map((part, partIndex) => (
                      <tr
                        key={`${index}-${partIndex}`}
                        className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}
                      >
                        {partIndex === 0 && (
                          <td
                            className="px-4 py-3 text-sm border-b font-medium text-gray-700 align-top"
                            rowSpan={parts.length + 1}
                          >
                            {propNameCell}
                          </td>
                        )}
                        {/* Part number + replace button */}
                        <td className="px-4 py-2 border-b">
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm bg-gray-100"
                              value={part.partNumber}
                              readOnly
                            />
                            <button
                              onClick={() => handleOpenPartDialog(property, part, partIndex)}
                              className="p-1 text-blue-600 hover:text-blue-800"
                              title="Replace part"
                            >
                              🔄
                            </button>
                          </div>
                        </td>
                        {/* RATING column — shows Designation3 of the selected part */}
                        <td className="px-4 py-2 border-b">
                          <input
                            type="text"
                            className="w-full border border-gray-200 rounded px-2 py-1 text-sm bg-amber-50 text-amber-900"
                            value={part.fullData?.Designation3 || ''}
                            readOnly
                            title="Rating (Designation 3)"
                          />
                        </td>
                        <td className="px-4 py-2 border-b">
                          <input
                            type="text"
                            className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                            value={part.label}
                            onChange={(e) =>
                              handleUpdatePart(property, partIndex, 'label', e.target.value)
                            }
                          />
                        </td>
                        <td className="px-4 py-2 border-b">
                          <input
                            type="number"
                            className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                            value={part.quantity}
                            onChange={(e) =>
                              handleUpdatePart(property, partIndex, 'quantity', parseInt(e.target.value) || 1)
                            }
                            min="1"
                          />
                        </td>
                        <td className="px-4 py-2 border-b">
                          <input
                            type="number"
                            className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                            value={part.priority}
                            onChange={(e) =>
                              handleUpdatePart(property, partIndex, 'priority', parseInt(e.target.value) || 1)
                            }
                            min="1"
                          />
                        </td>
                        {/* Eplanix column: OrderNumber or Designation3 */}
                        <td className="px-4 py-2 border-b">
                          <input
                            type="text"
                            className="w-full border border-gray-300 rounded px-2 py-1 text-sm bg-blue-50"
                            value={
                              (part.fullData?.OrderNumber && 
                               part.fullData.OrderNumber !== '-' && 
                               part.fullData.OrderNumber !== '_' && 
                               part.fullData.OrderNumber.trim() !== '') 
                                ? part.fullData.OrderNumber 
                                : (part.fullData?.Designation3 || '')
                            }
                            readOnly
                            title="Eplanix (Order Number or Designation 3)"
                          />
                        </td>
                        {/* Description column from SQL Server */}
                        <td className="px-4 py-2 border-b">
                          <input
                            type="text"
                            className="w-full border border-gray-300 rounded px-2 py-1 text-sm bg-gray-50"
                            value={part.fullData?.Description || ''}
                            readOnly
                            title="Description from SQL Server"
                          />
                        </td>
                        <td className="px-4 py-2 border-b">
                          <button
                            onClick={() => handleRemovePart(property, partIndex)}
                            className="text-red-600 hover:text-red-800"
                          >
                            <TrashIcon className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                  {parts.length > 0 && (
                    <tr className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                      <td className="px-4 py-2 border-b" colSpan={6}>
                        <button
                          onClick={() => handleOpenPartDialog(property)}
                          className="flex items-center text-blue-600 hover:text-blue-800 text-sm"
                        >
                          <PlusIcon className="w-4 h-4 mr-1" />
                          Add Another Part
                        </button>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <PartSelectionDialog
        isOpen={dialogState.isOpen}
        onClose={() => setDialogState({ isOpen: false, propertyName: '', currentPart: null, partIndex: null })}
        onSelect={handlePartSelect}
        propertyName={dialogState.propertyName}
        currentPart={dialogState.currentPart}
      />
    </div>
  );
};