"""
Document Intelligence API
==========================
Endpoints for NotebookLM-like features:
- Grounded responses with citations
- Document summaries
- Multi-document synthesis
- Study guides
- Audio summaries

Author: Simorgh Industrial Assistant
"""

import logging
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Depends, BackgroundTasks
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from pathlib import Path

from services.auth_utils import get_current_user
from services.redis_service import get_redis_service, RedisService
from services.llm_service import get_llm_service, LLMService
from services.qdrant_service import get_qdrant_service
from services.neo4j_service import get_neo4j_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/documents", tags=["Document Intelligence"])


# =============================================================================
# REQUEST/RESPONSE MODELS
# =============================================================================

class GroundedQueryRequest(BaseModel):
    """Request for grounded response"""
    query: str = Field(..., description="User's question")
    project_number: Optional[str] = Field(None, description="Project OENUM")
    chat_id: Optional[str] = Field(None, description="Chat ID for general chats")
    max_sources: int = Field(5, ge=1, le=10, description="Max sources to retrieve")
    llm_mode: Optional[str] = Field(None, description="LLM mode (online/offline)")


class CitationResponse(BaseModel):
    """Citation reference"""
    id: int
    section_title: str
    document_name: str
    page_number: Optional[int]
    quoted_text: str
    relevance_score: float


class GroundedResponse(BaseModel):
    """Grounded response with citations"""
    response: str
    citations: List[CitationResponse]
    sources_panel: Optional[str]
    is_grounded: bool
    confidence_score: float
    sources_used: int
    processing_time_ms: float


class SummaryRequest(BaseModel):
    """Request for document summary"""
    document_name: Optional[str] = Field(None, description="Specific document to summarize")
    project_number: Optional[str] = Field(None, description="Project OENUM")
    chat_id: Optional[str] = Field(None, description="Chat ID")
    force_regenerate: bool = Field(False, description="Bypass cache")


class DocumentSummaryResponse(BaseModel):
    """Document summary response"""
    document_name: str
    summary: str
    key_topics: List[str]
    key_entities: List[str]
    section_count: int
    word_count: int
    suggested_questions: List[str]


class SynthesisRequest(BaseModel):
    """Request for multi-document synthesis"""
    project_number: Optional[str] = None
    chat_id: Optional[str] = None
    force_regenerate: bool = False


class MultiDocSynthesisResponse(BaseModel):
    """Multi-document synthesis response"""
    overview: str
    document_count: int
    common_themes: List[str]
    connections: List[dict]
    knowledge_gaps: List[str]
    faq: List[dict]
    suggested_questions: List[str]


class StudyGuideRequest(BaseModel):
    """Request for study guide"""
    project_number: Optional[str] = None
    chat_id: Optional[str] = None
    focus_topics: Optional[List[str]] = None


class StudyGuideResponse(BaseModel):
    """Study guide response"""
    title: str
    overview: str
    key_concepts: List[dict]
    important_facts: List[str]
    review_questions: List[dict]
    summary_notes: str


class AudioRequest(BaseModel):
    """Request for audio summary"""
    project_number: Optional[str] = None
    chat_id: Optional[str] = None
    text: Optional[str] = Field(None, description="Custom text to convert")
    voice: Optional[str] = None
    language: str = "en"


class AudioResponse(BaseModel):
    """Audio summary response"""
    audio_url: str
    duration_seconds: float
    provider: str
    voice: str
    cached: bool


class PodcastRequest(BaseModel):
    """Request for podcast-style audio"""
    project_number: Optional[str] = None
    chat_id: Optional[str] = None
    style: str = Field("conversational", description="conversational, professional, casual")
    duration_target: int = Field(120, ge=30, le=600, description="Target duration in seconds")


class PodcastResponse(BaseModel):
    """Podcast response"""
    audio_url: str
    duration_seconds: float
    transcript: str
    segment_count: int


# =============================================================================
# GROUNDED RESPONSE ENDPOINT
# =============================================================================

@router.post("/query/grounded", response_model=GroundedResponse)
async def grounded_query(
    request: GroundedQueryRequest,
    current_user: str = Depends(get_current_user),
    redis: RedisService = Depends(get_redis_service),
    llm: LLMService = Depends(get_llm_service)
):
    """
    Get a grounded response with citations.

    The response is strictly based on uploaded documents.
    Each claim includes a citation reference.
    """
    try:
        from services.grounded_response_service import get_grounded_response_service

        qdrant = get_qdrant_service()

        service = get_grounded_response_service(
            llm_service=llm,
            qdrant_service=qdrant
        )

        result = await service.generate_grounded_response(
            query=request.query,
            project_number=request.project_number,
            chat_id=request.chat_id,
            user_id=current_user,
            max_sources=request.max_sources,
            llm_mode=request.llm_mode
        )

        formatted = service.format_response_with_citations(result)

        return GroundedResponse(
            response=formatted["response"],
            citations=[CitationResponse(**c) for c in formatted["citations"]],
            sources_panel=formatted.get("sources_panel"),
            is_grounded=formatted["metadata"]["is_grounded"],
            confidence_score=formatted["metadata"]["confidence_score"],
            sources_used=formatted["metadata"]["sources_used"],
            processing_time_ms=formatted["metadata"]["processing_time_ms"]
        )

    except Exception as e:
        logger.error(f"Grounded query failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# DOCUMENT SUMMARY ENDPOINTS
# =============================================================================

@router.post("/summary", response_model=DocumentSummaryResponse)
async def get_document_summary(
    request: SummaryRequest,
    current_user: str = Depends(get_current_user),
    redis: RedisService = Depends(get_redis_service),
    llm: LLMService = Depends(get_llm_service)
):
    """
    Generate or retrieve a document summary.

    If document_name is not specified, summarizes all documents.
    """
    try:
        from services.document_synthesis_service import get_document_synthesis_service

        qdrant = get_qdrant_service()

        service = get_document_synthesis_service(
            llm_service=llm,
            qdrant_service=qdrant,
            redis_service=redis
        )

        summary = await service.generate_document_summary(
            document_name=request.document_name,
            project_number=request.project_number,
            chat_id=request.chat_id,
            force_regenerate=request.force_regenerate
        )

        if not summary:
            raise HTTPException(status_code=404, detail="Document not found or summary generation failed")

        return DocumentSummaryResponse(
            document_name=summary.document_name,
            summary=summary.summary,
            key_topics=summary.key_topics,
            key_entities=summary.key_entities,
            section_count=summary.section_count,
            word_count=summary.word_count,
            suggested_questions=summary.suggested_questions
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Document summary failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/synthesis", response_model=MultiDocSynthesisResponse)
async def get_multi_doc_synthesis(
    request: SynthesisRequest,
    current_user: str = Depends(get_current_user),
    redis: RedisService = Depends(get_redis_service),
    llm: LLMService = Depends(get_llm_service)
):
    """
    Generate synthesis across all documents.

    Finds connections, common themes, and generates FAQ.
    """
    try:
        from services.document_synthesis_service import get_document_synthesis_service

        qdrant = get_qdrant_service()
        neo4j = get_neo4j_service()

        service = get_document_synthesis_service(
            llm_service=llm,
            qdrant_service=qdrant,
            redis_service=redis,
            neo4j_driver=neo4j.driver if neo4j else None
        )

        synthesis = await service.generate_multi_doc_synthesis(
            project_number=request.project_number,
            chat_id=request.chat_id,
            force_regenerate=request.force_regenerate
        )

        if not synthesis:
            raise HTTPException(status_code=404, detail="No documents found or synthesis failed")

        return MultiDocSynthesisResponse(
            overview=synthesis.overview,
            document_count=len(synthesis.documents),
            common_themes=synthesis.common_themes,
            connections=synthesis.connections,
            knowledge_gaps=synthesis.knowledge_gaps,
            faq=synthesis.faq,
            suggested_questions=synthesis.suggested_questions
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Multi-doc synthesis failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/study-guide", response_model=StudyGuideResponse)
async def get_study_guide(
    request: StudyGuideRequest,
    current_user: str = Depends(get_current_user),
    redis: RedisService = Depends(get_redis_service),
    llm: LLMService = Depends(get_llm_service)
):
    """
    Generate a study guide from documents.

    Includes key concepts, facts, and review questions.
    """
    try:
        from services.document_synthesis_service import get_document_synthesis_service

        qdrant = get_qdrant_service()

        service = get_document_synthesis_service(
            llm_service=llm,
            qdrant_service=qdrant,
            redis_service=redis
        )

        guide = await service.generate_study_guide(
            project_number=request.project_number,
            chat_id=request.chat_id,
            focus_topics=request.focus_topics
        )

        if not guide:
            raise HTTPException(status_code=404, detail="Study guide generation failed")

        return StudyGuideResponse(
            title=guide.title,
            overview=guide.overview,
            key_concepts=guide.key_concepts,
            important_facts=guide.important_facts,
            review_questions=guide.review_questions,
            summary_notes=guide.summary_notes
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Study guide generation failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/suggested-questions")
async def get_suggested_questions(
    project_number: Optional[str] = None,
    chat_id: Optional[str] = None,
    count: int = 10,
    current_user: str = Depends(get_current_user),
    redis: RedisService = Depends(get_redis_service),
    llm: LLMService = Depends(get_llm_service)
):
    """
    Get suggested questions based on document content.
    """
    try:
        from services.document_synthesis_service import get_document_synthesis_service

        qdrant = get_qdrant_service()

        service = get_document_synthesis_service(
            llm_service=llm,
            qdrant_service=qdrant,
            redis_service=redis
        )

        questions = await service.generate_suggested_questions(
            project_number=project_number,
            chat_id=chat_id,
            count=count
        )

        return {"questions": questions}

    except Exception as e:
        logger.error(f"Suggested questions failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# AUDIO SUMMARY ENDPOINTS
# =============================================================================

@router.post("/audio/summary", response_model=AudioResponse)
async def generate_audio_summary(
    request: AudioRequest,
    background_tasks: BackgroundTasks,
    current_user: str = Depends(get_current_user),
    redis: RedisService = Depends(get_redis_service),
    llm: LLMService = Depends(get_llm_service)
):
    """
    Generate audio summary of documents.

    Uses TTS to convert document summary to speech.
    """
    try:
        from services.audio_summary_service import get_audio_summary_service
        from services.document_synthesis_service import get_document_synthesis_service

        qdrant = get_qdrant_service()

        synthesis_service = get_document_synthesis_service(
            llm_service=llm,
            qdrant_service=qdrant,
            redis_service=redis
        )

        audio_service = get_audio_summary_service(
            llm_service=llm,
            synthesis_service=synthesis_service,
            redis_service=redis
        )

        result = await audio_service.generate_audio_summary(
            text=request.text,
            project_number=request.project_number,
            chat_id=request.chat_id,
            voice=request.voice,
            language=request.language
        )

        if not result:
            raise HTTPException(status_code=500, detail="Audio generation failed")

        return AudioResponse(
            audio_url=result.audio_url,
            duration_seconds=result.duration_seconds,
            provider=result.provider,
            voice=result.voice,
            cached=result.cached
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Audio summary failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/audio/podcast", response_model=PodcastResponse)
async def generate_podcast(
    request: PodcastRequest,
    current_user: str = Depends(get_current_user),
    redis: RedisService = Depends(get_redis_service),
    llm: LLMService = Depends(get_llm_service)
):
    """
    Generate podcast-style audio overview.

    Creates a multi-voice conversation about the documents.
    """
    try:
        from services.audio_summary_service import get_audio_summary_service
        from services.document_synthesis_service import get_document_synthesis_service

        qdrant = get_qdrant_service()

        synthesis_service = get_document_synthesis_service(
            llm_service=llm,
            qdrant_service=qdrant,
            redis_service=redis
        )

        audio_service = get_audio_summary_service(
            llm_service=llm,
            synthesis_service=synthesis_service,
            redis_service=redis
        )

        result = await audio_service.generate_podcast_overview(
            project_number=request.project_number,
            chat_id=request.chat_id,
            style=request.style,
            duration_target=request.duration_target
        )

        if not result:
            raise HTTPException(status_code=500, detail="Podcast generation failed")

        return PodcastResponse(
            audio_url=result.audio_url,
            duration_seconds=result.duration_seconds,
            transcript=result.transcript,
            segment_count=len(result.segments)
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Podcast generation failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/audio/{filename}")
async def serve_audio(filename: str):
    """Serve audio file"""
    audio_dir = Path("/app/uploads/audio")
    filepath = audio_dir / filename

    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")

    return FileResponse(
        filepath,
        media_type="audio/mpeg",
        filename=filename
    )


# =============================================================================
# DOCUMENT CONNECTIONS
# =============================================================================

@router.get("/connections")
async def get_document_connections(
    project_number: str,
    current_user: str = Depends(get_current_user)
):
    """
    Get connections between documents.

    Uses Neo4j to find relationships.
    """
    try:
        from services.document_synthesis_service import get_document_synthesis_service

        neo4j = get_neo4j_service()

        service = get_document_synthesis_service(
            neo4j_driver=neo4j.driver if neo4j else None
        )

        connections = await service.get_document_connections(project_number)

        return {"connections": connections}

    except Exception as e:
        logger.error(f"Document connections failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
