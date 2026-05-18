# =============================================================================
# Dockerfile for Simorgh Industrial Electrical Assistant - Backend
# =============================================================================
# Base: PyTorch 2.5 + CUDA 12.4 + cuDNN 9 (runtime)
# Python: 3.11
# Architecture: Neo4j + Redis + Hybrid LLM + SQL Server Auth
# Total size: ~15-20GB (includes all models and dependencies)
# =============================================================================

# -------------------------------------------------
#  Base Image: PyTorch 2.5 + CUDA 12.4 + cuDNN 9
# -------------------------------------------------
FROM pytorch/pytorch:2.5.0-cuda12.4-cudnn9-runtime
# ---- Air-gapped registry proxies (override at build with --build-arg) ----
ARG PIP_INDEX_URL=https://pypi.org/simple/
ARG PIP_TRUSTED_HOST=
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG UBUNTU_MIRROR=
ARG UBUNTU_SECURITY_MIRROR=
ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST} \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    npm_config_registry=${NPM_REGISTRY}

# Rewrite apt sources to use the Nexus apt-proxy when provided
# (jammy-style sources in /etc/apt/sources.list on the pytorch base image).
# Also tell apt to talk to the Nexus host DIRECT, not via $http_proxy
# (otherwise BuildKit's outer HTTP proxy tries to relay LAN traffic and 503s).
RUN if [ -n "${UBUNTU_MIRROR}" ]; then \
        sed -i "s|http://archive.ubuntu.com/ubuntu|${UBUNTU_MIRROR}|g" /etc/apt/sources.list && \
        sed -i "s|http://ports.ubuntu.com/ubuntu-ports|${UBUNTU_MIRROR}|g" /etc/apt/sources.list || true; \
    fi && \
    if [ -n "${UBUNTU_SECURITY_MIRROR}" ]; then \
        sed -i "s|http://security.ubuntu.com/ubuntu|${UBUNTU_SECURITY_MIRROR}|g" /etc/apt/sources.list || true; \
    fi && \
    for url in "${UBUNTU_MIRROR}" "${UBUNTU_SECURITY_MIRROR}"; do \
        host=$(echo "$url" | sed -E 's|^https?://([^/:]+).*|\1|'); \
        if [ -n "$host" ]; then \
            printf 'Acquire::http::Proxy::%s "DIRECT";\n' "$host" >> /etc/apt/apt.conf.d/99nexus-direct; \
        fi; \
    done && \
    if [ -f /etc/apt/apt.conf.d/99nexus-direct ]; then cat /etc/apt/apt.conf.d/99nexus-direct; fi


# -------------------------------------------------
#  Metadata
# -------------------------------------------------
LABEL maintainer="Simorgh Development Team"
LABEL description="Simorgh Industrial Electrical Assistant - Backend API"
LABEL version="2.0.0"

# -------------------------------------------------
#  Environment Variables
# -------------------------------------------------
ENV PYTHONUNBUFFERED=1
ENV DEBIAN_FRONTEND=noninteractive
ENV CUDA_VISIBLE_DEVICES=0
ENV TORCH_CUDA_ARCH_LIST="7.0 7.5 8.0 8.6 8.9 9.0+PTX"
ENV PIP_ROOT_USER_ACTION=ignore

# HuggingFace Model Cache Configuration
ENV HF_HOME=/root/.cache/huggingface
ENV TRANSFORMERS_CACHE=/root/.cache/huggingface/hub
ENV SENTENCE_TRANSFORMERS_HOME=/root/.cache/torch/sentence_transformers

# -------------------------------------------------
#  Remove any broken NVIDIA apt repos (TLS errors)
# -------------------------------------------------
RUN rm -f /etc/apt/sources.list.d/cuda* /etc/apt/sources.list.d/nvidia* || true

# -------------------------------------------------
#  Defensive apt config for slow / flaky upstream proxies
#  (Squid often disconnects mid-download on large .deb files).
# -------------------------------------------------
RUN printf '%s\n' \
    'Acquire::Retries "20";' \
    'Acquire::http::Timeout "300";' \
    'Acquire::https::Timeout "300";' \
    'Acquire::http::No-Cache "true";' \
    > /etc/apt/apt.conf.d/99retries

# -------------------------------------------------
#  Install Python 3.11 (with BuildKit cache)
# -------------------------------------------------
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    python3.11 \
    python3.11-dev \
    python3.11-venv \
    python3-pip \
    curl \
    wget

# -------------------------------------------------
#  System tools for OCR & PDF processing (with BuildKit cache)
# -------------------------------------------------
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    # PDF & OCR tools
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-eng \
    # Graphics libraries
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    # Build tools
    gcc \
    g++ \
    cmake \
    ninja-build \
    git \
    # Utilities
    vim \
    htop

# -------------------------------------------------
#  Upgrade pip, setuptools, wheel
# -------------------------------------------------
RUN python3.11 -m pip install --timeout 180 --retries 10 --upgrade pip setuptools wheel

# -------------------------------------------------
#  Make python3.11 the default
# -------------------------------------------------
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 && \
    update-alternatives --install /usr/bin/python python /usr/bin/python3.11 1

# -------------------------------------------------
#  Verify Python version
# -------------------------------------------------
RUN python3.11 --version && pip --version

# -------------------------------------------------
#  Workdir
# -------------------------------------------------
WORKDIR /app

# -------------------------------------------------
#  Copy requirements file
# -------------------------------------------------
COPY requirements.txt .

# -------------------------------------------------
#  Install Python packages (with BuildKit cache)
#  Single clean installation from requirements.txt
# -------------------------------------------------
RUN --mount=type=cache,target=/root/.cache/pip \
    echo "=== Installing Python dependencies ===" && \
    python3.11 -m pip install --timeout 180 --retries 10 -r requirements.txt && \
    echo "=== Python dependencies installed ==="

# -------------------------------------------------
#  Download NLTK data required by unstructured
# -------------------------------------------------
RUN echo "=== Downloading NLTK data ===" && \
    python3.11 -c "import nltk; \
    nltk.download('punkt', quiet=True); \
    nltk.download('punkt_tab', quiet=True); \
    nltk.download('averaged_perceptron_tagger', quiet=True); \
    nltk.download('averaged_perceptron_tagger_eng', quiet=True)" && \
    echo "=== NLTK data downloaded ==="

# -------------------------------------------------
#  Pre-cache tiktoken BPE files (cl100k_base + o200k_base)
#  Avoids runtime fetch of openaipublic.blob.core.windows.net
#  on air-gapped hosts.
# -------------------------------------------------
ENV TIKTOKEN_CACHE_DIR=/root/.cache/tiktoken
RUN mkdir -p ${TIKTOKEN_CACHE_DIR} && \
    echo "=== Pre-caching tiktoken encodings ===" && \
    python3.11 -c "import tiktoken; \
    tiktoken.get_encoding('cl100k_base').encode('warm'); \
    tiktoken.get_encoding('o200k_base').encode('warm'); \
    print('tiktoken encodings cached')" && \
    echo "=== tiktoken cached ==="

# -------------------------------------------------
#  Pre-download SentenceTransformer model
#  This avoids HuggingFace timeout issues at runtime
#  Model is cached in $SENTENCE_TRANSFORMERS_HOME and $HF_HOME
# -------------------------------------------------
RUN mkdir -p /root/.cache/huggingface/hub && \
    mkdir -p /root/.cache/torch/sentence_transformers && \
    echo "=== Pre-downloading SentenceTransformer model ===" && \
    python3.11 -c "from sentence_transformers import SentenceTransformer; \
    model = SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2'); \
    print(f'Model cached: {model.get_sentence_embedding_dimension()} dimensions'); \
    print(f'Cache locations: HF_HOME=/root/.cache/huggingface, SENTENCE_TRANSFORMERS_HOME=/root/.cache/torch/sentence_transformers')" && \
    echo "=== SentenceTransformer model cached ===" && \
    ls -la /root/.cache/huggingface/hub/ && \
    ls -la /root/.cache/torch/sentence_transformers/

# -------------------------------------------------
#  Verify critical packages are installed
# -------------------------------------------------
RUN echo "=== Verifying installations ===" && \
    python3.11 -c "import fastapi; print('✓ FastAPI')" && \
    python3.11 -c "import torch; print('✓ PyTorch')" && \
    python3.11 -c "import neo4j; print('✓ Neo4j')" && \
    python3.11 -c "import redis; print('✓ Redis')" && \
    python3.11 -c "from sentence_transformers import SentenceTransformer; print('✓ SentenceTransformers')" && \
    python3.11 -c "import unstructured; print('✓ Unstructured')" && \
    python3.11 -c "from pdfminer.pdfparser import PSSyntaxError; print('✓ pdfminer.six (with PSSyntaxError)')" && \
    echo "=== All packages verified successfully ==="

# -------------------------------------------------
#  Application files
# -------------------------------------------------
# Copy new architecture files
COPY main.py .
COPY services/ ./services/
COPY models/ ./models/
COPY routes/ ./routes/
COPY database/ ./database/
COPY middleware/ ./middleware/
COPY chatbot_core/ ./chatbot_core/
COPY utils/ ./utils/
COPY cocoindex_flows/ ./cocoindex_flows/
COPY knowledge/ ./knowledge/

# -------------------------------------------------
#  Create necessary directories
# -------------------------------------------------
RUN mkdir -p uploads && \
    chmod -R 755 /app

# -------------------------------------------------
#  Expose port
# -------------------------------------------------
EXPOSE 8890

# -------------------------------------------------
#  Health check
# -------------------------------------------------
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD python3.11 -c "import requests; requests.get('http://localhost:8890/health', timeout=5)" || exit 1

# -------------------------------------------------
#  Startup command
# -------------------------------------------------
CMD ["python3.11", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8890", "--workers", "1"]

# =============================================================================
# Build & Run Information
# =============================================================================
# Build command:
#   docker build -t simorgh-backend:latest .
#
# Run command:
#   docker run -d \
#     --name simorgh-backend \
#     --gpus all \
#     -p 8890:8890 \
#     -v $(pwd)/uploads:/app/uploads \
#     -e NEO4J_URI=bolt://neo4j:7687 \
#     -e NEO4J_USER=neo4j \
#     -e NEO4J_PASSWORD=changeme \
#     -e REDIS_HOST=redis \
#     -e REDIS_PORT=6379 \
#     -e OPENAI_API_KEY=sk-... \
#     -e LOCAL_LLM_URL_1=http://192.168.1.61/ai \
#     -e LOCAL_LLM_URL_2=http://192.168.1.62/ai \
#     simorgh-backend:latest
#
# Build time: ~25-35 minutes (first time)
# Image size: ~15-20GB (with all dependencies)
# =============================================================================