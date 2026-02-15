/**
 * ProjectAgentDashboard
 * ======================
 * Main dashboard for the Project Agent system.
 * Shows project list, task panel, and chat interface.
 */

import React, { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus, Trash2, FolderOpen, GitBranch, FileText, Mail,
  Terminal, Send, Loader, ChevronLeft, MoreVertical,
  Sparkles, Activity, Settings, Upload, ArrowLeft,
} from 'lucide-react';
import { useProjectAgent } from '../hooks/useProjectAgent';
import CreateAgentProjectModal from '../components/CreateAgentProjectModal';
import TaskPanel from '../components/TaskPanel';
import MarkdownRenderer from '../components/MarkdownRenderer';

interface Props {
  userId: string;
}

export default function ProjectAgentDashboard({ userId }: Props) {
  const navigate = useNavigate();
  const {
    projects, activeProject, activeProjectId,
    tasks, messages, isLoading, isSending, cotProgress, error,
    setActiveProjectId, createProject, deleteProject,
    sendMessage, updateTask, uploadDocument, setError,
  } = useProjectAgent(userId);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [inputMessage, setInputMessage] = useState('');
  const [showProjectMenu, setShowProjectMenu] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Scroll to bottom on new messages
  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = useCallback(async () => {
    if (!inputMessage.trim() || !activeProjectId || isSending) return;
    const msg = inputMessage;
    setInputMessage('');
    await sendMessage(activeProjectId, msg);
  }, [inputMessage, activeProjectId, isSending, sendMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  }, [handleSendMessage]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeProjectId) return;
    await uploadDocument(activeProjectId, file);
    e.target.value = '';
  }, [activeProjectId, uploadDocument]);

  const handleDeleteProject = useCallback(async (projectId: string) => {
    if (window.confirm('Delete this project and all its data? This cannot be undone.')) {
      await deleteProject(projectId);
    }
    setShowProjectMenu(null);
  }, [deleteProject]);

  return (
    <div className="flex h-full bg-gray-950">
      {/* Left Panel: Project List */}
      <div className="w-72 border-r border-white/10 flex flex-col bg-gray-900/50">
        {/* Header */}
        <div className="p-4 border-b border-white/10">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition mb-3"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Chat
          </button>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-emerald-400" />
              Agent Projects
            </h2>
            <button
              onClick={() => setShowCreateModal(true)}
              className="p-1.5 hover:bg-white/10 rounded-lg transition text-gray-400 hover:text-emerald-400"
              title="New Project"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Project List */}
        <div className="flex-1 overflow-y-auto">
          {isLoading && projects.length === 0 && (
            <div className="p-4 text-center text-gray-500 text-sm">
              <Loader className="w-5 h-5 animate-spin mx-auto mb-2" />
              Loading projects...
            </div>
          )}

          {!isLoading && projects.length === 0 && (
            <div className="p-6 text-center">
              <FolderOpen className="w-10 h-10 text-gray-600 mx-auto mb-3" />
              <p className="text-sm text-gray-500 mb-3">No projects yet</p>
              <button
                onClick={() => setShowCreateModal(true)}
                className="px-4 py-2 bg-emerald-500/20 text-emerald-400 rounded-lg text-sm hover:bg-emerald-500/30 transition"
              >
                Create First Project
              </button>
            </div>
          )}

          {projects.map(project => (
            <div
              key={project.id}
              onClick={() => setActiveProjectId(project.id)}
              className={`relative px-4 py-3 cursor-pointer transition border-b border-white/5 hover:bg-white/5 ${
                activeProjectId === project.id ? 'bg-white/10 border-l-2 border-l-emerald-400' : ''
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">
                    {project.name}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-gray-500">
                      {project.active_task_count || 0} active tasks
                    </span>
                    {project.git_repo_initialized && (
                      <GitBranch className="w-3 h-3 text-gray-600" />
                    )}
                  </div>
                </div>

                {/* Project menu */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowProjectMenu(showProjectMenu === project.id ? null : project.id);
                  }}
                  className="p-1 hover:bg-white/10 rounded transition"
                >
                  <MoreVertical className="w-3.5 h-3.5 text-gray-500" />
                </button>
              </div>

              {/* Dropdown menu */}
              <AnimatePresence>
                {showProjectMenu === project.id && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="absolute right-2 top-10 z-10 bg-gray-800 border border-white/20 rounded-lg shadow-xl py-1 min-w-[140px]"
                  >
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteProject(project.id); }}
                      className="w-full px-3 py-2 text-left text-xs text-red-400 hover:bg-red-500/10 transition flex items-center gap-2"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete Project
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {activeProject ? (
          <>
            {/* Project Header */}
            <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between bg-gray-900/30">
              <div>
                <h1 className="text-lg font-semibold text-white">{activeProject.name}</h1>
                {activeProject.description && (
                  <p className="text-sm text-gray-500 mt-0.5">{activeProject.description}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className={`px-2 py-1 rounded text-xs ${
                  activeProject.agent_enabled
                    ? 'bg-emerald-500/10 text-emerald-400'
                    : 'bg-gray-500/10 text-gray-400'
                }`}>
                  <Activity className="w-3 h-3 inline mr-1" />
                  {activeProject.agent_enabled ? 'Agent Active' : 'Agent Paused'}
                </span>
              </div>
            </div>

            {/* Messages + Tasks Split */}
            <div className="flex-1 flex overflow-hidden">
              {/* Chat Area */}
              <div className="flex-1 flex flex-col">
                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
                  {messages.length === 0 && (
                    <div className="text-center py-12">
                      <Sparkles className="w-12 h-12 text-gray-700 mx-auto mb-4" />
                      <p className="text-gray-500 mb-2">Send a message to start</p>
                      <p className="text-sm text-gray-600">
                        The agent will analyze your request, create tasks, and execute them.
                      </p>
                    </div>
                  )}

                  {messages.map(msg => (
                    <div
                      key={msg.id}
                      className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div className={`max-w-[80%] rounded-xl px-4 py-3 ${
                        msg.role === 'user'
                          ? 'bg-emerald-500/20 text-emerald-100'
                          : msg.role === 'system'
                          ? 'bg-yellow-500/10 text-yellow-300 text-xs'
                          : 'bg-gray-800/50 text-gray-200'
                      }`}>
                        {msg.channel !== 'chat' && (
                          <div className="flex items-center gap-1.5 mb-1.5">
                            {msg.channel === 'email' && <Mail className="w-3 h-3 text-blue-400" />}
                            {msg.channel === 'document' && <FileText className="w-3 h-3 text-purple-400" />}
                            <span className="text-xs text-gray-500">{msg.channel}</span>
                          </div>
                        )}
                        <div className="text-sm whitespace-pre-wrap">
                          <MarkdownRenderer content={msg.content} />
                        </div>
                        <span className="text-xs text-gray-500 mt-1 block">
                          {new Date(msg.created_at).toLocaleTimeString()}
                        </span>
                      </div>
                    </div>
                  ))}

                  {/* Sending indicator */}
                  {isSending && (
                    <div className="flex justify-start">
                      <div className="bg-gray-800/50 rounded-xl px-4 py-3 flex items-center gap-2">
                        <Loader className="w-4 h-4 text-emerald-400 animate-spin" />
                        <span className="text-sm text-gray-400">Agent is thinking...</span>
                      </div>
                    </div>
                  )}

                  <div ref={messagesEndRef} />
                </div>

                {/* Input */}
                <div className="px-6 py-4 border-t border-white/10 bg-gray-900/30">
                  {error && (
                    <div className="mb-3 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg">
                      <p className="text-xs text-red-400">{error}</p>
                      <button onClick={() => setError(null)} className="text-xs text-red-500 underline mt-1">
                        Dismiss
                      </button>
                    </div>
                  )}
                  <div className="flex items-end gap-3">
                    {/* File upload */}
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="p-2.5 hover:bg-white/10 rounded-xl transition text-gray-400 hover:text-white"
                      title="Upload document"
                    >
                      <Upload className="w-5 h-5" />
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden"
                      onChange={handleFileUpload}
                      accept=".pdf,.doc,.docx,.txt,.csv,.xlsx,.md"
                    />

                    {/* Message input */}
                    <div className="flex-1">
                      <textarea
                        value={inputMessage}
                        onChange={(e) => setInputMessage(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Message the project agent..."
                        rows={1}
                        className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition resize-none"
                        disabled={isSending}
                      />
                    </div>

                    {/* Send */}
                    <button
                      onClick={handleSendMessage}
                      disabled={!inputMessage.trim() || isSending}
                      className="p-2.5 bg-emerald-500 rounded-xl text-white hover:bg-emerald-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isSending ? (
                        <Loader className="w-5 h-5 animate-spin" />
                      ) : (
                        <Send className="w-5 h-5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {/* Right Panel: Tasks */}
              <div className="w-80 border-l border-white/10 overflow-y-auto bg-gray-900/20">
                <div className="p-4">
                  <TaskPanel
                    tasks={tasks}
                    cotProgress={cotProgress}
                    onApproveTask={(taskId) => updateTask(activeProjectId!, taskId, 'in_progress')}
                    onCancelTask={(taskId) => updateTask(activeProjectId!, taskId, 'cancelled')}
                  />
                </div>
              </div>
            </div>
          </>
        ) : (
          /* No project selected */
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <Sparkles className="w-16 h-16 text-gray-700 mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-gray-400 mb-2">
                Project Agent
              </h2>
              <p className="text-sm text-gray-600 mb-6 max-w-md">
                Select a project from the sidebar or create a new one.
                Each project has an AI agent that plans and executes tasks
                using Chain of Thought reasoning.
              </p>
              <button
                onClick={() => setShowCreateModal(true)}
                className="px-6 py-3 bg-gradient-to-r from-emerald-500 to-teal-600 rounded-xl font-medium text-white hover:from-emerald-600 hover:to-teal-700 transition shadow-lg flex items-center gap-2 mx-auto"
              >
                <Plus className="w-5 h-5" />
                Create New Project
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Create Project Modal */}
      <AnimatePresence>
        {showCreateModal && (
          <CreateAgentProjectModal
            isOpen={showCreateModal}
            onClose={() => setShowCreateModal(false)}
            onCreate={createProject}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
