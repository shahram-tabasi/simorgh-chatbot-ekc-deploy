# =============================================================================
# Simorgh Soft - Multi-stage Docker Build
# Builds React frontend + Node.js backend, served via nginx + node
# =============================================================================

# Stage 1: Build the React frontend
FROM node:20-alpine AS frontend-build
# Internal npm mirror (see NPM_REGISTRY in the top-level .env.example) —
# override at build with --build-arg, or via soft-app.yml's build.args,
# which passes it through automatically. No pip/apt anywhere in this
# image, it's a pure Node app, so there's nothing else to mirror here.
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV npm_config_registry=${NPM_REGISTRY}

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
RUN npm run build

# Stage 2: Install backend dependencies
FROM node:20-alpine AS backend-build
# This stage never had the registry ARG at all — it always hit the public
# registry regardless of what stage 1 (or --build-arg) was told, silently.
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV npm_config_registry=${NPM_REGISTRY}
WORKDIR /app
COPY simorgh-backend/package*.json ./
RUN npm ci --omit=dev
COPY simorgh-backend/ ./

# Stage 3: Final runtime image with nginx + node
FROM node:20-alpine

RUN apk add --no-cache nginx

WORKDIR /app

# Copy backend
COPY --from=backend-build /app ./

# Copy frontend build to nginx html directory
COPY --from=frontend-build /app/dist /usr/share/nginx/html

# Copy nginx configuration
COPY docker/nginx.conf /etc/nginx/http.d/default.conf

# Copy startup script
COPY docker/start.sh /start.sh
RUN chmod +x /start.sh

# Create nginx cache/log directories
RUN mkdir -p /var/cache/nginx /var/log/nginx /run/nginx

EXPOSE 80

CMD ["/start.sh"]
