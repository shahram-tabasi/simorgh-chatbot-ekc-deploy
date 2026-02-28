// src/components/shared/PartSelectionDialog.tsx
// دیالوگ انتخاب پارت از SQL Server - کامپوننت مشترک قابل استفاده در همه صفحات
import React, { useEffect, useState } from 'react';
import { Search, RefreshCw, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';

const PAGE_SIZE = 100;
const API_URL = import.meta.env.VITE_API_URL || '';

export interface SelectedPart {
  PartNumber: string;
  TypeNumber?: string;
  OrderNumber?: string;
  Manufacturer?: string;
  Designation1?: string;
  Designation2?: string;
  Designation3?: string;
  ProductGroup?: string;
  ProductSubgroup?: string;
  Width?: number;
  Height?: number;
  Depth?: number;
  Weight?: number;
  [key: string]: any;
}

interface PartSelectionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (part: SelectedPart) => void;
  title?: string;
  subtitle?: string;
}

export const PartSelectionDialog: React.FC<PartSelectionDialogProps> = ({
  isOpen,
  onClose,
  onSelect,
  title = 'Select Part',
  subtitle
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [parts, setParts] = useState<SelectedPart[]>([]);
  const [selectedPart, setSelectedPart] = useState<SelectedPart | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manufacturers, setManufacturers] = useState<string[]>([]);
  const [selectedManufacturer, setSelectedManufacturer] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);

  useEffect(() => {
    if (isOpen) {
      setCurrentPage(1);
      setSelectedPart(null);
      setSearchTerm('');
      setSelectedManufacturer('');
      fetchParts(1, '', '');
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      setCurrentPage(1);
      fetchParts(1, searchTerm, selectedManufacturer);
    }
  }, [selectedManufacturer]);

  const fetchParts = async (page: number, search: string, manufacturer: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/api/eplan-parts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchTerm: search || undefined,
          manufacturer: manufacturer || undefined,
          page,
          pageSize: PAGE_SIZE
        })
      });

      const result = await response.json();

      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);

      if (result.success) {
        const data = Array.isArray(result.data) ? result.data : [];
        setParts(data);
        setTotalCount(result.total ?? data.length);
        setTotalPages(result.totalPages || 1);
        setCurrentPage(result.page || page);
        if (result.manufacturers?.length > 0) setManufacturers(result.manufacturers);
      } else {
        throw new Error(result.error || 'Server returned an unsuccessful response');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection error';
      setError(msg);
      setParts([]);
      setTotalCount(0);
      setTotalPages(1);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = () => {
    setCurrentPage(1);
    fetchParts(1, searchTerm, selectedManufacturer);
  };

  const handlePageChange = (newPage: number) => {
    if (newPage < 1 || newPage > totalPages || loading) return;
    setCurrentPage(newPage);
    fetchParts(newPage, searchTerm, selectedManufacturer);
  };

  const handleConfirm = () => {
    if (!selectedPart) return;
    onSelect(selectedPart);
    onClose();
  };

  const pageButtons = () => {
    const buttons: number[] = [];
    const maxButtons = 5;
    let start = Math.max(1, currentPage - Math.floor(maxButtons / 2));
    let end = Math.min(totalPages, start + maxButtons - 1);
    if (end - start < maxButtons - 1) start = Math.max(1, end - maxButtons + 1);
    for (let i = start; i <= end; i++) buttons.push(i);
    return buttons;
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-[90%] h-[90%] flex flex-col">
        {/* Header */}
        <div className="bg-blue-600 text-white px-6 py-4 rounded-t-lg flex justify-between items-center">
          <div>
            <h2 className="text-xl font-semibold">{title}</h2>
            {subtitle && <p className="text-sm text-blue-100 mt-1">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-white hover:bg-blue-700 rounded-full p-2">✕</button>
        </div>

        {/* Search + Filter */}
        <div className="px-6 py-3 border-b bg-gray-50">
          <div className="flex gap-3">
            <select
              value={selectedManufacturer}
              onChange={(e) => setSelectedManufacturer(e.target.value)}
              className="w-44 py-2 px-3 border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            >
              <option value="">All Manufacturers</option>
              {manufacturers.map((m, i) => <option key={i} value={m}>{m}</option>)}
            </select>
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
              <input
                type="text"
                placeholder="Search part number, type, manufacturer..."
                className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                autoFocus
              />
            </div>
            <button
              onClick={handleSearch}
              disabled={loading}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-400 flex items-center gap-2 text-sm"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              {loading ? 'Loading...' : 'Search'}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-3 flex-wrap text-sm">
            {selectedManufacturer && (
              <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full flex items-center gap-1">
                {selectedManufacturer}
                <button onClick={() => setSelectedManufacturer('')} className="ml-1 text-blue-600 hover:text-blue-800">✕</button>
              </span>
            )}
            {!loading && totalCount > 0 && (
              <span className="text-gray-500">
                Total: <strong>{totalCount.toLocaleString()}</strong> — Page <strong>{currentPage}</strong>/<strong>{totalPages}</strong>
              </span>
            )}
            {error && (
              <span className="text-red-600 bg-red-50 border border-red-200 rounded px-2 py-0.5">⚠️ {error}</span>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 flex overflow-hidden">
          {/* Parts List */}
          <div className="w-1/2 border-r flex flex-col">
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 mx-auto mb-3" />
                    <p className="text-gray-500 text-sm">Loading from SQL Server...</p>
                  </div>
                </div>
              ) : (
                <div className="p-2">
                  {parts.map((part, i) => (
                    <div
                      key={i}
                      onClick={() => setSelectedPart(part)}
                      className={`p-3 mb-1 border rounded cursor-pointer transition-colors ${
                        selectedPart?.PartNumber === part.PartNumber
                          ? 'bg-blue-100 border-blue-500'
                          : 'border-gray-200 hover:bg-blue-50 hover:border-blue-300'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <span className="text-red-500 text-base">📦</span>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm text-gray-900 truncate">{part.PartNumber}</div>
                          <div className="text-xs text-gray-500 truncate mt-0.5">{part.Designation1}</div>
                          <div className="flex gap-1 mt-1 flex-wrap">
                            {part.Manufacturer && (
                              <span className="bg-gray-100 px-1.5 py-0.5 rounded text-xs text-gray-600">{part.Manufacturer}</span>
                            )}
                            {part.OrderNumber && (
                              <span className="bg-gray-100 px-1.5 py-0.5 rounded text-xs text-gray-600">{part.OrderNumber}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                  {parts.length === 0 && (
                    <div className="text-center text-gray-400 mt-16">
                      <div className="text-4xl mb-2">🔍</div>
                      <p className="text-sm">No parts found</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="border-t px-3 py-2 bg-gray-50 flex items-center justify-center gap-1 flex-wrap">
                <button onClick={() => handlePageChange(1)} disabled={currentPage === 1 || loading}
                  className="px-2 py-1 rounded text-xs border hover:bg-gray-200 disabled:opacity-40">«</button>
                <button onClick={() => handlePageChange(currentPage - 1)} disabled={currentPage === 1 || loading}
                  className="p-1 rounded border hover:bg-gray-200 disabled:opacity-40">
                  <ChevronLeftIcon className="w-3.5 h-3.5" />
                </button>
                {pageButtons().map(p => (
                  <button key={p} onClick={() => handlePageChange(p)} disabled={loading}
                    className={`px-2.5 py-1 rounded text-xs border font-medium ${p === currentPage ? 'bg-blue-600 text-white border-blue-600' : 'hover:bg-gray-200'}`}>
                    {p}
                  </button>
                ))}
                <button onClick={() => handlePageChange(currentPage + 1)} disabled={currentPage === totalPages || loading}
                  className="p-1 rounded border hover:bg-gray-200 disabled:opacity-40">
                  <ChevronRightIcon className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => handlePageChange(totalPages)} disabled={currentPage === totalPages || loading}
                  className="px-2 py-1 rounded text-xs border hover:bg-gray-200 disabled:opacity-40">»</button>
                <span className="text-xs text-gray-500 ml-1">
                  {((currentPage - 1) * PAGE_SIZE) + 1}–{Math.min(currentPage * PAGE_SIZE, totalCount)} / {totalCount.toLocaleString()}
                </span>
              </div>
            )}
          </div>

          {/* Part Detail */}
          <div className="w-1/2 overflow-y-auto p-5 bg-gray-50">
            {selectedPart ? (
              <div>
                <h3 className="text-base font-semibold mb-4 text-blue-900">📋 Part Details</h3>
                <div className="space-y-2">
                  {[
                    ['Product Group', selectedPart.ProductGroup],
                    ['Product Subgroup', selectedPart.ProductSubgroup],
                    ['Part Number', selectedPart.PartNumber, true],
                    ['Type Number', selectedPart.TypeNumber],
                    ['Order Number', selectedPart.OrderNumber],
                    ['Manufacturer', selectedPart.Manufacturer, true],
                    ['Designation 1', selectedPart.Designation1],
                    ['Designation 2', selectedPart.Designation2],
                    ['Designation 3', selectedPart.Designation3],
                  ].map(([label, value, highlight]) => value ? (
                    <div key={label as string}
                      className={`grid grid-cols-3 gap-2 text-sm ${highlight ? 'bg-yellow-50 p-1.5 rounded' : ''}`}>
                      <span className="font-medium text-gray-600">{label}:</span>
                      <span className="col-span-2 text-gray-900">{value}</span>
                    </div>
                  ) : null)}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-gray-300">
                <div className="text-5xl mb-3">📦</div>
                <p>Select a part to view details</p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t flex justify-between items-center bg-gray-50">
          <div className="text-sm text-gray-600">
            {selectedPart && (
              <span className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full">
                ✓ {selectedPart.PartNumber}
              </span>
            )}
          </div>
          <div className="flex gap-3">
            <button onClick={onClose}
              className="px-5 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm">
              Cancel
            </button>
            <button onClick={handleConfirm} disabled={!selectedPart}
              className={`px-5 py-2 rounded-lg text-sm ${selectedPart ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}>
              Select Part
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
