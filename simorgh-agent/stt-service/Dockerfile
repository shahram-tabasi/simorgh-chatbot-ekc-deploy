# STT Service Dockerfile
# Uses CPU-based Faster-Whisper for speech-to-text
# Optimized for minimal memory footprint

FROM python:3.11-slim-bookworm
# ---- Air-gapped registry proxies (override at build with --build-arg) ----
ARG PIP_INDEX_URL=https://pypi.org/simple/
ARG PIP_TRUSTED_HOST=
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST} \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    npm_config_registry=${NPM_REGISTRY}


# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Install system dependencies (with BuildKit cache)
# ffmpeg is required for pydub audio conversion
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

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    wget \
    pkg-config \
    libavformat-dev \
    libavcodec-dev \
    libavdevice-dev \
    libavutil-dev \
    libswscale-dev \
    libswresample-dev \
    libavfilter-dev \
    build-essential

# Create app directory
WORKDIR /app

# Create models directory for Whisper cache
RUN mkdir -p /app/models

# Copy requirements first for layer caching
COPY requirements.txt .

# Install Python dependencies (with BuildKit cache)
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --timeout 180 --retries 10 -r requirements.txt

# Copy application code
COPY app.py .

# Expose port
EXPOSE 8001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget -qO- http://localhost:8001/health || exit 1

# Run the application
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001"]
