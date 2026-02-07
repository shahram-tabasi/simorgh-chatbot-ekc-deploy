/**
 * Document Intelligence API Service
 * ===================================
 * API service for NotebookLM-like features:
 * - Grounded responses with citations
 * - Document summaries
 * - Multi-document synthesis
 * - Study guides
 * - Suggested questions
 * - Audio summaries & podcasts
 *
 * Endpoints: /api/documents/*
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';
const DOC_BASE = `${API_BASE_URL}/api/documents`;

/**
 * Helper to get auth token from localStorage
 */
const getAuthToken = (): string | null => {
  return localStorage.getItem('auth_token') || localStorage.getItem('simorgh_token');
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
// TYPES
// =============================================================================

export interface Citation {
  id: number;
  sectionTitle: string;
  documentName: string;
  pageNumber?: number;
  quotedText: string;
  relevanceScore: number;
}

export interface GroundedQueryRequest {
  query: string;
  projectNumber?: string;
  chatId?: string;
  maxSources?: number;
  llmMode?: string;
}

export interface GroundedResponse {
  response: string;
  citations: Citation[];
  sourcesPanel?: string;
  isGrounded: boolean;
  confidenceScore: number;
  sourcesUsed: number;
  processingTimeMs: number;
}

export interface SummaryRequest {
  documentName?: string;
  projectNumber?: string;
  chatId?: string;
  forceRegenerate?: boolean;
}

export interface DocumentSummary {
  documentName: string;
  summary: string;
  keyTopics: string[];
  keyEntities: string[];
  sectionCount: number;
  wordCount: number;
  suggestedQuestions: string[];
}

export interface SynthesisRequest {
  projectNumber?: string;
  chatId?: string;
  forceRegenerate?: boolean;
}

export interface MultiDocSynthesis {
  overview: string;
  documentCount: number;
  commonThemes: string[];
  connections: Record<string, any>[];
  knowledgeGaps: string[];
  faq: Record<string, any>[];
  suggestedQuestions: string[];
}

export interface StudyGuideRequest {
  projectNumber?: string;
  chatId?: string;
  focusTopics?: string[];
}

export interface StudyGuide {
  title: string;
  overview: string;
  keyConcepts: Record<string, any>[];
  importantFacts: string[];
  reviewQuestions: Record<string, any>[];
  summaryNotes: string;
}

export interface AudioRequest {
  projectNumber?: string;
  chatId?: string;
  text?: string;
  voice?: string;
  language?: string;
}

export interface AudioSummary {
  audioUrl: string;
  durationSeconds: number;
  provider: string;
  voice: string;
  cached: boolean;
}

export interface PodcastRequest {
  projectNumber?: string;
  chatId?: string;
  style?: 'conversational' | 'professional' | 'casual';
  durationTarget?: number;
}

export interface PodcastResponse {
  audioUrl: string;
  durationSeconds: number;
  transcript: string;
  segmentCount: number;
}

// =============================================================================
// GROUNDED RESPONSES
// =============================================================================

/**
 * Get a grounded response with citations from documents
 */
export const queryGrounded = async (
  request: GroundedQueryRequest
): Promise<GroundedResponse> => {
  const body = {
    query: request.query,
    project_number: request.projectNumber,
    chat_id: request.chatId,
    max_sources: request.maxSources ?? 5,
    llm_mode: request.llmMode,
  };

  const response = await authFetch(`${DOC_BASE}/query/grounded`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const data = await response.json();

  return {
    response: data.response,
    citations: (data.citations || []).map((c: any) => ({
      id: c.id,
      sectionTitle: c.section_title,
      documentName: c.document_name,
      pageNumber: c.page_number,
      quotedText: c.quoted_text,
      relevanceScore: c.relevance_score,
    })),
    sourcesPanel: data.sources_panel,
    isGrounded: data.is_grounded,
    confidenceScore: data.confidence_score,
    sourcesUsed: data.sources_used,
    processingTimeMs: data.processing_time_ms,
  };
};

// =============================================================================
// DOCUMENT SUMMARIES
// =============================================================================

/**
 * Generate or retrieve a document summary
 */
export const getDocumentSummary = async (
  request: SummaryRequest
): Promise<DocumentSummary> => {
  const body = {
    document_name: request.documentName,
    project_number: request.projectNumber,
    chat_id: request.chatId,
    force_regenerate: request.forceRegenerate ?? false,
  };

  const response = await authFetch(`${DOC_BASE}/summary`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const data = await response.json();

  return {
    documentName: data.document_name,
    summary: data.summary,
    keyTopics: data.key_topics,
    keyEntities: data.key_entities,
    sectionCount: data.section_count,
    wordCount: data.word_count,
    suggestedQuestions: data.suggested_questions,
  };
};

// =============================================================================
// MULTI-DOCUMENT SYNTHESIS
// =============================================================================

/**
 * Generate synthesis across all documents
 */
export const getMultiDocSynthesis = async (
  request: SynthesisRequest
): Promise<MultiDocSynthesis> => {
  const body = {
    project_number: request.projectNumber,
    chat_id: request.chatId,
    force_regenerate: request.forceRegenerate ?? false,
  };

  const response = await authFetch(`${DOC_BASE}/synthesis`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const data = await response.json();

  return {
    overview: data.overview,
    documentCount: data.document_count,
    commonThemes: data.common_themes,
    connections: data.connections,
    knowledgeGaps: data.knowledge_gaps,
    faq: data.faq,
    suggestedQuestions: data.suggested_questions,
  };
};

// =============================================================================
// STUDY GUIDE
// =============================================================================

/**
 * Generate a study guide from documents
 */
export const getStudyGuide = async (
  request: StudyGuideRequest
): Promise<StudyGuide> => {
  const body = {
    project_number: request.projectNumber,
    chat_id: request.chatId,
    focus_topics: request.focusTopics,
  };

  const response = await authFetch(`${DOC_BASE}/study-guide`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const data = await response.json();

  return {
    title: data.title,
    overview: data.overview,
    keyConcepts: data.key_concepts,
    importantFacts: data.important_facts,
    reviewQuestions: data.review_questions,
    summaryNotes: data.summary_notes,
  };
};

// =============================================================================
// SUGGESTED QUESTIONS
// =============================================================================

/**
 * Get suggested questions based on document content
 */
export const getSuggestedQuestions = async (
  projectNumber?: string,
  chatId?: string,
  count: number = 10
): Promise<string[]> => {
  const params = new URLSearchParams();
  if (projectNumber) params.append('project_number', projectNumber);
  if (chatId) params.append('chat_id', chatId);
  params.append('count', count.toString());

  const response = await authFetch(`${DOC_BASE}/suggested-questions?${params.toString()}`);
  const data = await response.json();

  return data.questions || [];
};

// =============================================================================
// AUDIO
// =============================================================================

/**
 * Generate audio summary of documents
 */
export const generateAudioSummary = async (
  request: AudioRequest
): Promise<AudioSummary> => {
  const body = {
    project_number: request.projectNumber,
    chat_id: request.chatId,
    text: request.text,
    voice: request.voice,
    language: request.language ?? 'en',
  };

  const response = await authFetch(`${DOC_BASE}/audio/summary`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const data = await response.json();

  return {
    audioUrl: data.audio_url,
    durationSeconds: data.duration_seconds,
    provider: data.provider,
    voice: data.voice,
    cached: data.cached,
  };
};

/**
 * Generate podcast-style audio overview
 */
export const generatePodcast = async (
  request: PodcastRequest
): Promise<PodcastResponse> => {
  const body = {
    project_number: request.projectNumber,
    chat_id: request.chatId,
    style: request.style ?? 'conversational',
    duration_target: request.durationTarget ?? 120,
  };

  const response = await authFetch(`${DOC_BASE}/audio/podcast`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const data = await response.json();

  return {
    audioUrl: data.audio_url,
    durationSeconds: data.duration_seconds,
    transcript: data.transcript,
    segmentCount: data.segment_count,
  };
};

// =============================================================================
// DOCUMENT CONNECTIONS
// =============================================================================

/**
 * Get connections between documents
 */
export const getDocumentConnections = async (
  projectNumber: string
): Promise<Record<string, any>[]> => {
  const response = await authFetch(
    `${DOC_BASE}/connections?project_number=${encodeURIComponent(projectNumber)}`
  );
  const data = await response.json();

  return data.connections || [];
};

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default {
  queryGrounded,
  getDocumentSummary,
  getMultiDocSynthesis,
  getStudyGuide,
  getSuggestedQuestions,
  generateAudioSummary,
  generatePodcast,
  getDocumentConnections,
};
