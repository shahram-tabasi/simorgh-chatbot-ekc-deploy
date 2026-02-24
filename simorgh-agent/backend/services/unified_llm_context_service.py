"""
Unified LLM Context Service
============================
Single source of truth for building LLM context from all available sources.

This service consolidates context gathering from:
1. User Profile (Redis) - personalization
2. Project TPMS Data (Neo4j) - panels, feeders, equipment
3. Document Specifications (Neo4j) - extracted spec values
4. Document Sections (Qdrant) - semantic search results
5. User Memory (Qdrant) - past relevant conversations
6. Chat History (Redis) - recent conversation context
7. Document Overview (Redis) - list of uploaded documents

Author: Simorgh Industrial Assistant
"""

import logging
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

logger = logging.getLogger(__name__)


class ContextSource(Enum):
    """Available context sources"""
    USER_PROFILE = "user_profile"
    TPMS_PROJECT = "tpms_project"
    GRAPH_SPECS = "graph_specs"
    GRAPH_SUBGRAPH = "graph_subgraph"
    VECTOR_SECTIONS = "vector_sections"
    USER_MEMORY = "user_memory"
    CHAT_HISTORY = "chat_history"
    DOCUMENT_OVERVIEW = "document_overview"


@dataclass
class ContextConfig:
    """Configuration for context building"""
    # Token limits (approximate)
    max_total_tokens: int = 8000

    # Per-source limits
    user_profile_tokens: int = 200
    tpms_project_tokens: int = 2000
    graph_specs_tokens: int = 1500
    graph_subgraph_tokens: int = 1000
    vector_sections_tokens: int = 2000
    user_memory_tokens: int = 800
    chat_history_tokens: int = 1500
    document_overview_tokens: int = 500

    # Feature toggles
    include_user_profile: bool = True
    include_tpms_data: bool = True
    include_graph_specs: bool = True
    include_graph_subgraph: bool = True
    include_vector_search: bool = True
    include_user_memory: bool = True
    include_chat_history: bool = True
    include_document_overview: bool = True

    # Search parameters
    vector_search_limit: int = 5
    vector_score_threshold: float = 0.3
    memory_search_limit: int = 5
    memory_score_threshold: float = 0.65
    chat_history_limit: int = 10
    max_panels_to_show: int = 15
    max_sections_to_show: int = 3
    bfs_max_depth: int = 2


@dataclass
class ContextResult:
    """Result of context building"""
    # Formatted context string for LLM
    context_text: str = ""

    # Metadata about what was included
    sources_used: List[str] = field(default_factory=list)

    # Individual source data (for debugging/logging)
    user_profile: Optional[Dict[str, Any]] = None
    tpms_data: Optional[Dict[str, Any]] = None
    graph_specs: Optional[Dict[str, Any]] = None
    graph_subgraph: Optional[Dict[str, Any]] = None
    vector_results: Optional[List[Dict[str, Any]]] = None
    user_memory: Optional[List[Dict[str, Any]]] = None
    chat_history: Optional[List[Dict[str, Any]]] = None
    document_overview: Optional[Dict[str, Any]] = None

    # Stats
    total_tokens_estimated: int = 0
    build_time_ms: float = 0


class UnifiedLLMContextService:
    """
    Unified service for building LLM context from all sources.

    Usage:
        context_service = UnifiedLLMContextService(
            redis=redis_service,
            neo4j=neo4j_service,
            qdrant=qdrant_service
        )

        result = await context_service.build_context(
            user_id="user123",
            query="What panels are in this project?",
            chat_id="chat456",
            project_number="04A12065"
        )

        # Use result.context_text in LLM prompt
    """

    def __init__(
        self,
        redis_service=None,
        neo4j_driver=None,
        qdrant_service=None,
        config: Optional[ContextConfig] = None
    ):
        """
        Initialize with required services.

        Args:
            redis_service: RedisService instance
            neo4j_driver: Neo4j driver instance
            qdrant_service: QdrantService instance
            config: Optional context configuration
        """
        self.redis = redis_service
        self.neo4j_driver = neo4j_driver
        self.qdrant = qdrant_service
        self.config = config or ContextConfig()

        # Lazy-loaded adapters
        self._cocoindex = None
        self._graph_rag = None

        logger.info("UnifiedLLMContextService initialized")

    @property
    def cocoindex(self):
        """Lazy-load CoCoIndex adapter"""
        if self._cocoindex is None and self.neo4j_driver:
            try:
                from cocoindex_flows.cocoindex_adapter import CoCoIndexAdapter
                self._cocoindex = CoCoIndexAdapter(driver=self.neo4j_driver)
            except Exception as e:
                logger.warning(f"Failed to initialize CoCoIndex adapter: {e}")
        return self._cocoindex

    @property
    def graph_rag(self):
        """Lazy-load GraphRAG service"""
        if self._graph_rag is None and self.neo4j_driver:
            try:
                from services.graph_rag_service import GraphRAGService
                self._graph_rag = GraphRAGService(self.neo4j_driver)
            except Exception as e:
                logger.warning(f"Failed to initialize GraphRAG service: {e}")
        return self._graph_rag

    async def build_context(
        self,
        user_id: str,
        query: str,
        chat_id: str,
        project_number: Optional[str] = None,
        chat_type: str = "general",
        config_override: Optional[ContextConfig] = None
    ) -> ContextResult:
        """
        Build complete LLM context from all sources.

        Args:
            user_id: Current user ID
            query: User's current query
            chat_id: Current chat session ID
            project_number: Project OENUM (None for general chats)
            chat_type: "general" or "project"
            config_override: Optional config to override defaults

        Returns:
            ContextResult with formatted context and metadata
        """
        import time
        start_time = time.time()

        config = config_override or self.config
        result = ContextResult()
        context_parts = []

        is_project_chat = project_number is not None and chat_type == "project"

        # =====================================================================
        # 1. USER PROFILE (Always first - personalization)
        # =====================================================================
        if config.include_user_profile:
            try:
                user_context = self._build_user_profile_context(user_id)
                if user_context:
                    context_parts.append(user_context)
                    result.sources_used.append(ContextSource.USER_PROFILE.value)
                    logger.debug(f"Added user profile context for {user_id}")
            except Exception as e:
                logger.warning(f"Failed to build user profile context: {e}")

        # =====================================================================
        # 2. PROJECT TPMS DATA (Highest priority for project chats)
        # =====================================================================
        if is_project_chat and config.include_tpms_data:
            try:
                tpms_context, tpms_data = self._build_tpms_context(
                    project_number,
                    config.max_panels_to_show
                )
                if tpms_context:
                    context_parts.append(tpms_context)
                    result.tpms_data = tpms_data
                    result.sources_used.append(ContextSource.TPMS_PROJECT.value)
                    logger.info(f"Added TPMS context: {tpms_data.get('panel_count', 0)} panels")
            except Exception as e:
                logger.warning(f"Failed to build TPMS context: {e}")

        # =====================================================================
        # 3. GRAPH SPECIFICATIONS (From parsed documents)
        # =====================================================================
        if is_project_chat and config.include_graph_specs and self.graph_rag:
            try:
                specs_context, specs_data = self._build_graph_specs_context(
                    project_number,
                    query
                )
                if specs_context:
                    context_parts.append(specs_context)
                    result.graph_specs = specs_data
                    result.sources_used.append(ContextSource.GRAPH_SPECS.value)
                    logger.info(f"Added graph specs: {specs_data.get('count', 0)} specifications")
            except Exception as e:
                logger.warning(f"Failed to build graph specs context: {e}")

        # =====================================================================
        # 4. GRAPH SUBGRAPH (BFS traversal for related entities)
        # =====================================================================
        if is_project_chat and config.include_graph_subgraph and self.graph_rag:
            try:
                subgraph_context, subgraph_data = self._build_subgraph_context(
                    project_number,
                    query,
                    config.bfs_max_depth
                )
                if subgraph_context:
                    context_parts.append(subgraph_context)
                    result.graph_subgraph = subgraph_data
                    result.sources_used.append(ContextSource.GRAPH_SUBGRAPH.value)
                    logger.info(f"Added subgraph: {subgraph_data.get('node_count', 0)} nodes")
            except Exception as e:
                logger.warning(f"Failed to build subgraph context: {e}")

        # =====================================================================
        # 5. VECTOR SECTIONS (Semantic search in documents)
        # =====================================================================
        if config.include_vector_search and self.qdrant:
            try:
                vector_context, vector_data = self._build_vector_context(
                    query,
                    project_number,
                    config.vector_search_limit,
                    config.vector_score_threshold,
                    config.max_sections_to_show,
                    chat_id=chat_id,
                    chat_type=chat_type
                )
                if vector_context:
                    context_parts.append(vector_context)
                    result.vector_results = vector_data
                    result.sources_used.append(ContextSource.VECTOR_SECTIONS.value)
                    logger.info(f"Added vector results: {len(vector_data)} sections")
            except Exception as e:
                logger.warning(f"Failed to build vector context: {e}")

        # =====================================================================
        # 6. USER MEMORY (Past relevant conversations)
        # =====================================================================
        if config.include_user_memory and self.qdrant:
            try:
                memory_context, memory_data = self._build_user_memory_context(
                    user_id,
                    query,
                    chat_id,
                    project_number,
                    config.memory_search_limit,
                    config.memory_score_threshold
                )
                if memory_context:
                    context_parts.append(memory_context)
                    result.user_memory = memory_data
                    result.sources_used.append(ContextSource.USER_MEMORY.value)
                    logger.debug(f"Added user memory: {len(memory_data)} conversations")
            except Exception as e:
                logger.warning(f"Failed to build user memory context: {e}")

        # =====================================================================
        # 7. CHAT HISTORY (Recent conversation context)
        # =====================================================================
        if config.include_chat_history and self.redis:
            try:
                history_context, history_data = self._build_chat_history_context(
                    user_id,
                    chat_id,
                    project_number,
                    chat_type,
                    config.chat_history_limit
                )
                if history_context:
                    context_parts.append(history_context)
                    result.chat_history = history_data
                    result.sources_used.append(ContextSource.CHAT_HISTORY.value)
                    logger.debug(f"Added chat history: {len(history_data)} messages")
            except Exception as e:
                logger.warning(f"Failed to build chat history context: {e}")

        # =====================================================================
        # 8. DOCUMENT OVERVIEW (List of uploaded documents)
        # =====================================================================
        if is_project_chat and config.include_document_overview:
            try:
                overview_context, overview_data = self._build_document_overview_context(
                    project_number
                )
                if overview_context:
                    context_parts.append(overview_context)
                    result.document_overview = overview_data
                    result.sources_used.append(ContextSource.DOCUMENT_OVERVIEW.value)
                    logger.debug(f"Added document overview: {overview_data.get('count', 0)} docs")
            except Exception as e:
                logger.warning(f"Failed to build document overview context: {e}")

        # =====================================================================
        # COMBINE ALL CONTEXT
        # =====================================================================
        if context_parts:
            result.context_text = "\n\n---\n\n".join(context_parts)
            # Rough token estimation (1 token ≈ 4 chars)
            result.total_tokens_estimated = len(result.context_text) // 4

        result.build_time_ms = (time.time() - start_time) * 1000

        logger.info(
            f"Context built: {len(result.sources_used)} sources, "
            f"~{result.total_tokens_estimated} tokens, "
            f"{result.build_time_ms:.1f}ms"
        )

        return result

    # =========================================================================
    # CONTEXT BUILDERS (Private Methods)
    # =========================================================================

    def _build_user_profile_context(self, user_id: str) -> Optional[str]:
        """Build user profile context from Redis"""
        if not self.redis:
            logger.warning(f"Redis not available for user profile lookup: {user_id}")
            return None

        profile = self.redis.get_user_profile(user_id)
        if not profile:
            logger.warning(f"No user profile found in Redis for: {user_id}")
            # Fallback: generate basic profile from user_id
            display_name = user_id.replace(".", " ").replace("_", " ").title()
            return f"## User Profile\n- **Name**: {display_name}\n- **Username**: {user_id}"

        parts = ["## 👤 User Profile"]

        # Name
        display_name = profile.get('display_name')
        first_name = profile.get('first_name')
        last_name = profile.get('last_name')

        if display_name:
            parts.append(f"- **Name**: {display_name}")
        elif first_name or last_name:
            full_name = f"{first_name or ''} {last_name or ''}".strip()
            parts.append(f"- **Name**: {full_name}")

        # Email (partial for privacy)
        email = profile.get('email', '')
        if email and '@' in email:
            local, domain = email.split('@', 1)
            masked = local[:2] + '***@' + domain
            parts.append(f"- **Email**: {masked}")

        # Last login
        last_login = profile.get('last_login_at')
        if last_login:
            if isinstance(last_login, str):
                parts.append(f"- **Last Active**: {last_login[:10]}")
            elif isinstance(last_login, datetime):
                parts.append(f"- **Last Active**: {last_login.strftime('%Y-%m-%d')}")

        # Preferences
        ai_mode = profile.get('ai_mode') or self.redis.get_user_preference(user_id, 'llm_mode')
        if ai_mode:
            parts.append(f"- **Preferred AI Mode**: {ai_mode}")

        language = profile.get('language')
        if language:
            parts.append(f"- **Language**: {language}")

        # Role/permissions if available
        role = profile.get('role') or profile.get('user_role')
        if role:
            parts.append(f"- **Role**: {role}")

        if len(parts) <= 1:
            return None

        return "\n".join(parts)

    def _build_tpms_context(
        self,
        project_number: str,
        max_panels: int
    ) -> tuple[Optional[str], Optional[Dict]]:
        """Build TPMS project context from Neo4j via CoCoIndex"""
        if not self.cocoindex:
            return None, None

        tpms_data = self.cocoindex.get_project_tpms_context(project_number)
        if not tpms_data:
            return None, None

        parts = ["## 🏭 Project Data (TPMS)"]

        # Project info
        if tpms_data.get("project_info"):
            info = tpms_data["project_info"]
            parts.append("\n### Project Information")

            name = info.get('project_name') or info.get('name')
            if name:
                parts.append(f"- **Project Name**: {name}")

            name_fa = info.get('project_name_fa')
            if name_fa:
                parts.append(f"- **Project Name (Persian)**: {name_fa}")

            category = info.get('order_category')
            if category:
                parts.append(f"- **Category**: {category}")

            date = info.get('oe_date')
            if date:
                parts.append(f"- **Date**: {date}")

            expert = info.get('project_expert')
            if expert:
                parts.append(f"- **Project Expert**: {expert}")

            supervisor = info.get('technical_supervisor')
            if supervisor:
                parts.append(f"- **Technical Supervisor**: {supervisor}")

        # Project identity (technical specs)
        if tpms_data.get("project_identity"):
            identity = tpms_data["project_identity"]
            identity_items = []

            for key, value in identity.items():
                if value:
                    readable_key = key.replace('_', ' ').title()
                    identity_items.append(f"- **{readable_key}**: {value}")

            if identity_items:
                parts.append("\n### Technical Specifications")
                parts.extend(identity_items)

        # Summary counts
        parts.append("\n### Project Summary")
        parts.append(f"- **Total Panels**: {tpms_data.get('panel_count', 0)}")
        parts.append(f"- **Total Feeders/Loads**: {tpms_data.get('feeder_count', 0)}")
        parts.append(f"- **Total Equipment Items**: {tpms_data.get('equipment_count', 0)}")

        # Panels list
        panels = tpms_data.get("panels", [])
        if panels:
            parts.append("\n### Panels/Switchgears")

            for panel in panels[:max_panels]:
                panel_name = (
                    panel.get('plane_name') or
                    panel.get('name') or
                    f"Panel {panel.get('panel_id')}"
                )
                panel_type = panel.get('plane_type') or panel.get('type') or 'N/A'
                voltage = panel.get('voltage_rate') or panel.get('rated_voltage') or 'N/A'
                amperage = panel.get('switch_amperage') or panel.get('amperage') or 'N/A'
                ip = panel.get('ip_value') or panel.get('ip') or 'N/A'
                feeder_count = panel.get('feeder_count', 0)

                parts.append(f"\n**{panel_name}**")
                parts.append(f"- Type: {panel_type}")
                parts.append(f"- Voltage: {voltage}")
                parts.append(f"- Amperage: {amperage}")
                parts.append(f"- IP Rating: {ip}")
                parts.append(f"- Feeders: {feeder_count}")

            if len(panels) > max_panels:
                parts.append(f"\n*... and {len(panels) - max_panels} more panels*")

        return "\n".join(parts), tpms_data

    def _build_graph_specs_context(
        self,
        project_number: str,
        query: str
    ) -> tuple[Optional[str], Optional[Dict]]:
        """Build graph specifications context from Neo4j"""
        if not self.graph_rag:
            return None, None

        # Check for protection-related queries
        protection_keywords = ['protection', 'protections', 'protective', 'relay', 'trip', 'breaker']
        is_protection_query = any(kw in query.lower() for kw in protection_keywords)

        if is_protection_query:
            result = self.graph_rag.get_protection_specifications(project_number)
            specs_list = result.get("protections", [])
        else:
            result = self.graph_rag.search_by_natural_query(project_number, query)
            specs_list = result.get("specs", [])

        if not result.get("success") or not specs_list:
            return None, None

        # Filter specs with actual values
        specs_with_values = [
            s for s in specs_list
            if s.get("value") and s["value"].strip() and s["value"] != "Not specified"
        ]

        if not specs_with_values:
            return None, result

        parts = [f"## 📊 Document Specifications ({len(specs_with_values)} found)"]

        # Group by category
        by_category = {}
        for spec in specs_with_values:
            category = spec.get("category", "Other")
            if category not in by_category:
                by_category[category] = []
            by_category[category].append(spec)

        for category, items in by_category.items():
            category_name = category.replace("_", " ").title()
            parts.append(f"\n### {category_name}")

            for item in items[:10]:  # Limit per category
                field = item.get("field", "").replace("_", " ")
                value = item.get("value", "")
                doc = item.get("document", "")

                line = f"- **{field}**: `{value}`"
                if doc:
                    line += f" _(from {doc})_"
                parts.append(line)

        return "\n".join(parts), result

    def _build_subgraph_context(
        self,
        project_number: str,
        query: str,
        max_depth: int
    ) -> tuple[Optional[str], Optional[Dict]]:
        """Build subgraph context via BFS traversal"""
        if not self.graph_rag:
            return None, None

        result = self.graph_rag.find_related_subgraph(
            project_number=project_number,
            query=query,
            max_depth=max_depth
        )

        if not result.get("success") or not result.get("nodes"):
            return None, None

        context = self.graph_rag.format_subgraph_for_context(result)
        return context if context else None, result

    def _build_vector_context(
        self,
        query: str,
        project_number: Optional[str],
        limit: int,
        score_threshold: float,
        max_to_show: int,
        chat_id: Optional[str] = None,
        chat_type: str = "general"
    ) -> tuple[Optional[str], Optional[List]]:
        """Build vector search context from Qdrant"""
        if not self.qdrant:
            return None, None

        # For general chats, documents are stored with project_oenum=f"general_{chat_id}"
        effective_project_oenum = project_number
        if not project_number and chat_id and chat_type == "general":
            effective_project_oenum = f"general_{chat_id}"

        results = self.qdrant.search_section_summaries(
            user_id="system",  # Documents stored with user_id="system"
            query=query,
            limit=limit,
            project_oenum=effective_project_oenum,
            score_threshold=score_threshold
        )

        if not results:
            return None, None

        parts = [f"## 📄 Relevant Document Sections ({len(results)} found)"]

        for idx, result in enumerate(results[:max_to_show], 1):
            title = result.get('section_title', 'Section')
            score = result.get('score', 0)
            content = result.get('full_content', result.get('text', ''))
            subjects = result.get('subjects', [])

            parts.append(f"\n### {idx}. {title} (Relevance: {score:.0%})")

            if subjects:
                parts.append(f"**Topics**: {', '.join(subjects[:5])}")

            parts.append(f"\n{content}")

        return "\n".join(parts), results

    def _build_user_memory_context(
        self,
        user_id: str,
        query: str,
        chat_id: str,
        project_number: Optional[str],
        limit: int,
        score_threshold: float
    ) -> tuple[Optional[str], Optional[List]]:
        """Build user memory context from Qdrant"""
        if not self.qdrant:
            return None, None

        try:
            results = self.qdrant.retrieve_similar_conversations(
                user_id=user_id,
                current_query=query,
                limit=limit,
                score_threshold=score_threshold,
                project_filter=project_number,
                chat_id=chat_id,
                fallback_to_recent=True
            )
        except Exception as e:
            logger.warning(f"User memory retrieval failed: {e}")
            return None, None

        if not results:
            return None, None

        parts = ["## 💭 Relevant Past Conversations"]

        for conv in results[:3]:  # Limit display
            q = conv.get('question', '')[:200]
            a = conv.get('answer', '')[:300]
            score = conv.get('score', 0)

            if q and a:
                parts.append(f"\n**Q**: {q}")
                parts.append(f"**A**: {a}...")
                parts.append(f"_(Relevance: {score:.0%})_")

        return "\n".join(parts), results

    def _build_chat_history_context(
        self,
        user_id: str,
        chat_id: str,
        project_number: Optional[str],
        chat_type: str,
        limit: int
    ) -> tuple[Optional[str], Optional[List]]:
        """Build chat history context from Redis"""
        if not self.redis:
            return None, None

        try:
            if chat_type == "project" and project_number:
                # Cross-chat memory for project chats
                messages = self.redis.get_project_chat_history(
                    user_id=user_id,
                    project_number=project_number,
                    current_chat_id=chat_id,
                    limit=limit,
                    include_current_chat=True
                )
            else:
                # Single chat history
                messages = self.redis.get_chat_history(chat_id, limit=limit)
        except Exception as e:
            logger.warning(f"Chat history retrieval failed: {e}")
            return None, None

        if not messages:
            return None, None

        parts = ["## 📝 Recent Conversation"]

        for msg in messages[-5:]:  # Last 5 messages
            role = msg.get('role', 'user')
            content = msg.get('content', '')[:300]
            from_other = msg.get('from_other_chat', False)

            prefix = "🔄 " if from_other else ""
            role_label = "You" if role == "user" else "Assistant"

            parts.append(f"\n{prefix}**{role_label}**: {content}")

        return "\n".join(parts), messages

    def _build_document_overview_context(
        self,
        project_number: str
    ) -> tuple[Optional[str], Optional[Dict]]:
        """Build document overview context"""
        try:
            from services.document_overview_service import DocumentOverviewService

            doc_service = DocumentOverviewService(redis_service=self.redis)
            overview = doc_service.generate_overview(
                project_number=project_number,
                max_documents=10
            )

            if not overview or not overview.get('documents'):
                return None, None

            parts = ["## 📁 Uploaded Documents"]

            for doc in overview.get('documents', [])[:10]:
                name = doc.get('filename', doc.get('name', 'Unknown'))
                doc_type = doc.get('type', 'Document')
                parts.append(f"- {name} ({doc_type})")

            total = overview.get('total_count', len(overview.get('documents', [])))
            if total > 10:
                parts.append(f"- *... and {total - 10} more*")

            return "\n".join(parts), overview

        except Exception as e:
            logger.warning(f"Document overview failed: {e}")
            return None, None

    # =========================================================================
    # CONVENIENCE METHODS
    # =========================================================================

    def build_system_prompt(
        self,
        context_result: ContextResult,
        base_prompt: Optional[str] = None,
        project_number: Optional[str] = None
    ) -> str:
        """
        Build complete system prompt with context.

        Args:
            context_result: Result from build_context()
            base_prompt: Optional base system prompt
            project_number: Optional project number for context

        Returns:
            Complete system prompt string
        """
        if base_prompt is None:
            base_prompt = self._get_default_system_prompt()

        parts = [base_prompt]

        if project_number:
            parts.append(f"\n**Current Project**: {project_number}")

        if context_result.context_text:
            parts.append("\n" + "=" * 50)
            parts.append("# CONTEXT (Use this information to answer)")
            parts.append("=" * 50)
            parts.append(context_result.context_text)
            parts.append("\n" + "=" * 50)
            parts.append(
                "**IMPORTANT**: Use the above context to answer the user's question. "
                "Cite specific values from the project data when relevant."
            )

        return "\n".join(parts)

    def _get_default_system_prompt(self) -> str:
        """Get default system prompt for electrical engineering assistant"""
        return """You are an expert industrial electrical engineer assistant specializing in:
- Low/Medium Voltage (LV/MV) switchgear and panel design
- Power distribution systems and load calculations
- Protection devices (circuit breakers, relays, RCDs)
- IEC and IEEE standards compliance
- Siemens and other major equipment manufacturers

Guidelines:
- Provide accurate, technical responses based on standards
- Reference specific project data when available
- Be concise but thorough
- If information is not in the context, say so clearly"""


# =============================================================================
# SINGLETON & FACTORY
# =============================================================================

_context_service_instance: Optional[UnifiedLLMContextService] = None


def get_unified_context_service(
    redis_service=None,
    neo4j_driver=None,
    qdrant_service=None,
    config: Optional[ContextConfig] = None
) -> UnifiedLLMContextService:
    """
    Get or create unified context service singleton.

    Args:
        redis_service: RedisService instance
        neo4j_driver: Neo4j driver instance
        qdrant_service: QdrantService instance
        config: Optional context configuration

    Returns:
        UnifiedLLMContextService instance
    """
    global _context_service_instance

    if _context_service_instance is None:
        _context_service_instance = UnifiedLLMContextService(
            redis_service=redis_service,
            neo4j_driver=neo4j_driver,
            qdrant_service=qdrant_service,
            config=config
        )

    return _context_service_instance


def reset_context_service():
    """Reset singleton (for testing)"""
    global _context_service_instance
    _context_service_instance = None
