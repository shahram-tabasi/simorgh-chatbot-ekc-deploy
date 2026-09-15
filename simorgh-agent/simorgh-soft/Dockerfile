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
RUN npm ci
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
# The vite that `npm ci` just installed, run directly — not through `npx`.
#
# `npm run build` runs `npx vite build`, and npx's contract is "find it or
# fetch it". That second half has no business in a container build: every
# package this step needs is already in /app/node_modules, so the only thing
# a registry lookup here can do is fail. It did — the internal npm mirror
# refused connections between `npm ci` and this line, npx went looking for
# vite on the network instead of at its feet, and seventeen minutes of build
# died on a package that was already installed.
#
# Called this way the step cannot reach the network at all: vite is either in
# node_modules or the build stops with a clear reason, which is the honest
# pair of outcomes.
RUN ./node_modules/.bin/vite build

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
RUN npm ci --omit=dev
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
