/**
 * SessionTree Component
 * =====================
 * Enhanced tree view for chat sessions supporting both legacy (Project/Chat)
 * and new (General-Session/Project-Session) chat types.
 */

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Folder,
  ChevronDown,
  ChevronRight,
  Plus,
  Sparkles,
  Globe,
  FolderOpen,
  MessageSquare,
  Search,
  MoreVertical,
  Trash2,
  Edit2,
} from 'lucide-react';
import { ChatSession, SessionStage, Project, Chat } from '../types';
import { StageBadge } from './SessionStageSelector';
import { Tooltip } from './Tooltip';
import ContextMenu from './ContextMenu';
import RenameModal from './RenameModal';

interface SessionTreeProps {
  // New session-based data
  sessions?: ChatSession[];
  activeSessionId?: string | null;
  onSelectSession?: (sessionId: string) => void;
  onCreateGeneralSession?: () => void;
  onCreateProjectSession?: () => void;
  onDeleteSession?: (sessionId: string) => Promise<boolean>;

  // Legacy support (optional)
  projects?: Project[];
  generalChats?: Chat[];
  activeProjectId?: string | null;
  activeChatId?: string | null;
  showGeneralChats?: boolean;
  onToggleProject?: (projectId: string) => void;
  onToggleGeneralChats?: () => void;
  onSelectChat?: (projectId: string | null, chatId: string) => void;
  onCreateProject?: () => void;
  onCreateChat?: (projectId: string, title: string) => void;
  onCreateGeneralChat?: () => void;
  onRenameChat?: (chatId: string, newName: string, projectId: string | null) => void;
  onDeleteChat?: (chatId: string, projectId: string | null) => void;
  onDeleteProject?: (projectId: string) => void;

  // Display options
  mode?: 'sessions' | 'legacy' | 'hybrid';
}

export function SessionTree({
  // New session props
  sessions = [],
  activeSessionId,
  onSelectSession,
  onCreateGeneralSession,
  onCreateProjectSession,
  onDeleteSession,

  // Legacy props
  projects = [],
  generalChats = [],
  activeProjectId,
  activeChatId,
  showGeneralChats = true,
  onToggleProject,
  onToggleGeneralChats,
  onSelectChat,
  onCreateProject,
  onCreateChat,
  onCreateGeneralChat,
  onRenameChat,
  onDeleteChat,
  onDeleteProject,

  // Display mode
  mode = 'hybrid',
}: SessionTreeProps) {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    generalSessions: true,
    projectSessions: true,
    legacyGeneral: true,
    legacyProjects: true,
  });

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    type: 'session' | 'chat' | 'project';
    id: string;
    name: string;
    projectId?: string | null;
  } | null>(null);

  const [renameModal, setRenameModal] = useState<{
    id: string;
    name: string;
    type: 'session' | 'chat';
    projectId?: string | null;
  } | null>(null);

  // Group sessions by type
  const generalSessions = sessions.filter((s) => s.chatType === 'general');
  const projectSessions = sessions.filter((s) => s.chatType === 'project');

  // Group project sessions by project number
  const projectSessionGroups = projectSessions.reduce((acc, session) => {
    const key = session.projectNumber || session.projectId || 'unknown';
    if (!acc[key]) {
      acc[key] = {
        projectNumber: session.projectNumber,
        projectName: session.projectName,
        sessions: [],
        expanded: true,
      };
    }
    acc[key].sessions.push(session);
    return acc;
  }, {} as Record<string, { projectNumber?: string; projectName?: string; sessions: ChatSession[]; expanded: boolean }>);

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  const handleContextMenu = (
    e: React.MouseEvent,
    type: 'session' | 'chat' | 'project',
    id: string,
    name: string,
    projectId?: string | null
  ) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, type, id, name, projectId });
  };

  const handleDelete = async () => {
    if (!contextMenu) return;

    if (contextMenu.type === 'session' && onDeleteSession) {
      await onDeleteSession(contextMenu.id);
    } else if (contextMenu.type === 'chat' && onDeleteChat) {
      onDeleteChat(contextMenu.id, contextMenu.projectId || null);
    } else if (contextMenu.type === 'project' && onDeleteProject) {
      onDeleteProject(contextMenu.id);
    }

    setContextMenu(null);
  };

  const handleRename = () => {
    if (!contextMenu) return;

    if (contextMenu.type === 'session' || contextMenu.type === 'chat') {
      setRenameModal({
        id: contextMenu.id,
        name: contextMenu.name,
        type: contextMenu.type,
        projectId: contextMenu.projectId,
      });
    }
    setContextMenu(null);
  };

  const handleRenameSubmit = (newName: string) => {
    if (!renameModal) return;

    if (renameModal.type === 'chat' && onRenameChat) {
      onRenameChat(renameModal.id, newName, renameModal.projectId || null);
    }
    // For sessions, you might want to add a rename API call here

    setRenameModal(null);
  };

  const showSessions = mode === 'sessions' || mode === 'hybrid';
  const showLegacy = mode === 'legacy' || mode === 'hybrid';

  return (
    <div className="h-full flex flex-col text-white">
      {/* Header Actions */}
      <div className="p-4 border-b border-white/10 space-y-2">
        {showSessions && (
          <div className="flex gap-2">
            {onCreateGeneralSession && (
              <button
                onClick={onCreateGeneralSession}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-gradient-to-r from-blue-500 to-cyan-600 hover:from-blue-600 hover:to-cyan-700 text-white text-sm font-semibold transition-all shadow-lg"
              >
                <Globe className="w-4 h-4" />
                General Chat
              </button>
            )}
            {onCreateProjectSession && (
              <button
                onClick={onCreateProjectSession}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-gradient-to-r from-purple-500 to-pink-600 hover:from-purple-600 hover:to-pink-700 text-white text-sm font-semibold transition-all shadow-lg"
              >
                <FolderOpen className="w-4 h-4" />
                Project Chat
              </button>
            )}
          </div>
        )}

        {showLegacy && onCreateProject && (
          <button
            onClick={onCreateProject}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-semibold transition-all shadow-lg"
          >
            <Plus className="w-5 h-5" />
            New Project
          </button>
        )}
      </div>

      {/* Tree Content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-6">
        {/* New Session Types */}
        {showSessions && (
          <>
            {/* General Sessions */}
            {(generalSessions.length > 0 || onCreateGeneralSession) && (
              <div>
                <button
                  onClick={() => toggleSection('generalSessions')}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 transition"
                >
                  {expandedSections.generalSessions ? (
                    <ChevronDown className="w-5 h-5 text-gray-400" />
                  ) : (
                    <ChevronRight className="w-5 h-5 text-gray-400" />
                  )}
                  <Globe className="w-5 h-5 text-blue-400" />
                  <span className="font-semibold">General Sessions</span>
                  <span className="text-xs text-gray-500 ml-1">
                    ({generalSessions.length})
                  </span>
                  {onCreateGeneralSession && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onCreateGeneralSession();
                      }}
                      className="ml-auto p-1.5 hover:bg-white/10 rounded transition"
                    >
                      <Plus className="w-4 h-4 text-gray-400" />
                    </button>
                  )}
                </button>

                <AnimatePresence>
                  {expandedSections.generalSessions && generalSessions.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="ml-8 mt-2 space-y-1"
                    >
                      {generalSessions.map((session) => (
                        <SessionItem
                          key={session.id}
                          session={session}
                          isActive={session.id === activeSessionId}
                          onClick={() => onSelectSession?.(session.id)}
                          onContextMenu={(e) =>
                            handleContextMenu(e, 'session', session.id, session.title)
                          }
                        />
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}

            {/* Project Sessions */}
            {(Object.keys(projectSessionGroups).length > 0 || onCreateProjectSession) && (
              <div>
                <button
                  onClick={() => toggleSection('projectSessions')}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 transition"
                >
                  {expandedSections.projectSessions ? (
                    <ChevronDown className="w-5 h-5 text-gray-400" />
                  ) : (
                    <ChevronRight className="w-5 h-5 text-gray-400" />
                  )}
                  <FolderOpen className="w-5 h-5 text-purple-400" />
                  <span className="font-semibold">Project Sessions</span>
                  <span className="text-xs text-gray-500 ml-1">
                    ({projectSessions.length})
                  </span>
                  {onCreateProjectSession && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onCreateProjectSession();
                      }}
                      className="ml-auto p-1.5 hover:bg-white/10 rounded transition"
                    >
                      <Plus className="w-4 h-4 text-gray-400" />
                    </button>
                  )}
                </button>

                <AnimatePresence>
                  {expandedSections.projectSessions &&
                    Object.keys(projectSessionGroups).length > 0 && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="ml-8 mt-2 space-y-3"
                      >
                        {Object.entries(projectSessionGroups).map(([projectKey, group]) => (
                          <ProjectSessionGroup
                            key={projectKey}
                            projectKey={projectKey}
                            projectName={group.projectName}
                            projectNumber={group.projectNumber}
                            sessions={group.sessions}
                            activeSessionId={activeSessionId}
                            onSelectSession={onSelectSession}
                            onContextMenu={handleContextMenu}
                          />
                        ))}
                      </motion.div>
                    )}
                </AnimatePresence>
              </div>
            )}
          </>
        )}

        {/* Legacy Support */}
        {showLegacy && (
          <>
            {/* Legacy General Chats */}
            {generalChats.length > 0 && onToggleGeneralChats && (
              <div>
                <button
                  onClick={onToggleGeneralChats}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 transition"
                >
                  {showGeneralChats ? (
                    <ChevronDown className="w-5 h-5 text-gray-400" />
                  ) : (
                    <ChevronRight className="w-5 h-5 text-gray-400" />
                  )}
                  <Sparkles className="w-5 h-5 text-purple-400" />
                  <span className="font-semibold">General Chats</span>
                  {onCreateGeneralChat && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onCreateGeneralChat();
                      }}
                      className="ml-auto p-1.5 hover:bg-white/10 rounded transition"
                    >
                      <Plus className="w-4 h-4 text-gray-400" />
                    </button>
                  )}
                </button>

                {showGeneralChats && generalChats.length > 0 && (
                  <motion.div className="ml-8 mt-2 space-y-1">
                    {generalChats.map((chat) => (
                      <Tooltip key={chat.id} content={chat.title} position="right">
                        <button
                          onClick={() => onSelectChat?.(null, chat.id)}
                          onContextMenu={(e) =>
                            handleContextMenu(e, 'chat', chat.id, chat.title, null)
                          }
                          className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition ${
                            activeChatId === chat.id && !activeProjectId
                              ? 'bg-emerald-500/20 text-emerald-400'
                              : 'text-gray-300 hover:bg-white/10'
                          }`}
                        >
                          <span className="block truncate">{chat.title}</span>
                        </button>
                      </Tooltip>
                    ))}
                  </motion.div>
                )}
              </div>
            )}

            {/* Legacy Projects */}
            {projects.length > 0 && (
              <div>
                <div className="px-3 py-2 text-xs font-bold text-gray-500 uppercase tracking-wider">
                  Projects
                </div>
                {projects.map((project) => (
                  <LegacyProjectItem
                    key={project.id}
                    project={project}
                    activeChatId={activeChatId}
                    onToggle={() => onToggleProject?.(project.id)}
                    onSelectChat={(chatId) => onSelectChat?.(project.id, chatId)}
                    onCreateChat={() => onCreateChat?.(project.id, '')}
                    onContextMenu={handleContextMenu}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* Empty State */}
        {sessions.length === 0 && projects.length === 0 && generalChats.length === 0 && (
          <div className="px-3 py-8 text-center text-gray-500 text-sm">
            No chats yet. Create a new session to get started!
          </div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onRename={contextMenu.type !== 'project' ? handleRename : undefined}
          onDelete={handleDelete}
          target={contextMenu.type === 'project' ? 'project' : 'page'}
        />
      )}

      {/* Rename Modal */}
      {renameModal && (
        <RenameModal
          isOpen={true}
          onClose={() => setRenameModal(null)}
          onRename={handleRenameSubmit}
          currentName={renameModal.name}
          type="page"
        />
      )}
    </div>
  );
}

// Session Item Component
function SessionItem({
  session,
  isActive,
  onClick,
  onContextMenu,
}: {
  session: ChatSession;
  isActive: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const isGeneral = session.chatType === 'general';

  return (
    <Tooltip content={session.title} position="right">
      <button
        onClick={onClick}
        onContextMenu={onContextMenu}
        className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition flex items-center gap-2 ${
          isActive
            ? isGeneral
              ? 'bg-blue-500/20 text-blue-400'
              : 'bg-purple-500/20 text-purple-400'
            : 'text-gray-300 hover:bg-white/10'
        }`}
      >
        <MessageSquare className="w-4 h-4 flex-shrink-0" />
        <span className="truncate flex-1">{session.title}</span>
        {!isGeneral && session.stage && (
          <StageBadge stage={session.stage} size="small" />
        )}
      </button>
    </Tooltip>
  );
}

// Project Session Group Component
function ProjectSessionGroup({
  projectKey,
  projectName,
  projectNumber,
  sessions,
  activeSessionId,
  onSelectSession,
  onContextMenu,
}: {
  projectKey: string;
  projectName?: string;
  projectNumber?: string;
  sessions: ChatSession[];
  activeSessionId?: string | null;
  onSelectSession?: (sessionId: string) => void;
  onContextMenu: (
    e: React.MouseEvent,
    type: 'session' | 'chat' | 'project',
    id: string,
    name: string,
    projectId?: string | null
  ) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/5 transition text-sm"
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-gray-500" />
        ) : (
          <ChevronRight className="w-4 h-4 text-gray-500" />
        )}
        <Folder className="w-4 h-4 text-purple-400" />
        <span className="font-medium text-purple-300 truncate">
          {projectNumber || projectName || projectKey}
        </span>
        <span className="text-xs text-gray-500">({sessions.length})</span>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="ml-4 mt-1 space-y-1 border-l-2 border-purple-500/20 pl-2"
          >
            {sessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                isActive={session.id === activeSessionId}
                onClick={() => onSelectSession?.(session.id)}
                onContextMenu={(e) =>
                  onContextMenu(e, 'session', session.id, session.title, projectKey)
                }
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Legacy Project Item Component
function LegacyProjectItem({
  project,
  activeChatId,
  onToggle,
  onSelectChat,
  onCreateChat,
  onContextMenu,
}: {
  project: Project;
  activeChatId: string | null;
  onToggle: () => void;
  onSelectChat: (chatId: string) => void;
  onCreateChat: () => void;
  onContextMenu: (
    e: React.MouseEvent,
    type: 'session' | 'chat' | 'project',
    id: string,
    name: string,
    projectId?: string | null
  ) => void;
}) {
  return (
    <div className="mt-4">
      <div
        className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 transition"
        onContextMenu={(e) => onContextMenu(e, 'project', project.id, project.name)}
      >
        <Tooltip content={project.name} position="right">
          <button onClick={onToggle} className="flex items-center gap-3 flex-1 text-left">
            {project.isExpanded ? (
              <ChevronDown className="w-5 h-5 text-gray-400" />
            ) : (
              <ChevronRight className="w-5 h-5 text-gray-400" />
            )}
            <Folder className="w-5 h-5 text-indigo-400" />
            <span className="font-bold text-white">
              {(project as any).oeNumber || project.id}
            </span>
          </button>
        </Tooltip>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onCreateChat();
          }}
          className="p-1.5 hover:bg-white/10 rounded transition"
        >
          <Plus className="w-4 h-4 text-emerald-400" />
        </button>
      </div>

      {project.isExpanded && project.chats.length > 0 && (
        <motion.div className="ml-10 mt-2 space-y-1">
          {project.chats.map((chat) => (
            <Tooltip key={chat.id} content={chat.title} position="right">
              <button
                onClick={() => onSelectChat(chat.id)}
                onContextMenu={(e) =>
                  onContextMenu(e, 'chat', chat.id, chat.title, project.id)
                }
                className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition ${
                  activeChatId === chat.id
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : 'text-gray-300 hover:bg-white/10'
                }`}
              >
                <span className="block truncate">{chat.title}</span>
              </button>
            </Tooltip>
          ))}
        </motion.div>
      )}
    </div>
  );
}

export default SessionTree;
