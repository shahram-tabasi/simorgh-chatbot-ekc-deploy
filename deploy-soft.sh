#!/usr/bin/env bash
#
# Bring the Design Suite (simorgh-soft) up to date on the server.
#
#   ./deploy-soft.sh            take the image GitHub built and restart
#   ./deploy-soft.sh --here     build it on this machine instead
#
# The default is a pull, because that is what the stack is set up for: the
# service in docker-compose.yml names an image and no build context, and the
# build instructions live in docker-compose.build.yml on purpose — a service
# that names both falls through to building whatever it failed to pull, which
# turns an expired registry login into a twenty-minute surprise.
#
# This script used to run `up -d --build`, which with no build section in the
# default stack does nothing at all: compose says "No services to build" and
# starts the image already on the daemon. It looked like a deploy and shipped
# the previous build. Hence the explicit pull, and hence the line at the end
# that prints which commit is actually running.
#
# The compose file lives in simorgh-agent/, with its .env beside it, so compose
# has to run from there. Running it from the repository root is exactly what
# "no configuration file provided: not found" means — this script is here so
# that cannot happen.
#
# nginx is not part of this: only the app's own container is replaced and the
# proxies in front of it are untouched. Only a change to
# simorgh-agent/nginx_configs/** or host-nginx-config/** needs a reload, and
# those are printed at the end when they have changed.
set -euo pipefail

cd "$(dirname "$0")"
root=$(pwd)
cd simorgh-agent

if [ "${1:-}" = "--here" ]; then
  echo "▶ building simorgh-soft on this machine …"
  docker compose -f docker-compose.yml -f docker-compose.build.yml build simorgh-soft
  docker compose -f docker-compose.yml -f docker-compose.build.yml up -d simorgh-soft
else
  echo "▶ pulling simorgh-soft …"
  docker compose pull simorgh-soft
  echo "▶ restarting simorgh-soft …"
  # Recreated rather than left alone: the pull above changes what :latest
  # points at, and a container already running on the old image would stay on
  # it — which is "I deployed and nothing changed", again.
  docker compose up -d --force-recreate simorgh-soft
fi

echo
echo "▶ state"
docker compose ps simorgh-soft

# Which commit this actually is. The whole point of the label: "the feature is
# not there" is then answerable by looking rather than by guessing.
echo
echo "▶ running commit"
docker inspect --format '  {{index .Config.Labels "org.opencontainers.image.revision"}}' simorgh-soft 2>/dev/null \
  || echo "  (no revision label — an image built before the label was added)" 

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
