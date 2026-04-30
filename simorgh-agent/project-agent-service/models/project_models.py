"""
Project Agent System Models
============================
Pydantic models for the Project Manager Agent, COT engine,
tasks, instructions, and multi-channel messaging.
"""

from datetime import datetime
from typing import Optional, List, Dict, Any
from uuid import UUID
from pydantic import BaseModel, Field
from enum import Enum


# =============================================================================
# ENUMS
# =============================================================================

class ProjectStatus(str, Enum):
    ACTIVE = "active"
    PAUSED = "paused"
    COMPLETED = "completed"
    ARCHIVED = "archived"


class TaskType(str, Enum):
    ACTION = "action"
    QUERY = "query"
    ANALYSIS = "analysis"
    GENERATION = "generation"
    REVIEW = "review"
    SHELL_COMMAND = "shell_command"
    EMAIL = "email"


class TaskStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    WAITING_APPROVAL = "waiting_approval"


class MessageChannel(str, Enum):
    CHAT = "chat"
    EMAIL = "email"
    DOCUMENT = "document"
    WEBHOOK = "webhook"
    SYSTEM = "system"


class MessageRole(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    TOOL = "tool"


class TaskTrigger(str, Enum):
    USER = "user"
    AGENT = "agent"
    EMAIL = "email"
    DOCUMENT = "document"
    SCHEDULE = "schedule"
    WEBHOOK = "webhook"


class InstructionStage(str, Enum):
    GENERAL = "general"
    ANALYSIS = "analysis"
    DESIGN = "design"
    IMPLEMENTATION = "implementation"
    REVIEW = "review"
    DEPLOYMENT = "deployment"


class DocumentProcessingStatus(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


# =============================================================================
# PROJECT MODELS
# =============================================================================

class ProjectCreate(BaseModel):
    """Request to create a new project (modern users: name only)."""
    name: str = Field(..., min_length=1, max_length=255, description="Project name")
    description: Optional[str] = Field(None, max_length=2000)
    tpms_oenum: Optional[str] = Field(None, description="TPMS OENUM (legacy users only)")
    agent_model: Optional[str] = Field("gpt-4o", description="LLM model for agent")
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict)
    # Which external sources to wire in for this project.
    # Valid values today: "techserver", "tpms", "tech_knowledge".
    # Frontend collects these from the precheck dialog (only the ones
    # whose probe came back green should be passed in).
    sources: List[str] = Field(default_factory=list,
                               description="External sources enabled for this project")


class ProjectSourcesPrecheckRequest(BaseModel):
    """Request to probe selected external sources before project creation."""
    sources: List[str] = Field(..., description="Subset of: techserver, tpms, tech_knowledge")
    tpms_oenum: Optional[str] = Field(None, description="Required when 'tpms' is in sources")


class ProjectSourcePrecheckResult(BaseModel):
    source: str           # e.g. "techserver"
    ok: bool
    detail: Optional[str] = None  # error message on failure


class ProjectSourcesPrecheckResponse(BaseModel):
    results: List[ProjectSourcePrecheckResult]


class ProjectUpdate(BaseModel):
    """Request to update a project."""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    status: Optional[ProjectStatus] = None
    agent_enabled: Optional[bool] = None
    agent_model: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class ProjectResponse(BaseModel):
    """Project response model."""
    id: UUID
    owner_id: str
    name: str
    description: Optional[str] = None
    tpms_oenum: Optional[str] = None
    status: ProjectStatus
    agent_enabled: bool
    agent_model: str
    git_repo_initialized: bool
    metadata: Dict[str, Any] = {}
    created_at: datetime
    updated_at: datetime
    # Counts (populated on list)
    task_count: Optional[int] = None
    active_task_count: Optional[int] = None
    message_count: Optional[int] = None
    document_count: Optional[int] = None


class ProjectListResponse(BaseModel):
    """Response for listing projects."""
    projects: List[ProjectResponse]
    total: int


# =============================================================================
# INSTRUCTION MODELS
# =============================================================================

class InstructionCreate(BaseModel):
    """Request to add an instruction step to a project."""
    step_number: int = Field(..., ge=1)
    title: str = Field(..., min_length=1, max_length=255)
    content: str = Field(..., min_length=1)
    dependencies: List[UUID] = Field(default_factory=list)
    allowed_tools: List[str] = Field(default_factory=list)
    stage: InstructionStage = InstructionStage.GENERAL
    requires_approval: bool = False
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict)


class InstructionUpdate(BaseModel):
    """Request to update an instruction."""
    title: Optional[str] = None
    content: Optional[str] = None
    dependencies: Optional[List[UUID]] = None
    allowed_tools: Optional[List[str]] = None
    stage: Optional[InstructionStage] = None
    requires_approval: Optional[bool] = None
    is_active: Optional[bool] = None


class InstructionResponse(BaseModel):
    """Instruction response model."""
    id: UUID
    project_id: UUID
    step_number: int
    title: str
    content: str
    dependencies: List[UUID] = []
    allowed_tools: List[str] = []
    stage: InstructionStage
    requires_approval: bool
    is_active: bool
    metadata: Dict[str, Any] = {}
    created_at: datetime
    updated_at: datetime


# =============================================================================
# TASK MODELS (COT-generated)
# =============================================================================

class TaskCreate(BaseModel):
    """Request to create a task (usually from COT engine)."""
    title: str = Field(..., min_length=1, max_length=500)
    description: Optional[str] = None
    task_type: TaskType = TaskType.ACTION
    instruction_id: Optional[UUID] = None
    parent_task_id: Optional[UUID] = None
    cot_chain_id: Optional[UUID] = None
    priority: int = Field(5, ge=1, le=10)
    tool_used: Optional[str] = None
    tool_input: Optional[Dict[str, Any]] = None
    sort_order: int = 0
    triggered_by: TaskTrigger = TaskTrigger.USER


class TaskUpdate(BaseModel):
    """Request to update a task."""
    status: Optional[TaskStatus] = None
    result: Optional[str] = None
    result_metadata: Optional[Dict[str, Any]] = None
    error_message: Optional[str] = None


class TaskResponse(BaseModel):
    """Task response model."""
    id: UUID
    project_id: UUID
    instruction_id: Optional[UUID] = None
    parent_task_id: Optional[UUID] = None
    cot_chain_id: Optional[UUID] = None
    title: str
    description: Optional[str] = None
    task_type: TaskType
    status: TaskStatus
    priority: int
    tool_used: Optional[str] = None
    tool_input: Optional[Dict[str, Any]] = None
    result: Optional[str] = None
    result_metadata: Dict[str, Any] = {}
    error_message: Optional[str] = None
    sort_order: int
    triggered_by: TaskTrigger
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    # Nested subtasks (populated on detail view)
    subtasks: Optional[List["TaskResponse"]] = None


class TaskListResponse(BaseModel):
    """Response for listing tasks."""
    tasks: List[TaskResponse]
    total: int
    pending: int = 0
    in_progress: int = 0
    completed: int = 0
    failed: int = 0


# =============================================================================
# COT (Chain of Thoughts) MODELS
# =============================================================================

class COTRequest(BaseModel):
    """Request to trigger COT analysis."""
    project_id: UUID
    user_input: str = Field(..., min_length=1)
    channel: MessageChannel = MessageChannel.CHAT
    chat_id: Optional[str] = None
    # Optional context
    document_id: Optional[UUID] = None
    email_subject: Optional[str] = None
    email_from: Optional[str] = None
    # Execution options
    auto_execute: bool = Field(True, description="Auto-execute generated tasks")
    max_tasks: int = Field(20, ge=1, le=50)


class COTStep(BaseModel):
    """A single step in the COT analysis."""
    step_number: int
    title: str
    description: str
    task_type: TaskType
    tool_needed: Optional[str] = None
    tool_input: Optional[Dict[str, Any]] = None
    depends_on: List[int] = Field(default_factory=list, description="Step numbers this depends on")
    priority: int = 5
    estimated_duration: Optional[str] = None


class COTAnalysis(BaseModel):
    """Result of COT analysis - the plan."""
    chain_id: UUID
    project_id: UUID
    user_input: str
    reasoning: str = Field(..., description="Agent's reasoning about the request")
    steps: List[COTStep]
    total_steps: int
    estimated_total_duration: Optional[str] = None


class COTExecutionProgress(BaseModel):
    """Real-time progress of COT execution."""
    chain_id: UUID
    project_id: UUID
    total_tasks: int
    completed_tasks: int
    current_task: Optional[TaskResponse] = None
    status: str  # 'planning', 'executing', 'completed', 'failed'
    progress_percent: float
    results: List[Dict[str, Any]] = []


# =============================================================================
# MESSAGE MODELS
# =============================================================================

class ProjectMessageCreate(BaseModel):
    """Request to send a message to project."""
    content: str = Field(..., min_length=1)
    channel: MessageChannel = MessageChannel.CHAT
    chat_id: Optional[str] = None
    # Email fields
    email_from: Optional[str] = None
    email_subject: Optional[str] = None
    # Document fields
    document_id: Optional[UUID] = None
    document_filename: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict)


class ProjectMessageResponse(BaseModel):
    """Message response model."""
    id: UUID
    project_id: UUID
    chat_id: Optional[str] = None
    channel: MessageChannel
    role: MessageRole
    content: str
    task_id: Optional[UUID] = None
    email_from: Optional[str] = None
    email_subject: Optional[str] = None
    document_id: Optional[UUID] = None
    document_filename: Optional[str] = None
    metadata: Dict[str, Any] = {}
    created_at: datetime


# =============================================================================
# SHELL SERVICE MODELS
# =============================================================================

class ShellCommandRequest(BaseModel):
    """Request to execute a shell command."""
    project_id: UUID
    command: str = Field(..., min_length=1, max_length=5000)
    working_dir: Optional[str] = None
    timeout: int = Field(30, ge=1, le=300, description="Timeout in seconds")
    environment: Optional[Dict[str, str]] = None


class ShellCommandResponse(BaseModel):
    """Response from shell command execution."""
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    command: str
    working_dir: str


class GitCommitRequest(BaseModel):
    """Request to create a git commit."""
    project_id: UUID
    message: str = Field(..., min_length=1, max_length=500)
    files: Optional[List[str]] = None  # None = all changes


class GitCommitResponse(BaseModel):
    """Response from git commit."""
    commit_hash: str
    message: str
    files_changed: List[str]
    timestamp: datetime


class GitLogResponse(BaseModel):
    """Git log response."""
    commits: List[Dict[str, Any]]
    total: int


# =============================================================================
# PROJECT DOCUMENT MODELS
# =============================================================================

class ProjectDocumentResponse(BaseModel):
    """Document response model."""
    id: UUID
    project_id: UUID
    filename: str
    original_filename: Optional[str] = None
    file_type: Optional[str] = None
    file_size: Optional[int] = None
    processing_status: DocumentProcessingStatus
    content_summary: Optional[str] = None
    chunk_count: int = 0
    entity_count: int = 0
    metadata: Dict[str, Any] = {}
    uploaded_by: Optional[str] = None
    created_at: datetime


# =============================================================================
# AGENT STATE MODELS
# =============================================================================

class AgentState(BaseModel):
    """Current state of the project manager agent."""
    project_id: UUID
    is_active: bool = True
    current_task_id: Optional[UUID] = None
    current_cot_chain_id: Optional[UUID] = None
    status: str = "idle"  # 'idle', 'planning', 'executing', 'waiting_approval'
    last_activity: Optional[datetime] = None
    pending_tasks: int = 0
    completed_tasks_today: int = 0
    error_count: int = 0


# Enable forward references
TaskResponse.model_rebuild()
