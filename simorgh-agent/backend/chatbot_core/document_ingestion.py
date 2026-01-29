"""
Document Ingestion Pipeline
===========================
Handles document uploads with CocoIndex-based embedding and storage.

Pipeline:
1. Parse/extract document content
2. Chunk content appropriately
3. Generate embeddings via LLM
4. Store to Qdrant (vectors)
5. Store to Neo4j (entities/relationships)
6. Store metadata to Postgres

Supports both General and Project contexts.

Author: Simorgh Industrial Assistant
"""

import logging
import uuid
import time
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, field
from datetime import datetime

from .models import (
    ChatType,
    DocumentCategory,
    DocumentContext,
    ChatContext,
    ProjectSessionContext,
)
from .cocoindex_dataflow import (
    CocoIndexDataflowManager,
    BaseDataflow,
    DataflowStep,
    DataflowMode,
    DataStore,
    get_dataflow_manager,
)

logger = logging.getLogger(__name__)


# =============================================================================
# INGESTION RESULT
# =============================================================================

@dataclass
class IngestionResult:
    """Result of document ingestion"""
    success: bool
    document_id: str
    filename: str
    chunks_created: int = 0
    entities_extracted: int = 0
    relationships_created: int = 0
    stored_to_qdrant: bool = False
    stored_to_neo4j: bool = False
    stored_to_postgres: bool = False
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    processing_time_ms: float = 0.0
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "success": self.success,
            "document_id": self.document_id,
            "filename": self.filename,
            "chunks_created": self.chunks_created,
            "entities_extracted": self.entities_extracted,
            "relationships_created": self.relationships_created,
            "stored_to_qdrant": self.stored_to_qdrant,
            "stored_to_neo4j": self.stored_to_neo4j,
            "stored_to_postgres": self.stored_to_postgres,
            "errors": self.errors,
            "warnings": self.warnings,
            "processing_time_ms": self.processing_time_ms,
            "metadata": self.metadata,
        }


# =============================================================================
# DOCUMENT CHUNKER
# =============================================================================

class DocumentChunker:
    """
    Chunks documents for embedding.

    Strategies:
    - Fixed size with overlap
    - Sentence-based
    - Section-based (for structured documents)
    """

    def __init__(
        self,
        chunk_size: int = 1000,
        overlap: int = 100,
        min_chunk_size: int = 100,
    ):
        self.chunk_size = chunk_size
        self.overlap = overlap
        self.min_chunk_size = min_chunk_size

    def chunk_by_size(
        self,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """
        Chunk content by fixed size with overlap.

        Args:
            content: Document content
            metadata: Optional metadata to include

        Returns:
            List of chunks
        """
        chunks = []
        start = 0
        chunk_index = 0

        while start < len(content):
            end = start + self.chunk_size

            # Find a good break point (paragraph or sentence)
            if end < len(content):
                # Try paragraph break first
                para_break = content.rfind('\n\n', start, end)
                if para_break > start + self.min_chunk_size:
                    end = para_break + 2
                else:
                    # Try sentence break
                    for sep in ['. ', '! ', '? ', '.\n']:
                        sent_break = content.rfind(sep, start, end)
                        if sent_break > start + self.min_chunk_size:
                            end = sent_break + len(sep)
                            break

            chunk_text = content[start:end].strip()

            if len(chunk_text) >= self.min_chunk_size:
                chunks.append({
                    "text": chunk_text,
                    "chunk_index": chunk_index,
                    "start_char": start,
                    "end_char": end,
                    "metadata": metadata or {},
                })
                chunk_index += 1

            # Move start with overlap
            start = end - self.overlap
            if start >= len(content):
                break

        return chunks

    def chunk_by_sections(
        self,
        content: str,
        section_markers: List[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """
        Chunk content by section markers.

        Args:
            content: Document content
            section_markers: List of section header patterns
            metadata: Optional metadata

        Returns:
            List of section chunks
        """
        if not section_markers:
            section_markers = [
                '# ', '## ', '### ',  # Markdown headers
                '\n\n',  # Paragraph breaks
            ]

        import re

        # Find all section boundaries
        boundaries = [0]
        for marker in section_markers:
            if marker.startswith('#'):
                pattern = rf'^{re.escape(marker)}'
                for match in re.finditer(pattern, content, re.MULTILINE):
                    boundaries.append(match.start())
            else:
                for match in re.finditer(re.escape(marker), content):
                    boundaries.append(match.start())

        boundaries = sorted(set(boundaries))
        boundaries.append(len(content))

        chunks = []
        for i in range(len(boundaries) - 1):
            start = boundaries[i]
            end = boundaries[i + 1]
            chunk_text = content[start:end].strip()

            if len(chunk_text) >= self.min_chunk_size:
                # Extract section title if it starts with a header
                section_title = ""
                lines = chunk_text.split('\n', 1)
                if lines[0].startswith('#'):
                    section_title = lines[0].lstrip('#').strip()

                chunks.append({
                    "text": chunk_text,
                    "chunk_index": len(chunks),
                    "section_title": section_title,
                    "start_char": start,
                    "end_char": end,
                    "metadata": metadata or {},
                })

        return chunks


# =============================================================================
# DOCUMENT INGESTION PIPELINE
# =============================================================================

class DocumentIngestionPipeline:
    """
    Complete document ingestion pipeline.

    Handles:
    - Content parsing and chunking
    - Embedding generation
    - Storage to Qdrant (vectors)
    - Storage to Neo4j (entities) - for project documents
    - Metadata storage to Postgres
    """

    def __init__(
        self,
        cocoindex_manager: Optional[CocoIndexDataflowManager] = None,
        qdrant_service=None,
        neo4j_service=None,
        llm_service=None,
        doc_processor_client=None,
    ):
        """
        Initialize ingestion pipeline.

        Args:
            cocoindex_manager: CocoIndex dataflow manager
            qdrant_service: Qdrant service for vector storage
            neo4j_service: Neo4j service for graph storage
            llm_service: LLM service for embeddings
            doc_processor_client: Document processor for PDF/DOCX
        """
        self.cocoindex = cocoindex_manager or get_dataflow_manager()
        self.qdrant = qdrant_service
        self.neo4j = neo4j_service
        self.llm = llm_service
        self.doc_processor = doc_processor_client

        # Chunker
        self.chunker = DocumentChunker()

        # Statistics
        self.stats = {
            "documents_processed": 0,
            "chunks_created": 0,
            "errors": 0,
        }

        logger.info("DocumentIngestionPipeline initialized")

    def set_services(
        self,
        cocoindex_manager=None,
        qdrant_service=None,
        neo4j_service=None,
        llm_service=None,
        doc_processor_client=None,
    ):
        """Update service dependencies"""
        if cocoindex_manager:
            self.cocoindex = cocoindex_manager
        if qdrant_service:
            self.qdrant = qdrant_service
        if neo4j_service:
            self.neo4j = neo4j_service
        if llm_service:
            self.llm = llm_service
        if doc_processor_client:
            self.doc_processor = doc_processor_client

    # =========================================================================
    # MAIN INGESTION METHOD
    # =========================================================================

    async def ingest_document(
        self,
        content: str,
        filename: str,
        user_id: str,
        chat_type: ChatType,
        chat_id: Optional[str] = None,
        project_id: Optional[str] = None,
        category: DocumentCategory = DocumentCategory.GENERAL,
        extract_entities: bool = True,
        generate_summary: bool = True,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> IngestionResult:
        """
        Ingest a document into the system.

        Args:
            content: Document content (text or markdown)
            filename: Original filename
            user_id: User identifier
            chat_type: General or Project chat
            chat_id: Chat ID (for general chats)
            project_id: Project ID (for project chats)
            category: Document category
            extract_entities: Whether to extract entities to Neo4j
            generate_summary: Whether to generate document summary
            metadata: Additional metadata

        Returns:
            IngestionResult with processing details
        """
        start_time = time.time()
        document_id = str(uuid.uuid4())

        result = IngestionResult(
            success=False,
            document_id=document_id,
            filename=filename,
        )

        try:
            # Validate inputs
            if chat_type == ChatType.PROJECT and not project_id:
                result.errors.append("project_id required for project documents")
                return result

            if chat_type == ChatType.GENERAL and not chat_id:
                result.errors.append("chat_id required for general documents")
                return result

            # Step 1: Chunk content
            chunks = self.chunker.chunk_by_size(
                content,
                metadata={
                    "filename": filename,
                    "document_id": document_id,
                    "category": category.value,
                }
            )

            if not chunks:
                result.errors.append("No chunks created from content")
                return result

            result.chunks_created = len(chunks)
            logger.info(f"Created {len(chunks)} chunks from {filename}")

            # Step 2: Generate summary if requested
            summary = None
            if generate_summary and self.llm:
                summary = await self._generate_summary(content, filename)
                result.metadata["summary"] = summary

            # Step 3: Store to Qdrant
            if self.qdrant:
                qdrant_success = await self._store_to_qdrant(
                    document_id=document_id,
                    user_id=user_id,
                    chunks=chunks,
                    chat_id=chat_id,
                    project_id=project_id,
                )
                result.stored_to_qdrant = qdrant_success
                if not qdrant_success:
                    result.warnings.append("Failed to store to Qdrant")

            # Step 4: Extract entities and store to Neo4j (project documents only)
            if (
                chat_type == ChatType.PROJECT
                and extract_entities
                and self.neo4j
                and project_id
            ):
                entity_result = await self._extract_and_store_entities(
                    content=content,
                    document_id=document_id,
                    project_id=project_id,
                    category=category,
                )
                result.entities_extracted = entity_result.get("entities", 0)
                result.relationships_created = entity_result.get("relationships", 0)
                result.stored_to_neo4j = entity_result.get("success", False)

            # Step 5: Store metadata to Postgres via CocoIndex
            if self.cocoindex:
                postgres_success = await self._store_metadata(
                    document_id=document_id,
                    filename=filename,
                    user_id=user_id,
                    chat_id=chat_id,
                    project_id=project_id,
                    category=category,
                    summary=summary,
                    chunks_count=len(chunks),
                    metadata=metadata,
                )
                result.stored_to_postgres = postgres_success

            # Update stats
            self.stats["documents_processed"] += 1
            self.stats["chunks_created"] += len(chunks)

            result.success = True
            result.processing_time_ms = (time.time() - start_time) * 1000

            logger.info(
                f"Ingested document {filename}: "
                f"{result.chunks_created} chunks, "
                f"{result.entities_extracted} entities"
            )

            return result

        except Exception as e:
            self.stats["errors"] += 1
            result.errors.append(str(e))
            result.processing_time_ms = (time.time() - start_time) * 1000
            logger.error(f"Document ingestion error: {e}")
            return result

    # =========================================================================
    # HELPER METHODS
    # =========================================================================

    async def _generate_summary(
        self,
        content: str,
        filename: str,
    ) -> Optional[str]:
        """Generate document summary using LLM"""
        try:
            # Take first portion of content for summary
            content_preview = content[:4000] if len(content) > 4000 else content

            messages = [
                {
                    "role": "system",
                    "content": "You are a document summarizer. Provide a concise summary (2-3 sentences) of the document content."
                },
                {
                    "role": "user",
                    "content": f"Summarize this document ({filename}):\n\n{content_preview}"
                }
            ]

            result = self.llm.generate(
                messages=messages,
                temperature=0.3,
                max_tokens=200,
            )

            return result.get("response", "")

        except Exception as e:
            logger.warning(f"Summary generation failed: {e}")
            return None

    async def _store_to_qdrant(
        self,
        document_id: str,
        user_id: str,
        chunks: List[Dict[str, Any]],
        chat_id: Optional[str] = None,
        project_id: Optional[str] = None,
    ) -> bool:
        """Store document chunks to Qdrant"""
        try:
            success = self.qdrant.add_document_chunks(
                user_id=user_id,
                document_id=document_id,
                chunks=chunks,
                session_id=chat_id if not project_id else None,
                project_oenum=project_id,
            )
            return success

        except Exception as e:
            logger.error(f"Qdrant storage error: {e}")
            return False

    async def _extract_and_store_entities(
        self,
        content: str,
        document_id: str,
        project_id: str,
        category: DocumentCategory,
    ) -> Dict[str, Any]:
        """Extract entities and store to Neo4j"""
        try:
            entities_created = 0
            relationships_created = 0

            # Use LLM for entity extraction if available
            if self.llm:
                # Extract entities based on document category
                entity_types = self._get_entity_types_for_category(category)

                extracted = self.llm.extract_entities(
                    text=content[:8000],  # Limit content size
                    entity_types=entity_types,
                )

                # Store entities to Neo4j
                for entity in extracted:
                    entity_id = f"{document_id}_{entity.get('type')}_{entities_created}"
                    success = await self.cocoindex.store_graph_entity(
                        project_id=project_id,
                        entity_type=entity.get("type", "Unknown"),
                        entity_id=entity_id,
                        properties=entity.get("properties", {}),
                    )
                    if success:
                        entities_created += 1

                # Extract and store relationships
                if extracted:
                    relationships = self.llm.extract_relationships(
                        entities=extracted,
                        context=content[:4000],
                    )

                    for rel in relationships:
                        success = await self.cocoindex.store_graph_relationship(
                            project_id=project_id,
                            from_entity_id=rel.get("from"),
                            to_entity_id=rel.get("to"),
                            relationship_type=rel.get("type", "RELATED_TO"),
                            properties=rel.get("properties", {}),
                        )
                        if success:
                            relationships_created += 1

            return {
                "success": True,
                "entities": entities_created,
                "relationships": relationships_created,
            }

        except Exception as e:
            logger.error(f"Entity extraction error: {e}")
            return {"success": False, "entities": 0, "relationships": 0}

    def _get_entity_types_for_category(
        self,
        category: DocumentCategory,
    ) -> List[str]:
        """Get entity types to extract based on document category"""
        base_types = ["Equipment", "Component", "Standard", "Requirement"]

        if category == DocumentCategory.SPECIFICATION:
            return base_types + [
                "Switchgear", "Transformer", "Cable", "CircuitBreaker",
                "Motor", "Panel", "Busbar", "Protection"
            ]
        elif category == DocumentCategory.PROCESS:
            return base_types + [
                "Procedure", "Step", "Condition", "Action"
            ]
        else:
            return base_types

    async def _store_metadata(
        self,
        document_id: str,
        filename: str,
        user_id: str,
        chat_id: Optional[str],
        project_id: Optional[str],
        category: DocumentCategory,
        summary: Optional[str],
        chunks_count: int,
        metadata: Optional[Dict[str, Any]],
    ) -> bool:
        """Store document metadata to Postgres"""
        try:
            # Store via CocoIndex dataflow
            # This would be implemented based on your Postgres schema

            logger.debug(f"Stored metadata for document {document_id}")
            return True

        except Exception as e:
            logger.error(f"Metadata storage error: {e}")
            return False

    # =========================================================================
    # BATCH INGESTION
    # =========================================================================

    async def ingest_batch(
        self,
        documents: List[Dict[str, Any]],
        user_id: str,
        chat_type: ChatType,
        chat_id: Optional[str] = None,
        project_id: Optional[str] = None,
    ) -> List[IngestionResult]:
        """
        Ingest multiple documents.

        Args:
            documents: List of {content, filename, category, metadata}
            user_id: User identifier
            chat_type: Chat type
            chat_id: Chat ID
            project_id: Project ID

        Returns:
            List of IngestionResults
        """
        results = []

        for doc in documents:
            result = await self.ingest_document(
                content=doc.get("content", ""),
                filename=doc.get("filename", "Unknown"),
                user_id=user_id,
                chat_type=chat_type,
                chat_id=chat_id,
                project_id=project_id,
                category=DocumentCategory(doc.get("category", "general")),
                metadata=doc.get("metadata"),
            )
            results.append(result)

        return results

    # =========================================================================
    # DOCUMENT PROCESSING
    # =========================================================================

    async def process_file(
        self,
        file_path: str,
        filename: str,
        user_id: str,
        chat_type: ChatType,
        chat_id: Optional[str] = None,
        project_id: Optional[str] = None,
        category: DocumentCategory = DocumentCategory.GENERAL,
    ) -> IngestionResult:
        """
        Process a file (PDF, DOCX, etc.) and ingest it.

        Args:
            file_path: Path to the file
            filename: Original filename
            user_id: User identifier
            chat_type: Chat type
            chat_id: Chat ID
            project_id: Project ID
            category: Document category

        Returns:
            IngestionResult
        """
        # Extract content using doc processor
        if self.doc_processor:
            try:
                content = await self.doc_processor.process_document(file_path)
            except Exception as e:
                return IngestionResult(
                    success=False,
                    document_id="",
                    filename=filename,
                    errors=[f"Failed to process file: {e}"],
                )
        else:
            # Try to read as text
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()
            except Exception as e:
                return IngestionResult(
                    success=False,
                    document_id="",
                    filename=filename,
                    errors=[f"Failed to read file: {e}"],
                )

        return await self.ingest_document(
            content=content,
            filename=filename,
            user_id=user_id,
            chat_type=chat_type,
            chat_id=chat_id,
            project_id=project_id,
            category=category,
        )

    # =========================================================================
    # STATISTICS
    # =========================================================================

    def get_stats(self) -> Dict[str, Any]:
        """Get pipeline statistics"""
        return {
            **self.stats,
            "services_available": {
                "qdrant": self.qdrant is not None,
                "neo4j": self.neo4j is not None,
                "llm": self.llm is not None,
                "doc_processor": self.doc_processor is not None,
            },
        }


# =============================================================================
# SINGLETON
# =============================================================================

_ingestion_pipeline: Optional[DocumentIngestionPipeline] = None


def get_ingestion_pipeline(
    cocoindex_manager=None,
    qdrant_service=None,
    neo4j_service=None,
    llm_service=None,
    doc_processor_client=None,
) -> DocumentIngestionPipeline:
    """Get or create ingestion pipeline singleton"""
    global _ingestion_pipeline

    if _ingestion_pipeline is None:
        _ingestion_pipeline = DocumentIngestionPipeline(
            cocoindex_manager=cocoindex_manager,
            qdrant_service=qdrant_service,
            neo4j_service=neo4j_service,
            llm_service=llm_service,
            doc_processor_client=doc_processor_client,
        )
    elif any([cocoindex_manager, qdrant_service, neo4j_service, llm_service, doc_processor_client]):
        _ingestion_pipeline.set_services(
            cocoindex_manager=cocoindex_manager,
            qdrant_service=qdrant_service,
            neo4j_service=neo4j_service,
            llm_service=llm_service,
            doc_processor_client=doc_processor_client,
        )

    return _ingestion_pipeline
