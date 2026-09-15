# =============================================================================
# Simorgh Soft - Multi-stage Docker Build
# Builds React frontend + Node.js backend, served via nginx + node
#
# Base images pull through the Harbor proxy-cache (registry.simorghai.com/
# docker-proxy/library/...) rather than docker.io directly — this server's
# direct path to Docker Hub, Alpine's own package CDN, and the public npm
# registry has all proven unreliable (an `apk add nginx` here once took 20
# minutes against Alpine's CDN, which Harbor can't proxy — a plain APK
# repository isn't a container registry). Since nginx:alpine already IS
# Alpine's nginx package pre-installed, pulling that image through Harbor
# sidesteps needing `apk add` here at all, not just makes it faster.
#
# `docker login registry.simorghai.com` (using HARBOR_USER / HARBOR_PASSWORD)
# must happen before `docker compose build` — docker-proxy is a private
# project, and neither BuildKit nor a Dockerfile can authenticate on their
# own; that has to already be in the local Docker credential store.
# =============================================================================

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

# The musl node binary, for the runtime image only.
#
# The final image is nginx:alpine and lifts node in as a binary rather than
# reinstalling it, so that binary has to be the Alpine one. It comes from here
# and nowhere else — this stage runs no npm, which is the entire point.
FROM ${BASE_REGISTRY}/node:20-alpine AS node-bin

# Stage 1: Build the React frontend
#
# On Debian, not Alpine, and not by preference — npm 10.8.2 on this Alpine image
# cannot complete an install on this host. It dies with its own internal error,
# "Exit handler never called!", and then exits 0, leaving 331 package
# directories with nothing inside them. Three attempts, a cleared cache and
# `npm install` instead of `npm ci` all ended the same way.
#
# Nothing is apt-installed here, in this stage or the next. The objection to a
# Debian base was `apt update` failing behind the network restrictions, and
# these stages never run apt: they run npm and nothing else. What they produce
# — a `dist` of static files, and a backend node_modules of pure JavaScript
# with not one native build or install script in it — copies into the Alpine
# runtime unchanged.
FROM ${BASE_REGISTRY}/node:20-slim AS frontend-build
# Internal npm mirror (see NPM_REGISTRY in the top-level .env.example) —
# override at build with --build-arg, or via soft-app.yml's build.args,
# which passes it through automatically. No pip/apt anywhere in this
# image, it's a pure Node app, so there's nothing else to mirror here.
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV npm_config_registry=${NPM_REGISTRY}
# npm ci had no retry tuning at all — a mid-download ECONNRESET on a large
# package (pdfjs-dist, several MB with its fonts/cmaps) just failed the
# build outright. Same fix as pip's --timeout/--retries below: try harder
# before giving up, since the mirror itself is the flaky part, not the
# package.
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000

WORKDIR /app
COPY simorgh-frontend/package*.json ./
# The install, retried until the tree is real.
#
# npm here dies with "Exit handler never called!" — its own internal crash —
# and then **exits 0 anyway**, having created 331 package directories and
# written nothing into any of them. node_modules/vite an empty folder, no .bin,
# no node_modules/.package-lock.json. Every "vite: not found" further down was
# that one fact wearing a different error message, and BuildKit cached it as a
# success because npm said it was one.
#
# So npm's exit code is not evidence here, and the only thing that counts as
# proof is the tree itself resolving. That check runs after every attempt.
#
# What provokes the crash is the file descriptor limit. This daemon gives a
# container 1024, and extracting 462 packages wants far more open at once, so
# the extraction hits EMFILE — and npm's handling of that is the very path this
# bug lives on. It fits every symptom: directories get made, because a mkdir is
# cheap, and files do not, because each one needs a descriptor. It fails the
# same on Alpine and on Debian, because the limit comes from the daemon and not
# from the image. And it fails against both registries, because the registry
# was never the problem.
#
# So the limit is raised first, and printed either way. `--maxsockets 3` and
# NODE_OPTIONS stay: fewer sockets is fewer descriptors, and the heap headroom
# costs nothing. The retries stay too — they are what catches an install that
# lies about succeeding, whatever the reason.
ENV NODE_OPTIONS=--max-old-space-size=4096

RUN set -eu; \
    ulimit -n 65536 2>/dev/null || ulimit -n 16384 2>/dev/null || ulimit -n 4096 2>/dev/null || true; \
    echo "### file descriptors: $(ulimit -n)"; \
    usable() { node -e "require.resolve('vite/package.json')" 2>/dev/null; }; \
    for attempt in 1 2 3; do \
      echo "### install attempt $attempt"; \
      rm -rf node_modules; \
      case $attempt in \
        1|2) npm ci --no-audit --no-fund --maxsockets 3 || echo "### npm reported a failure"; ;; \
        3)   npm cache clean --force || true; \
             npm install --no-audit --no-fund --maxsockets 3 || echo "### npm reported a failure"; ;; \
      esac; \
      if usable; then echo "### attempt $attempt produced a usable tree"; break; fi; \
      echo "### attempt $attempt left an unusable tree"; \
    done; \
    if ! usable; then \
      echo "### every attempt failed"; \
      echo "### node_modules/vite:"; ls -la node_modules/vite 2>&1 | head -5; \
      echo "### .package-lock.json:"; \
      test -f node_modules/.package-lock.json && echo present || echo "ABSENT — the install never finished"; \
      echo "### space:"; df -h /app | tail -2; \
      echo "### memory:"; head -3 /proc/meminfo; \
      exit 1; \
    fi
COPY simorgh-frontend/ ./
# The app is served under /simorgh-design-suite/ behind two layers of nginx.
# - VITE_BASE_PATH controls vite's `base` -- used by index.html asset URLs
#   (and exposed to the SPA via import.meta.env.BASE_URL → React Router basename).
# - VITE_API_URL is the prefix for fetch('${VITE_API_URL}/api/...') calls,
#   so the built bundle issues requests to /simorgh-design-suite/api/* (which the
#   docker nginx then strips and forwards to the simorgh-soft container's
#   internal nginx, which proxies /api/ to the Express backend on :3001).
ENV VITE_BASE_PATH=/simorgh-design-suite/
ENV VITE_API_URL=/simorgh-design-suite
# Vite through its own JavaScript API, found by node's resolver.
#
# Not `npx vite build`, which the npm script runs: npx's contract is "find it
# or fetch it", so a missing vite became a registry fetch and the build died on
# whichever network fault was in season — a refused connection to the internal
# mirror, then a reset from the public one. The network was never the problem,
# only where the problem surfaced.
#
# Not the bin link either, nor the package's bin file by path: this image's npm
# leaves neither reliably. `import('vite')` asks node to resolve the package by
# its own rules and calls the same build() the CLI calls, so it works wherever
# npm actually put it, and it cannot reach the network.
RUN node -e "import('vite').then(m => m.build()).catch(e => { console.error(e); process.exit(1); })"

# Stage 2: Install backend dependencies
FROM ${BASE_REGISTRY}/node:20-slim AS backend-build
# This stage never had the registry ARG at all — it always hit the public
# registry regardless of what stage 1 (or --build-arg) was told, silently.
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV npm_config_registry=${NPM_REGISTRY}
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000
WORKDIR /app
COPY simorgh-backend/package*.json ./
# Retried and proved the same way as the frontend's, and for the same reason:
# npm's exit code is not evidence on this host, and this is the tree the server
# runs off — an empty one would only be discovered when the container failed to
# start.
RUN set -eu; \
    ulimit -n 65536 2>/dev/null || ulimit -n 16384 2>/dev/null || ulimit -n 4096 2>/dev/null || true; \
    echo "### file descriptors: $(ulimit -n)"; \
    usable() { node -e "require.resolve('express/package.json')" 2>/dev/null; }; \
    for attempt in 1 2 3; do \
      echo "### install attempt $attempt"; \
      rm -rf node_modules; \
      case $attempt in \
        1|2) npm ci --omit=dev --no-audit --no-fund --maxsockets 3 || echo "### npm reported a failure"; ;; \
        3)   npm cache clean --force || true; \
             npm install --omit=dev --no-audit --no-fund --maxsockets 3 || echo "### npm reported a failure"; ;; \
      esac; \
      if usable; then echo "### attempt $attempt produced a usable tree"; break; fi; \
      echo "### attempt $attempt left an unusable tree"; \
    done; \
    if ! usable; then \
      echo "### every attempt failed"; \
      test -f node_modules/.package-lock.json && echo "lock present" || echo "lock ABSENT"; \
      df -h /app | tail -2; \
      exit 1; \
    fi
COPY simorgh-backend/ ./

# Stage 3: Final runtime image — nginx:alpine as the base (nginx already
# installed, from the same Alpine nginx package `apk add nginx` used to
# fetch here), node lifted in as a binary from the node-bin stage rather
# than reinstalled. Node's musl-alpine build is self-contained enough for
# this — both images track the same Alpine generation, so the shared C
# library ABI lines up.
#
# The binary comes from node-bin and not from the build stages, which are
# Debian: a glibc node would not run here. What does come from them is only
# JavaScript, which does not care which libc built it.
FROM ${BASE_REGISTRY}/nginx:alpine

WORKDIR /app

COPY --from=node-bin /usr/local/bin/node /usr/local/bin/node

# Copy backend
COPY --from=backend-build /app ./

# Copy frontend build to nginx html directory
COPY --from=frontend-build /app/dist /usr/share/nginx/html

# Copy nginx configuration — conf.d, not http.d: the official nginx:alpine
# image's own nginx.conf includes /etc/nginx/conf.d/*.conf (nginx Inc.'s own
# convention, kept consistent across all their image variants), unlike
# Alpine's native `apk add nginx` package, which used http.d/ instead.
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# Copy startup script
COPY docker/start.sh /start.sh
RUN chmod +x /start.sh

# Create nginx cache/log directories
RUN mkdir -p /var/cache/nginx /var/log/nginx /run/nginx

EXPOSE 80

CMD ["/start.sh"]
