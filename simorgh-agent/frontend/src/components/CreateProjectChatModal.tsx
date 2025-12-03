// src/components/CreateProjectChatModal.tsx
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, FolderOpen, FileText, AlertCircle } from 'lucide-react';

interface CreateProjectChatModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (projectId: string, projectName: string, pageName: string) => void;
  userId?: string;
}

export default function CreateProjectChatModal({
  isOpen,
  onClose,
  onCreate,
  userId
}: CreateProjectChatModalProps) {
  const [projectId, setProjectId] = useState('');
  const [pageName, setPageName] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!projectId.trim()) {
      setError('Please enter a Project ID');
      return;
    }

    if (!pageName.trim()) {
      setError('Please enter a Page Name');
      return;
    }

    // Backend will validate project access
    // Project name will be auto-filled by backend
    onCreate(projectId, '', pageName.trim());
    handleClose();
  };

  const handleClose = () => {
    setProjectId('');
    setPageName('');
    setError('');
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center"
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
          >
            <div className="bg-gradient-to-br from-gray-900 to-black border border-white/10 rounded-2xl shadow-2xl w-full max-w-md mx-4 pointer-events-auto overflow-hidden">
              {/* Header */}
              <div className="bg-gradient-to-r from-indigo-600/20 to-purple-600/20 border-b border-white/10 p-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
                      <FolderOpen className="w-6 h-6 text-white" />
                    </div>
                    <div>
                      <h2 className="text-xl font-bold text-white">New Project Chat</h2>
                      <p className="text-sm text-gray-400">Create a session for a project</p>
                    </div>
                  </div>
                  <button
                    onClick={handleClose}
                    className="p-2 hover:bg-white/10 rounded-lg transition"
                  >
                    <X className="w-5 h-5 text-gray-400" />
                  </button>
                </div>
              </div>

              {/* Form */}
              <form onSubmit={handleSubmit} className="p-6 space-y-6">
                {/* Project ID Input */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Project ID
                  </label>
                  <input
                    type="text"
                    value={projectId}
                    onChange={(e) => {
                      setProjectId(e.target.value);
                      setError('');
                    }}
                    placeholder="e.g., 12345"
                    className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition"
                    autoFocus
                  />
                  <p className="mt-2 text-xs text-gray-500">
                    Enter the Project ID from TPMS database
                  </p>
                </div>

                {/* Page Name Input */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Page Name
                  </label>
                  <div className="flex items-center gap-2 px-4 py-3 bg-white/5 border border-white/10 rounded-xl">
                    <FileText className="w-5 h-5 text-gray-400" />
                    <input
                      type="text"
                      value={pageName}
                      onChange={(e) => {
                        setPageName(e.target.value);
                        setError('');
                      }}
                      placeholder="e.g., Panel Analysis"
                      className="flex-1 bg-transparent text-white placeholder-gray-500 focus:outline-none"
                    />
                  </div>
                  <p className="mt-2 text-xs text-gray-500">
                    This will be the title of your chat session
                  </p>
                </div>

                {/* Error Message */}
                {error && (
                  <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl">
                    <AlertCircle className="w-5 h-5 text-red-400" />
                    <p className="text-sm text-red-400">{error}</p>
                  </div>
                )}

                {/* Buttons */}
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="flex-1 px-4 py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-white font-medium transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!projectId.trim() || !pageName.trim()}
                    className="flex-1 px-4 py-3 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-white font-medium transition"
                  >
                    Create Chat
                  </button>
                </div>
              </form>

              {/* Footer */}
              <div className="bg-white/5 border-t border-white/10 px-6 py-3">
                <p className="text-xs text-gray-500 text-center">
                  💡 Project access will be verified against TPMS database
                </p>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
