import React, { useState } from 'react';
import { RevisionCreateData } from '../../types/project';

interface CreateRevisionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (data: RevisionCreateData) => Promise<void>;
  projectName: string;
  projectId: string;
  nextRevisionNumber: number;
}

export const CreateRevisionModal: React.FC<CreateRevisionModalProps> = ({
  isOpen,
  onClose,
  onCreate,
  projectName,
  projectId,
  nextRevisionNumber
}) => {
  const [description, setDescription] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleCreate = async () => {
    setIsCreating(true);
    setError('');
    
    try {
      await onCreate({
        projectId,
        description: description.trim() || undefined,
        projectSnapshot: {} as any // Will be filled by parent component
      });
      onClose();
      setDescription('');
    } catch (err: any) {
      setError(err.message || 'Failed to create revision');
    } finally {
      setIsCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleCreate();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div 
        className="bg-white rounded-lg p-6 max-w-md w-full mx-4"
        onKeyDown={handleKeyDown}
      >
        <h3 className="text-lg font-semibold text-gray-800 mb-4">Create New Revision</h3>
        
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Project
          </label>
          <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded text-sm text-gray-600">
            {projectName}
          </div>
        </div>

        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            New Revision
          </label>
          <div className="px-3 py-2 bg-green-50 border border-green-200 rounded text-sm font-semibold text-green-700">
            REV {nextRevisionNumber}
          </div>
        </div>

        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Description (Optional)
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400 resize-none"
            rows={3}
            placeholder="Enter a description for this revision..."
            autoFocus
          />
          <p className="text-xs text-gray-500 mt-1">
            Describe the changes in this revision
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-600">
            {error}
          </div>
        )}

        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            disabled={isCreating}
            className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={isCreating}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            {isCreating ? (
              <>
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Creating...
              </>
            ) : (
              'Create Revision'
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
