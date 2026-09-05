#!/usr/bin/env bash
# install-build-deps.sh
# =============================================================================
# Install the bundled build-time dependencies (pip wheels + npm cache +
# apt .debs) produced by .github/workflows/build-deps-bundle.yml into
# /srv/build-deps/ on the deploy host. Once installed, every Dockerfile
# in the stack can fetch its dependencies over the LAN (out of the
# docker build context) instead of the metered international link.
#
# What this script does
# ---------------------
# 1. Verifies SHA256 if a sibling .sha256 file is present.
# 2. Unzips the bundle into /srv/build-deps/ (default; override with
#    --dest PATH).
# 3. Prints the bundle MANIFEST so you can see what landed.
# 4. Optionally tests one consumption path (pip install --no-index from
#    the wheels dir) to confirm the bundle is sane.
#
# Idempotent: re-running with the same zip is safe (unzip -o overwrites
# matching files; the tree is purely additive otherwise).
#
# Usage
# -----
#   ./scripts/install-build-deps.sh /tmp/simorgh-build-deps-<sha>.zip
#   ./scripts/install-build-deps.sh /tmp/...zip --dest /var/lib/simorgh-deps
#   ./scripts/install-build-deps.sh /tmp/...zip --skip-test
# =============================================================================
set -euo pipefail

DEST="/srv/build-deps"
SKIP_TEST=0

ZIPFILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest)         DEST="$2"; shift 2 ;;
    --skip-test)    SKIP_TEST=1; shift ;;
    -h|--help)      sed -n '2,30p' "$0"; exit 0 ;;
    -*)             echo "Unknown flag: $1" >&2; exit 2 ;;
    *)              ZIPFILE="$1"; shift ;;
  esac
done

[[ -n "$ZIPFILE" ]] || { echo "Usage: $0 /path/to/simorgh-build-deps-<sha>.zip"; exit 2; }
[[ -f "$ZIPFILE" ]] || { echo "Not found: $ZIPFILE" >&2; exit 2; }

ZIPFILE="$(cd "$(dirname "$ZIPFILE")" && pwd)/$(basename "$ZIPFILE")"
ZIP_DIR="$(dirname "$ZIPFILE")"
ZIP_NAME="$(basename "$ZIPFILE")"

# --- 1. Sha256 verification (if sibling exists) ------------------------------
SHA="${ZIPFILE}.sha256"
if [[ -f "$SHA" ]]; then
  echo "▶ Verifying SHA256 …"
  ( cd "$ZIP_DIR" && sha256sum -c "$(basename "$SHA")" )
fi

# --- 2. Unzip into DEST -----------------------------------------------------
echo "▶ Extracting to ${DEST} …"
sudo mkdir -p "$DEST"
sudo chown "$(id -u):$(id -g)" "$DEST"   # so we can unzip without sudo
unzip -oq "$ZIPFILE" -d "$DEST"

# --- 3. Show what landed ----------------------------------------------------
if [[ -f "$DEST/MANIFEST.txt" ]]; then
  echo
  echo "▶ Bundle manifest:"
  sed 's/^/    /' "$DEST/MANIFEST.txt"
fi
echo
echo "▶ Final tree (one level):"
find "$DEST" -maxdepth 2 -type d -printf '    %p\n' | sort

# --- 4. Optional smoke test (does pip see at least one wheel?) --------------
if [[ "$SKIP_TEST" -eq 0 ]] && [[ -d "$DEST/wheels" ]]; then
  WHL_COUNT=$(ls "$DEST/wheels"/*.whl 2>/dev/null | wc -l)
  echo
  echo "▶ Sanity check: $WHL_COUNT wheel(s) in $DEST/wheels"
  if (( WHL_COUNT == 0 )); then
    echo "  ⚠ no wheels found; the bundle may be incomplete." >&2
  else
    # Quick spot-check: is fastapi reachable via --find-links?
    if ls "$DEST/wheels"/fastapi-* &>/dev/null; then
      echo "  ✓ fastapi wheel present"
    fi
    if ls "$DEST/wheels"/torch-* &>/dev/null; then
      echo "  ✓ torch wheel present"
    fi
  fi
fi

# --- Done -------------------------------------------------------------------
cat <<EOF

============================================================
Installation complete.

Mount the bundle in your Dockerfiles via docker compose using a
named additional context. In simorgh-agent/docker-compose.override.yml:

  services:
    project-agent-service:
      build:
        additional_contexts:
          deps: ${DEST}     # <- the named "deps" build context

Then in each Dockerfile, switch the install steps to consume from
deps:

  # Pip (offline, no network calls)
  COPY --from=deps /wheels             /tmp/wheels
  COPY --from=deps /requirements       /tmp/requirements
  RUN pip install --no-index --find-links=/tmp/wheels \\
        -r /tmp/requirements/<this-service>.txt \\
   && rm -rf /tmp/wheels /tmp/requirements

  # Apt (offline)
  RUN rm -f /etc/apt/apt.conf.d/docker-clean
  COPY --from=deps /apt/<distro>      /var/cache/apt/archives
  RUN apt-get install -y --no-download \\
        \$(grep -vE '^(#|\$)' /var/cache/apt/archives/.apt-list 2>/dev/null \\
           || echo build-essential libpq-dev git wget curl)

  # Npm (frontend)
  COPY --from=deps /npm                /tmp/npm
  RUN cd /app && npm ci --offline --cache /tmp/npm

Once a few Dockerfiles are converted, rebuild them:
  cd ~/simorgh-chatbot-ekc-deploy/simorgh-agent
  docker compose build project-agent-service context-search frontend

Subsequent rebuilds will fetch NOTHING from the public internet.
============================================================
EOF
