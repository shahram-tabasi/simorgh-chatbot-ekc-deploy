# Local LLM stack (vllm/vllm-openai)

Two GPU servers, each running the **official `vllm/vllm-openai:latest`**
image directly. No custom Python code in this directory anymore — the
old `ai/` service has been removed. The GPU boxes expose a standard
OpenAI-compatible HTTP API; everything else in the stack treats them
like any OpenAI endpoint.

| Server | Hardware | Compose file | Role | Default model | API |
|---|---|---|---|---|---|
| **192.168.1.61** | NVIDIA A30 24 GB **× 2** | `docker-compose.llm.yml` | text-only LLM | `unsloth/gpt-oss-20b-16bit` (env `LLM_MODEL`) | OpenAI-compatible @ `:80` |
| **192.168.1.62** | NVIDIA A30 24 GB | `docker-compose.vlm.yml` | vision + text VLM | `Qwen/Qwen2.5-VL-7B-Instruct-AWQ` (env `VLM_MODEL`) | OpenAI-compatible @ `:80` |

> **Memory math.**
> * **.61 (LLM)** — `gpt-oss-20b` in BF16 needs ~40 GB of weights, which
>   does not fit on a single A30 24 GB. Default uses
>   `--tensor-parallel-size 2` to shard across two A30s (48 GB total).
>   If `.61` actually has 1 GPU, see the comment block at the top of
>   `docker-compose.llm.yml` — three documented fallbacks
>   (CPU offload, MXFP4 native, switch to Qwen2.5-14B-AWQ).
> * **.62 (VLM)** — `Qwen2.5-VL-7B` in AWQ-INT4 is ~5 GB of weights,
>   leaving ~18 GB for KV cache + vision tower at 32K context.
>   Comfortable single-card fit.

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
# gpt-oss-20b 16-bit, sharded across 2× A30 via tensor parallelism.
LLM_MODEL=unsloth/gpt-oss-20b-16bit
LLM_SERVED_NAME=gpt-oss-20b
LLM_TP_SIZE=2
LLM_DTYPE=bfloat16
LLM_MAX_MODEL_LEN=8192
LLM_MAX_NUM_SEQS=4
GPU_MEM_UTIL=0.92
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

| Var | Default | Notes |
|---|---|---|
| `LLM_MODEL` | `unsloth/gpt-oss-20b-16bit` | |
| `LLM_SERVED_NAME` | `gpt-oss-20b` | Match this on llm-gateway via `LOCAL_LLM_MODEL_TEXT` |
| `LLM_TP_SIZE` | `2` | Tensor-parallel shards. **Set 1 if `.61` has a single GPU** (you'll then need to use one of the fallback models — see compose comment block) |
| `LLM_DTYPE` | `bfloat16` | |
| `LLM_QUANTIZATION` | _(unset)_ | Set to `awq` / `bitsandbytes` / `mxfp4` only when the chosen model is quantized |
| `LLM_CPU_OFFLOAD_GB` | _(unset)_ | If you must run on a single GPU + RAM offload, set to `20`. Slow. |
| `LLM_MAX_MODEL_LEN` | `8192` | KV cache headroom is tight even with TP=2; don't bump above 8K without monitoring |
| `LLM_MAX_NUM_SEQS` | `4` | Lower than the VLM (BF16 weights + KV at 20B leaves less per-request room) |

### VLM-only (`docker-compose.vlm.yml`)

| Var | Default |
|---|---|
| `VLM_MODEL` | `Qwen/Qwen2.5-VL-7B-Instruct-AWQ` |
| `VLM_SERVED_NAME` | `qwen2.5-vl-7b` |
| `VLM_QUANTIZATION` | `awq` |
| `VLM_DTYPE` | `half` |
| `VLM_MAX_MODEL_LEN` | `32768` |
| `VLM_MAX_NUM_SEQS` | `8` |
| `VLM_MAX_IMAGES_PER_PROMPT` | `5` |

### If `.61` is single-card

The default config assumes `.61` has 2× A30 because `gpt-oss-20b` 16-bit
won't fit on one. Run `nvidia-smi -L` on `.61` to check. If you see only
one GPU, pick one of these three and put it in `.env`:

**(B) CPU offload** — keep gpt-oss-20b 16-bit but spill ~20 GB to RAM.
Inference becomes ~5-10× slower. Needs 32+ GB system RAM.
```env
LLM_TP_SIZE=1
LLM_CPU_OFFLOAD_GB=20
LLM_MAX_NUM_SEQS=2
```

**(C) MXFP4 native** — recommended single-GPU fallback. MXFP4 *is* the
trained gpt-oss format; the `-16bit` variant is unsloth's BF16 upcast
for fine-tuning convenience. Inference quality is essentially identical,
weights are ~12 GB → fits on 1 A30 with ~12 GB free for KV cache.
```env
LLM_MODEL=unsloth/gpt-oss-20b
LLM_SERVED_NAME=gpt-oss-20b
LLM_QUANTIZATION=mxfp4
LLM_TP_SIZE=1
LLM_DTYPE=bfloat16
LLM_MAX_NUM_SEQS=4
```

**(D) Different model** — switch to Qwen2.5-14B-AWQ (same Qwen family
as the VLM, ~8 GB on a single A30):
```env
LLM_MODEL=Qwen/Qwen2.5-14B-Instruct-AWQ
LLM_SERVED_NAME=qwen2.5-14b
LLM_QUANTIZATION=awq
LLM_DTYPE=half
LLM_TP_SIZE=1
LLM_MAX_NUM_SEQS=8
```
Then update `LOCAL_LLM_MODEL_TEXT` on llm-gateway to match the new
`LLM_SERVED_NAME`.

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
