"""
Chat Context Service
=====================
Separates general chat and project chat handling with appropriate storage layers.

Key Differences:
- General Chats: Qdrant only, isolated per chat, complete deletion on delete
- Project Chats: Qdrant + CoCoIndex/Neo4j, project-scoped, cross-chat context

Author: Simorgh Industrial Assistant
"""

import os
import logging
from typing import List, Dict, Any, Optional, AsyncIterator
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class ChatContext:
    """Represents context retrieved for a chat query"""
    vector_results: List[Dict[str, Any]]
    graph_context: Optional[Dict[str, Any]] = None
    combined_context: str = ""
    stats: Dict[str, Any] = None


class GeneralChatHandler:
    """
    Handles general (non-project) chats.

    Features:
    - Qdrant-only storage (NO Neo4j access)
    - Complete isolation per chat
    - Full deletion when chat is deleted
    """

    def __init__(
        self,
        qdrant_service,
        llm_service,
        redis_service=None
    ):
        """
        Initialize general chat handler.

        Args:
            qdrant_service: QdrantService instance
            llm_service: LLMService instance
            redis_service: Optional RedisService for caching
        """
        self.qdrant = qdrant_service
        self.llm = llm_service
        self.redis = redis_service

        # NO Neo4j or CoCoIndex access
        logger.info("GeneralChatHandler initialized (Qdrant only)")

    async def get_context(
        self,
        user_id: str,
        session_id: str,
        query: str,
        limit: int = 5
    ) -> ChatContext:
        """
        Get context for a general chat query.

        Uses only Qdrant vector search - no graph context.

        Args:
            user_id: User identifier
            session_id: Chat session ID
            query: User's query
            limit: Max results

        Returns:
            ChatContext with vector results only
        """
        try:
            # Search Qdrant for relevant sections
            vector_results = self.qdrant.search_section_summaries(
                project_number=None,  # No project scope
                query=query,
                limit=limit,
                session_id=session_id,
                user_id=user_id
            )

            # Format context for LLM
            context_parts = []
            for i, result in enumerate(vector_results, 1):
                section_title = result.get("section_title", "Section")
                full_content = result.get("full_content", result.get("text", ""))
                score = result.get("score", 0)

                context_parts.append(f"### Section {i} (Relevance: {score:.2f})")
                context_parts.append(f"**{section_title}**")
                context_parts.append(full_content[:2000])  # Limit per section
                context_parts.append("")

            combined_context = "\n".join(context_parts)

            return ChatContext(
                vector_results=vector_results,
                graph_context=None,  # No graph for general chats
                combined_context=combined_context,
                stats={
                    "vector_results": len(vector_results),
                    "graph_results": 0,
                    "chat_type": "general"
                }
            )

        except Exception as e:
            logger.error(f"Failed to get general chat context: {e}")
            return ChatContext(
                vector_results=[],
                graph_context=None,
                combined_context="",
                stats={"error": str(e)}
            )

    async def process_message(
        self,
        user_id: str,
        session_id: str,
        message: str,
        history: List[Dict[str, str]] = None,
        stream: bool = False
    ) -> Any:
        """
        Process a message in general chat.

        Args:
            user_id: User identifier
            session_id: Chat session ID
            message: User's message
            history: Conversation history
            stream: Whether to stream response

        Returns:
            LLM response (streaming or complete)
        """
        # Get context
        context = await self.get_context(user_id, session_id, message)

        # Build messages
        messages = [
            {
                "role": "system",
                "content": """You are a helpful assistant for general document Q&A.

Answer based on the provided context. If the context doesn't contain
enough information, say so clearly.

Be concise and accurate."""
            }
        ]

        # Add history
        if history:
            for h in history[-5:]:  # Last 5 turns
                messages.append({"role": h.get("role", "user"), "content": h.get("content", "")})

        # Add current message with context
        user_content = f"""Context:
{context.combined_context}

Question: {message}

Please answer based on the context provided."""

        messages.append({"role": "user", "content": user_content})

        # Generate response
        if stream:
            return self.llm.generate_stream(messages=messages)
        else:
            result = self.llm.generate(messages=messages)
            return result.get("response", "")

    def delete_chat(
        self,
        user_id: str,
        session_id: str
    ) -> Dict[str, Any]:
        """
        Completely delete a general chat.

        Removes all data from Qdrant - full cascade deletion.

        Args:
            user_id: User identifier
            session_id: Session ID

        Returns:
            Deletion result
        """
        try:
            # Delete Qdrant collection
            success = self.qdrant.delete_session_collection(
                user_id=user_id,
                session_id=session_id,
                project_oenum=None  # General chat
            )

            # Clear Redis cache if available
            if self.redis:
                patterns = [
                    f"session:{session_id}:*",
                    f"chat:{session_id}:*",
                ]
                for pattern in patterns:
                    keys = self.redis.client.keys(pattern)
                    for key in keys:
                        self.redis.client.delete(key)

            logger.info(f"General chat deleted: {session_id}")
            return {
                "success": success,
                "session_id": session_id,
                "chat_type": "general"
            }

        except Exception as e:
            logger.error(f"Failed to delete general chat: {e}")
            return {
                "success": False,
                "error": str(e)
            }


class ProjectChatHandler:
    """
    Handles project chats with full graph capabilities.

    Features:
    - Qdrant for vector search
    - CoCoIndex/Neo4j for graph context
    - Project-scoped isolation
    - Cross-chat context within project
    """

    def __init__(
        self,
        qdrant_service,
        cocoindex_adapter,
        llm_service,
        redis_service=None
    ):
        """
        Initialize project chat handler.

        Args:
            qdrant_service: QdrantService instance
            cocoindex_adapter: CoCoIndex Neo4j adapter
            llm_service: LLMService instance
            redis_service: Optional RedisService for caching
        """
        self.qdrant = qdrant_service
        self.cocoindex = cocoindex_adapter  # Neo4j access ONLY via CoCoIndex
        self.llm = llm_service
        self.redis = redis_service

        logger.info("ProjectChatHandler initialized (Qdrant + CoCoIndex)")

    async def get_context(
        self,
        user_id: str,
        project_number: str,
        query: str,
        session_id: str = None,
        limit: int = 5
    ) -> ChatContext:
        """
        Get context for a project chat query.

        Combines Qdrant vector search with CoCoIndex graph context.

        Args:
            user_id: User identifier
            project_number: Project OENUM
            query: User's query
            session_id: Optional chat session ID
            limit: Max vector results

        Returns:
            ChatContext with both vector and graph results
        """
        try:
            # 1. Vector search in Qdrant (project-scoped)
            vector_results = self.qdrant.search_section_summaries(
                project_number=project_number,
                query=query,
                limit=limit,
                user_id=user_id
            )

            # 2. Graph context via CoCoIndex
            graph_context = await self._get_graph_context(project_number, query)

            # 3. Combine contexts
            combined_context = self._format_combined_context(
                vector_results,
                graph_context,
                project_number
            )

            return ChatContext(
                vector_results=vector_results,
                graph_context=graph_context,
                combined_context=combined_context,
                stats={
                    "vector_results": len(vector_results),
                    "graph_entities": len(graph_context.get("entities", [])) if graph_context else 0,
                    "chat_type": "project",
                    "project_number": project_number
                }
            )

        except Exception as e:
            logger.error(f"Failed to get project chat context: {e}")
            return ChatContext(
                vector_results=[],
                graph_context=None,
                combined_context="",
                stats={"error": str(e)}
            )

    async def _get_graph_context(
        self,
        project_number: str,
        query: str
    ) -> Optional[Dict[str, Any]]:
        """
        Get graph context from CoCoIndex.

        Args:
            project_number: Project context
            query: User's query

        Returns:
            Graph context dict
        """
        try:
            # Extract entity keywords from query
            entities = self._extract_query_entities(query)

            graph_data = {
                "entities": [],
                "relationships": [],
                "specs": {}
            }

            # Search for relevant entities
            for entity_type in ["SpecificationDocument", "SpecCategory", "Equipment"]:
                try:
                    found = self.cocoindex.get_entities_by_type(
                        project_number=project_number,
                        entity_type=entity_type,
                        limit=10
                    )
                    graph_data["entities"].extend(found)
                except Exception:
                    continue

            # If query mentions specs, get spec data
            spec_keywords = ["specification", "spec", "value", "rated", "voltage", "current"]
            if any(kw in query.lower() for kw in spec_keywords):
                # Find spec documents
                spec_docs = self.cocoindex.get_entities_by_type(
                    project_number=project_number,
                    entity_type="SpecificationDocument",
                    limit=5
                )

                for doc in spec_docs:
                    doc_id = doc.get("entity_id")
                    if doc_id:
                        specs = self.cocoindex.get_full_specification(
                            project_number=project_number,
                            document_id=doc_id
                        )
                        if specs:
                            graph_data["specs"][doc_id] = specs

            return graph_data

        except Exception as e:
            logger.warning(f"Graph context retrieval failed: {e}")
            return None

    def _extract_query_entities(self, query: str) -> List[str]:
        """Extract potential entity references from query"""
        # Simple keyword extraction
        import re
        # Match alphanumeric IDs like MDB-01, TR-01, etc.
        ids = re.findall(r'[A-Z]{2,}[-_]?\d+', query.upper())
        return ids

    def _format_combined_context(
        self,
        vector_results: List[Dict[str, Any]],
        graph_context: Optional[Dict[str, Any]],
        project_number: str
    ) -> str:
        """
        Format combined vector + graph context for LLM.

        Args:
            vector_results: Qdrant search results
            graph_context: Graph data from CoCoIndex
            project_number: Project number

        Returns:
            Formatted context string
        """
        parts = []

        # Project header
        parts.append(f"# Project: {project_number}")
        parts.append("")

        # Graph context (prioritized)
        if graph_context:
            # Specification data
            if graph_context.get("specs"):
                parts.append("## Extracted Specifications")
                for doc_id, specs in graph_context["specs"].items():
                    parts.append(f"\n### Document: {doc_id}")
                    for category, fields in specs.items():
                        parts.append(f"\n**{category}:**")
                        for field_name, field_data in fields.items():
                            value = field_data.get("value") if isinstance(field_data, dict) else field_data
                            if value:
                                parts.append(f"- {field_name}: {value}")
                parts.append("")

            # Entities
            if graph_context.get("entities"):
                parts.append("## Knowledge Graph Entities")
                for entity in graph_context["entities"][:10]:
                    entity_id = entity.get("entity_id", "Unknown")
                    labels = entity.get("labels", [])
                    parts.append(f"- {entity_id} ({', '.join(labels)})")
                parts.append("")

        # Vector search results
        if vector_results:
            parts.append("## Relevant Document Sections")
            for i, result in enumerate(vector_results[:5], 1):
                section_title = result.get("section_title", "Section")
                full_content = result.get("full_content", result.get("text", ""))
                score = result.get("score", 0)

                parts.append(f"\n### Section {i}: {section_title} (Score: {score:.2f})")
                parts.append(full_content[:1500])

        return "\n".join(parts)

    async def process_message(
        self,
        user_id: str,
        project_number: str,
        message: str,
        session_id: str = None,
        history: List[Dict[str, str]] = None,
        stream: bool = False
    ) -> Any:
        """
        Process a message in project chat.

        Args:
            user_id: User identifier
            project_number: Project OENUM
            message: User's message
            session_id: Chat session ID
            history: Conversation history
            stream: Whether to stream response

        Returns:
            LLM response (streaming or complete)
        """
        # Get combined context
        context = await self.get_context(
            user_id=user_id,
            project_number=project_number,
            query=message,
            session_id=session_id
        )

        # Build messages
        messages = [
            {
                "role": "system",
                "content": f"""You are an expert assistant for electrical engineering projects.

You have access to:
1. Project documents and specifications
2. Knowledge graph with entities and relationships
3. Extracted specification values

Answer questions accurately based on the provided context.
When referencing specifications, cite the specific values from the graph data.
If information is not available in the context, say so clearly.

Current Project: {project_number}"""
            }
        ]

        # Add history
        if history:
            for h in history[-5:]:
                messages.append({"role": h.get("role", "user"), "content": h.get("content", "")})

        # Add current message with context
        user_content = f"""Context:
{context.combined_context}

---

Question: {message}

Please answer based on the project context provided. Reference specific values when available."""

        messages.append({"role": "user", "content": user_content})

        # Generate response
        if stream:
            return self.llm.generate_stream(messages=messages)
        else:
            result = self.llm.generate(messages=messages)
            return result.get("response", "")

    def get_cross_chat_context(
        self,
        user_id: str,
        project_number: str,
        limit: int = 10
    ) -> Dict[str, Any]:
        """
        Get context that spans all chats within a project.

        Args:
            user_id: User identifier
            project_number: Project OENUM
            limit: Max items per category

        Returns:
            Cross-chat context data
        """
        try:
            context = {
                "project_number": project_number,
                "documents": [],
                "specifications": {},
                "entities": []
            }

            # Get all spec documents
            spec_docs = self.cocoindex.get_entities_by_type(
                project_number=project_number,
                entity_type="SpecificationDocument",
                limit=limit
            )
            context["documents"] = spec_docs

            # Get full specs for each document
            for doc in spec_docs:
                doc_id = doc.get("entity_id")
                if doc_id:
                    specs = self.cocoindex.get_full_specification(
                        project_number=project_number,
                        document_id=doc_id
                    )
                    if specs:
                        context["specifications"][doc_id] = specs

            # Get other entity types
            for entity_type in ["Equipment", "SpecCategory"]:
                entities = self.cocoindex.get_entities_by_type(
                    project_number=project_number,
                    entity_type=entity_type,
                    limit=limit
                )
                context["entities"].extend(entities)

            return context

        except Exception as e:
            logger.error(f"Failed to get cross-chat context: {e}")
            return {"error": str(e)}


class ChatContextService:
    """
    Unified chat context service that routes to appropriate handler.

    Factory for GeneralChatHandler and ProjectChatHandler.
    """

    def __init__(
        self,
        qdrant_service,
        cocoindex_adapter,
        llm_service,
        redis_service=None
    ):
        """
        Initialize chat context service.

        Args:
            qdrant_service: QdrantService instance
            cocoindex_adapter: CoCoIndex adapter (for project chats)
            llm_service: LLMService instance
            redis_service: Optional RedisService
        """
        self.general_handler = GeneralChatHandler(
            qdrant_service=qdrant_service,
            llm_service=llm_service,
            redis_service=redis_service
        )

        self.project_handler = ProjectChatHandler(
            qdrant_service=qdrant_service,
            cocoindex_adapter=cocoindex_adapter,
            llm_service=llm_service,
            redis_service=redis_service
        )

        logger.info("ChatContextService initialized")

    def get_handler(self, project_number: str = None):
        """
        Get appropriate handler based on chat type.

        Args:
            project_number: Project number (None for general chat)

        Returns:
            GeneralChatHandler or ProjectChatHandler
        """
        if project_number:
            return self.project_handler
        else:
            return self.general_handler

    async def get_context(
        self,
        user_id: str,
        query: str,
        session_id: str = None,
        project_number: str = None,
        limit: int = 5
    ) -> ChatContext:
        """
        Get context for any chat type.

        Routes to appropriate handler based on project_number.
        """
        if project_number:
            return await self.project_handler.get_context(
                user_id=user_id,
                project_number=project_number,
                query=query,
                session_id=session_id,
                limit=limit
            )
        else:
            return await self.general_handler.get_context(
                user_id=user_id,
                session_id=session_id,
                query=query,
                limit=limit
            )

    async def process_message(
        self,
        user_id: str,
        message: str,
        session_id: str = None,
        project_number: str = None,
        history: List[Dict[str, str]] = None,
        stream: bool = False
    ) -> Any:
        """
        Process a message in any chat type.

        Routes to appropriate handler based on project_number.
        """
        if project_number:
            return await self.project_handler.process_message(
                user_id=user_id,
                project_number=project_number,
                message=message,
                session_id=session_id,
                history=history,
                stream=stream
            )
        else:
            return await self.general_handler.process_message(
                user_id=user_id,
                session_id=session_id,
                message=message,
                history=history,
                stream=stream
            )


# =============================================================================
# SINGLETON INSTANCE
# =============================================================================

_chat_context_service: Optional[ChatContextService] = None


def get_chat_context_service(
    qdrant_service=None,
    cocoindex_adapter=None,
    llm_service=None,
    redis_service=None
) -> ChatContextService:
    """Get or create chat context service singleton"""
    global _chat_context_service

    if _chat_context_service is None:
        if not all([qdrant_service, cocoindex_adapter, llm_service]):
            raise ValueError("Services required for first initialization")

        _chat_context_service = ChatContextService(
            qdrant_service=qdrant_service,
            cocoindex_adapter=cocoindex_adapter,
            llm_service=llm_service,
            redis_service=redis_service
        )

    return _chat_context_service
