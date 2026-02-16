/**
 * useProjectAgent Hook
 * =====================
 * Manages project agent state: projects, tasks, messages, COT chains.
 * Modern users create projects by name only (no TPMS).
 */

import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// =============================================================================
// Types
// =============================================================================

export interface AgentProject {
  id: string;
  name: string;
  description?: string;
  status: 'active' | 'paused' | 'completed' | 'archived';
  agent_enabled: boolean;
  agent_model: string;
  git_repo_initialized: boolean;
  task_count?: number;
  active_task_count?: number;
  message_count?: number;
  document_count?: number;
  created_at: string;
  updated_at: string;
}

export interface AgentTask {
  id: string;
  project_id: string;
  title: string;
  description?: string;
  task_type: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'waiting_approval';
  priority: number;
  tool_used?: string;
  result?: string;
  error_message?: string;
  sort_order: number;
  triggered_by: string;
  started_at?: string;
  completed_at?: string;
  created_at: string;
}

export interface AgentMessage {
  id: string;
  project_id: string;
  channel: 'chat' | 'email' | 'document' | 'webhook' | 'system';
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  task_id?: string;
  email_from?: string;
  email_subject?: string;
  document_filename?: string;
  created_at: string;
}

export interface COTProgress {
  chain_id: string;
  total_tasks: number;
  completed_tasks: number;
  current_task?: AgentTask;
  status: 'planning' | 'executing' | 'completed' | 'failed';
  progress_percent: number;
}

export interface AgentResponse {
  response: string;
  chain_id: string;
  reasoning: string;
  tasks_created: number;
  tasks: { id: string; title: string; status: string }[];
  commit?: { commit_hash: string; message: string } | null;
}

// =============================================================================
// Hook
// =============================================================================

export function useProjectAgent(userId?: string) {
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [cotProgress, setCotProgress] = useState<COTProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const getHeaders = useCallback(() => {
    const token = localStorage.getItem('simorgh_token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  // Handle 401 errors globally - clear auth state to prevent cascade
  const handleAuthError = useCallback((err: any) => {
    if (err?.response?.status === 401) {
      setError('Session expired. Please log in again.');
      setProjects([]);
      setActiveProjectId(null);
      setTasks([]);
      setMessages([]);
      return true;
    }
    return false;
  }, []);

  // Load projects on mount
  useEffect(() => {
    if (!userId) {
      setProjects([]);
      setActiveProjectId(null);
      return;
    }
    fetchProjects();
  }, [userId]);

  // Load tasks and messages when active project changes
  useEffect(() => {
    if (!activeProjectId) {
      setTasks([]);
      setMessages([]);
      return;
    }
    // Clear stale data immediately before fetching new project data
    setTasks([]);
    setMessages([]);
    setError(null);
    fetchTasks(activeProjectId);
    fetchMessages(activeProjectId);
  }, [activeProjectId]);

  // --- Projects ---

  const fetchProjects = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await axios.get(`${API_BASE}/v2/agent/projects`, {
        headers: getHeaders(),
      });
      setProjects(res.data.projects || []);
    } catch (err: any) {
      if (!handleAuthError(err)) {
        console.error('Failed to fetch agent projects:', err);
        setError(err.response?.data?.detail || 'Failed to load projects');
      }
    } finally {
      setIsLoading(false);
    }
  }, [getHeaders, handleAuthError]);

  const createProject = useCallback(async (
    name: string,
    description?: string,
  ): Promise<AgentProject | null> => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await axios.post(`${API_BASE}/v2/agent/projects`, {
        name,
        description,
      }, {
        headers: getHeaders(),
      });

      const project = res.data;
      setProjects(prev => [project, ...prev]);
      setActiveProjectId(project.id);
      return project;
    } catch (err: any) {
      if (handleAuthError(err)) return null;
      const detail = err.response?.data?.detail || 'Failed to create project';
      setError(detail);
      console.error('Create project failed:', err);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [getHeaders]);

  const deleteProject = useCallback(async (projectId: string) => {
    try {
      await axios.delete(`${API_BASE}/v2/agent/projects/${projectId}?confirm=true`, {
        headers: getHeaders(),
      });
      setProjects(prev => prev.filter(p => p.id !== projectId));
      if (activeProjectId === projectId) {
        setActiveProjectId(null);
      }
      return true;
    } catch (err: any) {
      if (!handleAuthError(err)) {
        setError(err.response?.data?.detail || 'Failed to delete project');
      }
      return false;
    }
  }, [getHeaders, handleAuthError, activeProjectId]);

  // --- Messages (COT-driven) ---

  const sendMessage = useCallback(async (
    projectId: string,
    content: string,
    chatId?: string,
  ): Promise<AgentResponse | null> => {
    setIsSending(true);
    setError(null);
    setCotProgress({
      chain_id: '',
      total_tasks: 0,
      completed_tasks: 0,
      status: 'planning',
      progress_percent: 0,
    });

    const token = localStorage.getItem('simorgh_token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
      // Use SSE streaming endpoint
      const response = await fetch(
        `${API_BASE}/v2/agent/projects/${projectId}/message/stream`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ content, channel: 'chat', chat_id: chatId }),
        },
      );

      if (response.status === 401) {
        handleAuthError({ response: { status: 401 } });
        return null;
      }

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.detail || `HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let finalResult: AgentResponse | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventName = '';
        let eventData = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventName = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            eventData = line.slice(6);
          } else if (line === '' && eventName && eventData) {
            // Process the event
            try {
              const parsed = JSON.parse(eventData);

              switch (eventName) {
                case 'cot_analyzing':
                  setCotProgress(prev => ({
                    ...(prev || { chain_id: '', total_tasks: 0, completed_tasks: 0, progress_percent: 0 }),
                    status: 'planning',
                  }));
                  break;

                case 'cot_complete':
                  setCotProgress(prev => ({
                    ...(prev || { chain_id: '', completed_tasks: 0, progress_percent: 0 }),
                    chain_id: parsed.chain_id || '',
                    total_tasks: parsed.total_steps || 0,
                    status: 'executing',
                    progress_percent: 10,
                  }));
                  break;

                case 'tasks_created':
                  setCotProgress(prev => ({
                    ...(prev || { chain_id: '', completed_tasks: 0, status: 'executing' as const }),
                    total_tasks: parsed.count || 0,
                    progress_percent: 15,
                  }));
                  // Refresh tasks to show them in the UI
                  fetchTasks(projectId);
                  break;

                case 'task_executing':
                  setCotProgress(prev => ({
                    ...(prev || { chain_id: '', total_tasks: 0, completed_tasks: 0 }),
                    status: 'executing',
                    progress_percent: parsed.progress_percent || 20,
                  }));
                  break;

                case 'task_completed':
                  setCotProgress(prev => ({
                    ...(prev || { chain_id: '', total_tasks: 0 }),
                    completed_tasks: parsed.step || 0,
                    status: 'executing',
                    progress_percent: parsed.progress_percent || 50,
                  }));
                  // Refresh tasks to update status
                  fetchTasks(projectId);
                  break;

                case 'task_failed':
                  fetchTasks(projectId);
                  break;

                case 'complete':
                  finalResult = parsed;
                  setCotProgress({
                    chain_id: parsed.chain_id || '',
                    total_tasks: parsed.tasks_created || 0,
                    completed_tasks: parsed.tasks?.filter((t: any) => t.status === 'completed').length || 0,
                    status: 'completed',
                    progress_percent: 100,
                  });
                  break;

                case 'error':
                  setError(parsed.error || 'Agent error');
                  break;
              }
            } catch {
              // Skip malformed events
            }
            eventName = '';
            eventData = '';
          }
        }
      }

      // Refresh messages and tasks after completion
      await fetchMessages(projectId);
      await fetchTasks(projectId);

      // Clear progress after a delay
      setTimeout(() => setCotProgress(null), 3000);

      return finalResult;
    } catch (err: any) {
      if (err?.response?.status === 401) {
        handleAuthError(err);
        return null;
      }
      const detail = err.message || 'Failed to send message';
      setError(detail);
      setCotProgress(null);
      console.error('Send message failed:', err);
      return null;
    } finally {
      setIsSending(false);
    }
  }, [getHeaders, handleAuthError, fetchMessages, fetchTasks]);

  // --- Tasks ---

  const fetchTasks = useCallback(async (projectId: string) => {
    try {
      const res = await axios.get(
        `${API_BASE}/v2/agent/projects/${projectId}/tasks`,
        { headers: getHeaders() },
      );
      setTasks(res.data.tasks || []);
    } catch (err) {
      console.error('Failed to fetch tasks:', err);
    }
  }, [getHeaders]);

  const updateTask = useCallback(async (
    projectId: string,
    taskId: string,
    status: string,
  ) => {
    try {
      await axios.patch(
        `${API_BASE}/v2/agent/projects/${projectId}/tasks/${taskId}`,
        { status },
        { headers: getHeaders() },
      );
      await fetchTasks(projectId);
    } catch (err) {
      console.error('Failed to update task:', err);
    }
  }, [getHeaders, fetchTasks]);

  // --- Messages ---

  const fetchMessages = useCallback(async (projectId: string) => {
    try {
      const res = await axios.get(
        `${API_BASE}/v2/agent/projects/${projectId}/messages?limit=100`,
        { headers: getHeaders() },
      );
      setMessages(res.data.messages || []);
    } catch (err) {
      console.error('Failed to fetch messages:', err);
    }
  }, [getHeaders]);

  // --- Documents ---

  const uploadDocument = useCallback(async (
    projectId: string,
    file: File,
  ) => {
    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await axios.post(
        `${API_BASE}/v2/agent/projects/${projectId}/documents`,
        formData,
        {
          headers: {
            ...getHeaders(),
            'Content-Type': 'multipart/form-data',
          },
        },
      );
      // Refresh after upload
      await fetchMessages(projectId);
      await fetchTasks(projectId);
      return res.data;
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to upload document');
      return null;
    }
  }, [getHeaders, fetchMessages, fetchTasks]);

  // --- Shell ---

  const execCommand = useCallback(async (
    projectId: string,
    command: string,
  ) => {
    try {
      const res = await axios.post(
        `${API_BASE}/v2/agent/projects/${projectId}/shell/exec`,
        new URLSearchParams({ command, timeout: '30' }),
        { headers: getHeaders() },
      );
      return res.data;
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Shell command failed');
      return null;
    }
  }, [getHeaders]);

  // --- Git ---

  const getGitLog = useCallback(async (projectId: string) => {
    try {
      const res = await axios.get(
        `${API_BASE}/v2/agent/projects/${projectId}/git/log`,
        { headers: getHeaders() },
      );
      return res.data;
    } catch (err) {
      console.error('Failed to get git log:', err);
      return null;
    }
  }, [getHeaders]);

  // Active project
  const activeProject = projects.find(p => p.id === activeProjectId) || null;

  return {
    // State
    projects,
    activeProject,
    activeProjectId,
    tasks,
    messages,
    isLoading,
    isSending,
    cotProgress,
    error,
    // Actions
    setActiveProjectId,
    createProject,
    deleteProject,
    sendMessage,
    fetchTasks,
    updateTask,
    fetchMessages,
    uploadDocument,
    execCommand,
    getGitLog,
    fetchProjects,
    setError,
  };
}
