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
  const { isAuthenticated, isLoading, user } = useAuth();
  const rightSidebar = useSidebar(true);
  const leftSidebar = useSidebar(false);
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
  } = useProjects(user?.EMPUSERNAME);

  // Get userId and projectNumber for chat
  const userId = user?.EMPUSERNAME;
  const projectNumber = activeProjectId || null;

  const { messages, isTyping, sendMessage } = useChat(
    activeChat?.messages || [],
    activeChatId,
    userId,
    projectNumber
  );

  // Wrapper to auto-create chat if none selected
  const handleSendMessage = async (content: string, files?: any, options?: any) => {
    // If no chat is selected, create a new general chat first
    if (!activeChatId && userId) {
      console.log('📝 No chat selected, creating new general chat...');
      const newChatId = await createGeneralChat('New Chat');

      if (newChatId) {
        console.log('✅ Chat created, sending message...');
        // The state will be updated by createGeneralChat, and React will re-render
        // On next render, activeChatId will be set and message can be sent
        // We'll queue the message to be sent after state updates
        setTimeout(() => {
          sendMessage(content, files, options);
        }, 200);
      } else {
        console.error('❌ Failed to create chat');
      }
    } else {
      sendMessage(content, files, options);
    }
  };

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
              onSendMessage={handleSendMessage}
              disabled={false}
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