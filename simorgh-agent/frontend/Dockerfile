# Pin to specific alpine version for consistent caching
FROM node:20-alpine3.19 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# Use BuildKit cache mount for npm
RUN --mount=type=cache,target=/root/.npm \
    npm ci
COPY . .
RUN npm run build   # This creates /app/dist

# Serve with Nginx (pinned version)
FROM nginx:alpine3.18
# Copy to /chatbot/ subdirectory to match vite base path config
COPY --from=builder /app/dist /usr/share/nginx/html/chatbot
# Also copy index.html to root for redirect
RUN echo '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/chatbot/"></head></html>' > /usr/share/nginx/html/index.html
EXPOSE 80