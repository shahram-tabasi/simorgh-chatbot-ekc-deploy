"""
Chatbot V2 Routes
=================
Enhanced chatbot routes using the new chatbot_core architecture.

Features:
- General-Session and Project-Session chat endpoints
- Unified memory management
- Context-aware LLM responses
- Stage-based tool restrictions
- Per-user quota enforcement for modern users
- LLM mode enforcement (online-only for modern users)

Author: Simorgh Industrial Assistant
"""

import logging
import os
from typing import Optional, List
from uuid import UUID

import httpx
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


# =============================================================================
# USER TYPE DETECTION & TIER HELPERS
# =============================================================================

def _is_modern_user(user_id: str) -> bool:
    """Check if user_id is a UUID (modern user) vs TPMS username (legacy)."""
    try:
        UUID(user_id)
        return True
    except (ValueError, AttributeError):
        return False


async def _get_modern_user_info(user_id: str) -> Optional[dict]:
    """Look up a modern user's tier info from PostgreSQL."""
    try:
        from services.postgres_auth_service import get_postgres_auth_service
        auth_service = get_postgres_auth_service()
        return await auth_service.get_user_by_id(UUID(user_id))
    except Exception as e:
        logger.warning(f"Could not look up modern user {user_id}: {e}")
        return None


async def _check_modern_quota(user_id: str, user_role: str) -> dict:
    """Check quota for a modern user. Raises HTTPException(429) if exceeded."""
    from services.user_tier_service import get_tier_service
    tier_service = get_tier_service()
    if not tier_service:
        return {"quota_check": "skipped"}

    allowed, quota_info = await tier_service.check_quota(UUID(user_id), user_role)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail={
                "error": "quota_exceeded",
                "message": f"Daily question limit reached ({quota_info['questions_limit']}). Resets at {quota_info['resets_at']}.",
                "questions_used": quota_info["questions_used"],
                "questions_limit": quota_info["questions_limit"],
                "questions_remaining": 0,
                "resets_at": quota_info["resets_at"],
                "upgrade_url": "/upgrade",
            },
        )
    return quota_info


async def _increment_modern_usage(user_id: str):
    """Increment daily usage count after successful response."""
    try:
        from services.user_tier_service import get_tier_service
        tier_service = get_tier_service()
        if tier_service:
            await tier_service.increment_usage(UUID(user_id))
    except Exception as e:
        logger.warning(f"Failed to increment usage for {user_id}: {e}")

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
    quota: Optional[dict] = None
    # Token-budget telemetry from the wrapper's fit_history pass, so the
    # frontend can render the round usage ring (priority 2 feature).
    # Shape: {used_tokens, history_tokens, budget, context_limit,
    #         fixed_tokens, response_reserve, dropped_count,
    #         trigger_compaction}.
    token_budget: Optional[dict] = None


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

    - **general** chats: Available to all users
    - **project** chats: Modern users need pro/max/admin tier. Legacy users: unrestricted.
    """
    try:
        chat_type = ChatType(request.chat_type)
        stage = SessionStage(request.stage) if request.stage else SessionStage.ANALYSIS

        # Tier-based project creation guard for modern users
        if chat_type == ChatType.PROJECT and _is_modern_user(request.user_id):
            user_info = await _get_modern_user_info(request.user_id)
            if user_info:
                user_role = user_info.get("user_role", "free")
                if user_role not in ("pro", "max", "admin"):
                    raise HTTPException(
                        status_code=403,
                        detail={
                            "error": "insufficient_tier",
                            "message": "Project chats require Pro, Max, or Admin tier.",
                            "current_tier": user_role,
                            "required_tiers": ["pro", "max", "admin"],
                            "upgrade_url": "/upgrade",
                        },
                    )

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

    except HTTPException:
        raise
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

    Modern users: quota enforced, online LLM only, tools restricted by tier.
    Legacy (TPMS) users: unlimited, all LLM modes, all tools.
    """
    try:
        llm_mode = None  # None = use server default (allows offline for legacy)
        use_tools = request.use_tools

        # --- Modern user enforcement ---
        if _is_modern_user(request.user_id):
            user_info = await _get_modern_user_info(request.user_id)
            user_role = user_info.get("user_role", "free") if user_info else "free"

            # 1. Quota check (raises 429 if exceeded)
            if user_role != "admin":
                await _check_modern_quota(request.user_id, user_role)

            # 2. Force online LLM mode for all modern users
            llm_mode = "online"

            # 3. Tool access: only max/admin can use tools
            if use_tools and user_role not in ("max", "admin"):
                use_tools = False

        # --- Send message ---
        result = await core.send_message(
            chat_id=chat_id,
            user_id=request.user_id,
            message=request.message,
            use_tools=use_tools,
            stream=request.stream,
            llm_mode=llm_mode,
        )

        # --- Increment usage for modern users on success ---
        if _is_modern_user(request.user_id) and result.get("success"):
            await _increment_modern_usage(request.user_id)

        if request.stream and result.get("stream"):
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
            token_budget=result.get("token_budget"),
        )

    except HTTPException:
        raise
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

    Uploads are PROJECT-ONLY (per chatbot main-functionality spec).
    General chat sessions reject all uploads with 403.

    Documents are:
    - Chunked and embedded in Qdrant
    - Entities extracted to Neo4j (for project chats)
    - Metadata stored in Postgres
    """
    try:
        # Guard: uploads are not allowed in general chat sessions.
        ctx = await core.sessions.get_session(chat_id, request.user_id)
        if ctx is None:
            raise HTTPException(status_code=404, detail="Chat not found")
        if ctx.chat_type != ChatType.PROJECT:
            raise HTTPException(
                status_code=403,
                detail="Uploads are not permitted in general chat sessions. "
                       "Create a project chat to upload documents.",
            )

        result = await core.upload_document(
            chat_id=chat_id,
            user_id=request.user_id,
            content=request.content,
            filename=request.filename,
            category=request.category,
        )

        # For project chats with an active session container, also drop a
        # copy of the upload into /work/uploads/ so the in-container tools
        # (and the explorer's deep-walk) can see it. Failures are logged
        # but don't fail the request — Qdrant ingest above is what the
        # chat retrieval path needs.
        try:
            project_id = None
            if hasattr(ctx, "project") and ctx.project:
                project_id = ctx.project.project_number
            if project_id:
                RUNTIME_BROKER_URL   = os.getenv("RUNTIME_BROKER_URL",
                                                 "http://runtime-broker:8048")
                RUNTIME_BROKER_TOKEN = os.getenv("BROKER_TOKEN", "")
                content_bytes = (
                    request.content.encode("utf-8")
                    if isinstance(request.content, str)
                    else bytes(request.content)
                )
                import base64 as _b64
                headers = ({"authorization": f"Bearer {RUNTIME_BROKER_TOKEN}"}
                           if RUNTIME_BROKER_TOKEN else {})
                async with httpx.AsyncClient(timeout=60.0) as c:
                    r = await c.post(
                        f"{RUNTIME_BROKER_URL}/sessions/{project_id}/write_file",
                        json={
                            "path": f"uploads/{request.filename}",
                            "content": _b64.b64encode(content_bytes).decode("ascii"),
                            "encoding": "base64",
                        },
                        headers=headers,
                    )
                    if r.status_code == 200:
                        result.setdefault("warnings", []).append(
                            f"container_upload: /work/uploads/{request.filename}"
                        )
                    else:
                        result.setdefault("warnings", []).append(
                            f"container_upload_failed: {r.status_code} {r.text[:120]}"
                        )
        except Exception as e:
            logger.warning("container upload push failed (non-fatal): %s", e)

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


class CompactRequest(BaseModel):
    """Body for POST /{chat_id}/compact."""
    hint: Optional[str] = Field(
        None,
        description="Optional steering for the summarizer "
                    "(e.g. 'preserve panel-A wiring decisions').",
    )


@router.post("/{chat_id}/compact")
async def compact_chat(
    chat_id: str,
    body: CompactRequest = Body(default_factory=CompactRequest),
    user_id: str = Query(..., description="User identifier"),
    core: ChatbotCore = Depends(get_core),
):
    """Manually compact this chat's history into a structured ``<summary>``.

    Mirrors Claude Code's ``/compact``: folds prior turns into a single
    summary block (decisions, files, current task, stage, open questions,
    pinned facts). Future turns reason on the summary plus the verbatim
    tail that still fits in the token budget. Pass ``hint`` to steer the
    summarizer.
    """
    try:
        context = await core.sessions.get_session(chat_id, user_id)
        if not context:
            raise HTTPException(status_code=404, detail="Chat not found")

        project_id = None
        if hasattr(context, "project") and context.project:
            project_id = context.project.project_number

        history = await core.memory.get_chat_history(
            chat_type=context.chat_type,
            chat_id=chat_id,
            project_id=project_id,
            limit=500,  # Compact the whole chat, not just the window.
        )
        if not history.success:
            raise HTTPException(status_code=500, detail=history.error or "history fetch failed")

        from services.conversation_summarizer import get_conversation_summarizer
        summarizer = get_conversation_summarizer()
        if summarizer.llm is None and getattr(core, "llm", None):
            # core.llm is the wrapper; the underlying service hangs off it.
            summarizer.set_services(llm_service=getattr(core.llm, "llm", None))

        summary = await summarizer.compact(
            chat_id=chat_id,
            messages=history.data or [],
            hint=body.hint,
        )
        return {
            "success": bool(summary),
            "chat_id": chat_id,
            "messages_compacted": len(history.data or []),
            "summary": summary,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error compacting chat {chat_id}: {e}")
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
