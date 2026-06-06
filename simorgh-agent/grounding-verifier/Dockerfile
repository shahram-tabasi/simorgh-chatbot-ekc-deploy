# Grounding Verifier — HHEM-2.1-Open NLI sidecar (CPU on .68).
# Commit D of the document-grounded answer pipeline. Runs the Vectara
# Hughes Hallucination Evaluation Model (HHEM-2.1-Open, 184M DeBERTa-v3
# derivative, Apache-2.0) and exposes /verify so the agent can ask
# "does this answer-sentence follow from this source-passage?"
#
# Base image: pytorch/pytorch:2.6.0 — the SAME base project-agent and
# documents-rag use. It already ships torch via conda, so we do NOT
# pip-install torch (which would re-fetch the 906 MB CUDA wheel on the
# operator's slow/unstable link). The base layer is already cached on
# .68 from the other two services, so the FROM here is a zero-download
# layer reuse. Torch runs on CPU here (no GPU on .68's container) —
# the CUDA base works fine CPU-only; it just never finds a device.
#
# Reference: https://huggingface.co/vectara/hallucination_evaluation_model
FROM pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime

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
