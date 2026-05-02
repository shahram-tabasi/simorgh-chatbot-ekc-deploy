"""
Enhanced AI Server with FastAPI
- Async request handling
- GPU resource management
- JSON streaming support
- Configurable thinking levels
- Max token control
"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from typing import Optional, AsyncIterator
import torch
import gc
import asyncio
import json
import re
from io import StringIO
from transformers import TextStreamer
from unsloth import FastLanguageModel
from peft import PeftModel
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ============================================================================
# Global State
# ============================================================================
app = FastAPI(title="AI Generation API")
model = None
tokenizer = None
model_lock = asyncio.Lock()

# Thinking level configurations
THINKING_CONFIGS = {
    "low": {
        "max_new_tokens": 1500,
        "temperature": 0.05,
        "reasoning_effort": "low"
    },
    "medium": {
        "max_new_tokens": 3000,
        "temperature": 0.1,
        "reasoning_effort": "medium"
    },
    "high": {
        "max_new_tokens": 5000,
        "temperature": 0.15,
        "reasoning_effort": "high"
    }
}

# ============================================================================
# Pydantic Models
# ============================================================================
class GenerateRequest(BaseModel):
    system_prompt: str
    user_prompt: str
    thinking_level: str = Field(default="medium", pattern="^(low|medium|high)$")
    max_tokens: Optional[int] = Field(default=None, ge=100, le=8000)
    stream: bool = Field(default=False)

class GenerateResponse(BaseModel):
    output: str
    tokens_used: int
    thinking_level: str

class HealthResponse(BaseModel):
    status: str
    gpu_available: bool
    gpu_memory_allocated: float
    gpu_memory_reserved: float
    model_loaded: bool

# ============================================================================
# Model Initialization
# ============================================================================
async def initialize_model():
    """Initialize model with correct parameters for gpt-oss."""
    global model, tokenizer
    
    if model is not None:
        logger.info("Model already initialized")
        return
    
    logger.info("Initializing model...")
    
    gc.collect()
    torch.cuda.empty_cache()
    
    try:
        # Initialize without unsupported parameters
        model, tokenizer = FastLanguageModel.from_pretrained(
            "unsloth/gpt-oss-20b",
            load_in_4bit=True,
            max_seq_length=4096,
            dtype=None,
        )
        model = PeftModel.from_pretrained(model, "./saved_lora_adapters")
        logger.info("✅ Model initialized successfully")
        
        if torch.cuda.is_available():
            allocated = torch.cuda.memory_allocated(0) / 1024**3
            reserved = torch.cuda.memory_reserved(0) / 1024**3
            logger.info(f"GPU Memory - Allocated: {allocated:.2f}GB, Reserved: {reserved:.2f}GB")
            
    except Exception as e:
        logger.error(f"❌ Model initialization failed: {e}")
        raise

# ============================================================================
# Streaming Utilities
# ============================================================================
class CapturingStreamer(TextStreamer):
    """Custom streamer that captures output."""
    def __init__(self, tokenizer, **kwargs):
        super().__init__(tokenizer, **kwargs)
        self.output_buffer = StringIO()

    def put(self, value):
        super().put(value)
        if len(value.shape) > 2:
            raise ValueError("TextStreamer expects a 1D or 2D tensor")
        value = value.squeeze()
        text = self.tokenizer.decode(value)
        self.output_buffer.write(text)

    def end(self):
        super().end()
        self.output_buffer.write("\n")

def parse_final_output(generated_output: str) -> str:
    """Extract final response from model output."""
    final_block_pattern = r'<\|start\|>assistant<\|channel\|>final<\|message\|>(.*?)(?:<\|end\|>|$)'
    match = re.search(final_block_pattern, generated_output, re.DOTALL)
    if match:
        return match.group(1).strip()
    return generated_output.strip()

# ============================================================================
# Core Generation Function
# ============================================================================
async def generate_text(
    system_prompt: str,
    user_prompt: str,
    thinking_level: str = "medium",
    max_tokens: Optional[int] = None
) -> tuple[str, int]:
    """Generate text with async GPU lock management."""
    if model is None or tokenizer is None:
        raise RuntimeError("Model not initialized")
    
    config = THINKING_CONFIGS[thinking_level]
    max_new_tokens = max_tokens if max_tokens else config["max_new_tokens"]
    
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    
    async with model_lock:
        logger.info(f"Generating with {thinking_level} level, max_tokens={max_new_tokens}")
        
        loop = asyncio.get_event_loop()
        
        def _generate():
            inputs = tokenizer.apply_chat_template(
                messages,
                add_generation_prompt=True,
                return_tensors="pt",
                return_dict=True,
                reasoning_effort=config["reasoning_effort"],
            ).to(model.device)
            
            streamer = CapturingStreamer(tokenizer)
            outputs = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                temperature=config["temperature"],
                streamer=streamer,
                do_sample=True,
                top_p=0.95,
            )
            
            tokens_used = outputs.shape[1]
            full_output = streamer.output_buffer.getvalue()
            
            return full_output, tokens_used
        
        try:
            full_output, tokens_used = await loop.run_in_executor(None, _generate)
            final_output = parse_final_output(full_output)
            
            logger.info(f"✅ Generation complete: {tokens_used} tokens")
            return final_output, tokens_used
            
        except Exception as e:
            logger.error(f"Generation error: {e}")
            raise

# ============================================================================
# Streaming Generator
# ============================================================================
async def stream_generation(
    system_prompt: str,
    user_prompt: str,
    thinking_level: str = "medium",
    max_tokens: Optional[int] = None
) -> AsyncIterator[str]:
    """Stream JSON chunks as generation progresses."""
    if model is None or tokenizer is None:
        raise RuntimeError("Model not initialized")
    
    config = THINKING_CONFIGS[thinking_level]
    max_new_tokens = max_tokens if max_tokens else config["max_new_tokens"]
    
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    
    async with model_lock:
        logger.info(f"Streaming generation with {thinking_level} level")
        
        yield f"data: {json.dumps({'status': 'started', 'thinking_level': thinking_level})}\n\n"
        
        loop = asyncio.get_event_loop()
        
        def _generate_streaming():
            inputs = tokenizer.apply_chat_template(
                messages,
                add_generation_prompt=True,
                return_tensors="pt",
                return_dict=True,
                reasoning_effort=config["reasoning_effort"],
            ).to(model.device)
            
            outputs = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                temperature=config["temperature"],
                do_sample=True,
                top_p=0.95,
            )
            
            full_text = tokenizer.decode(outputs[0], skip_special_tokens=True)
            return parse_final_output(full_text), outputs.shape[1]
        
        try:
            final_output, tokens_used = await loop.run_in_executor(None, _generate_streaming)
            
            completion_data = {
                'status': 'completed',
                'output': final_output,
                'tokens_used': tokens_used,
                'thinking_level': thinking_level
            }
            yield f"data: {json.dumps(completion_data)}\n\n"
            
        except Exception as e:
            error_data = {'status': 'error', 'error': str(e)}
            yield f"data: {json.dumps(error_data)}\n\n"

# ============================================================================
# API Endpoints
# ============================================================================
@app.on_event("startup")
async def startup_event():
    """Initialize model on startup."""
    await initialize_model()

@app.post("/generate", response_model=GenerateResponse)
async def generate_endpoint(request: GenerateRequest):
    """Generate text synchronously."""
    try:
        output, tokens_used = await generate_text(
            system_prompt=request.system_prompt,
            user_prompt=request.user_prompt,
            thinking_level=request.thinking_level,
            max_tokens=request.max_tokens
        )
        
        return GenerateResponse(
            output=output,
            tokens_used=tokens_used,
            thinking_level=request.thinking_level
        )
        
    except Exception as e:
        logger.error(f"Generation failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/generate-stream")
async def generate_stream_endpoint(request: GenerateRequest):
    """Generate text with streaming response."""
    if not request.stream:
        raise HTTPException(status_code=400, detail="Stream parameter must be true")
    
    try:
        return StreamingResponse(
            stream_generation(
                system_prompt=request.system_prompt,
                user_prompt=request.user_prompt,
                thinking_level=request.thinking_level,
                max_tokens=request.max_tokens
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no"
            }
        )
    except Exception as e:
        logger.error(f"Streaming failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check with GPU stats."""
    gpu_available = torch.cuda.is_available()
    
    gpu_allocated = 0.0
    gpu_reserved = 0.0
    
    if gpu_available:
        gpu_allocated = torch.cuda.memory_allocated(0) / 1024**3
        gpu_reserved = torch.cuda.memory_reserved(0) / 1024**3
    
    return HealthResponse(
        status="healthy",
        gpu_available=gpu_available,
        gpu_memory_allocated=round(gpu_allocated, 2),
        gpu_memory_reserved=round(gpu_reserved, 2),
        model_loaded=model is not None
    )

@app.post("/clear-cache")
async def clear_cache():
    """Manually clear GPU cache."""
    gc.collect()
    torch.cuda.empty_cache()
    
    if torch.cuda.is_available():
        allocated = torch.cuda.memory_allocated(0) / 1024**3
        reserved = torch.cuda.memory_reserved(0) / 1024**3
        
        return {
            "status": "cache_cleared",
            "gpu_memory_allocated_gb": round(allocated, 2),
            "gpu_memory_reserved_gb": round(reserved, 2)
        }
    
    return {"status": "cache_cleared", "gpu_available": False}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=9000,
        log_level="info",
        access_log=True
    )