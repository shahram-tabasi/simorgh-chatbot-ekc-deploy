/**
 * SessionChatItem Component
 * =========================
 * Displays a chat session item with type indicators (General/Project)
 * and stage badges for project sessions.
 */

import React from 'react';
import { motion } from 'framer-motion';
import {
  MessageSquare,
  Globe,
  FolderOpen,
  FileText,
  Clock,
  Wrench,
} from 'lucide-react';
import { ChatSession, SessionStage } from '../types';
import { StageBadge } from './SessionStageSelector';
import { Tooltip } from './Tooltip';

interface SessionChatItemProps {
  session: ChatSession;
  isActive: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  showTypeIndicator?: boolean;
  showStage?: boolean;
  showMeta?: boolean;
}

export default function SessionChatItem({
  session,
  isActive,
  onClick,
  onContextMenu,
  showTypeIndicator = true,
  showStage = true,
  showMeta = false,
}: SessionChatItemProps) {
  const isGeneralSession = session.chatType === 'general';

  const getSessionIcon = () => {
    if (isGeneralSession) {
      return <Globe className="w-4 h-4 text-blue-400" />;
    }
    return <FolderOpen className="w-4 h-4 text-purple-400" />;
  };

  const getSessionTitle = () => {
    return session.title || `Chat ${session.id.slice(0, 8)}`;
  };

  const formatDate = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <motion.button
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`w-full text-left p-3 rounded-xl transition group ${
        isActive
          ? isGeneralSession
            ? 'bg-blue-500/20 border border-blue-500/30'
            : 'bg-purple-500/20 border border-purple-500/30'
          : 'bg-white/5 border border-transparent hover:bg-white/10 hover:border-white/10'
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Type Icon */}
        {showTypeIndicator && (
          <div
            className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
              isGeneralSession ? 'bg-blue-500/20' : 'bg-purple-500/20'
            }`}
          >
            {getSessionIcon()}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Title Row */}
          <div className="flex items-center gap-2">
            <span
              className={`font-medium truncate ${
                isActive ? 'text-white' : 'text-gray-200'
              }`}
            >
              {getSessionTitle()}
            </span>
          </div>

          {/* Meta Row */}
          <div className="flex items-center gap-2 mt-1">
            {/* Session Type Label */}
            {showTypeIndicator && (
              <span
                className={`text-xs ${
                  isGeneralSession ? 'text-blue-400' : 'text-purple-400'
                }`}
              >
                {isGeneralSession ? 'General' : 'Project'}
              </span>
            )}

            {/* Stage Badge for Project Sessions */}
            {!isGeneralSession && showStage && session.stage && (
              <StageBadge stage={session.stage} size="small" />
            )}

            {/* Project Name */}
            {!isGeneralSession && session.projectName && (
              <Tooltip content={session.projectName}>
                <span className="text-xs text-gray-500 truncate max-w-[100px]">
                  {session.projectNumber || session.projectName}
                </span>
              </Tooltip>
            )}
          </div>

          {/* Extended Meta */}
          {showMeta && (
            <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
              {/* History Count */}
              {session.historyCount > 0 && (
                <span className="flex items-center gap-1">
                  <MessageSquare className="w-3 h-3" />
                  {session.historyCount}
                </span>
              )}

              {/* Documents Count */}
              {session.documentsCount > 0 && (
                <span className="flex items-center gap-1">
                  <FileText className="w-3 h-3" />
                  {session.documentsCount}
                </span>
              )}

              {/* Tools Available */}
              {session.allowsExternalTools && (
                <span className="flex items-center gap-1 text-green-500">
                  <Wrench className="w-3 h-3" />
                  Tools
                </span>
              )}

              {/* Updated Time */}
              {session.updatedAt && (
                <span className="flex items-center gap-1 ml-auto">
                  <Clock className="w-3 h-3" />
                  {formatDate(new Date(session.updatedAt))}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Right Indicator */}
        {isActive && (
          <div
            className={`w-1.5 h-8 rounded-full ${
              isGeneralSession ? 'bg-blue-500' : 'bg-purple-500'
            }`}
          />
        )}
      </div>
    </motion.button>
  );
}

/**
 * Session List Component
 * Renders a list of sessions with proper grouping
 */
interface SessionListProps {
  sessions: ChatSession[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onSessionContextMenu?: (e: React.MouseEvent, session: ChatSession) => void;
  groupByType?: boolean;
  emptyMessage?: string;
}

export function SessionList({
  sessions,
  activeSessionId,
  onSelectSession,
  onSessionContextMenu,
  groupByType = true,
  emptyMessage = 'No sessions yet',
}: SessionListProps) {
  if (sessions.length === 0) {
    return (
      <div className="p-8 text-center text-gray-500">
        <MessageSquare className="w-12 h-12 mx-auto mb-3 opacity-50" />
        <p>{emptyMessage}</p>
      </div>
    );
  }

  if (!groupByType) {
    return (
      <div className="space-y-2">
        {sessions.map((session) => (
          <SessionChatItem
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            onClick={() => onSelectSession(session.id)}
            onContextMenu={
              onSessionContextMenu
                ? (e) => onSessionContextMenu(e, session)
                : undefined
            }
            showMeta
          />
        ))}
      </div>
    );
  }

  // Group by type
  const generalSessions = sessions.filter((s) => s.chatType === 'general');
  const projectSessions = sessions.filter((s) => s.chatType === 'project');

  // Group project sessions by project
  const projectGroups = projectSessions.reduce((acc, session) => {
    const key = session.projectNumber || session.projectId || 'unknown';
    if (!acc[key]) {
      acc[key] = {
        projectNumber: session.projectNumber,
        projectName: session.projectName,
        sessions: [],
      };
    }
    acc[key].sessions.push(session);
    return acc;
  }, {} as Record<string, { projectNumber?: string; projectName?: string; sessions: ChatSession[] }>);

  return (
    <div className="space-y-6">
      {/* General Sessions */}
      {generalSessions.length > 0 && (
        <div>
          <div className="flex items-center gap-2 px-2 mb-2">
            <Globe className="w-4 h-4 text-blue-400" />
            <span className="text-sm font-semibold text-gray-400">
              General Sessions
            </span>
            <span className="text-xs text-gray-500">({generalSessions.length})</span>
          </div>
          <div className="space-y-2">
            {generalSessions.map((session) => (
              <SessionChatItem
                key={session.id}
                session={session}
                isActive={session.id === activeSessionId}
                onClick={() => onSelectSession(session.id)}
                onContextMenu={
                  onSessionContextMenu
                    ? (e) => onSessionContextMenu(e, session)
                    : undefined
                }
                showTypeIndicator={false}
              />
            ))}
          </div>
        </div>
      )}

      {/* Project Sessions (grouped by project) */}
      {Object.entries(projectGroups).length > 0 && (
        <div>
          <div className="flex items-center gap-2 px-2 mb-2">
            <FolderOpen className="w-4 h-4 text-purple-400" />
            <span className="text-sm font-semibold text-gray-400">
              Project Sessions
            </span>
            <span className="text-xs text-gray-500">({projectSessions.length})</span>
          </div>
          <div className="space-y-4">
            {Object.entries(projectGroups).map(([projectKey, group]) => (
              <div key={projectKey}>
                <div className="px-2 py-1 mb-2 text-xs font-medium text-purple-400">
                  {group.projectName || group.projectNumber || projectKey}
                </div>
                <div className="space-y-2 ml-2 border-l-2 border-purple-500/20 pl-3">
                  {group.sessions.map((session) => (
                    <SessionChatItem
                      key={session.id}
                      session={session}
                      isActive={session.id === activeSessionId}
                      onClick={() => onSelectSession(session.id)}
                      onContextMenu={
                        onSessionContextMenu
                          ? (e) => onSessionContextMenu(e, session)
                          : undefined
                      }
                      showTypeIndicator={false}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
