"""
Chat Session Manager
====================
Manages General-Session and Project-Session chat lifecycles.

Features:
- Create/retrieve/delete sessions
- Context building for LLM calls
- Session state management
- Cross-chat memory for project sessions

Author: Simorgh Industrial Assistant
"""

import logging
import uuid
from typing import Optional, Dict, Any, List
from datetime import datetime

from .models import (
    ChatType,
    SessionStage,
    ChatContext,
    GeneralSessionContext,
    ProjectSessionContext,
    UserContext,
    ProjectInfo,
    DocumentContext,
    ChatHistoryEntry,
    ExternalSearchResult,
    DocumentCategory,
)
from .memory_manager import MemoryManager, get_memory_manager

logger = logging.getLogger(__name__)


class ChatSessionManager:
    """
    Manages chat session lifecycles for both General and Project sessions.

    Responsibilities:
    - Create and initialize new sessions
    - Load existing session contexts
    - Build LLM-ready contexts
    - Manage session state transitions
    - Handle cross-chat memory for projects
    """

    def __init__(
        self,
        memory_manager: Optional[MemoryManager] = None,
        redis_service=None,
    ):
        """
        Initialize session manager.

        Args:
            memory_manager: Memory manager for storage operations
            redis_service: Redis service for direct session storage
        """
        self.memory = memory_manager or get_memory_manager()
        self.redis = redis_service

        # Active sessions cache (in-memory for fast access)
        self._active_sessions: Dict[str, ChatContext] = {}

        logger.info("ChatSessionManager initialized")

    def set_services(
        self,
        memory_manager: Optional[MemoryManager] = None,
        redis_service=None,
    ):
        """Update service dependencies"""
        if memory_manager:
            self.memory = memory_manager
        if redis_service:
            self.redis = redis_service

    # =========================================================================
    # SESSION CREATION
    # =========================================================================

    async def create_general_session(
        self,
        user_id: str,
        username: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> GeneralSessionContext:
        """
        Create a new General-Session chat.

        General sessions are isolated - each chat has its own memory.

        Args:
            user_id: User identifier
            username: Optional username
            metadata: Optional session metadata

        Returns:
            New GeneralSessionContext
        """
        chat_id = str(uuid.uuid4())

        user = UserContext(
            user_id=user_id,
            username=username,
        )

        context = GeneralSessionContext(
            chat_id=chat_id,
            chat_type=ChatType.GENERAL,
            user=user,
            metadata=metadata or {},
        )

        # Store in active sessions
        self._active_sessions[chat_id] = context

        # Register chat in Redis
        if self.redis:
            self.redis.add_chat_to_user_index(
                user_id=user_id,
                chat_id=chat_id,
                chat_type="general",
            )

        logger.info(f"Created general session: {chat_id}")
        return context

    async def create_project_session(
        self,
        user_id: str,
        project_id: str,
        project_number: str,
        project_name: str,
        username: Optional[str] = None,
        project_domain: Optional[str] = None,
        stage: SessionStage = SessionStage.ANALYSIS,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> ProjectSessionContext:
        """
        Create a new Project-Session chat.

        Project sessions share memory within the project.

        Args:
            user_id: User identifier
            project_id: Project identifier
            project_number: Project number (e.g., OE number)
            project_name: Project name
            username: Optional username
            project_domain: Project domain (e.g., "electrical")
            stage: Initial session stage
            metadata: Optional session metadata

        Returns:
            New ProjectSessionContext
        """
        chat_id = str(uuid.uuid4())

        user = UserContext(
            user_id=user_id,
            username=username,
        )

        project = ProjectInfo(
            project_id=project_id,
            project_number=project_number,
            project_name=project_name,
            domain=project_domain or "industrial electrical",
        )

        context = ProjectSessionContext(
            chat_id=chat_id,
            chat_type=ChatType.PROJECT,
            user=user,
            project=project,
            stage=stage,
            metadata=metadata or {},
        )

        # Store in active sessions
        self._active_sessions[chat_id] = context

        # Register chat in Redis
        if self.redis:
            self.redis.add_chat_to_user_index(
                user_id=user_id,
                chat_id=chat_id,
                chat_type="project",
                project_number=project_number,
            )

        logger.info(f"Created project session: {chat_id} for project {project_number}")
        return context

    # =========================================================================
    # SESSION RETRIEVAL
    # =========================================================================

    async def get_session(
        self,
        chat_id: str,
        user_id: str,
    ) -> Optional[ChatContext]:
        """
        Get an existing session by ID.

        Args:
            chat_id: Chat identifier
            user_id: User identifier (for validation)

        Returns:
            ChatContext or None if not found
        """
        # Check active sessions cache first
        if chat_id in self._active_sessions:
            context = self._active_sessions[chat_id]
            if context.user.user_id == user_id:
                return context

        # Load from storage
        context = await self._load_session(chat_id, user_id)
        if context:
            self._active_sessions[chat_id] = context

        return context

    async def _load_session(
        self,
        chat_id: str,
        user_id: str,
    ) -> Optional[ChatContext]:
        """Load session from storage"""
        if not self.redis:
            return None

        try:
            # Check if it's a general or project chat
            general_chats = self.redis.get_user_general_chats(user_id)
            if chat_id in general_chats:
                return await self._load_general_session(chat_id, user_id)

            # Check project chats
            # Would need to check across all projects
            all_chats = self.redis.get_user_all_chats(user_id)
            if chat_id in all_chats:
                return await self._load_project_session(chat_id, user_id)

            return None

        except Exception as e:
            logger.error(f"Error loading session: {e}")
            return None

    async def _load_general_session(
        self,
        chat_id: str,
        user_id: str,
    ) -> Optional[GeneralSessionContext]:
        """Load a general session"""
        user = UserContext(user_id=user_id)

        context = GeneralSessionContext(
            chat_id=chat_id,
            chat_type=ChatType.GENERAL,
            user=user,
        )

        # Load history from memory manager
        history_result = await self.memory.get_chat_history(
            chat_type=ChatType.GENERAL,
            chat_id=chat_id,
            limit=50,
        )

        if history_result.success and history_result.data:
            context.history_window = [
                ChatHistoryEntry(
                    message_id=m.get("message_id", ""),
                    role=m.get("role", "user"),
                    content=m.get("content") or m.get("text", ""),
                    timestamp=datetime.fromisoformat(m["timestamp"]) if m.get("timestamp") else datetime.utcnow(),
                )
                for m in history_result.data
            ]
            context.full_history_count = len(history_result.data)

        return context

    async def _load_project_session(
        self,
        chat_id: str,
        user_id: str,
    ) -> Optional[ProjectSessionContext]:
        """Load a project session"""
        # This would need project metadata from storage
        # Simplified version - in production, load full project info

        user = UserContext(user_id=user_id)

        context = ProjectSessionContext(
            chat_id=chat_id,
            chat_type=ChatType.PROJECT,
            user=user,
            stage=SessionStage.ANALYSIS,
        )

        return context

    # =========================================================================
    # CONTEXT BUILDING
    # =========================================================================

    async def build_llm_context(
        self,
        context: ChatContext,
        current_query: str,
        include_documents: bool = True,
        include_graph: bool = True,
        include_semantic: bool = True,
    ) -> ChatContext:
        """
        Build complete context for LLM call.

        Populates context with:
        - Chat history
        - Document context
        - Graph context (for project sessions)
        - Semantic search results

        Args:
            context: Session context to populate
            current_query: Current user query
            include_documents: Include document context
            include_graph: Include graph context (project only)
            include_semantic: Include semantic search

        Returns:
            Populated context
        """
        # Determine project_id
        project_id = None
        if isinstance(context, ProjectSessionContext) and context.project:
            project_id = context.project.project_number

        # Build context from memory manager
        memory_context = await self.memory.build_llm_context(
            chat_type=context.chat_type,
            chat_id=context.chat_id,
            user_id=context.user.user_id,
            current_query=current_query,
            project_id=project_id,
            include_documents=include_documents,
            include_graph=include_graph,
            include_semantic=include_semantic,
        )

        # Populate history
        if memory_context.get("history"):
            context.history_window = [
                ChatHistoryEntry(
                    message_id=m.get("message_id", ""),
                    role=m.get("role", "user"),
                    content=m.get("content") or m.get("text", ""),
                    timestamp=datetime.fromisoformat(m["timestamp"]) if m.get("timestamp") else datetime.utcnow(),
                    source_chat_id=m.get("source_chat_id"),
                )
                for m in memory_context["history"]
            ]

        # Populate documents
        if memory_context.get("documents"):
            context.documents = [
                DocumentContext(
                    document_id=d.get("document_id", ""),
                    filename=d.get("filename", "Unknown"),
                    category=DocumentCategory(d.get("category", "general")),
                    content_summary=d.get("content_summary"),
                )
                for d in memory_context["documents"]
            ]

        # Populate graph context for project sessions
        if isinstance(context, ProjectSessionContext):
            if memory_context.get("graph_context"):
                context.graph_context = memory_context["graph_context"]

            # Separate cross-chat history
            if context.history_window:
                cross_chat = [
                    h for h in context.history_window
                    if h.source_chat_id and h.source_chat_id != context.chat_id
                ]
                context.cross_chat_history = cross_chat

        # Store semantic results for possible use
        if memory_context.get("semantic_results"):
            # Could be used for RAG or context injection
            context.metadata["semantic_results"] = memory_context["semantic_results"]

        return context

    # =========================================================================
    # SESSION STATE MANAGEMENT
    # =========================================================================

    async def update_stage(
        self,
        context: ProjectSessionContext,
        new_stage: SessionStage,
    ) -> ProjectSessionContext:
        """
        Update project session stage.

        Args:
            context: Project session context
            new_stage: New stage

        Returns:
            Updated context
        """
        old_stage = context.stage
        context.stage = new_stage
        context.updated_at = datetime.utcnow()

        logger.info(f"Session {context.chat_id} stage: {old_stage.value} -> {new_stage.value}")

        return context

    async def add_external_search_result(
        self,
        context: ChatContext,
        source: str,
        title: str,
        content: str,
        url: Optional[str] = None,
        relevance_score: float = 0.0,
    ) -> ChatContext:
        """
        Add external search result to context.

        For project sessions, only allowed in ANALYSIS stage.

        Args:
            context: Chat context
            source: Source of result (internet, wikipedia, etc.)
            title: Result title
            content: Result content
            url: Optional URL
            relevance_score: Relevance score

        Returns:
            Updated context
        """
        result = ExternalSearchResult(
            source=source,
            title=title,
            content=content,
            url=url,
            relevance_score=relevance_score,
        )

        if isinstance(context, GeneralSessionContext):
            context.external_search_results.append(result)
        elif isinstance(context, ProjectSessionContext):
            if context.allows_external_tools:
                context.external_search_results.append(result)
            else:
                logger.warning(
                    f"External search not allowed in {context.stage.value} stage"
                )

        return context

    async def add_document(
        self,
        context: ChatContext,
        document_id: str,
        filename: str,
        category: DocumentCategory = DocumentCategory.GENERAL,
        content_summary: Optional[str] = None,
    ) -> ChatContext:
        """
        Add document to context.

        Args:
            context: Chat context
            document_id: Document identifier
            filename: Filename
            category: Document category
            content_summary: Optional summary

        Returns:
            Updated context
        """
        doc = DocumentContext(
            document_id=document_id,
            filename=filename,
            category=category,
            content_summary=content_summary,
        )

        if isinstance(context, ProjectSessionContext):
            if category == DocumentCategory.PROCESS:
                context.process_documents.append(doc)
            else:
                context.project_documents.append(doc)
        else:
            context.documents.append(doc)

        return context

    # =========================================================================
    # SESSION DELETION
    # =========================================================================

    async def delete_session(
        self,
        chat_id: str,
        user_id: str,
    ) -> bool:
        """
        Delete a session and all its data.

        Args:
            chat_id: Chat identifier
            user_id: User identifier

        Returns:
            True if successful
        """
        try:
            # Remove from active sessions
            if chat_id in self._active_sessions:
                context = self._active_sessions.pop(chat_id)
                project_id = None
                if isinstance(context, ProjectSessionContext) and context.project:
                    project_id = context.project.project_number
            else:
                project_id = None

            # Invalidate caches
            await self.memory.invalidate_chat_cache(
                chat_type=ChatType.GENERAL,  # Will be determined by memory manager
                chat_id=chat_id,
                project_id=project_id,
            )

            # Delete from Redis
            if self.redis:
                self.redis.delete_chat(chat_id, user_id)

            logger.info(f"Deleted session: {chat_id}")
            return True

        except Exception as e:
            logger.error(f"Error deleting session: {e}")
            return False

    # =========================================================================
    # UTILITIES
    # =========================================================================

    async def list_user_sessions(
        self,
        user_id: str,
        chat_type: Optional[ChatType] = None,
        project_number: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        List user's chat sessions.

        Args:
            user_id: User identifier
            chat_type: Optional filter by chat type
            project_number: Optional filter by project

        Returns:
            List of session summaries
        """
        sessions = []

        if not self.redis:
            return sessions

        try:
            if chat_type == ChatType.GENERAL or chat_type is None:
                general_chats = self.redis.get_user_general_chats(user_id)
                for chat_id in general_chats:
                    sessions.append({
                        "chat_id": chat_id,
                        "chat_type": ChatType.GENERAL.value,
                    })

            if (chat_type == ChatType.PROJECT or chat_type is None) and project_number:
                project_chats = self.redis.get_user_project_chats(user_id, project_number)
                for chat_id in project_chats:
                    sessions.append({
                        "chat_id": chat_id,
                        "chat_type": ChatType.PROJECT.value,
                        "project_number": project_number,
                    })

            return sessions

        except Exception as e:
            logger.error(f"Error listing sessions: {e}")
            return []

    def get_active_session_count(self) -> int:
        """Get count of active sessions in memory"""
        return len(self._active_sessions)

    def clear_inactive_sessions(self, max_age_hours: int = 24):
        """Clear old sessions from active cache"""
        cutoff = datetime.utcnow()
        to_remove = []

        for chat_id, context in self._active_sessions.items():
            age = cutoff - context.updated_at
            if age.total_seconds() > max_age_hours * 3600:
                to_remove.append(chat_id)

        for chat_id in to_remove:
            del self._active_sessions[chat_id]

        if to_remove:
            logger.info(f"Cleared {len(to_remove)} inactive sessions")


# =============================================================================
# SINGLETON
# =============================================================================

_session_manager: Optional[ChatSessionManager] = None


def get_session_manager(
    memory_manager: Optional[MemoryManager] = None,
    redis_service=None,
) -> ChatSessionManager:
    """Get or create session manager singleton"""
    global _session_manager

    if _session_manager is None:
        _session_manager = ChatSessionManager(
            memory_manager=memory_manager,
            redis_service=redis_service,
        )
    elif memory_manager or redis_service:
        _session_manager.set_services(
            memory_manager=memory_manager,
            redis_service=redis_service,
        )

    return _session_manager
