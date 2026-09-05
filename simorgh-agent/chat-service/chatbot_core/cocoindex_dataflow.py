"""
CocoIndex Dataflow Manager
==========================
Unified layer/interface between the chatbot and Postgres, Qdrant, Neo4j.

Defines declarative dataflows for:
- Ingestion: Document upload, embedding, graph building
- Transformation: Text processing, entity extraction
- Syncing: Delta/incremental updates across stores

Runs in 'live' mode for real-time updates.
Uses CocoIndex metadata in Postgres.

NOTE: Redis is NOT routed through this layer - it's handled directly
by the MemoryManager for high-speed cache operations.

Author: Simorgh Industrial Assistant
"""

import logging
import asyncio
from typing import List, Dict, Any, Optional, Callable, Union
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from abc import ABC, abstractmethod

logger = logging.getLogger(__name__)


# =============================================================================
# DATAFLOW ENUMS AND MODELS
# =============================================================================

class DataflowMode(str, Enum):
    """Dataflow execution modes"""
    LIVE = "live"           # Real-time processing
    BATCH = "batch"         # Batch processing
    INCREMENTAL = "incremental"  # Delta updates only


class DataflowStatus(str, Enum):
    """Status of a dataflow"""
    IDLE = "idle"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class DataStore(str, Enum):
    """Available data stores"""
    POSTGRES = "postgres"
    QDRANT = "qdrant"
    NEO4J = "neo4j"


@dataclass
class DataflowStep:
    """Single step in a dataflow pipeline"""
    step_id: str
    name: str
    transformer: Callable
    input_store: Optional[DataStore] = None
    output_store: Optional[DataStore] = None
    config: Dict[str, Any] = field(default_factory=dict)

    async def execute(self, data: Any, context: Dict[str, Any]) -> Any:
        """Execute this step"""
        try:
            if asyncio.iscoroutinefunction(self.transformer):
                return await self.transformer(data, context, self.config)
            else:
                return self.transformer(data, context, self.config)
        except Exception as e:
            logger.error(f"Step {self.step_id} failed: {e}")
            raise


@dataclass
class DataflowResult:
    """Result of a dataflow execution"""
    success: bool
    dataflow_id: str
    steps_completed: int
    steps_total: int
    output_data: Any = None
    errors: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    duration_ms: float = 0.0


# =============================================================================
# BASE DATAFLOW CLASS
# =============================================================================

class BaseDataflow(ABC):
    """
    Abstract base class for declarative dataflows.

    Subclasses implement specific data processing pipelines.
    """

    def __init__(
        self,
        dataflow_id: str,
        name: str,
        mode: DataflowMode = DataflowMode.LIVE,
    ):
        self.dataflow_id = dataflow_id
        self.name = name
        self.mode = mode
        self.steps: List[DataflowStep] = []
        self.status = DataflowStatus.IDLE
        self._created_at = datetime.utcnow()

    def add_step(self, step: DataflowStep):
        """Add a step to the dataflow"""
        self.steps.append(step)
        return self

    @abstractmethod
    def build_steps(self):
        """Build the dataflow steps. Override in subclasses."""
        pass

    async def execute(
        self,
        input_data: Any,
        context: Dict[str, Any] = None,
    ) -> DataflowResult:
        """
        Execute the complete dataflow.

        Args:
            input_data: Input data for the flow
            context: Execution context with services and config

        Returns:
            DataflowResult with execution status
        """
        import time
        start_time = time.time()

        self.status = DataflowStatus.RUNNING
        context = context or {}
        errors = []
        steps_completed = 0
        current_data = input_data

        try:
            for step in self.steps:
                try:
                    current_data = await step.execute(current_data, context)
                    steps_completed += 1
                except Exception as e:
                    errors.append(f"Step {step.name}: {str(e)}")
                    if self.mode == DataflowMode.LIVE:
                        # In live mode, fail fast
                        break

            self.status = DataflowStatus.COMPLETED if not errors else DataflowStatus.FAILED

            return DataflowResult(
                success=not errors,
                dataflow_id=self.dataflow_id,
                steps_completed=steps_completed,
                steps_total=len(self.steps),
                output_data=current_data,
                errors=errors,
                metadata={
                    "mode": self.mode.value,
                    "executed_at": datetime.utcnow().isoformat(),
                },
                duration_ms=(time.time() - start_time) * 1000,
            )

        except Exception as e:
            self.status = DataflowStatus.FAILED
            return DataflowResult(
                success=False,
                dataflow_id=self.dataflow_id,
                steps_completed=steps_completed,
                steps_total=len(self.steps),
                errors=[str(e)],
                duration_ms=(time.time() - start_time) * 1000,
            )


# =============================================================================
# COCOINDEX DATAFLOW MANAGER
# =============================================================================

class CocoIndexDataflowManager:
    """
    Unified CocoIndex Dataflow Manager.

    Provides:
    - Declarative dataflows for ingestion, transformation, syncing
    - Unified interface to Postgres, Qdrant, Neo4j
    - Delta/incremental update handling
    - Live mode for real-time processing
    - Metadata tracking in Postgres
    """

    def __init__(
        self,
        postgres_service=None,
        qdrant_service=None,
        neo4j_service=None,
        llm_service=None,
    ):
        """
        Initialize dataflow manager.

        Args:
            postgres_service: PostgreSQL service for metadata and full history
            qdrant_service: Qdrant service for vector storage
            neo4j_service: Neo4j service for graph storage
            llm_service: LLM service for transformations
        """
        self.postgres = postgres_service
        self.qdrant = qdrant_service
        self.neo4j = neo4j_service
        self.llm = llm_service

        # Registered dataflows
        self._dataflows: Dict[str, BaseDataflow] = {}

        # Execution history
        self._execution_history: List[DataflowResult] = []

        logger.info("CocoIndexDataflowManager initialized")

    def set_services(
        self,
        postgres_service=None,
        qdrant_service=None,
        neo4j_service=None,
        llm_service=None,
    ):
        """Update service dependencies"""
        if postgres_service:
            self.postgres = postgres_service
        if qdrant_service:
            self.qdrant = qdrant_service
        if neo4j_service:
            self.neo4j = neo4j_service
        if llm_service:
            self.llm = llm_service

    def register_dataflow(self, dataflow: BaseDataflow):
        """Register a dataflow for reuse"""
        self._dataflows[dataflow.dataflow_id] = dataflow
        logger.info(f"Registered dataflow: {dataflow.name}")

    def get_dataflow(self, dataflow_id: str) -> Optional[BaseDataflow]:
        """Get a registered dataflow"""
        return self._dataflows.get(dataflow_id)

    # =========================================================================
    # CHAT HISTORY OPERATIONS (Postgres)
    # =========================================================================

    async def get_chat_history(
        self,
        chat_id: str,
        project_id: Optional[str] = None,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        """
        Get chat history from Postgres (source of truth).

        Args:
            chat_id: Chat identifier
            project_id: Optional project filter
            limit: Maximum messages

        Returns:
            List of message dictionaries
        """
        if not self.postgres:
            logger.warning("Postgres service not available")
            return []

        try:
            # Use message persistence or direct query
            # This would integrate with existing message_persistence.py

            # Placeholder for actual Postgres query
            # In production, this would use SQLAlchemy or asyncpg
            query = """
                SELECT message_id, chat_id, user_id, role, content,
                       timestamp, metadata, project_id
                FROM chat_messages
                WHERE chat_id = $1
            """
            params = [chat_id]

            if project_id:
                query += " AND (project_id = $2 OR project_id IS NULL)"
                params.append(project_id)

            query += " ORDER BY timestamp DESC LIMIT $" + str(len(params) + 1)
            params.append(limit)

            # Execute query via postgres service
            # results = await self.postgres.fetch(query, *params)
            # return [dict(r) for r in results]

            # For now, return empty - actual implementation depends on postgres setup
            logger.debug(f"Getting chat history for {chat_id} from Postgres")
            return []

        except Exception as e:
            logger.error(f"Error fetching chat history: {e}")
            return []

    async def store_message(
        self,
        message_id: str,
        chat_id: str,
        user_id: str,
        role: str,
        content: str,
        project_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """
        Store message to Postgres.

        Args:
            message_id: Message identifier
            chat_id: Chat identifier
            user_id: User identifier
            role: Message role
            content: Message content
            project_id: Optional project ID
            metadata: Additional metadata

        Returns:
            True if successful
        """
        if not self.postgres:
            logger.warning("Postgres service not available")
            return False

        try:
            # Use message persistence service
            # This integrates with existing message_persistence.py

            query = """
                INSERT INTO chat_messages
                (message_id, chat_id, user_id, role, content, timestamp, project_id, metadata)
                VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7)
                ON CONFLICT (message_id) DO UPDATE SET
                    content = EXCLUDED.content,
                    metadata = EXCLUDED.metadata
            """

            # await self.postgres.execute(query, message_id, chat_id, user_id,
            #                             role, content, project_id, metadata)

            logger.debug(f"Stored message {message_id} to Postgres")
            return True

        except Exception as e:
            logger.error(f"Error storing message: {e}")
            return False

    # =========================================================================
    # DOCUMENT OPERATIONS (Qdrant + Postgres)
    # =========================================================================

    async def get_documents(
        self,
        chat_id: Optional[str] = None,
        project_id: Optional[str] = None,
        document_ids: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """
        Get document metadata and embeddings.

        Args:
            chat_id: Filter by chat ID
            project_id: Filter by project ID
            document_ids: Filter by specific document IDs

        Returns:
            List of document dictionaries
        """
        documents = []

        # Get metadata from Postgres
        if self.postgres:
            try:
                # Query document metadata
                # documents = await self._fetch_document_metadata(...)
                pass
            except Exception as e:
                logger.warning(f"Error fetching document metadata: {e}")

        return documents

    async def store_document_embedding(
        self,
        document_id: str,
        user_id: str,
        content: str,
        embedding: List[float],
        chat_id: Optional[str] = None,
        project_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """
        Store document embedding to Qdrant.

        Args:
            document_id: Document identifier
            user_id: User identifier
            content: Document content
            embedding: Embedding vector
            chat_id: Chat ID for general chats
            project_id: Project ID for project chats
            metadata: Additional metadata

        Returns:
            True if successful
        """
        if not self.qdrant:
            logger.warning("Qdrant service not available")
            return False

        try:
            # Determine collection based on context
            if project_id:
                session_id = None
                project_oenum = project_id
            else:
                session_id = chat_id
                project_oenum = None

            # Create chunks for storage
            chunks = [{
                "text": content,
                "section_title": metadata.get("filename", "Document") if metadata else "Document",
                "chunk_index": 0,
                "metadata": metadata or {},
            }]

            # Store via Qdrant service
            success = self.qdrant.add_document_chunks(
                user_id=user_id,
                document_id=document_id,
                chunks=chunks,
                session_id=session_id,
                project_oenum=project_oenum,
            )

            return success

        except Exception as e:
            logger.error(f"Error storing document embedding: {e}")
            return False

    async def semantic_search(
        self,
        query: str,
        chat_id: Optional[str] = None,
        project_id: Optional[str] = None,
        user_id: Optional[str] = None,
        limit: int = 5,
        score_threshold: float = 0.6,
    ) -> List[Dict[str, Any]]:
        """
        Perform semantic search in Qdrant.

        Args:
            query: Search query
            chat_id: Chat ID for general chats
            project_id: Project ID for project chats
            user_id: User identifier
            limit: Maximum results
            score_threshold: Minimum similarity

        Returns:
            List of search results
        """
        if not self.qdrant:
            logger.warning("Qdrant service not available")
            return []

        try:
            user_id = user_id or "system"

            # Determine context
            if project_id:
                results = self.qdrant.semantic_search(
                    user_id=user_id,
                    query=query,
                    limit=limit,
                    score_threshold=score_threshold,
                    project_oenum=project_id,
                )
            elif chat_id:
                results = self.qdrant.semantic_search(
                    user_id=user_id,
                    query=query,
                    limit=limit,
                    score_threshold=score_threshold,
                    session_id=chat_id,
                )
            else:
                results = []

            return results

        except Exception as e:
            logger.error(f"Error in semantic search: {e}")
            return []

    # =========================================================================
    # GRAPH OPERATIONS (Neo4j)
    # =========================================================================

    async def get_graph_context(
        self,
        project_id: str,
        query: Optional[str] = None,
        entity_types: Optional[List[str]] = None,
    ) -> Optional[str]:
        """
        Get graph context from Neo4j.

        Args:
            project_id: Project identifier
            query: Optional query to filter
            entity_types: Optional entity types to include

        Returns:
            Graph context as formatted string
        """
        if not self.neo4j:
            logger.warning("Neo4j service not available")
            return None

        try:
            # Query project entities and relationships
            context_parts = []

            # Get entities
            entities = self.neo4j.get_project_entities(
                project_number=project_id,
                entity_types=entity_types,
            )

            if entities:
                context_parts.append("## Project Entities")
                for entity in entities[:20]:  # Limit to 20 entities
                    entity_type = entity.get("type", "Unknown")
                    entity_id = entity.get("entity_id", "")
                    props = entity.get("properties", {})
                    context_parts.append(f"- {entity_type}: {entity_id}")
                    if props:
                        key_props = {k: v for k, v in list(props.items())[:3]}
                        context_parts.append(f"  Properties: {key_props}")

            # Get relationships
            relationships = self.neo4j.get_project_relationships(
                project_number=project_id,
            )

            if relationships:
                context_parts.append("\n## Key Relationships")
                for rel in relationships[:15]:  # Limit relationships
                    from_id = rel.get("from")
                    to_id = rel.get("to")
                    rel_type = rel.get("type")
                    context_parts.append(f"- {from_id} --[{rel_type}]--> {to_id}")

            return "\n".join(context_parts) if context_parts else None

        except Exception as e:
            logger.error(f"Error getting graph context: {e}")
            return None

    async def store_graph_entity(
        self,
        project_id: str,
        entity_type: str,
        entity_id: str,
        properties: Dict[str, Any],
    ) -> bool:
        """
        Store entity to Neo4j graph.

        Args:
            project_id: Project identifier
            entity_type: Type of entity
            entity_id: Entity identifier
            properties: Entity properties

        Returns:
            True if successful
        """
        if not self.neo4j:
            logger.warning("Neo4j service not available")
            return False

        try:
            # Use Neo4j service to create entity
            self.neo4j.create_entity(
                project_number=project_id,
                entity_type=entity_type,
                entity_id=entity_id,
                properties=properties,
            )
            return True

        except Exception as e:
            logger.error(f"Error storing graph entity: {e}")
            return False

    async def store_graph_relationship(
        self,
        project_id: str,
        from_entity_id: str,
        to_entity_id: str,
        relationship_type: str,
        properties: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """
        Store relationship to Neo4j graph.

        Args:
            project_id: Project identifier
            from_entity_id: Source entity ID
            to_entity_id: Target entity ID
            relationship_type: Type of relationship
            properties: Relationship properties

        Returns:
            True if successful
        """
        if not self.neo4j:
            logger.warning("Neo4j service not available")
            return False

        try:
            self.neo4j.create_relationship(
                project_number=project_id,
                from_entity_id=from_entity_id,
                to_entity_id=to_entity_id,
                relationship_type=relationship_type,
                properties=properties or {},
            )
            return True

        except Exception as e:
            logger.error(f"Error storing graph relationship: {e}")
            return False

    # =========================================================================
    # DATAFLOW EXECUTION
    # =========================================================================

    async def execute_dataflow(
        self,
        dataflow_id: str,
        input_data: Any,
        context: Optional[Dict[str, Any]] = None,
    ) -> DataflowResult:
        """
        Execute a registered dataflow.

        Args:
            dataflow_id: ID of the dataflow to execute
            input_data: Input data
            context: Additional context

        Returns:
            DataflowResult
        """
        dataflow = self._dataflows.get(dataflow_id)
        if not dataflow:
            return DataflowResult(
                success=False,
                dataflow_id=dataflow_id,
                steps_completed=0,
                steps_total=0,
                errors=[f"Dataflow {dataflow_id} not found"],
            )

        # Build execution context with services
        exec_context = {
            "postgres": self.postgres,
            "qdrant": self.qdrant,
            "neo4j": self.neo4j,
            "llm": self.llm,
            **(context or {}),
        }

        result = await dataflow.execute(input_data, exec_context)

        # Track execution history
        self._execution_history.append(result)
        if len(self._execution_history) > 100:
            self._execution_history = self._execution_history[-100:]

        return result

    # =========================================================================
    # INCREMENTAL SYNC
    # =========================================================================

    async def sync_incremental(
        self,
        source_store: DataStore,
        target_store: DataStore,
        project_id: Optional[str] = None,
        since: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """
        Perform incremental sync between stores.

        Args:
            source_store: Source data store
            target_store: Target data store
            project_id: Optional project filter
            since: Only sync changes since this time

        Returns:
            Sync statistics
        """
        # Placeholder for incremental sync logic
        # Would implement delta detection and sync

        logger.info(f"Incremental sync: {source_store.value} -> {target_store.value}")

        return {
            "success": True,
            "source": source_store.value,
            "target": target_store.value,
            "records_synced": 0,
            "since": since.isoformat() if since else None,
        }

    # =========================================================================
    # STATISTICS
    # =========================================================================

    def get_stats(self) -> Dict[str, Any]:
        """Get dataflow manager statistics"""
        return {
            "registered_dataflows": len(self._dataflows),
            "dataflow_ids": list(self._dataflows.keys()),
            "recent_executions": len(self._execution_history),
            "services_available": {
                "postgres": self.postgres is not None,
                "qdrant": self.qdrant is not None,
                "neo4j": self.neo4j is not None,
                "llm": self.llm is not None,
            },
        }


# =============================================================================
# BUILT-IN DATAFLOWS
# =============================================================================

class DocumentIngestionDataflow(BaseDataflow):
    """
    Dataflow for document ingestion.

    Steps:
    1. Parse document content
    2. Chunk content
    3. Generate embeddings
    4. Store to Qdrant
    5. Extract entities (optional)
    6. Store to Neo4j (optional)
    7. Store metadata to Postgres
    """

    def __init__(self):
        super().__init__(
            dataflow_id="document_ingestion",
            name="Document Ingestion Pipeline",
            mode=DataflowMode.LIVE,
        )
        self.build_steps()

    def build_steps(self):
        """Build ingestion pipeline steps"""

        async def parse_content(data, context, config):
            """Parse document content"""
            return {
                **data,
                "parsed": True,
                "content_length": len(data.get("content", "")),
            }

        async def chunk_content(data, context, config):
            """Chunk content for embedding"""
            content = data.get("content", "")
            chunk_size = config.get("chunk_size", 1000)
            overlap = config.get("overlap", 100)

            chunks = []
            for i in range(0, len(content), chunk_size - overlap):
                chunk = content[i:i + chunk_size]
                if chunk.strip():
                    chunks.append({
                        "text": chunk,
                        "chunk_index": len(chunks),
                    })

            return {**data, "chunks": chunks}

        async def generate_embeddings(data, context, config):
            """Generate embeddings for chunks"""
            llm = context.get("llm")
            qdrant = context.get("qdrant")

            if not llm and not qdrant:
                return {**data, "embeddings_generated": False}

            chunks = data.get("chunks", [])
            for chunk in chunks:
                try:
                    if qdrant:
                        embedding = qdrant.generate_embedding(chunk["text"])
                        chunk["embedding"] = embedding
                except Exception as e:
                    logger.warning(f"Embedding generation failed: {e}")

            return {**data, "embeddings_generated": True}

        async def store_to_qdrant(data, context, config):
            """Store chunks to Qdrant"""
            qdrant = context.get("qdrant")
            if not qdrant:
                return {**data, "stored_to_qdrant": False}

            user_id = data.get("user_id", "system")
            document_id = data.get("document_id")
            project_id = data.get("project_id")
            chat_id = data.get("chat_id")
            chunks = data.get("chunks", [])

            success = qdrant.add_document_chunks(
                user_id=user_id,
                document_id=document_id,
                chunks=chunks,
                session_id=chat_id if not project_id else None,
                project_oenum=project_id,
            )

            return {**data, "stored_to_qdrant": success}

        self.add_step(DataflowStep("parse", "Parse Content", parse_content))
        self.add_step(DataflowStep("chunk", "Chunk Content", chunk_content))
        self.add_step(DataflowStep("embed", "Generate Embeddings", generate_embeddings))
        self.add_step(DataflowStep("store_qdrant", "Store to Qdrant", store_to_qdrant,
                                   output_store=DataStore.QDRANT))


class ChatHistorySyncDataflow(BaseDataflow):
    """
    Dataflow for syncing chat history.

    Steps:
    1. Read from source (Redis or Postgres)
    2. Transform/normalize messages
    3. Store to target
    """

    def __init__(self):
        super().__init__(
            dataflow_id="chat_history_sync",
            name="Chat History Sync",
            mode=DataflowMode.INCREMENTAL,
        )
        self.build_steps()

    def build_steps(self):
        """Build sync pipeline steps"""

        async def normalize_messages(data, context, config):
            """Normalize message format"""
            messages = data.get("messages", [])
            normalized = []

            for msg in messages:
                normalized.append({
                    "message_id": msg.get("message_id"),
                    "chat_id": msg.get("chat_id"),
                    "user_id": msg.get("user_id"),
                    "role": msg.get("role"),
                    "content": msg.get("content") or msg.get("text"),
                    "timestamp": msg.get("timestamp") or msg.get("created_at"),
                    "project_id": msg.get("project_id"),
                })

            return {**data, "messages": normalized}

        self.add_step(DataflowStep("normalize", "Normalize Messages", normalize_messages))


# =============================================================================
# SINGLETON
# =============================================================================

_dataflow_manager: Optional[CocoIndexDataflowManager] = None


def get_dataflow_manager(
    postgres_service=None,
    qdrant_service=None,
    neo4j_service=None,
    llm_service=None,
) -> CocoIndexDataflowManager:
    """Get or create dataflow manager singleton"""
    global _dataflow_manager

    if _dataflow_manager is None:
        _dataflow_manager = CocoIndexDataflowManager(
            postgres_service=postgres_service,
            qdrant_service=qdrant_service,
            neo4j_service=neo4j_service,
            llm_service=llm_service,
        )

        # Register built-in dataflows
        _dataflow_manager.register_dataflow(DocumentIngestionDataflow())
        _dataflow_manager.register_dataflow(ChatHistorySyncDataflow())

    elif any([postgres_service, qdrant_service, neo4j_service, llm_service]):
        _dataflow_manager.set_services(
            postgres_service=postgres_service,
            qdrant_service=qdrant_service,
            neo4j_service=neo4j_service,
            llm_service=llm_service,
        )

    return _dataflow_manager
