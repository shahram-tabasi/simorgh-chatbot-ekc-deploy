# =======================================================================
# Shared Location Blocks for Simorgh AI
# Included by all server blocks
# =======================================================================

# ====================================================================
# SIMORGH-SOFT - Electrical Design Software
# Strips /simorgh-design-suite/ prefix and proxies to simorgh-soft container
# ====================================================================
location /simorgh-design-suite/ {
    rewrite ^/simorgh-design-suite/(.*) /$1 break;

    proxy_pass http://simorgh_soft;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Prefix /simorgh-design-suite;

    proxy_http_version 1.1;
    proxy_set_header Connection "";

    # Saving a project imported from TPMS sends the whole project — and one
    # snapshot per revision. On a plant with a dozen panels that is megabytes,
    # and nginx's 1 MB default answered every one of them with 413.
    client_max_body_size 100M;

    proxy_connect_timeout 30s;
    # Reading a TPMS project (its switchgears and their panel specifications)
    # is a long single request on a big project; 120s was cutting those off
    # as a 504 and the project simply never opened.
    proxy_send_timeout 600s;
    proxy_read_timeout 600s;
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
# VLM (Vision-Language Model) — direct proxy to 192.168.1.62.
# Use this for image-bearing OpenAI-compatible POSTs:
#   POST /api/vlm/v1/chat/completions
#   { "model": "qwen2.5-vl-7b", "messages": [{role,content:[{type:text},
#                                              {type:image_url,...}]}] }
# For mixed text/vision traffic that should auto-route, prefer the
# llm-gateway (/api/llm-gateway/v1/chat/completions) instead.
# ====================================================================
location /api/vlm/ {
    limit_req zone=api_limit burst=10 nodelay;
    rewrite ^/api/vlm/(.*)$ /$1 break;
    proxy_pass http://vlm_servers;

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

    # Images can make payloads large; vision generation can be slow.
    client_max_body_size 50M;
    proxy_connect_timeout 300s;
    proxy_send_timeout 1800s;
    proxy_read_timeout 1800s;
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
# Phase C — extracted microservice routing (paths corrected after audit)
#
# These specific /api/* paths route to their standalone services first.
# nginx longest-prefix-match wins, so if a path matches one of these
# blocks it goes to the matching service. Anything else falls through
# to the legacy /api/ catch-all (backend monolith) below.
#
# To disable a service:
#   1) comment the matching location block here
#   2) comment the matching include: in docker-compose.yml
#   3) docker compose up -d --remove-orphans && docker exec nginx nginx -s reload
# ====================================================================

# Auth (auth-service:8032)
# Router prefix is /auth/v2; main.py adds /api → external /api/auth/v2/*
location /api/auth/v2/ {
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
# Router prefix /api with internal routes /documents/*, /sessions/*, etc.
# Routing /api/documents/ here keeps document upload + retrieval clean;
# the other grab-bag paths inside that router (/api/chat/general,
# /api/sessions/...) stay on backend's catch-all for now — the router
# is misnamed and needs splitting (see documents-rag-service/README).
location /api/documents/ {
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

# Chat — modern chat surface (chat-service:8034)
# Router has its own /api/v2/chat prefix.
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

# General-chat HR/Strategy direct-RAG endpoint (chat-service:8034).
# Streams from gpt-oss-20b on .61 via llm-gateway. Modern-user only.
# Buffering off + 600s read timeout so SSE tokens reach the browser
# immediately and a slow first-token doesn't trip the proxy timeout.
location /api/v2/general-chat/ {
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

# Project chat sessions (chat-service:8034) — new deep-link surface added
# in migration 004. Routes: POST/GET/DELETE /api/v2/chatbot/project/...
location /api/v2/chatbot/ {
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
    proxy_read_timeout 120s;
}

# Project workspace (chat-service:8034)
# Router has prefix /api/v2/project (singular). Phase 10 used the
# regex /api/v2/projects/.+/sessions which was wrong on both fronts.
location /api/v2/project/ {
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

# GitLab MCP gateway (gitlab-mcp:8047) — exposes the user-repo / branch
# pickers and access-instructions endpoints used by the project wizard.
# The path is rewritten so /api/gitlab/branches → /branches upstream.
location /api/gitlab/ {
    limit_req zone=api_limit burst=10 nodelay;
    rewrite ^/api/gitlab/(.*)$ /$1 break;
    proxy_pass http://gitlab_mcp_service;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_read_timeout 60s;
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
# Router prefix /api/v2/payments — phase 10 had it as /api/payments.
location /api/v2/payments/ {
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
# Router prefix /api/v2/admin — phase 10 had it as /api/admin.
location /api/v2/admin/ {
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
# Router prefix /api/v2/quota — phase 10 had it as /api/quota.
location /api/v2/quota/ {
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
