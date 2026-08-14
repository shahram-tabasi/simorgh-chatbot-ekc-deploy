import React, { useState } from 'react';
import { Revision } from '../../types/project';

interface RevisionDropdownProps {
  revisions: Revision[];
  currentRevision: Revision | null;
  onSwitchRevision: (revisionId: string) => void;
  onDeleteRevision?: (revisionId: string) => void;
}

export const RevisionDropdown: React.FC<RevisionDropdownProps> = ({
  revisions,
  currentRevision,
  onSwitchRevision,
  onDeleteRevision
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [revisionToDelete, setRevisionToDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');

  const handleDeleteClick = (e: React.MouseEvent, revisionId: string) => {
    e.stopPropagation();
    setRevisionToDelete(revisionId);
    setShowDeleteConfirm(true);
    setDeletePassword('');
    setDeleteError('');
  };

  const handleConfirmDelete = async () => {
    if (!onDeleteRevision || !revisionToDelete) return;
    
    try {
      await onDeleteRevision(revisionToDelete);
      setShowDeleteConfirm(false);
      setRevisionToDelete(null);
      setDeletePassword('');
    } catch (error: any) {
      setDeleteError(error.message || 'Failed to delete revision');
    }
  };

  const sortedRevisions = [...revisions].sort((a, b) => b.revisionNumber - a.revisionNumber);

  return (
    <div className="relative">
      {/* Revision Selector Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded text-sm text-blue-800 transition-colors"
      >
        <span className="font-semibold">{currentRevision?.revisionLabel || 'REV N/A'}</span>
        {currentRevision?.isLatest && (
          <span className="text-xs bg-green-500 text-white px-1.5 py-0.5 rounded">LATEST</span>
        )}
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <>
          {/* Backdrop to close dropdown */}
          <div 
            className="fixed inset-0 z-40" 
            onClick={() => setIsOpen(false)} 
          />
          
          <div className="absolute right-0 mt-2 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-50 overflow-hidden">
            {/* Header */}
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-200">
              <span className="text-xs font-semibold text-gray-500 uppercase">Select Revision</span>
            </div>

            {/* Revision List */}
            <div className="max-h-64 overflow-y-auto">
              {sortedRevisions.length === 0 ? (
                <div className="px-4 py-3 text-sm text-gray-500 text-center">
                  No revisions available
                </div>
              ) : (
                sortedRevisions.map((revision) => (
                  <div
                    key={revision._id}
                    className={`flex items-center justify-between px-4 py-3 cursor-pointer transition-colors ${
                      currentRevision?._id === revision._id
                        ? 'bg-blue-50 border-l-4 border-blue-500'
                        : 'hover:bg-gray-50 border-l-4 border-transparent'
                    }`}
                    onClick={() => {
                      onSwitchRevision(revision._id!);
                      setIsOpen(false);
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-gray-800">{revision.revisionLabel}</span>
                        {revision.isLatest && (
                          <span className="text-xs bg-green-500 text-white px-1.5 py-0.5 rounded">LATEST</span>
                        )}
                        {revision.revisionNumber === 0 && (
                          <span className="text-xs bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded">BASE</span>
                        )}
                      </div>
                      {revision.description && (
                        <p className="text-xs text-gray-500 mt-1 truncate">{revision.description}</p>
                      )}
                      <p className="text-xs text-gray-400 mt-0.5">
                        {new Date(revision.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    
                    {/* Delete button (only for non-base revisions) */}
                    {revision.revisionNumber > 0 && onDeleteRevision && (
                      <button
                        onClick={(e) => handleDeleteClick(e, revision._id!)}
                        className="ml-2 p-1 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Delete revision"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">Delete Revision</h3>
            <p className="text-sm text-gray-600 mb-4">
              Are you sure you want to delete this revision? This action requires administrator password.
            </p>
            
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Administrator Password
              </label>
              <input
                type="password"
                value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:border-red-400"
                placeholder="Enter password"
                autoFocus
              />
              {deleteError && (
                <p className="text-xs text-red-500 mt-1">{deleteError}</p>
              )}
            </div>

            <div className="flex gap-3 justify-end">
              <button
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setRevisionToDelete(null);
                  setDeletePassword('');
                  setDeleteError('');
                }}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                disabled={!deletePassword}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                Delete Revision
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
