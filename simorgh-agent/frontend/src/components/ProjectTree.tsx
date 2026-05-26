import React from 'react';
import { motion } from 'framer-motion';
import {
  MessageSquare,
  ChevronDown,
  ChevronRight,
  Plus,
  Sparkles,
  GitBranch,
  Archive
} from 'lucide-react';
import { Project, Chat } from '../types';
import ContextMenu from './ContextMenu';
import RenameModal from './RenameModal';
import { Tooltip } from './Tooltip';
import { ProjectStatusIcon } from './ProjectStatusIcon';
import { useLanguage } from '../context/LanguageContext';

type StatusFilter = 'active' | 'archived' | 'all';

// Tiny colored pill — Claude-Code-style session status. We derive what
// little we can client-side: streaming → Running, archived → Archived.
function StatusPill({ kind }: { kind: 'running' | 'archived' | null }) {
  if (kind === null) return null;
  if (kind === 'running') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-sky-500/15 border border-sky-400/30 text-[10px] font-medium text-sky-300">
        <span className="w-1 h-1 rounded-full bg-sky-300 animate-pulse" />
        Running
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-white/[0.05] border border-white/10 text-[10px] font-medium text-gray-400">
      Archived
    </span>
  );
}

function timeAgo(d: Date | string | undefined): string {
  if (!d) return '';
  const t = typeof d === 'string' ? new Date(d) : d;
  const s = Math.floor((Date.now() - t.getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return t.toLocaleDateString();
}

interface ProjectTreeProps {
  projects: Project[];
  generalChats: Chat[];
  activeProjectId: string | null;
  activeChatId: string | null;
  showGeneralChats: boolean;
  // Whether the active chat is currently streaming a response. Drives the
  // "Running" status pill on that single row.
  isStreaming?: boolean;
  /** Project UUID whose chat is actively streaming. Used to force the
   * BUSY variant on its status dot — the backend only flips BUSY when
   * there's an explicit project_tasks row in pending/in_progress, but
   * plain chat-driven CoT never creates a task, so without this the
   * dot stayed blue/gray even during long answers. */
  streamingProjectId?: string | null;
  onToggleProject: (projectId: string) => void;
  onToggleGeneralChats: () => void;
  onSelectChat: (projectId: string | null, chatId: string) => void;
  onCreateProject: () => void;
  onCreateChat: (projectId: string, title: string) => void;
  // Optional: when undefined the "new general chat" entry is hidden (legacy users).
  onCreateGeneralChat?: () => void;
  onRenameChat: (chatId: string, newName: string, projectId: string | null) => void;
  onDeleteChat: (chatId: string, projectId: string | null) => void;
  onDeleteProject: (projectId: string) => void;
  onArchiveChat?: (chatId: string, projectId: string | null, archive: boolean) => void;
}

export function ProjectTree({
  projects,
  generalChats,
  activeProjectId,
  activeChatId,
  showGeneralChats,
  isStreaming = false,
  streamingProjectId = null,
  onToggleProject,
  onToggleGeneralChats,
  onSelectChat,
  onCreateProject,
  onCreateChat,
  onCreateGeneralChat,
  onRenameChat,
  onDeleteChat,
  onDeleteProject,
  onArchiveChat
}: ProjectTreeProps) {
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('active');
  const [showPageModal, setShowPageModal] = React.useState(false);
  const [selectedProjectId, setSelectedProjectId] = React.useState<string | null>(null);
  const { t } = useLanguage();

  // Context menu state for chats
  const [contextMenu, setContextMenu] = React.useState<{
    x: number;
    y: number;
    chatId: string;
    chatName: string;
    projectId: string | null;
  } | null>(null);

  // Context menu state for projects
  const [projectContextMenu, setProjectContextMenu] = React.useState<{
    x: number;
    y: number;
    projectId: string;
    projectName: string;
  } | null>(null);

  // Rename modal state
  const [renameModal, setRenameModal] = React.useState<{
    chatId: string;
    currentName: string;
    projectId: string | null;
  } | null>(null);

  // فقط پروژه‌های واقعی (نه هدر)
  const realProjects = projects.filter((p) => !(p as any).isHeader);

  const handleAddPage = (projectId: string) => {
    setSelectedProjectId(projectId);
    setShowPageModal(true);
  };

  // Context menu handlers
  const handleContextMenu = (
    e: React.MouseEvent,
    chatId: string,
    chatName: string,
    projectId: string | null
  ) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      chatId,
      chatName,
      projectId
    });
  };

  const handleCloseContextMenu = () => {
    setContextMenu(null);
  };

  const handleRename = () => {
    if (contextMenu) {
      setRenameModal({
        chatId: contextMenu.chatId,
        currentName: contextMenu.chatName,
        projectId: contextMenu.projectId
      });
      setContextMenu(null);
    }
  };

  const handleDelete = () => {
    if (contextMenu) {
      onDeleteChat(contextMenu.chatId, contextMenu.projectId);
      setContextMenu(null);
    }
  };

  const handleArchive = () => {
    if (contextMenu && onArchiveChat) {
      // Look up current archived state so the menu becomes a toggle.
      const chat = (contextMenu.projectId
        ? projects.find(p => p.id === contextMenu.projectId)?.chats
        : generalChats
      )?.find(c => c.id === contextMenu.chatId);
      const isCurrentlyArchived = chat?.archived === true;
      onArchiveChat(contextMenu.chatId, contextMenu.projectId, !isCurrentlyArchived);
      setContextMenu(null);
    }
  };

  const handleCreateNew = () => {
    if (contextMenu && contextMenu.projectId) {
      handleAddPage(contextMenu.projectId);
      setContextMenu(null);
    } else if (onCreateGeneralChat) {
      // General chat (hidden for legacy users — onCreateGeneralChat is undefined)
      onCreateGeneralChat();
      setContextMenu(null);
    }
  };

  const handleRenameSubmit = (newName: string) => {
    if (renameModal) {
      onRenameChat(renameModal.chatId, newName, renameModal.projectId);
      setRenameModal(null);
    }
  };

  // Project context menu handlers
  const handleProjectContextMenu = (
    e: React.MouseEvent,
    projectId: string,
    projectName: string
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setProjectContextMenu({
      x: e.clientX,
      y: e.clientY,
      projectId,
      projectName
    });
  };

  const handleCloseProjectContextMenu = () => {
    setProjectContextMenu(null);
  };

  const handleDeleteProject = () => {
    if (projectContextMenu) {
      onDeleteProject(projectContextMenu.projectId);
      setProjectContextMenu(null);
    }
  };

  return (
    <div className="h-full flex flex-col text-white">
      {/* Header — quiet "+ New project" button, Claude-Code style */}
      <div className="px-3 pt-3 pb-2 border-b border-white/[0.06]">
        <button
          onClick={onCreateProject}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-md bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 hover:border-white/20 text-gray-100 text-sm font-medium transition"
        >
          <Plus className="w-4 h-4 text-gray-300" />
          {t('newProject')}
        </button>
      </div>

      {/* Filter chips — Claude-Code style: Active / Archived / All. */}
      <div className="px-3 pt-2 pb-1 flex items-center gap-1 text-[11px]">
        {(['active', 'archived', 'all'] as StatusFilter[]).map(f => (
          <button
            key={f}
            onClick={() => setStatusFilter(f)}
            className={`px-2 py-0.5 rounded-full border transition ${
              statusFilter === f
                ? 'bg-white/[0.08] border-white/20 text-gray-100'
                : 'bg-transparent border-white/[0.06] text-gray-500 hover:text-gray-300 hover:border-white/15'
            }`}
          >
            {t(f)}
          </button>
        ))}
      </div>

      {/* Pinned GENERAL row — sits outside the scroll container so the
          header (and the + button next to it) stays visible while the
          chats below scroll. Visually distinct as a button-like tile
          (filled background, coloured Sparkles, hover lift). */}
      {onCreateGeneralChat && (
        <div className="flex-shrink-0 px-3 pt-2 pb-1.5">
          <div className="flex items-center gap-1 px-2 py-2 rounded-lg bg-gradient-to-r from-purple-500/[0.12] to-indigo-500/[0.08] border border-purple-400/20 hover:border-purple-400/40 transition">
            <button
              onClick={onToggleGeneralChats}
              className="flex items-center gap-1.5 flex-1 text-left text-[13px] font-bold text-purple-100 uppercase tracking-wider hover:text-white transition"
            >
              {showGeneralChats ? (
                <ChevronDown className="w-4 h-4 text-purple-300" />
              ) : (
                <ChevronRight className="w-4 h-4 text-purple-300" />
              )}
              <Sparkles className="w-4 h-4 text-fuchsia-400" />
              <span>{t('general')}</span>
            </button>
            <button
              onClick={onCreateGeneralChat}
              className="p-1.5 hover:bg-white/15 rounded-md text-purple-200 hover:text-white transition"
              title={t('newGeneralChat')}
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Scrollable list: General chats + Projects + project sessions */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 py-2 space-y-4">
        {onCreateGeneralChat && (
        <div>
          {showGeneralChats && generalChats.length > 0 && (
            <motion.div className="space-y-0.5">
              {generalChats
                .filter(c => statusFilter === 'all'
                  ? true
                  : statusFilter === 'archived' ? c.archived === true : c.archived !== true)
                .map((chat) => {
                const isChatActive = activeChatId === chat.id && !activeProjectId;
                const pill = chat.archived
                  ? 'archived' as const
                  : (isChatActive && isStreaming ? 'running' as const : null);
                return (
                <Tooltip key={chat.id} content={chat.title} position="right">
                  <button
                    onClick={() => onSelectChat(null, chat.id)}
                    onContextMenu={(e) => handleContextMenu(e, chat.id, chat.title, null)}
                    className={`group w-full text-left pl-7 pr-2 py-1.5 rounded text-sm transition flex items-center gap-2 border-l-2 ${
                      isChatActive
                        ? 'bg-white/[0.06] border-emerald-400/70 text-white'
                        : 'border-transparent text-gray-300 hover:bg-white/[0.04] hover:text-white'
                    }`}
                  >
                    <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 text-gray-500" />
                    <span className="block truncate flex-1">{chat.title}</span>
                    <StatusPill kind={pill} />
                  </button>
                </Tooltip>
                );
              })}
            </motion.div>
          )}
        </div>
        )}

        {/* Projects Section */}
        <div>
          <div className="px-2 mb-1 text-[13px] font-semibold text-gray-400 uppercase tracking-wider">
            {t('projects')}
          </div>

          {realProjects.length === 0 ? (
            <div className="px-3 py-8 text-center text-gray-500 text-sm">
              {t('noProjectsYet')}
            </div>
          ) : (
            <div className="space-y-1">
            {realProjects
              // Hide projects that have no chats matching the current
              // filter — otherwise "Archived" shows a forest of empty
              // project rows (none of their chats archived), and
              // "Active" hides brand-new projects that just don't have
              // chats yet. Rules:
              //   • all      → show every project
              //   • active   → show projects with ≥1 active chat,
              //                AND projects with no chats at all
              //                (treat empty as active-by-default)
              //   • archived → show only projects with ≥1 archived chat
              .filter(project => {
                if (statusFilter === 'all') return true;
                if (project.chats.length === 0) {
                  return statusFilter === 'active';
                }
                return project.chats.some(c =>
                  statusFilter === 'archived'
                    ? c.archived === true
                    : c.archived !== true
                );
              })
              .map((project) => {
              const isActive = activeProjectId === project.id;
              const repo = project.repoPath;
              const branch = project.workingBranch || project.baseBranch;
              return (
              <div key={project.id}>
                {/* Project Row — name, repo subtitle, branch chip */}
                <div
                  className={`group flex items-start gap-2 pl-2 pr-1 py-2 rounded-md transition border-l-2 ${
                    isActive
                      ? 'bg-white/[0.05] border-sky-400/70'
                      : 'border-transparent hover:bg-white/[0.03]'
                  }`}
                  onContextMenu={(e) => handleProjectContextMenu(e, project.id, project.name)}
                >
                  <button
                    onClick={() => onToggleProject(project.id)}
                    className="mt-0.5 flex-shrink-0 text-gray-500 hover:text-gray-300 transition"
                  >
                    {project.isExpanded ? (
                      <ChevronDown className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5" />
                    )}
                  </button>
                  {/* Status dot/icon — variants from ProjectStatusIcon:
                      busy (animated loader), paused (blue dot), pushed
                      (green branch), merged (green merge), created
                      (violet branch), stopped (gray dot), conflict
                      (red alert), error (red alert), idle (hollow
                      gray circle). Replaces the generic Folder icon
                      per operator request — status is the more useful
                      visual signal here. forceBusy makes plain CoT
                      streams (which don't create project_tasks rows)
                      register as busy too. */}
                  <span className="mt-0.5 flex-shrink-0">
                    <ProjectStatusIcon
                      status={project.runtimeStatus}
                      forceBusy={streamingProjectId === project.id}
                    />
                  </span>
                  <button
                    onClick={() => onToggleProject(project.id)}
                    className="flex-1 min-w-0 text-left"
                  >
                    <div className="text-[13px] font-medium text-gray-100 truncate">
                      {project.name || (project as any).oeNumber || project.id}
                    </div>
                    {repo && (
                      <div className="text-[11px] text-gray-500 font-mono truncate">
                        {repo}
                      </div>
                    )}
                    {branch && (
                      <div className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/[0.08] border border-emerald-400/20 text-[10px] font-mono text-emerald-300/90 max-w-full">
                        <GitBranch className="w-2.5 h-2.5 flex-shrink-0" />
                        <span className="truncate">{branch}</span>
                      </div>
                    )}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAddPage(project.id);
                    }}
                    className="mt-0.5 p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-white/10 transition opacity-0 group-hover:opacity-100 flex-shrink-0"
                    title="New chat in this project"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Chats within the project */}
                {project.isExpanded && (() => {
                  const visibleChats = project.chats.filter(c =>
                    statusFilter === 'all'
                      ? true
                      : statusFilter === 'archived' ? c.archived === true : c.archived !== true
                  );
                  if (visibleChats.length === 0) return null;
                  return (
                  <motion.div className="mt-0.5 space-y-0.5">
                    {visibleChats.map((chat) => {
                      const isChatActive = activeChatId === chat.id;
                      const pill = chat.archived
                        ? 'archived' as const
                        : (isChatActive && isStreaming ? 'running' as const : null);
                      return (
                      <Tooltip key={chat.id} content={chat.title} position="right">
                        <button
                          onClick={() => onSelectChat(project.id, chat.id)}
                          onContextMenu={(e) => handleContextMenu(e, chat.id, chat.title, project.id)}
                          className={`w-full text-left pl-9 pr-2 py-1.5 rounded text-[13px] transition flex items-center gap-2 border-l-2 ${
                            isChatActive
                              ? 'bg-white/[0.06] border-emerald-400/70 text-white'
                              : 'border-transparent text-gray-300 hover:bg-white/[0.04] hover:text-white'
                          } ${chat.archived ? 'opacity-60' : ''}`}
                        >
                          <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 text-gray-500" />
                          <span className="block truncate flex-1">{chat.title}</span>
                          <StatusPill kind={pill} />
                          {!pill && chat.updatedAt && (
                            <span className="text-[10px] text-gray-500 flex-shrink-0">
                              {timeAgo(chat.updatedAt)}
                            </span>
                          )}
                        </button>
                      </Tooltip>
                      );
                    })}
                  </motion.div>
                  );
                })()}
              </div>
              );
            })}
            </div>
          )}
        </div>
      </div>

      {/* مودال Add Page */}
      {showPageModal && selectedProjectId && (
        <AddPageModal
          onClose={() => {
            setShowPageModal(false);
            setSelectedProjectId(null);
          }}
          onCreate={(title) => {
            onCreateChat(selectedProjectId, title);
            setShowPageModal(false);
            setSelectedProjectId(null);
          }}
        />
      )}

      {/* Context Menu for Chats/Pages */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={handleCloseContextMenu}
          onRename={handleRename}
          onDelete={handleDelete}
          onCreateNew={handleCreateNew}
          onArchive={onArchiveChat ? handleArchive : undefined}
          isArchived={(() => {
            const chat = (contextMenu.projectId
              ? projects.find(p => p.id === contextMenu.projectId)?.chats
              : generalChats
            )?.find(c => c.id === contextMenu.chatId);
            return chat?.archived === true;
          })()}
          target={contextMenu.projectId ? 'page' : 'project'}
        />
      )}

      {/* Context Menu for Projects */}
      {projectContextMenu && (
        <ContextMenu
          x={projectContextMenu.x}
          y={projectContextMenu.y}
          onClose={handleCloseProjectContextMenu}
          onDelete={handleDeleteProject}
          onCreateNew={() => {
            if (projectContextMenu) {
              handleAddPage(projectContextMenu.projectId);
              handleCloseProjectContextMenu();
            }
          }}
          target='project'
        />
      )}

      {/* Rename Modal */}
      {renameModal && (
        <RenameModal
          isOpen={true}
          onClose={() => setRenameModal(null)}
          onRename={handleRenameSubmit}
          currentName={renameModal.currentName}
          type={renameModal.projectId ? 'page' : 'project'}
        />
      )}
    </div>
  );
}

// مودال کوچک برای Add Page
function AddPageModal({ onClose, onCreate }: { onClose: () => void; onCreate: (title: string) => void }) {
  const [title, setTitle] = React.useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (title.trim()) {
      onCreate(title.trim());
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-gradient-to-br from-gray-900 to-black border border-white/10 rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6"
      >
        <h3 className="text-xl font-bold text-white mb-4">📄 New Page</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Enter page title..."
            className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            autoFocus
          />
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-white font-medium transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim()}
              className="flex-1 px-4 py-3 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-white font-medium transition"
            >
              Create
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}