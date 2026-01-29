"""
Integration Module
==================
Integrates the new chatbot_core architecture with existing services.

Provides:
- Service initialization
- Dependency injection
- FastAPI route helpers
- Migration utilities

Author: Simorgh Industrial Assistant
"""

import logging
from typing import Optional, Dict, Any
from functools import lru_cache

from .models import (
    ChatType,
    SessionStage,
    ChatContext,
    GeneralSessionContext,
    ProjectSessionContext,
    UserContext,
    ProjectInfo,
)
from .memory_manager import MemoryManager, get_memory_manager
from .cocoindex_dataflow import CocoIndexDataflowManager, get_dataflow_manager
from .session_manager import ChatSessionManager, get_session_manager
from .llm_wrapper import EnhancedLLMWrapper, get_llm_wrapper
from .external_tools import ExternalToolsManager, get_tools_manager
from .document_ingestion import DocumentIngestionPipeline, get_ingestion_pipeline
from .monitoring import ChatbotMonitor, get_monitor
from .registry import ExtensionRegistry, get_extension_registry

logger = logging.getLogger(__name__)


# =============================================================================
# CHATBOT CORE INSTANCE
# =============================================================================

class ChatbotCore:
    """
    Main entry point for the enhanced chatbot architecture.

    Aggregates all components and provides unified API.
    """

    def __init__(self):
        """Initialize chatbot core with lazy loading"""
        self._initialized = False

        # Component references (set during initialization)
        self.memory: Optional[MemoryManager] = None
        self.dataflow: Optional[CocoIndexDataflowManager] = None
        self.sessions: Optional[ChatSessionManager] = None
        self.llm: Optional[EnhancedLLMWrapper] = None
        self.tools: Optional[ExternalToolsManager] = None
        self.ingestion: Optional[DocumentIngestionPipeline] = None
        self.monitor: Optional[ChatbotMonitor] = None
        self.registry: Optional[ExtensionRegistry] = None

        # External service references
        self._redis_service = None
        self._qdrant_service = None
        self._neo4j_service = None
        self._llm_service = None
        self._doc_processor = None

    def initialize(
        self,
        redis_service=None,
        qdrant_service=None,
        neo4j_service=None,
        llm_service=None,
        doc_processor_client=None,
    ):
        """
        Initialize chatbot core with services.

        Args:
            redis_service: Redis service instance
            qdrant_service: Qdrant service instance
            neo4j_service: Neo4j service instance
            llm_service: LLM service instance
            doc_processor_client: Document processor client
        """
        self._redis_service = redis_service
        self._qdrant_service = qdrant_service
        self._neo4j_service = neo4j_service
        self._llm_service = llm_service
        self._doc_processor = doc_processor_client

        # Initialize monitoring first
        self.monitor = get_monitor()

        # Initialize registry
        self.registry = get_extension_registry()

        # Initialize CocoIndex dataflow manager
        self.dataflow = get_dataflow_manager(
            qdrant_service=qdrant_service,
            neo4j_service=neo4j_service,
            llm_service=llm_service,
        )

        # Initialize memory manager
        self.memory = get_memory_manager(
            redis_service=redis_service,
            cocoindex_dataflow=self.dataflow,
        )

        # Initialize session manager
        self.sessions = get_session_manager(
            memory_manager=self.memory,
            redis_service=redis_service,
        )

        # Initialize LLM wrapper
        self.llm = get_llm_wrapper(llm_service=llm_service)

        # Initialize tools manager
        self.tools = get_tools_manager()

        # Initialize document ingestion
        self.ingestion = get_ingestion_pipeline(
            cocoindex_manager=self.dataflow,
            qdrant_service=qdrant_service,
            neo4j_service=neo4j_service,
            llm_service=llm_service,
            doc_processor_client=doc_processor_client,
        )

        self._initialized = True
        self.monitor.info("ChatbotCore", "Chatbot core initialized successfully")

        logger.info("ChatbotCore initialized with all components")

    @property
    def is_initialized(self) -> bool:
        """Check if core is initialized"""
        return self._initialized

    # =========================================================================
    # HIGH-LEVEL API
    # =========================================================================

    async def create_chat(
        self,
        user_id: str,
        chat_type: ChatType,
        username: Optional[str] = None,
        project_number: Optional[str] = None,
        project_name: Optional[str] = None,
        project_domain: Optional[str] = None,
        stage: SessionStage = SessionStage.ANALYSIS,
    ) -> ChatContext:
        """
        Create a new chat session.

        Args:
            user_id: User identifier
            chat_type: General or Project
            username: Optional username
            project_number: Project number (for project chats)
            project_name: Project name (for project chats)
            project_domain: Project domain
            stage: Initial stage (for project chats)

        Returns:
            Created chat context
        """
        if chat_type == ChatType.GENERAL:
            return await self.sessions.create_general_session(
                user_id=user_id,
                username=username,
            )
        else:
            if not project_number:
                raise ValueError("project_number required for project chats")

            return await self.sessions.create_project_session(
                user_id=user_id,
                project_id=project_number,
                project_number=project_number,
                project_name=project_name or f"Project {project_number}",
                username=username,
                project_domain=project_domain,
                stage=stage,
            )

    async def send_message(
        self,
        chat_id: str,
        user_id: str,
        message: str,
        use_tools: bool = True,
        stream: bool = False,
    ) -> Dict[str, Any]:
        """
        Send a message and get response.

        Args:
            chat_id: Chat identifier
            user_id: User identifier
            message: User message
            use_tools: Whether to use external tools
            stream: Whether to stream response

        Returns:
            Response dict with content and metadata
        """
        # Get session
        context = await self.sessions.get_session(chat_id, user_id)
        if not context:
            return {"success": False, "error": "Chat not found"}

        # Determine project_id
        project_id = None
        if isinstance(context, ProjectSessionContext) and context.project:
            project_id = context.project.project_number

        # Build LLM context
        context = await self.sessions.build_llm_context(
            context=context,
            current_query=message,
        )

        # Check for tool usage (if enabled and allowed)
        if use_tools and self._should_use_tools(context, message):
            tool_results = await self._execute_relevant_tools(context, message)
            if tool_results:
                # Add tool results to context
                for result in tool_results:
                    await self.sessions.add_external_search_result(
                        context=context,
                        source=result.get("source", "tool"),
                        title=result.get("title", ""),
                        content=result.get("content", ""),
                        url=result.get("url"),
                    )

        # Store user message
        await self.memory.store_message(
            chat_type=context.chat_type,
            chat_id=chat_id,
            user_id=user_id,
            role="user",
            content=message,
            project_id=project_id,
        )

        # Generate response
        if stream:
            return {
                "success": True,
                "stream": self.llm.generate_stream(
                    context=context,
                    current_message=message,
                ),
            }
        else:
            response = await self.llm.generate(
                context=context,
                current_message=message,
            )

            # Store assistant response
            if response.success:
                await self.memory.store_message(
                    chat_type=context.chat_type,
                    chat_id=chat_id,
                    user_id=user_id,
                    role="assistant",
                    content=response.content,
                    project_id=project_id,
                )

            return {
                "success": response.success,
                "content": response.content,
                "model": response.model,
                "mode": response.mode,
                "tokens_used": response.tokens_used,
                "sources": response.sources_referenced,
                "error": response.error,
            }

    async def upload_document(
        self,
        chat_id: str,
        user_id: str,
        content: str,
        filename: str,
        category: str = "general",
    ) -> Dict[str, Any]:
        """
        Upload and process a document.

        Args:
            chat_id: Chat identifier
            user_id: User identifier
            content: Document content
            filename: Filename
            category: Document category

        Returns:
            Ingestion result
        """
        from .models import DocumentCategory

        # Get session to determine context
        context = await self.sessions.get_session(chat_id, user_id)
        if not context:
            return {"success": False, "error": "Chat not found"}

        project_id = None
        if isinstance(context, ProjectSessionContext) and context.project:
            project_id = context.project.project_number

        # Ingest document
        result = await self.ingestion.ingest_document(
            content=content,
            filename=filename,
            user_id=user_id,
            chat_type=context.chat_type,
            chat_id=chat_id,
            project_id=project_id,
            category=DocumentCategory(category),
        )

        return result.to_dict()

    # =========================================================================
    # HELPER METHODS
    # =========================================================================

    def _should_use_tools(self, context: ChatContext, message: str) -> bool:
        """Determine if tools should be used"""
        # Check if tools are allowed
        if isinstance(context, ProjectSessionContext):
            if not context.allows_external_tools:
                return False

        # Simple heuristic: check for question patterns
        question_patterns = ["?", "what is", "how to", "explain", "search", "find"]
        return any(p in message.lower() for p in question_patterns)

    async def _execute_relevant_tools(
        self,
        context: ChatContext,
        message: str,
    ) -> list:
        """Execute relevant tools based on message"""
        results = []

        # Wikipedia for definitional questions
        if any(p in message.lower() for p in ["what is", "define", "explain"]):
            wiki_result = await self.tools.search_wikipedia(message, context)
            if wiki_result.success:
                for r in wiki_result.results:
                    results.append({
                        "source": "wikipedia",
                        "title": r.title,
                        "content": r.content,
                        "url": r.url,
                    })

        return results

    # =========================================================================
    # STATISTICS
    # =========================================================================

    def get_stats(self) -> Dict[str, Any]:
        """Get comprehensive statistics"""
        return {
            "initialized": self._initialized,
            "memory": self.memory.get_stats() if self.memory else None,
            "llm": self.llm.get_stats() if self.llm else None,
            "tools": self.tools.get_stats() if self.tools else None,
            "ingestion": self.ingestion.get_stats() if self.ingestion else None,
            "monitor": self.monitor.get_summary() if self.monitor else None,
            "registry": self.registry.get_summary() if self.registry else None,
            "sessions_active": self.sessions.get_active_session_count() if self.sessions else 0,
        }


# =============================================================================
# SINGLETON
# =============================================================================

_chatbot_core: Optional[ChatbotCore] = None


def get_chatbot_core() -> ChatbotCore:
    """Get or create chatbot core singleton"""
    global _chatbot_core

    if _chatbot_core is None:
        _chatbot_core = ChatbotCore()

    return _chatbot_core


# =============================================================================
# FASTAPI DEPENDENCY INJECTION
# =============================================================================

def get_chatbot_core_dependency():
    """FastAPI dependency for chatbot core"""
    return get_chatbot_core()


def get_memory_dependency():
    """FastAPI dependency for memory manager"""
    core = get_chatbot_core()
    return core.memory


def get_session_dependency():
    """FastAPI dependency for session manager"""
    core = get_chatbot_core()
    return core.sessions


def get_llm_dependency():
    """FastAPI dependency for LLM wrapper"""
    core = get_chatbot_core()
    return core.llm


def get_tools_dependency():
    """FastAPI dependency for tools manager"""
    core = get_chatbot_core()
    return core.tools


def get_ingestion_dependency():
    """FastAPI dependency for document ingestion"""
    core = get_chatbot_core()
    return core.ingestion


# =============================================================================
# INITIALIZATION HELPER
# =============================================================================

async def initialize_chatbot_core(
    redis_service=None,
    qdrant_service=None,
    neo4j_service=None,
    llm_service=None,
    doc_processor_client=None,
) -> ChatbotCore:
    """
    Initialize the chatbot core with all services.

    This should be called during FastAPI startup.

    Args:
        redis_service: Redis service instance
        qdrant_service: Qdrant service instance
        neo4j_service: Neo4j service instance
        llm_service: LLM service instance
        doc_processor_client: Document processor client

    Returns:
        Initialized ChatbotCore
    """
    core = get_chatbot_core()

    if not core.is_initialized:
        core.initialize(
            redis_service=redis_service,
            qdrant_service=qdrant_service,
            neo4j_service=neo4j_service,
            llm_service=llm_service,
            doc_processor_client=doc_processor_client,
        )

    return core
