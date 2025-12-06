import React from 'react';
import { motion } from 'framer-motion';
import {
  Folder,
  MessageSquare,
  ChevronDown,
  ChevronRight,
  Plus,
  Sparkles
} from 'lucide-react';
import { Project, Chat } from '../types';
import ContextMenu from './ContextMenu';
import RenameModal from './RenameModal';

interface ProjectTreeProps {
  projects: Project[];
  generalChats: Chat[];
  activeProjectId: string | null;
  activeChatId: string | null;
  showGeneralChats: boolean;
  onToggleProject: (projectId: string) => void;
  onToggleGeneralChats: () => void;
  onSelectChat: (projectId: string | null, chatId: string) => void;
  onCreateProject: () => void;
  onCreateChat: (projectId: string, title: string) => void;
  onCreateGeneralChat: () => void;
  onRenameChat: (chatId: string, newName: string, projectId: string | null) => void;
  onDeleteChat: (chatId: string, projectId: string | null) => void;
  onDeleteProject: (projectId: string) => void;
}

export function ProjectTree({
  projects,
  generalChats,
  activeProjectId,
  activeChatId,
  showGeneralChats,
  onToggleProject,
  onToggleGeneralChats,
  onSelectChat,
  onCreateProject,
  onCreateChat,
  onCreateGeneralChat,
  onRenameChat,
  onDeleteChat,
  onDeleteProject
}: ProjectTreeProps) {
  const [showPageModal, setShowPageModal] = React.useState(false);
  const [selectedProjectId, setSelectedProjectId] = React.useState<string | null>(null);

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

  const handleCreateNew = () => {
    if (contextMenu && contextMenu.projectId) {
      handleAddPage(contextMenu.projectId);
      setContextMenu(null);
    } else {
      // General chat
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
      {/* Header */}
      <div className="p-4 border-b border-white/10">
        <button
          onClick={onCreateProject}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-semibold transition-all shadow-lg"
        >
          <Plus className="w-5 h-5" />
          New Project
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* General Chats */}
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
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCreateGeneralChat();
              }}
              className="ml-auto p-1.5 hover:bg-white/10 rounded transition"
            >
              <Plus className="w-4 h-4 text-gray-400" />
            </button>
          </button>

          {showGeneralChats && generalChats.length > 0 && (
            <motion.div className="ml-8 mt-2 space-y-1">
              {generalChats.map((chat) => (
                <button
                  key={chat.id}
                  onClick={() => onSelectChat(null, chat.id)}
                  onContextMenu={(e) => handleContextMenu(e, chat.id, chat.title, null)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition ${
                    activeChatId === chat.id && !activeProjectId
                      ? 'bg-emerald-500/20 text-emerald-400'
                      : 'text-gray-300 hover:bg-white/10'
                  }`}
                >
                  {chat.title}
                </button>
              ))}
            </motion.div>
          )}
        </div>

        {/* Projects Section */}
        <div>
          <div className="px-3 py-2 text-xs font-bold text-gray-500 uppercase tracking-wider">
            List Projects
          </div>

          {realProjects.length === 0 ? (
            <div className="px-3 py-8 text-center text-gray-500 text-sm">
              No projects yet. Click "New Project" to start!
            </div>
          ) : (
            realProjects.map((project) => (
              <div key={project.id} className="mt-4">
                {/* Project Row */}
                <div
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 transition"
                  onContextMenu={(e) => handleProjectContextMenu(e, project.id, project.name)}
                >
                  <button
                    onClick={() => onToggleProject(project.id)}
                    className="flex items-center gap-3 flex-1 text-left"
                  >
                    {project.isExpanded ? (
                      <ChevronDown className="w-5 h-5 text-gray-400" />
                    ) : (
                      <ChevronRight className="w-5 h-5 text-gray-400" />
                    )}
                    <Folder className="w-5 h-5 text-indigo-400" />
                    <span className="font-bold text-white truncate">
                      {project.name}
                    </span>
                  </button>

                  {/* Add Page + */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAddPage(project.id);
                    }}
                    className="p-1.5 hover:bg-white/10 rounded transition"
                    title="Add new page"
                  >
                    <Plus className="w-4 h-4 text-emerald-400" />
                  </button>
                </div>

                {/* Pages */}
                {project.isExpanded && project.chats.length > 0 && (
                  <motion.div className="ml-10 mt-2 space-y-1">
                    {project.chats.map((chat) => (
                      <button
                        key={chat.id}
                        onClick={() => onSelectChat(project.id, chat.id)}
                        onContextMenu={(e) => handleContextMenu(e, chat.id, chat.title, project.id)}
                        className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition ${
                          activeChatId === chat.id
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : 'text-gray-300 hover:bg-white/10'
                        }`}
                      >
                        {chat.title}
                      </button>
                    ))}
                  </motion.div>
                )}
              </div>
            ))
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
          target={contextMenu.projectId ? 'page' : 'project'}
        />
      )}

      {/* Context Menu for Projects */}
      {projectContextMenu && (
        <ContextMenu
          x={projectContextMenu.x}
          y={projectContextMenu.y}
          onClose={handleCloseProjectContextMenu}
          onRename={() => {
            // TODO: Implement project rename functionality
            alert('Project rename feature coming soon!');
            handleCloseProjectContextMenu();
          }}
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