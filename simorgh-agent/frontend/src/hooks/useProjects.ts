import { useState, useEffect } from 'react';
import { Project, Chat, Message } from '../types';

const initialProjects: Project[] = [];

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [generalChats, setGeneralChats] = useState<Chat[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [showGeneralChats, setShowGeneralChats] = useState(true);

  // Load data from localStorage on mount
  useEffect(() => {
    const savedProjects = localStorage.getItem('simorgh_projects');
    const savedGeneralChats = localStorage.getItem('simorgh_general_chats');
    
    if (savedProjects) {
      try {
        const parsed = JSON.parse(savedProjects);
        setProjects(parsed.map((p: any) => ({
          ...p,
          createdAt: new Date(p.createdAt),
          updatedAt: p.updatedAt ? new Date(p.updatedAt) : undefined,
          chats: p.chats.map((c: any) => ({
            ...c,
            createdAt: new Date(c.createdAt),
            updatedAt: new Date(c.updatedAt),
            messages: c.messages.map((m: any) => ({
              ...m,
              timestamp: new Date(m.timestamp)
            }))
          }))
        })));
      } catch (e) {
        console.error('Failed to load projects:', e);
      }
    }

    if (savedGeneralChats) {
      try {
        const parsed = JSON.parse(savedGeneralChats);
        setGeneralChats(parsed.map((c: any) => ({
          ...c,
          createdAt: new Date(c.createdAt),
          updatedAt: new Date(c.updatedAt),
          messages: c.messages.map((m: any) => ({
            ...m,
            timestamp: new Date(m.timestamp)
          }))
        })));
      } catch (e) {
        console.error('Failed to load general chats:', e);
      }
    }
  }, []);

  // Save projects to localStorage
  useEffect(() => {
    if (projects.length > 0) {
      localStorage.setItem('simorgh_projects', JSON.stringify(projects));
    }
  }, [projects]);

  // Save general chats to localStorage
  useEffect(() => {
    if (generalChats.length > 0) {
      localStorage.setItem('simorgh_general_chats', JSON.stringify(generalChats));
    }
  }, [generalChats]);

  const createProject = (name: string, firstPageTitle: string) => {
    const projectId = `proj-${Date.now()}`;
    const chatId = `chat-${Date.now()}`;

    const newChat: Chat = {
      id: chatId,
      title: firstPageTitle,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      projectId: projectId
    };

    const newProject: Project = {
      id: projectId,
      name,
      chats: [newChat],
      createdAt: new Date(),
      isExpanded: true
    };

    setProjects(prev => [newProject, ...prev]);
    setActiveProjectId(projectId);
    setActiveChatId(chatId);
  };

  const createChat = (projectId: string, title: string) => {
    const chatId = `chat-${Date.now()}`;
    const newChat: Chat = {
      id: chatId,
      title,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      projectId: projectId
    };

    setProjects(prev =>
      prev.map(p =>
        p.id === projectId
          ? { ...p, chats: [newChat, ...p.chats], updatedAt: new Date() }
          : p
      )
    );

    setActiveProjectId(projectId);
    setActiveChatId(chatId);
  };

  const createGeneralChat = (title: string = 'New Chat') => {
    const chatId = `gen-${Date.now()}`;
    const newChat: Chat = {
      id: chatId,
      title,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      isGeneral: true
    };

    setGeneralChats(prev => [newChat, ...prev]);
    setActiveChatId(chatId);
    setActiveProjectId(null);
  };

  const updateChatMessages = (chatId: string, messages: Message[]) => {
    if (activeProjectId) {
      setProjects(prev =>
        prev.map(p =>
          p.id === activeProjectId
            ? {
                ...p,
                chats: p.chats.map(c =>
                  c.id === chatId
                    ? { ...c, messages, updatedAt: new Date() }
                    : c
                ),
                updatedAt: new Date()
              }
            : p
        )
      );
    } else {
      setGeneralChats(prev =>
        prev.map(c =>
          c.id === chatId
            ? { ...c, messages, updatedAt: new Date() }
            : c
        )
      );
    }
  };

  const toggleProject = (projectId: string) => {
    setProjects(prev =>
      prev.map(p =>
        p.id === projectId ? { ...p, isExpanded: !p.isExpanded } : p
      )
    );
  };

  const toggleGeneralChats = () => {
    setShowGeneralChats(prev => !prev);
  };

  const selectChat = (projectId: string | null, chatId: string) => {
    setActiveProjectId(projectId);
    setActiveChatId(chatId);
  };

  const activeChat =
    activeProjectId !== null
      ? projects
          .find(p => p.id === activeProjectId)
          ?.chats.find(c => c.id === activeChatId)
      : generalChats.find(c => c.id === activeChatId);

  return {
    projects,
    generalChats,
    activeProjectId,
    activeChatId,
    activeChat,
    showGeneralChats,
    createProject,
    createChat,
    createGeneralChat,
    updateChatMessages,
    toggleProject,
    toggleGeneralChats,
    selectChat
  };
}