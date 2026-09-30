#!/bin/sh
# Start Node.js backend in background, then nginx in foreground.
#
# `wait -n` (wait for whichever of several PIDs exits first) is a bash job-
# control flag — this image's /bin/sh is busybox ash, which doesn't reliably
# support it. Under it, a dead Node process could leave nginx running
# orphaned, serving the static frontend while every /api/ call 502s forever,
# with nothing here noticing to tear the container down and let
# `restart: unless-stopped` recover it. Poll both PIDs instead — portable,
# and exits as soon as either process is gone.

echo "Starting Simorgh Soft backend..."
node /app/server.js &
BACKEND_PID=$!

echo "Starting nginx..."
nginx -g "daemon off;" &
NGINX_PID=$!

while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$NGINX_PID" 2>/dev/null; do
  sleep 2
done

echo "A process exited, shutting down..."
kill "$BACKEND_PID" "$NGINX_PID" 2>/dev/null
wait
