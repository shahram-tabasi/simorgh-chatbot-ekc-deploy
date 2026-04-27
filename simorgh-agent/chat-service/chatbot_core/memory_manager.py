"""
Memory Manager
==============
Unified memory management with Redis-first caching and CocoIndex fallback.

Routes all memory operations:
1. Check Redis cache first (high-speed)
2. Fallback to CocoIndex-triggered fetches from DBs
3. Cache results in Redis

Memory Types:
- Redis: High-speed cache (direct access, not via CocoIndex)
- Postgres: Tabular data (via CocoIndex)
- Qdrant: Vector data (via CocoIndex)
- Neo4j: Graph data (via CocoIndex)

Namespace Convention:
- General chats: 'general:chat_id:{chat_id}:*'
- Project chats: 'project:project_id:{project_id}:*'

Author: Simorgh Industrial Assistant
"""

import logging
import time
import json
from typing import List, Dict, Any, Optional, Union
from datetime import datetime, timedelta

from .models import (
    ChatType,
    MemoryTier,
    ChatContext,
    GeneralSessionContext,
    ProjectSessionContext,
    ChatHistoryEntry,
    DocumentContext,
    MemoryReadResult,
    MemoryWriteResult,
)

logger = logging.getLogger(__name__)


# =============================================================================
# REDIS NAMESPACE HELPERS
# =============================================================================

class RedisNamespace:
    """Helper class for Redis key namespacing"""

    # TTL configurations (in seconds)
    TTL_SESSION = 86400        # 24 hours for session data
    TTL_HISTORY = 86400        # 24 hours for chat history
    TTL_CACHE = 3600           # 1 hour for cached results
    TTL_CONTEXT = 1800         # 30 minutes for context cache
    TTL_TEMP = 300             # 5 minutes for temporary data

    @staticmethod
    def general_chat(chat_id: str, suffix: str = "") -> str:
        """Generate key for general chat data"""
        base = f"general:chat_id:{chat_id}"
        return f"{base}:{suffix}" if suffix else base

    @staticmethod
    def general_history(chat_id: str) -> str:
        """Generate key for general chat history"""
        return f"general:chat_id:{chat_id}:history"

    @staticmethod
    def general_context(chat_id: str) -> str:
        """Generate key for general chat context cache"""
        return f"general:chat_id:{chat_id}:context"

    @staticmethod
    def general_documents(chat_id: str) -> str:
        """Generate key for general chat documents"""
        return f"general:chat_id:{chat_id}:documents"

    @staticmethod
    def project_chat(project_id: str, chat_id: str, suffix: str = "") -> str:
        """Generate key for project chat data"""
        base = f"project:project_id:{project_id}:chat_id:{chat_id}"
        return f"{base}:{suffix}" if suffix else base

    @staticmethod
    def project_history(project_id: str, chat_id: str) -> str:
        """Generate key for project chat history"""
        return f"project:project_id:{project_id}:chat_id:{chat_id}:history"

    @staticmethod
    def project_shared_history(project_id: str) -> str:
        """Generate key for shared project history (cross-chat)"""
        return f"project:project_id:{project_id}:shared_history"

    @staticmethod
    def project_context(project_id: str, chat_id: str) -> str:
        """Generate key for project chat context cache"""
        return f"project:project_id:{project_id}:chat_id:{chat_id}:context"

    @staticmethod
    def project_documents(project_id: str) -> str:
        """Generate key for project documents (shared across chats)"""
        return f"project:project_id:{project_id}:documents"

    @staticmethod
    def project_graph_cache(project_id: str) -> str:
        """Generate key for cached graph context"""
        return f"project:project_id:{project_id}:graph_cache"

    @staticmethod
    def user_preference(user_id: str, key: str) -> str:
        """Generate key for user preferences"""
        return f"user:user_id:{user_id}:pref:{key}"

    @staticmethod
    def temp_result(request_id: str) -> str:
        """Generate key for temporary computation results"""
        return f"temp:request:{request_id}"


# =============================================================================
# MEMORY MANAGER
# =============================================================================

class MemoryManager:
    """
    Unified Memory Manager.

    Routes all memory operations:
    1. Check Redis cache first (high-speed)
    2. Fallback to CocoIndex-triggered fetches from DBs
    3. Cache results in Redis

    Redis is accessed directly (not via CocoIndex).
    Postgres, Qdrant, Neo4j are accessed via CocoIndex dataflow.
    """

    def __init__(
        self,
        redis_service=None,
        cocoindex_dataflow=None,
    ):
        """
        Initialize memory manager.

        Args:
            redis_service: Redis service for direct cache access
            cocoindex_dataflow: CocoIndex dataflow manager for DB access
        """
        self.redis = redis_service
        self.cocoindex = cocoindex_dataflow

        # Statistics
        self.stats = {
            "cache_hits": 0,
            "cache_misses": 0,
            "reads": 0,
            "writes": 0,
            "errors": 0,
        }

        logger.info("MemoryManager initialized")

    def set_services(
        self,
        redis_service=None,
        cocoindex_dataflow=None,
    ):
        """Update service dependencies after initialization"""
        if redis_service:
            self.redis = redis_service
        if cocoindex_dataflow:
            self.cocoindex = cocoindex_dataflow

    # =========================================================================
    # CHAT HISTORY OPERATIONS
    # =========================================================================

    async def get_chat_history(
        self,
        chat_type: ChatType,
        chat_id: str,
        project_id: Optional[str] = None,
        limit: int = 50,
        include_cross_chat: bool = True,
    ) -> MemoryReadResult:
        """
        Get chat history with Redis-first caching.

        For GENERAL chats: Returns isolated chat history
        For PROJECT chats: Returns chat history + cross-chat project memory

        Args:
            chat_type: Type of chat session
            chat_id: Chat identifier
            project_id: Project ID (required for PROJECT chats)
            limit: Maximum messages to return
            include_cross_chat: Include cross-chat history for project chats

        Returns:
            MemoryReadResult with chat history
        """
        start_time = time.time()
        self.stats["reads"] += 1

        try:
            # Determine Redis key based on chat type
            if chat_type == ChatType.GENERAL:
                cache_key = RedisNamespace.general_history(chat_id)
            else:
                if not project_id:
                    return MemoryReadResult(
                        success=False,
                        error="project_id required for PROJECT chats"
                    )
                cache_key = RedisNamespace.project_history(project_id, chat_id)

            # Step 1: Try Redis cache first
            if self.redis:
                cached_data = self._get_from_redis_list(cache_key, limit)
                if cached_data:
                    self.stats["cache_hits"] += 1

                    # For project chats, also get cross-chat history
                    if chat_type == ChatType.PROJECT and include_cross_chat:
                        cross_chat = await self._get_project_cross_chat_history(
                            project_id, chat_id, limit=limit // 2
                        )
                        cached_data = self._merge_histories(cached_data, cross_chat)

                    latency = (time.time() - start_time) * 1000
                    return MemoryReadResult(
                        success=True,
                        data=cached_data,
                        source_tier=MemoryTier.REDIS,
                        cached=True,
                        latency_ms=latency,
                    )

            self.stats["cache_misses"] += 1

            # Step 2: Fallback to CocoIndex (Postgres)
            if self.cocoindex:
                db_data = await self.cocoindex.get_chat_history(
                    chat_id=chat_id,
                    project_id=project_id,
                    limit=limit,
                )

                # Cache the result in Redis
                if db_data and self.redis:
                    self._set_redis_list(
                        cache_key,
                        db_data,
                        ttl=RedisNamespace.TTL_HISTORY
                    )

                # For project chats, also get cross-chat history
                if chat_type == ChatType.PROJECT and include_cross_chat and db_data:
                    cross_chat = await self._get_project_cross_chat_history(
                        project_id, chat_id, limit=limit // 2
                    )
                    db_data = self._merge_histories(db_data, cross_chat)

                latency = (time.time() - start_time) * 1000
                return MemoryReadResult(
                    success=True,
                    data=db_data or [],
                    source_tier=MemoryTier.POSTGRES,
                    cached=False,
                    latency_ms=latency,
                )

            # No data sources available
            return MemoryReadResult(
                success=True,
                data=[],
                latency_ms=(time.time() - start_time) * 1000,
            )

        except Exception as e:
            self.stats["errors"] += 1
            logger.error(f"Error getting chat history: {e}")
            return MemoryReadResult(
                success=False,
                error=str(e),
                latency_ms=(time.time() - start_time) * 1000,
            )

    async def store_message(
        self,
        chat_type: ChatType,
        chat_id: str,
        user_id: str,
        role: str,
        content: str,
        project_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> MemoryWriteResult:
        """
        Store a message across all memory tiers.

        For GENERAL chats: Stores in isolated chat storage
        For PROJECT chats: Stores in chat storage + shared project memory

        Args:
            chat_type: Type of chat session
            chat_id: Chat identifier
            user_id: User identifier
            role: Message role (user/assistant)
            content: Message content
            project_id: Project ID (required for PROJECT chats)
            metadata: Additional message metadata

        Returns:
            MemoryWriteResult with operation status
        """
        start_time = time.time()
        self.stats["writes"] += 1

        message_id = f"{chat_id}_{int(time.time() * 1000)}"
        timestamp = datetime.utcnow().isoformat()

        message_data = {
            "message_id": message_id,
            "chat_id": chat_id,
            "user_id": user_id,
            "role": role,
            "content": content,
            "timestamp": timestamp,
            "sender": role,
            "text": content,
            **(metadata or {}),
        }

        tiers_written = []
        errors = {}

        # Determine Redis key based on chat type
        if chat_type == ChatType.GENERAL:
            cache_key = RedisNamespace.general_history(chat_id)
        else:
            if not project_id:
                return MemoryWriteResult(
                    success=False,
                    errors={MemoryTier.REDIS: "project_id required for PROJECT chats"},
                )
            cache_key = RedisNamespace.project_history(project_id, chat_id)
            message_data["project_id"] = project_id

        # Step 1: Write to Redis (primary cache)
        try:
            if self.redis:
                self._append_to_redis_list(
                    cache_key,
                    message_data,
                    max_items=100,
                    ttl=RedisNamespace.TTL_HISTORY
                )
                tiers_written.append(MemoryTier.REDIS)

                # For project chats, also add to shared project history
                if chat_type == ChatType.PROJECT:
                    shared_key = RedisNamespace.project_shared_history(project_id)
                    message_data["source_chat_id"] = chat_id
                    self._append_to_redis_list(
                        shared_key,
                        message_data,
                        max_items=200,
                        ttl=RedisNamespace.TTL_HISTORY
                    )
        except Exception as e:
            errors[MemoryTier.REDIS] = str(e)
            logger.error(f"Redis write error: {e}")

        # Step 2: Write to CocoIndex (Postgres - source of truth)
        try:
            if self.cocoindex:
                await self.cocoindex.store_message(
                    message_id=message_id,
                    chat_id=chat_id,
                    user_id=user_id,
                    role=role,
                    content=content,
                    project_id=project_id,
                    metadata=metadata,
                )
                tiers_written.append(MemoryTier.POSTGRES)
        except Exception as e:
            errors[MemoryTier.POSTGRES] = str(e)
            logger.warning(f"Postgres write error (non-fatal): {e}")

        latency = (time.time() - start_time) * 1000
        success = MemoryTier.REDIS in tiers_written  # Redis is required

        return MemoryWriteResult(
            success=success,
            tiers_written=tiers_written,
            errors=errors,
            latency_ms=latency,
        )

    # =========================================================================
    # DOCUMENT CONTEXT OPERATIONS
    # =========================================================================

    async def get_document_context(
        self,
        chat_type: ChatType,
        chat_id: str,
        project_id: Optional[str] = None,
        document_ids: Optional[List[str]] = None,
    ) -> MemoryReadResult:
        """
        Get document context with caching.

        For GENERAL chats: Returns documents uploaded to this chat
        For PROJECT chats: Returns all project documents (shared)

        Args:
            chat_type: Type of chat session
            chat_id: Chat identifier
            project_id: Project ID (for PROJECT chats)
            document_ids: Optional specific document IDs to fetch

        Returns:
            MemoryReadResult with document contexts
        """
        start_time = time.time()
        self.stats["reads"] += 1

        try:
            # Determine cache key
            if chat_type == ChatType.GENERAL:
                cache_key = RedisNamespace.general_documents(chat_id)
            else:
                if not project_id:
                    return MemoryReadResult(
                        success=False,
                        error="project_id required for PROJECT chats"
                    )
                cache_key = RedisNamespace.project_documents(project_id)

            # Try Redis first
            if self.redis:
                cached = self.redis.get(cache_key, db="cache")
                if cached:
                    self.stats["cache_hits"] += 1

                    # Filter by document_ids if specified
                    if document_ids:
                        cached = [d for d in cached if d.get("document_id") in document_ids]

                    return MemoryReadResult(
                        success=True,
                        data=cached,
                        source_tier=MemoryTier.REDIS,
                        cached=True,
                        latency_ms=(time.time() - start_time) * 1000,
                    )

            self.stats["cache_misses"] += 1

            # Fallback to CocoIndex (Qdrant + Postgres)
            if self.cocoindex:
                docs = await self.cocoindex.get_documents(
                    chat_id=chat_id,
                    project_id=project_id,
                    document_ids=document_ids,
                )

                # Cache result
                if docs and self.redis:
                    self.redis.set(
                        cache_key,
                        docs,
                        ttl=RedisNamespace.TTL_CACHE,
                        db="cache"
                    )

                return MemoryReadResult(
                    success=True,
                    data=docs or [],
                    source_tier=MemoryTier.QDRANT,
                    cached=False,
                    latency_ms=(time.time() - start_time) * 1000,
                )

            return MemoryReadResult(
                success=True,
                data=[],
                latency_ms=(time.time() - start_time) * 1000,
            )

        except Exception as e:
            self.stats["errors"] += 1
            logger.error(f"Error getting document context: {e}")
            return MemoryReadResult(
                success=False,
                error=str(e),
                latency_ms=(time.time() - start_time) * 1000,
            )

    async def cache_document_embedding(
        self,
        document_id: str,
        chat_type: ChatType,
        chat_id: str,
        project_id: Optional[str] = None,
        document_context: Dict[str, Any] = None,
    ) -> MemoryWriteResult:
        """
        Cache document embedding metadata.

        Args:
            document_id: Document identifier
            chat_type: Type of chat session
            chat_id: Chat identifier
            project_id: Project ID (for PROJECT chats)
            document_context: Document context to cache

        Returns:
            MemoryWriteResult
        """
        start_time = time.time()
        self.stats["writes"] += 1

        try:
            # Invalidate the documents cache so it gets refreshed
            if chat_type == ChatType.GENERAL:
                cache_key = RedisNamespace.general_documents(chat_id)
            else:
                cache_key = RedisNamespace.project_documents(project_id)

            if self.redis:
                # Get current cached documents
                cached = self.redis.get(cache_key, db="cache") or []

                # Add or update document
                cached = [d for d in cached if d.get("document_id") != document_id]
                if document_context:
                    cached.append(document_context)

                self.redis.set(
                    cache_key,
                    cached,
                    ttl=RedisNamespace.TTL_CACHE,
                    db="cache"
                )

            return MemoryWriteResult(
                success=True,
                tiers_written=[MemoryTier.REDIS],
                latency_ms=(time.time() - start_time) * 1000,
            )

        except Exception as e:
            self.stats["errors"] += 1
            logger.error(f"Error caching document: {e}")
            return MemoryWriteResult(
                success=False,
                errors={MemoryTier.REDIS: str(e)},
                latency_ms=(time.time() - start_time) * 1000,
            )

    # =========================================================================
    # GRAPH CONTEXT OPERATIONS (PROJECT CHATS)
    # =========================================================================

    async def get_graph_context(
        self,
        project_id: str,
        query: Optional[str] = None,
        entity_types: Optional[List[str]] = None,
    ) -> MemoryReadResult:
        """
        Get graph context from Neo4j with caching.

        Args:
            project_id: Project identifier
            query: Optional query to filter graph data
            entity_types: Optional entity types to include

        Returns:
            MemoryReadResult with graph context
        """
        start_time = time.time()
        self.stats["reads"] += 1

        try:
            cache_key = RedisNamespace.project_graph_cache(project_id)

            # Try Redis cache first
            if self.redis and not query:  # Only use cache for full graph
                cached = self.redis.get(cache_key, db="cache")
                if cached:
                    self.stats["cache_hits"] += 1
                    return MemoryReadResult(
                        success=True,
                        data=cached,
                        source_tier=MemoryTier.REDIS,
                        cached=True,
                        latency_ms=(time.time() - start_time) * 1000,
                    )

            self.stats["cache_misses"] += 1

            # Fallback to CocoIndex (Neo4j)
            if self.cocoindex:
                graph_data = await self.cocoindex.get_graph_context(
                    project_id=project_id,
                    query=query,
                    entity_types=entity_types,
                )

                # Cache if not query-specific
                if graph_data and self.redis and not query:
                    self.redis.set(
                        cache_key,
                        graph_data,
                        ttl=RedisNamespace.TTL_CACHE,
                        db="cache"
                    )

                return MemoryReadResult(
                    success=True,
                    data=graph_data,
                    source_tier=MemoryTier.NEO4J,
                    cached=False,
                    latency_ms=(time.time() - start_time) * 1000,
                )

            return MemoryReadResult(
                success=True,
                data=None,
                latency_ms=(time.time() - start_time) * 1000,
            )

        except Exception as e:
            self.stats["errors"] += 1
            logger.error(f"Error getting graph context: {e}")
            return MemoryReadResult(
                success=False,
                error=str(e),
                latency_ms=(time.time() - start_time) * 1000,
            )

    # =========================================================================
    # SEMANTIC SEARCH OPERATIONS
    # =========================================================================

    async def semantic_search(
        self,
        query: str,
        chat_type: ChatType,
        chat_id: str,
        project_id: Optional[str] = None,
        user_id: Optional[str] = None,
        limit: int = 5,
        score_threshold: float = 0.6,
    ) -> MemoryReadResult:
        """
        Perform semantic search in Qdrant.

        For GENERAL chats: Searches chat-specific documents
        For PROJECT chats: Searches all project documents

        Args:
            query: Search query
            chat_type: Type of chat session
            chat_id: Chat identifier
            project_id: Project ID (for PROJECT chats)
            user_id: User identifier
            limit: Maximum results
            score_threshold: Minimum similarity score

        Returns:
            MemoryReadResult with search results
        """
        start_time = time.time()
        self.stats["reads"] += 1

        try:
            if self.cocoindex:
                results = await self.cocoindex.semantic_search(
                    query=query,
                    chat_id=chat_id,
                    project_id=project_id,
                    user_id=user_id,
                    limit=limit,
                    score_threshold=score_threshold,
                )

                return MemoryReadResult(
                    success=True,
                    data=results or [],
                    source_tier=MemoryTier.QDRANT,
                    cached=False,
                    latency_ms=(time.time() - start_time) * 1000,
                )

            return MemoryReadResult(
                success=True,
                data=[],
                latency_ms=(time.time() - start_time) * 1000,
            )

        except Exception as e:
            self.stats["errors"] += 1
            logger.error(f"Error in semantic search: {e}")
            return MemoryReadResult(
                success=False,
                error=str(e),
                latency_ms=(time.time() - start_time) * 1000,
            )

    # =========================================================================
    # CONTEXT BUILDING (COMBINED)
    # =========================================================================

    async def build_llm_context(
        self,
        chat_type: ChatType,
        chat_id: str,
        user_id: str,
        current_query: str,
        project_id: Optional[str] = None,
        include_documents: bool = True,
        include_graph: bool = True,
        include_semantic: bool = True,
        history_limit: int = 20,
        semantic_limit: int = 5,
    ) -> Dict[str, Any]:
        """
        Build complete LLM context from all memory sources.

        Aggregates:
        - Chat history (from Redis/Postgres)
        - Document context (from Qdrant)
        - Graph context (from Neo4j) - for PROJECT chats
        - Semantic search results (from Qdrant)

        Args:
            chat_type: Type of chat session
            chat_id: Chat identifier
            user_id: User identifier
            current_query: Current user message
            project_id: Project ID (for PROJECT chats)
            include_documents: Whether to include document context
            include_graph: Whether to include graph context (PROJECT only)
            include_semantic: Whether to include semantic search results
            history_limit: Max history messages
            semantic_limit: Max semantic search results

        Returns:
            Dict with aggregated context
        """
        start_time = time.time()

        context = {
            "chat_type": chat_type.value,
            "chat_id": chat_id,
            "user_id": user_id,
            "current_query": current_query,
            "history": [],
            "documents": [],
            "graph_context": None,
            "semantic_results": [],
            "metadata": {
                "built_at": datetime.utcnow().isoformat(),
            },
        }

        # Get chat history
        history_result = await self.get_chat_history(
            chat_type=chat_type,
            chat_id=chat_id,
            project_id=project_id,
            limit=history_limit,
        )
        if history_result.success and history_result.data:
            context["history"] = history_result.data
            context["metadata"]["history_source"] = history_result.source_tier.value if history_result.source_tier else None

        # Get document context
        if include_documents:
            docs_result = await self.get_document_context(
                chat_type=chat_type,
                chat_id=chat_id,
                project_id=project_id,
            )
            if docs_result.success and docs_result.data:
                context["documents"] = docs_result.data

        # Get graph context (PROJECT chats only)
        if chat_type == ChatType.PROJECT and include_graph and project_id:
            graph_result = await self.get_graph_context(project_id=project_id)
            if graph_result.success and graph_result.data:
                context["graph_context"] = graph_result.data

        # Get semantic search results
        if include_semantic:
            semantic_result = await self.semantic_search(
                query=current_query,
                chat_type=chat_type,
                chat_id=chat_id,
                project_id=project_id,
                user_id=user_id,
                limit=semantic_limit,
            )
            if semantic_result.success and semantic_result.data:
                context["semantic_results"] = semantic_result.data

        context["metadata"]["build_time_ms"] = (time.time() - start_time) * 1000
        context["metadata"]["project_id"] = project_id

        return context

    # =========================================================================
    # CACHE INVALIDATION
    # =========================================================================

    async def invalidate_chat_cache(
        self,
        chat_type: ChatType,
        chat_id: str,
        project_id: Optional[str] = None,
    ):
        """Invalidate all cached data for a chat"""
        if not self.redis:
            return

        try:
            if chat_type == ChatType.GENERAL:
                patterns = [
                    RedisNamespace.general_history(chat_id),
                    RedisNamespace.general_context(chat_id),
                    RedisNamespace.general_documents(chat_id),
                ]
            else:
                patterns = [
                    RedisNamespace.project_history(project_id, chat_id),
                    RedisNamespace.project_context(project_id, chat_id),
                ]

            for key in patterns:
                self.redis.delete(key, db="cache")

            logger.info(f"Invalidated cache for chat {chat_id}")

        except Exception as e:
            logger.error(f"Error invalidating cache: {e}")

    async def invalidate_project_cache(self, project_id: str):
        """Invalidate all cached data for a project"""
        if not self.redis:
            return

        try:
            keys_to_delete = [
                RedisNamespace.project_documents(project_id),
                RedisNamespace.project_graph_cache(project_id),
                RedisNamespace.project_shared_history(project_id),
            ]

            for key in keys_to_delete:
                self.redis.delete(key, db="cache")

            logger.info(f"Invalidated cache for project {project_id}")

        except Exception as e:
            logger.error(f"Error invalidating project cache: {e}")

    # =========================================================================
    # HELPER METHODS
    # =========================================================================

    def _get_from_redis_list(self, key: str, limit: int) -> Optional[List[Dict]]:
        """Get list data from Redis"""
        if not self.redis:
            return None

        try:
            data = self.redis.get_chat_history(key.split(":")[-2], limit=limit)
            return data if data else None
        except Exception:
            # Try generic get for non-standard keys
            try:
                data = self.redis.get(key, db="chat")
                if isinstance(data, list):
                    return data[-limit:] if limit > 0 else data
                return None
            except Exception:
                return None

    def _set_redis_list(self, key: str, data: List[Dict], ttl: int):
        """Set list data in Redis"""
        if not self.redis:
            return

        try:
            self.redis.set(key, data, ttl=ttl, db="chat")
        except Exception as e:
            logger.warning(f"Redis set error: {e}")

    def _append_to_redis_list(
        self,
        key: str,
        item: Dict,
        max_items: int = 100,
        ttl: int = None
    ):
        """Append item to Redis list with size limit"""
        if not self.redis:
            return

        try:
            # Use the native chat message caching
            chat_id = key.split(":")[-2] if "chat_id" in key else key
            self.redis.cache_chat_message(chat_id, item, max_messages=max_items)
        except Exception as e:
            logger.warning(f"Redis append error: {e}")

    async def _get_project_cross_chat_history(
        self,
        project_id: str,
        current_chat_id: str,
        limit: int = 20,
    ) -> List[Dict]:
        """Get cross-chat history for project"""
        if not self.redis:
            return []

        try:
            key = RedisNamespace.project_shared_history(project_id)
            data = self.redis.get(key, db="chat")

            if not data:
                return []

            # Filter out current chat messages and limit
            cross_chat = [
                m for m in data
                if m.get("source_chat_id") != current_chat_id
            ]

            # Sort by timestamp and take most recent
            cross_chat.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
            return cross_chat[:limit]

        except Exception as e:
            logger.warning(f"Error getting cross-chat history: {e}")
            return []

    def _merge_histories(
        self,
        primary: List[Dict],
        secondary: List[Dict],
    ) -> List[Dict]:
        """Merge two history lists, removing duplicates"""
        seen_ids = set()
        merged = []

        for item in primary:
            msg_id = item.get("message_id")
            if msg_id not in seen_ids:
                seen_ids.add(msg_id)
                merged.append(item)

        for item in secondary:
            msg_id = item.get("message_id")
            if msg_id not in seen_ids:
                seen_ids.add(msg_id)
                merged.append(item)

        # Sort by timestamp
        merged.sort(key=lambda x: x.get("timestamp", ""))
        return merged

    def get_stats(self) -> Dict[str, Any]:
        """Get memory manager statistics"""
        total = self.stats["cache_hits"] + self.stats["cache_misses"]
        hit_rate = self.stats["cache_hits"] / total if total > 0 else 0

        return {
            **self.stats,
            "cache_hit_rate": hit_rate,
        }

    def reset_stats(self):
        """Reset statistics"""
        self.stats = {
            "cache_hits": 0,
            "cache_misses": 0,
            "reads": 0,
            "writes": 0,
            "errors": 0,
        }


# =============================================================================
# SINGLETON
# =============================================================================

_memory_manager: Optional[MemoryManager] = None


def get_memory_manager(
    redis_service=None,
    cocoindex_dataflow=None,
) -> MemoryManager:
    """Get or create memory manager singleton"""
    global _memory_manager

    if _memory_manager is None:
        _memory_manager = MemoryManager(
            redis_service=redis_service,
            cocoindex_dataflow=cocoindex_dataflow,
        )
    elif redis_service or cocoindex_dataflow:
        _memory_manager.set_services(
            redis_service=redis_service,
            cocoindex_dataflow=cocoindex_dataflow,
        )

    return _memory_manager
