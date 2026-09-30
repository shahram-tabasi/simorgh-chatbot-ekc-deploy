# ---- Where the base image comes from ----------------------------------------
#
# Same argument as everywhere else in this repo: the default is the Harbor
# proxy-cache, because the EPLAN machine's own path to Docker Hub is as
# restricted as the Linux server's, and Harbor is on the LAN. A GitHub runner
# has no credentials for Harbor and reaches Docker Hub perfectly well, so the
# workflow passes BASE_REGISTRY=library. Nothing about the image differs —
# Harbor is a cache of exactly this.
#
#   docker build --build-arg BASE_REGISTRY=library .   # straight from Docker Hub
ARG BASE_REGISTRY=registry.simorghai.com/docker-proxy/library
FROM ${BASE_REGISTRY}/python:3.11-slim
WORKDIR /app
# Nothing is installed: the relay is stdlib asyncio and one file. That is what
# makes this image buildable on a machine with no package-manager access at
# all, which the EPLAN box very nearly is.
COPY forwarder.py .
CMD ["python", "forwarder.py"]
