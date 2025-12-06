import React from 'react';
import { StarryBackground } from './components/StarryBackground';
import { Sidebar } from './components/Sidebar';
import { ProjectTree } from './components/ProjectTree';
import { HistoryList } from './components/HistoryList';
import { ChatArea } from './components/ChatArea';
import SettingsPanel from './components/SettingsPanel';
import CreateProjectModal from './components/CreateProjectModal';
import CreateChatModal from './components/CreateChatModal';
import CreateProjectChatModal from './components/CreateProjectChatModal';
import Login from './components/Login';
import { useSidebar } from './hooks/useSidebar';
import { useProjects } from './hooks/useProjects';
import { useChat } from './hooks/useChat';
import { LanguageProvider } from './context/LanguageContext';
import { AuthProvider, useAuth } from './context/AuthContext';

// Main app content component (uses auth context)
function AppContent() {
  const { isAuthenticated, isLoading, user } = useAuth();
  const rightSidebar = useSidebar(true);
  const leftSidebar = useSidebar(false);
  const [showCreateModal, setShowCreateModal] = React.useState(false);
  const [showChatModal, setShowChatModal] = React.useState(false);
  const [showProjectChatModal, setShowProjectChatModal] = React.useState(false);
  const [selectedProjectForChat, setSelectedProjectForChat] = React.useState<string | null>(null);

  const {
    projects,
    generalChats,
    activeProjectId,
    activeChatId,
    activeChat,
    showGeneralChats,
    createProject,
    createChat,
    createGeneralChat,
    updateChatTitle,
    renameChat,
    deleteChat,
    deleteProject,
    toggleProject,
    toggleGeneralChats,
    selectChat
  } = useProjects(user?.EMPUSERNAME);

  // Get userId and projectNumber for chat
  const userId = user?.EMPUSERNAME;
  const projectNumber = activeProjectId || null;

  const { messages, isTyping, sendMessage } = useChat(
    activeChat?.messages || [],
    activeChatId,
    userId,
    projectNumber,
    updateChatTitle
  );

  const handleCreateProject = () => setShowCreateModal(true);

  const handleCreateChat = (projectId: string, projectName: string, pageName: string) => {
    // projectName is for display/validation only, not passed to createChat
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

  // Show loading state while checking authentication
  if (isLoading) {
    return (
      <div className="w-full h-screen flex items-center justify-center bg-gradient-to-br from-purple-900 via-blue-900 to-black">
        <div className="text-white text-xl">Loading...</div>
      </div>
    );
  }

  // Show login if not authenticated
  if (!isAuthenticated) {
    return <Login />;
  }

  return (
    <LanguageProvider>
      <div className="w-full h-screen overflow-hidden relative bg-[#0a0e27]">
        <StarryBackground />

        <div className="relative z-10 flex h-full">
          {/* سایدبار راست */}
          <Sidebar
            isOpen={rightSidebar.isOpen}
            onToggle={rightSidebar.toggle}
            side="right"
            onNewProject={handleCreateProject}
            onNewGeneralChat={handleCreateGeneralChat}
          >
            <ProjectTree
              projects={displayProjects}
              generalChats={generalChats}
              activeProjectId={activeProjectId}
              activeChatId={activeChatId}
              showGeneralChats={showGeneralChats}
              onToggleProject={toggleProject}
              onToggleGeneralChats={toggleGeneralChats}
              onSelectChat={selectChat}
              onCreateProject={handleCreateProject}
              onCreateChat={handleCreateChat}
              onCreateGeneralChat={handleCreateGeneralChat}
              onRenameChat={renameChat}
              onDeleteChat={deleteChat}
              onDeleteProject={deleteProject}
            />
          </Sidebar>

          {/* چت اصلی */}
          <div className="flex-1 flex flex-col">
            <ChatArea
              messages={messages}
              isTyping={isTyping}
              onSendMessage={sendMessage}
              disabled={!activeChatId}
            />
          </div>

          {/* سایدبار چپ */}
          <Sidebar isOpen={leftSidebar.isOpen} onToggle={leftSidebar.toggle} side="left">
            <HistoryList projects={allProjectsForHistory} onSelectChat={selectChat} />
          </Sidebar>
        </div>

        {/* تنظیمات */}
        <SettingsPanel />

        {/* مودال ساخت پروژه */}
        <CreateProjectModal
          isOpen={showCreateModal}
          onClose={() => setShowCreateModal(false)}
          onCreate={(projectId, projectName, firstPageTitle) => {
            createProject(projectName, firstPageTitle);
            setShowCreateModal(false);
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
            handleCreateChat(projectId, projectName, pageName);
            setShowProjectChatModal(false);
            setSelectedProjectForChat(null);
          }}
          userId={userId}
        />
      </div>
    </LanguageProvider>
  );
}

// Main App wrapper with providers
export function App() {
  return (
    <AuthProvider>
      <LanguageProvider>
        <AppContent />
      </LanguageProvider>
    </AuthProvider>
  );
}

export default App;