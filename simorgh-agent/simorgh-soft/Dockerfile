# =============================================================================
# Simorgh Soft - Multi-stage Docker Build
# Builds React frontend + Node.js backend, served via nginx + node
# =============================================================================

# Stage 1: Build the React frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app
COPY simorgh-frontend/package*.json ./
RUN npm ci
COPY simorgh-frontend/ ./
# Build with empty API URL so fetch calls use relative paths (proxied by nginx)
ENV VITE_API_URL=
RUN npm run build

# Stage 2: Install backend dependencies
FROM node:20-alpine AS backend-build
WORKDIR /app
COPY simorgh-backend/package*.json ./
RUN npm ci --production
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
