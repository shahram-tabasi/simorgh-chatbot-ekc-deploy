# Grounding Verifier — HHEM-2.1-Open NLI sidecar (CPU on .68).
# Commit D of the document-grounded answer pipeline. Runs the Vectara
# Hughes Hallucination Evaluation Model (HHEM-2.1-Open, 184M DeBERTa-v3
# derivative, Apache-2.0) and exposes /verify so the agent can ask
# "does this answer-sentence follow from this source-passage?"
# CPU-only by design — keeps .61's A30 free of model-juggling. ~2 s per
# 4 k-token request on a modest x86 box, comfortably under the
# operator's verification-latency budget.
#
# Reference: https://www.vectara.com/blog/hhem-2-1-a-better-hallucination-detection-model
FROM python:3.11-slim

ARG PIP_INDEX_URL=https://pypi.org/simple/
ARG PIP_TRUSTED_HOST=
ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST} \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/root/.cache/huggingface \
    TRANSFORMERS_CACHE=/root/.cache/huggingface

RUN printf '%s\n' 'Acquire::Retries "20";' 'Acquire::http::Timeout "300";' > /etc/apt/apt.conf.d/99retries
RUN apt-get update && apt-get install -y --no-install-recommends \
        wget curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --timeout 180 --retries 10 --no-cache-dir -r requirements.txt
COPY app.py .

EXPOSE 8055
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8055/health || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8055"]
