#!/usr/bin/env bash
#
# Rebuild and restart the Design Suite (simorgh-soft) on the server.
#
#   ./deploy-soft.sh
#
# The compose file lives in simorgh-agent/, with its .env beside it, so compose
# has to run from there. Running it from the repository root is exactly what
# "no configuration file provided: not found" means — this script is here so
# that cannot happen.
#
# nginx is not part of this: the app is rebuilt into its container and the
# proxies in front of it are untouched. Only a change to
# simorgh-agent/nginx_configs/** or host-nginx-config/** needs a reload, and
# those are printed at the end when they have changed.
set -euo pipefail

cd "$(dirname "$0")"
root=$(pwd)
cd simorgh-agent

echo "▶ building simorgh-soft …"
docker compose up -d --build simorgh-soft

echo
echo "▶ state"
docker compose ps simorgh-soft

# The container answers on :80 inside the app network; the host proxies to it.
echo
echo "▶ health"
for i in 1 2 3 4 5 6 7 8 9 10; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1/simorgh-design-suite/ || true)
  if [ "$code" = "200" ]; then echo "  /simorgh-design-suite/ → 200"; break; fi
  if [ "$i" = "10" ]; then echo "  /simorgh-design-suite/ → $code (still starting? see: docker compose logs -n 50 simorgh-soft)"; fi
  sleep 3
done

# Symbols exported from EPLAN are read from disk, not baked into the image.
symbols=$(ls -1 "$root"/simorgh-agent/simorgh-soft/simorgh-backend/eplan-symbols/*.svg 2>/dev/null | wc -l)
echo
echo "▶ symbol pack: $symbols file(s) — a copy into eplan-symbols/ needs no rebuild"

# Say it only when it is actually needed.
if git -C "$root" diff --name-only HEAD@{1} HEAD 2>/dev/null |
     grep -qE '^(simorgh-agent/nginx_configs/|host-nginx-config/)'; then
  echo
  echo "▶ nginx config changed in this pull — reload the proxies:"
  echo "    docker compose exec nginx nginx -t && docker compose exec nginx nginx -s reload"
  echo "    sudo nginx -t && sudo systemctl reload nginx"
fi

echo
echo "✔ done — hard-refresh the browser (Ctrl+Shift+R) to drop the cached bundle."
