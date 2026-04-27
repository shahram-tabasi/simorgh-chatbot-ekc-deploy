# =======================================================================
# Shared Location Blocks for Simorgh AI
# Included by all server blocks
# =======================================================================

# ====================================================================
# SIMORGH-SOFT - Electrical Design Software
# Strips /simorgh-draft/ prefix and proxies to simorgh-soft container
# ====================================================================
location /simorgh-draft/ {
    rewrite ^/simorgh-draft/(.*) /$1 break;

    proxy_pass http://simorgh_soft;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Prefix /simorgh-draft;

    proxy_http_version 1.1;
    proxy_set_header Connection "";

    proxy_connect_timeout 30s;
    proxy_send_timeout 120s;
    proxy_read_timeout 120s;
}

# ====================================================================
# STATIC FILES - Old Interface
# ====================================================================
location /old/ {
    alias /usr/share/nginx/html/old/;
    index index.html;
    try_files $uri $uri/ /old/index.html;
    expires 7d;
    add_header Cache-Control "public, immutable";
}

# ====================================================================
# REACT FRONTEND - Main Application
# ====================================================================
location / {
    proxy_pass http://frontend;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Pass login mode to frontend (modern or legacy)
    proxy_set_header X-Login-Mode $login_mode;
    add_header X-Login-Mode $login_mode;

    proxy_cache_valid 200 7d;
    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;
}

# ====================================================================
# LOCAL LLM API - Load Balanced
# ====================================================================
location /api/llm/ {
    limit_req zone=api_limit burst=30 nodelay;

    proxy_pass http://llm_servers/;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_http_version 1.1;
    proxy_set_header Connection '';

    proxy_buffering off;
    proxy_cache off;
    proxy_request_buffering off;
    chunked_transfer_encoding on;

    add_header X-Accel-Buffering "no" always;
    add_header Cache-Control "no-cache" always;

    proxy_connect_timeout 300s;
    proxy_send_timeout 1800s;
    proxy_read_timeout 1800s;

    client_max_body_size 100M;
    client_body_timeout 300s;

    proxy_next_upstream error timeout invalid_header http_500 http_502 http_503;
    proxy_next_upstream_tries 2;
}

# ====================================================================
# AUTHENTICATION API
# ====================================================================
location /api/auth/ {
    limit_req zone=api_limit burst=30 nodelay;

    rewrite ^/api/auth/(.*) /auth/$1 break;
    proxy_pass http://backend;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_http_version 1.1;
    proxy_set_header Connection "";

    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;
}

# ====================================================================
# Phase 10 — extracted microservice routing
# Specific /api/* paths route to their standalone services first.
# Anything not matched falls through to the legacy /api/ catch-all
# (backend monolith) below. To disable a route, comment its location
# block here AND comment the matching include: in docker-compose.yml.
# ====================================================================

# Auth (auth-service:8032)
location /api/v2/auth/ {
    limit_req zone=api_limit burst=30 nodelay;
    proxy_pass http://auth_service;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Login-Mode $login_mode;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_connect_timeout 30s;
    proxy_read_timeout 60s;
}

# Documents RAG (documents-rag-service:8033)
location /api/v2/documents/ {
    limit_req zone=upload_limit burst=10 nodelay;
    proxy_pass http://documents_rag_service;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_request_buffering off;
    client_max_body_size 200M;
    proxy_connect_timeout 60s;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
}

# Chat (chat-service:8034)
location /api/v2/chat/ {
    limit_req zone=api_limit burst=30 nodelay;
    proxy_pass http://chat_service;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    add_header X-Accel-Buffering "no" always;
    proxy_connect_timeout 60s;
    proxy_read_timeout 600s;
}

# Project sessions (chat-service:8034)
location ~ ^/api/v2/projects/[^/]+/sessions {
    limit_req zone=api_limit burst=30 nodelay;
    proxy_pass http://chat_service;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_read_timeout 300s;
}

# Project agent (project-agent-service:8035, REST)
location /api/v2/agent/ {
    limit_req zone=api_limit burst=30 nodelay;
    proxy_pass http://project_agent_service;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    client_max_body_size 50M;
    proxy_connect_timeout 60s;
    proxy_read_timeout 600s;
}

# Specification agent (specification-agent-service:8036, REST)
location /api/v2/specs/ {
    limit_req zone=api_limit burst=30 nodelay;
    proxy_pass http://specification_agent_svc;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_read_timeout 300s;
}

# Graph RAG (graph-rag-service:8037)
location /api/v2/graph-rag/ {
    limit_req zone=api_limit burst=30 nodelay;
    proxy_pass http://graph_rag_service;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_read_timeout 120s;
}

# Payments (payments-service:8038)
location /api/payments/ {
    limit_req zone=api_limit burst=30 nodelay;
    proxy_pass http://payments_service;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_read_timeout 60s;
}

# Admin (admin-service:8039)
location /api/admin/ {
    limit_req zone=api_limit burst=30 nodelay;
    proxy_pass http://admin_service;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_read_timeout 60s;
}

# Tier / quota (tier-quota-service:8040)
location /api/quota/ {
    limit_req zone=api_limit burst=30 nodelay;
    proxy_pass http://tier_quota_service;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_read_timeout 60s;
}

# Internal: LLM gateway (llm-gateway:8030) — exposed for backend & services
# Not normally hit by the frontend, but available behind the proxy.
location /api/llm-gateway/ {
    rewrite ^/api/llm-gateway/(.*) /$1 break;
    proxy_pass http://llm_gateway;
    proxy_set_header Host $host;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 1800s;
}

# Internal: embeddings (embeddings-service:8031)
location /api/embeddings/ {
    rewrite ^/api/embeddings/(.*) /$1 break;
    proxy_pass http://embeddings_service;
    proxy_set_header Host $host;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_read_timeout 60s;
}

# ====================================================================
# BACKEND API — catch-all for paths not yet migrated to extracted
# services. Slim this further in future phases by deleting routes from
# the backend monolith and pointing them here at standalone services.
# ====================================================================
location /api/ {
    limit_req zone=api_limit burst=30 nodelay;

    proxy_pass http://backend;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_http_version 1.1;
    proxy_set_header Connection "";

    proxy_buffering off;
    proxy_cache off;

    add_header X-Accel-Buffering "no" always;

    proxy_connect_timeout 300s;
    proxy_send_timeout 600s;
    proxy_read_timeout 600s;

    client_max_body_size 100M;
}

# ====================================================================
# STT (Speech-to-Text) API
# ====================================================================
location /api/stt/ {
    limit_req zone=upload_limit burst=10 nodelay;

    rewrite ^/api/stt/(.*) /$1 break;
    proxy_pass http://stt_service;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_http_version 1.1;
    proxy_set_header Connection "";

    client_max_body_size 50M;
    client_body_timeout 120s;

    proxy_connect_timeout 30s;
    proxy_send_timeout 120s;
    proxy_read_timeout 120s;
}

# STT WebSocket endpoint
location /api/stt/ws/ {
    rewrite ^/api/stt/ws/(.*) /ws/$1 break;
    proxy_pass http://stt_service;

    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;

    proxy_connect_timeout 60s;
    proxy_send_timeout 300s;
    proxy_read_timeout 300s;
}

# ====================================================================
# TTS (Text-to-Speech) API
# ====================================================================
location /api/tts/ {
    limit_req zone=api_limit burst=10 nodelay;

    rewrite ^/api/tts/(.*) /$1 break;
    proxy_pass http://tts_service;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_http_version 1.1;
    proxy_set_header Connection "";

    proxy_connect_timeout 30s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;
}

# ====================================================================
# HEALTH CHECK ENDPOINTS
# ====================================================================
location /health {
    access_log off;
    return 200 "healthy\n";
    add_header Content-Type text/plain;
}

location /api/health {
    access_log off;
    proxy_pass http://backend/health;
    proxy_http_version 1.1;
    proxy_set_header Host $host;

    proxy_connect_timeout 5s;
    proxy_send_timeout 5s;
    proxy_read_timeout 5s;
}

# ====================================================================
# LOGIN MODE API - Returns current login mode for frontend
# ====================================================================
location /api/login-mode {
    access_log off;
    default_type application/json;
    return 200 '{"mode": "$login_mode"}';
}
