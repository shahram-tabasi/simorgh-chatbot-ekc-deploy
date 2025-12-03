import { useState, useEffect } from 'react';
import { Project, Chat, Message } from '../types';
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const initialProjects: Project[] = [];

export function useProjects(userId?: string) {
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [generalChats, setGeneralChats] = useState<Chat[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [showGeneralChats, setShowGeneralChats] = useState(true);

  // Load data from backend and localStorage on mount (per user)
  // CRITICAL: Reset state when userId changes (user logout/login)
  useEffect(() => {
    // Reset all state when userId changes or becomes null
    setProjects([]);
    setGeneralChats([]);
    setActiveProjectId(null);
    setActiveChatId(null);
    setShowGeneralChats(true);

    if (!userId) {
      console.log('🔄 No userId - state cleared');
      return;
    }

    console.log('👤 Loading data for user:', userId);

    // Fetch general chats from backend
    const fetchGeneralChats = async () => {
      try {
        const token = localStorage.getItem('simorgh_token');
        if (!token) {
          console.warn('⚠️ No auth token, skipping backend sync');
          return;
        }

        const response = await axios.get(`${API_BASE}/users/${userId}/general-chats`, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        const backendChats = response.data.chats.map((chat: any) => ({
          id: chat.chat_id,
          title: chat.chat_name,
          messages: [], // Messages loaded on demand
          createdAt: new Date(chat.created_at),
          updatedAt: new Date(chat.created_at),
          isGeneral: true
        }));

        setGeneralChats(backendChats);
        console.log(`✅ Loaded ${backendChats.length} general chats from backend`);

        // Save to localStorage as backup
        localStorage.setItem(`simorgh_general_chats_${userId}`, JSON.stringify(backendChats));
      } catch (error) {
        console.error('❌ Failed to fetch general chats from backend:', error);

        // Fallback to localStorage
        const savedGeneralChats = localStorage.getItem(`simorgh_general_chats_${userId}`);
        if (savedGeneralChats) {
          try {
            const parsed = JSON.parse(savedGeneralChats);
            setGeneralChats(parsed.map((c: any) => ({
              ...c,
              createdAt: new Date(c.createdAt),
              updatedAt: new Date(c.updatedAt),
              messages: []
            })));
            console.log('✅ Loaded general chats from localStorage (fallback)');
          } catch (e) {
            console.error('Failed to load general chats from localStorage:', e);
          }
        }
      }
    };

    fetchGeneralChats();

    // Load projects from localStorage (for now - can be enhanced to fetch from backend)
    const savedProjects = localStorage.getItem(`simorgh_projects_${userId}`);
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
            messages: []
          }))
        })));
      } catch (e) {
        console.error('Failed to load projects:', e);
      }
    }
  }, [userId]);

  // Save projects to localStorage (per user)
  useEffect(() => {
    if (!userId) return;
    if (projects.length > 0) {
      localStorage.setItem(`simorgh_projects_${userId}`, JSON.stringify(projects));
    }
  }, [projects, userId]);

  // Save general chats to localStorage (per user)
  useEffect(() => {
    if (!userId) return;
    if (generalChats.length > 0) {
      localStorage.setItem(`simorgh_general_chats_${userId}`, JSON.stringify(generalChats));
    }
  }, [generalChats, userId]);

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

  const createChat = async (projectId: string, pageName: string) => {
    if (!userId) {
      console.error('Cannot create chat: userId missing');
      return;
    }

    try {
      // Get auth token
      const token = localStorage.getItem('simorgh_token');
      if (!token) {
        console.error('❌ No auth token found');
        return;
      }

      // Create project chat in backend with page_name
      const response = await axios.post(`${API_BASE}/chats`, {
        chat_name: pageName,  // Use page_name as chat_name
        user_id: userId,
        chat_type: 'project',
        project_number: projectId,
        page_name: pageName  // New required field for project sessions
      }, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      const backendChatId = response.data.chat.chat_id;
      const projectName = response.data.chat.project_name || `Project ${projectId}`;

      const newChat: Chat = {
        id: backendChatId,
        title: pageName,  // Use page_name as title
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
      setActiveChatId(backendChatId);

      console.log('✅ Project chat created:', backendChatId, 'Project:', projectName, 'Page:', pageName);
    } catch (error: any) {
      console.error('❌ Failed to create project chat:', error);

      // Show error to user
      if (error.response?.status === 404) {
        alert(`Project ID ${projectId} not found in database`);
      } else if (error.response?.status === 403) {
        alert(`Access denied for project ${projectId}`);
      } else {
        alert(error.response?.data?.detail || 'Failed to create project chat');
      }
    }
  };

  const createGeneralChat = async (title: string = 'New Chat'): Promise<string | null> => {
    if (!userId) {
      console.error('Cannot create chat: userId missing');
      return null;
    }

    try {
      // Get auth token
      const token = localStorage.getItem('simorgh_token');
      if (!token) {
        console.error('❌ No auth token found');
        return null;
      }

      // Create chat in backend
      const response = await axios.post(`${API_BASE}/chats`, {
        chat_name: title,
        user_id: userId,
        chat_type: 'general',
        project_number: null
      }, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      const backendChatId = response.data.chat.chat_id;

      const newChat: Chat = {
        id: backendChatId,
        title,
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        isGeneral: true
      };

      setGeneralChats(prev => [newChat, ...prev]);
      setActiveChatId(backendChatId);
      setActiveProjectId(null);

      // Update localStorage
      const updatedChats = [newChat, ...generalChats];
      localStorage.setItem(`simorgh_general_chats_${userId}`, JSON.stringify(updatedChats));

      console.log('✅ General chat created:', backendChatId);
      return backendChatId;
    } catch (error) {
      console.error('❌ Failed to create general chat:', error);
      // Fallback to local-only chat if backend fails
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
      return chatId;
    }
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