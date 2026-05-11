# Pin to specific alpine version for consistent caching
FROM node:20-alpine AS builder
# ---- Air-gapped registry proxies (override at build with --build-arg) ----
ARG PIP_INDEX_URL=https://pypi.org/simple/
ARG PIP_TRUSTED_HOST=
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST} \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    npm_config_registry=${NPM_REGISTRY}

WORKDIR /app
COPY package.json package-lock.json ./
# Use BuildKit cache mount for npm
RUN --mount=type=cache,target=/root/.npm \
    npm ci
COPY . .
RUN npm run build   # This creates /app/dist

# Serve with Nginx (latest alpine — matches the rest of the stack and is
# already in the Nexus proxy cache).
FROM nginx:alpine
# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf
# Copy custom nginx config with SPA try_files support
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Copy to /chatbot/ subdirectory to match vite base path config
COPY --from=builder /app/dist /usr/share/nginx/html/chatbot
EXPOSE 80