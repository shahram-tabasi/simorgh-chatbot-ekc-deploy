/**
 * SessionStageSelector Component
 * ==============================
 * Displays the current project session stage and allows stage changes.
 * Shows visual indicators for tool availability per stage.
 */

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronDown,
  ChevronRight,
  Globe,
  Lock,
  Search,
  Code,
  FileSearch,
  CheckCircle,
  Settings,
} from 'lucide-react';
import { SessionStage } from '../types';
import { getStageDisplayName, getStageColor } from '../services/chatbotV2Api';

interface SessionStageSelectorProps {
  currentStage: SessionStage;
  onStageChange: (stage: SessionStage) => Promise<boolean>;
  isLoading?: boolean;
  disabled?: boolean;
  compact?: boolean;
}

interface StageInfo {
  value: SessionStage;
  label: string;
  description: string;
  icon: React.ReactNode;
  color: string;
  allowsTools: boolean;
}

const STAGES: StageInfo[] = [
  {
    value: 'analysis',
    label: 'Analysis',
    description: 'Gather information, use external tools',
    icon: <Search className="w-4 h-4" />,
    color: '#3B82F6', // blue
    allowsTools: true,
  },
  {
    value: 'design',
    label: 'Design',
    description: 'Design solutions using project knowledge',
    icon: <FileSearch className="w-4 h-4" />,
    color: '#8B5CF6', // purple
    allowsTools: false,
  },
  {
    value: 'implementation',
    label: 'Implementation',
    description: 'Implement based on project context',
    icon: <Code className="w-4 h-4" />,
    color: '#10B981', // green
    allowsTools: false,
  },
  {
    value: 'review',
    label: 'Review',
    description: 'Review and validate work',
    icon: <CheckCircle className="w-4 h-4" />,
    color: '#F59E0B', // amber
    allowsTools: false,
  },
];

export default function SessionStageSelector({
  currentStage,
  onStageChange,
  isLoading = false,
  disabled = false,
  compact = false,
}: SessionStageSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [changingStage, setChangingStage] = useState(false);

  const currentStageInfo = STAGES.find((s) => s.value === currentStage) || STAGES[0];

  const handleStageSelect = async (stage: SessionStage) => {
    if (stage === currentStage || disabled || isLoading) {
      setIsOpen(false);
      return;
    }

    setChangingStage(true);
    try {
      const success = await onStageChange(stage);
      if (success) {
        setIsOpen(false);
      }
    } finally {
      setChangingStage(false);
    }
  };

  if (compact) {
    return (
      <div className="relative">
        <button
          onClick={() => setIsOpen(!isOpen)}
          disabled={disabled || isLoading}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition ${
            disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-white/10'
          }`}
          style={{ color: currentStageInfo.color }}
        >
          {currentStageInfo.icon}
          <span>{currentStageInfo.label}</span>
          <ChevronDown
            className={`w-3 h-3 transition ${isOpen ? 'rotate-180' : ''}`}
          />
        </button>

        <AnimatePresence>
          {isOpen && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="absolute top-full left-0 mt-1 bg-gray-900 border border-white/10 rounded-lg shadow-xl z-50 min-w-[200px]"
            >
              {STAGES.map((stage) => (
                <button
                  key={stage.value}
                  onClick={() => handleStageSelect(stage.value)}
                  disabled={changingStage}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition ${
                    stage.value === currentStage
                      ? 'bg-white/10'
                      : 'hover:bg-white/5'
                  } ${changingStage ? 'opacity-50' : ''}`}
                  style={{ color: stage.color }}
                >
                  {stage.icon}
                  <span>{stage.label}</span>
                  {stage.allowsTools && (
                    <Globe className="w-3 h-3 ml-auto opacity-50" />
                  )}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Current Stage Display */}
      <div
        className="flex items-center justify-between p-4 rounded-xl border"
        style={{
          backgroundColor: `${currentStageInfo.color}10`,
          borderColor: `${currentStageInfo.color}30`,
        }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center"
            style={{ backgroundColor: `${currentStageInfo.color}20` }}
          >
            <span style={{ color: currentStageInfo.color }}>{currentStageInfo.icon}</span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-white">{currentStageInfo.label}</span>
              {currentStageInfo.allowsTools ? (
                <span className="flex items-center gap-1 px-2 py-0.5 bg-blue-500/20 text-blue-400 text-xs rounded-full">
                  <Globe className="w-3 h-3" />
                  Tools Enabled
                </span>
              ) : (
                <span className="flex items-center gap-1 px-2 py-0.5 bg-gray-500/20 text-gray-400 text-xs rounded-full">
                  <Lock className="w-3 h-3" />
                  Project Only
                </span>
              )}
            </div>
            <p className="text-sm text-gray-400 mt-0.5">{currentStageInfo.description}</p>
          </div>
        </div>

        <button
          onClick={() => setIsOpen(!isOpen)}
          disabled={disabled || isLoading}
          className={`p-2 rounded-lg transition ${
            disabled
              ? 'opacity-50 cursor-not-allowed'
              : 'hover:bg-white/10 text-gray-400 hover:text-white'
          }`}
        >
          <Settings className="w-5 h-5" />
        </button>
      </div>

      {/* Stage Selector Dropdown */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="grid grid-cols-2 gap-2 p-4 bg-white/5 border border-white/10 rounded-xl">
              {STAGES.map((stage) => (
                <button
                  key={stage.value}
                  onClick={() => handleStageSelect(stage.value)}
                  disabled={changingStage || disabled}
                  className={`p-3 rounded-xl border text-left transition ${
                    stage.value === currentStage
                      ? 'border-2'
                      : 'border border-white/10 hover:bg-white/5'
                  } ${changingStage ? 'opacity-50' : ''}`}
                  style={{
                    borderColor:
                      stage.value === currentStage ? stage.color : undefined,
                    backgroundColor:
                      stage.value === currentStage ? `${stage.color}10` : undefined,
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span style={{ color: stage.color }}>{stage.icon}</span>
                    <span
                      className={`font-medium ${
                        stage.value === currentStage ? 'text-white' : 'text-gray-300'
                      }`}
                    >
                      {stage.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 mt-2">
                    {stage.allowsTools ? (
                      <span className="text-xs text-blue-400 flex items-center gap-1">
                        <Globe className="w-3 h-3" />
                        External tools
                      </span>
                    ) : (
                      <span className="text-xs text-gray-500 flex items-center gap-1">
                        <Lock className="w-3 h-3" />
                        Project only
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Inline Stage Badge
 * Shows a compact stage indicator for use in lists
 */
export function StageBadge({
  stage,
  size = 'default',
}: {
  stage: SessionStage;
  size?: 'small' | 'default';
}) {
  const stageInfo = STAGES.find((s) => s.value === stage) || STAGES[0];

  if (size === 'small') {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium"
        style={{
          backgroundColor: `${stageInfo.color}20`,
          color: stageInfo.color,
        }}
      >
        {stageInfo.icon}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium"
      style={{
        backgroundColor: `${stageInfo.color}20`,
        color: stageInfo.color,
      }}
    >
      {stageInfo.icon}
      <span>{stageInfo.label}</span>
    </span>
  );
}

/**
 * Stage Progress Indicator
 * Shows progress through all stages
 */
export function StageProgress({
  currentStage,
  size = 'default',
}: {
  currentStage: SessionStage;
  size?: 'small' | 'default';
}) {
  const currentIndex = STAGES.findIndex((s) => s.value === currentStage);

  return (
    <div className="flex items-center gap-1">
      {STAGES.map((stage, index) => {
        const isActive = index === currentIndex;
        const isPast = index < currentIndex;

        return (
          <React.Fragment key={stage.value}>
            <div
              className={`rounded-full transition ${
                size === 'small' ? 'w-2 h-2' : 'w-3 h-3'
              }`}
              style={{
                backgroundColor: isActive || isPast ? stage.color : '#374151',
                boxShadow: isActive ? `0 0 8px ${stage.color}` : undefined,
              }}
              title={stage.label}
            />
            {index < STAGES.length - 1 && (
              <div
                className={`transition ${
                  size === 'small' ? 'w-3 h-0.5' : 'w-6 h-1'
                }`}
                style={{
                  backgroundColor: isPast ? stage.color : '#374151',
                }}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
