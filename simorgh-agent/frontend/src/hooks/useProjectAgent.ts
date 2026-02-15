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
      console.error('Failed to fetch agent projects:', err);
      setError(err.response?.data?.detail || 'Failed to load projects');
    } finally {
      setIsLoading(false);
    }
  }, [getHeaders]);

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
      setError(err.response?.data?.detail || 'Failed to delete project');
      return false;
    }
  }, [getHeaders, activeProjectId]);

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

    try {
      const res = await axios.post(
        `${API_BASE}/v2/agent/projects/${projectId}/message`,
        { content, channel: 'chat', chat_id: chatId },
        { headers: getHeaders(), timeout: 120000 },
      );

      const result: AgentResponse = res.data;

      // Update local state
      setCotProgress({
        chain_id: result.chain_id,
        total_tasks: result.tasks_created,
        completed_tasks: result.tasks.filter(t => t.status === 'completed').length,
        status: 'completed',
        progress_percent: 100,
      });

      // Refresh messages and tasks
      await fetchMessages(projectId);
      await fetchTasks(projectId);

      // Clear progress after a delay
      setTimeout(() => setCotProgress(null), 3000);

      return result;
    } catch (err: any) {
      const detail = err.response?.data?.detail || 'Failed to send message';
      setError(detail);
      setCotProgress(null);
      console.error('Send message failed:', err);
      return null;
    } finally {
      setIsSending(false);
    }
  }, [getHeaders]);

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
