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
from services.section_retriever import SectionRetriever
from services.document_overview_service import DocumentOverviewService
from services.graph_builder import GraphBuilder
from services.guide_executor import GuideExecutor
from services.qdrant_service import QdrantService
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
    """General chat request with vector RAG and session isolation"""
    user_id: str
    message: str
    session_id: str  # REQUIRED for session isolation
    top_k: int = 5
    llm_mode: Optional[str] = None
    use_conversation_memory: bool = True  # Enable past context retrieval


class ProjectChatRequest(BaseModel):
    """Project chat request with graph RAG and session isolation"""
    user_id: str
    project_oenum: str  # Acts as natural session boundary for projects
    message: str
    session_id: Optional[str] = None  # Optional: project_oenum is the session
    max_hops: int = 2
    use_hybrid: bool = False
    llm_mode: Optional[str] = None
    use_conversation_memory: bool = True  # Enable past context retrieval


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
    neo4j_service: Neo4jService,
    redis_service: Optional[RedisService] = None,
    llm_service: Optional[LLMService] = None,
    use_enhanced_pipeline: bool = True
) -> Dict[str, Any]:
    """
    ENHANCED: Process document with section extraction, summarization, and entity extraction

    Args:
        file_path: Path to document file
        user_id: User ID who uploaded the document
        project_oenum: Optional project number
        doc_processor: Document processor client
        classifier: Document classifier
        vector_rag: Optional vector RAG service (for fallback)
        graph_init: Optional graph initializer
        neo4j_service: Neo4j service
        redis_service: Optional Redis service (for enhanced pipeline)
        llm_service: Optional LLM service (for enhanced pipeline)
        use_enhanced_pipeline: If True, use section-based processing (default: True)

    Returns:
        Result dictionary with processing statistics
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
        chunks_indexed = 0

        # ============================================================
        # ✅ ENHANCED: Use Section-based Processing
        # ============================================================
        if use_enhanced_pipeline and llm_service and redis_service:
            logger.info(f"🚀 Starting ENHANCED document processing pipeline")

            try:
                # Initialize enhanced services with LLM-based embeddings
                qdrant = QdrantService(llm_service=llm_service)
                section_retriever = SectionRetriever(
                    llm_service=llm_service,
                    qdrant_service=qdrant
                )
                doc_overview = DocumentOverviewService(redis_service=redis_service)

                # Extract sections + generate summaries + store in Qdrant
                processing_result = section_retriever.process_and_store_document(
                    markdown_content=markdown_content,
                    project_number=project_oenum or "general",
                    document_id=doc_id,
                    filename=file_path.name,
                    document_type_hint=f"{doc_type} Document",
                    llm_mode="offline"  # Use local LLM by default
                )

                if processing_result.get("success"):
                    chunks_indexed = processing_result.get("sections_extracted", 0)
                    logger.info(f"✅ Enhanced processing complete: {chunks_indexed} sections")

                    # Track document in overview
                    summary_stats = processing_result.get("summary_stats", {})
                    doc_overview.add_document(
                        document_id=doc_id,
                        filename=file_path.name,
                        document_type=doc_type,
                        category=category,
                        key_topics=summary_stats.get("total_subjects", 0),
                        sections_count=chunks_indexed,
                        total_chars=len(markdown_content),
                        project_number=project_oenum,
                        user_id=user_id
                    )
                else:
                    logger.warning(f"⚠️ Enhanced processing failed: {processing_result.get('error')}")
                    raise Exception("Enhanced processing failed, falling back to basic indexing")

            except Exception as enhanced_error:
                logger.warning(f"⚠️ Enhanced pipeline error: {enhanced_error}, falling back to basic indexing")
                use_enhanced_pipeline = False

        # ============================================================
        # Fallback to Basic Indexing (if enhanced disabled or failed)
        # ============================================================
        if not use_enhanced_pipeline:
            if vector_rag and not project_oenum:
                logger.info(f"📥 Using BASIC indexing to Qdrant")
                index_result = await vector_rag.index_document(
                    markdown_content=markdown_content,
                    user_id=user_id,
                    filename=file_path.name,
                    doc_id=doc_id
                )

                if index_result.get('success'):
                    chunks_indexed = index_result.get('chunks_indexed', 0)
                else:
                    logger.warning(f"⚠️ Vector indexing failed: {index_result.get('error')}")

        # 3. Add to graph structure if project document
        if project_oenum and graph_init:
            logger.info(f"📊 Adding to project graph: {project_oenum}")

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
                    'uploaded_by': user_id,
                    'sections_extracted': chunks_indexed
                }
            )

            if not success:
                logger.warning(f"⚠️ Failed to add document to graph structure")

            # ============================================================
            # ✅ ENHANCED: Extract entities for technical documents
            # ============================================================
            if use_enhanced_pipeline and doc_type in ["Spec", "Drawing", "Technical"]:
                logger.info(f"🔍 Extracting entities from {doc_type} document")

                try:
                    graph_builder = GraphBuilder(neo4j_service.driver)
                    entity_result = graph_builder.extract_entities_from_spec(
                        project_oenum=project_oenum,
                        document_id=doc_id,
                        spec_content=markdown_content,
                        filename=file_path.name,
                        llm_mode="offline"
                    )

                    if entity_result.get("success"):
                        entities_count = len(entity_result.get('entities', []))
                        logger.info(f"✅ Extracted {entities_count} entities")
                except Exception as e:
                    logger.warning(f"⚠️ Entity extraction failed: {e}")

                # ✅ ENHANCED: Execute extraction guides for Spec documents
                if use_enhanced_pipeline and doc_type == "Spec" and category == "Client" and llm_service:
                    logger.info(f"📋 Executing extraction guides for spec document")

                    try:
                        qdrant = QdrantService(llm_service=llm_service)
                        guide_executor = GuideExecutor(
                            neo4j_driver=neo4j_service.driver,
                            qdrant_service=qdrant,
                            llm_service=llm_service
                        )

                        guide_result = guide_executor.execute_all_guides(
                            project_number=project_oenum,
                            document_id=doc_id,
                            llm_mode="offline"
                        )

                        if guide_result.get("success"):
                            extracted_count = guide_result.get('extracted_count', 0)
                            logger.info(f"✅ Extracted {extracted_count} spec values using guides")
                    except Exception as e:
                        logger.warning(f"⚠️ Guide execution failed: {e}")

        return {
            "success": True,
            "doc_id": doc_id,
            "filename": file_path.name,
            "doc_type": doc_type,
            "category": category,
            "confidence": confidence,
            "chunks_indexed": chunks_indexed,
            "processing_method": "enhanced" if use_enhanced_pipeline else "basic",
            "message": f"Document processed with {'enhanced' if use_enhanced_pipeline else 'basic'} pipeline"
        }

    except Exception as e:
        logger.error(f"❌ Document processing failed: {e}", exc_info=True)
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
    redis_service: RedisService = Depends(get_redis_service),
    llm_service: LLMService = Depends(get_llm_service)
):
    """
    ENHANCED: Upload and process document with section-based extraction

    - For general chats: Indexes to Qdrant with section summaries
    - For project chats: Adds to Neo4j + extracts entities + runs extraction guides

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
        vector_rag = VectorRAG(llm_service=llm_service) if not project_oenum else None
        graph_init = ProjectGraphInitializer(neo4j_service.driver) if project_oenum and neo4j_service else None

        # ✅ ENHANCED: Process with enhanced pipeline (section extraction, entities, guides)
        result = await process_and_index_document(
            file_path=temp_path,
            user_id=user_id,
            project_oenum=project_oenum,
            doc_processor=doc_processor,
            classifier=classifier,
            vector_rag=vector_rag,
            graph_init=graph_init,
            neo4j_service=neo4j_service,
            redis_service=redis_service,  # ✅ ADD
            llm_service=llm_service,      # ✅ ADD
            use_enhanced_pipeline=True    # ✅ ADD
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
    llm_service: LLMService = Depends(get_llm_service),
    neo4j_service: Neo4jService = Depends(get_neo4j_service)
):
    """
    General chat with vector RAG (Qdrant) + Session Isolation + Conversation Memory

    NEW FEATURES:
    - Session-specific document isolation (no cross-session leakage)
    - LLM-powered conversation memory with semantic retrieval
    - Past context included in responses for continuity
    """
    # Security: Verify user_id matches authenticated user
    if request.user_id != current_user:
        raise HTTPException(
            status_code=403,
            detail="Cannot chat as another user"
        )

    try:
        # ✅ Initialize session-isolated services
        from services.qdrant_service import QdrantService
        from services.conversation_memory import ConversationMemoryService

        # Initialize Qdrant with session isolation
        qdrant_service = QdrantService(llm_service=llm_service)

        # Initialize conversation memory service
        conv_memory = ConversationMemoryService(
            qdrant_service=qdrant_service,
            llm_service=llm_service
        )

        logger.info(f"💬 General chat - User: {request.user_id}, Session: {request.session_id}")

        # ✅ STEP 1: Retrieve past conversation context (if enabled)
        past_context = ""
        if request.use_conversation_memory:
            logger.info(f"📚 Retrieving past conversation context...")
            relevant_conversations = conv_memory.retrieve_relevant_context(
                user_id=request.user_id,
                current_query=request.message,
                session_id=request.session_id,
                top_k=5,
                score_threshold=0.6
            )

            if relevant_conversations:
                past_context = conv_memory.format_context_for_llm(relevant_conversations)
                logger.info(f"✅ Retrieved {len(relevant_conversations)} past conversations")

        # ✅ STEP 2: Search for relevant document chunks (session-isolated)
        logger.info(f"🔍 Searching session-specific documents...")
        results = qdrant_service.semantic_search(
            user_id=request.user_id,
            query=request.message,
            limit=request.top_k,
            score_threshold=0.7,
            session_id=request.session_id
        )

        # Build document context
        doc_context = ""
        if results:
            doc_context = "\n\n## Relevant Documents from This Session:\n\n"
            for idx, result in enumerate(results, 1):
                doc_context += f"### Source {idx} (Score: {result['score']:.2f})\n"
                doc_context += f"{result['text']}\n\n"

        # ✅ STEP 3: Build comprehensive LLM prompt
        system_prompt = """You are Simorgh, an expert industrial electrical engineer assistant specializing in electrical panels and power systems.

Provide accurate, technical responses based on:
1. Past conversation context (if provided)
2. Relevant documents from this session
3. Your expertise in electrical engineering standards

Be conversational and maintain context from past discussions."""

        # Add past conversation context
        if past_context:
            system_prompt += f"\n\n{past_context}"

        # Add document context
        if doc_context:
            system_prompt += f"\n\n{doc_context}"

        llm_messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": request.message}
        ]

        # ✅ STEP 4: Generate response
        logger.info(f"🤖 Generating response with {len(results)} docs + {len(relevant_conversations) if request.use_conversation_memory else 0} past convs")
        result = llm_service.generate(
            messages=llm_messages,
            mode=request.llm_mode,
            temperature=0.7,
            use_cache=False  # Don't cache - each session is unique
        )

        ai_response = result["response"]

        # ✅ STEP 5: Store conversation in memory (background)
        if request.use_conversation_memory:
            logger.info(f"💾 Storing conversation in session memory...")
            conv_memory.store_conversation(
                user_id=request.user_id,
                user_message=request.message,
                ai_response=ai_response,
                session_id=request.session_id,
                metadata={
                    "chunks_used": len(results),
                    "mode": result.get("mode"),
                    "tokens": result.get("tokens")
                }
            )

        return {
            "success": True,
            "response": ai_response,
            "session_id": request.session_id,
            "chunks_used": len(results),
            "past_conversations_used": len(relevant_conversations) if request.use_conversation_memory else 0,
            "sources": [
                {
                    "text_preview": result['text'][:100],
                    "score": result['score'],
                    "section_title": result.get('section_title', '')
                }
                for result in results
            ],
            "mode": result.get('mode'),
            "tokens": result.get('tokens')
        }

    except Exception as e:
        logger.error(f"❌ General chat failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/chat/project")
async def project_chat(
    request: ProjectChatRequest,
    current_user: str = Depends(get_current_user),
    neo4j_service: Neo4jService = Depends(get_neo4j_service),
    llm_service: LLMService = Depends(get_llm_service),
    redis_service: RedisService = Depends(get_redis_service)
):
    """
    Project chat with graph RAG (Neo4j) + Session Isolation + Conversation Memory

    NEW FEATURES:
    - Project-specific session isolation (project_oenum as session boundary)
    - LLM-powered conversation memory with semantic retrieval
    - Past context included for project continuity
    - Hybrid graph + vector search with session isolation
    """
    # Security: Verify user_id matches authenticated user
    if request.user_id != current_user:
        raise HTTPException(
            status_code=403,
            detail="Cannot chat as another user"
        )

    try:
        # ✅ Initialize session-isolated services
        from services.qdrant_service import QdrantService
        from services.conversation_memory import ConversationMemoryService

        # Initialize Qdrant with session isolation
        qdrant_service = QdrantService(llm_service=llm_service)

        # Initialize conversation memory service
        conv_memory = ConversationMemoryService(
            qdrant_service=qdrant_service,
            llm_service=llm_service
        )

        logger.info(f"📊 Project chat - User: {request.user_id}, Project: {request.project_oenum}")

        # ✅ STEP 1: Retrieve past conversation context (if enabled)
        past_context = ""
        relevant_conversations = []
        if request.use_conversation_memory:
            logger.info(f"📚 Retrieving past project conversation context...")
            relevant_conversations = conv_memory.retrieve_relevant_context(
                user_id=request.user_id,
                current_query=request.message,
                project_oenum=request.project_oenum,
                top_k=5,
                score_threshold=0.6
            )

            if relevant_conversations:
                past_context = conv_memory.format_context_for_llm(relevant_conversations)
                logger.info(f"✅ Retrieved {len(relevant_conversations)} past project conversations")

        # ✅ STEP 2: Query project graph
        graph_rag = GraphRAG(driver=neo4j_service.driver)

        # Get project context
        project = neo4j_service.get_project(request.project_oenum)
        project_context = f"{project.get('project_name', '')} - {project.get('client', '')}"

        logger.info(f"📊 Querying project graph: {request.project_oenum}")

        if request.use_hybrid:
            # Hybrid: Graph + Vector with SESSION ISOLATION
            logger.info(f"🔀 Using hybrid mode with session-isolated vector search")

            # Search only in project-specific collection
            vector_results = qdrant_service.semantic_search(
                user_id=request.user_id,
                query=request.message,
                limit=5,
                score_threshold=0.7,
                project_oenum=request.project_oenum  # ✅ Project session isolation
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

        graph_context = result['context']

        # ✅ STEP 3: Build comprehensive LLM prompt
        system_prompt = f"""You are Simorgh, an expert industrial electrical engineer assistant working on Project {request.project_oenum}.

Project: {project_context}

Provide accurate, technical responses based on:
1. Past conversation context from this project (if provided)
2. The project's knowledge graph and documents
3. Your expertise in electrical engineering standards

Be conversational and maintain context from past project discussions."""

        # Add past conversation context
        if past_context:
            system_prompt += f"\n\n{past_context}"

        # Add graph context
        if graph_context:
            system_prompt += f"\n\n{graph_context}"

        llm_messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": request.message}
        ]

        # ✅ STEP 4: Generate response
        logger.info(f"🤖 Generating project response with graph context + {len(relevant_conversations)} past convs")
        llm_result = llm_service.generate(
            messages=llm_messages,
            mode=request.llm_mode,
            temperature=0.7,
            use_cache=False  # Don't cache - each project session is unique
        )

        ai_response = llm_result["response"]

        # ✅ STEP 5: Store conversation in project memory (background)
        if request.use_conversation_memory:
            logger.info(f"💾 Storing conversation in project memory...")
            conv_memory.store_conversation(
                user_id=request.user_id,
                user_message=request.message,
                ai_response=ai_response,
                project_oenum=request.project_oenum,
                metadata={
                    "graph_stats": result.get('stats', {}),
                    "mode": llm_result.get("mode"),
                    "tokens": llm_result.get("tokens")
                }
            )

        return {
            "success": True,
            "response": ai_response,
            "project_oenum": request.project_oenum,
            "past_conversations_used": len(relevant_conversations),
            "graph_stats": result.get('stats', {}),
            "mode": llm_result.get('mode'),
            "tokens": llm_result.get('tokens')
        }

    except Exception as e:
        logger.error(f"❌ Project chat failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# SESSION MANAGEMENT
# =============================================================================

@router.delete("/sessions/{session_id}")
async def delete_session(
    session_id: str,
    user_id: str,
    current_user: str = Depends(get_current_user),
    neo4j_service: Neo4jService = Depends(get_neo4j_service),
    redis_service: RedisService = Depends(get_redis_service),
    llm_service: LLMService = Depends(get_llm_service)
):
    """
    Delete a general chat session completely (cascade deletion)

    Removes ALL data:
    - Qdrant collection (documents + conversation memory)
    - File storage
    - Redis cache
    """
    # Security: Verify user_id matches authenticated user
    if user_id != current_user:
        raise HTTPException(
            status_code=403,
            detail="Cannot delete another user's session"
        )

    try:
        from services.session_manager import SessionManager
        from services.qdrant_service import QdrantService

        # Initialize services
        qdrant_service = QdrantService(llm_service=llm_service)

        session_manager = SessionManager(
            qdrant_service=qdrant_service,
            neo4j_driver=neo4j_service.driver,
            redis_service=redis_service
        )

        # Delete session completely
        logger.info(f"🗑️ Deleting session {session_id} for user {user_id}")
        result = session_manager.delete_session_completely(
            user_id=user_id,
            session_id=session_id
        )

        return {
            "success": result["success"],
            "session_id": session_id,
            "user_id": user_id,
            "deletion_stats": result
        }

    except Exception as e:
        logger.error(f"❌ Session deletion failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/projects/{project_oenum}/session")
async def delete_project_session(
    project_oenum: str,
    user_id: str,
    current_user: str = Depends(get_current_user),
    neo4j_service: Neo4jService = Depends(get_neo4j_service),
    redis_service: RedisService = Depends(get_redis_service),
    llm_service: LLMService = Depends(get_llm_service)
):
    """
    Delete a project session completely (cascade deletion)

    Removes ALL data:
    - Qdrant collection (documents + conversation memory)
    - Neo4j graph (project nodes, documents, guides, values)
    - File storage
    - Redis cache
    """
    # Security: Verify user_id matches authenticated user
    if user_id != current_user:
        raise HTTPException(
            status_code=403,
            detail="Cannot delete another user's project session"
        )

    try:
        from services.session_manager import SessionManager
        from services.qdrant_service import QdrantService

        # Initialize services
        qdrant_service = QdrantService(llm_service=llm_service)

        session_manager = SessionManager(
            qdrant_service=qdrant_service,
            neo4j_driver=neo4j_service.driver,
            redis_service=redis_service
        )

        # Delete project session completely
        logger.info(f"🗑️ Deleting project session {project_oenum} for user {user_id}")
        result = session_manager.delete_session_completely(
            user_id=user_id,
            project_oenum=project_oenum
        )

        return {
            "success": result["success"],
            "project_oenum": project_oenum,
            "user_id": user_id,
            "deletion_stats": result
        }

    except Exception as e:
        logger.error(f"❌ Project session deletion failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/users/{user_id}/sessions")
async def list_user_sessions(
    user_id: str,
    current_user: str = Depends(get_current_user),
    llm_service: LLMService = Depends(get_llm_service)
):
    """
    List all sessions for a user (general + project sessions)
    """
    # Security: Verify user_id matches authenticated user
    if user_id != current_user:
        raise HTTPException(
            status_code=403,
            detail="Cannot list another user's sessions"
        )

    try:
        from services.session_manager import SessionManager
        from services.qdrant_service import QdrantService

        # Initialize services
        qdrant_service = QdrantService(llm_service=llm_service)

        session_manager = SessionManager(
            qdrant_service=qdrant_service
        )

        # List sessions
        result = session_manager.list_user_sessions(user_id=user_id)

        return {
            "success": True,
            "user_id": user_id,
            "sessions": result
        }

    except Exception as e:
        logger.error(f"❌ Failed to list user sessions: {e}", exc_info=True)
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
