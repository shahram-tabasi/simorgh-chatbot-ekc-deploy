# =======================================================================
# Shared Location Blocks for Simorgh AI
# Included by all server blocks
# =======================================================================

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
# BACKEND API
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
