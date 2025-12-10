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
          messages: [], // Messages will be loaded below
          createdAt: new Date(chat.created_at),
          updatedAt: new Date(chat.created_at),
          isGeneral: true
        }));

        setGeneralChats(backendChats);
        console.log(`✅ Loaded ${backendChats.length} general chats from backend`);

        // Save to localStorage as backup
        localStorage.setItem(`simorgh_general_chats_${userId}`, JSON.stringify(backendChats));

        // 🔥 AUTO-LOAD MOST RECENT CHAT
        if (backendChats.length > 0) {
          const mostRecentChat = backendChats[0]; // Already sorted by backend
          console.log('🚀 Auto-loading most recent chat:', mostRecentChat.id);

          // Set as active immediately
          setActiveChatId(mostRecentChat.id);
          setActiveProjectId(null);

          // Load chat history
          try {
            const chatResponse = await axios.get(`${API_BASE}/chats/${mostRecentChat.id}`, {
              headers: { 'Authorization': `Bearer ${token}` }
            });

            const messages = chatResponse.data.messages || [];
            console.log(`✅ Auto-loaded ${messages.length} messages for chat ${mostRecentChat.id}`);

            // Update chat with messages
            setGeneralChats(prev =>
              prev.map(c =>
                c.id === mostRecentChat.id
                  ? {
                      ...c,
                      messages: messages.map((m: any) => ({
                        id: m.timestamp || Date.now().toString(),
                        content: m.content,
                        role: m.role,
                        timestamp: new Date(m.timestamp),
                        metadata: m.metadata
                      }))
                    }
                  : c
              )
            );
          } catch (error) {
            console.error('❌ Failed to auto-load chat history:', error);
          }
        }
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

    // Fetch projects from backend (with project chats)
    const fetchProjects = async () => {
      try {
        const token = localStorage.getItem('simorgh_token');
        if (!token) {
          console.warn('⚠️ No auth token, skipping projects fetch');
          return;
        }

        // Fetch all user's project chats from backend
        const projectChatsResponse = await axios.get(`${API_BASE}/users/${userId}/project-chats`, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        const backendProjectChats = projectChatsResponse.data.chats || [];
        console.log(`✅ Loaded ${backendProjectChats.length} project chats from backend`);

        // Group chats by project
        const projectsMap = new Map<string, any>();

        for (const chat of backendProjectChats) {
          const projectId = chat.project_number || chat.project_id_main;
          const projectName = chat.project_name || `Project ${projectId}`;

          if (!projectsMap.has(projectId)) {
            projectsMap.set(projectId, {
              id: projectId,
              name: projectName,
              chats: [],
              createdAt: new Date(chat.created_at),
              isExpanded: false
            });
          }

          const project = projectsMap.get(projectId);
          project.chats.push({
            id: chat.chat_id,
            title: chat.chat_name,
            messages: [],
            createdAt: new Date(chat.created_at),
            updatedAt: new Date(chat.created_at),
            projectId: projectId
          });

          // Update project createdAt to earliest chat
          if (new Date(chat.created_at) < project.createdAt) {
            project.createdAt = new Date(chat.created_at);
          }
        }

        // Convert map to array and sort by creation date (newest first)
        const backendProjects = Array.from(projectsMap.values())
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        setProjects(backendProjects);
        console.log(`✅ Loaded ${backendProjects.length} projects from backend`);

        // Save to localStorage as backup
        localStorage.setItem(`simorgh_projects_${userId}`, JSON.stringify(backendProjects));

      } catch (error) {
        console.error('❌ Failed to fetch projects from backend:', error);

        // Fallback to localStorage
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
            console.log('✅ Loaded projects from localStorage (fallback)');
          } catch (e) {
            console.error('Failed to load projects from localStorage:', e);
          }
        }
      }
    };

    fetchProjects();
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

  const createProject = async (oenum: string, name: string, firstPageTitle: string) => {
    if (!userId) {
      console.error('Cannot create project: userId missing');
      return;
    }

    try {
      const token = localStorage.getItem('simorgh_token');
      if (!token) {
        console.error('❌ No auth token found');
        alert('Authentication required. Please log in again.');
        return;
      }

      // Create project in Neo4j via backend
      console.log('📤 Creating TPMS project:', oenum, name);
      const projectResponse = await axios.post(`${API_BASE}/projects`, {
        project_number: oenum,
        project_name: name,
        client: '',
        contract_number: '',
        contract_date: '',
        description: ''
      }, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      console.log('✅ Project created in Neo4j:', projectResponse.data);

      // Create first page/chat for the project
      const chatResponse = await axios.post(`${API_BASE}/chats`, {
        chat_name: firstPageTitle,
        user_id: userId,
        chat_type: 'project',
        project_number: oenum,
        page_name: firstPageTitle
      }, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      const chatId = chatResponse.data.chat.chat_id;

      // Add to local state
      const newChat: Chat = {
        id: chatId,
        title: firstPageTitle,
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        projectId: oenum
      };

      const newProject: Project = {
        id: oenum,  // Use OENUM as project ID
        name,
        chats: [newChat],
        createdAt: new Date(),
        isExpanded: true
      };

      setProjects(prev => [newProject, ...prev]);
      setActiveProjectId(oenum);
      setActiveChatId(chatId);

      console.log('✅ Project and first page created successfully');
      alert(`Project "${name}" created successfully!`);
    } catch (error: any) {
      console.error('❌ Failed to create project:', error);
      if (error.response?.status === 400 && error.response?.data?.detail?.includes('already exists')) {
        alert(error.response.data.detail);
      } else {
        alert(error.response?.data?.detail || 'Failed to create project. Please try again.');
      }
    }
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

      // Create project page/chat in backend
      const response = await axios.post(`${API_BASE}/chats`, {
        chat_name: pageName,
        user_id: userId,
        chat_type: 'project',
        project_number: projectId,  // projectId is OENUM
        page_name: pageName
      }, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      const backendChatId = response.data.chat.chat_id;
      const projectName = response.data.chat.project_name || `Project ${projectId}`;

      const newChat: Chat = {
        id: backendChatId,
        title: pageName,
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

      console.log('✅ Project page created:', backendChatId, 'Project:', projectName, 'Page:', pageName);
    } catch (error: any) {
      console.error('❌ Failed to create project page:', error);

      // Show error to user
      if (error.response?.status === 404) {
        alert(`Project ${projectId} not found in database`);
      } else if (error.response?.status === 403) {
        alert(`Access denied for project ${projectId}`);
      } else {
        alert(error.response?.data?.detail || 'Failed to create project page');
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
      // Project chat - update in projects
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
      // General chat - update in generalChats
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

  const selectChat = async (projectId: string | null, chatId: string) => {
    setActiveProjectId(projectId);
    setActiveChatId(chatId);

    // Fetch chat history from backend when selecting a chat
    if (!userId || !chatId) return;

    try {
      const token = localStorage.getItem('simorgh_token');
      if (!token) {
        console.warn('⚠️ No auth token, skipping chat history fetch');
        return;
      }

      console.log('📥 Loading chat history for:', chatId);

      const response = await axios.get(`${API_BASE}/chats/${chatId}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      const messages = response.data.messages || [];
      const chatMetadata = response.data.chat || {};

      console.log(`✅ Loaded ${messages.length} messages for chat ${chatId}`);

      // Update chat with loaded messages and latest metadata
      if (projectId !== null) {
        // Project chat
        setProjects(prev =>
          prev.map(p =>
            p.id === projectId
              ? {
                  ...p,
                  chats: p.chats.map(c =>
                    c.id === chatId
                      ? {
                          ...c,
                          title: chatMetadata.chat_name || c.title,
                          messages: messages.map((m: any) => ({
                            id: m.timestamp || Date.now().toString(),
                            content: m.content,
                            role: m.role,
                            timestamp: new Date(m.timestamp),
                            metadata: m.metadata
                          })),
                          updatedAt: new Date()
                        }
                      : c
                  )
                }
              : p
          )
        );
      } else {
        // General chat
        setGeneralChats(prev =>
          prev.map(c =>
            c.id === chatId
              ? {
                  ...c,
                  title: chatMetadata.chat_name || c.title,
                  messages: messages.map((m: any) => ({
                    id: m.timestamp || Date.now().toString(),
                    content: m.content,
                    role: m.role,
                    timestamp: new Date(m.timestamp),
                    metadata: m.metadata
                  })),
                  updatedAt: new Date()
                }
              : c
          )
        );
      }
    } catch (error) {
      console.error('❌ Failed to load chat history:', error);
    }
  };

  const updateChatTitle = (chatId: string, newTitle: string) => {
    // Update title in general chats
    setGeneralChats(prev =>
      prev.map(c =>
        c.id === chatId
          ? { ...c, title: newTitle, updatedAt: new Date() }
          : c
      )
    );

    // Update title in project chats
    setProjects(prev =>
      prev.map(p => ({
        ...p,
        chats: p.chats.map(c =>
          c.id === chatId
            ? { ...c, title: newTitle, updatedAt: new Date() }
            : c
        )
      }))
    );

    console.log(`✅ Updated chat title: ${chatId} -> "${newTitle}"`);
  };

  const renameChat = async (chatId: string, newName: string, projectId: string | null) => {
    if (!userId) {
      console.error('Cannot rename chat: userId missing');
      return;
    }

    try {
      const token = localStorage.getItem('simorgh_token');
      if (!token) {
        console.error('❌ No auth token found');
        return;
      }

      // Call backend rename endpoint (if exists, otherwise just update locally)
      // For now, update locally and in backend metadata
      await axios.patch(
        `${API_BASE}/chats/${chatId}`,
        { chat_name: newName },
        { headers: { 'Authorization': `Bearer ${token}` } }
      );

      // Update UI
      if (projectId !== null) {
        // Project chat
        setProjects(prev =>
          prev.map(p =>
            p.id === projectId
              ? {
                  ...p,
                  chats: p.chats.map(c =>
                    c.id === chatId ? { ...c, title: newName } : c
                  )
                }
              : p
          )
        );
      } else {
        // General chat
        setGeneralChats(prev =>
          prev.map(c =>
            c.id === chatId ? { ...c, title: newName } : c
          )
        );
      }

      console.log('✅ Chat renamed:', chatId, '->', newName);
    } catch (error: any) {
      console.error('❌ Failed to rename chat:', error);
      alert(error.response?.data?.detail || 'Failed to rename chat');
    }
  };

  const deleteChat = async (chatId: string, projectId: string | null) => {
    if (!userId) {
      console.error('Cannot delete chat: userId missing');
      return;
    }

    if (!confirm('Are you sure you want to delete this chat? This action cannot be undone.')) {
      return;
    }

    try {
      const token = localStorage.getItem('simorgh_token');
      if (!token) {
        console.error('❌ No auth token found');
        return;
      }

      // Call backend delete endpoint
      await axios.delete(`${API_BASE}/chats/${chatId}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      // Remove from UI
      if (projectId !== null) {
        // Project chat
        setProjects(prev =>
          prev.map(p =>
            p.id === projectId
              ? { ...p, chats: p.chats.filter(c => c.id !== chatId) }
              : p
          )
        );
      } else {
        // General chat
        setGeneralChats(prev => prev.filter(c => c.id !== chatId));
      }

      // Clear active chat if it was deleted
      if (activeChatId === chatId) {
        setActiveChatId(null);
        setActiveProjectId(null);
      }

      console.log('✅ Chat deleted:', chatId);
    } catch (error: any) {
      console.error('❌ Failed to delete chat:', error);
      alert(error.response?.data?.detail || 'Failed to delete chat');
    }
  };

  const deleteProject = async (projectId: string) => {
    if (!userId) {
      console.error('Cannot delete project: userId missing');
      return;
    }

    // Find project name for confirmation
    const project = projects.find(p => p.id === projectId);
    if (!project) {
      console.error('Project not found:', projectId);
      return;
    }

    // Confirmation dialog
    if (!confirm(`Are you sure you want to delete project "${project.name}" from your chatbot?\n\nThis will:\n- Delete the project from your project list\n- Delete all chat history for this project\n- Remove all project data from backend\n\nNote: The project structure will remain in Neo4j database. You can re-add it later if needed.\n\nThis action cannot be undone.`)) {
      return;
    }

    try {
      const token = localStorage.getItem('simorgh_token');
      if (!token) {
        console.error('❌ No auth token found');
        alert('Authentication required. Please log in again.');
        return;
      }

      // Delete all project chats from backend
      console.log('🗑️ Deleting all chats for project:', projectId);
      const response = await axios.delete(`${API_BASE}/projects/${projectId}/chats`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      console.log(`✅ Backend deletion result:`, response.data);

      // Remove from local state
      const updatedProjects = projects.filter(p => p.id !== projectId);
      setProjects(updatedProjects);

      // Update localStorage to persist deletion
      localStorage.setItem(`simorgh_projects_${userId}`, JSON.stringify(updatedProjects));

      // Clear active project if it was deleted
      if (activeProjectId === projectId) {
        setActiveChatId(null);
        setActiveProjectId(null);
      }

      const deletedCount = response.data.deleted_count || 0;
      console.log(`✅ Project deleted: ${projectId} (${deletedCount} chats removed)`);
      alert(`Project "${project.name}" has been deleted.\n${deletedCount} chat(s) removed from backend.`);

    } catch (error: any) {
      console.error('❌ Failed to delete project from backend:', error);

      // Show error to user
      const errorMessage = error.response?.data?.detail || 'Failed to delete project from backend';
      alert(`Error: ${errorMessage}\n\nThe project was not deleted.`);
    }
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
    updateChatTitle,
    renameChat,
    deleteChat,
    deleteProject,
    toggleProject,
    toggleGeneralChats,
    selectChat
  };
}