FROM python:3.11-slim
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
      printf 'deb %s trixie main\ndeb %s trixie-updates main\n' \
        "$APT_MIRROR" "$APT_MIRROR" > /etc/apt/sources.list; \
      if [ -n "$APT_SECURITY_MIRROR" ]; then \
        printf 'deb %s trixie-security main\n' "$APT_SECURITY_MIRROR" \
          >> /etc/apt/sources.list; \
      fi; \
      rm -f /etc/apt/sources.list.d/debian.sources; \
      echo 'Acquire::http::Pipeline-Depth "0";' > /etc/apt/apt.conf.d/99nexus; \
    fi

RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir --timeout 180 --retries 10 -r requirements.txt
COPY app.py .

EXPOSE 8026
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8026"]
