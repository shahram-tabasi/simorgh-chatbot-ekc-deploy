# Phase 7 added a bge-reranker-v2-m3 cross-encoder pass over
# /search/content. That needs sentence-transformers + torch, which
# would balloon a python:3.12-slim base by ~3 GB and pull torch from
# pypi over the metered link. Reuse the pytorch/pytorch image the
# rest of the torch-using services already pull
# (project-agent-service, embeddings-service, doc-processor, backend
# all use this base) — same layers, no extra disk.
FROM pytorch/pytorch:2.5.0-cuda12.4-cudnn9-runtime
# ---- Air-gapped registry proxies (override at build with --build-arg) ----
ARG PIP_INDEX_URL=https://pypi.org/simple/
ARG PIP_TRUSTED_HOST=
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST} \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    npm_config_registry=${NPM_REGISTRY}


WORKDIR /app
RUN printf '%s\n' 'Acquire::Retries "20";' 'Acquire::http::Timeout "300";' 'Acquire::https::Timeout "300";' 'Acquire::http::No-Cache "true";' > /etc/apt/apt.conf.d/99retries


ARG APT_MIRROR=
ARG APT_SECURITY_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then \
      printf 'deb %s trixie main\ndeb %s trixie-updates main\n' \
        "$APT_MIRROR" "$APT_MIRROR" > /etc/apt/sources.list; \
      if [ -n "$APT_SECURITY_MIRROR" ]; then \
        printf 'deb %s trixie-security main\n' "$APT_SECURITY_MIRROR" \
          >> /etc/apt/sources.list; \
      fi; \
      rm -f /etc/apt/sources.list.d/debian.sources; \
      echo 'Acquire::http::Pipeline-Depth "0";' > /etc/apt/apt.conf.d/99nexus; \
    fi

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

COPY context-search-service/requirements.txt .
# torch is already in the pytorch base image — strip any torch line
# out of requirements.txt at install time so pip doesn't try to
# reinstall (or downgrade) the CUDA-built wheel.
RUN sed -i '/^torch\b/d;/^torchaudio\b/d;/^torchvision\b/d' requirements.txt \
 && pip install --no-cache-dir --timeout 180 --retries 10 -r requirements.txt

COPY shared/ /opt/shared/
RUN pip install --no-cache-dir --timeout 180 --retries 10 -e /opt/shared/

COPY context-search-service/app.py .
COPY context-search-service/index_setup.py .

EXPOSE 8049
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8049"]
