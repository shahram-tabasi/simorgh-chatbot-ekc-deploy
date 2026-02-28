#!/bin/sh
# Start Node.js backend in background, then nginx in foreground

echo "Starting Simorgh Soft backend..."
node /app/server.js &
BACKEND_PID=$!

echo "Starting nginx..."
nginx -g "daemon off;" &
NGINX_PID=$!

# Wait for either process to exit
wait -n $BACKEND_PID $NGINX_PID

# If one exits, stop the other
echo "A process exited, shutting down..."
kill $BACKEND_PID $NGINX_PID 2>/dev/null
wait
