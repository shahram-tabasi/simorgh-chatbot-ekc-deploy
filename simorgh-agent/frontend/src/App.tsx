import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeBackground } from './components/ThemeBackground';
import { Sidebar } from './components/Sidebar';
import { ProjectTree } from './components/ProjectTree';
import { HistoryList } from './components/HistoryList';
import { ChatArea } from './components/ChatArea';
import SettingsPanel from './components/SettingsPanel';
import MobileHeader from './components/MobileHeader';
import CreateProjectWizard from './components/CreateProjectWizard';
import ProjectSessionDeepLink from './pages/ProjectSessionDeepLink';
import CreateProjectChatModal from './components/CreateProjectChatModal';
import Login from './components/Login';
import SpecTaskNotification from './components/SpecTaskNotification';
import NotificationToast, { ToastNotification } from './components/NotificationToast';
import { subscribeNotify } from './services/notifyBus';
import SpecReview from './pages/SpecReview';
import AdminPanel from './pages/AdminPanel';
import UpgradePage from './pages/UpgradePage';
// QuotaRing (the big sidebar tile) was replaced by QuotaIndicator —
// a small ring + popover that lives in the sidebar header next to
// the wordmark. Keeping the import path here as a breadcrumb in case
// someone wants to bring the tile back; the symbol is no longer
// referenced.
import { QuotaIndicator } from './components/QuotaIndicator';
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
  const [currentAiMode, setCurrentAiMode] = React.useState<'online' | 'offline'>('offline');

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
    archiveChat,
    toggleProject,
    toggleGeneralChats,
    selectChat,
    ensureSessionChat,
  } = useProjects(userId);

  // Get projectNumber for chat
  const projectNumber = activeProjectId || null;

  // Active project row for the header chip (repo/branch context).
  const activeProject = React.useMemo(
    () => projects.find(p => p.id === activeProjectId) || null,
    [projects, activeProjectId]
  );
  const defaultModel = (import.meta.env.VITE_DEFAULT_MODEL as string | undefined) || 'SimorghAI-model';

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

  // Broad "stream still alive" flag for project-chat sidebar status.
  // useChat flips isTyping false at first event but CoT can stream
  // for tens of seconds after. Project status icon and ChatInput Stop
  // both need to stay live for the whole duration — same derivation
  // as ChatArea.isActivelyGenerating but lifted to App so ProjectTree
  // can react too.
  const isActivelyStreaming = React.useMemo(() => {
    if (isTyping) return true;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'assistant') continue;
      return Boolean((m.metadata as any)?.streaming);
    }
    return false;
  }, [isTyping, messages]);

  // Load AI mode on mount and listen for changes
  // Modern users are forced to online mode (offline is legacy-only)
  // LLM mode: default OFFLINE for everyone (general chat always
  // uses the local gpt-oss-20b via hr_chat.py; this setting controls
  // project chat only). Previous version forced modern users to
  // 'online' on every mount — that pre-dated the HR direct-RAG path
  // and was the reason the operator's online/offline toggle had no
  // effect ("always work via offline"). Removed.
  React.useEffect(() => {
    const savedMode = localStorage.getItem('llm_mode') as 'online' | 'offline' | null;
    setCurrentAiMode(savedMode ?? 'offline');

    const handleModeChange = (e: Event) => {
      const customEvent = e as CustomEvent<'online' | 'offline'>;
      setCurrentAiMode(customEvent.detail);
    };
    window.addEventListener('llm-mode-changed', handleModeChange);
    return () => window.removeEventListener('llm-mode-changed', handleModeChange);
  }, []);

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

  // Auto-create an empty general chat the first time a modern user
  // lands on the chatbot with no active selection. Lets the operator
  // tap a Persian HR prompt and have it sent straight to the LLM —
  // without that chat we'd have no chatId for useChat.sendMessage().
  // Legacy/TPMS users are skipped (they use project chats only).
  //
  // Important: useProjects re-creates `selectChat`/`createGeneralChat`
  // refs on every render and `generalChats` is a fresh array after
  // any setState. Depending on those would fire this effect dozens of
  // times per render cycle on slower Android Chrome devices (was
  // observed as a "freeze" on the entry page). We instead depend on
  // primitives only (userId, activeChatId, generalChats.length) and
  // read the latest refs through useRef + a tracking effect — so the
  // body still sees current data but doesn't re-run on identity churn.
  const autoCreatedRef = React.useRef(false);
  const autoCreateDepsRef = React.useRef({
    selectChat,
    generalChats,
    createGeneralChatFn: handleCreateGeneralChat,
  });
  React.useEffect(() => {
    autoCreateDepsRef.current = {
      selectChat,
      generalChats,
      createGeneralChatFn: handleCreateGeneralChat,
    };
  });
  React.useEffect(() => {
    if (autoCreatedRef.current) return;
    if (!user || !userId) return;
    if (isLegacyUser(user)) return;
    if (activeChatId) {
      // Some other path (history selector, deep link) already picked a
      // chat — count that as the entry chat and stop auto-creating.
      autoCreatedRef.current = true;
      return;
    }
    // Deep-link landing: /chatbot/project/<token> stashes a pending
    // session in sessionStorage. Let the deep-link effect resolve it
    // first instead of racing it with a brand-new general chat.
    const params = new URLSearchParams(window.location.search);
    if (params.get('session') || sessionStorage.getItem('simorgh_pending_session')) {
      return;
    }
    const { selectChat: pickChat, generalChats: chats, createGeneralChatFn } =
      autoCreateDepsRef.current;
    // If the operator already has general chats, surface the most
    // recent one instead of spamming a brand new row on every reload.
    if (chats.length > 0) {
      autoCreatedRef.current = true;
      pickChat(null, chats[0].id);
      return;
    }
    autoCreatedRef.current = true;
    createGeneralChatFn();
    // Intentionally NOT depending on selectChat / generalChats / the
    // handler — the .length primitive is enough to wake us when chats
    // finish loading, and the ref carries the latest function refs.
  }, [user, userId, activeChatId, generalChats.length]);

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

  // SignalR-style hub: any component can call notify(...) and we pipe
  // it into the same NotificationToast queue. Re-emitting with the same
  // `key` updates the live toast (useful for progress bars).
  React.useEffect(() => {
    if (!notificationsEnabled) return;
    return subscribeNotify((ev) => {
      setNotifications((prev) => {
        const existingIdx = ev.key ? prev.findIndex((n) => n.id === ev.key) : -1;
        const next: ToastNotification = {
          id:        ev.key || ev.id,
          message:   ev.message,
          timestamp: Date.now(),
          type:      ev.type,
          title:     ev.title,
          progress:  ev.progress,
          timeoutMs: ev.timeoutMs,
        };
        if (existingIdx >= 0) {
          const copy = [...prev];
          copy[existingIdx] = next;
          return copy;
        }
        return [...prev, next];
      });
    });
  }, [notificationsEnabled]);

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

  // Initial-mount header bootstrap. The /users/{id}/project-chats
  // endpoint returns chat rows without per-chat repo context, so when
  // the app boots straight onto a project chat (refresh, deep link, or
  // wizard creation) the header bar above the chat input has no
  // repo/branch/diff to render — it only appeared after the operator
  // clicked a chat in the sidebar, which fires selectChat() and pulls
  // the session message ctx. This effect runs that fetch once per
  // (project, chat) the first time we land on it without repo data,
  // so the header renders on initial mount too.
  const headerBootstrapRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!activeProjectId || !activeChatId) return;
    // Wait until activeProject is actually loaded into the projects
    // array. If we fire selectChat() before this, the setProjects
    // callback inside it can't find the row to update and the repo
    // data is silently dropped — the original bug the operator
    // hit ("only shows after switch chats").
    if (!activeProject) return;
    if (activeProject.repoPath || activeProject.workingBranch) return;
    const key = `${activeProjectId}::${activeChatId}`;
    if (headerBootstrapRef.current === key) return;
    headerBootstrapRef.current = key;
    selectChat(activeProjectId, activeChatId);
  }, [activeProjectId, activeChatId, activeProject,
      activeProject?.repoPath, activeProject?.workingBranch, selectChat]);

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
      // Optimistic local decrement so the ring nudges down the
      // moment the user sends. Server reconciliation happens
      // automatically when the stream completes — useQuota
      // listens for the `simorgh-message-streamed` CustomEvent
      // that useChat dispatches in onDone, fetches
      // /api/v2/quota/me, and corrects the local count to the
      // server truth. The previous 800ms-timer reconciliation
      // raced the backend's increment (HR direct-RAG can take
      // 5-30s for long answers) and snapped the optimistic
      // decrement back to the pre-increment count — operator
      // report May 2026: "quota still not work".
      if (isModernTier) {
        decrementLocal();
      }
    }
  }, [editingMessage, editMessage, sendMessage, isModernTier, decrementLocal]);

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

        {/* Top padding on mobile reserves room for the fixed MobileHeader
            (h-14 + iOS safe area) so the first chat message and the
            sidebar drawers don't get hidden behind it. md+ doesn't
            render the mobile header so the offset is reset to 0. */}
        <div className="relative z-10 flex h-full overflow-hidden pt-[calc(3.5rem+env(safe-area-inset-top))] md:pt-0">
          {/* سایدبار راست */}
          <Sidebar
            isOpen={rightSidebar.isOpen}
            onToggle={rightSidebar.toggle}
            side="right"
            onNewProject={canCreateProjects ? handleCreateProject : undefined}
            // Legacy users get project-only chat: hide the "new general chat" entry point.
            onNewGeneralChat={user && isLegacyUser(user) ? undefined : handleCreateGeneralChat}
            // Quota lives in the ChatInput footer (next to "Simorgh
            // AI") since the May-2026 follow-up — see the
            // quotaIndicator prop passed to <ChatArea> below.
            // headerExtra remains a sidebar extension point but is
            // unused here.
          >
            <ProjectTree
              projects={displayProjects}
              // Hide general chats entirely for legacy users — project chat only.
              generalChats={user && isLegacyUser(user) ? [] : generalChats}
              activeProjectId={activeProjectId}
              activeChatId={activeChatId}
              showGeneralChats={user && isLegacyUser(user) ? false : showGeneralChats}
              isStreaming={isActivelyStreaming}
              streamingProjectId={isActivelyStreaming ? activeProjectId : null}
              onToggleProject={toggleProject}
              onToggleGeneralChats={toggleGeneralChats}
              onSelectChat={handleSelectChat}
              onCreateProject={handleCreateProject}
              onCreateChat={handleCreateChat}
              onCreateGeneralChat={user && isLegacyUser(user) ? undefined as any : handleCreateGeneralChat}
              onRenameChat={renameChat}
              onDeleteChat={deleteChat}
              onDeleteProject={deleteProject}
              onArchiveChat={archiveChat}
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
              activeChatId={activeChatId}
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
              // Quota ring next to "Simorgh AI" in the composer
              // footer (issue #2 follow-up, May 2026). Only rendered
              // for modern users; legacy users fall through to the
              // idle typing-pulse spinner. `placement='top'` because
              // the composer sits at the bottom of the viewport and
              // a downward popover would clip below the screen.
              quotaIndicator={
                isModernTier ? (
                  <QuotaIndicator
                    used={quota.questions_used_today}
                    total={quota.questions_limit}
                    remaining={quota.questions_remaining}
                    tier={quota.user_role}
                    resetsAt={quota.resets_at}
                    unlimited={quota.user_role === 'admin' || quota.user_role === 'max'}
                    placement="top"
                  />
                ) : null
              }
              headerContext={
                activeProject
                  ? {
                      repoPath: activeProject.repoPath || null,
                      workingBranch: activeProject.workingBranch || null,
                      baseBranch: activeProject.baseBranch || null,
                      projectName: activeProject.name,
                      projectId: activeProject.id,
                      model: defaultModel,
                      filesChanged: typeof activeProject.filesChangedCount === 'number'
                        ? activeProject.filesChangedCount
                        : null,
                    }
                  : null
              }
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
          // General chat hard-pins to local Simorgh AI server-side
          // (hr_chat.py); disable the Online tile in the picker when
          // a general chat is active so the setting can't suggest
          // otherwise.
          isGeneralChatActive={!!activeChatId && activeProjectId === null}
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
