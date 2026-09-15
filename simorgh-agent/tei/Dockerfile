# =============================================================================
# Text Embeddings Inference (TEI) — HuggingFace's production embeddings server
# =============================================================================
# Drop-in replacement for embeddings-service. OpenAI /v1/embeddings compatible,
# dynamic batching, 3-10× throughput vs sentence-transformers on the same
# hardware. Model pre-baked at build time so runtime is fully offline.
#
# Default model (--build-arg EMBEDDING_MODEL=...) is the same model your
# current embeddings-service uses (sentence-transformers/all-MiniLM-L6-v2,
# 384-dim, English-focused). Keep this for backward compatibility so existing
# Qdrant collections still work.
#
# UPGRADE PATH for better Persian quality (requires re-embedding all
# Qdrant collections — they're keyed by dimension count):
#   - BAAI/bge-m3                       1024-dim multilingual (Persian OK)
#   - intfloat/multilingual-e5-large    1024-dim multilingual (Persian OK)
#   - intfloat/multilingual-e5-base     768-dim (smaller, slightly worse)
#
# Built by the images-build workflow like everything else. To build it by hand
# against a different model (~80 MB for the default):
#   docker build --build-arg EMBEDDING_MODEL=BAAI/bge-m3 \
#     -t simorgh-tei:offline -f tei/Dockerfile tei/
# =============================================================================
ARG TEI_BASE_TAG=cpu-latest
ARG EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2

# ── Fetch the model somewhere that has a Python ──────────────────────────────
#
# The download used to run in the TEI image itself and failed with
# "python3: not found", because there is no python3 in it — TEI is a Rust
# binary and its image carries the binary and little else. It had never been
# caught: this service's include is commented out, so nobody had built it.
#
# So the download happens here, in an image that does have one, and only the
# files cross over. Nothing of this stage ends up in the published image.
FROM python:3.11-slim AS fetch
ARG EMBEDDING_MODEL
# The same internal PyPI mirror the rest of the stack takes, overridable for a
# runner that has no route to it.
ARG PIP_INDEX_URL=https://pypi.org/simple/
ARG PIP_TRUSTED_HOST=
ENV PIP_INDEX_URL=${PIP_INDEX_URL}
ENV PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST}
RUN pip install --no-cache-dir huggingface_hub
RUN mkdir -p /data \
 && python3 -c "from huggingface_hub import snapshot_download; \
                snapshot_download(repo_id='${EMBEDDING_MODEL}', \
                                  cache_dir='/data')"

# ── The server, with the model already in it ─────────────────────────────────
FROM ghcr.io/huggingface/text-embeddings-inference:${TEI_BASE_TAG}

# TEI's entrypoint takes the model from /data when --model-id is a local path;
# compose points it at the directory this puts there.
COPY --from=fetch /data /data
ENV HF_HOME=/data
ENV HUGGINGFACE_HUB_CACHE=/data

# Lock runtime to offline mode — no inadvertent network calls.
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1

# TEI default port.
EXPOSE 80
