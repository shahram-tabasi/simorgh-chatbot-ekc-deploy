# --------------------------------------------------------------
#  Base: PyTorch 2.9.1 + CUDA 12.8 + cuDNN 9 (DEVEL - includes build tools)
# --------------------------------------------------------------
    FROM pytorch/pytorch:2.9.1-cuda12.8-cudnn9-devel

    # --------------------------------------------------------------
    #  Environment
    # --------------------------------------------------------------
    ENV DEBIAN_FRONTEND=noninteractive \
        PYTHONUNBUFFERED=1 \
        PIP_NO_CACHE_DIR=1 \
        PIP_INDEX_URL=https://pypi.org/simple \
        PIP_EXTRA_INDEX_URL=https://download.pytorch.org/whl/cu128
    
    WORKDIR /app
    
    # --------------------------------------------------------------
    #  System dependencies
    # --------------------------------------------------------------
    RUN apt-get update -y && \
        apt-get install -y --no-install-recommends \
        ca-certificates curl git build-essential wget && \
        rm -rf /var/lib/apt/lists/*
    
    # --------------------------------------------------------------
    #  Upgrade pip + LOCK TORCH to base image version
    # --------------------------------------------------------------
    RUN pip install --upgrade pip setuptools wheel && \
        pip install --no-cache-dir \
        "torch==2.9.1+cu128" \
        "torchvision==0.24.1+cu128" \
        "torchaudio==2.9.1+cu128" \
        --extra-index-url https://download.pytorch.org/whl/cu128
    
    # --------------------------------------------------------------
    #  Core ML stack (cached)
    # --------------------------------------------------------------
    RUN --mount=type=cache,target=/root/.cache/pip \
        pip install --no-cache-dir \
        transformers==4.56.2 \
        accelerate==1.10.1 \
        peft==0.17.1 \
        safetensors==0.6.2 \
        tokenizers==0.22.1
    
    # --------------------------------------------------------------
    #  Install bitsandbytes - Use pre-built wheel, don't reinstall deps
    # --------------------------------------------------------------
    RUN --mount=type=cache,target=/root/.cache/pip \
        pip install --no-cache-dir --no-deps bitsandbytes
    
    # --------------------------------------------------------------
    #  Install xformers
    # --------------------------------------------------------------
    RUN --mount=type=cache,target=/root/.cache/pip \
        pip install --no-cache-dir \
        xformers==0.0.33
    
    # --------------------------------------------------------------
    #  vLLM dependencies (everything except torch/CUDA packages)
    #  Base image has torch 2.9.1 but vLLM wants 2.9.0 - skip torch
    # --------------------------------------------------------------
    RUN --mount=type=cache,target=/root/.cache/pip \
        pip install --no-cache-dir \
        aiohttp \
        anthropic \
        blake3 \
        cachetools \
        cbor2 \
        cloudpickle \
        compressed-tensors \
        depyf \
        diskcache \
        einops \
        "fastapi[standard]>=0.115.0" \
        filelock \
        gguf>=0.17.0 \
        llguidance>=1.3.0 \
        lm-format-enforcer \
        "mistral_common[image]>=1.8.5" \
        msgspec \
        numba \
        nvidia-ml-py \
        openai>=1.99.1 \
        openai-harmony \
        opencv-python-headless>=4.11.0 \
        outlines_core \
        partial-json-parser \
        pillow \
        prometheus-fastapi-instrumentator>=7.0.0 \
        prometheus_client>=0.18.0 \
        protobuf \
        psutil \
        py-cpuinfo \
        pybase64 \
        pydantic>=2.12.0 \
        python-json-logger \
        pyzmq>=25.0.0 \
        ray>=2.48.0 \
        scipy \
        sentencepiece \
        setproctitle \
        tiktoken>=0.6.0 \
        watchfiles \
        xgrammar

    # --------------------------------------------------------------
    #  vLLM - Install with --no-deps (torch already in base image)
    # --------------------------------------------------------------
    RUN --mount=type=cache,target=/root/.cache/pip \
        pip install --no-cache-dir --no-deps \
        vllm==0.12.0 && \
        python -c "import vllm; print('✅ vLLM successfully installed:', vllm.__version__)"
    
    # --------------------------------------------------------------
    #  Unsloth (Install latest from GitHub for newest model support)
    # --------------------------------------------------------------
    RUN --mount=type=cache,target=/root/.cache/pip \
        pip install --no-cache-dir \
        "unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git" \
        "git+https://github.com/unslothai/unsloth-zoo.git"
    
    # --------------------------------------------------------------
    #  FastAPI stack
    # --------------------------------------------------------------
    RUN --mount=type=cache,target=/root/.cache/pip \
        pip install --no-cache-dir \
        fastapi==0.116.1 \
        "uvicorn[standard]==0.35.0" \
        pydantic==2.11.9 \
        pydantic-settings==2.11.0 \
        pydantic_core==2.33.2
    
    # --------------------------------------------------------------
    #  Additional ML deps
    # --------------------------------------------------------------
    RUN --mount=type=cache,target=/root/.cache/pip \
        pip install --no-cache-dir \
        datasets==3.6.0 \
        sentencepiece==0.2.1 \
        sentence-transformers==5.1.0 \
        tiktoken==0.11.0
    
    # --------------------------------------------------------------
    #  Remaining requirements (only extras, vLLM now installed above)
    # --------------------------------------------------------------
    COPY requirements.txt .
    RUN --mount=type=cache,target=/root/.cache/pip \
        pip install --no-cache-dir -r requirements.txt
    
    # --------------------------------------------------------------
    #  Application code
    # --------------------------------------------------------------
    COPY app.py .
    COPY ai_server.py .
    COPY saved_lora_adapters ./saved_lora_adapters
    COPY services ./services
    COPY api ./api
    COPY tools ./tools
    COPY utils ./utils
    
    # --------------------------------------------------------------
    #  Create model cache directory
    # --------------------------------------------------------------
    RUN mkdir -p /models
    
    # --------------------------------------------------------------
    #  Expose + Healthcheck
    # --------------------------------------------------------------
    EXPOSE 9000
    
    HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
        CMD wget -qO- http://localhost:9000/health || exit 1
    
    # --------------------------------------------------------------
    #  Environment variables (can be overridden at runtime)
    # --------------------------------------------------------------
    ENV ENABLE_SEARCH_TOOL=true \
        ENABLE_PYTHON_REPL=false \
        AGENT_VERBOSE=false \
        MODEL_PATH=/models/unsloth-gpt-oss-20b-16bit
    
    # --------------------------------------------------------------
    #  Run server - Use new app.py with OpenAI-compatible endpoints
    # --------------------------------------------------------------
    CMD ["python", "-m", "uvicorn", "app:app", \
        "--host", "0.0.0.0", "--port", "9000", \
        "--workers", "1", "--timeout-keep-alive", "120"]