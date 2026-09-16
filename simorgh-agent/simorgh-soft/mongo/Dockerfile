# simorgh-soft's MongoDB, with its backup script inside it.
#
# It is mongo:7 and one file. The reason it exists rather than the compose
# file naming mongo:7 directly is the server this runs on: its link to the
# outside is slow and unreliable, and everything else it runs is pulled from
# one registry. An image that has to come from Docker Hub instead is the one
# that fails on the day the link is bad — and it is the database.
#
# The script rides along rather than living in the compose file's `command:`,
# where it was thirty lines of bash with every `$` doubled to survive
# interpolation. See mongo/backup.sh.
#
# Both services use this image: the database runs it as it comes — the
# entrypoint and command are mongo:7's own, untouched — and the backup
# sidecar overrides the command with the script.
ARG BASE_REGISTRY=registry.simorghai.com/docker-proxy/library
FROM ${BASE_REGISTRY}/mongo:7

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

ARG GIT_SHA=unknown
ARG GIT_REF=unknown
ARG BUILD_TIME=unknown
LABEL org.opencontainers.image.title="simorgh-soft-mongo" \
      org.opencontainers.image.description="MongoDB for simorgh-soft, with the nightly dump script" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.version="${GIT_REF}" \
      org.opencontainers.image.created="${BUILD_TIME}"
