# =============================================================================
# Docling Serve — fully OFFLINE PDF/DOCX/PPTX/HTML → Markdown extraction
# =============================================================================
# IBM's Docling document-intelligence stack, wrapped as a FastAPI service.
# Models are downloaded ONCE at build time (~1.5 GB from HuggingFace
# ds4sd/docling-models) and baked into the image, so the runtime never
# touches the internet — matches Simorgh's offline-first deployment.
#
# Build (on an internet-connected host):
#   docker build -t simorgh-docling:offline -f docling/Dockerfile docling/
#
# To rebuild after a Docling upgrade:
#   docker build --no-cache --build-arg DOCLING_VERSION=2.62.0 \
#       -t simorgh-docling:offline -f docling/Dockerfile docling/
# =============================================================================
ARG DOCLING_BASE_TAG=latest
FROM quay.io/docling-project/docling-serve-cpu:${DOCLING_BASE_TAG}

# Stage 1: download model artifacts (requires network — build time only)
ENV DOCLING_SERVE_ARTIFACTS_PATH=/opt/docling-models
RUN mkdir -p "${DOCLING_SERVE_ARTIFACTS_PATH}" \
 && docling-tools models download --output-dir "${DOCLING_SERVE_ARTIFACTS_PATH}"

# Stage 2: lock the runtime to offline mode. HF_HUB_OFFLINE blocks any
# implicit huggingface_hub call; TRANSFORMERS_OFFLINE forces transformers
# to use only local cached models. Combined with the baked artifacts
# above, the container has no reason to reach the internet — set both
# at the image level so accidental code paths can't override at runtime.
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1
ENV HF_HOME=/opt/docling-models/hf-cache

# Sanity check: artifacts are present.
RUN test -d "${DOCLING_SERVE_ARTIFACTS_PATH}" \
 && echo "Docling models baked into image at: ${DOCLING_SERVE_ARTIFACTS_PATH}"

EXPOSE 5001
