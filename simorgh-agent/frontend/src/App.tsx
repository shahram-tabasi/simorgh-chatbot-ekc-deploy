import React from 'react';
import { StarryBackground } from './components/StarryBackground';
import { Sidebar } from './components/Sidebar';
import { ProjectTree } from './components/ProjectTree';
import { HistoryList } from './components/HistoryList';
import { ChatArea } from './components/ChatArea';
import SettingsPanel from './components/SettingsPanel';
import CreateProjectModal from './components/CreateProjectModal';
import CreateChatModal from './components/CreateChatModal';
import Login from './components/Login';
import { useSidebar } from './hooks/useSidebar';
import { useProjects } from './hooks/useProjects';
import { useChat } from './hooks/useChat';
import { LanguageProvider } from './context/LanguageContext';
import { AuthProvider, useAuth } from './context/AuthContext';

// Main app content component (uses auth context)
function AppContent() {
  const { isAuthenticated, isLoading } = useAuth();
  const rightSidebar = useSidebar(true);
  const leftSidebar = useSidebar(true);
  const [showCreateModal, setShowCreateModal] = React.useState(false);
  const [showChatModal, setShowChatModal] = React.useState(false);

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
    toggleProject,
    toggleGeneralChats,
    selectChat
  } = useProjects();

  const { messages, isTyping, sendMessage } = useChat(
    activeChat?.messages || [],
    activeChatId
  );

  const handleCreateProject = () => setShowCreateModal(true);

  const handleCreateChat = (projectId: string, title: string) => {
    createChat(projectId, title);
  };

  const handleCreateGeneralChat = (title: string) => {
    createGeneralChat(title);
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
            onNewGeneralChat={() => setShowChatModal(true)}
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
              onCreateGeneralChat={() => setShowChatModal(true)}
            />
          </Sidebar>

          {/* چت اصلی */}
          <div className="flex-1 flex flex-col">
            <ChatArea
              messages={messages}
              isTyping={isTyping}
              onSendMessage={sendMessage}
              disabled={!activeChat}
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

        {/* مودال ساخت چت جدید */}
        <CreateChatModal
          isOpen={showChatModal}
          onClose={() => setShowChatModal(false)}
          onCreate={(title) => {
            handleCreateGeneralChat(title);
            setShowChatModal(false);
          }}
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