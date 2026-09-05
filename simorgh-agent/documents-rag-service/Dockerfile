# Align with project-agent-service so both services share the same base
# image layer (saves 12 GB of disk on a host that currently has 2.5.0 +
# 2.6.0 = 24 GB of redundant base layers cached). Torch 2.6 is the
# version `simorgh-project-agent-service` builds on; using the same
# tag lets Docker reuse the FROM layer across both services and avoids
# a re-download of torch on every requirements bump (the conda-shipped
# torch in this image satisfies the import; we no longer pin torch in
# requirements.txt to avoid a 906 MB pip-side re-fetch).
FROM pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime
# ---- Air-gapped registry proxies (override at build with --build-arg) ----
ARG PIP_INDEX_URL=https://pypi.org/simple/
ARG PIP_TRUSTED_HOST=
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST} \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    npm_config_registry=${NPM_REGISTRY}


ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/root/.cache/huggingface \
    SENTENCE_TRANSFORMERS_HOME=/root/.cache/torch/sentence_transformers

RUN printf '%s\n' 'Acquire::Retries "20";' 'Acquire::http::Timeout "300";' 'Acquire::https::Timeout "300";' 'Acquire::http::No-Cache "true";' > /etc/apt/apt.conf.d/99retries



RUN apt-get update && apt-get install -y --no-install-recommends \
        wget curl ca-certificates build-essential libpq-dev \
        poppler-utils tesseract-ocr libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --timeout 180 --retries 10 --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8033

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=60s \
    CMD wget -qO- http://127.0.0.1:8033/health || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8033"]
