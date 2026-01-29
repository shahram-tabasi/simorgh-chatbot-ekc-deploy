FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build   # This creates /app/dist

# Serve with Nginx
FROM nginx:alpine
# Copy to /chatbot/ subdirectory to match vite base path config
COPY --from=builder /app/dist /usr/share/nginx/html/chatbot
# Also copy index.html to root for redirect
RUN echo '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/chatbot/"></head></html>' > /usr/share/nginx/html/index.html
EXPOSE 80