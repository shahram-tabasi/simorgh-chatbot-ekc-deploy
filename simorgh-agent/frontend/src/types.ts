// src/types.ts

// ============================================
// User & Authentication Types
// ============================================

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'manager' | 'user';
  projectId?: string;
  oeNumber?: string;
  avatar?: string;
  preferences?: UserPreferences;
}

export interface UserPreferences {
 ndata: string;
  language: string;
  aiMode: AIMode;
}

export type AIMode = 'online' | 'local';

// ============================================
// Project & Chat Types
// ============================================

export interface Project {
  id: string;
  name: string;
  pid?: string;
  oeNumber?: string;
  chats: Chat[];
  createdAt: Date;
  updatedAt?: Date;
  isExpanded?: boolean;
  metadata?: Record<string, any>;
}

export interface Chat {
  id: string;
  title: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
  isGeneral?: boolean;
  projectId?: string;
  conversationId?: string;
  metadata?: Record<string, any>;
}

// ============================================
// Message Types
// ============================================

export interface Message {
  id: string;
  content: string;
  role: 'user' | 'assistant' | 'system';
  timestamp: Date;
  files?: UploadedFile[];
  metadata?: MessageMetadata;
  isStreaming?: boolean;
  // AI message interaction features
  liked?: boolean;
  disliked?: boolean;
  versions?: MessageVersion[];
  currentVersionIndex?: number;
  refreshCount?: number;
}

export interface MessageVersion {
  id: string;
  content: string;
  timestamp: Date;
  metadata?: MessageMetadata;
}

export interface MessageMetadata {
  sources?: MessageSource[];
  contextUsed?: boolean;
  context_used?: boolean; // Backend format
  graphPaths?: GraphPath[];
  processingTime?: number;
  model?: string;
  llm_mode?: 'online' | 'offline'; // LLM mode used
  cached_response?: boolean; // Whether response was cached
  error?: boolean; // Error flag
  tokens?: {
    prompt: number;
    completion: number;
    total: number;
  };
}

export interface MessageSource {
  type: 'document' | 'graph' | 'web';
  title: string;
  content: string;
  score?: number;
  metadata?: Record<string, any>;
}

export interface GraphPath {
  entities: GraphEntity[];
  ionships: GraphRelationship[];
  score: number;
}

export interface GraphEntity {
  id: string;
  type: string;
  properties: Record<string, any>;
}

export interface GraphRelationship {
  type: string;
  from: string;
  to: string;
  properties?: Record<string, any>;
}

// ============================================
// File Types
// ============================================

export type FileCategory = 'image' | 'document' | 'video' | 'audio';

export interface UploadedFile {
  id: string;
  name: string;
  type: string;
  size: number;
  category: FileCategory;
  url?: string;
  uploadProgress?: number;
  status?: 'uploading' | 'uploaded' | 'processing' | 'completed' | 'failed';
  error?: string;
  file?: File; // Store original File object for uploading
}

// ============================================
// Conversation Types (Multi-document)
// ============================================

export interface Conversation {
  id: string;
  userId: string;
  projectId: string;
  oeNumber: string;
  userPrompt: string;
  documents: ConversationDocument[];
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
  metadata?: ConversationMetadata;
}

export interface ConversationDocument {
  id: string;
  filename: string;
  hash: string;
  size: number;
  uploadedAt: Date;
  status: string;
  processingResult?: {
    entities: number;
    relationships: number;
    processingTime: number;
  };
}

export interface ConversationMetadata {
  totalEntities: number;
  totalRelationships: number;
  crossDocumentLinks: number;
  processingTime: number;
  errors?: string[];
}

// ============================================
// Theme Types
// ============================================

export interface Theme {
  id: string;
  name: string;
  primaryColor: string;
  secondaryColor: string;
  backgroundColor: string;
}

// ============================================
// API Types
// ============================================

export interface ApiResponse<T = any> {
  status: 'success' | 'error';
  data?: T;
  error?: string;
  message?: string;
}

export interface ChatRequest {
  pid: string;
  oe_number: string;
  query: string;
  conversation_history?: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  max_results?: number;
}

export interface ChatResponse {
  response: string;
  sources: MessageSource[];
  context_used: boolean;
  graph_paths?: GraphPath[];
}

export interface AnalyzeRequest {
  file: File;
  projectId: string;
  oeNumber: string;
  thinkingLevel?: 'low' | 'medium' | 'high';
}

export interface AnalyzeResponse {
  status: string;
  statistics: {
    entities_created: number;
    relationships_created: number;
    vectors_stored: number;
    processing_time_seconds: number;
  };
  graph_stats?: GraphStats;
}

export interface GraphStats {
  project_id: string;
  graph_database: {
    total_entities: number;
    total_relationships: number;
    entities_by_type: Record<string, number>;
    relationships_by_type: Record<string, number>;
  };
  vector_store: {
    total_vectors: number;
    dimensions: number;
    index_size: number;
  };
  timestamp: string;
}

// ============================================
// Progress Types
// ============================================

export interface ProgressUpdate {
  progress: number;
  message: string;
  phase: string;
  status?: 'processing' | 'completed' | 'error' | 'cancelled';
  data?: any;
}

// ============================================
// WebSocket Types
// ============================================

export interface WebSocketMessage {
  type: 'chat' | 'progress' | 'notification' | 'error';
  data: any;
  timestamp: Date;
}

// ============================================
// Settings Types
// ============================================

export interface Settings {
  theme: Theme;
  aiMode: AIMode;
  language: string;
  notifications: NotificationSettings;
  privacy: PrivacySettings;
}

export interface NotificationSettings {
  enabled: boolean;
  sound: boolean;
  desktop: boolean;
}

export interface PrivacySettings {
  saveHistory: boolean;
  shareAnalytics: boolean;
}

// ============================================
// Enhanced Chat Session Types (V2)
// ============================================

/**
 * Chat session types:
 * - general: Isolated chats with full external tool access
 * - project: Shared project memory with stage-based restrictions
 */
export type ChatSessionType = 'general' | 'project';

/**
 * Project session stages - controls tool availability
 * - analysis: External tools allowed (internet, wiki, Python)
 * - design: Project knowledge only
 * - implementation: Project knowledge only
 * - review: Project knowledge only
 */
export type SessionStage = 'analysis' | 'design' | 'implementation' | 'review';

/**
 * Document categories for session context
 */
export type DocumentCategory = 'specification' | 'process' | 'reference' | 'general';

/**
 * External tool identifiers
 */
export type ExternalToolId = 'internet_search' | 'wikipedia' | 'python_engine';

/**
 * Enhanced chat session info
 */
export interface ChatSession {
  id: string;
  chatType: ChatSessionType;
  title: string;
  userId: string;
  createdAt: Date;
  updatedAt: Date;

  // General chat specific
  isIsolated?: boolean;

  // Project chat specific
  projectId?: string;
  projectNumber?: string;
  projectName?: string;
  stage?: SessionStage;

  // Common properties
  historyCount: number;
  documentsCount: number;
  allowsExternalTools: boolean;

  // Messages (loaded on demand)
  messages?: Message[];

  // Metadata
  metadata?: ChatSessionMetadata;
}

export interface ChatSessionMetadata {
  lastMessageAt?: Date;
  graphContext?: string;
  semanticResults?: SemanticSearchResult[];
  externalSearchResults?: ExternalSearchResult[];
}

/**
 * Semantic search result from Qdrant
 */
export interface SemanticSearchResult {
  documentId: string;
  filename: string;
  content: string;
  score: number;
  chunkIndex?: number;
  metadata?: Record<string, any>;
}

/**
 * External search result (internet, wiki, etc.)
 */
export interface ExternalSearchResult {
  source: string;
  title: string;
  content: string;
  url?: string;
  relevanceScore: number;
  metadata?: Record<string, any>;
}

/**
 * Session document context
 */
export interface SessionDocument {
  documentId: string;
  filename: string;
  category: DocumentCategory;
  contentSummary?: string;
  embeddingId?: string;
  uploadedAt: Date;
  metadata?: Record<string, any>;
}

/**
 * External tool configuration
 */
export interface ExternalTool {
  toolId: ExternalToolId;
  name: string;
  category: string;
  enabled: boolean;
  allowedStages?: SessionStage[];
}

// ============================================
// Chatbot V2 API Types
// ============================================

/**
 * Request to create a new chat session
 */
export interface CreateChatSessionRequest {
  userId: string;
  chatType: ChatSessionType;
  username?: string;
  // Project chat specific
  projectNumber?: string;
  projectName?: string;
  projectDomain?: string;
  stage?: SessionStage;
}

/**
 * Response from chat session creation
 */
export interface CreateChatSessionResponse {
  success: boolean;
  chatId: string;
  chatType: ChatSessionType;
  message?: string;
}

/**
 * Request to send a message
 */
export interface SendMessageV2Request {
  userId: string;
  message: string;
  useTools?: boolean;
  stream?: boolean;
}

/**
 * Response from message send
 */
export interface SendMessageV2Response {
  success: boolean;
  content?: string;
  model?: string;
  mode?: 'online' | 'offline';
  tokensUsed?: number;
  sources?: string[];
  error?: string;
}

/**
 * Request to upload a document
 */
export interface UploadDocumentRequest {
  userId: string;
  content: string;
  filename: string;
  category?: DocumentCategory;
}

/**
 * Response from document upload
 */
export interface UploadDocumentResponse {
  success: boolean;
  documentId: string;
  filename: string;
  chunksCreated: number;
  entitiesExtracted: number;
  storedToQdrant: boolean;
  storedToNeo4j: boolean;
  errors: string[];
  warnings: string[];
  processingTimeMs: number;
}

/**
 * Request to update session stage
 */
export interface UpdateStageRequest {
  userId: string;
  stage: SessionStage;
}

/**
 * Chat info response
 */
export interface ChatInfoResponse {
  chatId: string;
  chatType: ChatSessionType;
  userId: string;
  projectNumber?: string;
  projectName?: string;
  stage?: SessionStage;
  historyCount: number;
  documentsCount: number;
  allowsExternalTools: boolean;
}

/**
 * Available tools response
 */
export interface AvailableToolsResponse {
  chatId: string;
  chatType: ChatSessionType;
  tools: {
    toolId: ExternalToolId;
    name: string;
    category: string;
  }[];
}

/**
 * Chatbot stats response
 */
export interface ChatbotStatsResponse {
  initialized: boolean;
  sessionsActive: number;
  memoryStats?: Record<string, any>;
  llmStats?: Record<string, any>;
  toolsStats?: Record<string, any>;
}