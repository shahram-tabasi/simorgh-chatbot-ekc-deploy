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
            # IMPORTANT: Documents are stored with user_id="system" so we must search the same way
            vector_results = self.qdrant.search_section_summaries(
                user_id="system",  # Must match how documents are stored in section_retriever
                query=query,
                limit=limit,
                project_oenum=None,  # No project scope for general chat
                session_id=session_id
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

        Combines Qdrant vector search with CoCoIndex graph context and PostgreSQL project data.

        Args:
            user_id: User identifier
            project_number: Project OENUM
            query: User's query
            session_id: Optional chat session ID
            limit: Max vector results

        Returns:
            ChatContext with vector, graph, and project database results
        """
        try:
            # 1. Vector search in Qdrant (project-scoped)
            # IMPORTANT: Documents are stored with user_id="system" so we must search the same way
            vector_results = self.qdrant.search_section_summaries(
                user_id="system",  # Must match how documents are stored in section_retriever
                query=query,
                limit=limit,
                project_oenum=project_number  # Correct parameter name
            )

            # 2. Graph context via CoCoIndex
            graph_context = await self._get_graph_context(project_number, query)

            # 3. Project TPMS context from Neo4j (synced data)
            project_tpms_context = self._get_neo4j_project_context(project_number)

            # 4. Combine all contexts
            combined_context = self._format_combined_context(
                vector_results,
                graph_context,
                project_number,
                project_tpms_context
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

    def _get_neo4j_project_context(self, project_number: str) -> Optional[Dict[str, Any]]:
        """
        Get project TPMS data from Neo4j (synced project data).

        Uses Redis cache first for fast responses, falls back to Neo4j.
        Cache is populated on cache miss and invalidated when TPMS syncs.

        Args:
            project_number: Project OENUM

        Returns:
            Dict with project info, panels, and counts
        """
        try:
            # 1. Check Redis cache first (fast path)
            if self.redis:
                cached_context = self.redis.get_cached_project_tpms_context(project_number)
                if cached_context:
                    logger.debug(f"📦 Using cached project context for {project_number}")
                    return cached_context

            # 2. Cache miss - fetch from Neo4j
            if not self.cocoindex:
                logger.debug("CoCoIndex adapter not available for Neo4j context")
                return None

            # Fetch from Neo4j (slow path)
            context = self.cocoindex.get_project_tpms_context(project_number)

            if context:
                logger.debug(f"Retrieved Neo4j project context: {context.get('panel_count', 0)} panels, {context.get('feeder_count', 0)} feeders")

                # 3. Cache the result for future requests (30 min TTL)
                if self.redis:
                    self.redis.cache_project_tpms_context(project_number, context, ttl=1800)

                    # Also cache panels separately for quick panel lookups
                    if context.get("panels"):
                        self.redis.cache_project_panels(
                            project_number,
                            context["panels"],
                            ttl=1800
                        )

            return context

        except Exception as e:
            logger.warning(f"Failed to get project database context: {e}")
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
        project_number: str,
        project_db_context: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        Format combined vector + graph + project database context for LLM.

        Args:
            vector_results: Qdrant search results
            graph_context: Graph data from CoCoIndex
            project_number: Project number
            project_db_context: Project data from PostgreSQL

        Returns:
            Formatted context string
        """
        parts = []

        # Project header
        parts.append(f"# Project: {project_number}")
        parts.append("")

        # Project TPMS context from Neo4j (synced data - HIGHEST PRIORITY)
        if project_db_context:
            # Project info (from Neo4j Project node)
            if project_db_context.get("project_info"):
                info = project_db_context["project_info"]
                parts.append("## Project Information (from TPMS)")
                parts.append(f"- **Project Name**: {info.get('project_name') or info.get('name', 'N/A')}")
                if info.get('project_name_fa') or info.get('name_fa'):
                    parts.append(f"- **Project Name (Persian)**: {info.get('project_name_fa') or info.get('name_fa')}")
                parts.append(f"- **Category**: {info.get('order_category') or info.get('category', 'N/A')}")
                parts.append(f"- **Date**: {info.get('oe_date') or info.get('date', 'N/A')}")
                parts.append(f"- **Project Expert**: {info.get('project_expert', 'N/A')}")
                parts.append(f"- **Technical Supervisor**: {info.get('technical_supervisor', 'N/A')}")
                parts.append(f"- **Technical Expert**: {info.get('technical_expert', 'N/A')}")
                parts.append("")

            # Project identity (additional specs)
            if project_db_context.get("project_identity"):
                identity = project_db_context["project_identity"]
                if any(identity.values()):
                    parts.append("## Project Technical Specifications")
                    if identity.get('delivery_date'):
                        parts.append(f"- **Delivery Date**: {identity.get('delivery_date')}")
                    if identity.get('above_sea_level'):
                        parts.append(f"- **Altitude**: {identity.get('above_sea_level')}")
                    if identity.get('average_temperature'):
                        parts.append(f"- **Average Temperature**: {identity.get('average_temperature')}")
                    if identity.get('wire_brand'):
                        parts.append(f"- **Wire Brand**: {identity.get('wire_brand')}")
                    if identity.get('isolation_value'):
                        parts.append(f"- **Isolation**: {identity.get('isolation_value')}")
                    parts.append("")

            # Summary counts
            parts.append("## Project Summary")
            parts.append(f"- **Total Panels**: {project_db_context.get('panel_count', 0)}")
            parts.append(f"- **Total Feeders/Loads**: {project_db_context.get('feeder_count', 0)}")
            parts.append(f"- **Total Equipment Items**: {project_db_context.get('equipment_count', 0)}")
            parts.append("")

            # Panels list (from Neo4j Panel nodes)
            if project_db_context.get("panels"):
                parts.append("## Panels/Switchgears")
                for panel in project_db_context["panels"]:
                    panel_name = panel.get('plane_name') or panel.get('name') or f"Panel {panel.get('panel_id')}"
                    panel_type = panel.get('plane_type') or panel.get('type') or 'N/A'
                    voltage = panel.get('voltage_rate') or panel.get('rated_voltage') or 'N/A'
                    amperage = panel.get('switch_amperage') or panel.get('amperage') or 'N/A'
                    ip = panel.get('ip_value') or panel.get('ip') or 'N/A'
                    cell_count = panel.get('cell_count') or 'N/A'

                    # feeder_count is included in each panel from Neo4j query
                    feeder_count = panel.get('feeder_count', 0)

                    parts.append(f"### {panel_name}")
                    parts.append(f"- Type: {panel_type}")
                    parts.append(f"- Voltage: {voltage}")
                    parts.append(f"- Amperage: {amperage}")
                    parts.append(f"- IP Rating: {ip}")
                    parts.append(f"- Cell Count: {cell_count}")
                    parts.append(f"- Number of Feeders: {feeder_count}")
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
