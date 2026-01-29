"""
Chatbot V2 Routes
=================
Enhanced chatbot routes using the new chatbot_core architecture.

Features:
- General-Session and Project-Session chat endpoints
- Unified memory management
- Context-aware LLM responses
- Stage-based tool restrictions

Author: Simorgh Industrial Assistant
"""

import logging
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query, Body
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from chatbot_core.models import (
    ChatType,
    SessionStage,
    DocumentCategory,
)
from chatbot_core.integration import (
    get_chatbot_core,
    ChatbotCore,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/chat", tags=["Chatbot V2"])


# =============================================================================
# REQUEST/RESPONSE MODELS
# =============================================================================

class CreateChatRequest(BaseModel):
    """Request to create a new chat"""
    user_id: str = Field(..., description="User identifier")
    chat_type: str = Field("general", description="Chat type: 'general' or 'project'")
    username: Optional[str] = Field(None, description="Optional username")
    project_number: Optional[str] = Field(None, description="Project number (for project chats)")
    project_name: Optional[str] = Field(None, description="Project name")
    project_domain: Optional[str] = Field(None, description="Project domain (e.g., 'electrical')")
    stage: Optional[str] = Field("analysis", description="Initial stage for project chats")


class CreateChatResponse(BaseModel):
    """Response from chat creation"""
    success: bool
    chat_id: str
    chat_type: str
    message: Optional[str] = None


class SendMessageRequest(BaseModel):
    """Request to send a message"""
    user_id: str = Field(..., description="User identifier")
    message: str = Field(..., description="User message")
    use_tools: bool = Field(True, description="Whether to use external tools")
    stream: bool = Field(False, description="Whether to stream response")


class SendMessageResponse(BaseModel):
    """Response from message send"""
    success: bool
    content: Optional[str] = None
    model: Optional[str] = None
    mode: Optional[str] = None
    tokens_used: int = 0
    sources: List[str] = []
    error: Optional[str] = None


class UploadDocumentRequest(BaseModel):
    """Request to upload a document"""
    user_id: str = Field(..., description="User identifier")
    content: str = Field(..., description="Document content (text)")
    filename: str = Field(..., description="Original filename")
    category: str = Field("general", description="Document category")


class UploadDocumentResponse(BaseModel):
    """Response from document upload"""
    success: bool
    document_id: str
    filename: str
    chunks_created: int = 0
    entities_extracted: int = 0
    stored_to_qdrant: bool = False
    stored_to_neo4j: bool = False
    errors: List[str] = []
    warnings: List[str] = []
    processing_time_ms: float = 0.0


class UpdateStageRequest(BaseModel):
    """Request to update project session stage"""
    user_id: str = Field(..., description="User identifier")
    stage: str = Field(..., description="New stage: analysis, design, implementation, review")


class ChatInfoResponse(BaseModel):
    """Chat information response"""
    chat_id: str
    chat_type: str
    user_id: str
    project_number: Optional[str] = None
    project_name: Optional[str] = None
    stage: Optional[str] = None
    history_count: int = 0
    documents_count: int = 0
    allows_external_tools: bool = True


class ChatStatsResponse(BaseModel):
    """Chatbot statistics response"""
    initialized: bool
    sessions_active: int
    memory_stats: Optional[dict] = None
    llm_stats: Optional[dict] = None
    tools_stats: Optional[dict] = None


# =============================================================================
# DEPENDENCY
# =============================================================================

def get_core() -> ChatbotCore:
    """Get chatbot core dependency"""
    core = get_chatbot_core()
    if not core.is_initialized:
        raise HTTPException(
            status_code=503,
            detail="Chatbot core not initialized. Please wait for startup."
        )
    return core


# =============================================================================
# ROUTES
# =============================================================================

@router.post("/create", response_model=CreateChatResponse)
async def create_chat(
    request: CreateChatRequest,
    core: ChatbotCore = Depends(get_core),
):
    """
    Create a new chat session.

    - **general** chats: Isolated sessions with general responses
    - **project** chats: Project-specific sessions with shared memory
    """
    try:
        chat_type = ChatType(request.chat_type)
        stage = SessionStage(request.stage) if request.stage else SessionStage.ANALYSIS

        context = await core.create_chat(
            user_id=request.user_id,
            chat_type=chat_type,
            username=request.username,
            project_number=request.project_number,
            project_name=request.project_name,
            project_domain=request.project_domain,
            stage=stage,
        )

        return CreateChatResponse(
            success=True,
            chat_id=context.chat_id,
            chat_type=context.chat_type.value,
            message=f"Created {context.chat_type.value} chat successfully",
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating chat: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{chat_id}/message", response_model=SendMessageResponse)
async def send_message(
    chat_id: str,
    request: SendMessageRequest,
    core: ChatbotCore = Depends(get_core),
):
    """
    Send a message to a chat and get response.

    For project chats:
    - Responses are restricted to project knowledge
    - External tools only allowed in 'analysis' stage
    """
    try:
        result = await core.send_message(
            chat_id=chat_id,
            user_id=request.user_id,
            message=request.message,
            use_tools=request.use_tools,
            stream=request.stream,
        )

        if request.stream and result.get("stream"):
            # Return streaming response
            async def generate():
                for chunk in result["stream"]:
                    yield chunk

            return StreamingResponse(
                generate(),
                media_type="text/event-stream"
            )

        return SendMessageResponse(
            success=result.get("success", False),
            content=result.get("content"),
            model=result.get("model"),
            mode=result.get("mode"),
            tokens_used=result.get("tokens_used", 0),
            sources=result.get("sources", []),
            error=result.get("error"),
        )

    except Exception as e:
        logger.error(f"Error sending message: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{chat_id}/document", response_model=UploadDocumentResponse)
async def upload_document(
    chat_id: str,
    request: UploadDocumentRequest,
    core: ChatbotCore = Depends(get_core),
):
    """
    Upload and process a document.

    Documents are:
    - Chunked and embedded in Qdrant
    - Entities extracted to Neo4j (for project chats)
    - Metadata stored in Postgres
    """
    try:
        result = await core.upload_document(
            chat_id=chat_id,
            user_id=request.user_id,
            content=request.content,
            filename=request.filename,
            category=request.category,
        )

        return UploadDocumentResponse(
            success=result.get("success", False),
            document_id=result.get("document_id", ""),
            filename=result.get("filename", ""),
            chunks_created=result.get("chunks_created", 0),
            entities_extracted=result.get("entities_extracted", 0),
            stored_to_qdrant=result.get("stored_to_qdrant", False),
            stored_to_neo4j=result.get("stored_to_neo4j", False),
            errors=result.get("errors", []),
            warnings=result.get("warnings", []),
            processing_time_ms=result.get("processing_time_ms", 0.0),
        )

    except Exception as e:
        logger.error(f"Error uploading document: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{chat_id}/stage")
async def update_stage(
    chat_id: str,
    request: UpdateStageRequest,
    core: ChatbotCore = Depends(get_core),
):
    """
    Update the stage of a project session.

    Stages:
    - **analysis**: External tools allowed, gather information
    - **design**: Project knowledge only
    - **implementation**: Project knowledge only
    - **review**: Project knowledge only
    """
    try:
        context = await core.sessions.get_session(chat_id, request.user_id)
        if not context:
            raise HTTPException(status_code=404, detail="Chat not found")

        if context.chat_type != ChatType.PROJECT:
            raise HTTPException(
                status_code=400,
                detail="Stage can only be changed for project chats"
            )

        new_stage = SessionStage(request.stage)
        await core.sessions.update_stage(context, new_stage)

        return {
            "success": True,
            "chat_id": chat_id,
            "stage": new_stage.value,
            "allows_external_tools": new_stage == SessionStage.ANALYSIS,
        }

    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid stage: {e}")
    except Exception as e:
        logger.error(f"Error updating stage: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{chat_id}", response_model=ChatInfoResponse)
async def get_chat_info(
    chat_id: str,
    user_id: str = Query(..., description="User identifier"),
    core: ChatbotCore = Depends(get_core),
):
    """
    Get information about a chat session.
    """
    try:
        context = await core.sessions.get_session(chat_id, user_id)
        if not context:
            raise HTTPException(status_code=404, detail="Chat not found")

        # Build context to get latest info
        context = await core.sessions.build_llm_context(
            context=context,
            current_query="",
        )

        response = ChatInfoResponse(
            chat_id=context.chat_id,
            chat_type=context.chat_type.value,
            user_id=context.user.user_id,
            history_count=len(context.history_window),
            documents_count=len(context.documents),
            allows_external_tools=True,
        )

        if hasattr(context, "project") and context.project:
            response.project_number = context.project.project_number
            response.project_name = context.project.project_name
            response.stage = context.stage.value
            response.allows_external_tools = context.allows_external_tools

        return response

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting chat info: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{chat_id}/history")
async def get_chat_history(
    chat_id: str,
    user_id: str = Query(..., description="User identifier"),
    limit: int = Query(50, ge=1, le=100),
    core: ChatbotCore = Depends(get_core),
):
    """
    Get chat history.
    """
    try:
        context = await core.sessions.get_session(chat_id, user_id)
        if not context:
            raise HTTPException(status_code=404, detail="Chat not found")

        project_id = None
        if hasattr(context, "project") and context.project:
            project_id = context.project.project_number

        result = await core.memory.get_chat_history(
            chat_type=context.chat_type,
            chat_id=chat_id,
            project_id=project_id,
            limit=limit,
        )

        return {
            "success": result.success,
            "chat_id": chat_id,
            "messages": result.data or [],
            "source": result.source_tier.value if result.source_tier else None,
            "cached": result.cached,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting history: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{chat_id}")
async def delete_chat(
    chat_id: str,
    user_id: str = Query(..., description="User identifier"),
    core: ChatbotCore = Depends(get_core),
):
    """
    Delete a chat session.
    """
    try:
        success = await core.sessions.delete_session(chat_id, user_id)

        if not success:
            raise HTTPException(status_code=500, detail="Failed to delete chat")

        return {"success": True, "chat_id": chat_id, "deleted": True}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting chat: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# UTILITY ROUTES
# =============================================================================

@router.get("/tools/available")
async def get_available_tools(
    chat_id: str = Query(..., description="Chat identifier"),
    user_id: str = Query(..., description="User identifier"),
    core: ChatbotCore = Depends(get_core),
):
    """
    Get tools available for a chat.

    Tools vary based on:
    - Chat type (general vs project)
    - Session stage (for project chats)
    """
    try:
        context = await core.sessions.get_session(chat_id, user_id)
        if not context:
            raise HTTPException(status_code=404, detail="Chat not found")

        available = core.tools.get_available_tools(context)

        return {
            "chat_id": chat_id,
            "chat_type": context.chat_type.value,
            "tools": [
                {
                    "tool_id": t.tool_id,
                    "name": t.tool_name,
                    "category": t.category.value,
                }
                for t in available
            ],
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting tools: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/stats", response_model=ChatStatsResponse)
async def get_stats(core: ChatbotCore = Depends(get_core)):
    """
    Get chatbot system statistics.
    """
    stats = core.get_stats()

    return ChatStatsResponse(
        initialized=stats.get("initialized", False),
        sessions_active=stats.get("sessions_active", 0),
        memory_stats=stats.get("memory"),
        llm_stats=stats.get("llm"),
        tools_stats=stats.get("tools"),
    )


@router.get("/health")
async def health_check(core: ChatbotCore = Depends(get_core)):
    """
    Health check endpoint.
    """
    return {
        "status": "healthy" if core.is_initialized else "initializing",
        "initialized": core.is_initialized,
        "components": {
            "memory": core.memory is not None,
            "sessions": core.sessions is not None,
            "llm": core.llm is not None,
            "tools": core.tools is not None,
            "ingestion": core.ingestion is not None,
        },
    }
