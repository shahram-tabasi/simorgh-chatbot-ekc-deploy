# =============================================================================
# eplan-files-service — hands back the drawings EPLAN wrote to the techserver.
#
# Base image through the Harbor proxy-cache, like simorgh-soft, because this
# server's direct path to Docker Hub is unreliable.
#
# Nothing here installs an OS package, and that is the point. smbclient is an
# apt package, and apt cannot reach Debian's mirrors from this network — the
# APT_MIRROR build args other services carry are wired to nothing, so they
# fall through to the real mirrors and hang. Harbor cannot cover for that: it
# proxies container images, not package repositories. So the SMB client is a
# pip dependency instead, through the Nexus PyPI proxy that already works for
# every other service here.
# =============================================================================
FROM registry.simorghai.com/docker-proxy/library/python:3.12-slim

# Air-gapped registry proxies — passed from compose (see svc-eplan-files.yml).
ARG PIP_INDEX_URL=https://pypi.org/simple/
ARG PIP_TRUSTED_HOST=
ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST} \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt .
# Same retry tuning as the other services: the mirror is the flaky part, not
# the packages, so try harder before failing the build.
RUN pip install --no-cache-dir --timeout 180 --retries 10 -r requirements.txt

COPY app.py .

ENV PYTHONUNBUFFERED=1
EXPOSE 8056
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8056"]
