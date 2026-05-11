# Pin to specific release for consistent caching
FROM python:3.11-slim-bookworm

# Install system dependencies for document processing
# Use BuildKit cache mount for apt to speed up rebuilds
RUN printf '%s\n' 'Acquire::Retries "20";' 'Acquire::http::Timeout "300";' 'Acquire::https::Timeout "300";' 'Acquire::http::No-Cache "true";' > /etc/apt/apt.conf.d/99retries

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    # For PDF processing
    poppler-utils \
    ghostscript \
    # For image processing (updated package names for Debian Trixie)
    libgl1 \
    libglib2.0-0 \
    # For table extraction (camelot)
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    # Build tools
    gcc \
    g++ \
    # For health check
    wget

# Set working directory
WORKDIR /app

# Copy requirements first (for better layer caching)
COPY requirements.txt .

# Use BuildKit cache mount for pip to speed up rebuilds
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --timeout 180 --retries 10 -r requirements.txt

# Copy application code
COPY main.py .

# Create directories for temp files and output
RUN mkdir -p temp processed_docs

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8000/health || exit 1

# Run the application
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
