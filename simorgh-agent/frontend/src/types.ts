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