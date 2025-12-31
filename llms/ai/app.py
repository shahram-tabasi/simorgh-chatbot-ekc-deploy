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
    LegacyGenerateRequest,
    LegacyGenerateResponse,
)
from services.model_manager import ModelManager
from services.langchain_agent import create_agent_with_tools

# Import output parser for cleaning LLM responses
try:
    from utils.output_parser import (
        OutputParser,
        StreamingOutputParser,
        parse_llm_output,
        create_streaming_parser,
        sanitize_for_user
    )
    OUTPUT_PARSER_AVAILABLE = True
except ImportError:
    OUTPUT_PARSER_AVAILABLE = False
    logger = logging.getLogger(__name__)
    logger.warning("⚠️ Output parser not available")

    # Fallback functions if parser not available
    def parse_llm_output(x): return x
    def sanitize_for_user(x): return x
    def create_streaming_parser(): return None

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
            max_model_len=8196,  # Updated for NVIDIA A30 GPU capability
            gpu_memory_utilization=0.9,
            lora_adapter_path="./saved_lora_adapters",
        )

        await model_manager.initialize()

        # Initialize LangChain agent with tools
        import os
        enable_search = os.getenv("ENABLE_SEARCH_TOOL", "true").lower() == "true"
        enable_python = os.getenv("ENABLE_PYTHON_REPL", "false").lower() == "true"
        enable_wikipedia = os.getenv("ENABLE_WIKIPEDIA_TOOL", "true").lower() == "true"

        langchain_agent = create_agent_with_tools(
            model_manager=model_manager,
            enable_search=enable_search,
            enable_python_repl=enable_python,
            enable_wikipedia=enable_wikipedia,
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
                raw_output = result["output"]
                tokens_used = result.get("tokens_used", 0) or len(raw_output.split())
            else:
                # Direct generation without tools
                raw_output, tokens_used = await model_manager.generate(
                    messages=messages,
                    max_tokens=request.max_tokens,
                    temperature=request.temperature,
                    top_p=request.top_p,
                    reasoning_effort=request.reasoning_effort,
                )

            # Parse output to remove thinking sections
            if OUTPUT_PARSER_AVAILABLE:
                output = parse_llm_output(raw_output)
                logger.info(f"📝 Output parsed: {len(raw_output)} -> {len(output)} chars")
            else:
                output = raw_output

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

    Filters out thinking sections (<think>...</think>) from the stream
    so only the final answer is sent to the client.
    """
    start_time = time.time()
    completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())

    # Create streaming parser for filtering thinking sections
    streaming_parser = create_streaming_parser() if OUTPUT_PARSER_AVAILABLE else None

    try:
        async with request_semaphore:
            # Convert messages
            messages = [
                {"role": msg.role.value, "content": msg.content}
                for msg in request.messages
            ]

            # Stream generation with thinking section filtering
            async for chunk in model_manager.generate_stream(
                messages=messages,
                max_tokens=request.max_tokens,
                temperature=request.temperature,
                top_p=request.top_p,
                reasoning_effort=request.reasoning_effort,
            ):
                # Filter thinking sections if parser available
                if streaming_parser:
                    clean_chunk, in_thinking = streaming_parser.process_chunk(chunk)
                    if in_thinking or not clean_chunk:
                        # Skip chunks inside thinking sections
                        continue
                    chunk = clean_chunk

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
            logger.info(f"✅ Streaming completed in {duration:.2f}s")

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
    Detects keywords that suggest the user wants information from external sources.
    """
    # Keywords that suggest tool usage is needed
    tool_keywords = [
        # Search-related
        "search", "look up", "find information", "find out",
        "google", "browse", "internet",
        # Wikipedia-related
        "wikipedia", "wiki", "encyclopedia",
        # Standards and technical info
        "standard", "iec", "ieee", "nema", "ansi", "iso",
        "protection code", "relay code", "device number",
        # Calculation
        "calculate", "compute", "math",
        # Current information
        "current", "latest", "recent", "today", "2024", "2025",
        # Explicit requests
        "what is", "who is", "when was", "where is", "how does",
        "define", "explain", "describe",
    ]

    for msg in messages:
        content = msg.get("content", "").lower()
        if any(keyword in content for keyword in tool_keywords):
            return True

    return False


def _should_use_tools_for_prompt(prompt: str) -> bool:
    """
    Heuristic to determine if tools should be used based on user prompt.
    """
    messages = [{"role": "user", "content": prompt}]
    return _should_use_tools(messages)


def _estimate_tokens(messages: list) -> int:
    """
    Rough token estimation for usage stats.
    """
    total_chars = sum(len(msg.get("content", "")) for msg in messages)
    return total_chars // 4  # Rough approximation


# ============================================================================
# Legacy Endpoints (for backward compatibility with simorgh-agent backend)
# ============================================================================

# Thinking level to temperature mapping
THINKING_LEVEL_CONFIG = {
    "low": {"temperature": 0.05, "max_tokens": 1500},
    "medium": {"temperature": 0.1, "max_tokens": 3000},
    "high": {"temperature": 0.15, "max_tokens": 5000},
}


@app.post("/generate", response_model=LegacyGenerateResponse)
async def legacy_generate(request: LegacyGenerateRequest):
    """
    Legacy generate endpoint for backward compatibility.
    Used by simorgh-agent backend for non-streaming requests.

    Supports tool usage (Wikipedia, search) when use_tools=True or auto-detected.
    """
    if model_manager is None:
        raise HTTPException(status_code=503, detail="Model not initialized")

    try:
        # Get thinking level config
        config = THINKING_LEVEL_CONFIG.get(request.thinking_level, THINKING_LEVEL_CONFIG["medium"])
        max_tokens = request.max_tokens or config["max_tokens"]
        temperature = config["temperature"]

        # Determine if tools should be used
        use_tools = request.use_tools
        if use_tools is None:
            # Auto-detect based on query content
            use_tools = _should_use_tools_for_prompt(request.user_prompt)

        # Convert to message format
        messages = [
            {"role": "system", "content": request.system_prompt},
            {"role": "user", "content": request.user_prompt}
        ]

        # Generate response (with or without tools)
        if use_tools and langchain_agent:
            logger.info(f"🔧 Using LangChain agent with tools for query: {request.user_prompt[:100]}...")

            # Run agent with tools
            result = await langchain_agent.run_with_messages(
                messages=messages,
                use_tools=True
            )

            raw_output = result.get("output", "")
            tokens_used = result.get("tokens_used") or len(raw_output.split())
            tool_calls = result.get("tool_calls", [])

            if tool_calls:
                logger.info(f"🔧 Agent used {len(tool_calls)} tool(s): {[tc['tool'] for tc in tool_calls]}")
        else:
            # Direct generation without tools
            raw_output, tokens_used = await model_manager.generate(
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                top_p=0.95,
            )

        # Parse output to remove thinking sections
        if OUTPUT_PARSER_AVAILABLE:
            output = parse_llm_output(raw_output)
            logger.info(f"📝 Output parsed: {len(raw_output)} -> {len(output)} chars")
        else:
            output = raw_output

        return LegacyGenerateResponse(
            output=output,
            tokens_used=tokens_used,
            thinking_level=request.thinking_level
        )

    except Exception as e:
        logger.error(f"Legacy generate failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/generate-stream")
async def legacy_generate_stream(request: LegacyGenerateRequest):
    """
    Legacy streaming endpoint for backward compatibility.
    Used by simorgh-agent backend for streaming requests.

    Returns SSE (Server-Sent Events) format expected by the backend.
    """
    if model_manager is None:
        raise HTTPException(status_code=503, detail="Model not initialized")

    if not request.stream:
        raise HTTPException(status_code=400, detail="Stream parameter must be true")

    return StreamingResponse(
        legacy_stream_generation(request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


async def legacy_stream_generation(request: LegacyGenerateRequest) -> AsyncIterator[str]:
    """
    Stream generation in legacy SSE format.

    Backend expects format:
    data: {"status": "started", "thinking_level": "medium"}
    data: {"chunk": "partial text"}
    data: {"status": "completed", "output": "full text", "tokens_used": 123}

    Supports two modes:
    1. With tools (LangChain agent): First gets full result, then streams it in chunks
    2. Without tools (direct): Streams directly from model with thinking section filtering
    """
    import json

    try:
        # Get thinking level config
        config = THINKING_LEVEL_CONFIG.get(request.thinking_level, THINKING_LEVEL_CONFIG["medium"])
        max_tokens = request.max_tokens or config["max_tokens"]
        temperature = config["temperature"]

        # Determine if tools should be used
        use_tools = request.use_tools
        if use_tools is None:
            # Auto-detect based on query content
            use_tools = _should_use_tools_for_prompt(request.user_prompt)

        # Send started event with tool usage info
        yield f"data: {json.dumps({'status': 'started', 'thinking_level': request.thinking_level, 'using_tools': use_tools})}\n\n"

        # =========================================================================
        # MODE 1: With Tools (LangChain Agent)
        # =========================================================================
        if use_tools and langchain_agent:
            logger.info(f"🔧 Using LangChain agent with tools for query: {request.user_prompt[:100]}...")

            # Convert to message format
            messages = [
                {"role": "system", "content": request.system_prompt},
                {"role": "user", "content": request.user_prompt}
            ]

            # Run agent (non-streaming) to get result with tool usage
            result = await langchain_agent.run_with_messages(
                messages=messages,
                use_tools=True
            )

            raw_output = result.get("output", "")
            tool_calls = result.get("tool_calls", [])

            # Log tool usage
            if tool_calls:
                logger.info(f"🔧 Agent used {len(tool_calls)} tool(s): {[tc['tool'] for tc in tool_calls]}")

            # Parse output to remove thinking sections
            if OUTPUT_PARSER_AVAILABLE:
                final_output = parse_llm_output(raw_output)
                # Double-check with sanitize_for_user for any edge cases
                final_output = sanitize_for_user(final_output)
                logger.info(f"📝 Output parsed: {len(raw_output)} -> {len(final_output)} chars")
            else:
                final_output = raw_output

            # Ensure we have content to stream
            if not final_output or len(final_output.strip()) < 10:
                final_output = "I was unable to generate a complete response. Please try again."
                logger.warning("⚠️ Empty or minimal response after parsing, using fallback")

            # Stream the result in chunks for smooth UI
            chunk_size = 50  # Characters per chunk for smooth streaming effect
            for i in range(0, len(final_output), chunk_size):
                chunk = final_output[i:i + chunk_size]
                yield f"data: {json.dumps({'chunk': chunk})}\n\n"
                # Small delay for visual streaming effect
                await asyncio.sleep(0.02)

            # Send completion event
            tokens_used = result.get("tokens_used") or len(raw_output.split())
            completion_data = {
                'status': 'completed',
                'output': final_output,
                'tokens_used': tokens_used,
                'thinking_level': request.thinking_level,
                'tools_used': [tc['tool'] for tc in tool_calls] if tool_calls else []
            }
            yield f"data: {json.dumps(completion_data)}\n\n"

            logger.info(f"✅ Agent streaming completed - Raw: {len(raw_output)} chars, Clean: {len(final_output)} chars")

        # =========================================================================
        # MODE 2: Without Tools (Direct Streaming)
        # =========================================================================
        else:
            logger.info(f"📝 Direct streaming (no tools) for query: {request.user_prompt[:100]}...")

            # Create streaming parser for filtering thinking sections
            streaming_parser = create_streaming_parser() if OUTPUT_PARSER_AVAILABLE else None

            # Convert to message format
            messages = [
                {"role": "system", "content": request.system_prompt},
                {"role": "user", "content": request.user_prompt}
            ]

            # Stream generation with thinking section filtering
            full_output = ""
            clean_output = ""

            async for chunk in model_manager.generate_stream(
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                top_p=0.95,
            ):
                full_output += chunk

                # Filter thinking sections if parser available
                if streaming_parser:
                    clean_chunk, in_thinking = streaming_parser.process_chunk(chunk)
                    if in_thinking or not clean_chunk:
                        # Skip chunks inside thinking sections
                        continue
                    clean_output += clean_chunk
                    # Send clean chunk
                    yield f"data: {json.dumps({'chunk': clean_chunk})}\n\n"
                else:
                    clean_output += chunk
                    yield f"data: {json.dumps({'chunk': chunk})}\n\n"

            # Parse full output for final clean version (in case of any missed thinking sections)
            # Use the streaming parser's final output for guaranteed clean result
            if streaming_parser:
                final_output = streaming_parser.get_final_output()
            elif OUTPUT_PARSER_AVAILABLE:
                final_output = parse_llm_output(full_output)
            else:
                final_output = clean_output

            # Final sanitization to catch any edge cases
            if OUTPUT_PARSER_AVAILABLE:
                final_output = sanitize_for_user(final_output)

            # Send completion event with clean output
            tokens_used = len(full_output.split())  # Rough estimate
            completion_data = {
                'status': 'completed',
                'output': final_output,
                'tokens_used': tokens_used,
                'thinking_level': request.thinking_level,
                'tools_used': []
            }
            yield f"data: {json.dumps(completion_data)}\n\n"

            logger.info(f"✅ Direct streaming completed - Raw: {len(full_output)} chars, Clean: {len(final_output)} chars")

    except Exception as e:
        logger.error(f"Legacy streaming failed: {e}")
        logger.exception(e)
        error_data = {'status': 'error', 'error': str(e)}
        yield f"data: {json.dumps(error_data)}\n\n"


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
