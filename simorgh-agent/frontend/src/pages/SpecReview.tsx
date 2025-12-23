// src/pages/SpecReview.tsx
import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { showSuccess, showError } from '../utils/alerts';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface SpecField {
  [fieldName: string]: string;
}

interface SpecData {
  [categoryName: string]: SpecField;
}

interface SpecResponse {
  status: string;
  project_number: string;
  document_id: string;
  specifications: SpecData;
}

export const SpecReview: React.FC = () => {
  const { projectNumber, documentId } = useParams<{ projectNumber: string; documentId: string }>();
  const navigate = useNavigate();

  const [specs, setSpecs] = useState<SpecData | null>(null);
  const [originalSpecs, setOriginalSpecs] = useState<SpecData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    fetchSpecs();
  }, [projectNumber, documentId]);

  const fetchSpecs = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('simorgh_token');

      if (!token) {
        setError('Authentication required');
        return;
      }

      const response = await axios.get<SpecResponse>(
        `${API_BASE}/projects/${projectNumber}/documents/${documentId}/specs`,
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      setSpecs(response.data.specifications);
      setOriginalSpecs(JSON.parse(JSON.stringify(response.data.specifications)));
      setError(null);
    } catch (err: any) {
      console.error('Failed to fetch specs:', err);
      setError(err.response?.data?.detail || 'Failed to load specifications');
    } finally {
      setLoading(false);
    }
  };

  const handleFieldChange = (category: string, field: string, value: string) => {
    if (!specs) return;

    const updatedSpecs = { ...specs };
    updatedSpecs[category] = { ...updatedSpecs[category], [field]: value };
    setSpecs(updatedSpecs);
    setHasChanges(true);
  };

  const handleSave = async () => {
    if (!specs) return;

    try {
      setSaving(true);
      const token = localStorage.getItem('simorgh_token');

      if (!token) {
        setError('Authentication required');
        return;
      }

      await axios.put(
        `${API_BASE}/projects/${projectNumber}/documents/${documentId}/specs`,
        {
          specifications: specs
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      setOriginalSpecs(JSON.parse(JSON.stringify(specs)));
      setHasChanges(false);
      showSuccess('Success!', 'Specifications saved successfully!');
    } catch (err: any) {
      console.error('Failed to save specs:', err);
      showError('Save Failed', err.response?.data?.detail || err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (originalSpecs) {
      setSpecs(JSON.parse(JSON.stringify(originalSpecs)));
      setHasChanges(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading specifications...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-500 text-xl mb-4">❌ {error}</p>
          <button
            onClick={() => navigate('/')}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 overflow-x-hidden">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-2 sm:px-4 py-3 sm:py-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white truncate">
                Review Specifications
              </h1>
              <p className="text-xs sm:text-sm text-gray-600 dark:text-gray-400 mt-1 truncate">
                Project: {projectNumber} • Document: {documentId}
              </p>
            </div>

            <div className="flex gap-2 flex-shrink-0 w-full sm:w-auto">
              {hasChanges && (
                <button
                  onClick={handleReset}
                  className="px-3 sm:px-4 py-2 text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
                >
                  Reset
                </button>
              )}

              <button
                onClick={handleSave}
                disabled={!hasChanges || saving}
                className={`px-3 sm:px-4 py-2 text-sm rounded font-medium transition-colors flex-1 sm:flex-initial ${
                  hasChanges && !saving
                    ? 'bg-blue-500 hover:bg-blue-600 text-white'
                    : 'bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed'
                }`}
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>

              <button
                onClick={() => navigate('/')}
                className="hidden sm:block px-3 sm:px-4 py-2 text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-2 sm:px-4 py-4 sm:py-6 pb-20 sm:pb-6">
        {specs && Object.entries(specs).map(([category, fields]) => (
          <div
            key={category}
            className="bg-white dark:bg-gray-800 rounded-lg shadow mb-4 sm:mb-6 overflow-hidden"
          >
            <div className="bg-blue-500 text-white px-3 sm:px-4 py-2 sm:py-3">
              <h2 className="text-base sm:text-lg font-semibold truncate">
                {category.replace(/_/g, ' ')}
              </h2>
            </div>

            <div className="p-3 sm:p-4 grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
              {Object.entries(fields).map(([fieldName, fieldValue]) => (
                <div key={fieldName} className="flex flex-col min-w-0">
                  <label className="text-xs sm:text-sm font-medium text-gray-700 dark:text-gray-300 mb-1 truncate">
                    {fieldName.replace(/_/g, ' ')}
                  </label>
                  <input
                    type="text"
                    value={fieldValue}
                    onChange={(e) => handleFieldChange(category, fieldName, e.target.value)}
                    placeholder="Not specified"
                    className="w-full min-w-0 px-2 sm:px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-shadow"
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Floating save button for mobile - moved to avoid settings button */}
      {hasChanges && (
        <div className="fixed bottom-4 left-4 md:hidden z-40">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 sm:px-6 py-2 sm:py-3 text-sm bg-blue-500 hover:bg-blue-600 text-white rounded-full shadow-lg font-medium transition-colors disabled:opacity-50"
          >
            {saving ? '💾 Saving...' : '💾 Save'}
          </button>
        </div>
      )}
    </div>
  );
};

export default SpecReview;
