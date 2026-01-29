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
#  Install Python 3.11
# -------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 \
    python3.11-dev \
    python3.11-venv \
    python3-pip \
    curl \
    wget \
    && rm -rf /var/lib/apt/lists/*

# -------------------------------------------------
#  System tools for OCR & PDF processing
# -------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
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
    htop \
    && rm -rf /var/lib/apt/lists/*

# -------------------------------------------------
#  Upgrade pip, setuptools, wheel
# -------------------------------------------------
RUN python3.11 -m pip install --upgrade pip setuptools wheel

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
#  Install Python packages
#  Single clean installation from requirements.txt
# -------------------------------------------------
RUN echo "=== Installing Python dependencies ===" && \
    python3.11 -m pip install --no-cache-dir -r requirements.txt && \
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