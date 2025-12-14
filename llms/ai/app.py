"""
Enhanced AI Server with vLLM, LangChain, and OpenAI-compatible API

Features:
- vLLM with 16-bit precision (fallback to 4-bit)
- OpenAI-compatible chat completion endpoints
- LangChain tool orchestration (search, Python REPL)
- Streaming support with SSE
- Async request handling
- Prometheus metrics
- Health checks and monitoring
"""

import asyncio
import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse, JSONResponse
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST
from pydantic import ValidationError

from api.schemas import (
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatCompletionResponseChoice,
    ChatCompletionStreamResponse,
    ChatCompletionStreamResponseChoice,
    ChatCompletionStreamResponseDelta,
    ChatMessage,
    UsageInfo,
    HealthResponse,
    ModelsListResponse,
    ModelInfo,
    ErrorResponse,
    Role,
    SimorghChatRequest,
    SimorghChatResponse,
)
from services.model_manager import ModelManager
from services.langchain_agent import create_agent_with_tools

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# ============================================================================
# Global State
# ============================================================================
model_manager: Optional[ModelManager] = None
langchain_agent = None

# Concurrency control
MAX_CONCURRENT_REQUESTS = 4
request_semaphore = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)

# ============================================================================
# Prometheus Metrics
# ============================================================================
request_counter = Counter(
    'ai_requests_total',
    'Total number of AI requests',
    ['endpoint', 'status']
)

request_duration = Histogram(
    'ai_request_duration_seconds',
    'Request duration in seconds',
    ['endpoint']
)

tokens_generated = Counter(
    'ai_tokens_generated_total',
    'Total tokens generated',
    ['model']
)

# ============================================================================
# Lifespan Management
# ============================================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Lifespan context manager for startup/shutdown.
    """
    # Startup
    logger.info("=" * 60)
    logger.info("Starting AI Service")
    logger.info("=" * 60)

    global model_manager, langchain_agent

    try:
        # Initialize model manager
        model_manager = ModelManager(
            model_name="unsloth/gpt-oss-20b",
            model_path="/models/unsloth-gpt-oss-20b-16bit",
            max_model_len=4096,
            gpu_memory_utilization=0.9,
            lora_adapter_path="./saved_lora_adapters",
        )

        await model_manager.initialize()

        # Initialize LangChain agent with tools
        import os
        enable_search = os.getenv("ENABLE_SEARCH_TOOL", "true").lower() == "true"
        enable_python = os.getenv("ENABLE_PYTHON_REPL", "false").lower() == "true"

        langchain_agent = create_agent_with_tools(
            model_manager=model_manager,
            enable_search=enable_search,
            enable_python_repl=enable_python,
            verbose=os.getenv("AGENT_VERBOSE", "false").lower() == "true"
        )

        logger.info("✅ Service initialization complete")

    except Exception as e:
        logger.error(f"❌ Service initialization failed: {e}")
        raise

    yield

    # Shutdown
    logger.info("Shutting down AI Service")
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

# ============================================================================
# FastAPI App
# ============================================================================
app = FastAPI(
    title="Simorgh AI Service",
    description="OpenAI-compatible AI inference with vLLM and LangChain tools",
    version="2.0.0",
    lifespan=lifespan
)

# ============================================================================
# Health & Monitoring Endpoints
# ============================================================================
@app.get("/health", response_model=HealthResponse)
async def health_check():
    """
    Health check endpoint.
    Returns model status and GPU metrics.
    """
    if model_manager is None:
        raise HTTPException(status_code=503, detail="Model not initialized")

    status_info = model_manager.get_status()

    return HealthResponse(
        status="healthy" if status_info["model_loaded"] else "initializing",
        model=status_info["model_name"],
        precision=status_info["precision"],
        gpu_available=torch.cuda.is_available(),
        gpu_memory_allocated_gb=status_info.get("gpu_memory_allocated_gb"),
        gpu_memory_reserved_gb=status_info.get("gpu_memory_reserved_gb"),
        model_loaded=status_info["model_loaded"],
        engine=status_info["engine"],
    )


@app.get("/metrics")
async def metrics():
    """
    Prometheus metrics endpoint.
    """
    return JSONResponse(
        content=generate_latest().decode("utf-8"),
        media_type=CONTENT_TYPE_LATEST
    )


@app.get("/v1/models", response_model=ModelsListResponse)
async def list_models():
    """
    List available models (OpenAI-compatible).
    """
    if model_manager is None:
        return ModelsListResponse(data=[])

    return ModelsListResponse(
        data=[
            ModelInfo(
                id=model_manager.model_name,
                created=int(time.time()),
                owned_by="simorgh-ai"
            )
        ]
    )

# ============================================================================
# Chat Completion Endpoints
# ============================================================================
@app.post("/v1/chat/completions")
async def chat_completions(request: ChatCompletionRequest):
    """
    OpenAI-compatible chat completion endpoint.

    Supports:
    - Non-streaming responses (stream=false)
    - Streaming responses (stream=true) via SSE
    - Tool usage with LangChain
    """
    if model_manager is None:
        request_counter.labels(endpoint="chat_completions", status="error").inc()
        raise HTTPException(status_code=503, detail="Model not initialized")

    # Streaming response
    if request.stream:
        return StreamingResponse(
            stream_chat_completion(request),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            }
        )

    # Non-streaming response
    return await non_streaming_chat_completion(request)


async def non_streaming_chat_completion(
    request: ChatCompletionRequest
) -> ChatCompletionResponse:
    """
    Handle non-streaming chat completion.
    """
    start_time = time.time()

    try:
        async with request_semaphore:
            # Convert messages to dict format
            messages = [
                {"role": msg.role.value, "content": msg.content}
                for msg in request.messages
            ]

            # Check if we should use tools
            use_tools = request.tools is not None or _should_use_tools(messages)

            if use_tools and langchain_agent:
                # Use LangChain agent with tools
                result = await langchain_agent.run_with_messages(
                    messages=messages,
                    use_tools=True
                )
                output = result["output"]
                tokens_used = result.get("tokens_used", 0) or len(output.split())
            else:
                # Direct generation without tools
                output, tokens_used = await model_manager.generate(
                    messages=messages,
                    max_tokens=request.max_tokens,
                    temperature=request.temperature,
                    top_p=request.top_p,
                    reasoning_effort=request.reasoning_effort,
                )

            # Create response
            completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
            created = int(time.time())

            response = ChatCompletionResponse(
                id=completion_id,
                created=created,
                model=request.model,
                choices=[
                    ChatCompletionResponseChoice(
                        index=0,
                        message=ChatMessage(
                            role=Role.ASSISTANT,
                            content=output
                        ),
                        finish_reason="stop"
                    )
                ],
                usage=UsageInfo(
                    prompt_tokens=_estimate_tokens(messages),
                    completion_tokens=tokens_used,
                    total_tokens=_estimate_tokens(messages) + tokens_used
                )
            )

            # Metrics
            duration = time.time() - start_time
            request_counter.labels(endpoint="chat_completions", status="success").inc()
            request_duration.labels(endpoint="chat_completions").observe(duration)
            tokens_generated.labels(model=request.model).inc(tokens_used)

            return response

    except Exception as e:
        logger.error(f"Chat completion failed: {e}")
        request_counter.labels(endpoint="chat_completions", status="error").inc()
        raise HTTPException(status_code=500, detail=str(e))


async def stream_chat_completion(
    request: ChatCompletionRequest
) -> AsyncIterator[str]:
    """
    Handle streaming chat completion with Server-Sent Events.
    """
    start_time = time.time()
    completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())

    try:
        async with request_semaphore:
            # Convert messages
            messages = [
                {"role": msg.role.value, "content": msg.content}
                for msg in request.messages
            ]

            # Stream generation
            async for chunk in model_manager.generate_stream(
                messages=messages,
                max_tokens=request.max_tokens,
                temperature=request.temperature,
                top_p=request.top_p,
                reasoning_effort=request.reasoning_effort,
            ):
                # Create SSE chunk
                stream_chunk = ChatCompletionStreamResponse(
                    id=completion_id,
                    created=created,
                    model=request.model,
                    choices=[
                        ChatCompletionStreamResponseChoice(
                            index=0,
                            delta=ChatCompletionStreamResponseDelta(
                                content=chunk
                            ),
                            finish_reason=None
                        )
                    ]
                )

                # Yield as SSE
                yield f"data: {stream_chunk.model_dump_json()}\n\n"

            # Send final chunk with finish_reason
            final_chunk = ChatCompletionStreamResponse(
                id=completion_id,
                created=created,
                model=request.model,
                choices=[
                    ChatCompletionStreamResponseChoice(
                        index=0,
                        delta=ChatCompletionStreamResponseDelta(content=""),
                        finish_reason="stop"
                    )
                ]
            )
            yield f"data: {final_chunk.model_dump_json()}\n\n"
            yield "data: [DONE]\n\n"

            # Metrics
            duration = time.time() - start_time
            request_counter.labels(endpoint="chat_completions_stream", status="success").inc()
            request_duration.labels(endpoint="chat_completions_stream").observe(duration)

    except Exception as e:
        logger.error(f"Streaming failed: {e}")
        request_counter.labels(endpoint="chat_completions_stream", status="error").inc()

        # Send error as SSE
        error_data = {
            "error": {
                "message": str(e),
                "type": "server_error",
                "code": "internal_error"
            }
        }
        yield f"data: {error_data}\n\n"


def _should_use_tools(messages: list) -> bool:
    """
    Heuristic to determine if tools should be used.
    """
    # Check if any message mentions search, calculation, etc.
    tool_keywords = [
        "search", "look up", "find information",
        "calculate", "compute", "math", "analysis"
    ]

    for msg in messages:
        content = msg.get("content", "").lower()
        if any(keyword in content for keyword in tool_keywords):
            return True

    return False


def _estimate_tokens(messages: list) -> int:
    """
    Rough token estimation for usage stats.
    """
    total_chars = sum(len(msg.get("content", "")) for msg in messages)
    return total_chars // 4  # Rough approximation


# ============================================================================
# Legacy Endpoints (for backward compatibility)
# ============================================================================
@app.post("/generate")
async def legacy_generate(request: dict):
    """
    Legacy generate endpoint for backward compatibility.
    """
    try:
        # Convert to ChatCompletionRequest format
        messages = [
            ChatMessage(role=Role.SYSTEM, content=request.get("system_prompt", "")),
            ChatMessage(role=Role.USER, content=request.get("user_prompt", ""))
        ]

        chat_request = ChatCompletionRequest(
            model="unsloth/gpt-oss-20b",
            messages=messages,
            max_tokens=request.get("max_tokens"),
            stream=False
        )

        response = await non_streaming_chat_completion(chat_request)

        # Convert to legacy format
        return {
            "output": response.choices[0].message.content,
            "tokens_used": response.usage.completion_tokens,
            "thinking_level": request.get("thinking_level", "medium")
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Simorgh Frontend Compatibility Endpoint
# ============================================================================
@app.post("/api/chat/send", response_model=SimorghChatResponse)
async def simorgh_chat_send(request: SimorghChatRequest):
    """
    Simorgh frontend compatibility endpoint.

    Converts Simorgh frontend format to OpenAI format and back.
    This allows the AI service to work standalone without the full simorgh-agent backend.
    """
    if model_manager is None:
        request_counter.labels(endpoint="simorgh_chat_send", status="error").inc()
        raise HTTPException(status_code=503, detail="Model not initialized")

    start_time = time.time()

    try:
        async with request_semaphore:
            # Build message history from conversation_history + new content
            messages = []

            # Add conversation history if provided
            if request.conversation_history:
                messages.extend([
                    {"role": msg.get("role", "user"), "content": msg.get("content", "")}
                    for msg in request.conversation_history
                ])

            # Add current user message
            messages.append({"role": "user", "content": request.content})

            # Check if we should use tools (based on heuristic)
            use_tools = _should_use_tools(messages)

            if use_tools and langchain_agent:
                # Use LangChain agent with tools
                result = await langchain_agent.run_with_messages(
                    messages=messages,
                    use_tools=True
                )
                output = result["output"]
                tokens_used = result.get("tokens_used", 0) or len(output.split())
            else:
                # Direct generation without tools
                output, tokens_used = await model_manager.generate(
                    messages=messages,
                    max_tokens=1024,  # Default for chat
                    temperature=0.7,
                    top_p=0.95,
                )

            # Create Simorgh-compatible response
            response = SimorghChatResponse(
                response=output,
                llm_mode="offline",  # This service only supports offline mode
                context_used=False,  # Graph context not available in standalone mode
                cached_response=False,  # No caching in standalone mode
                tokens=tokens_used,
                spec_task_id=None  # Spec extraction not available in standalone mode
            )

            # Metrics
            duration = time.time() - start_time
            request_counter.labels(endpoint="simorgh_chat_send", status="success").inc()
            request_duration.labels(endpoint="simorgh_chat_send").observe(duration)
            tokens_generated.labels(model="unsloth/gpt-oss-20b").inc(tokens_used)

            logger.info(f"Simorgh chat request processed in {duration:.2f}s, {tokens_used} tokens")

            return response

    except Exception as e:
        logger.error(f"Simorgh chat send failed: {e}")
        request_counter.labels(endpoint="simorgh_chat_send", status="error").inc()
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Error Handlers
# ============================================================================
@app.exception_handler(ValidationError)
async def validation_exception_handler(request: Request, exc: ValidationError):
    """Handle validation errors"""
    return JSONResponse(
        status_code=422,
        content={"error": {"message": str(exc), "type": "validation_error"}}
    )


@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    """Handle general exceptions"""
    logger.error(f"Unhandled exception: {exc}")
    return JSONResponse(
        status_code=500,
        content={"error": {"message": "Internal server error", "type": "server_error"}}
    )


# ============================================================================
# Main
# ============================================================================
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=9000,
        log_level="info",
        access_log=True
    )
