"""
Documents and RAG Routes
=========================
API endpoints for document upload, classification, and RAG chat sessions.

Author: Simorgh Industrial Assistant
"""

from fastapi import APIRouter, File, UploadFile, Form, HTTPException, Depends, BackgroundTasks
from pydantic import BaseModel
from typing import Dict, Any, Optional, List
from pathlib import Path
import logging
import os
import uuid

from services.neo4j_service import Neo4jService, get_neo4j_service
from services.redis_service import RedisService, get_redis_service
from services.llm_service import LLMService, get_llm_service
from services.doc_processor_client import DocProcessorClient
from services.document_classifier import DocumentClassifier
from services.vector_rag import VectorRAG
from services.graph_rag import GraphRAG
from services.project_graph_init import ProjectGraphInitializer
from services.auth_utils import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["documents", "rag"])

# Configuration
UPLOAD_FOLDER = os.getenv("UPLOAD_DIR", "/app/uploads")
DOCS_FOLDER = os.path.join(UPLOAD_FOLDER, "docs")
Path(DOCS_FOLDER).mkdir(exist_ok=True, parents=True)


# =============================================================================
# PYDANTIC MODELS
# =============================================================================

class DocumentUploadResponse(BaseModel):
    """Document upload response"""
    success: bool
    doc_id: str
    filename: str
    doc_type: str
    category: str
    confidence: float
    chunks_indexed: Optional[int] = None
    message: str


class GeneralChatRequest(BaseModel):
    """General chat request with vector RAG"""
    user_id: str
    message: str
    session_id: Optional[str] = None
    top_k: int = 5
    llm_mode: Optional[str] = None


class ProjectChatRequest(BaseModel):
    """Project chat request with graph RAG"""
    user_id: str
    project_oenum: str
    message: str
    session_id: Optional[str] = None
    max_hops: int = 2
    use_hybrid: bool = False
    llm_mode: Optional[str] = None


class GraphInitRequest(BaseModel):
    """Project graph initialization request"""
    project_oenum: str
    project_name: str


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

async def process_and_index_document(
    file_path: Path,
    user_id: str,
    project_oenum: Optional[str],
    doc_processor: DocProcessorClient,
    classifier: DocumentClassifier,
    vector_rag: Optional[VectorRAG],
    graph_init: Optional[ProjectGraphInitializer],
    neo4j_service: Neo4jService
) -> Dict[str, Any]:
    """
    Process document and index based on type (general or project)
    """
    try:
        # 1. Process to markdown
        logger.info(f"📄 Processing document: {file_path.name}")
        result = await doc_processor.process_document(file_path, user_id)

        if not result.get('success'):
            raise Exception(f"Document processing failed: {result.get('error')}")

        markdown_content = result['content']
        output_path = result.get('output_path')

        # 2. Classify document
        logger.info(f"🔍 Classifying document: {file_path.name}")
        category, doc_type, confidence = classifier.classify(
            filename=file_path.name,
            content=markdown_content
        )

        doc_id = str(uuid.uuid4())

        # 3. Index based on type
        if project_oenum:
            # Project document - add to graph structure
            logger.info(f"📊 Adding to project graph: {project_oenum}")

            # Add document node to graph
            if graph_init:
                success = graph_init.add_document_to_structure(
                    project_oenum=project_oenum,
                    category=category,
                    doc_type=doc_type,
                    document_id=doc_id,
                    document_metadata={
                        'filename': file_path.name,
                        'doc_type': doc_type,
                        'category': category,
                        'confidence': confidence,
                        'markdown_path': output_path,
                        'uploaded_by': user_id
                    }
                )

                if not success:
                    logger.warning(f"⚠️ Failed to add document to graph structure")

            chunks_indexed = None

        else:
            # General document - index to Qdrant
            logger.info(f"📥 Indexing to Qdrant for user: {user_id}")

            if vector_rag:
                index_result = await vector_rag.index_document(
                    markdown_content=markdown_content,
                    user_id=user_id,
                    filename=file_path.name,
                    doc_id=doc_id
                )

                if not index_result.get('success'):
                    raise Exception(f"Vector indexing failed: {index_result.get('error')}")

                chunks_indexed = index_result.get('chunks_indexed')
            else:
                chunks_indexed = None

        return {
            "success": True,
            "doc_id": doc_id,
            "filename": file_path.name,
            "doc_type": doc_type,
            "category": category,
            "confidence": confidence,
            "chunks_indexed": chunks_indexed,
            "message": f"Document processed and indexed successfully"
        }

    except Exception as e:
        logger.error(f"❌ Document processing failed: {e}")
        return {
            "success": False,
            "error": str(e)
        }


# =============================================================================
# DOCUMENT UPLOAD ENDPOINTS
# =============================================================================

@router.post("/documents/upload", response_model=DocumentUploadResponse)
async def upload_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    user_id: str = Form(...),
    project_oenum: Optional[str] = Form(None),
    current_user: str = Depends(get_current_user),
    neo4j_service: Neo4jService = Depends(get_neo4j_service),
    redis_service: RedisService = Depends(get_redis_service)
):
    """
    Upload and process document

    - For general chats: Indexes to Qdrant vector store
    - For project chats: Adds to Neo4j project graph structure

    Args:
        file: Document file (PDF, image, Word, Excel, text)
        user_id: User ID
        project_oenum: Optional project OENUM (if project document)
    """
    # Security: Verify user_id matches authenticated user
    if user_id != current_user:
        raise HTTPException(
            status_code=403,
            detail="Cannot upload documents for another user"
        )

    try:
        # Save uploaded file temporarily
        temp_path = Path(DOCS_FOLDER) / "temp" / f"{uuid.uuid4()}_{file.filename}"
        temp_path.parent.mkdir(exist_ok=True, parents=True)

        with open(temp_path, 'wb') as f:
            content = await file.read()
            f.write(content)

        logger.info(f"📤 File uploaded: {file.filename} ({len(content)} bytes)")

        # Initialize services
        doc_processor = DocProcessorClient()
        classifier = DocumentClassifier()
        vector_rag = VectorRAG() if not project_oenum else None
        graph_init = ProjectGraphInitializer(neo4j_service.driver) if project_oenum and neo4j_service else None

        # Process and index
        result = await process_and_index_document(
            file_path=temp_path,
            user_id=user_id,
            project_oenum=project_oenum,
            doc_processor=doc_processor,
            classifier=classifier,
            vector_rag=vector_rag,
            graph_init=graph_init,
            neo4j_service=neo4j_service
        )

        # Clean up temp file in background
        background_tasks.add_task(os.remove, temp_path)

        if not result.get('success'):
            raise HTTPException(status_code=500, detail=result.get('error'))

        return DocumentUploadResponse(**result)

    except Exception as e:
        logger.error(f"❌ Upload failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# RAG CHAT ENDPOINTS
# =============================================================================

@router.post("/chat/general")
async def general_chat(
    request: GeneralChatRequest,
    current_user: str = Depends(get_current_user),
    redis_service: RedisService = Depends(get_redis_service),
    llm_service: LLMService = Depends(get_llm_service)
):
    """
    General chat with vector RAG (Qdrant)

    Uses semantic search to find relevant document chunks and generates response.
    """
    # Security: Verify user_id matches authenticated user
    if request.user_id != current_user:
        raise HTTPException(
            status_code=403,
            detail="Cannot chat as another user"
        )

    try:
        # Initialize vector RAG
        vector_rag = VectorRAG()

        # Search for relevant chunks
        logger.info(f"🔍 Searching for relevant chunks: {request.message[:50]}...")
        chunks = await vector_rag.search(
            query=request.message,
            user_id=request.user_id,
            top_k=request.top_k,
            score_threshold=0.7
        )

        # Build context from chunks
        context = ""
        if chunks:
            context = "\n\n## Relevant Information:\n\n"
            for idx, chunk in enumerate(chunks, 1):
                context += f"### Source {idx}: {chunk['filename']}"
                if chunk.get('header'):
                    context += f" - {chunk['header']}"
                context += f"\n{chunk['text']}\n\n"

        # Build LLM prompt
        system_prompt = """You are an expert industrial electrical engineer assistant specializing in electrical panels and power systems.
Provide accurate, technical responses based on the provided context and your knowledge of electrical engineering standards."""

        if context:
            system_prompt += f"\n\n{context}"

        llm_messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": request.message}
        ]

        # Generate response
        logger.info(f"💬 Generating response with {len(chunks)} context chunks")
        result = llm_service.generate(
            messages=llm_messages,
            mode=request.llm_mode,
            temperature=0.7,
            use_cache=True
        )

        return {
            "success": True,
            "response": result["response"],
            "chunks_used": len(chunks),
            "sources": [
                {
                    "filename": chunk['filename'],
                    "score": chunk['score'],
                    "header": chunk.get('header')
                }
                for chunk in chunks
            ],
            "mode": result.get('mode'),
            "tokens": result.get('tokens')
        }

    except Exception as e:
        logger.error(f"❌ General chat failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/chat/project")
async def project_chat(
    request: ProjectChatRequest,
    current_user: str = Depends(get_current_user),
    neo4j_service: Neo4jService = Depends(get_neo4j_service),
    llm_service: LLMService = Depends(get_llm_service)
):
    """
    Project chat with graph RAG (Neo4j)

    Uses knowledge graph traversal to find relevant project information.
    Optional hybrid mode combines graph + vector search.
    """
    # Security: Verify user_id matches authenticated user
    if request.user_id != current_user:
        raise HTTPException(
            status_code=403,
            detail="Cannot chat as another user"
        )

    try:
        # Initialize graph RAG
        graph_rag = GraphRAG(driver=neo4j_service.driver)

        # Get project context
        project = neo4j_service.get_project(request.project_oenum)
        project_context = f"{project.get('project_name', '')} - {project.get('client', '')}"

        # Perform graph RAG query
        logger.info(f"📊 Querying project graph: {request.project_oenum}")

        if request.use_hybrid:
            # Hybrid: Graph + Vector
            vector_rag = VectorRAG()
            vector_results = await vector_rag.search(
                query=request.message,
                user_id=request.user_id,
                top_k=5
            )

            result = await graph_rag.hybrid_search(
                project_oenum=request.project_oenum,
                user_query=request.message,
                vector_results=vector_results,
                project_context=project_context,
                max_hops=request.max_hops
            )
        else:
            # Graph only
            result = await graph_rag.query(
                project_oenum=request.project_oenum,
                user_query=request.message,
                project_context=project_context,
                max_hops=request.max_hops,
                use_llm_formatting=True
            )

        if not result.get('success'):
            raise Exception(result.get('error', 'Graph query failed'))

        context = result['context']

        # Build LLM prompt
        system_prompt = f"""You are an expert industrial electrical engineer assistant working on Project {request.project_oenum}.
Provide accurate, technical responses based on the project's knowledge graph and documents.

{context}
"""

        llm_messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": request.message}
        ]

        # Generate response
        logger.info(f"💬 Generating project response")
        llm_result = llm_service.generate(
            messages=llm_messages,
            mode=request.llm_mode,
            temperature=0.7,
            use_cache=True
        )

        return {
            "success": True,
            "response": llm_result["response"],
            "graph_stats": result.get('stats', {}),
            "mode": llm_result.get('mode'),
            "tokens": llm_result.get('tokens')
        }

    except Exception as e:
        logger.error(f"❌ Project chat failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# PROJECT GRAPH MANAGEMENT
# =============================================================================

@router.post("/projects/{oenum}/init-graph")
async def initialize_project_graph(
    oenum: str,
    request: GraphInitRequest,
    current_user: str = Depends(get_current_user),
    neo4j_service: Neo4jService = Depends(get_neo4j_service)
):
    """
    Initialize base graph structure for a project

    Creates hierarchical structure:
    - Document → Client/EKC categories
    - Drawing → LV/MV categories
    - Identity → OE_Revision
    """
    try:
        # Verify OENUM matches
        if oenum != request.project_oenum:
            raise HTTPException(status_code=400, detail="OENUM mismatch")

        # Initialize graph
        graph_init = ProjectGraphInitializer(neo4j_service.driver)

        # Check if already initialized
        if graph_init.check_project_initialized(oenum):
            logger.info(f"⚠️ Project {oenum} already initialized")
            return {
                "success": True,
                "message": "Project graph already initialized",
                "structure": graph_init.get_project_structure(oenum)
            }

        # Initialize structure
        logger.info(f"🏗️ Initializing graph structure for: {oenum}")
        stats = graph_init.initialize_project_structure(
            project_oenum=oenum,
            project_name=request.project_name
        )

        return {
            "success": True,
            "message": "Project graph initialized successfully",
            "stats": stats,
            "structure": graph_init.get_project_structure(oenum)
        }

    except Exception as e:
        logger.error(f"❌ Graph initialization failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/projects/{oenum}/graph-status")
async def get_project_graph_status(
    oenum: str,
    current_user: str = Depends(get_current_user),
    neo4j_service: Neo4jService = Depends(get_neo4j_service)
):
    """
    Get project graph initialization status and statistics
    """
    try:
        graph_init = ProjectGraphInitializer(neo4j_service.driver)

        structure = graph_init.get_project_structure(oenum)

        return {
            "success": True,
            "oenum": oenum,
            "initialized": structure.get('initialized', False),
            "structure": structure
        }

    except Exception as e:
        logger.error(f"❌ Failed to get graph status: {e}")
        raise HTTPException(status_code=500, detail=str(e))
