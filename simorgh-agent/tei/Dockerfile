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
# Build (once, on connected host — downloads ~80 MB for default model):
#   docker build --build-arg EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2 \
#     -t simorgh-tei:offline -f tei/Dockerfile tei/
# =============================================================================
ARG TEI_BASE_TAG=cpu-latest
FROM ghcr.io/huggingface/text-embeddings-inference:${TEI_BASE_TAG}

# Re-declare the build arg AFTER the FROM so it's visible to RUN below.
# This is a Docker quirk: build args declared before FROM apply only to the
# FROM line itself.
ARG EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2

# Bake the model into the image at build time. TEI's entrypoint expects
# the model in /data when --model-id is a local path; we download to
# /data/<model> and set --model-id to that path at runtime via compose.
ENV HF_HOME=/data
ENV HUGGINGFACE_HUB_CACHE=/data
RUN mkdir -p /data \
 && python3 -c "from huggingface_hub import snapshot_download; \
                snapshot_download(repo_id='${EMBEDDING_MODEL}', \
                                  cache_dir='/data', \
                                  local_dir_use_symlinks=False)"

# Lock runtime to offline mode — no inadvertent network calls.
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1

# TEI default port.
EXPOSE 80
