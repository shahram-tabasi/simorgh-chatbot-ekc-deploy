/**
 * AgentTaskStream Component
 * =========================
 * Claude Code-style agent task display with collapsible task groups.
 * Shows a main plan with tasks, each task has sub-tasks (tool calls)
 * displayed as collapsible dropdown sections.
 *
 * Matches Claude Code's look:
 * - Main todo list of tasks
 * - Each task: clickable header with status icon
 * - Expanded: shows sub-tasks with tool icons and details
 * - Real-time status updates (spinning, checkmark, error)
 */

import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Loader2,
  XCircle,
  Clock,
  Server,
  Database,
  Search,
  History,
  Brain,
  GitBranch,
  ListChecks,
} from 'lucide-react';
import type { AgentPlan, AgentTaskGroup, AgentSubtask } from '../types';

interface AgentTaskStreamProps {
  plan: AgentPlan;
  isComplete?: boolean;
}

// Tool icon mapping
const TOOL_ICONS: Record<string, React.FC<{ className?: string }>> = {
  server: Server,
  qdrant: Search,
  neo4j: GitBranch,
  redis: History,
  llm: Brain,
  default: Database,
};

function getToolIcon(tool?: string): React.FC<{ className?: string }> {
  if (!tool) return TOOL_ICONS.default;
  return TOOL_ICONS[tool] || TOOL_ICONS.default;
}

// Status indicator component
function StatusIcon({ status, size = 'sm' }: { status: string; size?: 'sm' | 'md' }) {
  const sizeClass = size === 'md' ? 'w-4 h-4' : 'w-3.5 h-3.5';

  switch (status) {
    case 'active':
      return <Loader2 className={`${sizeClass} text-blue-400 animate-spin`} />;
    case 'completed':
      return <CheckCircle2 className={`${sizeClass} text-emerald-400`} />;
    case 'failed':
      return <XCircle className={`${sizeClass} text-red-400`} />;
    default:
      return <Clock className={`${sizeClass} text-gray-500`} />;
  }
}

// Individual subtask row
function SubtaskRow({ subtask }: { subtask: AgentSubtask }) {
  const ToolIcon = getToolIcon(subtask.tool);
  const statusColor =
    subtask.status === 'active'
      ? 'text-blue-400'
      : subtask.status === 'completed'
      ? 'text-gray-300'
      : subtask.status === 'failed'
      ? 'text-red-400'
      : 'text-gray-500';

  return (
    <div className="flex items-center gap-2 py-1 px-3 ml-6 text-xs">
      <StatusIcon status={subtask.status} />
      <ToolIcon className={`w-3 h-3 flex-shrink-0 ${statusColor}`} />
      <span className={`${statusColor} truncate`}>
        {subtask.title}
      </span>
      {subtask.detail && subtask.status === 'completed' && (
        <span className="text-gray-500 ml-auto flex-shrink-0 text-[11px]">
          {subtask.detail}
        </span>
      )}
      {subtask.detail && subtask.status === 'failed' && (
        <span className="text-red-400/70 ml-auto flex-shrink-0 text-[11px]">
          {subtask.detail}
        </span>
      )}
    </div>
  );
}

// Task group with collapsible subtasks
function TaskGroupRow({ group, defaultExpanded }: { group: AgentTaskGroup; defaultExpanded: boolean }) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const hasSubtasks = group.subtasks.length > 0;
  const completedCount = group.subtasks.filter((s) => s.status === 'completed').length;
  const totalCount = group.subtasks.length;

  const titleColor =
    group.status === 'active'
      ? 'text-white'
      : group.status === 'completed'
      ? 'text-gray-300'
      : group.status === 'failed'
      ? 'text-red-400'
      : 'text-gray-400';

  return (
    <div className="border-b border-white/5 last:border-b-0">
      {/* Task header - clickable */}
      <button
        onClick={() => hasSubtasks && setIsExpanded(!isExpanded)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${
          hasSubtasks ? 'hover:bg-white/5 cursor-pointer' : 'cursor-default'
        }`}
      >
        {/* Expand/collapse chevron */}
        {hasSubtasks ? (
          isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
          )
        ) : (
          <span className="w-3.5" />
        )}

        {/* Status icon */}
        <StatusIcon status={group.status} size="md" />

        {/* Task title */}
        <span className={`flex-1 text-sm font-medium ${titleColor} truncate`}>
          {group.title}
        </span>

        {/* Subtask counter */}
        {hasSubtasks && group.status !== 'pending' && (
          <span className="text-xs text-gray-500 flex-shrink-0">
            {completedCount}/{totalCount}
          </span>
        )}
      </button>

      {/* Expanded subtask list */}
      <AnimatePresence>
        {isExpanded && hasSubtasks && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="pb-2">
              {group.subtasks.map((subtask) => (
                <SubtaskRow key={subtask.id} subtask={subtask} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function AgentTaskStream({ plan, isComplete }: AgentTaskStreamProps) {
  // Compute stats
  const stats = useMemo(() => {
    const total = plan.tasks.length;
    const completed = plan.tasks.filter((t) => t.status === 'completed').length;
    const failed = plan.tasks.filter((t) => t.status === 'failed').length;
    const active = plan.tasks.filter((t) => t.status === 'active').length;
    return { total, completed, failed, active };
  }, [plan]);

  // Determine which task group to expand by default (the active one, or last completed if all done)
  const activeTaskId = plan.tasks.find((t) => t.status === 'active')?.id;
  const allDone = isComplete || (stats.active === 0 && stats.completed === stats.total && stats.total > 0);

  // Don't render if no tasks
  if (plan.tasks.length === 0) return null;

  return (
    <div className="mb-3 rounded-xl border border-white/10 bg-gray-900/60 overflow-hidden max-w-xl">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 bg-white/[0.02]">
        <ListChecks className="w-4 h-4 text-blue-400" />
        <span className="text-xs font-semibold text-gray-300">Agent Tasks</span>
        {stats.total > 0 && (
          <span className="text-[11px] text-gray-500">
            ({stats.completed}/{stats.total})
          </span>
        )}
        {stats.active > 0 && (
          <Loader2 className="w-3 h-3 text-blue-400 animate-spin ml-auto" />
        )}
        {stats.active === 0 && stats.completed === stats.total && stats.total > 0 && (
          <CheckCircle2 className="w-3 h-3 text-emerald-400 ml-auto" />
        )}
      </div>

      {/* Task list */}
      <div className="max-h-64 overflow-y-auto">
        {plan.tasks.map((group) => (
          <TaskGroupRow
            key={group.id}
            group={group}
            defaultExpanded={!allDone && (group.id === activeTaskId || group.status === 'active')}
          />
        ))}
      </div>
    </div>
  );
}
