FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN printf '%s\n' 'Acquire::Retries "20";' 'Acquire::http::Timeout "300";' 'Acquire::https::Timeout "300";' 'Acquire::http::No-Cache "true";' > /etc/apt/apt.conf.d/99retries

RUN apt-get update && apt-get install -y --no-install-recommends \
        wget curl ca-certificates build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --timeout 180 --retries 10 --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8038

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=30s \
    CMD wget -qO- http://127.0.0.1:8038/health || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8038"]
