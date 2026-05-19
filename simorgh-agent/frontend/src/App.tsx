import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link } from 'react-router-dom';
import { ThemeBackground } from './components/ThemeBackground';
import { Sidebar } from './components/Sidebar';
import { ProjectTree } from './components/ProjectTree';
import { HistoryList } from './components/HistoryList';
import { ChatArea } from './components/ChatArea';
import SettingsPanel from './components/SettingsPanel';
import MobileHeader from './components/MobileHeader';
import CreateProjectModal from './components/CreateProjectModal';
import CreateAgentProjectModal from './components/CreateAgentProjectModal';
import CreateProjectWizard from './components/CreateProjectWizard';
import ProjectSessionDeepLink from './pages/ProjectSessionDeepLink';
import CreateChatModal from './components/CreateChatModal';
import CreateProjectChatModal from './components/CreateProjectChatModal';
import Login from './components/Login';
import SpecTaskNotification from './components/SpecTaskNotification';
import NotificationToast, { ToastNotification } from './components/NotificationToast';
import SpecReview from './pages/SpecReview';
import AdminPanel from './pages/AdminPanel';
import UpgradePage from './pages/UpgradePage';
// ProjectAgentDashboard removed - all agent functionality is now in the main chat display

// Auth components (modern + auto-routing)
import {
  ModernLogin,
  Signup,
  ForgotPassword,
  ResetPassword,
  VerifyEmail,
  VerifyEmailSent,
  GoogleCallback,
  LoginRouter
} from './components/auth';

import { useSidebar } from './hooks/useSidebar';
import { useProjects } from './hooks/useProjects';
import { useChat } from './hooks/useChat';
import { useQuota } from './hooks/useQuota';
import { LanguageProvider } from './context/LanguageContext';
import { AuthProvider, useAuth, isModernUser, isLegacyUser } from './context/AuthContext';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import { Message } from './types';

// Main chat interface component
function MainChat() {
  const { user } = useAuth();
  const { notificationsEnabled } = useTheme();
  const { quota, isModern: isModernTier, canUseOfflineLlm, canCreateProjects, canUseTools, quotaExceeded, quotaWarning, decrementLocal, fetchQuota } = useQuota();
  const rightSidebar = useSidebar(true);
  const leftSidebar = useSidebar(false);
  const [showCreateModal, setShowCreateModal] = React.useState(false);
  const [showChatModal, setShowChatModal] = React.useState(false);
  const [showProjectChatModal, setShowProjectChatModal] = React.useState(false);
  const [selectedProjectForChat, setSelectedProjectForChat] = React.useState<string | null>(null);
  const [activeSpecTasks, setActiveSpecTasks] = React.useState<string[]>([]);
  const [notifications, setNotifications] = React.useState<ToastNotification[]>([]);
  const [settingsPanelOpen, setSettingsPanelOpen] = React.useState(false);
  const [currentAiMode, setCurrentAiMode] = React.useState<'online' | 'offline'>('online');

  // Derive a unified userId that works for both legacy (TPMS) and modern (email/Google) users
  // Modern users: use user.id (UUID from PostgreSQL) which matches JWT "sub" claim
  // Legacy users: use EMPUSERNAME which matches JWT "sub" claim
  const userId = user ? (isLegacyUser(user) ? user.EMPUSERNAME : isModernUser(user) ? user.id : undefined) : undefined;

  const {
    projects,
    generalChats,
    activeProjectId,
    activeChatId,
    activeChat,
    showGeneralChats,
    syncProgress,
    createProject,
    createChat,
    createGeneralChat,
    updateChatTitle,
    renameChat,
    deleteChat,
    deleteProject,
    toggleProject,
    toggleGeneralChats,
    selectChat,
    ensureSessionChat,
  } = useProjects(userId);

  // Get projectNumber for chat
  const projectNumber = activeProjectId || null;

  const handleSpecTaskCreated = (taskId: string) => {
    console.log('📊 New spec task:', taskId);
    setActiveSpecTasks(prev => [...prev, taskId]);
  };

  const handleSpecTaskComplete = (documentId: string, projectNumber: string) => {
    console.log('✅ Spec extraction complete:', documentId, projectNumber);
    // You can add logic here to refresh project data or show a success message
  };

  const handleRemoveSpecTask = (taskId: string) => {
    setActiveSpecTasks(prev => prev.filter(id => id !== taskId));
  };

  // Memoize initial messages to prevent unnecessary re-renders with new empty array references
  const initialMessages = React.useMemo(() => {
    const msgs = activeChat?.messages || [];
    console.log(`📚 Active chat messages: ${msgs.length} (chat: ${activeChatId})`);
    return msgs;
  }, [activeChat?.messages, activeChatId]);

  const {
    messages,
    isTyping,
    sendMessage,
    regenerateResponse,
    updateMessageReaction,
    switchVersion,
    cancelGeneration,
    editMessage
  } = useChat(
    initialMessages,
    activeChatId,
    userId,
    projectNumber,
    updateChatTitle,
    handleSpecTaskCreated
  );

  const [editingMessage, setEditingMessage] = React.useState<Message | null>(null);

  // Load AI mode on mount and listen for changes
  // Modern users are forced to online mode (offline is legacy-only)
  React.useEffect(() => {
    if (isModernTier) {
      setCurrentAiMode('online');
      localStorage.setItem('llm_mode', 'online');
      return;
    }

    const savedMode = localStorage.getItem('llm_mode') as 'online' | 'offline' | null;
    if (savedMode) {
      setCurrentAiMode(savedMode);
    }

    const handleModeChange = (e: Event) => {
      const customEvent = e as CustomEvent<'online' | 'offline'>;
      if (isModernTier && customEvent.detail === 'offline') return; // Block for modern
      setCurrentAiMode(customEvent.detail);
    };

    window.addEventListener('llm-mode-changed', handleModeChange);
    return () => window.removeEventListener('llm-mode-changed', handleModeChange);
  }, [isModernTier]);

  // Handle back button for settings panel on mobile
  React.useEffect(() => {
    const handlePopState = () => {
      if (window.innerWidth < 768 && settingsPanelOpen) {
        setSettingsPanelOpen(false);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [settingsPanelOpen]);

  // Push history state when settings panel opens on mobile
  const handleOpenSettings = React.useCallback(() => {
    if (window.innerWidth < 768) {
      window.history.pushState({ settingsOpen: true }, '');
    }
    setSettingsPanelOpen(true);
  }, []);

  const handleCreateProject = () => setShowCreateModal(true);

  const handleCreateChat = (projectId: string, pageName: string) => {
    createChat(projectId, pageName);
  };

  const handleShowProjectChatModal = (projectId: string) => {
    setSelectedProjectForChat(projectId);
    setShowProjectChatModal(true);
  };

  const handleCreateGeneralChat = () => {
    // Create general chat immediately without asking for title
    // The title will be auto-generated from the first message
    createGeneralChat("New conversation");
  };

  // Add notification when AI responds
  const addNotification = React.useCallback((message: string) => {
    if (!notificationsEnabled) return;

    const notification: ToastNotification = {
      id: Date.now().toString(),
      message,
      timestamp: Date.now(),
    };

    setNotifications(prev => [...prev, notification]);
  }, [notificationsEnabled]);

  // Watch for new AI messages
  React.useEffect(() => {
    if (messages.length === 0) return;

    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role === 'assistant') {
      // Get first 100 characters of message for notification
      const preview = lastMessage.content.substring(0, 100);
      addNotification(preview);
    }
  }, [messages.length, addNotification]); // Only trigger on new messages

  // Remove notification
  const removeNotification = React.useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  // Handle chat selection - close right sidebar on mobile
  const handleSelectChat = React.useCallback((projectId: string | null, chatId: string) => {
    selectChat(projectId, chatId);

    // Close sidebar on mobile after selection
    if (window.innerWidth < 768) {
      rightSidebar.toggle();
    }
  }, [selectChat, rightSidebar]);

  // Auto-open a session when arriving via /chatbot/project/session_<token>.
  // The deep-link page stashes the resolved session in sessionStorage and
  // navigates here with ?project=...&session=... in the query string.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const projectId = params.get('project');
    const sessionToken = params.get('session');
    if (!projectId || !sessionToken) return;
    const pending = sessionStorage.getItem('simorgh_pending_session');
    if (pending) {
      try {
        const s = JSON.parse(pending);
        if (s.session_token === sessionToken) {
          // Inject a synthetic chat row so the sidebar shows it immediately.
          ensureSessionChat(projectId, sessionToken, s.title || 'New session');
          selectChat(projectId, sessionToken);
          sessionStorage.removeItem('simorgh_pending_session');
          // Strip the query string so back/forward stay clean.
          window.history.replaceState({}, '', window.location.pathname);
        }
      } catch {}
    }
  }, [selectChat, ensureSessionChat]);

  // Handle chat selection from history - close left sidebar on mobile
  const handleSelectChatFromHistory = React.useCallback((projectId: string | null, chatId: string) => {
    selectChat(projectId, chatId);

    // Close sidebar on mobile after selection
    if (window.innerWidth < 768) {
      leftSidebar.toggle();
    }
  }, [selectChat, leftSidebar]);

  const handleEditMessage = React.useCallback((message: Message) => {
    setEditingMessage(message);
  }, []);

  const handleSendMessage = React.useCallback((content: string, files?: any[]) => {
    if (editingMessage) {
      // If editing, call editMessage instead of sendMessage
      editMessage(editingMessage.id, content, files);
      setEditingMessage(null);
    } else {
      sendMessage(content, files);
    }
  }, [editingMessage, editMessage, sendMessage]);

  // هدر ثابت + پروژه‌ها
  const displayProjects = [
    {
      id: 'list-projects-header',
      name: 'List Projects',
      chats: [],
      createdAt: new Date(),
      isExpanded: true,
      isHeader: true as const
    },
    ...projects
  ];

  // تاریخچه
  const allProjectsForHistory = [
    ...projects,
    ...(generalChats.length > 0
      ? [{
        id: 'general',
        name: 'General Chats',
        chats: generalChats,
        createdAt: new Date(),
        isExpanded: true
      }]
      : [])
  ];

  return (
    <LanguageProvider>
      {/* Render background at root level to avoid stacking context issues */}
      <ThemeBackground />


      <div className="w-full h-[100dvh] relative">

        {/* Mobile Header - only visible on mobile */}
        <MobileHeader
          onMenuClick={rightSidebar.toggle}
          onHistoryClick={leftSidebar.toggle}
          onSettingsClick={handleOpenSettings}
          currentModel={currentAiMode}
          userTier={quota.user_role}
          offlineLocked={!canUseOfflineLlm}
        />

        <div className="relative z-10 flex h-full mt-0 md:mt-0 overflow-hidden">
          {/* سایدبار راست */}
          <Sidebar
            isOpen={rightSidebar.isOpen}
            onToggle={rightSidebar.toggle}
            side="right"
            onNewProject={canCreateProjects ? handleCreateProject : undefined}
            // Legacy users get project-only chat: hide the "new general chat" entry point.
            onNewGeneralChat={user && isLegacyUser(user) ? undefined : handleCreateGeneralChat}
          >
            {/* Quota Badge for modern users */}
            {isModernTier && (
              <div className="px-3 py-2 mx-2 mb-2 rounded-lg bg-white/5 border border-white/10">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-400 capitalize">{quota.user_role} tier</span>
                  <span className={`font-medium ${quotaExceeded ? 'text-red-400' : quotaWarning ? 'text-amber-400' : 'text-emerald-400'}`}>
                    {quota.questions_remaining}/{quota.questions_limit}
                  </span>
                </div>
                <div className="mt-1 w-full bg-gray-700 rounded-full h-1">
                  <div
                    className={`h-1 rounded-full transition-all ${quotaExceeded ? 'bg-red-500' : quotaWarning ? 'bg-amber-500' : 'bg-emerald-500'}`}
                    style={{ width: `${Math.min(100, (quota.questions_used_today / Math.max(1, quota.questions_limit)) * 100)}%` }}
                  />
                </div>
                {quota.user_role !== 'admin' && quota.user_role !== 'max' && (
                  <Link to="/upgrade" className="block mt-1.5 text-center text-xs text-blue-400 hover:text-blue-300 transition">
                    Upgrade plan
                  </Link>
                )}
              </div>
            )}
            <ProjectTree
              projects={displayProjects}
              // Hide general chats entirely for legacy users — project chat only.
              generalChats={user && isLegacyUser(user) ? [] : generalChats}
              activeProjectId={activeProjectId}
              activeChatId={activeChatId}
              showGeneralChats={user && isLegacyUser(user) ? false : showGeneralChats}
              onToggleProject={toggleProject}
              onToggleGeneralChats={toggleGeneralChats}
              onSelectChat={handleSelectChat}
              onCreateProject={handleCreateProject}
              onCreateChat={handleCreateChat}
              onCreateGeneralChat={user && isLegacyUser(user) ? undefined as any : handleCreateGeneralChat}
              onRenameChat={renameChat}
              onDeleteChat={deleteChat}
              onDeleteProject={deleteProject}
            />
          </Sidebar>

          {/* چت اصلی */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {/* Project Sync Progress - Above Chat Input */}
            {syncProgress && syncProgress.status === 'in_progress' && (
              <div className="absolute bottom-20 left-1/2 transform -translate-x-1/2 z-40 bg-gray-900/95 backdrop-blur-sm rounded-lg shadow-xl border border-purple-500/30 px-4 py-2 min-w-[280px] max-w-[400px]">
                <div className="flex items-center gap-3">
                  <div className="animate-spin rounded-full h-4 w-4 border-2 border-purple-500 border-t-transparent flex-shrink-0"></div>
                  <div className="flex-1 min-w-0">
                    <div className="text-white text-xs font-medium truncate">
                      {syncProgress.step_name || 'Initializing project...'}
                    </div>
                    <div className="mt-1 w-full bg-gray-700 rounded-full h-1.5">
                      <div
                        className="bg-gradient-to-r from-purple-500 to-blue-500 h-1.5 rounded-full transition-all duration-300"
                        style={{ width: `${syncProgress.progress_percent || 0}%` }}
                      ></div>
                    </div>
                  </div>
                  <div className="text-gray-400 text-xs flex-shrink-0">
                    {syncProgress.progress_percent || 0}%
                  </div>
                </div>
              </div>
            )}
            <ChatArea
              messages={messages}
              isTyping={isTyping}
              onSendMessage={handleSendMessage}
              onRegenerateResponse={regenerateResponse}
              onUpdateReaction={updateMessageReaction}
              onSwitchVersion={switchVersion}
              onEditMessage={handleEditMessage}
              onCancelGeneration={cancelGeneration}
              editingMessage={editingMessage}
              disabled={!activeChatId}
              isProjectChat={activeProjectId !== null}
              quotaExceeded={quotaExceeded}
            />
          </div>

          {/* سایدبار چپ */}
          <Sidebar isOpen={leftSidebar.isOpen} onToggle={leftSidebar.toggle} side="left">
            <HistoryList projects={allProjectsForHistory} onSelectChat={handleSelectChatFromHistory} />
          </Sidebar>
        </div>

        {/* تنظیمات */}
        <SettingsPanel
          externalOpen={settingsPanelOpen}
          onExternalClose={() => setSettingsPanelOpen(false)}
        />

        {/* New per-project container wizard (legacy + modern, both flows). */}
        <CreateProjectWizard
          isOpen={showCreateModal}
          onClose={() => setShowCreateModal(false)}
          onCreated={(_projectId, sessionToken) => {
            setShowCreateModal(false);
            // Navigate to the deep-link so the rest of the app picks up the session.
            window.location.assign(`/chatbot/project/${sessionToken}`);
          }}
        />

        {/* مودال ساخت چت جدید (Not used - general chats are created immediately) */}
        {/* <CreateChatModal
          isOpen={showChatModal}
          onClose={() => setShowChatModal(false)}
          onCreate={(title) => {
            handleCreateGeneralChat();
            setShowChatModal(false);
          }}
        /> */}

        {/* مودال ساخت چت پروژه */}
        <CreateProjectChatModal
          isOpen={showProjectChatModal}
          onClose={() => {
            setShowProjectChatModal(false);
            setSelectedProjectForChat(null);
          }}
          onCreate={(projectId, projectName, pageName) => {
            handleCreateChat(projectId, pageName);
            setShowProjectChatModal(false);
            setSelectedProjectForChat(null);
          }}
          userId={userId}
        />

        {/* Spec extraction task notifications */}
        {activeSpecTasks.map(taskId => (
          <SpecTaskNotification
            key={taskId}
            taskId={taskId}
            onComplete={(documentId, projectNumber) => {
              handleSpecTaskComplete(documentId, projectNumber);
              handleRemoveSpecTask(taskId);
            }}
            onError={(error) => {
              console.error('Spec extraction error:', error);
              handleRemoveSpecTask(taskId);
            }}
          />
        ))}

        {/* Toast notifications for AI messages */}
        <NotificationToast
          notifications={notifications}
          onDismiss={removeNotification}
        />
      </div>
    </LanguageProvider>
  );
}

// Protected route wrapper
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="w-full h-[100dvh] flex items-center justify-center bg-gradient-to-br from-purple-900 via-blue-900 to-black">
        <div className="text-white text-xl">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

// App content with routing
function AppContent() {
  return (
    <BrowserRouter basename="/chatbot">
      <Routes>
        {/* Smart Login Router - auto-detects local vs external access */}
        <Route path="/login" element={<LoginRouter />} />

        {/* Direct access to specific login types */}
        <Route path="/login/modern" element={<ModernLogin />} />
        <Route path="/login/legacy" element={<Login />} />

        {/* Modern Auth Routes */}
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/verify-email-sent" element={<VerifyEmailSent />} />
        <Route path="/auth/google/callback" element={<GoogleCallback />} />

        {/* Protected Routes */}
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <MainChat />
            </ProtectedRoute>
          }
        />
        <Route
          path="/review-specs/:projectNumber/:documentId"
          element={
            <ProtectedRoute>
              <SpecReview />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin"
          element={
            <ProtectedRoute>
              <AdminPanel />
            </ProtectedRoute>
          }
        />
        <Route
          path="/upgrade"
          element={
            <ProtectedRoute>
              <UpgradePage />
            </ProtectedRoute>
          }
        />
        {/* Deep link: /chatbot/project/session_<token> */}
        <Route
          path="/project/:sessionToken"
          element={
            <ProtectedRoute>
              <ProjectSessionDeepLink />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

// Main App wrapper with providers
export function App() {
  return (
    <AuthProvider>
      <LanguageProvider>
        <ThemeProvider>
          <AppContent />
        </ThemeProvider>
      </LanguageProvider>
    </AuthProvider>
  );
}

export default App;
