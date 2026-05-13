FROM python:3.11-slim
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


ARG APT_MIRROR=
ARG APT_SECURITY_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then \
      printf 'deb %s trixie main
deb %s trixie-updates main
' \
        "$APT_MIRROR" "$APT_MIRROR" > /etc/apt/sources.list; \
      if [ -n "$APT_SECURITY_MIRROR" ]; then \
        printf 'deb %s trixie-security main
' "$APT_SECURITY_MIRROR" \
          >> /etc/apt/sources.list; \
      fi; \
      rm -f /etc/apt/sources.list.d/debian.sources; \
      echo 'Acquire::http::Pipeline-Depth "0";' > /etc/apt/apt.conf.d/99nexus; \
    fi

RUN apt-get update && apt-get install -y --no-install-recommends \
        wget curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --timeout 180 --retries 10 --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8031

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=120s \
    CMD wget -qO- http://127.0.0.1:8031/health || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8031"]
