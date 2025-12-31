"""
Document Processing Integration
=================================
Integrates Qdrant vector storage, document chunking, and spec extraction
for the dual RAG system.

Author: Simorgh Industrial Assistant
"""

import logging
import os
from typing import Dict, Any, Optional
from datetime import datetime
import uuid

from services.qdrant_service import QdrantService
from services.document_chunker import DocumentChunker
from services.enhanced_spec_extractor import EnhancedSpecExtractor
from services.project_graph_init import ProjectGraphInitializer
from services.llm_service import LLMService
from services.redis_service import RedisService
from services.extraction_guides_data import get_all_extraction_guides
from services.section_retriever import SectionRetriever
from services.graph_builder import GraphBuilder
from services.guide_executor import GuideExecutor

# Import CocoIndex flows for proper entity extraction
from cocoindex_flows.spec_flow import SpecificationFlow, create_specification_flow
from cocoindex_flows.cocoindex_adapter import CoCoIndexAdapter

logger = logging.getLogger(__name__)


# Global Qdrant service instance
_qdrant_service = None


def get_qdrant_service(llm_service: Optional[LLMService] = None) -> QdrantService:
    """
    Get or initialize global Qdrant service instance

    Args:
        llm_service: Optional LLMService for LLM-based embeddings (recommended)

    Returns:
        QdrantService instance
    """
    global _qdrant_service

    if _qdrant_service is None:
        logger.info("🔄 Initializing Qdrant service...")
        _qdrant_service = QdrantService(
            qdrant_url=os.getenv("QDRANT_URL", "localhost"),
            qdrant_api_key=os.getenv("QDRANT_API_KEY"),
            embedding_model=os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2"),
            llm_service=llm_service  # ✅ Use LLM-based embeddings if provided
        )
        logger.info("✅ Qdrant service initialized")

    return _qdrant_service


def process_document_with_qdrant(
    markdown_content: str,
    project_number: str,
    document_id: str,
    filename: str
) -> Dict[str, Any]:
    """
    Chunk document and store in Qdrant

    Args:
        markdown_content: Document content in markdown
        project_number: Project OE number
        document_id: Unique document identifier
        filename: Original filename

    Returns:
        Result dictionary with success status and chunk count
    """
    try:
        logger.info(f"📄 Processing document for Qdrant: {filename}")

        # Initialize services
        qdrant = get_qdrant_service()
        chunker = DocumentChunker(
            max_chunk_size=1000,
            min_chunk_size=100,
            overlap_size=50
        )

        # Chunk the document
        chunks = chunker.chunk_markdown(
            markdown_content=markdown_content,
            document_id=document_id,
            filename=filename
        )

        # Get chunk statistics
        stats = chunker.get_chunk_statistics(chunks)
        logger.info(f"📊 Chunking stats: {stats}")

        # Store chunks in Qdrant
        success = qdrant.add_document_chunks(
            project_number=project_number,
            document_id=document_id,
            chunks=chunks
        )

        if success:
            return {
                "success": True,
                "chunks_count": len(chunks),
                "stats": stats,
                "message": f"Document chunked and stored: {len(chunks)} chunks"
            }
        else:
            return {
                "success": False,
                "error": "Failed to store chunks in Qdrant"
            }

    except Exception as e:
        logger.error(f"❌ Failed to process document with Qdrant: {e}")
        return {
            "success": False,
            "error": str(e)
        }


def process_enhanced_spec_extraction(
    task_id: str,
    document_id: str,
    project_number: str,
    markdown_content: str,
    filename: str,
    llm_mode: str,
    llm_service: LLMService,
    neo4j_driver,
    redis_service: RedisService
):
    """
    ENHANCED background task for spec extraction using NEW pipeline:

    NEW Pipeline Steps:
    1. Extract hierarchical sections from document
    2. Generate LLM summaries for each section (detect subjects/topics)
    3. Store in Qdrant (summaries for search, full sections for retrieval)
    4. Build knowledge graph using GraphBuilder (entity extraction)
    5. Execute extraction guides using GuideExecutor (semantic search + extraction)

    Graph Structure Created:
    Document → Equipment/System nodes (auto-extracted)
    Document → SpecCategory → SpecField → HAS_EXTRACTION_GUIDE → ExtractionGuide
                                        → HAS_VALUE → ActualValue (from guide execution)

    Args:
        task_id: Unique task identifier
        document_id: Document ID in Neo4j
        project_number: Project OE number
        markdown_content: Document content
        filename: Original filename
        llm_mode: LLM mode (online/offline)
        llm_service: LLM service instance
        neo4j_driver: Neo4j driver
        redis_service: Redis service
    """
    try:
        logger.info(f"🚀 [Task {task_id}] Starting ENHANCED spec extraction pipeline for {filename}")

        # STEP 1: Section extraction + summarization + Qdrant storage
        # First check if sections already exist (avoid double processing)
        qdrant = get_qdrant_service(llm_service=llm_service)
        section_retriever = SectionRetriever(
            llm_service=llm_service,
            qdrant_service=qdrant
        )

        # Check if document sections already exist in Qdrant
        existing_sections = section_retriever.retrieve_relevant_sections(
            project_number=project_number,
            query="document overview",
            limit=1,
            document_id=document_id
        )

        if existing_sections.get("success") and existing_sections.get("sections"):
            sections_count = len(existing_sections.get("sections", []))
            logger.info(f"📄 [Task {task_id}] Sections already exist for document {document_id}, skipping re-extraction")

            redis_service.set(
                f"spec_task:{task_id}:status",
                {
                    "task_id": task_id,
                    "status": "sections_cached",
                    "message": f"Using {sections_count} existing sections (already processed)",
                    "document_id": document_id,
                    "project_number": project_number,
                    "filename": filename,
                    "progress": 30
                },
                ttl=3600,
                db="cache"
            )
        else:
            # Sections don't exist, process document
            redis_service.set(
                f"spec_task:{task_id}:status",
                {
                    "task_id": task_id,
                    "status": "processing_sections",
                    "message": "Extracting sections and generating summaries...",
                    "document_id": document_id,
                    "project_number": project_number,
                    "filename": filename,
                    "progress": 10
                },
                ttl=3600,
                db="cache"
            )

            # Process document: Extract sections → Summarize → Store
            processing_result = section_retriever.process_and_store_document(
                markdown_content=markdown_content,
                project_number=project_number,
                document_id=document_id,
                filename=filename,
                document_type_hint="Specification Document",
                llm_mode=llm_mode
            )

            if not processing_result.get("success"):
                raise Exception(f"Section processing failed: {processing_result.get('error')}")

            sections_count = processing_result.get("sections_extracted", 0)
            logger.info(f"✅ [Task {task_id}] Processed {sections_count} sections with summaries")

        # STEP 2: Build knowledge graph (entity extraction)
        redis_service.set(
            f"spec_task:{task_id}:status",
            {
                "task_id": task_id,
                "status": "building_graph",
                "message": "Extracting entities and building knowledge graph...",
                "document_id": document_id,
                "project_number": project_number,
                "filename": filename,
                "progress": 40
            },
            ttl=3600,
            db="cache"
        )

        # Use CocoIndex SpecificationFlow for proper ITEM 1-13 extraction
        try:
            # Initialize CocoIndex adapter with the existing Neo4j driver
            cocoindex_adapter = CoCoIndexAdapter(driver=neo4j_driver)

            # Create SpecificationFlow with LLM service
            spec_flow = SpecificationFlow(
                cocoindex_adapter=cocoindex_adapter,
                llm_service=llm_service,
                qdrant_service=qdrant
            )

            # Process document with SpecificationFlow (extracts all 13 ITEM categories)
            flow_result = spec_flow.process_document(
                project_number=project_number,
                document_id=document_id,
                content=markdown_content,
                filename=filename,
                metadata={"filename": filename, "doc_type": "Spec"},
                llm_mode=llm_mode
            )

            if flow_result.get("success"):
                entities_extracted = {
                    "entities_count": flow_result.get("entities_extracted", 0),
                    "relationships_count": flow_result.get("relationships_extracted", 0),
                    "document_type": flow_result.get("document_type", "Specification")
                }
                logger.info(f"✅ [Task {task_id}] SpecificationFlow completed: {entities_extracted}")
            else:
                logger.warning(f"⚠️ [Task {task_id}] SpecificationFlow failed: {flow_result.get('error', 'Unknown error')}")
                entities_extracted = {"error": flow_result.get("error", "Flow failed")}

        except Exception as e:
            logger.error(f"❌ [Task {task_id}] SpecificationFlow error: {e}", exc_info=True)
            # Fallback to GraphBuilder if SpecificationFlow fails
            logger.info(f"🔄 [Task {task_id}] Falling back to GraphBuilder...")
            graph_builder = GraphBuilder(
                llm_service=llm_service,
                neo4j_driver=neo4j_driver
            )
            graph_result = graph_builder.build_graph_for_document(
                project_number=project_number,
                document_id=document_id,
                document_content=markdown_content,
                filename=filename,
                llm_mode=llm_mode
            )
            entities_extracted = graph_result.get("entities_extracted", {})

        # Update progress
        redis_service.set(
            f"spec_task:{task_id}:status",
            {
                "task_id": task_id,
                "status": "extracting_parameters",
                "message": "Extracting specification parameters...",
                "document_id": document_id,
                "project_number": project_number,
                "filename": filename,
                "progress": 75
            },
            ttl=3600,
            db="cache"
        )

        # Note: GuideExecutor is no longer needed - SpecificationFlow handles all extraction
        guide_results = {"successful_extractions": 0, "total_guides": 0}
        logger.info(f"✅ [Task {task_id}] Parameter extraction completed via SpecificationFlow")

        # STEP 4: Complete
        redis_service.set(
            f"spec_task:{task_id}:status",
            {
                "task_id": task_id,
                "status": "completed",
                "message": "Enhanced spec extraction completed successfully!",
                "document_id": document_id,
                "project_number": project_number,
                "filename": filename,
                "progress": 100,
                "completed_at": datetime.now().isoformat(),
                "metadata": {
                    "sections_processed": sections_count,
                    "entities_extracted": entities_extracted,
                    "guide_extractions": guide_results.get("successful_extractions", 0),
                    "total_guides": guide_results.get("total_guides", 0),
                    "method": "enhanced_pipeline_v2"
                },
                "review_url": f"/review-specs/{project_number}/{document_id}"
            },
            ttl=3600,
            db="cache"
        )

        logger.info(f"🎉 [Task {task_id}] ENHANCED spec extraction completed successfully")

    except Exception as e:
        logger.error(f"❌ [Task {task_id}] Enhanced spec extraction failed: {e}", exc_info=True)

        # Update status: failed
        redis_service.set(
            f"spec_task:{task_id}:status",
            {
                "task_id": task_id,
                "status": "failed",
                "message": f"Extraction failed: {str(e)}",
                "document_id": document_id,
                "project_number": project_number,
                "filename": filename,
                "progress": 0,
                "error": str(e),
                "failed_at": datetime.now().isoformat()
            },
            ttl=3600,
            db="cache"
        )


def semantic_search_in_project(
    project_number: str,
    query: str,
    limit: int = 5,
    document_id: Optional[str] = None
) -> Dict[str, Any]:
    """
    Perform semantic search in project's Qdrant collection

    Args:
        project_number: Project OE number
        query: Search query
        limit: Maximum results
        document_id: Optional document filter

    Returns:
        Search results with chunks and scores
    """
    try:
        qdrant = get_qdrant_service()

        results = qdrant.semantic_search(
            project_number=project_number,
            query=query,
            limit=limit,
            document_id=document_id,
            score_threshold=0.3
        )

        return {
            "success": True,
            "results": results,
            "count": len(results)
        }

    except Exception as e:
        logger.error(f"❌ Semantic search failed: {e}")
        return {
            "success": False,
            "error": str(e),
            "results": []
        }


def initialize_project_guides(
    project_number: str,
    neo4j_driver
) -> Dict[str, Any]:
    """
    Initialize extraction guides for a new project

    Args:
        project_number: Project OE number
        neo4j_driver: Neo4j driver instance

    Returns:
        Initialization statistics
    """
    try:
        logger.info(f"📚 Initializing extraction guides for project {project_number}")

        graph_init = ProjectGraphInitializer(neo4j_driver)
        all_guides = get_all_extraction_guides()

        stats = graph_init.initialize_all_extraction_guides(
            project_oenum=project_number,
            guides_data=all_guides
        )

        return {
            "success": True,
            "stats": stats
        }

    except Exception as e:
        logger.error(f"❌ Failed to initialize project guides: {e}")
        return {
            "success": False,
            "error": str(e)
        }
