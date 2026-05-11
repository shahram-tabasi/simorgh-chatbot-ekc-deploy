# STT Service Dockerfile
# Uses CPU-based Faster-Whisper for speech-to-text
# Optimized for minimal memory footprint

FROM python:3.11-slim-bookworm

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Install system dependencies (with BuildKit cache)
# ffmpeg is required for pydub audio conversion
RUN printf '%s\n' 'Acquire::Retries "20";' 'Acquire::http::Timeout "300";' 'Acquire::https::Timeout "300";' 'Acquire::http::No-Cache "true";' > /etc/apt/apt.conf.d/99retries

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
