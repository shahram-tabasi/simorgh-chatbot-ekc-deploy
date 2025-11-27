# --------------------------------------------------------------
#  Initializer Service - Downloads models and prepares environment
# --------------------------------------------------------------
FROM python:3.11-slim

# --------------------------------------------------------------
#  Environment
# --------------------------------------------------------------
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# --------------------------------------------------------------
#  System dependencies
# --------------------------------------------------------------
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    git && \
    rm -rf /var/lib/apt/lists/*

# --------------------------------------------------------------
#  Install Python packages for model downloading
# --------------------------------------------------------------
RUN pip install --no-cache-dir \
    huggingface-hub \
    requests \
    tqdm

# --------------------------------------------------------------
#  Copy initializer script
# --------------------------------------------------------------
COPY init-models.py .
COPY init-config.yaml .

# --------------------------------------------------------------
#  Run initializer
# --------------------------------------------------------------
CMD ["python", "init-models.py"]