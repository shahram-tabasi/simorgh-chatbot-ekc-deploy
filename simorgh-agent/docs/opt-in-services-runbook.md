# Opt-in services — deployment runbook

Step-by-step deploy / verify / rollback for the six standard-image swaps
that are **wired in code but not yet running on `.68`** as of May 2026.

This is the operator-side companion to `service-migration.md` (which
documents *what* the swaps are) and the per-service compose-file headers
(which document *why*).

## Topology recap

| Host | What runs there |
|---|---|
| `.68` | All app + microservice containers, host nginx (SSL), container nginx (:85), Postgres, Redis, Qdrant, Elastic, GitLab |
| `.61` | vLLM `ai_service:9000` (gpt-oss-20b, Harmony) fronted by nginx :80; `ai_adapter:9100`; A/B `vllm-openai:9001` |
| `.62` | vLLM `vllm:8000` (qwen2.5-vl-7b) fronted by nginx :80 |

All standard-image swaps in this runbook deploy to `.68`. No changes to
`.61` / `.62`.

## Current state on `.68` (May 2026)

| Service / flag | Live? | What this runbook does |
|---|---|---|
| `litellm` container | ✅ running (was unhealthy — fixed in this branch) | step 0: redeploy with corrected healthcheck |
| `USE_LITELLM=1` on `llm-gateway` | ❌ flag=0 | step 1: flip + restart `llm-gateway` |
| `USE_DOCLING=1` on `doc-processor` + `docling-serve` container | ❌ both off | step 2: build image, enable include, flip flag |
| `USE_SEARXNG=1` on `search-service` + `searxng` container | ❌ both off | step 3: enable include, flip flag |
| `tei` container (replaces `embeddings-service`) | ❌ off | step 4: build image, stop legacy, enable include |
| `whisper-server` container (replaces `stt-service`) | ❌ off | step 5: build image, stop legacy, enable include |
| `openedai-speech` container (replaces `tts-service`) | ❌ off | step 6: download voices, stop legacy, enable include |

**Lowest-risk first order**: 0 → 1 → 2 → 3 → 4 → 5 → 6. Each step is
independently revertible. Verify after each step before moving on.

All commands run on `.68` from `~/simorgh-chatbot-ekc-deploy/simorgh-agent/`
unless noted otherwise.

---

## Step 0 — Fix the `litellm` `(unhealthy)` state

**Root cause:** the `svc-litellm.yml` healthcheck used `curl`, but
`ghcr.io/berriai/litellm:main-stable` is a python-slim image with no
`curl` / `wget`. The proxy itself was serving `/health/liveliness:200`
the whole time; only the docker healthcheck binary was missing. Fixed in
this branch to use `python -c urllib.request.urlopen(...)`.

```bash
# Pull the branch:
git checkout claude/eager-euler-lMDjZ
git pull --ff-only origin claude/eager-euler-lMDjZ

# Sanity check the proxy itself is responding (should print {"status":"healthy"}):
docker exec litellm python -c \
  "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:4000/health/liveliness', timeout=5).read().decode())"

# Recreate the container so the new healthcheck takes effect:
docker compose up -d --force-recreate litellm

# Verify (wait ~60s for two healthcheck cycles):
docker ps --filter name=^litellm$ --format '{{.Names}}\t{{.Status}}'
# expect: litellm    Up XXs (healthy)
```

**Rollback:** none needed — purely a healthcheck binary change. The
proxy itself was always fine.

---

## Step 1 — Enable `USE_LITELLM=1` shim on `llm-gateway`

Routes every llm-gateway backend (online / offline_text / offline_vlm)
through the existing `litellm` container. `litellm/config.yaml` already
points at `http://192.168.1.61/v1` (gpt-oss-20b) and
`http://192.168.1.62/v1` (qwen2.5-vl-7b) on the GPU boxes' nginx
fronts.

**Pre-flight (1 min):**
```bash
# Litellm proxy is healthy from step 0?
docker ps --filter name=^litellm$ --format '{{.Status}}' | grep -q healthy && echo OK

# .61 nginx is up?
curl -sf http://192.168.1.61/v1/models | python3 -m json.tool | head -20
# .62 nginx is up?
curl -sf http://192.168.1.62/v1/models | python3 -m json.tool | head -20

# Direct probe through litellm — should return a token via .61:
docker exec litellm python -c "
import urllib.request, json
req = urllib.request.Request('http://127.0.0.1:4000/v1/chat/completions',
  data=json.dumps({'model':'gpt-oss-20b',
                   'messages':[{'role':'user','content':'say hi'}],
                   'max_tokens':5}).encode(),
  headers={'Content-Type':'application/json'})
print(urllib.request.urlopen(req, timeout=30).read().decode()[:500])
"
```
If the last command returns a non-empty `choices[0].message.content`,
LiteLLM → vLLM is wired correctly.

**Activate:**
```bash
# Add to simorgh-agent/.env (or export inline for the next compose call):
echo 'USE_LITELLM=1' >> .env

# Recreate llm-gateway with the new env:
docker compose up -d --force-recreate llm-gateway
```

**Verify:**
```bash
# /health should report litellm.enabled=true:
curl -s http://localhost:85/api/llm-gateway/health | python3 -m json.tool
# look for:
#   "litellm": { "enabled": true, "url": "http://litellm:4000" }

# /health/deep should show checks.litellm.ok=true:
curl -s http://localhost:85/api/llm-gateway/health/deep | python3 -m json.tool
# look for:
#   "checks": { "litellm": { "ok": true, "status": 200 } }

# End-to-end via /generate (the route chat-service / project-agent use):
curl -sX POST http://localhost:85/api/llm-gateway/generate \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"یک جمله کوتاه به فارسی بنویس"}],
       "mode":"offline","max_tokens":40}' | python3 -m json.tool
```

**Rollback (instant):**
```bash
sed -i 's/^USE_LITELLM=.*/USE_LITELLM=0/' .env  # or just delete the line
docker compose up -d --force-recreate llm-gateway
```

---

## Step 2 — `USE_DOCLING=1` + `docling-serve` (PDF/DOCX → Markdown)

Pattern A: `doc-processor` keeps running; only when `USE_DOCLING=1` does
it call the docling-serve container, with **silent fallback** to the
pdfplumber+EasyOCR pipeline on any failure.

Two ways to get the ~1.5 GB document-AI bundle (layout-heron,
tableformer, code-equation, easyocr) onto `.68`:

* **Phase 2a — recommended on .68**: download on a GitHub runner, ship
  a tarball. The in-image build (`docling-tools models download`
  inside `docker build`) stalls on the larger model weights through
  Xray; the GH runner has fast direct HF access.
* **Phase 2b — only where HF is fast/direct**: original build path that
  bakes models into the image.

Both end up populating the `simorgh_docling_models` docker volume that
`svc-docling.yml` mounts at `/opt/docling-models`.

### Phase 2a — fetch models via GitHub Actions (recommended)

**On GitHub:**

1. Repo → **Actions** → **Download Docling models**.
2. *Run workflow*. Inputs:
   * `docling_image_tag`: `latest` (default).
   * `parts`: `1` if the host can scp ~1.5 GB in one shot; `2`+ to
     stay under the 5 GB/day proxy cap (each part is its own
     artifact, downloadable on different days).
3. Wait ~10 min. Final log step prints the exact `gh run download`
   + `scp` + extract commands tailored to your run-id and split.

**On any internet-connected workstation:**

```bash
# Single piece:
gh run download <RUN_ID> -R shahram-tabasi/simorgh-chatbot-ekc-deploy \
    -n docling-models
sha256sum -c docling-models.tar.gz.sha256

# OR split into N parts (download each on a different day):
for i in $(seq 1 N); do
  gh run download <RUN_ID> -R shahram-tabasi/simorgh-chatbot-ekc-deploy \
      -n docling-models-part-${i}ofN
done
chmod +x REASSEMBLE.sh && ./REASSEMBLE.sh   # → docling-models.tar.gz
```

**Transfer + extract on `.68`:**

```bash
scp docling-models.tar.gz ubuntu@192.168.1.68:/tmp/

# (now on .68)
docker volume create simorgh_docling_models
docker run --rm \
  -v simorgh_docling_models:/dst \
  -v /tmp:/src:ro \
  alpine sh -c '
    tar xzf /src/docling-models.tar.gz -C /dst &&
    chown -R 1001:0 /dst &&
    chmod -R g+rwX /dst &&
    du -sh /dst
  '
# expect: ~1.5G   /dst

# Tag the upstream image as `simorgh-docling:offline` so the compose
# `image:` resolves without rebuilding:
docker pull quay.io/docling-project/docling-serve-cpu:latest  # if needed
docker tag quay.io/docling-project/docling-serve-cpu:latest simorgh-docling:offline
```

Skip phase 2b — jump to phase 2c.

### Phase 2b — build models into the image (where HF is fast)

The original path. Models get baked into the image at build time, then
copied into the (initially empty) named volume on first start. Don't
use this on .68 — `docling-tools models download` will stall on the
larger files through Xray.

```bash
docker build -t simorgh-docling:offline -f docling/Dockerfile docling/
docker images simorgh-docling:offline
```

### Phase 2c — activate Docling

```bash
cd ~/simorgh-chatbot-ekc-deploy/simorgh-agent

# 1. Uncomment the include in docker-compose.yml:
sed -i 's|^  # - compose/svc-docling.yml|  - compose/svc-docling.yml|' docker-compose.yml
grep -n 'compose/svc-docling.yml' docker-compose.yml
# expect a line WITHOUT a leading '#'

# 2. Add the flag to .env:
grep -q '^USE_DOCLING=' .env 2>/dev/null && \
  sed -i 's/^USE_DOCLING=.*/USE_DOCLING=1/' .env || \
  echo 'USE_DOCLING=1' >> .env
grep USE_DOCLING .env

# 3. Start docling-serve:
docker compose up -d docling-serve

# 4. Wait for healthy (first-boot model load ~60s):
until docker ps --filter name=^docling-serve$ --format '{{.Status}}' | grep -q '(healthy)'; do
  echo "still starting: $(docker ps --filter name=^docling-serve$ --format '{{.Status}}')"
  sleep 5
done
echo "OK — docling-serve healthy"

# 5. Recreate doc-processor with the new env:
docker compose up -d --force-recreate doc-processor
until docker ps --filter name=^doc-processor$ --format '{{.Status}}' | grep -q '(healthy)'; do
  sleep 3
done
echo "OK — doc-processor healthy"
```

### Phase 2d — verify

```bash
# A. doc-processor sees the flag and the upstream:
docker exec doc-processor env | grep -E 'USE_DOCLING|DOCLING_URL'

# B. doc-processor can reach docling-serve over the app network:
docker exec doc-processor wget -qO- http://docling-serve:5001/health

# C. Models actually present in the volume:
docker exec docling-serve ls -la /opt/docling-models | head -10

# D. Tail logs during a real upload — look for docling, NOT pdfplumber:
docker logs -f doc-processor 2>&1 | grep -iE 'docling|pdfplumber|fallback|extract'
```

**Rollback (instant):**
```bash
sed -i 's/^USE_DOCLING=.*/USE_DOCLING=0/' .env
docker compose up -d --force-recreate doc-processor
# pdfplumber+EasyOCR fallback re-engages immediately.
docker compose stop docling-serve   # optional — saves RAM
```

---

## Step 3 — `USE_SEARXNG=1` + `searxng` (web metasearch)

Pattern A. `search-service` keeps running; only when `USE_SEARXNG=1` are
web_search calls routed through SearXNG, with silent fallback to the
DuckDuckGo wrapper.

**⚠ Air-gap caveat:** SearXNG calls `google.com` / `bing.com` /
`wikipedia.org` upstream and needs outbound HTTPS. If your `.68` is
genuinely air-gapped, skip this step entirely — don't enable web search
in CoT instead.

**Activate:**
```bash
# 1. Generate a real secret_key (any random string works for an internal
#    instance; this just signs the session cookie):
SECRET=$(openssl rand -hex 32)
echo "SEARXNG_SECRET=${SEARXNG_SECRET}" >> .env
# OR edit searxng/settings.yml line 'secret_key:' directly.

# 2. Uncomment the include:
sed -i 's|^  # - compose/svc-searxng.yml|  - compose/svc-searxng.yml|' docker-compose.yml

# 3. Flip the flag:
echo 'USE_SEARXNG=1' >> .env

# 4. Start SearXNG, recreate search-service:
docker compose up -d searxng
docker compose up -d --force-recreate search-service
```

**Verify:**
```bash
# SearXNG is up and answering JSON:
docker exec search-service wget -qO- 'http://searxng:8080/search?q=tehran+weather&format=json' \
  | python3 -m json.tool | head -40

# CoT/agent path — first web_search through CoT should hit SearXNG, not DDG:
docker logs -f search-service 2>&1 | grep -iE 'searxng|duckduckgo|fallback'
```

**Rollback:**
```bash
sed -i 's/^USE_SEARXNG=.*/USE_SEARXNG=0/' .env
docker compose up -d --force-recreate search-service
docker compose stop searxng
```

---

## Step 4 — `tei` replaces `embeddings-service` (Pattern B, alias swap)

⚠ **This stops the legacy service.** Pattern B uses a Docker network
alias so existing clients (`chat-service`, `project-agent-service`,
`documents-rag-service`, `hr-kb-service`) keep dialling
`http://embeddings-service:8031` and Docker DNS resolves to the new
container. Two containers cannot share the alias, so the **legacy
service must be stopped first**.

TEI's default model is the same `sentence-transformers/all-MiniLM-L6-v2`
(384-dim) your current embeddings-service uses, so existing Qdrant
collections stay compatible. Don't switch to `bge-m3` / `e5-large`
without a re-embedding plan — Qdrant collection dims are immutable.

**Build the offline image:**
```bash
docker build \
  --build-arg EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2 \
  -t simorgh-tei:offline -f tei/Dockerfile tei/
# ~80 MB model download during build.
```

**Activate:**
```bash
# 1. Uncomment the include:
sed -i 's|^  # - compose/svc-tei.yml|  - compose/svc-tei.yml|' docker-compose.yml

# 2. Stop the legacy service so its alias is released:
docker compose stop embeddings-service

# 3. Start TEI (it registers the alias `embeddings-service` on app_net):
docker compose up -d tei

# 4. Confirm Docker DNS now resolves to TEI:
docker exec chat-service getent hosts embeddings-service
# IP should match `docker inspect tei | grep IPAddress`
```

**Verify:**
```bash
# OpenAI-compatible probe through the legacy hostname:
docker exec chat-service wget -qO- --post-data='{"input":["سلام"]}' \
  --header='Content-Type: application/json' \
  http://embeddings-service:8031/v1/embeddings | python3 -m json.tool | head -20

# Dimension MUST be 384 (same as legacy) or downstream Qdrant ops will fail.

# End-to-end: re-upload a known doc to documents-rag-service or hr-kb-service
# and confirm the embedding pipeline returns 200.
docker logs -f tei 2>&1 | head -50
```

**Rollback:**
```bash
docker compose stop tei
docker compose start embeddings-service
# Permanently disable: re-comment the include line.
```

---

## Step 5 — `whisper-server` replaces `stt-service` (Pattern B)

Same alias-swap pattern as TEI. Persian-tuned Whisper baked in;
`/v1/audio/transcriptions` compatible.

**Build:**
```bash
docker build \
  --build-arg WHISPER_MODEL=MohammadGholizadeh/whisper-large-v3-persian-common-voice-17 \
  -t simorgh-whisper:offline -f whisper/Dockerfile whisper/
# ~3 GB after CT2 conversion. First build is slow.

# Faster-but-slightly-worse alternative:
# docker build --build-arg WHISPER_MODEL=vhdm/whisper-large-fa-v1 \
#   -t simorgh-whisper:offline -f whisper/Dockerfile whisper/
```

**Activate:**
```bash
sed -i 's|^  # - compose/svc-whisper.yml|  - compose/svc-whisper.yml|' docker-compose.yml
docker compose stop stt-service
docker compose up -d whisper-server
```

**Verify:**
```bash
docker ps --filter name=^whisper-server$ --format '{{.Status}}'
# First boot does CTranslate2 conversion — start_period in healthcheck is
# 120s; give it ~3 min before declaring it broken.

docker exec chat-service wget -qO- http://stt-service:8001/health
# expect 200; alias resolves to whisper-server.

# Real audio test (replace path with a small wav/m4a):
# curl -X POST -F file=@/tmp/sample-fa.wav \
#   http://localhost:85/api/v2/<your-stt-route> ...
```

**Rollback:**
```bash
docker compose stop whisper-server
docker compose start stt-service
```

---

## Step 6 — `openedai-speech` replaces `tts-service` (Pattern B)

Same alias-swap pattern. Piper voices must be **pre-downloaded** into
`simorgh-agent/tts/voices/` — image expects them mounted in read-only.

**Pre-download voices (one-time):**
```bash
cd tts/voices

# Persian (required) — ~75 MB:
wget https://huggingface.co/karim23657/Persian-Piper-Model-gyro/resolve/main/fa_IR-amir-medium.onnx
wget https://huggingface.co/karim23657/Persian-Piper-Model-gyro/resolve/main/fa_IR-amir-medium.onnx.json

# English fallback (optional):
# wget https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx
# wget https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json

cd -
ls -lh tts/voices/   # confirm the .onnx files are there
```

If your `.68` Xray VPN can't reach huggingface.co directly, download on
any internet-connected host and `scp` the files in.

**Activate:**
```bash
sed -i 's|^  # - compose/svc-openedai-speech.yml|  - compose/svc-openedai-speech.yml|' docker-compose.yml
docker compose stop tts-service
docker compose up -d openedai-speech
```

**Verify:**
```bash
docker ps --filter name=^openedai-speech$ --format '{{.Status}}'

# Voice list (should include alloy/echo/fable/onyx/nova/shimmer/fa_amir):
docker exec chat-service wget -qO- http://tts-service:8002/v1/models | python3 -m json.tool

# Generate a Persian sample (saves to /tmp/sample.mp3 inside chat-service):
docker exec chat-service sh -c '
  wget -qO /tmp/sample.mp3 --post-data="{\"model\":\"tts-1\",\"voice\":\"alloy\",\"input\":\"سلام، سیمرغ هستم.\"}" \
    --header="Content-Type: application/json" \
    http://tts-service:8002/v1/audio/speech
  ls -lh /tmp/sample.mp3
'
```

**Rollback:**
```bash
docker compose stop openedai-speech
docker compose start tts-service
```

---

## Sanity checklist after all 6 steps

```bash
# All containers healthy:
docker ps --format '{{.Names}}\t{{.Status}}' | grep -v healthy | grep -v 'starting'
# Should print only nginx (no healthcheck) + filebeat etc — nothing matching
# litellm / docling-serve / searxng / tei / whisper-server / openedai-speech.

# Pattern B aliases resolve to NEW containers, not legacy ones:
for svc in embeddings-service stt-service tts-service; do
  echo -n "$svc -> "; docker exec chat-service getent hosts $svc
done

# Sanity: still serving traffic end-to-end. Open the app, send a chat
# message in Persian, upload a PDF, request a voice reply. All should
# work without code changes.
```

---

## When to abort and call for help

* Step 0 healthcheck still says `unhealthy` after 2 cycles → `docker
  logs litellm --tail 100`, look for worker crashes. Likely a config.yaml
  parse error.
* Step 1 `/health/deep` returns `checks.litellm.ok: false` →
  `docker exec llm-gateway curl -v http://litellm:4000/health/liveliness`
  to isolate gateway → litellm.
* Step 4 dimension mismatch (TEI returns 768 instead of 384) → revert
  immediately; Qdrant inserts will start failing within seconds.
* Pattern B steps where the alias doesn't resolve → both legacy and new
  containers stopped, or Docker network `simorgh_app_net` is borked.
  `docker network inspect simorgh_app_net | grep -A2 Aliases`.
