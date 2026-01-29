/**
 * Chatbot V2 API Service
 * ======================
 * API service for the enhanced chatbot architecture with:
 * - General-Session chats (isolated memory)
 * - Project-Session chats (shared project memory)
 *
 * Endpoints: /api/v2/chat/*
 */

import {
  ChatSessionType,
  SessionStage,
  DocumentCategory,
  ChatSession,
  CreateChatSessionRequest,
  CreateChatSessionResponse,
  SendMessageV2Request,
  SendMessageV2Response,
  UploadDocumentRequest,
  UploadDocumentResponse,
  UpdateStageRequest,
  ChatInfoResponse,
  AvailableToolsResponse,
  ChatbotStatsResponse,
  Message,
  ExternalTool,
} from '../types';

// Get API base URL from environment or use default
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';
const V2_BASE = `${API_BASE_URL}/api/v2/chat`;

/**
 * Helper to get auth token from localStorage
 */
const getAuthToken = (): string | null => {
  return localStorage.getItem('auth_token');
};

/**
 * Helper to make authenticated requests
 */
const authFetch = async (
  url: string,
  options: RequestInit = {}
): Promise<Response> => {
  const token = getAuthToken();

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || `HTTP ${response.status}`);
  }

  return response;
};

// =============================================================================
// CHAT SESSION MANAGEMENT
// =============================================================================

/**
 * Create a new chat session (General or Project)
 */
export const createChatSession = async (
  request: CreateChatSessionRequest
): Promise<CreateChatSessionResponse> => {
  const body = {
    user_id: request.userId,
    chat_type: request.chatType,
    username: request.username,
    project_number: request.projectNumber,
    project_name: request.projectName,
    project_domain: request.projectDomain,
    stage: request.stage,
  };

  const response = await authFetch(`${V2_BASE}/create`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const data = await response.json();

  return {
    success: data.success,
    chatId: data.chat_id,
    chatType: data.chat_type as ChatSessionType,
    message: data.message,
  };
};

/**
 * Create a general chat session (convenience method)
 */
export const createGeneralSession = async (
  userId: string,
  username?: string
): Promise<CreateChatSessionResponse> => {
  return createChatSession({
    userId,
    chatType: 'general',
    username,
  });
};

/**
 * Create a project chat session (convenience method)
 */
export const createProjectSession = async (
  userId: string,
  projectNumber: string,
  projectName: string,
  username?: string,
  projectDomain?: string,
  stage: SessionStage = 'analysis'
): Promise<CreateChatSessionResponse> => {
  return createChatSession({
    userId,
    chatType: 'project',
    username,
    projectNumber,
    projectName,
    projectDomain,
    stage,
  });
};

/**
 * Get chat session info
 */
export const getChatInfo = async (
  chatId: string,
  userId: string
): Promise<ChatInfoResponse> => {
  const response = await authFetch(
    `${V2_BASE}/${chatId}?user_id=${encodeURIComponent(userId)}`
  );

  const data = await response.json();

  return {
    chatId: data.chat_id,
    chatType: data.chat_type as ChatSessionType,
    userId: data.user_id,
    projectNumber: data.project_number,
    projectName: data.project_name,
    stage: data.stage as SessionStage | undefined,
    historyCount: data.history_count,
    documentsCount: data.documents_count,
    allowsExternalTools: data.allows_external_tools,
  };
};

/**
 * Delete a chat session
 */
export const deleteChatSession = async (
  chatId: string,
  userId: string
): Promise<{ success: boolean; chatId: string }> => {
  const response = await authFetch(
    `${V2_BASE}/${chatId}?user_id=${encodeURIComponent(userId)}`,
    { method: 'DELETE' }
  );

  return response.json();
};

// =============================================================================
// MESSAGING
// =============================================================================

/**
 * Send a message and get response
 */
export const sendMessageV2 = async (
  chatId: string,
  request: SendMessageV2Request
): Promise<SendMessageV2Response> => {
  const body = {
    user_id: request.userId,
    message: request.message,
    use_tools: request.useTools ?? true,
    stream: false, // Non-streaming for now
  };

  const response = await authFetch(`${V2_BASE}/${chatId}/message`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const data = await response.json();

  return {
    success: data.success,
    content: data.content,
    model: data.model,
    mode: data.mode,
    tokensUsed: data.tokens_used,
    sources: data.sources,
    error: data.error,
  };
};

/**
 * Send a message with streaming response
 */
export const sendMessageV2Stream = async (
  chatId: string,
  request: SendMessageV2Request,
  onChunk: (chunk: string) => void,
  onComplete?: () => void,
  onError?: (error: Error) => void
): Promise<void> => {
  const token = getAuthToken();

  const body = {
    user_id: request.userId,
    message: request.message,
    use_tools: request.useTools ?? true,
    stream: true,
  };

  try {
    const response = await fetch(`${V2_BASE}/${chatId}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      onChunk(chunk);
    }

    onComplete?.();
  } catch (error) {
    onError?.(error as Error);
  }
};

/**
 * Get chat history
 */
export const getChatHistory = async (
  chatId: string,
  userId: string,
  limit: number = 50
): Promise<{ success: boolean; chatId: string; messages: Message[] }> => {
  const response = await authFetch(
    `${V2_BASE}/${chatId}/history?user_id=${encodeURIComponent(userId)}&limit=${limit}`
  );

  const data = await response.json();

  // Transform backend message format to frontend format
  const messages: Message[] = (data.messages || []).map((m: any) => ({
    id: m.message_id,
    content: m.content || m.text,
    role: m.role,
    timestamp: new Date(m.timestamp),
    metadata: m.metadata,
  }));

  return {
    success: data.success,
    chatId: data.chat_id,
    messages,
  };
};

// =============================================================================
// DOCUMENT MANAGEMENT
// =============================================================================

/**
 * Upload a document to a chat session
 */
export const uploadDocumentV2 = async (
  chatId: string,
  request: UploadDocumentRequest
): Promise<UploadDocumentResponse> => {
  const body = {
    user_id: request.userId,
    content: request.content,
    filename: request.filename,
    category: request.category || 'general',
  };

  const response = await authFetch(`${V2_BASE}/${chatId}/document`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const data = await response.json();

  return {
    success: data.success,
    documentId: data.document_id,
    filename: data.filename,
    chunksCreated: data.chunks_created,
    entitiesExtracted: data.entities_extracted,
    storedToQdrant: data.stored_to_qdrant,
    storedToNeo4j: data.stored_to_neo4j,
    errors: data.errors || [],
    warnings: data.warnings || [],
    processingTimeMs: data.processing_time_ms,
  };
};

/**
 * Upload a file to a chat session
 * Reads file content and sends as text
 */
export const uploadFileV2 = async (
  chatId: string,
  userId: string,
  file: File,
  category?: DocumentCategory
): Promise<UploadDocumentResponse> => {
  // Read file content
  const content = await file.text();

  return uploadDocumentV2(chatId, {
    userId,
    content,
    filename: file.name,
    category,
  });
};

// =============================================================================
// PROJECT SESSION STAGE MANAGEMENT
// =============================================================================

/**
 * Update the stage of a project session
 */
export const updateSessionStage = async (
  chatId: string,
  request: UpdateStageRequest
): Promise<{
  success: boolean;
  chatId: string;
  stage: SessionStage;
  allowsExternalTools: boolean;
}> => {
  const body = {
    user_id: request.userId,
    stage: request.stage,
  };

  const response = await authFetch(`${V2_BASE}/${chatId}/stage`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });

  const data = await response.json();

  return {
    success: data.success,
    chatId: data.chat_id,
    stage: data.stage as SessionStage,
    allowsExternalTools: data.allows_external_tools,
  };
};

// =============================================================================
// TOOLS
// =============================================================================

/**
 * Get available tools for a chat session
 */
export const getAvailableTools = async (
  chatId: string,
  userId: string
): Promise<AvailableToolsResponse> => {
  const response = await authFetch(
    `${V2_BASE}/tools/available?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(userId)}`
  );

  const data = await response.json();

  return {
    chatId: data.chat_id,
    chatType: data.chat_type as ChatSessionType,
    tools: data.tools.map((t: any) => ({
      toolId: t.tool_id,
      name: t.name,
      category: t.category,
    })),
  };
};

// =============================================================================
// STATISTICS & HEALTH
// =============================================================================

/**
 * Get chatbot system statistics
 */
export const getChatbotStats = async (): Promise<ChatbotStatsResponse> => {
  const response = await authFetch(`${V2_BASE}/stats`);
  const data = await response.json();

  return {
    initialized: data.initialized,
    sessionsActive: data.sessions_active,
    memoryStats: data.memory_stats,
    llmStats: data.llm_stats,
    toolsStats: data.tools_stats,
  };
};

/**
 * Check chatbot health
 */
export const checkChatbotHealth = async (): Promise<{
  status: string;
  initialized: boolean;
  components: Record<string, boolean>;
}> => {
  const response = await authFetch(`${V2_BASE}/health`);
  return response.json();
};

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Convert backend chat session to frontend ChatSession type
 */
export const toChatSession = (data: any): ChatSession => {
  return {
    id: data.chat_id,
    chatType: data.chat_type as ChatSessionType,
    title: data.title || `Chat ${data.chat_id.slice(0, 8)}`,
    userId: data.user_id,
    createdAt: new Date(data.created_at || Date.now()),
    updatedAt: new Date(data.updated_at || Date.now()),
    isIsolated: data.chat_type === 'general',
    projectId: data.project_id,
    projectNumber: data.project_number,
    projectName: data.project_name,
    stage: data.stage as SessionStage | undefined,
    historyCount: data.history_count || 0,
    documentsCount: data.documents_count || 0,
    allowsExternalTools: data.allows_external_tools ?? true,
    metadata: data.metadata,
  };
};

/**
 * Get stage display name
 */
export const getStageDisplayName = (stage: SessionStage): string => {
  const names: Record<SessionStage, string> = {
    analysis: 'Analysis',
    design: 'Design',
    implementation: 'Implementation',
    review: 'Review',
  };
  return names[stage] || stage;
};

/**
 * Get stage color for UI
 */
export const getStageColor = (stage: SessionStage): string => {
  const colors: Record<SessionStage, string> = {
    analysis: '#3B82F6', // blue
    design: '#8B5CF6', // purple
    implementation: '#10B981', // green
    review: '#F59E0B', // amber
  };
  return colors[stage] || '#6B7280';
};

/**
 * Check if external tools are allowed for a stage
 */
export const stageAllowsTools = (stage: SessionStage): boolean => {
  return stage === 'analysis';
};

export default {
  // Session management
  createChatSession,
  createGeneralSession,
  createProjectSession,
  getChatInfo,
  deleteChatSession,

  // Messaging
  sendMessageV2,
  sendMessageV2Stream,
  getChatHistory,

  // Documents
  uploadDocumentV2,
  uploadFileV2,

  // Stage management
  updateSessionStage,

  // Tools
  getAvailableTools,

  // Stats & Health
  getChatbotStats,
  checkChatbotHealth,

  // Utilities
  toChatSession,
  getStageDisplayName,
  getStageColor,
  stageAllowsTools,
};
