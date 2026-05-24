import { useState, useEffect, useCallback } from 'react';
import { Project, Chat, Message } from '../types';
import axios from 'axios';
import { showSuccess, showError, showInfo, showConfirm } from '../utils/alerts';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const initialProjects: Project[] = [];

// Type for sync progress
interface SyncProgress {
  oenum: string;
  status: 'in_progress' | 'success' | 'failed' | 'no_sync_data';
  current_step?: number;
  total_steps?: number;
  step_name?: string;
  progress_percent?: number;
  error?: string;
}

export function useProjects(userId?: string) {
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [generalChats, setGeneralChats] = useState<Chat[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [showGeneralChats, setShowGeneralChats] = useState(true);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);

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

            // Update chat with messages - use message_id for unique IDs
            setGeneralChats(prev =>
              prev.map(c =>
                c.id === mostRecentChat.id
                  ? {
                      ...c,
                      messages: messages.map((m: any, idx: number) => ({
                        id: m.message_id || `${m.timestamp}-${idx}` || `${Date.now()}-${idx}`,
                        content: m.content || m.text || '',
                        role: m.role || 'user',
                        timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
                        metadata: m.metadata || {}
                      }))
                    }
                  : c
              )
            );
            console.log(`✅ Messages populated in generalChats state: ${messages.length}`);
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

        // Group chats by project. CRITICAL: key on project_id_main
        // (the per-workspace UUID), NOT project_number. project_number
        // is the SOURCE OE / TPMS identifier and is shared across all
        // workspaces branched from the same source. Keying on it was
        // collapsing multiple distinct workspaces into one folder with
        // all chats commingled — the "project still collapsed in each
        // other" bug from the operator's punch list.
        const projectsMap = new Map<string, any>();

        for (const chat of backendProjectChats) {
          const projectId = chat.project_id_main || chat.project_number;
          const projectName = chat.project_name || `Project ${chat.project_number || projectId}`;

          if (!projectsMap.has(projectId)) {
            projectsMap.set(projectId, {
              id: projectId,
              name: projectName,
              // Keep project_number around as a display-only field (it's
              // the human-readable OE) so the sidebar can show e.g.
              // "test-ap05" while internally tracking by UUID.
              oeNumber: chat.project_number ?? null,
              chats: [],
              createdAt: new Date(chat.created_at),
              isExpanded: false,
              repoPath: chat.repo_path ?? null,
              baseBranch: chat.base_branch ?? null,
              workingBranch: chat.working_branch ?? null
            });
          } else {
            // Fill in git context from whichever chat in the project
            // carries it — older sessions may pre-date the mirror change.
            const existing = projectsMap.get(projectId);
            if (!existing.repoPath && chat.repo_path) existing.repoPath = chat.repo_path;
            if (!existing.baseBranch && chat.base_branch) existing.baseBranch = chat.base_branch;
            if (!existing.workingBranch && chat.working_branch) existing.workingBranch = chat.working_branch;
          }

          const project = projectsMap.get(projectId);
          project.chats.push({
            id: chat.chat_id,
            title: chat.chat_name,
            messages: [],
            createdAt: new Date(chat.created_at),
            updatedAt: new Date(chat.created_at),
            projectId: projectId,
            archived: chat.archived === true
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

  // ---------------------------------------------------------------------
  // Sidebar status dots — poll the batch runtime endpoint and merge the
  // result into the existing project list. Independent of either project
  // source (legacy /project-chats or agent /v2/agent/projects) because
  // the backend keys the response by both UUID and oenum.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    const refreshRuntime = async () => {
      try {
        const token = localStorage.getItem('simorgh_token');
        if (!token) return;
        const res = await axios.get(
          `${API_BASE}/v2/agent/projects/runtime/batch`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const map = res.data || {};
        if (cancelled || !map || Object.keys(map).length === 0) return;
        setProjects(prev =>
          prev.map(p => {
            const next = map[p.id] || (p as any).oeNumber && map[(p as any).oeNumber];
            return next ? { ...p, runtimeStatus: next } : p;
          })
        );
      } catch (err) {
        // Status is best-effort. Don't surface 401/5xx — the sidebar
        // just falls back to the "idle" dot.
      }
    };

    refreshRuntime();
    const id = window.setInterval(refreshRuntime, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
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

  // Poll for sync progress
  const pollSyncProgress = useCallback(async (oenum: string, maxAttempts: number = 120): Promise<void> => {
    const token = localStorage.getItem('simorgh_token');
    if (!token) return;

    let attempts = 0;
    const pollInterval = 1000; // 1 second

    const poll = async (): Promise<void> => {
      try {
        const response = await axios.get(`${API_BASE}/v2/project/sync/progress/${oenum}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        const progress: SyncProgress = response.data;
        setSyncProgress(progress);

        if (progress.status === 'success') {
          console.log('✅ Project sync completed:', oenum);
          showSuccess('Project Ready!', 'All project data has been synced successfully.');
          setTimeout(() => setSyncProgress(null), 3000);
          return;
        }

        if (progress.status === 'failed') {
          console.error('❌ Project sync failed:', progress.error);
          showError('Sync Failed', progress.error || 'Project data sync failed. Some features may be limited.');
          setTimeout(() => setSyncProgress(null), 5000);
          return;
        }

        attempts++;
        if (attempts < maxAttempts && progress.status === 'in_progress') {
          setTimeout(poll, pollInterval);
        } else if (attempts >= maxAttempts) {
          console.warn('⚠️ Sync polling timeout');
          setSyncProgress(null);
        }
      } catch (error) {
        console.error('Error polling sync status:', error);
        attempts++;
        if (attempts < maxAttempts) {
          setTimeout(poll, pollInterval * 2); // Slower retry on error
        }
      }
    };

    await poll();
  }, []);

  /**
   * Unified project creation via the agent API.
   * Legacy users: provide tpms_oenum for TPMS-authenticated project.
   * Modern users: provide name only.
   */
  const createProject = async (
    name: string,
    options?: { tpmsOenum?: string; description?: string; firstPageTitle?: string }
  ): Promise<boolean> => {
    if (!userId) {
      console.error('Cannot create project: userId missing');
      return false;
    }

    const tpmsOenum = options?.tpmsOenum;
    const description = options?.description;
    const firstPageTitle = options?.firstPageTitle || 'New Page';

    setIsCreatingProject(true);
    setSyncProgress({
      oenum: tpmsOenum || name,
      status: 'in_progress',
      current_step: 0,
      total_steps: 5,
      step_name: 'Creating project...',
      progress_percent: 0
    });

    try {
      const token = localStorage.getItem('simorgh_token');
      if (!token) {
        console.error('❌ No auth token found');
        showError('Authentication Required', 'Please log in again.');
        return false;
      }

      // Create project via unified agent API
      console.log('📤 Creating project:', name, tpmsOenum ? `(TPMS: ${tpmsOenum})` : '(modern)');
      const projectResponse = await axios.post(`${API_BASE}/v2/agent/projects`, {
        name,
        description: description || '',
        tpms_oenum: tpmsOenum || null,
      }, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 60000 // 60s for TPMS fetch + techserver copy
      });

      const project = projectResponse.data;
      const projectId = project.id;
      console.log('✅ Project created:', projectId);

      // Create first page/chat for the project
      const chatResponse = await axios.post(`${API_BASE}/chats`, {
        chat_name: firstPageTitle,
        user_id: userId,
        chat_type: 'project',
        project_number: tpmsOenum || projectId,
        page_name: firstPageTitle
      }, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const chatId = chatResponse.data.chat.chat_id;

      // Add to local state
      const newChat: Chat = {
        id: chatId,
        title: firstPageTitle,
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        projectId: tpmsOenum || projectId
      };

      const newProject: Project = {
        id: tpmsOenum || projectId,
        name,
        chats: [newChat],
        createdAt: new Date(),
        isExpanded: true
      };

      setProjects(prev => [newProject, ...prev]);
      setActiveProjectId(tpmsOenum || projectId);
      setActiveChatId(chatId);

      console.log('✅ Project and first page created successfully');
      showInfo('Project Created!', 'You can start chatting now.');
      setSyncProgress(null);

      return true;
    } catch (error: any) {
      console.error('❌ Failed to create project:', error);
      setSyncProgress(null);
      if (error.response?.status === 400) {
        showError('Cannot Create', error.response.data.detail);
      } else {
        showError('Create Failed', error.response?.data?.detail || 'Failed to create project. Please try again.');
      }
      return false;
    } finally {
      setIsCreatingProject(false);
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

      // For wizard projects (any chat id starts with `session_`) we use
      // the new endpoint; need the project's UUID for it. The first
      // session chat's metadata holds it — resolve once.
      const existingProject = projects.find(p => p.id === projectId);
      const anySessionChat = existingProject?.chats.find(c => c.id.startsWith('session_'));

      let response;
      if (anySessionChat) {
        const sessMeta = await axios.get(
          `${API_BASE}/v2/chatbot/project/sessions/${anySessionChat.id}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const projectUuid = sessMeta.data.project_id;
        const created = await axios.post(
          `${API_BASE}/v2/chatbot/project/sessions`,
          { project_id: projectUuid, title: pageName, stage: 'general' },
          { headers: { Authorization: `Bearer ${token}` } },
        );
        // Shape the response to match what the legacy path returned so
        // the downstream code keeps working unchanged.
        response = {
          data: {
            chat: {
              chat_id: created.data.session_token,
              project_name: existingProject?.name || projectId,
            },
          },
        };
      } else {
        // Legacy OENUM-based project (no session_ chat yet) — keep using
        // the old endpoint. Falls back to current behaviour for old data.
        response = await axios.post(`${API_BASE}/chats`, {
          chat_name: pageName,
          user_id: userId,
          chat_type: 'project',
          project_number: projectId,
          page_name: pageName,
        }, {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });
      }

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
        showError('Project Not Found', `Project ${projectId} not found in database`);
      } else if (error.response?.status === 403) {
        showError('Access Denied', `You don't have permission for project ${projectId}`);
      } else {
        showError('Create Failed', error.response?.data?.detail || 'Failed to create project page');
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

      // Project chat sessions use the new deep-link token format
      // (session_<urlsafe>). They live in project_messages, not the
      // legacy chats table. Route the GET accordingly.
      const isProjectSession = chatId.startsWith('session_');
      const response = isProjectSession
        ? await axios.get(
            `${API_BASE}/v2/chatbot/project/sessions/${chatId}/messages`,
            { headers: { Authorization: `Bearer ${token}` } },
          )
        : await axios.get(`${API_BASE}/chats/${chatId}`, {
            headers: { Authorization: `Bearer ${token}` },
          });

      const messages = response.data.messages || [];
      const chatMetadata = response.data.chat || {};
      const ctx = response.data.context || null;

      console.log(`✅ Loaded ${messages.length} messages for chat ${chatId}`);

      // Update chat with loaded messages and latest metadata - use message_id for unique IDs
      const mapMessages = (messages: any[]) => messages.map((m: any, idx: number) => ({
        id: m.message_id || `${m.timestamp}-${idx}` || `${Date.now()}-${idx}`,
        content: m.content || m.text || '',
        role: m.role || 'user',
        timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
        metadata: m.metadata || {}
      }));

      // Guard: a 200-OK-with-empty-messages from the backend used to
      // nuke the in-memory thread on every project switch (the blanking
      // bug). Only replace local messages if the server actually
      // returned some, or there were none locally.
      const mapped = mapMessages(messages);

      if (projectId !== null) {
        // Project chat
        setProjects(prev =>
          prev.map(p =>
            p.id === projectId
              ? {
                  ...p,
                  repoPath: ctx?.repo_path ?? p.repoPath ?? null,
                  baseBranch: ctx?.base_branch ?? p.baseBranch ?? null,
                  workingBranch: ctx?.working_branch ?? p.workingBranch ?? null,
                  filesChangedCount: typeof ctx?.files_changed_count === 'number'
                    ? ctx.files_changed_count
                    : p.filesChangedCount,
                  chats: p.chats.map(c =>
                    c.id === chatId
                      ? {
                          ...c,
                          title: chatMetadata.chat_name || c.title,
                          messages: (mapped.length > 0 || c.messages.length === 0)
                            ? mapped
                            : c.messages,
                          updatedAt: new Date(),
                          archived: ctx?.archived ?? c.archived
                        }
                      : c
                  )
                }
              : p
          )
        );
        console.log(`✅ Project chat messages loaded: ${messages.length}`);
      } else {
        // General chat
        setGeneralChats(prev =>
          prev.map(c =>
            c.id === chatId
              ? {
                  ...c,
                  title: chatMetadata.chat_name || c.title,
                  messages: (mapped.length > 0 || c.messages.length === 0)
                    ? mapped
                    : c.messages,
                  updatedAt: new Date()
                }
              : c
          )
        );
        console.log(`✅ General chat messages loaded: ${messages.length}`);
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
      showError('Rename Failed', error.response?.data?.detail || 'Failed to rename chat');
    }
  };

  const deleteChat = async (chatId: string, projectId: string | null) => {
    if (!userId) {
      console.error('Cannot delete chat: userId missing');
      return;
    }

    // Beautiful confirmation dialog
    const confirmed = await showConfirm(
      'Delete Chat?',
      'Are you sure you want to delete this chat? This action cannot be undone.',
      'Delete',
      'Cancel'
    );

    if (!confirmed) {
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
      showSuccess('Chat Deleted', 'Chat has been successfully deleted');
    } catch (error: any) {
      console.error('❌ Failed to delete chat:', error);
      showError('Delete Failed', error.response?.data?.detail || 'Failed to delete chat');
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

    // Beautiful confirmation dialog with detailed warning
    const confirmed = await showConfirm(
      `Delete Project "${project.name}"?`,
      `⚠️ This will PERMANENTLY DELETE:\n\n` +
      `✗ All chat history from Redis\n` +
      `✗ All project data from Neo4j graph\n` +
      `✗ Project PostgreSQL database\n` +
      `✗ Project Qdrant vector collection\n` +
      `✗ All documents and specifications\n` +
      `✗ All extraction guides and values\n\n` +
      `THIS ACTION CANNOT BE UNDONE!`,
      'Delete Forever',
      'Cancel'
    );

    if (!confirmed) {
      return;
    }

    const token = localStorage.getItem('simorgh_token');
    if (!token) {
      console.error('❌ No auth token found');
      showError('Authentication Required', 'Please log in again.');
      return;
    }
    const authHeaders = { headers: { Authorization: `Bearer ${token}` } };

    // Previous version had three failure modes the operator hit:
    //   1) Only the first session_<...> chat was cascade-deleted;
    //      projects with multiple sessions left orphan messages.
    //   2) Any error (including 404 "already gone") aborted before
    //      local cleanup, leaving the project stuck in the sidebar.
    //   3) Projects with BOTH a wizard session AND legacy OENUM
    //      chats only got one path attempted, not both.
    // Fix: best-effort sweep of every backend deletion path; treat
    // 404 as success ("already gone"); only block local cleanup if
    // EVERY path failed for a real reason.
    const errors: string[] = [];
    let anyBackendCleanup = false;
    let aggregateChats = 0;
    let aggregateNeo4j = 0;
    let projectDbDeleted = false;

    // (a) Cascade each session token. Each one drops its own project
    //     + sessions + messages + tasks + documents + git_commits +
    //     containers + volumes server-side; doing all of them
    //     guarantees nothing is left behind even if a project has
    //     multiple wizard sessions.
    const sessionChats = project.chats.filter(c => c.id.startsWith('session_'));
    for (const sc of sessionChats) {
      try {
        const r = await axios.delete(
          `${API_BASE}/v2/chatbot/project/sessions/${sc.id}`,
          authHeaders,
        );
        anyBackendCleanup = true;
        aggregateChats   += r.data?.deleted_chat_count  ?? 0;
        aggregateNeo4j   += r.data?.deleted_neo4j_nodes ?? 0;
        projectDbDeleted ||= !!r.data?.project_db_deleted;
        console.log('🗑️ session cascade ok:', sc.id, r.data);
      } catch (e: any) {
        const status = e?.response?.status;
        if (status === 404) {
          // Already gone — treat as success for local cleanup.
          anyBackendCleanup = true;
          console.log('🗑️ session already gone (404):', sc.id);
        } else {
          errors.push(`session ${sc.id.slice(0, 12)}…: ${e?.message || e}`);
          console.error('❌ session delete failed:', sc.id, e);
        }
      }
    }

    // (b) Legacy per-project sweep — covers OENUM-only projects AND
    //     stragglers in projects that ALSO had wizard sessions.
    try {
      const r = await axios.delete(
        `${API_BASE}/projects/${projectId}/chats`,
        authHeaders,
      );
      anyBackendCleanup = true;
      aggregateChats += r.data?.deleted_chat_count ?? 0;
      console.log('🗑️ legacy sweep ok:', projectId, r.data);
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 404) {
        // No legacy chats — expected for modern-only projects.
        console.log('🗑️ no legacy chats for project (404, OK):', projectId);
      } else {
        // Don't treat this as a hard failure when sessions already
        // succeeded — many wizard projects have no legacy chats and
        // the endpoint can 500 on empty.
        console.warn('legacy sweep error (non-fatal):', e?.message);
      }
    }

    // Local cleanup: as long as SOMETHING succeeded server-side OR
    // we've collected zero real errors, the project is effectively
    // gone and the sidebar should reflect that. Otherwise surface
    // the error and KEEP the project so the user can retry.
    if (anyBackendCleanup || errors.length === 0) {
      const remaining = projects.filter(p => p.id !== projectId);
      setProjects(remaining);
      localStorage.setItem(`simorgh_projects_${userId}`, JSON.stringify(remaining));

      // Clear active project if it was the one deleted, then strip
      // any deep-link ?project=X&session=Y from the URL so a refresh
      // doesn't try to re-open the just-deleted session.
      if (activeProjectId === projectId) {
        setActiveChatId(null);
        setActiveProjectId(null);
      }
      try {
        const params = new URLSearchParams(window.location.search);
        if (params.get('project') === projectId) {
          window.history.replaceState({}, '', window.location.pathname);
        }
      } catch {}
      try { sessionStorage.removeItem('simorgh_pending_session'); } catch {}

      let summary = `Project "${project.name}" deleted.\n\n`;
      summary += `📊 Cleanup:\n`;
      summary += `• ${aggregateChats} chat(s) removed\n`;
      summary += `• ${aggregateNeo4j} graph node(s) removed\n`;
      summary += `• PostgreSQL: ${projectDbDeleted ? 'database deleted' : 'no per-project DB'}\n`;
      if (errors.length > 0) {
        summary += `\n⚠️ Partial cleanup — some backend paths failed:\n${errors.join('\n')}`;
        showInfo('Project Deleted (Partial)', summary);
      } else {
        showInfo('Project Deleted', summary);
      }
    } else {
      showError(
        'Delete Failed',
        `Could not remove the project from the backend:\n\n${errors.join('\n')}\n\n` +
        `The project is still in the sidebar — try again or contact support.`,
      );
    }
  };

  const activeChat =
    activeProjectId !== null
      ? projects
          .find(p => p.id === activeProjectId)
          ?.chats.find(c => c.id === activeChatId)
      : generalChats.find(c => c.id === activeChatId);

  // Prepend a synthetic chat row for a project chat session that was
  // just created via the wizard or arrived through the deep-link
  // resolver, so the user sees it in the sidebar before the next
  // background project-list refresh catches up.
  const ensureSessionChat = (projectId: string, sessionToken: string,
                             title: string) => {
    setProjects(prev =>
      prev.map(p => {
        if (p.id !== projectId) return p;
        if (p.chats.some(c => c.id === sessionToken)) return p;
        const synthetic = {
          id: sessionToken,
          title: title || 'New session',
          messages: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any;
        return { ...p, chats: [synthetic, ...p.chats] };
      })
    );
  };

  const archiveChat = async (chatId: string, projectId: string | null, archive: boolean) => {
    if (!chatId.startsWith('session_')) {
      // Only wizard sessions support archive (the legacy endpoint isn't wired).
      showError('Not supported', 'Archive is only available for project sessions.');
      return;
    }
    try {
      const token = localStorage.getItem('simorgh_token');
      if (!token) return;
      const path = archive ? 'archive' : 'unarchive';
      await axios.post(
        `${API_BASE}/v2/chatbot/project/sessions/${chatId}/${path}`,
        {},
        { headers: { Authorization: `Bearer ${token}` } },
      );
      // Update local state — flip the chat's archived flag.
      if (projectId !== null) {
        setProjects(prev =>
          prev.map(p =>
            p.id === projectId
              ? {
                  ...p,
                  chats: p.chats.map(c =>
                    c.id === chatId ? { ...c, archived: archive } : c
                  )
                }
              : p
          )
        );
      } else {
        setGeneralChats(prev =>
          prev.map(c => c.id === chatId ? { ...c, archived: archive } : c)
        );
      }
    } catch (e: any) {
      console.error('archive failed', e);
      showError('Archive failed', e?.response?.data?.detail || 'Could not update session.');
    }
  };

  return {
    projects,
    generalChats,
    activeProjectId,
    activeChatId,
    activeChat,
    showGeneralChats,
    isCreatingProject,
    syncProgress,
    createProject,
    createChat,
    createGeneralChat,
    updateChatMessages,
    updateChatTitle,
    renameChat,
    deleteChat,
    deleteProject,
    archiveChat,
    toggleProject,
    toggleGeneralChats,
    selectChat,
    ensureSessionChat,
  };
}