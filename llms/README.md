# LLM Services Docker Compose Setup

This directory contains the Docker Compose configuration for running the Simorgh AI services with GPU support.

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Docker Compose Stack                   │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  ┌─────────────────┐                                    │
│  │  Initializer    │  (runs once)                        │
│  │  Downloads:     │                                     │
│  │  - 4-bit model  │                                     │
│  │  - 16-bit model │                                     │
│  └────────┬────────┘                                     │
│           │                                              │
│           ▼                                              │
│  ┌─────────────────┐                                    │
│  │   AI Service    │  (port 9000)                        │
│  │  - vLLM 16-bit  │                                     │
│  │  - 4-bit fallback│                                    │
│  │  - LangChain    │                                     │
│  │  - OpenAI API   │                                     │
│  └────────┬────────┘                                     │
│           │                                              │
│           ▼                                              │
│  ┌─────────────────┐                                    │
│  │     Nginx       │  (port 80)                          │
│  │  Reverse Proxy  │                                     │
│  └─────────────────┘                                     │
│                                                           │
│  ┌─────────────────┐                                    │
│  │  GPU Monitor    │  (optional)                         │
│  │  Health checks  │                                     │
│  └─────────────────┘                                     │
│                                                           │
└─────────────────────────────────────────────────────────┘
```

## 📋 Prerequisites

- Docker 20.10+
- Docker Compose 2.0+
- NVIDIA GPU with CUDA 12.8+
- NVIDIA Container Toolkit
- 40GB+ free disk space (for models)
- 24GB+ GPU memory (for 16-bit mode)

## 🚀 Quick Start

### 1. Configure Environment

```bash
# Copy example environment file
cp .env.example .env

# Edit .env with your settings
nano .env
```

**Required Configuration:**
- `MODEL_CACHE_PATH`: Path where models will be stored (needs ~40GB)
- `HF_TOKEN`: Hugging Face token (if model requires it)

### 2. Start Services

```bash
# Start all services
docker-compose up -d

# Watch logs
docker-compose logs -f

# Check status
docker-compose ps
```

### 3. Verify Installation

```bash
# Check AI service health
curl http://localhost/health | jq

# Test chat completion
curl http://localhost/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "unsloth/gpt-oss-20b",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## 🔧 Services

### Model Initializer

**Purpose**: Downloads models before AI service starts

**Runs**: Once on startup (exits when complete)

**Downloads**:
1. `unsloth/gpt-oss-20b-unsloth-bnb-4bit` (4-bit, ~8GB)
2. `unsloth/gpt-oss-20b` (16-bit, ~40GB)

**Configuration**: See `initializer/init-config.yaml`

### AI Service

**Purpose**: LLM inference with vLLM and OpenAI-compatible API

**Port**: 9000 (internal)

**Endpoints**:
- `GET /health` - Health check
- `GET /v1/models` - List models
- `POST /v1/chat/completions` - Chat completion (streaming/non-streaming)
- `GET /metrics` - Prometheus metrics

**Model Loading**:
- **Primary**: vLLM with 16-bit (requires 24GB+ VRAM)
- **Fallback**: Unsloth 4-bit (works with 8GB+ VRAM)

**Tools**:
- Web search (DuckDuckGo)
- Python REPL (disabled by default)

### Nginx

**Purpose**: Reverse proxy with load balancing

**Port**: 80 (public)

**Features**:
- Routes requests to AI service
- SSL termination (configure in nginx_configs/)
- Rate limiting (optional)

### GPU Monitor

**Purpose**: Monitors GPU usage and AI service health

**Features**:
- Tracks GPU memory usage
- Monitors service health
- Auto-restart on failures (optional)

## ⚙️ Configuration

### Environment Variables

All configuration is in `.env` file:

| Variable | Default | Description |
|----------|---------|-------------|
| `MODEL_CACHE_PATH` | `/home/ubuntu/models` | Model storage path |
| `HF_TOKEN` | - | Hugging Face token |
| `ENABLE_SEARCH_TOOL` | `true` | Enable web search |
| `ENABLE_PYTHON_REPL` | `false` | Enable Python REPL |
| `AGENT_VERBOSE` | `false` | Verbose agent logs |
| `IMAGE_TAG` | `latest` | Docker image tag |

### Volume Mounts

```yaml
# Initializer
/home/ubuntu/models → /models

# AI Service
/home/ubuntu/models → /models (read-only)
/home/ubuntu/models/huggingface → /root/.cache/huggingface/hub (read-only)
```

### GPU Access

Services with GPU access:
- `ai_service`: Full GPU access for inference
- `gpu_monitor`: Utility access for monitoring

## 🔍 Troubleshooting

### Model Download Fails

**Symptom**: Initializer exits with error

**Solutions**:
1. Check HF token: `echo $HF_TOKEN`
2. Check disk space: `df -h $MODEL_CACHE_PATH`
3. Check logs: `docker-compose logs model_initializer`
4. Accept model license at: https://huggingface.co/unsloth/gpt-oss-20b

### AI Service Won't Start

**Symptom**: Service keeps restarting

**Solutions**:
1. Check GPU: `nvidia-smi`
2. Check model files: `ls $MODEL_CACHE_PATH/unsloth-gpt-oss-20b-16bit`
3. Check logs: `docker-compose logs ai_service`
4. Verify initializer completed: `docker-compose ps model_initializer`

### Out of GPU Memory

**Symptom**: CUDA out of memory errors

**Solutions**:
1. Service will auto-fallback to 4-bit mode
2. Check logs for fallback message
3. Verify precision: `curl http://localhost/health | jq .precision`

### Health Check Fails

**Symptom**: Nginx can't connect to AI service

**Solutions**:
1. Increase `start_period` in docker-compose.yml
2. Check AI service logs: `docker-compose logs ai_service`
3. Check port 9000: `docker exec ai_service wget -qO- http://localhost:9000/health`

## 📊 Monitoring

### Check Service Health

```bash
# All services
docker-compose ps

# Detailed health
curl http://localhost/health | jq

# GPU usage
docker exec gpu_monitor nvidia-smi
```

### View Logs

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f ai_service

# Last 100 lines
docker-compose logs --tail=100 ai_service
```

### Prometheus Metrics

```bash
# View metrics
curl http://localhost/metrics

# Integration with Prometheus
# Add to prometheus.yml:
scrape_configs:
  - job_name: 'simorgh-ai'
    static_configs:
      - targets: ['ai_service:9000']
```

## 🔄 Updating

### Update Images

```bash
# Pull latest images
docker-compose pull

# Restart services
docker-compose down
docker-compose up -d
```

### Update Models

```bash
# Remove model cache
sudo rm -rf $MODEL_CACHE_PATH/*

# Restart to re-download
docker-compose down
docker-compose up -d
```

## 🛑 Stopping Services

```bash
# Stop all services
docker-compose down

# Stop and remove volumes
docker-compose down -v

# Stop specific service
docker-compose stop ai_service
```

## 🔐 Security

### Production Recommendations

1. **Enable Authentication**: Add API keys via nginx
2. **Disable Python REPL**: Keep `ENABLE_PYTHON_REPL=false`
3. **Use HTTPS**: Configure SSL in nginx
4. **Rate Limiting**: Enable in nginx config
5. **Network Isolation**: Use Docker networks
6. **Read-Only Mounts**: Models mounted read-only

### API Security

```nginx
# Add to nginx config
location /v1/ {
    # Rate limiting
    limit_req zone=api burst=10;

    # API key check
    if ($http_x_api_key != "your-secret-key") {
        return 401;
    }

    proxy_pass http://ai_service:9000;
}
```

## 📁 Directory Structure

```
llms/
├── docker-compose.yml          # Main compose file
├── .env                        # Environment config (create from .env.example)
├── .env.example               # Example environment
├── README.md                   # This file
├── ai/                         # AI service code
│   ├── Dockerfile
│   ├── app.py
│   ├── services/
│   ├── api/
│   ├── tools/
│   └── tests/
├── initializer/                # Model initializer
│   ├── Dockerfile
│   ├── init-models.py
│   └── init-config.yaml
├── gpu_monitor/                # GPU monitor service
│   ├── Dockerfile
│   └── monitor.py
└── nginx_configs/              # Nginx configuration
    ├── nginx.conf
    └── conf.d/
        └── default.conf
```

## 🆘 Support

### Logs Location

Inside containers:
- AI Service: `/app/logs/` (if configured)
- System logs: `docker-compose logs`

### Debug Mode

```bash
# Run with debug output
AGENT_VERBOSE=true docker-compose up

# Exec into container
docker exec -it ai_service bash

# Check GPU
docker exec ai_service nvidia-smi

# Test model loading
docker exec ai_service python -c "import torch; print(torch.cuda.is_available())"
```

## 📚 References

- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [NVIDIA Container Toolkit](https://github.com/NVIDIA/nvidia-docker)
- [vLLM Documentation](https://docs.vllm.ai/)
- [AI Service README](./ai/README.md)
- [Initializer README](./initializer/README.md)

## 📄 License

See main repository LICENSE file.
