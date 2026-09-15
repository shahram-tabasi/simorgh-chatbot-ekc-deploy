# ---- Where the base images come from ----------------------------------------
#
# The build host's direct path to Docker Hub has proven unreliable, so it pulls
# these through the Harbor proxy-cache instead — which is why that is the
# default. `docker login registry.simorghai.com` (HARBOR_USER /
# HARBOR_PASSWORD) has to have happened first; docker-proxy is a private
# project.
#
# A GitHub runner is the other way round: it reaches Docker Hub perfectly well
# and has no credentials for Harbor, where it gets a 401 and the build stops on
# the first FROM. So the registry is an argument rather than a fact, and the
# workflow passes BASE_REGISTRY=library to take the images straight from Docker
# Hub. Nothing about the resulting image differs — Harbor is a cache of exactly
# these.
ARG BASE_REGISTRY=registry.simorghai.com/docker-proxy/library
FROM ${BASE_REGISTRY}/python:3.11-slim
# ---- Air-gapped registry proxies (override at build with --build-arg) ----
ARG PIP_INDEX_URL=https://pypi.org/simple/
ARG PIP_TRUSTED_HOST=
ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST} \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
# No apt-get here on purpose: this image needs nothing from the Debian
# archive. It used to install wget + ca-certificates just for the compose
# healthcheck — swapped for the stdlib urllib call below, which needs
# neither, so a slow or unreachable Debian mirror can no longer turn a
# rebuild into a multi-hour wait. pip's own vendored CA bundle already
# covers requirements.txt, HTTPS or not.
COPY requirements.txt .
RUN pip install --no-cache-dir --timeout 180 --retries 10 -r requirements.txt
COPY app.py .

EXPOSE 8026
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8026"]
