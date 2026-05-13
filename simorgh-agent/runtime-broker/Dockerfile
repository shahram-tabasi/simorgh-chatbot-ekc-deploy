# Built with context = ../ (the simorgh-agent root) for sibling `shared/`.
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

RUN printf '%s\n' 'Acquire::Retries "20";' 'Acquire::http::Timeout "300";' 'Acquire::https::Timeout "300";' 'Acquire::http::No-Cache "true";' > /etc/apt/apt.conf.d/99retries


ARG APT_MIRROR=
ARG APT_SECURITY_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then \
      printf 'deb %s trixie main
deb %s trixie-updates main
' \
        "$APT_MIRROR" "$APT_MIRROR" > /etc/apt/sources.list; \
      if [ -n "$APT_SECURITY_MIRROR" ]; then \
        printf 'deb %s trixie-security main
' "$APT_SECURITY_MIRROR" \
          >> /etc/apt/sources.list; \
      fi; \
      rm -f /etc/apt/sources.list.d/debian.sources; \
      echo 'Acquire::http::Pipeline-Depth "0";' > /etc/apt/apt.conf.d/99nexus; \
    fi

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates wget docker.io \
    && rm -rf /var/lib/apt/lists/*

COPY runtime-broker/requirements.txt .
RUN pip install --no-cache-dir --timeout 180 --retries 10 -r requirements.txt

COPY shared/ /opt/shared/
RUN pip install --no-cache-dir --timeout 180 --retries 10 -e /opt/shared/

COPY runtime-broker/app.py .

EXPOSE 8048
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8048"]
