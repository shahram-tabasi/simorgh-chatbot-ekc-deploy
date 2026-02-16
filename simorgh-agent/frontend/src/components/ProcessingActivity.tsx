/**
 * ProcessingActivity Component
 * =============================
 * Shows a clean, collapsible activity indicator during message processing.
 * Replaces the ugly typing dots with meaningful task descriptions.
 *
 * Each processing step shows:
 * - An icon for the activity type
 * - A title describing what's happening
 * - A collapsible detail section
 */

import React, { useState, useEffect } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileSearch,
  Search,
  Database,
  Sparkles,
  Wrench,
  FileEdit,
  Brain,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
} from 'lucide-react';
import type { ProcessingStep } from '../types';

interface ProcessingActivityProps {
  steps: ProcessingStep[];
  title?: string;
  isComplete?: boolean;
}

const STEP_ICONS: Record<ProcessingStep['type'], React.FC<{ className?: string }>> = {
  reading: FileSearch,
  searching: Search,
  indexing: Database,
  generating: Sparkles,
  tool: Wrench,
  editing: FileEdit,
  analyzing: Brain,
};

const STEP_COLORS: Record<ProcessingStep['status'], string> = {
  pending: 'text-gray-500',
  active: 'text-blue-400',
  completed: 'text-emerald-400',
  failed: 'text-red-400',
};

function StatusIcon({ status }: { status: ProcessingStep['status'] }) {
  switch (status) {
    case 'active':
      return <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />;
    case 'completed':
      return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
    case 'failed':
      return <XCircle className="w-3.5 h-3.5 text-red-400" />;
    default:
      return <Clock className="w-3.5 h-3.5 text-gray-500" />;
  }
}

export function ProcessingActivity({ steps, title, isComplete }: ProcessingActivityProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const activeStep = steps.find((s) => s.status === 'active');
  const completedCount = steps.filter((s) => s.status === 'completed').length;

  // Auto-expand when there's activity
  useEffect(() => {
    if (activeStep && !isComplete) {
      // Don't auto-expand - let user control it
    }
  }, [activeStep, isComplete]);

  const currentLabel = activeStep?.label || (isComplete ? 'Done' : 'Processing...');

  return (
    <div className="flex gap-2 sm:gap-3 items-start mb-2">
      {/* AI Avatar */}
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center">
        <Sparkles className="w-4 h-4 text-white" />
      </div>

      <div className="flex-1 min-w-0 max-w-xl">
        {/* Main activity bar - clickable to expand */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/8 transition-colors text-left group"
        >
          {/* Spinning or static icon */}
          {!isComplete ? (
            <Loader2 className="w-4 h-4 text-blue-400 animate-spin flex-shrink-0" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          )}

          {/* Current activity title */}
          <span className="flex-1 text-sm text-gray-300 truncate">
            {title || currentLabel}
          </span>

          {/* Step counter */}
          {steps.length > 1 && (
            <span className="text-xs text-gray-500 flex-shrink-0">
              {completedCount}/{steps.length}
            </span>
          )}

          {/* Expand chevron */}
          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-gray-500 flex-shrink-0 group-hover:text-gray-400" />
          )}
        </button>

        {/* Expanded step list */}
        {isExpanded && (
          <div className="mt-1 ml-1 space-y-0.5 overflow-hidden">
            {steps.map((step) => {
              const Icon = STEP_ICONS[step.type] || Wrench;
              const colorClass = STEP_COLORS[step.status];

              return (
                <div
                  key={step.id}
                  className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-white/5 transition-colors"
                >
                  <StatusIcon status={step.status} />
                  <Icon className={`w-3.5 h-3.5 ${colorClass} flex-shrink-0`} />
                  <span className={`text-xs ${colorClass} truncate`}>
                    {step.label}
                  </span>
                  {step.detail && step.status === 'active' && (
                    <span className="text-xs text-gray-600 truncate ml-auto">
                      {step.detail}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Generate processing steps based on message context.
 * Call this when starting to process a message.
 */
export function generateProcessingSteps(hasFiles: boolean, hasDocuments?: boolean): ProcessingStep[] {
  const steps: ProcessingStep[] = [];
  let id = 0;

  if (hasFiles) {
    steps.push({
      id: `step-${id++}`,
      label: 'Processing uploaded document',
      type: 'reading',
      status: 'pending',
    });
    steps.push({
      id: `step-${id++}`,
      label: 'Converting to searchable format',
      type: 'indexing',
      status: 'pending',
    });
  }

  if (hasDocuments || hasFiles) {
    steps.push({
      id: `step-${id++}`,
      label: 'Searching document content',
      type: 'searching',
      status: 'pending',
    });
  }

  steps.push({
    id: `step-${id++}`,
    label: 'Building context',
    type: 'analyzing',
    status: 'pending',
  });

  steps.push({
    id: `step-${id++}`,
    label: 'Generating response',
    type: 'generating',
    status: 'pending',
  });

  return steps;
}

/**
 * Progress the steps forward based on elapsed time.
 * Returns a new copy of steps with updated statuses.
 */
export function progressSteps(
  steps: ProcessingStep[],
  elapsedMs: number,
  isResponseStarted: boolean,
  isComplete: boolean
): ProcessingStep[] {
  const totalSteps = steps.length;
  if (totalSteps === 0) return steps;

  // If complete, mark all as completed
  if (isComplete) {
    return steps.map((s) => ({ ...s, status: 'completed' as const }));
  }

  // If response started streaming, mark all but last as completed, last as active
  if (isResponseStarted) {
    return steps.map((s, i) => ({
      ...s,
      status: i < totalSteps - 1 ? ('completed' as const) : ('active' as const),
    }));
  }

  // Time-based progression for the intermediate steps
  const stepDuration = Math.max(800, 2000 / totalSteps); // ~0.8-2s per step
  const currentStepIndex = Math.min(
    Math.floor(elapsedMs / stepDuration),
    totalSteps - 2 // Don't auto-complete the last step
  );

  return steps.map((s, i) => ({
    ...s,
    status:
      i < currentStepIndex
        ? ('completed' as const)
        : i === currentStepIndex
        ? ('active' as const)
        : ('pending' as const),
  }));
}
