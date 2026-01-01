"""
Unified Memory Service
======================
Single entry point for all memory operations.
Provides consistent memory handling across batch and streaming endpoints.

Implements tiered memory architecture:
- Tier 1: Redis (Working memory - fast access)
- Tier 2: Session summaries (Compressed context)
- Tier 3: Qdrant (Semantic memory - relevant past conversations)
- Tier 4: PostgreSQL (Persistent archive - full history)

Author: Simorgh Industrial Assistant
"""

import logging
import asyncio
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime
import uuid

from .context_window_manager import ContextWindowManager, get_context_window_manager
from .conversation_summarizer import ConversationSummarizer, get_conversation_summarizer
from .message_persistence import MessagePersistenceService, get_message_persistence

logger = logging.getLogger(__name__)


class UnifiedMemoryService:
    """
    Unified memory service providing consistent memory handling.

    Features:
    - Single API for all memory operations
    - Automatic tiered storage (Redis + Qdrant + PostgreSQL)
    - Token-aware context building
    - Rolling conversation summaries
    - Transaction-like semantics for storage
    """

    def __init__(
        self,
        redis_service=None,
        qdrant_service=None,
        llm_service=None,
        neo4j_service=None
    ):
        """
        Initialize unified memory service.

        Args:
            redis_service: Redis service for working memory
            qdrant_service: Qdrant service for semantic memory
            llm_service: LLM service for summarization
            neo4j_service: Neo4j service for graph context
        """
        self.redis = redis_service
        self.qdrant = qdrant_service
        self.llm = llm_service
        self.neo4j = neo4j_service

        # Initialize sub-services
        self.context_manager = get_context_window_manager()
        self.summarizer = get_conversation_summarizer(llm_service, redis_service)
        self.persistence = get_message_persistence()

        # Track initialization
        self._initialized = False

        logger.info("UnifiedMemoryService created")

    def set_services(
        self,
        redis_service=None,
        qdrant_service=None,
        llm_service=None,
        neo4j_service=None
    ):
        """Update service dependencies after initialization"""
        if redis_service:
            self.redis = redis_service
            self.summarizer.set_services(redis_service=redis_service)
        if qdrant_service:
            self.qdrant = qdrant_service
        if llm_service:
            self.llm = llm_service
            self.summarizer.set_services(llm_service=llm_service)
        if neo4j_service:
            self.neo4j = neo4j_service

    async def initialize(self):
        """Initialize async components"""
        if self._initialized:
            return

        try:
            await self.persistence.initialize()
            self._initialized = True
            logger.info("UnifiedMemoryService initialized")
        except Exception as e:
            logger.warning(f"Persistence initialization failed (non-fatal): {e}")
            self._initialized = True  # Continue without persistence

    async def store_message(
        self,
        chat_id: str,
        user_id: str,
        role: str,
        content: str,
        project_number: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> Tuple[bool, str]:
        """
        Store a message across all tiers.

        Implements transaction-like semantics:
        1. Store in Redis (primary - must succeed)
        2. Store in PostgreSQL (backup - best effort)
        3. Store in Qdrant if assistant message (semantic - best effort)

        Args:
            chat_id: Chat identifier
            user_id: User identifier
            role: Message role (user/assistant)
            content: Message content
            project_number: Optional project number
            metadata: Optional metadata

        Returns:
            Tuple of (success, message_id)
        """
        message_id = str(uuid.uuid4())
        created_at = datetime.utcnow().isoformat()

        # Build message object
        message = {
            "message_id": message_id,
            "chat_id": chat_id,
            "user_id": user_id,
            "role": role,
            "sender": role,
            "content": content,
            "text": content,
            "project_id": project_number,
            "timestamp": created_at,
            "created_at": created_at,
            **(metadata or {})
        }

        success = True

        # Tier 1: Redis (Primary - must succeed)
        try:
            if self.redis:
                self.redis.cache_chat_message(chat_id, message)
                logger.debug(f"Message stored in Redis: {message_id[:8]}...")
        except Exception as e:
            logger.error(f"Redis storage failed: {e}")
            success = False

        # Tier 4: PostgreSQL (Backup - best effort)
        try:
            await self.persistence.store_message(
                message_id=message_id,
                chat_id=chat_id,
                user_id=user_id,
                role=role,
                content=content,
                project_number=project_number,
                metadata=metadata
            )
            logger.debug(f"Message stored in PostgreSQL: {message_id[:8]}...")
        except Exception as e:
            logger.warning(f"PostgreSQL storage failed (non-fatal): {e}")

        # Tier 3: Qdrant for semantic search (only for complete exchanges)
        # This is handled separately in store_conversation_pair

        return success, message_id

    async def store_conversation_pair(
        self,
        chat_id: str,
        user_id: str,
        user_message: str,
        assistant_response: str,
        project_number: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> bool:
        """
        Store a complete user-assistant conversation pair.

        This method should be called after receiving the complete assistant response.
        It stores both messages and creates semantic embeddings.

        Args:
            chat_id: Chat identifier
            user_id: User identifier
            user_message: User's message
            assistant_response: Assistant's response
            project_number: Optional project number
            metadata: Optional metadata

        Returns:
            True if successful
        """
        # Store user message
        user_success, user_msg_id = await self.store_message(
            chat_id=chat_id,
            user_id=user_id,
            role="user",
            content=user_message,
            project_number=project_number,
            metadata={"pair_id": user_msg_id if 'user_msg_id' in dir() else None}
        )

        # Store assistant message
        assistant_metadata = {
            **(metadata or {}),
            "pair_id": user_msg_id
        }
        assistant_success, assistant_msg_id = await self.store_message(
            chat_id=chat_id,
            user_id=user_id,
            role="assistant",
            content=assistant_response,
            project_number=project_number,
            metadata=assistant_metadata
        )

        # Tier 3: Store in Qdrant for semantic retrieval
        try:
            if self.qdrant:
                self.qdrant.store_user_conversation(
                    user_id=user_id,
                    user_message=user_message,
                    assistant_response=assistant_response,
                    chat_id=chat_id,
                    project_number=project_number,
                    metadata={
                        "user_msg_id": user_msg_id,
                        "assistant_msg_id": assistant_msg_id,
                        **(metadata or {})
                    }
                )
                logger.debug(f"Conversation stored in Qdrant for semantic search")
        except Exception as e:
            logger.warning(f"Qdrant storage failed (non-fatal): {e}")

        return user_success and assistant_success

    async def get_context_for_llm(
        self,
        chat_id: str,
        user_id: str,
        current_query: str,
        project_number: Optional[str] = None,
        system_prompt: str = "",
        graph_context: Optional[str] = None,
        use_semantic_memory: bool = True,
        use_summary: bool = True
    ) -> Dict[str, Any]:
        """
        Build complete context for LLM call.

        Retrieves and combines:
        1. Recent chat history from Redis
        2. Conversation summary (if available)
        3. Semantic memories from Qdrant
        4. Graph context (if provided)

        Args:
            chat_id: Chat identifier
            user_id: User identifier
            current_query: Current user message
            project_number: Optional project number
            system_prompt: Base system prompt
            graph_context: Optional knowledge graph context
            use_semantic_memory: Whether to include semantic memories
            use_summary: Whether to include conversation summary

        Returns:
            Dict with 'messages' list and 'metadata'
        """
        # Gather all context sources in parallel
        tasks = []

        # Task 1: Get recent messages from Redis
        async def get_redis_history():
            if self.redis:
                return self.redis.get_chat_history(chat_id, limit=20)
            return []

        tasks.append(get_redis_history())

        # Task 2: Get or generate summary
        async def get_summary():
            if not use_summary:
                return None
            try:
                messages = self.redis.get_chat_history(chat_id, limit=50) if self.redis else []
                return await self.summarizer.maybe_summarize(chat_id, messages)
            except Exception as e:
                logger.warning(f"Summary retrieval failed: {e}")
                return None

        tasks.append(get_summary())

        # Task 3: Get semantic memories from Qdrant
        async def get_semantic_memories():
            if not use_semantic_memory or not self.qdrant:
                return []
            try:
                return self.qdrant.retrieve_similar_conversations(
                    user_id=user_id,
                    current_query=current_query,
                    limit=5,
                    score_threshold=0.6,
                    project_filter=project_number,
                    chat_id=chat_id,
                    fallback_to_recent=True,
                    fallback_limit=5
                )
            except Exception as e:
                logger.warning(f"Semantic memory retrieval failed: {e}")
                return []

        tasks.append(get_semantic_memories())

        # Execute all tasks in parallel
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Process results
        recent_messages = results[0] if not isinstance(results[0], Exception) else []
        session_summary = results[1] if not isinstance(results[1], Exception) else None
        semantic_memories = results[2] if not isinstance(results[2], Exception) else []

        # Log what we retrieved
        logger.info(
            f"Context retrieved: {len(recent_messages)} recent messages, "
            f"summary={'yes' if session_summary else 'no'}, "
            f"{len(semantic_memories)} semantic memories"
        )

        # Build context using token-aware manager
        context_result = self.context_manager.build_context(
            system_prompt=system_prompt,
            current_message=current_query,
            chat_history=recent_messages,
            semantic_memories=semantic_memories,
            session_summary=session_summary,
            graph_context=graph_context
        )

        return {
            "messages": context_result.messages,
            "budget": {
                "total_used": context_result.budget.total_used,
                "total_available": context_result.budget.total_available,
                "recent_history": context_result.budget.recent_history,
                "semantic_memory": context_result.budget.semantic_memory,
                "session_summary": context_result.budget.session_summary,
                "graph_context": context_result.budget.graph_context
            },
            "truncated": context_result.truncated,
            "warnings": context_result.warnings,
            "metadata": {
                "recent_message_count": len(recent_messages),
                "semantic_memory_count": len(semantic_memories),
                "has_summary": session_summary is not None,
                "has_graph_context": graph_context is not None
            }
        }

    async def get_chat_history(
        self,
        chat_id: str,
        limit: int = 50,
        offset: int = 0,
        prefer_persistent: bool = False
    ) -> List[Dict[str, Any]]:
        """
        Get chat history, with fallback between storage layers.

        Args:
            chat_id: Chat identifier
            limit: Maximum messages to return
            offset: Offset for pagination
            prefer_persistent: If True, prefer PostgreSQL over Redis

        Returns:
            List of messages
        """
        if prefer_persistent:
            # Try PostgreSQL first
            try:
                messages = await self.persistence.get_chat_messages(
                    chat_id, limit=limit, offset=offset
                )
                if messages:
                    return messages
            except Exception as e:
                logger.warning(f"PostgreSQL retrieval failed: {e}")

        # Fall back to Redis
        if self.redis:
            try:
                return self.redis.get_chat_history(chat_id, limit=limit, offset=offset)
            except Exception as e:
                logger.warning(f"Redis retrieval failed: {e}")

        # Last resort: try PostgreSQL if we didn't already
        if not prefer_persistent:
            try:
                return await self.persistence.get_chat_messages(
                    chat_id, limit=limit, offset=offset
                )
            except Exception as e:
                logger.warning(f"PostgreSQL fallback failed: {e}")

        return []

    async def delete_chat(
        self,
        chat_id: str,
        user_id: str
    ) -> bool:
        """
        Delete a chat from all storage layers.

        Args:
            chat_id: Chat identifier
            user_id: User identifier

        Returns:
            True if successful
        """
        success = True

        # Delete from Redis
        try:
            if self.redis:
                self.redis.delete_chat(chat_id, user_id)
                logger.debug(f"Chat deleted from Redis: {chat_id}")
        except Exception as e:
            logger.warning(f"Redis deletion failed: {e}")
            success = False

        # Delete from PostgreSQL
        try:
            await self.persistence.delete_chat(chat_id)
            logger.debug(f"Chat deleted from PostgreSQL: {chat_id}")
        except Exception as e:
            logger.warning(f"PostgreSQL deletion failed: {e}")

        # Delete from Qdrant (session collection)
        try:
            if self.qdrant:
                self.qdrant.delete_session_collection(
                    user_id=user_id,
                    session_id=chat_id
                )
                logger.debug(f"Chat collection deleted from Qdrant: {chat_id}")
        except Exception as e:
            logger.warning(f"Qdrant deletion failed: {e}")

        # Clear summary
        try:
            await self.summarizer.clear_summary(chat_id)
        except Exception as e:
            logger.warning(f"Summary deletion failed: {e}")

        return success

    async def sync_redis_to_postgres(self, chat_id: str) -> int:
        """
        Sync messages from Redis to PostgreSQL.

        Useful for backup or recovery.

        Args:
            chat_id: Chat to sync

        Returns:
            Number of messages synced
        """
        if not self.redis:
            return 0

        return await self.persistence.sync_from_redis(self.redis, chat_id)

    def get_memory_stats(self, chat_id: str) -> Dict[str, Any]:
        """
        Get memory statistics for a chat.

        Args:
            chat_id: Chat identifier

        Returns:
            Stats dictionary
        """
        stats = {
            "chat_id": chat_id,
            "redis": {},
            "qdrant": {},
            "summary": {}
        }

        # Redis stats
        if self.redis:
            try:
                count = self.redis.get_chat_count(chat_id)
                stats["redis"]["message_count"] = count
            except Exception:
                stats["redis"]["error"] = "Failed to get stats"

        # Qdrant stats
        if self.qdrant:
            try:
                collection_stats = self.qdrant.get_collection_stats(
                    user_id="system",
                    session_id=chat_id
                )
                stats["qdrant"] = collection_stats
            except Exception:
                stats["qdrant"]["error"] = "Failed to get stats"

        return stats


# =============================================================================
# SINGLETON INSTANCE
# =============================================================================

_unified_memory: Optional[UnifiedMemoryService] = None


def get_unified_memory_service(
    redis_service=None,
    qdrant_service=None,
    llm_service=None,
    neo4j_service=None
) -> UnifiedMemoryService:
    """Get or create unified memory service singleton"""
    global _unified_memory

    if _unified_memory is None:
        _unified_memory = UnifiedMemoryService(
            redis_service=redis_service,
            qdrant_service=qdrant_service,
            llm_service=llm_service,
            neo4j_service=neo4j_service
        )
    elif any([redis_service, qdrant_service, llm_service, neo4j_service]):
        _unified_memory.set_services(
            redis_service=redis_service,
            qdrant_service=qdrant_service,
            llm_service=llm_service,
            neo4j_service=neo4j_service
        )

    return _unified_memory


async def init_unified_memory_service(
    redis_service=None,
    qdrant_service=None,
    llm_service=None,
    neo4j_service=None
) -> UnifiedMemoryService:
    """Initialize and return unified memory service"""
    service = get_unified_memory_service(
        redis_service=redis_service,
        qdrant_service=qdrant_service,
        llm_service=llm_service,
        neo4j_service=neo4j_service
    )
    await service.initialize()
    return service
