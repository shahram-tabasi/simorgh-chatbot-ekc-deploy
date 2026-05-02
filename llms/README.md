# Local LLM stack

Two GPU servers, two different runtimes — picked to match what each card
can actually fit:

| Server | Hardware | Compose file | Runtime | Default model | API |
|---|---|---|---|---|---|
| **192.168.1.61** | NVIDIA A30 24 GB | `docker-compose.llm.yml` | bespoke `ai/` (Unsloth + vLLM, FastAPI) | `unsloth/gpt-oss-20b-16bit` | OpenAI-compatible @ `:80` |
| **192.168.1.62** | NVIDIA A30 24 GB | `docker-compose.vlm.yml` | `vllm/vllm-openai:latest` (upstream image) | `Qwen/Qwen2.5-VL-7B-Instruct-AWQ` | OpenAI-compatible @ `:80` |

> **Why two different runtimes?**
> * **.61 (LLM)** — `gpt-oss-20b` in BF16 needs ~40 GB of weights. The
>   upstream `vllm/vllm-openai` image pins all weights in VRAM at startup,
>   which OOMs on a 24 GB A30. Unsloth's `FastLanguageModel` instead
>   streams layers from disk on demand, which is exactly how this box ran
>   the model successfully before. The Python service in `ai/` wraps
>   Unsloth + vLLM in a FastAPI front and exposes the standard OpenAI
>   chat-completions API on top, so the upstream contract is identical to
>   `.62` — clients can't tell them apart.
> * **.62 (VLM)** — `Qwen2.5-VL-7B` in AWQ-INT4 is ~5 GB of weights, with
>   ~18 GB free for KV cache + vision tower at 32K context. Comfortable
>   single-card fit on the A30, no streaming needed → use the upstream
>   `vllm/vllm-openai` image directly. Less code to maintain, gets
>   security + perf fixes from upstream.

Both boxes look identical to clients: OpenAI-compatible HTTP on `:80`,
fronted by an nginx that IP-allowlists `.68` and configures SSE-friendly
proxy buffering. Routing across them is done by
`simorgh-agent/llm-gateway` on **.68** — text-only requests → .61,
anything with `image_url` content → .62. Clients never talk to the GPU
boxes directly.

---

## Deploy

### On 192.168.1.61 (text LLM — Python service)

```bash
cd llms
mkdir -p /home/ubuntu/models
cat > .env <<EOF
HF_TOKEN=hf_...
# The initializer drops the 16-bit weights at this exact path on first run.
LLM_MODEL_PATH=/models/unsloth-gpt-oss-20b-16bit
MODEL_CACHE_PATH=/home/ubuntu/models
EOF

docker compose -f docker-compose.llm.yml up -d --build
docker compose -f docker-compose.llm.yml logs -f ai_service
```

First start runs `model_initializer` to download the 16-bit weights
(~40 GB) into `${MODEL_CACHE_PATH}/unsloth-gpt-oss-20b-16bit/`, then
brings `ai_service` up. The cold start takes ~15 min on a fresh box;
subsequent restarts skip the download and come up in ~2.5 min.

### On 192.168.1.62 (VLM — upstream vllm/vllm-openai)

```bash
cd llms
mkdir -p /home/ubuntu/models
cat > .env <<EOF
HF_TOKEN=hf_...
# Default — Qwen2.5-VL-7B AWQ on A30 24GB. ~5GB weights, ~18GB free for KV.
VLM_MODEL=Qwen/Qwen2.5-VL-7B-Instruct-AWQ
VLM_SERVED_NAME=qwen2.5-vl-7b
VLM_QUANTIZATION=awq
VLM_DTYPE=half
VLM_MAX_MODEL_LEN=32768
VLM_MAX_NUM_SEQS=8
VLM_MAX_IMAGES_PER_PROMPT=5
GPU_MEM_UTIL=0.92
MODEL_CACHE_PATH=/home/ubuntu/models
VLLM_API_KEY=
EOF

docker compose -f docker-compose.vlm.yml up -d
docker compose -f docker-compose.vlm.yml logs -f vllm
```

First start downloads the model (~5 GB) into
`/home/ubuntu/models/huggingface/`. The healthcheck `start_period` is
8 min for the VLM. Subsequent restarts use the cache.

---

## Environment variables

### LLM-only (`docker-compose.llm.yml`, .61)

| Var | Default | Notes |
|---|---|---|
| `HF_TOKEN` | — | Hugging Face token (required for first download) |
| `MODEL_CACHE_PATH` | `/home/ubuntu/models` | Host path bind-mounted at `/models` |
| `LLM_MODEL_PATH` | `/models/unsloth-gpt-oss-20b-16bit` | Where the initializer drops weights and `ai_service` reads them. Override only if you renamed the cache layout. |
| `ENABLE_SEARCH_TOOL` | `false` | LangChain DDG search tool. The chat-service in simorgh-agent owns search now; keep off here. |
| `ENABLE_PYTHON_REPL` | `false` | Off by default for safety. |
| `ENABLE_SIEMENS_API` | `false` | Set to `true` + provide `SIEMENS_API_KEY` to expose Siemens product lookups via the agent. |
| `AGENT_VERBOSE` | `false` | LangChain verbose logging. |

The model itself is hardcoded to `unsloth/gpt-oss-20b-16bit` — this is
the loader that's known to fit on a single A30. To swap models you'd
change the initializer + `ai_service.py`; for routine reconfiguration
just leave it.

### VLM-only (`docker-compose.vlm.yml`, .62)

| Var | Default | Notes |
|---|---|---|
| `HF_TOKEN` | — | Hugging Face token |
| `MODEL_CACHE_PATH` | `/home/ubuntu/models` | Host path bind-mounted at `/models` |
| `GPU_MEM_UTIL` | `0.92` | vllm `--gpu-memory-utilization` |
| `VLLM_API_KEY` | (empty) | If set, vllm requires `Authorization: Bearer <key>`. Mirror the same value to llm-gateway via `LOCAL_LLM_API_KEY`. |
| `VLLM_LOGGING_LEVEL` | `INFO` | `DEBUG` / `WARNING` / etc. |
| `VLM_MODEL` | `Qwen/Qwen2.5-VL-7B-Instruct-AWQ` | |
| `VLM_SERVED_NAME` | `qwen2.5-vl-7b` | Match this on llm-gateway via `LOCAL_LLM_MODEL_VLM` |
| `VLM_QUANTIZATION` | `awq` | |
| `VLM_DTYPE` | `half` | |
| `VLM_MAX_MODEL_LEN` | `32768` | |
| `VLM_MAX_NUM_SEQS` | `8` | |
| `VLM_MAX_IMAGES_PER_PROMPT` | `5` | |

---

## What you get on each box

```
host port 80  ──►  nginx (this dir's nginx_configs/)  ──►  ai_service:9000  (.61)
                                                       └►  vllm:8000        (.62)
                   IP-allowlists 192.168.1.68 + localhost
                   forwards everything upstream
```

The two boxes use different upstream blocks but expose the same surface:

```
GET  /health
GET  /v1/models
POST /v1/chat/completions       # streaming via "stream": true
POST /v1/completions
POST /generate-stream           # legacy, .61 only — deprecated
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
    "model":"qwen2.5-vl-7b",
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

If `VLLM_API_KEY` is set on the VLM box, set `LOCAL_LLM_API_KEY` on the
llm-gateway side to the same value. The .61 Python service does not
require an API key by default.

---

## GPU monitor

`gpu_monitor/` watches the GPU container's memory + idle time and
restarts it if it hangs. `TARGET_CONTAINER` is `ai_service` on the LLM
box and `vllm` on the VLM box.

---

## Files in this directory

| Path | Purpose |
|---|---|
| `docker-compose.llm.yml` | Runs on .61 — Python ai_service + initializer + nginx + gpu_monitor |
| `docker-compose.vlm.yml` | Runs on .62 — vllm/vllm-openai + nginx + gpu_monitor |
| `docker-compose.yml` | Pointer / placeholder |
| `docker-compose.local.yml`, `docker-compose.no-wait.yml` | Dev-only legacy variants |
| `ai/` | Python service used by .61 (Unsloth FastLanguageModel + vLLM 0.12 + FastAPI) |
| `initializer/` | One-shot model downloader (used by .61) |
| `gpu_monitor/` | Watches GPU memory + restarts the upstream container if it hangs |
| `nginx_configs/nginx.conf` | Top-level nginx config (shared) |
| `nginx_configs/conf.d/llm.conf` | LLM vhost (.61) — proxies to `ai_service:9000` |
| `nginx_configs/conf.d/default.conf` | VLM vhost (.62) — proxies to `vllm:8000` |
| `check-models.sh`, `cleanup-incomplete-models.sh`, `deploy-llm-service.sh` | Existing helper scripts |
| `scripts/` | Existing helpers |

---

## Why this split

- **`.61` keeps the Python service** because Unsloth's
  `FastLanguageModel` is the only loader in the ecosystem that fits
  `gpt-oss-20b-16bit` on a single 24 GB A30 (it streams layers from
  disk on demand). The upstream `vllm/vllm-openai` image was tried in
  an earlier iteration and OOMed; it can't fit BF16 20B on one card.
- **`.62` uses the upstream image** because the AWQ-INT4 7B VLM fits
  comfortably on one A30 — there's no reason to maintain bespoke
  Python code for it. Multimodal `image_url` requests pass through
  unmodified, security + perf fixes come from upstream.
- **Both expose the same OpenAI-compatible surface**, so llm-gateway
  uses one `httpx` client for online (api.openai.com) and offline
  (.61/.62), with content-aware routing as the only branch.
