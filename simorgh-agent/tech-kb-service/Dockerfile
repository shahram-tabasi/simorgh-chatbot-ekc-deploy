FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# git is required for clone/pull/grep; openssh-client for SSH-based remotes.
RUN apt-get update && apt-get install -y --no-install-recommends \
        wget curl ca-certificates git openssh-client findutils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8046

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=20s \
    CMD wget -qO- http://127.0.0.1:8046/health || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8046"]
