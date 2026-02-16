/**
 * ProjectAgentDashboard
 * ======================
 * Main dashboard for the Project Agent system.
 * Shows project list and chat interface with inline tasks.
 */

import React, { useState, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus, Trash2, FolderOpen, GitBranch, FileText, Mail,
  Terminal, Send, Loader, ChevronLeft, MoreVertical,
  Sparkles, Activity, Settings, Upload, ArrowLeft,
  CheckCircle, Clock, AlertCircle, XCircle, Zap, Brain, Search, Shield,
} from 'lucide-react';
import { useProjectAgent } from '../hooks/useProjectAgent';
import type { AgentMessage, AgentTask } from '../hooks/useProjectAgent';
import CreateAgentProjectModal from '../components/CreateAgentProjectModal';
import { MarkdownRenderer } from '../components/MarkdownRenderer';

interface Props {
  userId: string;
}

// Format timestamp to Tehran timezone HH:MM
function formatTehranTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString('en-US', {
      timeZone: 'Asia/Tehran',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return '';
  }
}

// Task status icons for inline display
const TASK_STATUS_ICON: Record<string, React.ReactNode> = {
  pending: <Clock className="w-3.5 h-3.5 text-gray-400" />,
  in_progress: <Loader className="w-3.5 h-3.5 text-blue-400 animate-spin" />,
  completed: <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />,
  failed: <AlertCircle className="w-3.5 h-3.5 text-red-400" />,
  cancelled: <XCircle className="w-3.5 h-3.5 text-gray-500" />,
  waiting_approval: <Shield className="w-3.5 h-3.5 text-yellow-400" />,
};

const TASK_TYPE_ICON: Record<string, React.ReactNode> = {
  action: <Zap className="w-3 h-3" />,
  query: <Search className="w-3 h-3" />,
  analysis: <Brain className="w-3 h-3" />,
  generation: <FileText className="w-3 h-3" />,
  review: <Shield className="w-3 h-3" />,
  shell_command: <Terminal className="w-3 h-3" />,
  email: <Mail className="w-3 h-3" />,
};

// Timeline item types
type TimelineItem =
  | { type: 'message'; msg: AgentMessage }
  | { type: 'tasks'; tasks: AgentTask[] };

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

  // Build timeline: interleave messages with inline task groups
  const timeline = useMemo((): TimelineItem[] => {
    if (messages.length === 0 && tasks.length === 0) return [];

    const items: TimelineItem[] = [];
    const usedTaskIds = new Set<string>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      items.push({ type: 'message', msg });

      // After a user message, insert relevant tasks before the next assistant message
      if (msg.role === 'user') {
        const msgTime = new Date(msg.created_at).getTime();
        const nextMsg = messages[i + 1];
        const nextTime = nextMsg ? new Date(nextMsg.created_at).getTime() : Date.now() + 60000;

        const relevantTasks = tasks.filter(t => {
          if (usedTaskIds.has(t.id)) return false;
          const taskTime = new Date(t.created_at).getTime();
          // Task was created between this user message and the next message (with 2s buffer)
          return taskTime >= msgTime - 2000 && taskTime <= nextTime + 2000;
        });

        if (relevantTasks.length > 0) {
          relevantTasks.forEach(t => usedTaskIds.add(t.id));
          items.push({ type: 'tasks', tasks: relevantTasks.sort((a, b) => a.sort_order - b.sort_order) });
        }
      }
    }

    // If there are tasks not matched to any message, show them at the end
    const remainingTasks = tasks.filter(t => !usedTaskIds.has(t.id));
    if (remainingTasks.length > 0) {
      items.push({ type: 'tasks', tasks: remainingTasks.sort((a, b) => a.sort_order - b.sort_order) });
    }

    return items;
  }, [messages, tasks]);

  // Scroll to bottom on new messages/tasks
  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, tasks]);

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
      <div className="flex-1 flex flex-col overflow-hidden">
        {activeProject ? (
          <>
            {/* Project Header */}
            <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between bg-gray-900/30 shrink-0">
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

            {/* Chat Area - full width, no right panel */}
            <div className="flex-1 flex flex-col overflow-hidden relative">
              {/* Messages + Inline Tasks */}
              <div className="flex-1 overflow-y-auto px-6 py-4 pb-32 space-y-3">
                {messages.length === 0 && tasks.length === 0 && (
                  <div className="text-center py-12">
                    <Sparkles className="w-12 h-12 text-gray-700 mx-auto mb-4" />
                    <p className="text-gray-500 mb-2">Send a message to start</p>
                    <p className="text-sm text-gray-600">
                      The agent will analyze your request, create tasks, and execute them.
                    </p>
                  </div>
                )}

                {timeline.map((item, idx) => {
                  if (item.type === 'message') {
                    const msg = item.msg;
                    return (
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
                            {formatTehranTime(msg.created_at)}
                          </span>
                        </div>
                      </div>
                    );
                  }

                  if (item.type === 'tasks') {
                    return (
                      <div key={`tasks-${idx}`} className="flex justify-center my-1">
                        <div className="w-full max-w-[90%] bg-gray-800/30 border border-white/5 rounded-lg px-4 py-2.5">
                          <div className="flex items-center gap-2 mb-1.5">
                            <Zap className="w-3.5 h-3.5 text-emerald-400" />
                            <span className="text-xs font-medium text-gray-400">
                              Agent Tasks ({item.tasks.filter(t => t.status === 'completed').length}/{item.tasks.length})
                            </span>
                          </div>
                          <div className="space-y-1">
                            {item.tasks.map(task => (
                              <div key={task.id} className="flex items-center gap-2 py-0.5">
                                {TASK_STATUS_ICON[task.status] || TASK_STATUS_ICON.pending}
                                <span className="text-gray-500">
                                  {TASK_TYPE_ICON[task.task_type] || TASK_TYPE_ICON.action}
                                </span>
                                <span className={`text-xs flex-1 truncate ${
                                  task.status === 'completed' ? 'text-gray-400' :
                                  task.status === 'failed' ? 'text-red-400' :
                                  task.status === 'in_progress' ? 'text-blue-300' :
                                  'text-gray-400'
                                }`}>
                                  {task.title}
                                </span>
                                {task.status === 'waiting_approval' && (
                                  <div className="flex gap-1">
                                    <button
                                      onClick={() => updateTask(activeProjectId!, task.id, 'in_progress')}
                                      className="px-2 py-0.5 text-[10px] bg-emerald-500/20 text-emerald-400 rounded hover:bg-emerald-500/30"
                                    >
                                      Approve
                                    </button>
                                    <button
                                      onClick={() => updateTask(activeProjectId!, task.id, 'cancelled')}
                                      className="px-2 py-0.5 text-[10px] bg-red-500/20 text-red-400 rounded hover:bg-red-500/30"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                          {item.tasks.some(t => t.error_message) && (
                            <div className="mt-1.5 px-2 py-1 bg-red-500/10 rounded text-[10px] text-red-400">
                              {item.tasks.find(t => t.error_message)?.error_message}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  }

                  return null;
                })}

                {/* COT progress indicator */}
                {cotProgress && cotProgress.status !== 'completed' && (
                  <div className="flex justify-center my-1">
                    <div className="w-full max-w-[90%] bg-blue-500/5 border border-blue-500/20 rounded-lg px-4 py-2.5">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-blue-400 font-medium flex items-center gap-2">
                          <Loader className="w-3.5 h-3.5 animate-spin" />
                          {cotProgress.status === 'planning' ? 'Planning...' : 'Executing tasks...'}
                        </span>
                        <span className="text-xs text-blue-400">
                          {Math.round(cotProgress.progress_percent)}%
                        </span>
                      </div>
                      <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                        <motion.div
                          className="h-full bg-gradient-to-r from-blue-500 to-emerald-500 rounded-full"
                          initial={{ width: 0 }}
                          animate={{ width: `${cotProgress.progress_percent}%` }}
                          transition={{ duration: 0.3 }}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* Sending indicator */}
                {isSending && !cotProgress && (
                  <div className="flex justify-start">
                    <div className="bg-gray-800/50 rounded-xl px-4 py-3 flex items-center gap-2">
                      <Loader className="w-4 h-4 text-emerald-400 animate-spin" />
                      <span className="text-sm text-gray-400">Agent is thinking...</span>
                    </div>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>

              {/* Sticky Input - overlay at bottom */}
              <div className="absolute bottom-0 left-0 right-0 px-6 py-4 bg-gray-950/90 backdrop-blur-md border-t border-white/10">
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
