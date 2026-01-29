/**
 * CreateSessionModal Component
 * ============================
 * Unified modal for creating both General and Project chat sessions.
 * Supports the enhanced chatbot v2 architecture.
 */

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  MessageSquarePlus,
  FolderOpen,
  Sparkles,
  Globe,
  Lock,
  ChevronRight,
} from 'lucide-react';
import { ChatSessionType, SessionStage } from '../types';

interface CreateSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateGeneralSession: (title?: string) => Promise<void>;
  onCreateProjectSession: (
    projectNumber: string,
    projectName: string,
    projectDomain?: string,
    stage?: SessionStage
  ) => Promise<void>;
  isLoading?: boolean;
}

type SessionTypeTab = 'general' | 'project';

const STAGE_OPTIONS: { value: SessionStage; label: string; description: string }[] = [
  { value: 'analysis', label: 'Analysis', description: 'External tools allowed' },
  { value: 'design', label: 'Design', description: 'Project knowledge only' },
  { value: 'implementation', label: 'Implementation', description: 'Project knowledge only' },
  { value: 'review', label: 'Review', description: 'Project knowledge only' },
];

export default function CreateSessionModal({
  isOpen,
  onClose,
  onCreateGeneralSession,
  onCreateProjectSession,
  isLoading = false,
}: CreateSessionModalProps) {
  const [activeTab, setActiveTab] = useState<SessionTypeTab>('general');

  // General session form
  const [generalTitle, setGeneralTitle] = useState('');

  // Project session form
  const [projectNumber, setProjectNumber] = useState('');
  const [projectName, setProjectName] = useState('');
  const [projectDomain, setProjectDomain] = useState('');
  const [selectedStage, setSelectedStage] = useState<SessionStage>('analysis');

  const resetForm = () => {
    setGeneralTitle('');
    setProjectNumber('');
    setProjectName('');
    setProjectDomain('');
    setSelectedStage('analysis');
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleCreateGeneral = async (e: React.FormEvent) => {
    e.preventDefault();
    await onCreateGeneralSession(generalTitle.trim() || undefined);
    resetForm();
    onClose();
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectNumber.trim() || !projectName.trim()) return;

    await onCreateProjectSession(
      projectNumber.trim(),
      projectName.trim(),
      projectDomain.trim() || undefined,
      selectedStage
    );
    resetForm();
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
            <div className="bg-gradient-to-br from-gray-900 to-black border border-white/10 rounded-2xl shadow-2xl w-full max-w-lg mx-4 pointer-events-auto overflow-hidden">
              {/* Header */}
              <div className="bg-gradient-to-r from-blue-600/20 to-purple-600/20 border-b border-white/10 p-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                      <MessageSquarePlus className="w-6 h-6 text-white" />
                    </div>
                    <div>
                      <h2 className="text-xl font-bold text-white">New Chat Session</h2>
                      <p className="text-sm text-gray-400">Choose session type and configure</p>
                    </div>
                  </div>
                  <button
                    onClick={handleClose}
                    className="p-2 hover:bg-white/10 rounded-lg transition"
                    disabled={isLoading}
                  >
                    <X className="w-5 h-5 text-gray-400" />
                  </button>
                </div>
              </div>

              {/* Tab Selector */}
              <div className="flex border-b border-white/10">
                <button
                  onClick={() => setActiveTab('general')}
                  className={`flex-1 px-4 py-3 flex items-center justify-center gap-2 text-sm font-medium transition ${
                    activeTab === 'general'
                      ? 'bg-white/5 text-blue-400 border-b-2 border-blue-400'
                      : 'text-gray-400 hover:text-gray-300 hover:bg-white/5'
                  }`}
                >
                  <Globe className="w-4 h-4" />
                  General Session
                </button>
                <button
                  onClick={() => setActiveTab('project')}
                  className={`flex-1 px-4 py-3 flex items-center justify-center gap-2 text-sm font-medium transition ${
                    activeTab === 'project'
                      ? 'bg-white/5 text-purple-400 border-b-2 border-purple-400'
                      : 'text-gray-400 hover:text-gray-300 hover:bg-white/5'
                  }`}
                >
                  <FolderOpen className="w-4 h-4" />
                  Project Session
                </button>
              </div>

              {/* General Session Form */}
              {activeTab === 'general' && (
                <form onSubmit={handleCreateGeneral} className="p-6 space-y-4">
                  {/* Info Banner */}
                  <div className="flex items-start gap-3 p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl">
                    <Globe className="w-5 h-5 text-blue-400 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-blue-300">Isolated Memory</p>
                      <p className="text-xs text-blue-300/70 mt-1">
                        This session has its own isolated memory. Full access to external tools
                        (internet search, Wikipedia, Python engine).
                      </p>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      Chat Title (Optional)
                    </label>
                    <input
                      type="text"
                      value={generalTitle}
                      onChange={(e) => setGeneralTitle(e.target.value)}
                      placeholder="e.g., Research Notes, Quick Questions..."
                      className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                      disabled={isLoading}
                    />
                  </div>

                  {/* Actions */}
                  <div className="flex gap-3 pt-2">
                    <button
                      type="button"
                      onClick={handleClose}
                      className="flex-1 px-4 py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-white font-medium transition"
                      disabled={isLoading}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isLoading}
                      className="flex-1 px-4 py-3 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-white font-medium transition flex items-center justify-center gap-2"
                    >
                      {isLoading ? (
                        <span className="animate-spin">⏳</span>
                      ) : (
                        <>
                          <Sparkles className="w-4 h-4" />
                          Create General Chat
                        </>
                      )}
                    </button>
                  </div>
                </form>
              )}

              {/* Project Session Form */}
              {activeTab === 'project' && (
                <form onSubmit={handleCreateProject} className="p-6 space-y-4">
                  {/* Info Banner */}
                  <div className="flex items-start gap-3 p-4 bg-purple-500/10 border border-purple-500/20 rounded-xl">
                    <Lock className="w-5 h-5 text-purple-400 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-purple-300">Shared Project Memory</p>
                      <p className="text-xs text-purple-300/70 mt-1">
                        This session shares memory with other project chats. External tools
                        are only available during the Analysis stage.
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-2">
                        Project Number *
                      </label>
                      <input
                        type="text"
                        value={projectNumber}
                        onChange={(e) => setProjectNumber(e.target.value)}
                        placeholder="e.g., PRJ-2024-001"
                        className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent transition"
                        required
                        disabled={isLoading}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-2">
                        Project Name *
                      </label>
                      <input
                        type="text"
                        value={projectName}
                        onChange={(e) => setProjectName(e.target.value)}
                        placeholder="e.g., Motor Controller"
                        className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent transition"
                        required
                        disabled={isLoading}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      Project Domain (Optional)
                    </label>
                    <input
                      type="text"
                      value={projectDomain}
                      onChange={(e) => setProjectDomain(e.target.value)}
                      placeholder="e.g., Electrical, Mechanical, Software..."
                      className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent transition"
                      disabled={isLoading}
                    />
                  </div>

                  {/* Stage Selector */}
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      Initial Stage
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {STAGE_OPTIONS.map((stage) => (
                        <button
                          key={stage.value}
                          type="button"
                          onClick={() => setSelectedStage(stage.value)}
                          className={`p-3 rounded-xl border text-left transition ${
                            selectedStage === stage.value
                              ? 'bg-purple-500/20 border-purple-500/50 text-purple-300'
                              : 'bg-white/5 border-white/10 text-gray-400 hover:bg-white/10'
                          }`}
                          disabled={isLoading}
                        >
                          <div className="flex items-center gap-2">
                            <ChevronRight
                              className={`w-4 h-4 ${
                                selectedStage === stage.value
                                  ? 'text-purple-400'
                                  : 'text-gray-500'
                              }`}
                            />
                            <span className="font-medium">{stage.label}</span>
                          </div>
                          <p className="text-xs mt-1 ml-6 opacity-70">{stage.description}</p>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex gap-3 pt-2">
                    <button
                      type="button"
                      onClick={handleClose}
                      className="flex-1 px-4 py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-white font-medium transition"
                      disabled={isLoading}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isLoading || !projectNumber.trim() || !projectName.trim()}
                      className="flex-1 px-4 py-3 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-white font-medium transition flex items-center justify-center gap-2"
                    >
                      {isLoading ? (
                        <span className="animate-spin">⏳</span>
                      ) : (
                        <>
                          <FolderOpen className="w-4 h-4" />
                          Create Project Chat
                        </>
                      )}
                    </button>
                  </div>
                </form>
              )}

              {/* Footer */}
              <div className="bg-white/5 border-t border-white/10 px-6 py-3">
                <p className="text-xs text-gray-500 text-center">
                  {activeTab === 'general'
                    ? 'General sessions are perfect for quick questions and isolated research'
                    : 'Project sessions share context across all chats within the same project'}
                </p>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
