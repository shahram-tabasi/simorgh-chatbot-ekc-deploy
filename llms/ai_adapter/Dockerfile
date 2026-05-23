# Tiny adapter that translates the legacy /generate-stream endpoint
# into vLLM's /v1/chat/completions. ~50 MB image, no GPU.
FROM python:3.12-slim

ARG PIP_INDEX_URL=https://pypi.org/simple/
ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .

EXPOSE 9100
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "9100", "--workers", "2"]
