"""
OpenAI-compatible API schemas

Pydantic models that match OpenAI's chat completion API format.
"""

from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any, Literal, Union
from enum import Enum


class Role(str, Enum):
    """Message role"""
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


class ChatMessage(BaseModel):
    """Chat message in OpenAI format"""
    role: Role
    content: str
    name: Optional[str] = None
    tool_calls: Optional[List[Dict[str, Any]]] = None
    tool_call_id: Optional[str] = None


class ChatCompletionRequest(BaseModel):
    """Request body for /v1/chat/completions"""
    model: str = Field(default="unsloth/gpt-oss-20b", description="Model name")
    messages: List[ChatMessage] = Field(..., description="List of chat messages")
    temperature: Optional[float] = Field(default=0.7, ge=0.0, le=2.0)
    top_p: Optional[float] = Field(default=1.0, ge=0.0, le=1.0)
    n: Optional[int] = Field(default=1, ge=1, le=1, description="Only n=1 supported")
    stream: Optional[bool] = Field(default=False)
    max_tokens: Optional[int] = Field(default=1024, ge=1, le=8000)
    presence_penalty: Optional[float] = Field(default=0.0)
    frequency_penalty: Optional[float] = Field(default=0.0)
    logit_bias: Optional[Dict[str, float]] = None
    user: Optional[str] = None

    # Tool/function calling (for LangChain integration)
    tools: Optional[List[Dict[str, Any]]] = None
    tool_choice: Optional[Union[str, Dict[str, Any]]] = None

    # Custom parameters
    reasoning_effort: Optional[str] = Field(default="medium", pattern="^(low|medium|high)$")


class UsageInfo(BaseModel):
    """Token usage information"""
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class ChatCompletionResponseChoice(BaseModel):
    """Individual choice in completion response"""
    index: int
    message: ChatMessage
    finish_reason: Literal["stop", "length", "tool_calls", "content_filter"] = "stop"


class ChatCompletionResponse(BaseModel):
    """Response for /v1/chat/completions (non-streaming)"""
    id: str
    object: Literal["chat.completion"] = "chat.completion"
    created: int
    model: str
    choices: List[ChatCompletionResponseChoice]
    usage: UsageInfo
    system_fingerprint: Optional[str] = None


class ChatCompletionStreamResponseDelta(BaseModel):
    """Delta for streaming response"""
    role: Optional[Role] = None
    content: Optional[str] = None
    tool_calls: Optional[List[Dict[str, Any]]] = None


class ChatCompletionStreamResponseChoice(BaseModel):
    """Choice for streaming response"""
    index: int
    delta: ChatCompletionStreamResponseDelta
    finish_reason: Optional[Literal["stop", "length", "tool_calls", "content_filter"]] = None


class ChatCompletionStreamResponse(BaseModel):
    """Streaming response chunk for /v1/chat/completions"""
    id: str
    object: Literal["chat.completion.chunk"] = "chat.completion.chunk"
    created: int
    model: str
    choices: List[ChatCompletionStreamResponseChoice]
    system_fingerprint: Optional[str] = None


class HealthResponse(BaseModel):
    """Health check response"""
    status: str
    model: str
    precision: str
    gpu_available: bool
    gpu_memory_allocated_gb: Optional[float] = None
    gpu_memory_reserved_gb: Optional[float] = None
    model_loaded: bool
    engine: str


class ErrorResponse(BaseModel):
    """Error response"""
    error: Dict[str, Any]


class ModelInfo(BaseModel):
    """Model information for /v1/models endpoint"""
    id: str
    object: Literal["model"] = "model"
    created: int
    owned_by: str = "simorgh-ai"


class ModelsListResponse(BaseModel):
    """Response for /v1/models endpoint"""
    object: Literal["list"] = "list"
    data: List[ModelInfo]


# ============================================================================
# Legacy Endpoints (for backward compatibility with simorgh-agent backend)
# ============================================================================

class LegacyGenerateRequest(BaseModel):
    """Legacy generate request format (from ai_server.py)"""
    system_prompt: str
    user_prompt: str
    thinking_level: str = Field(default="medium", pattern="^(low|medium|high)$")
    max_tokens: Optional[int] = Field(default=None, ge=100, le=8000)
    stream: bool = Field(default=False)
    use_tools: Optional[bool] = Field(
        default=None,
        description="Whether to use tools (search, Wikipedia). If None, auto-detect based on query content."
    )


class LegacyGenerateResponse(BaseModel):
    """Legacy generate response format"""
    output: str
    tokens_used: int
    thinking_level: str
