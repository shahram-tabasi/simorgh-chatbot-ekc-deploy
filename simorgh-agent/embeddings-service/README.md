# embeddings-service

Standalone REST microservice that turns text into vectors using a
**sentence-transformers** model. This is the non-LLM embedding path —
faster, free, deterministic, and good enough for general semantic search
when you don't need the domain-tuned LLM embeddings from `llm-gateway`.

| Property | Value |
|---|---|
| Container | `embeddings-service` |
| Port (internal) | **8031** |
| Image | built from `simorgh-agent/embeddings-service/Dockerfile` |
| Compose file | `simorgh-agent/compose/svc-embeddings.yml` |
| Network | `simorgh_app_net` |
| Mounted at nginx | `/api/embeddings/` (host nginx) |

---

## What it does

* Loads a sentence-transformers model **at startup** (not lazily) and keeps
  it pinned in memory.
* Returns L2-normalised float vectors (default), dimension determined by the
  loaded model.
* Caps batch size to protect memory.
* Exposes the model name + dimension at `/info` so callers can verify
  compatibility before sending traffic.

It does **not** do:

* Multi-model serving — one container, one model. Run a second container
  with a different `EMBEDDING_MODEL` if you need both.
* Caching — every request re-encodes. Add Redis-keyed caching upstream if
  you re-encode the same texts often.
* GPU inference by default — set `EMBEDDING_DEVICE=cuda` if you mount a GPU.

---

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET`  | `/health`           | — | `{"status": "healthy", "model": "...", "dim": 384, "device": "cpu"}` |
| `GET`  | `/info`             | — | `{"model": "...", "dim": 384, "device": "cpu", "normalize": true}` |
| `POST` | `/embeddings`       | `{"text": "..."}` | `{"embedding": [..floats..], "dim": 384}` |
| `POST` | `/embeddings/batch` | `{"texts": ["...", "..."]}` | `{"embeddings": [[..],[..]], "count": 2, "dim": 384}` |

### Status codes

| Code | When |
|---|---|
| `200` | Success |
| `400` | `text` missing / `texts` empty |
| `413` | Batch larger than `MAX_BATCH_SIZE` |

---

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `EMBEDDING_MODEL` | `sentence-transformers/all-MiniLM-L6-v2` | HF model id; 384-dim, fast, English |
| `EMBEDDING_DEVICE` | `cpu` | Set to `cuda` for GPU |
| `EMBEDDING_NORMALIZE` | `true` | L2-normalise vectors (good for cosine similarity) |
| `MAX_BATCH_SIZE` | `256` | Reject batches larger than this with 413 |
| `HF_HOME` | `/root/.cache/huggingface` | Where the model is cached on disk |
| `SENTENCE_TRANSFORMERS_HOME` | `/root/.cache/torch/sentence_transformers` | |
| `LOG_LEVEL` | `INFO` | |

The HF caches are mounted as named volumes (`simorgh_huggingface_cache`,
`simorgh_sentence_transformers_cache`) so the model is downloaded once and
shared with the backend container too.

---

## Performance notes

| Model | dim | latency (CPU, MiniLM batch=1) |
|---|---|---|
| `all-MiniLM-L6-v2` | 384 | ~10 ms |
| `all-mpnet-base-v2` | 768 | ~50 ms |
| `paraphrase-multilingual-mpnet-base-v2` | 768 | ~60 ms (multilingual incl. Persian) |

For Persian text (your chat content is often Persian), consider switching
`EMBEDDING_MODEL` to `paraphrase-multilingual-mpnet-base-v2`. **Switching
models means re-indexing every document already in Qdrant** — you can't
mix vectors of different dims in the same collection.

---

## Talking to other services

```
   /api/embeddings/         ┌────────────────────────┐
   ─────────────▶ nginx ───▶│ embeddings-service:8031│
                            │     model: MiniLM       │ ──▶ HF cache
                            └────────────────────────┘     volume
```

Stateless apart from the in-memory model, so trivially replicable.

---

## How it collaborates with `backend/main.py`

Currently backend's `services/qdrant_service.py` instantiates a
`SentenceTransformer` in-process. After phase C the
`QdrantService.generate_embedding()` method becomes a thin HTTP call:

```python
# backend/services/embeddings_client.py (after phase C)
import httpx, os

EMBEDDINGS_URL = os.getenv("EMBEDDINGS_URL", "http://embeddings-service:8031")

class EmbeddingsClient:
    def __init__(self):
        self._http = httpx.Client(base_url=EMBEDDINGS_URL, timeout=30.0)

    def encode(self, text: str) -> list[float]:
        return self._http.post("/embeddings", json={"text": text}).json()["embedding"]

    def encode_batch(self, texts: list[str]) -> list[list[float]]:
        # chunk into MAX_BATCH_SIZE-sized requests
        chunks = [texts[i:i+256] for i in range(0, len(texts), 256)]
        return sum([self._http.post("/embeddings/batch", json={"texts": c}).json()["embeddings"] for c in chunks], [])
```

In the existing `QdrantService.__init__` the model load:

```python
self.embedding_model = SentenceTransformer(embedding_model)
```

becomes:

```python
self._embeddings = EmbeddingsClient()
info = self._embeddings._http.get("/info").json()
self.embedding_model_name = info["model"]
self.embedding_dim = info["dim"]
```

and `generate_embedding(text)`:

```python
return self._embeddings.encode(text)
```

The Qdrant-side dimension validation already exists — it'll catch a mismatch
between the embedding service's `dim` and an existing collection's `vector_size`.

---

## Local development

### Run alone

```bash
cd simorgh-agent
docker compose -f compose/svc-embeddings.yml up --build
```

### Without Docker (host)

```bash
cd simorgh-agent/embeddings-service
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8031 --reload
```

First start downloads ~80 MB for MiniLM. Subsequent starts use the cache.

### Smoke tests

```bash
curl -s http://localhost:8031/health
# {"status":"healthy","model":"sentence-transformers/all-MiniLM-L6-v2","dim":384,"device":"cpu"}

curl -s http://localhost:8031/info

curl -s -X POST http://localhost:8031/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"text": "industrial transformer"}' \
  | jq '.dim, (.embedding | length)'
# 384
# 384

curl -s -X POST http://localhost:8031/embeddings/batch \
  -H 'Content-Type: application/json' \
  -d '{"texts": ["a","b","c"]}' \
  | jq '.count, .dim'
# 3
# 384
```

---

## Files

| File | Purpose |
|---|---|
| `main.py` | FastAPI app — model load, encode endpoints |
| `requirements.txt` | sentence-transformers, torch, fastapi, uvicorn, numpy |
| `Dockerfile` | python:3.11-slim, exposes 8031, healthcheck on `/health`, `start_period: 180s` for cold model download |

---

## Roadmap / known gaps

* **Caching** — same text → same vector. Hash by sha256(text) and cache in
  Redis with a long TTL.
* **GPU** — needs a `runtime: nvidia` block in compose and `cuda` device. Worth
  it if QPS gets high; not for current load.
* **Multilingual** — switch to `paraphrase-multilingual-mpnet-base-v2` if
  Persian text retrieval gets bad. Re-index Qdrant after.
* **Async batch endpoint** — for very large batch jobs, accept and return a
  job id; let documents-rag-service poll. Not needed yet.
