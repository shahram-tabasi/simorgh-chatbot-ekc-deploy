# Simorgh AI Service v2.0

Enhanced AI inference service with vLLM, LangChain tools, and OpenAI-compatible API.

## 🚀 Features

### Core Capabilities
- **vLLM Integration**: High-performance inference with 16-bit precision (automatic fallback to 4-bit)
- **OpenAI-Compatible API**: Drop-in replacement for OpenAI chat completion endpoints
- **Streaming Support**: True server-sent events (SSE) for token streaming
- **LangChain Tools**: Web search and Python REPL for agentic workflows
- **Async Architecture**: FastAPI with async/await for high concurrency
- **Prometheus Metrics**: Built-in monitoring and observability
- **GPU Auto-Detection**: Intelligent GPU memory management and fallback

### Model Loading Strategy

1. **Primary: vLLM with 16-bit** (FP16)
   - Requires ~20GB GPU memory for 20B model
   - Optimal performance and quality
   - Automatic model download from Hugging Face

2. **Fallback: Unsloth with 4-bit** (INT4)
   - Used when GPU memory insufficient
   - Loads existing LoRA adapters
   - Maintains backward compatibility

## 📋 Prerequisites

- NVIDIA GPU with CUDA 12.8+ (A30 or better recommended)
- Docker with NVIDIA container runtime
- 24GB+ GPU memory (for 16-bit mode)
- Hugging Face account (for model downloads)

## 🔧 Setup

### 1. Hugging Face Authentication

If the model requires license acceptance:

```bash
# Install Hugging Face CLI
pip install huggingface_hub

# Login to Hugging Face
huggingface-cli login

# Accept model license at:
# https://huggingface.co/unsloth/gpt-oss-20b
```

### 2. Build Docker Image

```bash
cd llms/ai
docker build -t simorgh-ai:v2 .
```

### 3. Run with GPU

```bash
docker run -d \
  --name simorgh-ai \
  --gpus all \
  -p 9000:9000 \
  -v /path/to/models:/models \
  -e ENABLE_SEARCH_TOOL=true \
  -e ENABLE_PYTHON_REPL=false \
  -e HF_TOKEN=your_hf_token \
  simorgh-ai:v2
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_SEARCH_TOOL` | `true` | Enable web search tool (DuckDuckGo) |
| `ENABLE_PYTHON_REPL` | `false` | Enable Python REPL tool (⚠️ security risk) |
| `AGENT_VERBOSE` | `false` | Log agent reasoning steps |
| `MODEL_PATH` | `/models/unsloth-gpt-oss-20b-16bit` | Local model cache path |
| `HF_TOKEN` | - | Hugging Face API token |
| `SEARCH_API_URL` | - | Self-hosted search API URL (optional) |
| `SEARCH_API_KEY` | - | Search API key (optional) |
| `PYTHON_REPL_TIMEOUT` | `10` | Python execution timeout (seconds) |
| `PYTHON_REPL_SANDBOX` | `true` | Use subprocess sandbox for Python |

## 📡 API Endpoints

### Health Check

```bash
GET /health
```

**Response:**
```json
{
  "status": "healthy",
  "model": "unsloth/gpt-oss-20b",
  "precision": "16-bit",
  "gpu_available": true,
  "gpu_memory_allocated_gb": 18.5,
  "gpu_memory_reserved_gb": 20.0,
  "model_loaded": true,
  "engine": "vllm"
}
```

### Chat Completion (Non-Streaming)

```bash
POST /v1/chat/completions
Content-Type: application/json
```

**Request:**
```json
{
  "model": "unsloth/gpt-oss-20b",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "What is the capital of France?"}
  ],
  "temperature": 0.7,
  "max_tokens": 1024,
  "stream": false
}
```

**Response:**
```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "unsloth/gpt-oss-20b",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The capital of France is Paris."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 25,
    "completion_tokens": 8,
    "total_tokens": 33
  }
}
```

### Chat Completion (Streaming)

```bash
POST /v1/chat/completions
Content-Type: application/json
```

**Request:**
```json
{
  "model": "unsloth/gpt-oss-20b",
  "messages": [
    {"role": "user", "content": "Write a haiku about AI"}
  ],
  "stream": true
}
```

**Response (SSE):**
```
data: {"id":"chatcmpl-xyz","object":"chat.completion.chunk","created":1234567890,"model":"unsloth/gpt-oss-20b","choices":[{"index":0,"delta":{"content":"Silicon"},"finish_reason":null}]}

data: {"id":"chatcmpl-xyz","object":"chat.completion.chunk","created":1234567890,"model":"unsloth/gpt-oss-20b","choices":[{"index":0,"delta":{"content":" minds"},"finish_reason":null}]}

...

data: {"id":"chatcmpl-xyz","object":"chat.completion.chunk","created":1234567890,"model":"unsloth/gpt-oss-20b","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]}

data: [DONE]
```

### List Models

```bash
GET /v1/models
```

### Prometheus Metrics

```bash
GET /metrics
```

## 🔌 Using with OpenAI Clients

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:9000/v1",
    api_key="dummy"  # Not required, but SDK expects it
)

# Non-streaming
response = client.chat.completions.create(
    model="unsloth/gpt-oss-20b",
    messages=[
        {"role": "user", "content": "Hello!"}
    ]
)
print(response.choices[0].message.content)

# Streaming
stream = client.chat.completions.create(
    model="unsloth/gpt-oss-20b",
    messages=[{"role": "user", "content": "Tell me a story"}],
    stream=True
)

for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### cURL

```bash
# Non-streaming
curl http://localhost:9000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "unsloth/gpt-oss-20b",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'

# Streaming
curl http://localhost:9000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -N \
  -d '{
    "model": "unsloth/gpt-oss-20b",
    "messages": [{"role": "user", "content": "Count to 10"}],
    "stream": true
  }'
```

## 🛠️ LangChain Tools

### Web Search Tool

Enabled by default. Uses DuckDuckGo for free web search.

**Example prompt:**
```
"Search for the latest news about AI regulations in 2024"
```

The agent will automatically use the search tool when appropriate.

### Self-Hosted Search API

For production, deploy a self-hosted search service:

```bash
# Set environment variables
SEARCH_API_URL=http://your-search-api:8080/search
SEARCH_API_KEY=your-api-key
```

### Python REPL Tool

⚠️ **Security Warning**: Executes arbitrary Python code. Disabled by default.

To enable:
```bash
docker run ... -e ENABLE_PYTHON_REPL=true ...
```

**Example prompt:**
```
"Calculate the factorial of 50"
"Plot a sine wave from 0 to 2π"
```

**Security Measures:**
- Subprocess isolation
- 10-second timeout (configurable)
- Limited file system access
- Recommend: Use Docker containers or firejail in production

## 🧪 Testing

### Install Test Dependencies

```bash
pip install -r tests/requirements-test.txt
```

### Run Tests

```bash
# All tests
pytest

# Unit tests only
pytest -m unit

# Integration tests
pytest -m integration

# With coverage
pytest --cov=. --cov-report=html
```

## 📊 Monitoring

### Prometheus Metrics

Available at `/metrics`:

- `ai_requests_total` - Total requests by endpoint and status
- `ai_request_duration_seconds` - Request latency histogram
- `ai_tokens_generated_total` - Total tokens generated

### Example Prometheus Config

```yaml
scrape_configs:
  - job_name: 'simorgh-ai'
    static_configs:
      - targets: ['localhost:9000']
    metrics_path: '/metrics'
```

## 🐛 Troubleshooting

### Model Download Fails

**Error:** `Model requires license acceptance`

**Solution:**
1. Visit https://huggingface.co/unsloth/gpt-oss-20b
2. Accept the model license
3. Login: `huggingface-cli login`
4. Restart service

### Out of GPU Memory

**Error:** `CUDA out of memory`

**Solution:**
The service will automatically fall back to 4-bit quantization. To force 4-bit:
```bash
# Use smaller gpu_memory_utilization
docker run ... -e GPU_MEMORY_UTILIZATION=0.7 ...
```

### vLLM Import Error

**Error:** `No module named 'vllm'`

**Solution:**
vLLM requires CUDA. Ensure you're using the correct base image:
```dockerfile
FROM pytorch/pytorch:2.9.1-cuda12.8-cudnn9-devel
```

### Slow Inference

**Check:**
1. Verify GPU is being used: `docker exec simorgh-ai nvidia-smi`
2. Check precision: `curl http://localhost:9000/health | jq .precision`
3. Monitor GPU utilization: `watch -n 1 nvidia-smi`

## 📁 Project Structure

```
llms/ai/
├── app.py                      # Main FastAPI application
├── ai_server.py                # Legacy server (backward compat)
├── Dockerfile                  # GPU-enabled container
├── requirements.txt            # Python dependencies
├── pytest.ini                  # Test configuration
├── services/
│   ├── model_manager.py        # vLLM/4-bit model loading
│   └── langchain_agent.py      # LangChain orchestration
├── api/
│   └── schemas.py              # OpenAI-compatible Pydantic models
├── tools/
│   ├── search_tool.py          # Web search integration
│   └── python_repl.py          # Python REPL tool
├── tests/
│   ├── test_model_manager.py   # Unit tests
│   ├── test_api.py             # Integration tests
│   └── requirements-test.txt   # Test dependencies
└── saved_lora_adapters/        # LoRA weights (4-bit fallback)
```

## 🔐 Security Considerations

### Python REPL Tool

- **Risk**: Arbitrary code execution
- **Mitigation**:
  - Disabled by default
  - Subprocess isolation with timeout
  - Limited filesystem access
  - Production: Use Docker/firejail sandboxing

### Model Access

- Store HF tokens securely (use Docker secrets)
- Don't commit credentials to repo
- Use read-only model cache mounts

### API Security

- Add authentication layer (not included)
- Rate limiting (implement via reverse proxy)
- Input validation (Pydantic schemas)

## 📝 Migration Guide

### From Legacy API

The legacy `/generate` endpoint is still supported:

```python
# Old format still works
POST /generate
{
  "system_prompt": "You are helpful",
  "user_prompt": "Hello",
  "thinking_level": "medium"
}
```

Migrate to new format:

```python
# New OpenAI-compatible format
POST /v1/chat/completions
{
  "messages": [
    {"role": "system", "content": "You are helpful"},
    {"role": "user", "content": "Hello"}
  ]
}
```

## 🔄 Rollback Procedure

If issues occur:

```bash
# Stop new service
docker stop simorgh-ai

# Revert to ai_server.py
docker run ... \
  --entrypoint python \
  simorgh-ai:v2 \
  -m uvicorn ai_server:app --host 0.0.0.0 --port 9000

# Or rebuild from previous version
git checkout <previous-commit>
docker build -t simorgh-ai:rollback .
```

## 📚 References

- [vLLM Documentation](https://docs.vllm.ai/)
- [OpenAI API Reference](https://platform.openai.com/docs/api-reference)
- [LangChain Documentation](https://python.langchain.com/)
- [FastAPI Documentation](https://fastapi.tiangolo.com/)

## 🤝 Contributing

### Adding New Tools

1. Create tool in `tools/` directory
2. Implement LangChain Tool interface
3. Add to `create_agent_with_tools()` in `langchain_agent.py`
4. Update environment variables
5. Add tests

### Code Style

```bash
# Format code
black .
ruff check .

# Type checking
mypy .
```

## 📄 License

See main repository LICENSE.

## 🆘 Support

For issues and questions:
- Open GitHub issue
- Check logs: `docker logs simorgh-ai`
- Monitor health: `curl http://localhost:9000/health`
