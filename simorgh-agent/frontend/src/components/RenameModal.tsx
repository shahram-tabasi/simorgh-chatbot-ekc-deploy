import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Edit2 } from 'lucide-react';
import { showWarning } from '../utils/alerts';

interface RenameModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRename: (newName: string) => void;
  currentName: string;
  type: 'project' | 'page';
}

export default function RenameModal({
  isOpen,
  onClose,
  onRename,
  currentName,
  type
}: RenameModalProps) {
  const [newName, setNewName] = useState(currentName);

  useEffect(() => {
    if (isOpen) {
      setNewName(currentName);
    }
  }, [isOpen, currentName]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!newName.trim()) {
      showWarning('Empty Name', `${type === 'project' ? 'Project' : 'Page'} name cannot be empty`);
      return;
    }

    if (newName.trim() === currentName) {
      onClose();
      return;
    }

    onRename(newName.trim());
    onClose();
  };

  const handleClose = () => {
    setNewName(currentName);
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
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[9998]"
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed inset-0 z-[9999] flex items-center justify-center pointer-events-none"
          >
            <div className="bg-gradient-to-br from-gray-900 to-black border border-white/20 rounded-2xl shadow-2xl w-full max-w-md mx-4 pointer-events-auto overflow-hidden">
              {/* Header */}
              <div className="bg-gradient-to-r from-blue-600/20 to-purple-600/20 border-b border-white/10 p-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                      <Edit2 className="w-6 h-6 text-white" />
                    </div>
                    <div>
                      <h2 className="text-xl font-bold text-white">
                        Rename {type === 'project' ? 'Project' : 'Page'}
                      </h2>
                      <p className="text-sm text-gray-400">
                        Enter a new name
                      </p>
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
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    {type === 'project' ? 'Project' : 'Page'} Name
                  </label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={`Enter ${type} name`}
                    className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                    autoFocus
                  />
                </div>

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
                    disabled={!newName.trim()}
                    className="flex-1 px-4 py-3 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-white font-medium transition"
                  >
                    Rename
                  </button>
                </div>
              </form>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
