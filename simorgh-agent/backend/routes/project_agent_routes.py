"""
Project Agent Routes
=====================
API routes for the Project Manager Agent system.
Handles project CRUD, COT-driven messaging, tasks, instructions,
documents, git operations, and email gateway.

Modern users create projects by name only (no TPMS data).
Legacy users can optionally link TPMS OENUM.
"""

import json
import logging
import uuid
from datetime import datetime
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
import asyncio

from models.project_models import (
    ProjectCreate, ProjectUpdate, ProjectResponse, ProjectListResponse,
    InstructionCreate, InstructionUpdate, InstructionResponse,
    TaskCreate, TaskUpdate, TaskResponse, TaskListResponse,
    COTRequest, COTExecutionProgress,
    ProjectMessageCreate, ProjectMessageResponse,
    ShellCommandRequest, ShellCommandResponse,
    GitCommitRequest, AgentState,
    ProjectStatus, TaskStatus, MessageChannel, TaskTrigger,
)
from services.auth_utils import get_current_user
from services.project_agent import get_project_agent, ProjectManagerAgent
from services.project_memory_service import get_project_memory_service, ProjectMemoryService
from services.shell_service import get_shell_service, ShellServiceClient
from services.email_gateway import get_email_gateway, InboundEmail
from services.doc_processor_client import DocProcessorClient

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/agent", tags=["Project Agent"])


# =============================================================================
# DEPENDENCY HELPERS
# =============================================================================

def _is_legacy_user(user_id: str) -> bool:
    """Check if user is legacy (non-UUID) or modern (UUID)."""
    try:
        uuid.UUID(user_id)
        return False  # Modern user
    except (ValueError, AttributeError):
        return True  # Legacy user


# =============================================================================
# PROJECT CRUD
# =============================================================================

@router.post("/projects", response_model=ProjectResponse)
async def create_project(
    data: ProjectCreate,
    current_user: str = Depends(get_current_user),
):
    """
    Create a new project.

    Modern users: provide a name (no TPMS link).
    Legacy users: can optionally provide tpms_oenum.
    """
    memory = get_project_memory_service()
    agent = get_project_agent()

    is_legacy = _is_legacy_user(current_user)

    # Modern users cannot link TPMS
    if not is_legacy and data.tpms_oenum:
        raise HTTPException(
            status_code=400,
            detail="Modern users cannot link TPMS projects. Create a project by name."
        )

    try:
        # Create in PostgreSQL
        project = await memory.create_project(
            owner_id=current_user,
            name=data.name,
            description=data.description,
            tpms_oenum=data.tpms_oenum if is_legacy else None,
            agent_model=data.agent_model or "gpt-4o",
            metadata=data.metadata,
        )

        if not project:
            raise HTTPException(status_code=500, detail="Failed to create project")

        project_id = str(project["id"])

        # Initialize all systems (Neo4j graph, Qdrant, git workspace, agent state)
        # Pass tpms_oenum so modern users get minimal graph (no EKC template)
        init_result = await agent.initialize_project(
            project_id, data.name, current_user,
            tpms_oenum=data.tpms_oenum if is_legacy else None,
        )
        logger.info(f"Project initialized: {project_id}, results: {init_result}")

        return ProjectResponse(
            id=project["id"],
            owner_id=project["owner_id"],
            name=project["name"],
            description=project.get("description"),
            tpms_oenum=project.get("tpms_oenum"),
            status=ProjectStatus(project.get("status", "active")),
            agent_enabled=project.get("agent_enabled", True),
            agent_model=project.get("agent_model", "gpt-4o"),
            git_repo_initialized=True,
            metadata=json.loads(project["metadata"]) if isinstance(project.get("metadata"), str) else project.get("metadata", {}),
            created_at=project["created_at"],
            updated_at=project["updated_at"],
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Project creation failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to create project: {str(e)}")


@router.get("/projects", response_model=ProjectListResponse)
async def list_projects(
    current_user: str = Depends(get_current_user),
):
    """List all projects for the current user."""
    memory = get_project_memory_service()

    try:
        projects = await memory.list_projects(current_user)
        responses = []
        for p in projects:
            responses.append(ProjectResponse(
                id=p["id"],
                owner_id=p["owner_id"],
                name=p["name"],
                description=p.get("description"),
                tpms_oenum=p.get("tpms_oenum"),
                status=ProjectStatus(p.get("status", "active")),
                agent_enabled=p.get("agent_enabled", True),
                agent_model=p.get("agent_model", "gpt-4o"),
                git_repo_initialized=p.get("git_repo_initialized", False),
                metadata=json.loads(p["metadata"]) if isinstance(p.get("metadata"), str) else p.get("metadata", {}),
                created_at=p["created_at"],
                updated_at=p["updated_at"],
                task_count=p.get("task_count", 0),
                active_task_count=p.get("active_task_count", 0),
                message_count=p.get("message_count", 0),
                document_count=p.get("document_count", 0),
            ))

        return ProjectListResponse(projects=responses, total=len(responses))

    except Exception as e:
        logger.error(f"Failed to list projects: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/projects/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: str,
    current_user: str = Depends(get_current_user),
):
    """Get a project by ID."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    return ProjectResponse(
        id=project["id"],
        owner_id=project["owner_id"],
        name=project["name"],
        description=project.get("description"),
        tpms_oenum=project.get("tpms_oenum"),
        status=ProjectStatus(project.get("status", "active")),
        agent_enabled=project.get("agent_enabled", True),
        agent_model=project.get("agent_model", "gpt-4o"),
        git_repo_initialized=project.get("git_repo_initialized", False),
        metadata=json.loads(project["metadata"]) if isinstance(project.get("metadata"), str) else project.get("metadata", {}),
        created_at=project["created_at"],
        updated_at=project["updated_at"],
    )


@router.patch("/projects/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: str,
    data: ProjectUpdate,
    current_user: str = Depends(get_current_user),
):
    """Update a project."""
    memory = get_project_memory_service()

    # Verify ownership
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    update_fields = {}
    if data.name is not None:
        update_fields["name"] = data.name
    if data.description is not None:
        update_fields["description"] = data.description
    if data.status is not None:
        update_fields["status"] = data.status.value
    if data.agent_enabled is not None:
        update_fields["agent_enabled"] = data.agent_enabled
    if data.agent_model is not None:
        update_fields["agent_model"] = data.agent_model
    if data.metadata is not None:
        update_fields["metadata"] = data.metadata

    updated = await memory.update_project(project_id, **update_fields)
    if not updated:
        raise HTTPException(status_code=500, detail="Failed to update project")

    return ProjectResponse(
        id=updated["id"],
        owner_id=updated["owner_id"],
        name=updated["name"],
        description=updated.get("description"),
        tpms_oenum=updated.get("tpms_oenum"),
        status=ProjectStatus(updated.get("status", "active")),
        agent_enabled=updated.get("agent_enabled", True),
        agent_model=updated.get("agent_model", "gpt-4o"),
        git_repo_initialized=updated.get("git_repo_initialized", False),
        metadata=json.loads(updated["metadata"]) if isinstance(updated.get("metadata"), str) else updated.get("metadata", {}),
        created_at=updated["created_at"],
        updated_at=updated["updated_at"],
    )


@router.delete("/projects/{project_id}")
async def delete_project(
    project_id: str,
    confirm: bool = Query(False),
    current_user: str = Depends(get_current_user),
):
    """Delete a project and all its data across all memory layers."""
    if not confirm:
        raise HTTPException(status_code=400, detail="Set confirm=true to delete")

    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    # Clean up all layers
    results = await memory.cleanup_project(project_id)

    # Also clean up shell workspace
    try:
        shell = get_shell_service()
        await shell.delete_workspace(project_id)
        results["shell"] = "cleaned"
    except Exception as e:
        results["shell"] = f"error: {e}"

    return {"status": "deleted", "project_id": project_id, "details": results}


# =============================================================================
# AGENT MESSAGING (Main entry point - COT-driven)
# =============================================================================

@router.post("/projects/{project_id}/message")
async def send_message(
    project_id: str,
    data: ProjectMessageCreate,
    current_user: str = Depends(get_current_user),
):
    """
    Send a message to the project agent.
    Triggers COT analysis -> task creation -> execution -> response.
    """
    memory = get_project_memory_service()
    agent = get_project_agent()

    # Verify ownership
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    try:
        result = await agent.handle_input(
            project_id=project_id,
            user_input=data.content,
            channel=data.channel,
            chat_id=data.chat_id,
            user_id=current_user,
            document_id=str(data.document_id) if data.document_id else None,
            document_filename=data.document_filename,
            email_from=data.email_from,
            email_subject=data.email_subject,
            auto_execute=True,
        )

        return {
            "response": result["response"],
            "chain_id": result["chain_id"],
            "reasoning": result["reasoning"],
            "tasks_created": result["tasks_created"],
            "tasks": result["tasks"],
            "commit": result.get("commit"),
        }

    except Exception as e:
        logger.error(f"Agent message failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Agent error: {str(e)}")


@router.post("/projects/{project_id}/message/stream")
async def send_message_stream(
    project_id: str,
    data: ProjectMessageCreate,
    current_user: str = Depends(get_current_user),
):
    """
    Send a message to the project agent with SSE streaming.
    Returns Server-Sent Events with progress updates and final response.
    """
    memory = get_project_memory_service()
    agent = get_project_agent()

    # Verify ownership
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    async def event_generator():
        progress_queue = asyncio.Queue()

        async def progress_callback(event_data):
            await progress_queue.put(event_data)

        # Register callback for streaming progress
        agent.register_progress_callback(project_id, progress_callback)

        # Start agent processing in background
        result_holder = {"result": None, "error": None}

        async def run_agent():
            try:
                result_holder["result"] = await agent.handle_input(
                    project_id=project_id,
                    user_input=data.content,
                    channel=data.channel,
                    chat_id=data.chat_id,
                    user_id=current_user,
                    document_id=str(data.document_id) if data.document_id else None,
                    document_filename=data.document_filename,
                    email_from=data.email_from,
                    email_subject=data.email_subject,
                    auto_execute=True,
                )
            except Exception as e:
                result_holder["error"] = str(e)
            finally:
                # Signal completion
                await progress_queue.put({"event": "_done", "data": {}})

        agent_task = asyncio.create_task(run_agent())

        try:
            while True:
                try:
                    event = await asyncio.wait_for(progress_queue.get(), timeout=120)
                except asyncio.TimeoutError:
                    yield f"event: ping\ndata: {{}}\n\n"
                    continue

                event_name = event.get("event", "progress")
                event_data = event.get("data", {})

                if event_name == "_done":
                    # Send final result
                    if result_holder["result"]:
                        result = result_holder["result"]
                        final_data = json.dumps({
                            "response": result["response"],
                            "chain_id": result["chain_id"],
                            "reasoning": result["reasoning"],
                            "tasks_created": result["tasks_created"],
                            "tasks": result["tasks"],
                            "commit": result.get("commit"),
                        })
                        yield f"event: complete\ndata: {final_data}\n\n"
                    elif result_holder["error"]:
                        yield f"event: error\ndata: {json.dumps({'error': result_holder['error']})}\n\n"
                    break
                else:
                    yield f"event: {event_name}\ndata: {json.dumps(event_data, default=str)}\n\n"
        finally:
            agent.unregister_progress_callback(project_id)
            if not agent_task.done():
                await agent_task

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/projects/{project_id}/messages")
async def get_messages(
    project_id: str,
    channel: Optional[str] = None,
    chat_id: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    current_user: str = Depends(get_current_user),
):
    """Get project messages."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    messages = await memory.get_messages(project_id, channel=channel,
                                          chat_id=chat_id, limit=limit)
    return {"messages": messages, "total": len(messages)}


# =============================================================================
# TASKS
# =============================================================================

@router.get("/projects/{project_id}/tasks", response_model=TaskListResponse)
async def list_tasks(
    project_id: str,
    status: Optional[str] = None,
    chain_id: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    current_user: str = Depends(get_current_user),
):
    """List tasks for a project."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    tasks = await memory.get_tasks(project_id, status=status,
                                    cot_chain_id=chain_id, limit=limit)

    task_responses = []
    for t in tasks:
        task_responses.append(TaskResponse(
            id=t["id"],
            project_id=t["project_id"],
            instruction_id=t.get("instruction_id"),
            parent_task_id=t.get("parent_task_id"),
            cot_chain_id=t.get("cot_chain_id"),
            title=t["title"],
            description=t.get("description"),
            task_type=t.get("task_type", "action"),
            status=t.get("status", "pending"),
            priority=t.get("priority", 5),
            tool_used=t.get("tool_used"),
            tool_input=json.loads(t["tool_input"]) if isinstance(t.get("tool_input"), str) else t.get("tool_input"),
            result=t.get("result"),
            result_metadata=json.loads(t["result_metadata"]) if isinstance(t.get("result_metadata"), str) else t.get("result_metadata", {}),
            error_message=t.get("error_message"),
            sort_order=t.get("sort_order", 0),
            triggered_by=t.get("triggered_by", "user"),
            started_at=t.get("started_at"),
            completed_at=t.get("completed_at"),
            created_at=t["created_at"],
            updated_at=t["updated_at"],
        ))

    return TaskListResponse(
        tasks=task_responses,
        total=len(task_responses),
        pending=sum(1 for t in tasks if t.get("status") == "pending"),
        in_progress=sum(1 for t in tasks if t.get("status") == "in_progress"),
        completed=sum(1 for t in tasks if t.get("status") == "completed"),
        failed=sum(1 for t in tasks if t.get("status") == "failed"),
    )


@router.patch("/projects/{project_id}/tasks/{task_id}")
async def update_task(
    project_id: str,
    task_id: str,
    data: TaskUpdate,
    current_user: str = Depends(get_current_user),
):
    """Update a task (e.g., approve, cancel)."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    update_fields = {}
    if data.status:
        update_fields["status"] = data.status.value
    if data.result:
        update_fields["result"] = data.result
    if data.error_message:
        update_fields["error_message"] = data.error_message

    updated = await memory.update_task(task_id, project_id, **update_fields)
    if not updated:
        raise HTTPException(status_code=404, detail="Task not found")

    return {"status": "updated", "task": updated}


# =============================================================================
# INSTRUCTIONS
# =============================================================================

@router.post("/projects/{project_id}/instructions")
async def add_instruction(
    project_id: str,
    data: InstructionCreate,
    current_user: str = Depends(get_current_user),
):
    """Add an instruction step to a project."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    instruction = await memory.create_instruction(project_id, data.model_dump())
    return {"status": "created", "instruction": instruction}


@router.get("/projects/{project_id}/instructions")
async def list_instructions(
    project_id: str,
    current_user: str = Depends(get_current_user),
):
    """List all instructions for a project."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    instructions = await memory.get_instructions(project_id)
    return {"instructions": instructions, "total": len(instructions)}


# =============================================================================
# AGENT STATUS
# =============================================================================

@router.get("/projects/{project_id}/agent/status")
async def get_agent_status(
    project_id: str,
    current_user: str = Depends(get_current_user),
):
    """Get current agent status for a project."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    agent = get_project_agent()
    status = await agent.get_status(project_id)
    return status.model_dump(mode='json')


# =============================================================================
# SHELL / GIT OPERATIONS
# =============================================================================

@router.post("/projects/{project_id}/shell/exec")
async def exec_shell_command(
    project_id: str,
    command: str = Form(...),
    timeout: int = Form(30),
    current_user: str = Depends(get_current_user),
):
    """Execute a shell command in the project workspace."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    shell = get_shell_service()
    try:
        result = await shell.exec_command(
            project_id=project_id,
            command=command,
            timeout=timeout,
        )
        return result.model_dump()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/projects/{project_id}/git/log")
async def get_git_log(
    project_id: str,
    limit: int = Query(20, ge=1, le=100),
    current_user: str = Depends(get_current_user),
):
    """Get git log for a project."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    shell = get_shell_service()
    try:
        result = await shell.git_log(project_id, limit)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/projects/{project_id}/git/diff")
async def get_git_diff(
    project_id: str,
    current_user: str = Depends(get_current_user),
):
    """Get git diff for a project."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    shell = get_shell_service()
    try:
        result = await shell.git_diff(project_id)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/projects/{project_id}/files")
async def list_files(
    project_id: str,
    path: str = ".",
    recursive: bool = False,
    current_user: str = Depends(get_current_user),
):
    """List files in the project workspace."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    shell = get_shell_service()
    try:
        result = await shell.file_list(project_id, path, recursive)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# EMAIL GATEWAY WEBHOOK
# =============================================================================

@router.post("/email/inbound")
async def receive_inbound_email(
    data: dict,
):
    """
    Webhook endpoint for receiving inbound emails.
    Called by email provider (SendGrid Inbound Parse, Mailgun, etc.)
    """
    gateway = get_email_gateway()

    try:
        email_data = InboundEmail.from_webhook(data)
        result = await gateway.process_inbound_email(email_data)
        return result
    except Exception as e:
        logger.error(f"Inbound email processing failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{project_id}/email/generate")
async def generate_project_email(
    project_id: str,
    current_user: str = Depends(get_current_user),
):
    """Generate a unique email address for a project."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    gateway = get_email_gateway()
    email_addr = await gateway.generate_project_email(project_id)
    return {"email": email_addr, "project_id": project_id}


# =============================================================================
# DOCUMENT UPLOAD
# =============================================================================

@router.post("/projects/{project_id}/documents")
async def upload_document(
    project_id: str,
    file: UploadFile = File(...),
    current_user: str = Depends(get_current_user),
):
    """Upload a document to a project."""
    memory = get_project_memory_service()

    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    # Create document record
    doc_record = await memory.create_document_record(
        project_id=project_id,
        filename=file.filename,
        original_filename=file.filename,
        file_type=file.content_type,
        file_size=file.size,
        uploaded_by=current_user,
    )

    # Read raw file bytes
    raw_content = await file.read()
    doc_id_str = str(doc_record["id"])

    # Determine if the file is binary (PDF, docx, etc.) or plain text
    BINARY_TYPES = {
        'application/pdf', 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel', 'application/octet-stream',
        'image/jpeg', 'image/png', 'image/bmp', 'image/tiff',
    }
    is_binary = (file.content_type or '').lower() in BINARY_TYPES or (
        file.filename and file.filename.lower().endswith(('.pdf', '.docx', '.doc', '.xlsx', '.xls'))
    )

    # For binary files, use doc-processor to convert to markdown
    # For text files, decode directly
    markdown_content = ""
    content_text = ""

    if is_binary:
        try:
            doc_client = DocProcessorClient()
            proc_result = await doc_client.process_bytes(
                file_bytes=raw_content,
                filename=file.filename,
                user_id=current_user,
            )
            if proc_result.get("success") and proc_result.get("content"):
                markdown_content = proc_result["content"]
                content_text = markdown_content
                logger.info(f"Doc-processor converted {file.filename} to markdown ({len(markdown_content)} chars)")
            else:
                logger.warning(f"Doc-processor failed for {file.filename}: {proc_result.get('error')}")
                content_text = f"[Binary file: {file.filename} - {file.content_type}]"
        except Exception as e:
            logger.warning(f"Doc-processor unavailable for {file.filename}: {e}")
            content_text = f"[Binary file: {file.filename} - {file.content_type}]"
    else:
        content_text = raw_content.decode("utf-8", errors="replace").replace('\x00', '')
        markdown_content = content_text

    # Save document content to shell-service workspace for version control
    shell = get_shell_service()
    try:
        # Create documents directory first
        await shell.exec_command(project_id=project_id, command="mkdir -p documents", timeout=10)
        # Write text/markdown content using file_write API
        write_content = markdown_content or content_text
        await shell.file_write(
            project_id=project_id,
            path=f"documents/{file.filename}",
            content=write_content[:50000],  # Limit size for text transport
        )
        # Also save as .md if we have markdown from doc-processor
        if markdown_content and is_binary:
            md_filename = file.filename.rsplit('.', 1)[0] + '.md'
            await shell.file_write(
                project_id=project_id,
                path=f"documents/{md_filename}",
                content=markdown_content[:50000],
            )
        logger.info(f"Saved document to shell workspace: {file.filename}")
    except Exception as e:
        logger.warning(f"Failed to save document to shell workspace: {e}")

    # -----------------------------------------------------------------
    # Direct document processing (no COT/agent - reliable and fast)
    # -----------------------------------------------------------------
    processing_results = {
        "convert_markdown": "skipped",
        "save_workspace": "skipped",
        "semantic_index": "skipped",
        "git_commit": "skipped",
    }

    # Step 1: Markdown conversion already done above
    processing_results["convert_markdown"] = "completed" if markdown_content else "no_content"

    # Step 2: Workspace save already done above
    processing_results["save_workspace"] = "completed"

    # Step 3: Index content in Qdrant for semantic search
    indexable_content = markdown_content or content_text
    chunks_stored = 0
    if indexable_content and len(indexable_content) > 10:
        try:
            qdrant = memory.qdrant
            if qdrant:
                # Chunk content into segments (~500 chars each with overlap)
                chunk_dicts = []
                chunk_size = 500
                overlap = 50
                text = indexable_content.strip()
                i = 0
                chunk_idx = 0
                while i < len(text):
                    end = min(i + chunk_size, len(text))
                    chunk_text = text[i:end]
                    if chunk_text.strip():
                        chunk_dicts.append({
                            "text": chunk_text.strip(),
                            "section_title": file.filename,
                            "chunk_index": chunk_idx,
                            "metadata": {"filename": file.filename, "document_id": doc_id_str},
                        })
                        chunk_idx += 1
                    i += chunk_size - overlap

                if chunk_dicts:
                    success = qdrant.add_document_chunks(
                        user_id="project",
                        document_id=doc_id_str,
                        chunks=chunk_dicts,
                        project_oenum=project_id,
                    )
                    chunks_stored = len(chunk_dicts) if success else 0
                    processing_results["semantic_index"] = f"completed ({chunks_stored} chunks)"
                    logger.info(f"Indexed {chunks_stored} chunks for {file.filename}")
                else:
                    processing_results["semantic_index"] = "no_chunks"
            else:
                processing_results["semantic_index"] = "qdrant_unavailable"
        except Exception as e:
            logger.warning(f"Semantic indexing failed for {file.filename}: {e}")
            processing_results["semantic_index"] = f"error: {str(e)[:100]}"

    # Step 4: Git commit (init if needed)
    try:
        try:
            commit_result = await shell.git_commit(
                project_id, f"Add document: {file.filename}"
            )
        except Exception as init_err:
            if "not initialized" in str(init_err).lower():
                await shell.git_init(project_id)
                commit_result = await shell.git_commit(
                    project_id, f"Add document: {file.filename}"
                )
            else:
                raise
        if commit_result.get("status") == "committed":
            processing_results["git_commit"] = "completed"
        else:
            processing_results["git_commit"] = commit_result.get("status", "unknown")
    except Exception as e:
        logger.warning(f"Git commit failed for {file.filename}: {e}")
        processing_results["git_commit"] = f"error: {str(e)[:100]}"

    # Store a document message in project history (no agent/COT trigger)
    content_summary = indexable_content[:500] if indexable_content else file.filename
    await memory.store_message(
        project_id=project_id,
        role="user",
        content=f"Document uploaded: {file.filename}",
        channel="document",
        document_id=doc_id_str,
        document_filename=file.filename,
    )
    await memory.store_message(
        project_id=project_id,
        role="assistant",
        content=(
            f"Document **{file.filename}** has been processed:\n\n"
            f"- Converted to markdown ({len(markdown_content)} chars)\n"
            f"- Saved to workspace\n"
            f"- Indexed {chunks_stored} chunks for semantic search\n"
            f"- Git: {processing_results['git_commit']}\n\n"
            f"You can now ask questions about this document."
        ),
        channel="document",
        document_id=doc_id_str,
        document_filename=file.filename,
    )

    # Update document record
    try:
        await memory.update_document(
            doc_id_str,
            processing_status="completed",
            chunk_count=chunks_stored,
            content_summary=content_summary,
        )
    except Exception:
        pass

    return {
        "document_id": doc_id_str,
        "filename": file.filename,
        "status": "completed",
        "markdown_length": len(markdown_content),
        "chunks_indexed": chunks_stored,
        "processing": processing_results,
    }


# =============================================================================
# ROUTE REGISTRATION
# =============================================================================

def include_project_agent_routes(app):
    """Include project agent routes in FastAPI app."""
    app.include_router(router)
    logger.info("Included project agent routes (/api/v2/agent/*)")
