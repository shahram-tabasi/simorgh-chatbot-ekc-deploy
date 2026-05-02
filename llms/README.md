# Local LLM stack (vllm/vllm-openai)

Two GPU servers, each running the **official `vllm/vllm-openai:latest`**
image directly. No custom Python code in this directory anymore — the
old `ai/` service has been removed. The GPU boxes expose a standard
OpenAI-compatible HTTP API; everything else in the stack treats them
like any OpenAI endpoint.

| Server | Compose file | Role | Default model | API |
|---|---|---|---|---|
| **192.168.1.61** | `docker-compose.llm.yml` | text-only LLM | `unsloth/gpt-oss-20b-16bit` (env `LLM_MODEL`) | OpenAI-compatible @ `:80` |
| **192.168.1.62** | `docker-compose.vlm.yml` | vision + text VLM | `Qwen/Qwen2-VL-7B-Instruct` (env `VLM_MODEL`) | OpenAI-compatible @ `:80` |

Routing across the two is done by `simorgh-agent/llm-gateway` on **.68**
— text-only requests → .61, anything with `image_url` content → .62.
Clients never talk to the GPU boxes directly.

---

## Deploy

On **192.168.1.61** (text-only LLM):

```bash
cd llms
mkdir -p /home/ubuntu/models
cat > .env <<EOF
HF_TOKEN=hf_...
LLM_MODEL=unsloth/gpt-oss-20b-16bit
LLM_SERVED_NAME=gpt-oss-20b
LLM_DTYPE=bfloat16
LLM_MAX_MODEL_LEN=8192
GPU_MEM_UTIL=0.90
MODEL_CACHE_PATH=/home/ubuntu/models
VLLM_API_KEY=
EOF

docker compose -f docker-compose.llm.yml up -d
docker compose -f docker-compose.llm.yml logs -f vllm
```

On **192.168.1.62** (VLM):

```bash
cd llms
mkdir -p /home/ubuntu/models
cat > .env <<EOF
HF_TOKEN=hf_...
VLM_MODEL=Qwen/Qwen2-VL-7B-Instruct
VLM_SERVED_NAME=qwen2-vl-7b
VLM_DTYPE=bfloat16
VLM_MAX_MODEL_LEN=32768
VLM_MAX_NUM_SEQS=5
VLM_MAX_IMAGES_PER_PROMPT=5
GPU_MEM_UTIL=0.90
MODEL_CACHE_PATH=/home/ubuntu/models
VLLM_API_KEY=
EOF

docker compose -f docker-compose.vlm.yml up -d
docker compose -f docker-compose.vlm.yml logs -f vllm
```

First start downloads the model (large — 40+ GB for the 20B model)
into `/home/ubuntu/models/huggingface/`. The healthcheck `start_period`
is set to 10 min for the LLM and 8 min for the VLM to cover this.
Subsequent restarts use the cache and come up in ~1 min.

---

## Environment variables (per server)

### Common to both

| Var | Default | Notes |
|---|---|---|
| `HF_TOKEN` | — | Hugging Face token (gated models, rate limits) |
| `MODEL_CACHE_PATH` | `/home/ubuntu/models` | Host path bind-mounted at `/models` in the container |
| `GPU_MEM_UTIL` | `0.90` | vllm `--gpu-memory-utilization` |
| `VLLM_API_KEY` | (empty) | If set, vllm requires `Authorization: Bearer <key>`. Mirror the same value to llm-gateway via `LOCAL_LLM_API_KEY` |
| `VLLM_LOGGING_LEVEL` | `INFO` | `DEBUG` / `WARNING` / etc. |

### LLM-only (`docker-compose.llm.yml`)

| Var | Default |
|---|---|
| `LLM_MODEL` | `unsloth/gpt-oss-20b-16bit` |
| `LLM_SERVED_NAME` | `gpt-oss-20b` |
| `LLM_DTYPE` | `bfloat16` |
| `LLM_MAX_MODEL_LEN` | `8192` |

### VLM-only (`docker-compose.vlm.yml`)

| Var | Default |
|---|---|
| `VLM_MODEL` | `Qwen/Qwen2-VL-7B-Instruct` |
| `VLM_SERVED_NAME` | `qwen2-vl-7b` |
| `VLM_DTYPE` | `bfloat16` |
| `VLM_MAX_MODEL_LEN` | `32768` |
| `VLM_MAX_NUM_SEQS` | `5` |
| `VLM_MAX_IMAGES_PER_PROMPT` | `5` |

---

## What you get on each box

```
host port 80  ──►  nginx (this dir's nginx_configs/)  ──►  vllm:8000
                   IP-allowlists 192.168.1.68 + localhost
                   forwards everything to vllm
```

Nginx is mostly for the IP allowlist + a sane SSE configuration
(no buffering, long timeouts). The actual API is what
`vllm/vllm-openai` provides natively:

```
GET  /health
GET  /v1/models
POST /v1/chat/completions       # streaming via "stream": true
POST /v1/completions
POST /v1/embeddings             # only if --task=embedding (not the default here)
```

Smoke test from the central server:

```bash
curl -s http://192.168.1.61/v1/models | jq

curl -s http://192.168.1.61/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-oss-20b","messages":[{"role":"user","content":"hi"}],"max_tokens":20}'

curl -s http://192.168.1.62/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"qwen2-vl-7b",
    "messages":[{"role":"user","content":[
      {"type":"text","text":"What is in this image?"},
      {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,/9j/4AAQ..."}}
    ]}],
    "max_tokens":200
  }'
```

---

## How the simorgh stack on .68 calls these

`simorgh-agent/llm-gateway` (port **8030**) is the only client. It:

1. Accepts a request from the rest of the stack (chat-service, project-
   agent-service, etc.).
2. **Inspects `messages` for any `image_url` content part.**
3. Routes:
   - text-only → `LOCAL_LLM_URL_TEXT` (default `http://192.168.1.61/v1`)
   - has image  → `LOCAL_LLM_URL_VLM`  (default `http://192.168.1.62/v1`)
4. Streams the OpenAI-compatible response back as-is.

If `VLLM_API_KEY` is set on the GPU side, set `LOCAL_LLM_API_KEY` on the
llm-gateway side to the same value.

---

## GPU monitor

`gpu_monitor/` watches the `vllm` container's GPU memory + idle time
and restarts it if it hangs. `TARGET_CONTAINER=vllm` (was `ai_service`
before this refactor).

---

## What was removed in this refactor

- `ai/` — custom vLLM Python service. Superseded entirely by
  `vllm/vllm-openai:latest` which has more features, gets security
  fixes upstream, and uses the standard OpenAI API contract instead of
  the bespoke `/generate-stream`.
- `initializer/` — bespoke model downloader. vllm/vllm-openai pulls
  from Hugging Face on first start (with `HF_TOKEN`), so the extra
  container isn't needed. The bind-mounted `MODEL_CACHE_PATH` keeps
  the cache across restarts.

---

## Files in this directory

| Path | Purpose |
|---|---|
| `docker-compose.yml` | Empty / pointer comment |
| `docker-compose.llm.yml` | What runs on .61 |
| `docker-compose.vlm.yml` | What runs on .62 |
| `docker-compose.local.yml` | Dev-only legacy variant |
| `docker-compose.no-wait.yml` | Dev-only legacy variant |
| `nginx_configs/nginx.conf` | Top-level nginx config (shared) |
| `nginx_configs/conf.d/default.conf` | vhost in front of vllm |
| `gpu_monitor/` | Watches GPU memory + restarts vllm if it hangs |
| `check-models.sh`, `cleanup-incomplete-models.sh`, `deploy-llm-service.sh` | Existing helper scripts |
| `scripts/` | Existing helpers |

---

## Why `vllm/vllm-openai` directly

- **Standard OpenAI API.** Drop-in client; every existing OpenAI SDK
  works without changes. llm-gateway uses the same `httpx` client for
  both online (api.openai.com) and offline (.61/.62).
- **Multimodal support.** VLM image input goes through unmodified — no
  request adapter to write.
- **Upstream security + perf updates.** Pulling
  `vllm/vllm-openai:latest` is a `docker compose pull` away — no
  service code to maintain.
- **Built-in tooling we don't have to write.** Prefix caching, batched
  scheduling, speculative decoding, GPU memory tuning, etc.
