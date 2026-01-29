/**
 * useSessionChat Hook
 * ===================
 * React hook for managing enhanced chat sessions with:
 * - General-Session chats (isolated memory)
 * - Project-Session chats (shared project memory, stage-based tools)
 *
 * Integrates with the chatbot v2 API endpoints.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  ChatSessionType,
  SessionStage,
  ChatSession,
  Message,
  ExternalTool,
  DocumentCategory,
} from '../types';
import chatbotV2Api, {
  createGeneralSession,
  createProjectSession,
  getChatInfo,
  getChatHistory,
  sendMessageV2,
  sendMessageV2Stream,
  uploadDocumentV2,
  updateSessionStage,
  getAvailableTools,
  deleteChatSession,
  toChatSession,
} from '../services/chatbotV2Api';

// =============================================================================
// TYPES
// =============================================================================

export interface UseSessionChatOptions {
  userId: string;
  username?: string;
  autoLoadHistory?: boolean;
  historyLimit?: number;
}

export interface UseSessionChatReturn {
  // State
  sessions: ChatSession[];
  activeSession: ChatSession | null;
  messages: Message[];
  isLoading: boolean;
  isSending: boolean;
  isStreaming: boolean;
  error: string | null;
  availableTools: ExternalTool[];

  // Session management
  createGeneralChat: (title?: string) => Promise<ChatSession | null>;
  createProjectChat: (
    projectNumber: string,
    projectName: string,
    projectDomain?: string,
    stage?: SessionStage
  ) => Promise<ChatSession | null>;
  selectSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<boolean>;
  refreshSession: () => Promise<void>;

  // Messaging
  sendMessage: (content: string, useTools?: boolean) => Promise<Message | null>;
  sendMessageStreaming: (
    content: string,
    onChunk: (chunk: string) => void,
    useTools?: boolean
  ) => Promise<void>;
  clearMessages: () => void;

  // Document management
  uploadDocument: (
    content: string,
    filename: string,
    category?: DocumentCategory
  ) => Promise<boolean>;

  // Project session stage
  setStage: (stage: SessionStage) => Promise<boolean>;

  // Utilities
  clearError: () => void;
  getSessionById: (sessionId: string) => ChatSession | undefined;
}

// =============================================================================
// HOOK IMPLEMENTATION
// =============================================================================

export const useSessionChat = (
  options: UseSessionChatOptions
): UseSessionChatReturn => {
  const { userId, username, autoLoadHistory = true, historyLimit = 50 } = options;

  // State
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availableTools, setAvailableTools] = useState<ExternalTool[]>([]);

  // Refs
  const abortControllerRef = useRef<AbortController | null>(null);

  // ==========================================================================
  // SESSION MANAGEMENT
  // ==========================================================================

  /**
   * Create a new general chat session
   */
  const createGeneralChat = useCallback(
    async (title?: string): Promise<ChatSession | null> => {
      setIsLoading(true);
      setError(null);

      try {
        const response = await createGeneralSession(userId, username);

        if (!response.success) {
          throw new Error(response.message || 'Failed to create session');
        }

        // Get full session info
        const info = await getChatInfo(response.chatId, userId);

        const session: ChatSession = {
          id: response.chatId,
          chatType: 'general',
          title: title || `Chat ${response.chatId.slice(0, 8)}`,
          userId,
          createdAt: new Date(),
          updatedAt: new Date(),
          isIsolated: true,
          historyCount: info.historyCount,
          documentsCount: info.documentsCount,
          allowsExternalTools: info.allowsExternalTools,
        };

        setSessions((prev) => [session, ...prev]);
        setActiveSession(session);
        setMessages([]);

        // Load available tools
        loadAvailableTools(session.id);

        return session;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create session';
        setError(message);
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    [userId, username]
  );

  /**
   * Create a new project chat session
   */
  const createProjectChat = useCallback(
    async (
      projectNumber: string,
      projectName: string,
      projectDomain?: string,
      stage: SessionStage = 'analysis'
    ): Promise<ChatSession | null> => {
      setIsLoading(true);
      setError(null);

      try {
        const response = await createProjectSession(
          userId,
          projectNumber,
          projectName,
          username,
          projectDomain,
          stage
        );

        if (!response.success) {
          throw new Error(response.message || 'Failed to create session');
        }

        // Get full session info
        const info = await getChatInfo(response.chatId, userId);

        const session: ChatSession = {
          id: response.chatId,
          chatType: 'project',
          title: `${projectName} - ${stage}`,
          userId,
          createdAt: new Date(),
          updatedAt: new Date(),
          isIsolated: false,
          projectId: projectNumber,
          projectNumber,
          projectName,
          stage,
          historyCount: info.historyCount,
          documentsCount: info.documentsCount,
          allowsExternalTools: info.allowsExternalTools,
        };

        setSessions((prev) => [session, ...prev]);
        setActiveSession(session);
        setMessages([]);

        // Load available tools
        loadAvailableTools(session.id);

        return session;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create session';
        setError(message);
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    [userId, username]
  );

  /**
   * Select and load a session
   */
  const selectSession = useCallback(
    async (sessionId: string): Promise<void> => {
      setIsLoading(true);
      setError(null);

      try {
        // Check if session exists locally
        let session = sessions.find((s) => s.id === sessionId);

        if (!session) {
          // Load from API
          const info = await getChatInfo(sessionId, userId);
          session = toChatSession(info);
          setSessions((prev) => [...prev, session!]);
        }

        setActiveSession(session);

        // Load chat history if enabled
        if (autoLoadHistory) {
          const historyResponse = await getChatHistory(sessionId, userId, historyLimit);
          if (historyResponse.success) {
            setMessages(historyResponse.messages);
          }
        }

        // Load available tools
        loadAvailableTools(sessionId);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load session';
        setError(message);
      } finally {
        setIsLoading(false);
      }
    },
    [sessions, userId, autoLoadHistory, historyLimit]
  );

  /**
   * Delete a session
   */
  const deleteSession = useCallback(
    async (sessionId: string): Promise<boolean> => {
      setIsLoading(true);
      setError(null);

      try {
        const result = await deleteChatSession(sessionId, userId);

        if (result.success) {
          setSessions((prev) => prev.filter((s) => s.id !== sessionId));

          if (activeSession?.id === sessionId) {
            setActiveSession(null);
            setMessages([]);
          }

          return true;
        }

        return false;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to delete session';
        setError(message);
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [userId, activeSession]
  );

  /**
   * Refresh current session info
   */
  const refreshSession = useCallback(async (): Promise<void> => {
    if (!activeSession) return;

    try {
      const info = await getChatInfo(activeSession.id, userId);
      const updatedSession = toChatSession(info);

      setActiveSession(updatedSession);
      setSessions((prev) =>
        prev.map((s) => (s.id === updatedSession.id ? updatedSession : s))
      );

      // Reload history
      if (autoLoadHistory) {
        const historyResponse = await getChatHistory(
          activeSession.id,
          userId,
          historyLimit
        );
        if (historyResponse.success) {
          setMessages(historyResponse.messages);
        }
      }

      // Reload tools
      loadAvailableTools(activeSession.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to refresh session';
      setError(message);
    }
  }, [activeSession, userId, autoLoadHistory, historyLimit]);

  // ==========================================================================
  // MESSAGING
  // ==========================================================================

  /**
   * Send a message (non-streaming)
   */
  const sendMessage = useCallback(
    async (content: string, useTools: boolean = true): Promise<Message | null> => {
      if (!activeSession) {
        setError('No active session');
        return null;
      }

      setIsSending(true);
      setError(null);

      // Add user message immediately
      const userMessage: Message = {
        id: `user_${Date.now()}`,
        content,
        role: 'user',
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, userMessage]);

      try {
        const response = await sendMessageV2(activeSession.id, {
          userId,
          message: content,
          useTools,
        });

        if (!response.success) {
          throw new Error(response.error || 'Failed to send message');
        }

        // Add assistant message
        const assistantMessage: Message = {
          id: `assistant_${Date.now()}`,
          content: response.content || '',
          role: 'assistant',
          timestamp: new Date(),
          metadata: {
            model: response.model,
            llm_mode: response.mode as 'online' | 'offline',
            tokens: {
              prompt: 0,
              completion: 0,
              total: response.tokensUsed || 0,
            },
            sources: response.sources?.map((s) => ({
              type: 'document' as const,
              title: s,
              content: '',
            })),
          },
        };

        setMessages((prev) => [...prev, assistantMessage]);

        return assistantMessage;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to send message';
        setError(message);

        // Add error message
        const errorMessage: Message = {
          id: `error_${Date.now()}`,
          content: `Error: ${message}`,
          role: 'assistant',
          timestamp: new Date(),
          metadata: { error: true },
        };

        setMessages((prev) => [...prev, errorMessage]);

        return null;
      } finally {
        setIsSending(false);
      }
    },
    [activeSession, userId]
  );

  /**
   * Send a message with streaming response
   */
  const sendMessageStreaming = useCallback(
    async (
      content: string,
      onChunk: (chunk: string) => void,
      useTools: boolean = true
    ): Promise<void> => {
      if (!activeSession) {
        setError('No active session');
        return;
      }

      setIsSending(true);
      setIsStreaming(true);
      setError(null);

      // Add user message immediately
      const userMessage: Message = {
        id: `user_${Date.now()}`,
        content,
        role: 'user',
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, userMessage]);

      // Add streaming assistant message placeholder
      const streamingMessageId = `assistant_${Date.now()}`;
      let streamedContent = '';

      const streamingMessage: Message = {
        id: streamingMessageId,
        content: '',
        role: 'assistant',
        timestamp: new Date(),
        isStreaming: true,
      };

      setMessages((prev) => [...prev, streamingMessage]);

      try {
        await sendMessageV2Stream(
          activeSession.id,
          { userId, message: content, useTools },
          (chunk) => {
            streamedContent += chunk;
            onChunk(chunk);

            // Update message content
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamingMessageId
                  ? { ...m, content: streamedContent }
                  : m
              )
            );
          },
          () => {
            // Complete - remove streaming flag
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamingMessageId ? { ...m, isStreaming: false } : m
              )
            );
          },
          (err) => {
            setError(err.message);
            // Update message with error
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamingMessageId
                  ? {
                      ...m,
                      content: `Error: ${err.message}`,
                      isStreaming: false,
                      metadata: { error: true },
                    }
                  : m
              )
            );
          }
        );
      } finally {
        setIsSending(false);
        setIsStreaming(false);
      }
    },
    [activeSession, userId]
  );

  /**
   * Clear all messages
   */
  const clearMessages = useCallback((): void => {
    setMessages([]);
  }, []);

  // ==========================================================================
  // DOCUMENT MANAGEMENT
  // ==========================================================================

  /**
   * Upload a document to the current session
   */
  const uploadDocument = useCallback(
    async (
      content: string,
      filename: string,
      category?: DocumentCategory
    ): Promise<boolean> => {
      if (!activeSession) {
        setError('No active session');
        return false;
      }

      setIsLoading(true);
      setError(null);

      try {
        const response = await uploadDocumentV2(activeSession.id, {
          userId,
          content,
          filename,
          category,
        });

        if (!response.success) {
          throw new Error(response.errors.join(', ') || 'Upload failed');
        }

        // Refresh session to update document count
        await refreshSession();

        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to upload document';
        setError(message);
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [activeSession, userId, refreshSession]
  );

  // ==========================================================================
  // PROJECT SESSION STAGE
  // ==========================================================================

  /**
   * Update the stage of the current project session
   */
  const setStage = useCallback(
    async (stage: SessionStage): Promise<boolean> => {
      if (!activeSession || activeSession.chatType !== 'project') {
        setError('Only project sessions have stages');
        return false;
      }

      setIsLoading(true);
      setError(null);

      try {
        const response = await updateSessionStage(activeSession.id, {
          userId,
          stage,
        });

        if (!response.success) {
          throw new Error('Failed to update stage');
        }

        // Update local state
        const updatedSession: ChatSession = {
          ...activeSession,
          stage: response.stage,
          allowsExternalTools: response.allowsExternalTools,
        };

        setActiveSession(updatedSession);
        setSessions((prev) =>
          prev.map((s) => (s.id === updatedSession.id ? updatedSession : s))
        );

        // Reload available tools (they change based on stage)
        loadAvailableTools(activeSession.id);

        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update stage';
        setError(message);
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [activeSession, userId]
  );

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  /**
   * Load available tools for a session
   */
  const loadAvailableTools = async (sessionId: string): Promise<void> => {
    try {
      const response = await getAvailableTools(sessionId, userId);
      setAvailableTools(
        response.tools.map((t) => ({
          toolId: t.toolId,
          name: t.name,
          category: t.category,
          enabled: true,
        }))
      );
    } catch {
      setAvailableTools([]);
    }
  };

  /**
   * Clear error
   */
  const clearError = useCallback((): void => {
    setError(null);
  }, []);

  /**
   * Get session by ID
   */
  const getSessionById = useCallback(
    (sessionId: string): ChatSession | undefined => {
      return sessions.find((s) => s.id === sessionId);
    },
    [sessions]
  );

  // ==========================================================================
  // CLEANUP
  // ==========================================================================

  useEffect(() => {
    return () => {
      // Cancel any pending requests on unmount
      abortControllerRef.current?.abort();
    };
  }, []);

  // ==========================================================================
  // RETURN
  // ==========================================================================

  return {
    // State
    sessions,
    activeSession,
    messages,
    isLoading,
    isSending,
    isStreaming,
    error,
    availableTools,

    // Session management
    createGeneralChat,
    createProjectChat,
    selectSession,
    deleteSession,
    refreshSession,

    // Messaging
    sendMessage,
    sendMessageStreaming,
    clearMessages,

    // Document management
    uploadDocument,

    // Project session stage
    setStage,

    // Utilities
    clearError,
    getSessionById,
  };
};

export default useSessionChat;
