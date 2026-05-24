# Service migration map — standard images for hand-rolled services

This doc tracks the migration from custom services to off-the-shelf
Docker images. Each row shows the swap path. **All swaps are opt-in
with silent fallback** — flipping any flag can't break production.

## Migration table

| # | Custom service       | Standard image                  | Swap mechanism                                    | Status   |
|---|----------------------|---------------------------------|---------------------------------------------------|----------|
| 1 | `doc-processor`      | `docling-serve` (IBM)           | `USE_DOCLING=1` env (in `svc-doc-processor.yml`)  | ✅ wired |
| 2 | `embeddings-service` | `tei` (HF Text Embeddings)      | Docker network alias on `tei` ⇒ `embeddings-service` | ✅ wired |
| 3 | `stt-service`        | `whisper-server` (faster-whisper) | Docker network alias on `whisper-server` ⇒ `stt-service` | ✅ wired |
| 4 | `tts-service`        | `openedai-speech` (Piper/XTTS)  | Docker network alias on `openedai-speech` ⇒ `tts-service` | ✅ wired |
| 5 | `search-service`     | `searxng` (privacy metasearch)  | `USE_SEARXNG=1` env (in `svc-search.yml`)         | ✅ wired |
| 6 | `llm-gateway`        | `litellm` (LiteLLM Proxy)       | Manual — has custom `/api/llm/*` routes           | ⏸ deferred |

## Activation patterns

### Pattern A — `USE_*=1` feature flag (doc-processor, search-service)

The legacy service stays in place but routes upstream traffic through the
standard image when the flag is set. Silent fallback to the legacy code
path on any failure.

**Workflow:**
1. Add the standard-image service to `docker-compose.yml` (uncomment include).
2. Build the offline image once (see service's `Dockerfile`).
3. Set `USE_<X>=1` in `.env`.
4. `docker compose up -d <standard-image-service> <legacy-service>`.
5. Verify via `/health` endpoint — should report `<x>.enabled: true`.

Used by: docling (PDF), SearXNG (web search).

### Pattern B — Docker network alias (TEI, whisper, openedai-speech)

The standard-image service registers a network alias matching the legacy
hostname. Stop the legacy service, start the new one — clients hit the
same `http://<hostname>:<port>` and Docker DNS resolves to the new
container. Zero code changes anywhere.

**Workflow:**
1. Build the standard-image's offline image (see its `Dockerfile`).
2. `docker compose stop <legacy-service>`  (frees the alias).
3. Uncomment the standard-image include in `docker-compose.yml`.
4. `docker compose up -d <standard-image-service>`.
5. Existing clients keep working — no env-var changes.

To roll back: `docker compose stop <standard-image-service>` then
`docker compose start <legacy-service>`.

Used by: TEI ⇒ embeddings-service, whisper ⇒ stt-service,
openedai-speech ⇒ tts-service.

### Pattern C — Deferred (LiteLLM)

`llm-gateway` exposes Simorgh-specific routes:
- `/api/llm/generate-stream` (SSE shim)
- `/api/llm/route` (mode routing: online/offline/voice)
- `/api/llm/forms` (form-mode)

LiteLLM doesn't speak these. Two migration paths to choose from when
ready (separate PR):

1. **Clean cut**: update clients (chat-service, project-agent) to call
   LiteLLM's `/v1/chat/completions` directly. Removes one hop, drops
   the legacy routes entirely.

2. **Shim**: keep `llm-gateway` as a thin translator that converts
   `/api/llm/*` requests into `/v1/chat/completions` and forwards to
   LiteLLM. Zero client changes; LiteLLM owns provider routing /
   failover / cost tracking.

Recommendation: pick **(2)** unless you're already touching the client
code for other reasons.

## Activation order (lowest risk first)

1. **TEI** — Pattern B. Just a hostname swap; either it works or the service
   won't start. Easy to verify by re-embedding a known doc and comparing
   the vector dimensions.
2. **Docling** — Pattern A. Already wired. Set `USE_DOCLING=1` and re-process
   a known PDF.
3. **SearXNG** — Pattern A. Just wired. Set `USE_SEARXNG=1`. Note: SearXNG
   itself NEEDS outbound HTTPS to upstream search engines; not for fully
   air-gapped deploys.
4. **Whisper-server** — Pattern B. Drop in when you're ready to use voice
   for real (also when wiring VoIP per `docs/voip-integration.md`).
5. **OpenedAI-speech** — Pattern B. Pair with whisper-server.
6. **LiteLLM** — Pattern C. Plan the migration in a separate PR with a
   client-code audit.

## Honest caveats

- **All alias swaps require the new service to listen on the legacy
  port.** TEI is configured to listen on `8031` (embeddings-service's
  port), whisper on `8001` (stt-service's port), openedai-speech on
  `8002` (tts-service's port). If you change those ports later, the
  aliases need to track.

- **Re-embedding when swapping TEI's model.** TEI's default keeps
  `all-MiniLM-L6-v2` (384-dim) for Qdrant compatibility. Switching to
  multilingual `bge-m3` (1024-dim) for better Persian quality requires
  re-embedding every existing Qdrant collection — the dimension count
  is part of the collection schema.

- **SearXNG needs outbound HTTPS.** It queries google.com / bing.com /
  duckduckgo.com / wikipedia.org on your behalf. For a fully air-gapped
  deployment, leave `USE_SEARXNG=0` and the CoT planner will simply skip
  the web-search rung.

- **Persian phone-audio WER hit.** The Persian Whisper fine-tune was
  trained on Common Voice (clean 16 kHz). Real phone audio (narrowband
  8 kHz, GSM codec) will give materially worse WER (+5-8 percentage
  points). Mitigation: RNNoise / Krisp upstream of STT — see VoIP
  integration plan.
