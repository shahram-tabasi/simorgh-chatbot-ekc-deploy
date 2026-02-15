/**
 * CreateAgentProjectModal
 * ========================
 * Modern user project creation - just a name and optional description.
 * No TPMS data, no OENUM, no permission validation needed.
 */

import React, { useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Plus, X, Loader, Sparkles } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string, description?: string) => Promise<any>;
}

export default function CreateAgentProjectModal({ isOpen, onClose, onCreate }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = useCallback(async () => {
    if (!name.trim()) {
      setError('Project name is required');
      return;
    }

    setIsCreating(true);
    setError('');

    try {
      await onCreate(name.trim(), description.trim() || undefined);
      handleClose();
    } catch (err: any) {
      setError(err.message || 'Failed to create project');
    } finally {
      setIsCreating(false);
    }
  }, [name, description, onCreate]);

  const handleClose = useCallback(() => {
    setName('');
    setDescription('');
    setError('');
    setIsCreating(false);
    onClose();
  }, [onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && name.trim()) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit, name]);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={handleClose}
        className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50"
      />

      {/* Modal */}
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0, y: 20 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <div className="bg-gradient-to-br from-gray-900 to-black border border-white/20 rounded-2xl shadow-2xl w-full max-w-md p-8">
          {/* Header */}
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-2xl font-bold text-white flex items-center gap-3">
              <div className="p-2 bg-gradient-to-br from-emerald-500/20 to-teal-500/20 rounded-xl">
                <Sparkles className="w-6 h-6 text-emerald-400" />
              </div>
              New Agent Project
            </h2>
            <button
              onClick={handleClose}
              className="p-2 hover:bg-white/10 rounded-lg transition"
            >
              <X className="w-5 h-5 text-gray-400" />
            </button>
          </div>

          {/* Description */}
          <p className="text-sm text-gray-400 mb-6">
            Create a project with an AI agent that manages tasks, documents,
            and communications. The agent uses Chain of Thought reasoning
            to break down requests into actionable steps.
          </p>

          <div className="space-y-5">
            {/* Project Name */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Project Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); setError(''); }}
                onKeyDown={handleKeyDown}
                placeholder="e.g., Website Redesign, Data Migration..."
                className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition"
                autoFocus
                maxLength={255}
              />
            </div>

            {/* Description (optional) */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Description <span className="text-gray-500">(optional)</span>
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description of the project goals..."
                rows={3}
                className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition resize-none"
                maxLength={2000}
              />
            </div>

            {/* Features info */}
            <div className="bg-white/5 border border-white/10 rounded-xl p-4">
              <p className="text-xs font-medium text-gray-400 mb-2">This project will include:</p>
              <div className="grid grid-cols-2 gap-2 text-xs text-gray-500">
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />
                  COT Task Planning
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 bg-blue-400 rounded-full" />
                  Git Version Control
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 bg-purple-400 rounded-full" />
                  4-Layer Memory
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 bg-orange-400 rounded-full" />
                  Document Processing
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 bg-pink-400 rounded-full" />
                  Email Gateway
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 bg-yellow-400 rounded-full" />
                  Shell Terminal
                </div>
              </div>
            </div>

            {/* Error */}
            {error && (
              <div className="px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            {/* Creating Animation */}
            {isCreating && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-3 px-4 py-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl"
              >
                <Loader className="w-5 h-5 text-emerald-400 animate-spin" />
                <div>
                  <p className="text-sm text-emerald-400 font-medium">Creating project...</p>
                  <p className="text-xs text-emerald-400/70">Initializing agent, memory, and git workspace</p>
                </div>
              </motion.div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-2">
              <button
                onClick={handleSubmit}
                disabled={!name.trim() || isCreating}
                className="flex-1 py-3 bg-gradient-to-r from-emerald-500 to-teal-600 rounded-xl font-bold text-white hover:from-emerald-600 hover:to-teal-700 transition shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isCreating ? (
                  <>
                    <Loader className="w-5 h-5 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <Plus className="w-5 h-5" />
                    Create Project
                  </>
                )}
              </button>
              <button
                onClick={handleClose}
                disabled={isCreating}
                className="px-6 py-3 bg-white/10 border border-white/20 rounded-xl text-white hover:bg-white/20 transition disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </>
  );
}
