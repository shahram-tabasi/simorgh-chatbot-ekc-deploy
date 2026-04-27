"""
Core Data Models
================
Data models for the enhanced chatbot architecture.

Defines:
- Chat types (General-Session, Project-Session)
- Session contexts and stages
- Memory tiers and document contexts
- Prompt templates

Author: Simorgh Industrial Assistant
"""

import logging
from enum import Enum
from typing import List, Dict, Any, Optional
from dataclasses import dataclass, field
from datetime import datetime

logger = logging.getLogger(__name__)


# =============================================================================
# ENUMS
# =============================================================================

class ChatType(str, Enum):
    """Types of chat sessions"""
    GENERAL = "general"
    PROJECT = "project"


class SessionStage(str, Enum):
    """
    Stages in a project session.

    Controls what tools and knowledge are available:
    - ANALYSIS: Full access to external tools, general knowledge
    - DESIGN: Project knowledge only
    - IMPLEMENTATION: Project knowledge only
    - REVIEW: Project knowledge only
    """
    ANALYSIS = "analysis"
    DESIGN = "design"
    IMPLEMENTATION = "implementation"
    REVIEW = "review"


class MemoryTier(str, Enum):
    """Memory storage tiers"""
    REDIS = "redis"           # High-speed cache (working memory)
    QDRANT = "qdrant"         # Vector storage (semantic memory)
    POSTGRES = "postgres"     # SQL storage (source of truth)
    NEO4J = "neo4j"           # Graph storage (entity relations)


class DocumentCategory(str, Enum):
    """Categories of documents"""
    SPECIFICATION = "specification"
    PROCESS = "process"
    REFERENCE = "reference"
    GENERAL = "general"


class ToolCategory(str, Enum):
    """Categories of external tools"""
    INTERNET_SEARCH = "internet_search"
    WIKIPEDIA = "wikipedia"
    PYTHON_ENGINE = "python_engine"
    CODE_EXECUTION = "code_execution"
    FILE_ANALYSIS = "file_analysis"


# =============================================================================
# CONTEXT DATA CLASSES
# =============================================================================

@dataclass
class UserContext:
    """User information context"""
    user_id: str
    username: Optional[str] = None
    email: Optional[str] = None
    preferences: Dict[str, Any] = field(default_factory=dict)
    roles: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "user_id": self.user_id,
            "username": self.username,
            "email": self.email,
            "preferences": self.preferences,
            "roles": self.roles,
        }


@dataclass
class DocumentContext:
    """Context for uploaded documents"""
    document_id: str
    filename: str
    category: DocumentCategory = DocumentCategory.GENERAL
    content_summary: Optional[str] = None
    embedding_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    uploaded_at: datetime = field(default_factory=datetime.utcnow)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "document_id": self.document_id,
            "filename": self.filename,
            "category": self.category.value,
            "content_summary": self.content_summary,
            "embedding_id": self.embedding_id,
            "metadata": self.metadata,
            "uploaded_at": self.uploaded_at.isoformat(),
        }


@dataclass
class ChatHistoryEntry:
    """Single entry in chat history"""
    message_id: str
    role: str  # 'user' or 'assistant'
    content: str
    timestamp: datetime = field(default_factory=datetime.utcnow)
    metadata: Dict[str, Any] = field(default_factory=dict)
    source_chat_id: Optional[str] = None  # For cross-chat project memory

    def to_dict(self) -> Dict[str, Any]:
        return {
            "message_id": self.message_id,
            "role": self.role,
            "content": self.content,
            "timestamp": self.timestamp.isoformat(),
            "metadata": self.metadata,
            "source_chat_id": self.source_chat_id,
        }


@dataclass
class ExternalSearchResult:
    """Result from external search (internet, wiki, etc.)"""
    source: str
    title: str
    content: str
    url: Optional[str] = None
    relevance_score: float = 0.0
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "source": self.source,
            "title": self.title,
            "content": self.content,
            "url": self.url,
            "relevance_score": self.relevance_score,
            "metadata": self.metadata,
        }


# =============================================================================
# CHAT CONTEXT CLASSES
# =============================================================================

@dataclass
class ChatContext:
    """
    Base context for all chat sessions.

    Contains common elements shared by both general and project chats.
    """
    chat_id: str
    chat_type: ChatType
    user: UserContext
    created_at: datetime = field(default_factory=datetime.utcnow)
    updated_at: datetime = field(default_factory=datetime.utcnow)

    # Chat history (window from Redis cache)
    history_window: List[ChatHistoryEntry] = field(default_factory=list)

    # Full history reference (from persistent storage)
    full_history_count: int = 0

    # Uploaded documents
    documents: List[DocumentContext] = field(default_factory=list)

    # Session metadata
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "chat_id": self.chat_id,
            "chat_type": self.chat_type.value,
            "user": self.user.to_dict(),
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "history_window": [h.to_dict() for h in self.history_window],
            "full_history_count": self.full_history_count,
            "documents": [d.to_dict() for d in self.documents],
            "metadata": self.metadata,
        }


@dataclass
class GeneralSessionContext(ChatContext):
    """
    Context for General-Session chats.

    Features:
    - Each chat is isolated (no cross-chat memory)
    - LLM context includes user info, chat info, chat history, documents
    - External search results allowed (internet, wiki, Python engine)
    - Responses are general (not project-restricted)
    """
    # External search results
    external_search_results: List[ExternalSearchResult] = field(default_factory=list)

    # Flags for enabled features
    enable_internet_search: bool = True
    enable_wikipedia: bool = True
    enable_python_engine: bool = True

    def __post_init__(self):
        self.chat_type = ChatType.GENERAL

    def to_dict(self) -> Dict[str, Any]:
        base = super().to_dict()
        base.update({
            "external_search_results": [r.to_dict() for r in self.external_search_results],
            "enable_internet_search": self.enable_internet_search,
            "enable_wikipedia": self.enable_wikipedia,
            "enable_python_engine": self.enable_python_engine,
        })
        return base


@dataclass
class ProjectInfo:
    """Project information for project sessions"""
    project_id: str
    project_number: str
    project_name: str
    description: Optional[str] = None
    domain: Optional[str] = None  # e.g., "electrical", "mechanical"
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "project_id": self.project_id,
            "project_number": self.project_number,
            "project_name": self.project_name,
            "description": self.description,
            "domain": self.domain,
            "metadata": self.metadata,
        }


@dataclass
class ProjectSessionContext(ChatContext):
    """
    Context for Project-Session chats.

    Features:
    - All chats in a project share memory (cross-chat history)
    - LLM context restricted to project knowledge/domain
    - Includes project info, project documents, process documents
    - External tools only allowed in ANALYSIS stage for process documents
    - Responses must reference only project knowledge
    """
    # Project information
    project: Optional[ProjectInfo] = None

    # Current session stage
    stage: SessionStage = SessionStage.ANALYSIS

    # Project documents (specifications, designs, etc.)
    project_documents: List[DocumentContext] = field(default_factory=list)

    # Process documents (guidelines, standards, etc.)
    process_documents: List[DocumentContext] = field(default_factory=list)

    # Cross-chat history from other project sessions
    cross_chat_history: List[ChatHistoryEntry] = field(default_factory=list)

    # Graph context from Neo4j
    graph_context: Optional[str] = None

    # External search results (only allowed in ANALYSIS stage)
    external_search_results: List[ExternalSearchResult] = field(default_factory=list)

    def __post_init__(self):
        self.chat_type = ChatType.PROJECT

    @property
    def allows_external_tools(self) -> bool:
        """Check if external tools are allowed in current stage"""
        return self.stage == SessionStage.ANALYSIS

    @property
    def all_project_documents(self) -> List[DocumentContext]:
        """Get all project-related documents"""
        return self.project_documents + self.process_documents

    def to_dict(self) -> Dict[str, Any]:
        base = super().to_dict()
        base.update({
            "project": self.project.to_dict() if self.project else None,
            "stage": self.stage.value,
            "project_documents": [d.to_dict() for d in self.project_documents],
            "process_documents": [d.to_dict() for d in self.process_documents],
            "cross_chat_history": [h.to_dict() for h in self.cross_chat_history],
            "graph_context": self.graph_context,
            "external_search_results": [r.to_dict() for r in self.external_search_results],
            "allows_external_tools": self.allows_external_tools,
        })
        return base


# =============================================================================
# TOOL CONFIGURATION
# =============================================================================

@dataclass
class ExternalToolConfig:
    """Configuration for external tools"""
    tool_id: str
    tool_name: str
    category: ToolCategory
    enabled: bool = True

    # Stage restrictions (empty = allowed in all stages)
    allowed_stages: List[SessionStage] = field(default_factory=list)

    # Chat type restrictions
    allowed_chat_types: List[ChatType] = field(default_factory=lambda: [ChatType.GENERAL, ChatType.PROJECT])

    # Document category restrictions (for project chats)
    allowed_document_categories: List[DocumentCategory] = field(default_factory=list)

    # Rate limiting
    rate_limit_per_minute: int = 10

    # Tool-specific configuration
    config: Dict[str, Any] = field(default_factory=dict)

    def is_allowed_for_context(
        self,
        chat_type: ChatType,
        stage: Optional[SessionStage] = None,
        document_category: Optional[DocumentCategory] = None
    ) -> bool:
        """Check if tool is allowed for given context"""
        if not self.enabled:
            return False

        # Check chat type
        if chat_type not in self.allowed_chat_types:
            return False

        # Check stage (if specified and tool has restrictions)
        if self.allowed_stages and stage:
            if stage not in self.allowed_stages:
                return False

        # Check document category (if specified and tool has restrictions)
        if self.allowed_document_categories and document_category:
            if document_category not in self.allowed_document_categories:
                return False

        return True

    def to_dict(self) -> Dict[str, Any]:
        return {
            "tool_id": self.tool_id,
            "tool_name": self.tool_name,
            "category": self.category.value,
            "enabled": self.enabled,
            "allowed_stages": [s.value for s in self.allowed_stages],
            "allowed_chat_types": [c.value for c in self.allowed_chat_types],
            "allowed_document_categories": [d.value for d in self.allowed_document_categories],
            "rate_limit_per_minute": self.rate_limit_per_minute,
            "config": self.config,
        }


# =============================================================================
# PROMPT TEMPLATES
# =============================================================================

@dataclass
class PromptTemplate:
    """
    Template for LLM prompts.

    Supports different templates for different chat types and contexts.
    """
    template_id: str
    name: str
    chat_type: ChatType

    # System prompt template
    system_template: str

    # User context template (injected before user message)
    context_template: str = ""

    # Document reference template
    document_template: str = ""

    # History template
    history_template: str = ""

    # Project-specific template (for PROJECT chats)
    project_template: str = ""

    # Stage-specific templates (for PROJECT chats)
    stage_templates: Dict[SessionStage, str] = field(default_factory=dict)

    def render_system_prompt(
        self,
        context: ChatContext,
        **kwargs
    ) -> str:
        """
        Render the complete system prompt for given context.

        Args:
            context: Chat context
            **kwargs: Additional template variables

        Returns:
            Rendered system prompt
        """
        # Start with base system template
        prompt_parts = [self.system_template]

        # Add project-specific content for project chats
        if isinstance(context, ProjectSessionContext) and self.project_template:
            project_prompt = self.project_template.format(
                project_number=context.project.project_number if context.project else "",
                project_name=context.project.project_name if context.project else "",
                project_domain=context.project.domain if context.project else "",
                stage=context.stage.value,
                **kwargs
            )
            prompt_parts.append(project_prompt)

            # Add stage-specific content
            if context.stage in self.stage_templates:
                stage_prompt = self.stage_templates[context.stage].format(**kwargs)
                prompt_parts.append(stage_prompt)

        return "\n\n".join(prompt_parts)

    def render_context_section(
        self,
        context: ChatContext,
        **kwargs
    ) -> str:
        """Render the context section for the prompt"""
        if not self.context_template:
            return ""

        return self.context_template.format(
            user_id=context.user.user_id,
            username=context.user.username or "User",
            chat_id=context.chat_id,
            **kwargs
        )

    def render_document_section(
        self,
        documents: List[DocumentContext],
        **kwargs
    ) -> str:
        """Render the document references section"""
        if not documents or not self.document_template:
            return ""

        doc_sections = []
        for doc in documents:
            doc_section = self.document_template.format(
                filename=doc.filename,
                category=doc.category.value,
                summary=doc.content_summary or "No summary available",
                **kwargs
            )
            doc_sections.append(doc_section)

        return "\n".join(doc_sections)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "template_id": self.template_id,
            "name": self.name,
            "chat_type": self.chat_type.value,
            "system_template": self.system_template,
            "context_template": self.context_template,
            "document_template": self.document_template,
            "history_template": self.history_template,
            "project_template": self.project_template,
            "stage_templates": {k.value: v for k, v in self.stage_templates.items()},
        }


# =============================================================================
# MEMORY OPERATION RESULTS
# =============================================================================

@dataclass
class MemoryReadResult:
    """Result of a memory read operation"""
    success: bool
    data: Any = None
    source_tier: Optional[MemoryTier] = None
    cached: bool = False
    error: Optional[str] = None
    latency_ms: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "success": self.success,
            "data": self.data,
            "source_tier": self.source_tier.value if self.source_tier else None,
            "cached": self.cached,
            "error": self.error,
            "latency_ms": self.latency_ms,
        }


@dataclass
class MemoryWriteResult:
    """Result of a memory write operation"""
    success: bool
    tiers_written: List[MemoryTier] = field(default_factory=list)
    errors: Dict[MemoryTier, str] = field(default_factory=dict)
    latency_ms: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "success": self.success,
            "tiers_written": [t.value for t in self.tiers_written],
            "errors": {k.value: v for k, v in self.errors.items()},
            "latency_ms": self.latency_ms,
        }


# =============================================================================
# LLM RESPONSE MODELS
# =============================================================================

@dataclass
class LLMResponse:
    """Response from LLM wrapper"""
    success: bool
    content: str
    model: str
    mode: str  # online/offline
    tokens_used: int = 0
    cached: bool = False
    sources_referenced: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None
    latency_ms: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "success": self.success,
            "content": self.content,
            "model": self.model,
            "mode": self.mode,
            "tokens_used": self.tokens_used,
            "cached": self.cached,
            "sources_referenced": self.sources_referenced,
            "metadata": self.metadata,
            "error": self.error,
            "latency_ms": self.latency_ms,
        }
