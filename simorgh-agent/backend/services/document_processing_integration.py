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

logger = logging.getLogger(__name__)


# Global Qdrant service instance
_qdrant_service = None


def get_qdrant_service() -> QdrantService:
    """
    Get or initialize global Qdrant service instance

    Returns:
        QdrantService instance
    """
    global _qdrant_service

    if _qdrant_service is None:
        logger.info("🔄 Initializing Qdrant service...")
        _qdrant_service = QdrantService(
            qdrant_url=os.getenv("QDRANT_URL", "localhost"),
            qdrant_api_key=os.getenv("QDRANT_API_KEY"),
            embedding_model=os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
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
    Enhanced background task for spec extraction using two-stage RAG

    Steps:
    1. Chunk document and store in Qdrant
    2. Initialize extraction guides in Neo4j (if not already done)
    3. Extract specs using enhanced RAG (Qdrant + guides)
    4. Store results in Neo4j
    5. Link extraction guides to document fields

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
        logger.info(f"🚀 [Task {task_id}] Starting enhanced spec extraction for {filename}")

        # STEP 1: Chunk and store in Qdrant
        redis_service.set(
            f"spec_task:{task_id}:status",
            {
                "task_id": task_id,
                "status": "chunking",
                "message": "Chunking document and creating vector embeddings...",
                "document_id": document_id,
                "project_number": project_number,
                "filename": filename,
                "progress": 10
            },
            ttl=3600,
            db="cache"
        )

        chunk_result = process_document_with_qdrant(
            markdown_content=markdown_content,
            project_number=project_number,
            document_id=document_id,
            filename=filename
        )

        if not chunk_result["success"]:
            logger.warning(f"⚠️ [Task {task_id}] Qdrant chunking failed, continuing with fallback")

        chunks_count = chunk_result.get("chunks_count", 0)
        logger.info(f"✅ [Task {task_id}] Document chunked: {chunks_count} chunks")

        # STEP 2: Initialize extraction guides (if not done)
        redis_service.set(
            f"spec_task:{task_id}:status",
            {
                "task_id": task_id,
                "status": "initializing_guides",
                "message": "Initializing extraction guides...",
                "document_id": document_id,
                "project_number": project_number,
                "filename": filename,
                "progress": 20
            },
            ttl=3600,
            db="cache"
        )

        graph_init = ProjectGraphInitializer(neo4j_driver)

        # Initialize extraction guides for the project
        all_guides = get_all_extraction_guides()
        guides_stats = graph_init.initialize_all_extraction_guides(
            project_oenum=project_number,
            guides_data=all_guides
        )

        logger.info(f"✅ [Task {task_id}] Extraction guides initialized: {guides_stats}")

        # STEP 3: Extract specifications using enhanced RAG
        redis_service.set(
            f"spec_task:{task_id}:status",
            {
                "task_id": task_id,
                "status": "extracting",
                "message": "Extracting specifications using AI with semantic search...",
                "document_id": document_id,
                "project_number": project_number,
                "filename": filename,
                "progress": 40
            },
            ttl=3600,
            db="cache"
        )

        # Use enhanced extractor
        qdrant = get_qdrant_service()
        enhanced_extractor = EnhancedSpecExtractor(
            llm_service=llm_service,
            qdrant_service=qdrant,
            graph_initializer=graph_init
        )

        # Try enhanced extraction with fallback
        specifications = enhanced_extractor.extract_with_fallback(
            project_number=project_number,
            document_id=document_id,
            markdown_content=markdown_content,
            filename=filename,
            llm_mode=llm_mode
        )

        logger.info(f"✅ [Task {task_id}] Extraction complete - {len(specifications)} categories")

        # STEP 4: Create spec structure in Neo4j
        redis_service.set(
            f"spec_task:{task_id}:status",
            {
                "task_id": task_id,
                "status": "building_graph",
                "message": "Creating specification structure in knowledge graph...",
                "document_id": document_id,
                "project_number": project_number,
                "filename": filename,
                "progress": 75
            },
            ttl=3600,
            db="cache"
        )

        success = graph_init.add_spec_structure_to_document(
            project_oenum=project_number,
            document_id=document_id,
            specifications=specifications
        )

        if not success:
            raise Exception("Failed to create spec structure in graph")

        logger.info(f"✅ [Task {task_id}] Graph structure created")

        # STEP 5: Link extraction guides to document fields
        redis_service.set(
            f"spec_task:{task_id}:status",
            {
                "task_id": task_id,
                "status": "linking_guides",
                "message": "Linking extraction guides to specification fields...",
                "document_id": document_id,
                "project_number": project_number,
                "filename": filename,
                "progress": 90
            },
            ttl=3600,
            db="cache"
        )

        links_created = graph_init.link_extraction_guides_to_document(
            project_oenum=project_number,
            document_id=document_id
        )

        logger.info(f"✅ [Task {task_id}] Linked {links_created} extraction guides")

        # STEP 6: Complete
        redis_service.set(
            f"spec_task:{task_id}:status",
            {
                "task_id": task_id,
                "status": "completed",
                "message": "Specifications extracted successfully! Ready for review.",
                "document_id": document_id,
                "project_number": project_number,
                "filename": filename,
                "progress": 100,
                "completed_at": datetime.now().isoformat(),
                "metadata": {
                    "categories_extracted": len(specifications),
                    "chunks_created": chunks_count,
                    "extraction_guides_linked": links_created,
                    "method": "enhanced_rag"
                },
                "review_url": f"/review-specs/{project_number}/{document_id}"
            },
            ttl=3600,
            db="cache"
        )

        logger.info(f"🎉 [Task {task_id}] Enhanced spec extraction completed successfully")

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
