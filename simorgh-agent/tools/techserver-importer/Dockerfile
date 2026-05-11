FROM python:3.12-slim
# ---- Air-gapped registry proxies (override at build with --build-arg) ----
ARG PIP_INDEX_URL=https://pypi.org/simple/
ARG PIP_TRUSTED_HOST=
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST} \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    npm_config_registry=${NPM_REGISTRY}

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates git smbclient \
    && rm -rf /var/lib/apt/lists/*

COPY tools/techserver-importer/requirements.txt .
RUN pip install --no-cache-dir --timeout 180 --retries 10 -r requirements.txt

COPY tools/techserver-importer/import_techserver.py .

ENTRYPOINT ["python", "/app/import_techserver.py"]
