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

# Stage 1: Build the React frontend
FROM registry.simorghai.com/docker-proxy/library/node:20-alpine AS frontend-build
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
# The install, and proof that it happened.
#
# `npm ci` here exited 0 having created 331 package directories and written
# nothing into any of them — node_modules/vite an empty folder, no .bin, and no
# node_modules/.package-lock.json, which npm writes only when an install
# finishes. An install that leaves a tree of empty directories is not an
# install, and every "vite: not found" further down was that one fact wearing a
# different error message.
#
# So the check belongs here, in the same layer, where the fault is: the tree is
# proved usable before anything is allowed to depend on it. `df` goes in the
# output because a build host that ran out of room mid-install is what this
# looks like, and that is worth knowing at the moment it happens rather than
# two steps later.
RUN set -eu; \
    npm ci; \
    if ! node -e "require.resolve('vite/package.json')" 2>/dev/null; then \
      echo "### npm ci exited 0 but left an unusable tree"; \
      echo "### node_modules/vite:"; ls -la node_modules/vite 2>&1 | head -5; \
      echo "### .package-lock.json:"; \
      test -f node_modules/.package-lock.json && echo present || echo "ABSENT — the install never finished"; \
      echo "### space on this filesystem:"; df -h /app | tail -2; \
      echo "### inodes:"; df -i /app | tail -2; \
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
FROM registry.simorghai.com/docker-proxy/library/node:20-alpine AS backend-build
# This stage never had the registry ARG at all — it always hit the public
# registry regardless of what stage 1 (or --build-arg) was told, silently.
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV npm_config_registry=${NPM_REGISTRY}
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000
WORKDIR /app
COPY simorgh-backend/package*.json ./
# Proved the same way as the frontend's, and for the same reason: this is the
# tree the server runs off, and an empty one would only be discovered when the
# container failed to start.
RUN set -eu; \
    npm ci --omit=dev; \
    if ! node -e "require.resolve('express/package.json')" 2>/dev/null; then \
      echo "### npm ci exited 0 but left an unusable tree"; \
      test -f node_modules/.package-lock.json && echo "lock present" || echo "lock ABSENT — the install never finished"; \
      df -h /app | tail -2; \
      exit 1; \
    fi
COPY simorgh-backend/ ./

# Stage 3: Final runtime image — nginx:alpine as the base (nginx already
# installed, from the same Alpine nginx package `apk add nginx` used to
# fetch here), node lifted in as a binary from stage 1's own base image
# rather than reinstalled. Node's musl-alpine build is self-contained
# enough for this — both images track the same Alpine generation, so the
# shared C library ABI lines up.
FROM registry.simorghai.com/docker-proxy/library/nginx:alpine

WORKDIR /app

COPY --from=frontend-build /usr/local/bin/node /usr/local/bin/node

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
