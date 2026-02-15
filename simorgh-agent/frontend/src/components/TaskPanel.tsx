/**
 * TaskPanel Component
 * ====================
 * Displays COT-generated tasks for the active project.
 * Shows real-time progress as the agent executes tasks.
 */

import React, { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CheckCircle, Clock, Loader, AlertCircle, XCircle,
  ChevronDown, ChevronRight, Zap, Brain, Terminal,
  Mail, FileText, Search, GitCommit, Shield,
} from 'lucide-react';
import type { AgentTask, COTProgress } from '../hooks/useProjectAgent';

interface Props {
  tasks: AgentTask[];
  cotProgress: COTProgress | null;
  onApproveTask?: (taskId: string) => void;
  onCancelTask?: (taskId: string) => void;
}

const TASK_TYPE_ICONS: Record<string, React.ReactNode> = {
  action: <Zap className="w-3.5 h-3.5" />,
  query: <Search className="w-3.5 h-3.5" />,
  analysis: <Brain className="w-3.5 h-3.5" />,
  generation: <FileText className="w-3.5 h-3.5" />,
  review: <Shield className="w-3.5 h-3.5" />,
  shell_command: <Terminal className="w-3.5 h-3.5" />,
  email: <Mail className="w-3.5 h-3.5" />,
};

const STATUS_CONFIG: Record<string, { color: string; bg: string; icon: React.ReactNode }> = {
  pending: {
    color: 'text-gray-400',
    bg: 'bg-gray-500/10',
    icon: <Clock className="w-4 h-4 text-gray-400" />,
  },
  in_progress: {
    color: 'text-blue-400',
    bg: 'bg-blue-500/10',
    icon: <Loader className="w-4 h-4 text-blue-400 animate-spin" />,
  },
  completed: {
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10',
    icon: <CheckCircle className="w-4 h-4 text-emerald-400" />,
  },
  failed: {
    color: 'text-red-400',
    bg: 'bg-red-500/10',
    icon: <AlertCircle className="w-4 h-4 text-red-400" />,
  },
  cancelled: {
    color: 'text-gray-500',
    bg: 'bg-gray-500/10',
    icon: <XCircle className="w-4 h-4 text-gray-500" />,
  },
  waiting_approval: {
    color: 'text-yellow-400',
    bg: 'bg-yellow-500/10',
    icon: <Shield className="w-4 h-4 text-yellow-400" />,
  },
};

export default function TaskPanel({ tasks, cotProgress, onApproveTask, onCancelTask }: Props) {
  const [expandedTasks, setExpandedTasks] = React.useState<Set<string>>(new Set());

  const toggleTask = (taskId: string) => {
    setExpandedTasks(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  // Group tasks by COT chain
  const tasksByChain = useMemo(() => {
    const chains: Record<string, AgentTask[]> = {};
    for (const task of tasks) {
      const chainId = task.project_id; // Group by project for now
      if (!chains[chainId]) chains[chainId] = [];
      chains[chainId].push(task);
    }
    return chains;
  }, [tasks]);

  const stats = useMemo(() => ({
    total: tasks.length,
    pending: tasks.filter(t => t.status === 'pending').length,
    in_progress: tasks.filter(t => t.status === 'in_progress').length,
    completed: tasks.filter(t => t.status === 'completed').length,
    failed: tasks.filter(t => t.status === 'failed').length,
  }), [tasks]);

  if (tasks.length === 0 && !cotProgress) {
    return null;
  }

  return (
    <div className="bg-gray-900/50 border border-white/10 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-emerald-400" />
          <span className="text-sm font-medium text-white">Agent Tasks</span>
          {stats.total > 0 && (
            <span className="text-xs text-gray-500">
              {stats.completed}/{stats.total}
            </span>
          )}
        </div>

        {/* Mini stats */}
        <div className="flex items-center gap-2">
          {stats.in_progress > 0 && (
            <span className="flex items-center gap-1 text-xs text-blue-400">
              <Loader className="w-3 h-3 animate-spin" />
              {stats.in_progress}
            </span>
          )}
          {stats.failed > 0 && (
            <span className="flex items-center gap-1 text-xs text-red-400">
              <AlertCircle className="w-3 h-3" />
              {stats.failed}
            </span>
          )}
        </div>
      </div>

      {/* COT Progress Bar */}
      {cotProgress && cotProgress.status !== 'completed' && (
        <div className="px-4 py-2 bg-blue-500/5 border-b border-white/5">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-blue-400 font-medium">
              {cotProgress.status === 'planning' ? 'Planning...' : 'Executing tasks...'}
            </span>
            <span className="text-xs text-blue-400">
              {Math.round(cotProgress.progress_percent)}%
            </span>
          </div>
          <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-gradient-to-r from-blue-500 to-emerald-500 rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${cotProgress.progress_percent}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>
        </div>
      )}

      {/* Task List */}
      <div className="max-h-80 overflow-y-auto">
        <AnimatePresence initial={false}>
          {tasks.map((task, index) => {
            const config = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending;
            const isExpanded = expandedTasks.has(task.id);
            const typeIcon = TASK_TYPE_ICONS[task.task_type] || TASK_TYPE_ICONS.action;

            return (
              <motion.div
                key={task.id}
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
                className="border-b border-white/5 last:border-b-0"
              >
                {/* Task Row */}
                <button
                  onClick={() => toggleTask(task.id)}
                  className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-white/5 transition text-left"
                >
                  {/* Status Icon */}
                  {config.icon}

                  {/* Task Type Icon */}
                  <span className="text-gray-500">{typeIcon}</span>

                  {/* Title */}
                  <span className={`flex-1 text-sm truncate ${config.color}`}>
                    {task.title}
                  </span>

                  {/* Sort order */}
                  <span className="text-xs text-gray-600">#{task.sort_order}</span>

                  {/* Expand arrow */}
                  {isExpanded ? (
                    <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-gray-500" />
                  )}
                </button>

                {/* Expanded Details */}
                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="px-4 pb-3 pl-11 space-y-2">
                        {task.description && (
                          <p className="text-xs text-gray-500">{task.description}</p>
                        )}

                        <div className="flex flex-wrap gap-2">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${config.bg} ${config.color}`}>
                            {task.status}
                          </span>
                          {task.tool_used && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-purple-500/10 text-purple-400">
                              {task.tool_used}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-gray-500/10 text-gray-400">
                            {task.task_type}
                          </span>
                        </div>

                        {/* Result preview */}
                        {task.result && (
                          <div className="bg-gray-800/50 rounded-lg p-2">
                            <p className="text-xs text-gray-400 font-mono whitespace-pre-wrap line-clamp-4">
                              {task.result}
                            </p>
                          </div>
                        )}

                        {/* Error message */}
                        {task.error_message && (
                          <div className="bg-red-500/10 rounded-lg p-2">
                            <p className="text-xs text-red-400">{task.error_message}</p>
                          </div>
                        )}

                        {/* Actions for waiting_approval */}
                        {task.status === 'waiting_approval' && (
                          <div className="flex gap-2 pt-1">
                            {onApproveTask && (
                              <button
                                onClick={() => onApproveTask(task.id)}
                                className="px-3 py-1 text-xs bg-emerald-500/20 text-emerald-400 rounded-lg hover:bg-emerald-500/30 transition"
                              >
                                Approve
                              </button>
                            )}
                            {onCancelTask && (
                              <button
                                onClick={() => onCancelTask(task.id)}
                                className="px-3 py-1 text-xs bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/30 transition"
                              >
                                Cancel
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
