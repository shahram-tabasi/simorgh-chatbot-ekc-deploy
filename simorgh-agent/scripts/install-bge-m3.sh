#!/usr/bin/env bash
# install-bge-m3.sh
# =============================================================================
# Install the pre-downloaded BAAI/bge-m3 tarball (produced by
# .github/workflows/bge-m3-fetch.yml) into the simorgh_huggingface_cache
# Docker volume that project-agent-service and (optionally) context-search
# mount at /root/.cache/huggingface.
#
# Implements "Option B" of the EMBEDDING_MODEL config: instead of letting
# sentence-transformers fetch BAAI/bge-m3 from HuggingFace at runtime
# (impossible on an air-gapped box), the model lives on disk and
# EMBEDDING_MODEL is a snapshot path so transformers loads it locally.
#
# What this script does
# ---------------------
# 1. Verifies SHA256 if a .sha256 sibling file is present.
# 2. Extracts the tarball into the simorgh_huggingface_cache volume
#    (creates the volume if it doesn't exist).
# 3. Discovers the snapshot hash inside the extracted tree.
# 4. Updates the EMBEDDING_MODEL line in simorgh-agent/.env (in place,
#    with a .bak backup) and prints the value for verification.
# 5. (Optional) Runs a smoke-test load via the project-agent image so
#    you know the model is intact before restarting the service.
#
# Idempotent: re-running with the same tarball is a no-op (tar will
# overwrite identical files; the .env update is also idempotent).
#
# Usage
# -----
#   ./scripts/install-bge-m3.sh /tmp/BAAI__bge-m3.tar.gz
#   ./scripts/install-bge-m3.sh /tmp/BAAI__bge-m3.tar.gz --skip-smoke
#   ./scripts/install-bge-m3.sh /tmp/BAAI__bge-m3.tar.gz --env-file /custom/.env
#
# Flags
#   --skip-smoke      Skip the model-load smoke test (saves ~60s).
#   --skip-env        Don't touch .env (just extract + print path).
#   --env-file PATH   Override .env location (default: ../.env relative
#                     to this script — i.e. simorgh-agent/.env).
#   --volume NAME     Override the docker volume name
#                     (default: simorgh_huggingface_cache).
# =============================================================================
set -euo pipefail

# --- defaults ----------------------------------------------------------------
VOLUME="simorgh_huggingface_cache"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
SMOKE=1
UPDATE_ENV=1

# --- arg parsing -------------------------------------------------------------
TARBALL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-smoke)   SMOKE=0; shift ;;
    --skip-env)     UPDATE_ENV=0; shift ;;
    --env-file)     ENV_FILE="$2"; shift 2 ;;
    --volume)       VOLUME="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,40p' "$0"; exit 0 ;;
    -*)             echo "Unknown flag: $1" >&2; exit 2 ;;
    *)              TARBALL="$1"; shift ;;
  esac
done

if [[ -z "${TARBALL}" ]]; then
  echo "Usage: $0 /path/to/BAAI__bge-m3.tar.gz [flags]" >&2
  exit 2
fi
if [[ ! -f "${TARBALL}" ]]; then
  echo "Tarball not found: ${TARBALL}" >&2
  exit 2
fi

# Resolve to absolute path so the docker mount works regardless of cwd.
TARBALL="$(cd "$(dirname "${TARBALL}")" && pwd)/$(basename "${TARBALL}")"
TARBALL_DIR="$(dirname "${TARBALL}")"
TARBALL_NAME="$(basename "${TARBALL}")"

# --- prerequisite checks -----------------------------------------------------
command -v docker >/dev/null 2>&1 || {
  echo "docker not in PATH. Install Docker first." >&2; exit 1
}

# --- 1. SHA256 verification (if sibling file present) ------------------------
SHA256_FILE="${TARBALL}.sha256"
if [[ -f "${SHA256_FILE}" ]]; then
  echo "▶ Verifying SHA256 …"
  (cd "${TARBALL_DIR}" && sha256sum -c "$(basename "${SHA256_FILE}")")
  echo "  OK"
else
  echo "▶ No ${TARBALL_NAME}.sha256 sibling — skipping integrity check."
fi

# --- 2. Extract into the Docker volume --------------------------------------
echo "▶ Ensuring volume ${VOLUME} exists …"
docker volume create "${VOLUME}" >/dev/null

# Detect tarball layout so we strip the right number of leading components.
# The workflow up to commit 94840eb packed the archive with `huggingface/`
# as the root directory; later runs pack it with `hub/` as the root. We
# auto-detect to support both.
#   layout A — root entry is "huggingface/hub/..."   → strip 1
#   layout B — root entry is "hub/..."               → strip 0
#   layout C — root entry is "models--BAAI--bge-m3/" → strip 0 + nest under hub/
echo "▶ Detecting archive layout …"
FIRST_ENTRY="$(tar tzf "${TARBALL}" 2>/dev/null | head -1 | tr -d '\n')"
case "${FIRST_ENTRY}" in
  huggingface/*)
    STRIP=1
    EXTRACT_TO="/dst"
    echo "  layout: huggingface/hub/… (strip 1)"
    ;;
  hub/*)
    STRIP=0
    EXTRACT_TO="/dst"
    echo "  layout: hub/… (strip 0)"
    ;;
  models--*/*|.huggingface/* )
    STRIP=0
    EXTRACT_TO="/dst/hub"
    echo "  layout: models--…/ (nest under hub/)"
    ;;
  *)
    echo "  Unrecognised archive layout (first entry: '${FIRST_ENTRY}')."
    echo "  Defaulting to extract-as-is into /dst — manual cleanup may be needed."
    STRIP=0
    EXTRACT_TO="/dst"
    ;;
esac

# Clean any stale top-level "huggingface/" directory left over from a
# previous run that used the broken layout — otherwise we leave dead
# files in the volume taking up disk.
echo "▶ Removing any stale huggingface/ subdir from prior failed runs …"
docker run --rm -v "${VOLUME}:/dst" alpine sh -c \
  'if [ -d /dst/huggingface ]; then rm -rf /dst/huggingface && echo "  cleaned stale /dst/huggingface"; fi' \
  || true

echo "▶ Extracting ${TARBALL_NAME} into volume ${VOLUME} …"
# Run as root inside the helper container so the volume gets the right
# perms; project-agent-service's HF_HOME=/root/.cache/huggingface
# expects /root ownership. STRIP / EXTRACT_TO were chosen above by the
# layout-detection block so the resulting tree is always
#   /dst/hub/models--BAAI--bge-m3/snapshots/<hash>/...
docker run --rm \
  -v "${VOLUME}:/dst" \
  -v "${TARBALL_DIR}:/src:ro" \
  alpine sh -c "
    set -e
    mkdir -p '${EXTRACT_TO}'
    tar xzf '/src/${TARBALL_NAME}' -C '${EXTRACT_TO}' --strip-components=${STRIP}
    echo '----- extracted tree -----'
    find /dst/hub/models--BAAI--bge-m3 -maxdepth 4 -type d
    du -sh /dst/hub/models--BAAI--bge-m3
  "

# --- 3. Discover the snapshot hash -------------------------------------------
echo "▶ Discovering snapshot hash …"
SNAP_HASH="$(docker run --rm -v "${VOLUME}:/v:ro" alpine sh -c \
  "ls /v/hub/models--BAAI--bge-m3/snapshots/ 2>/dev/null | head -1" \
  | tr -d '[:space:]')"

if [[ -z "${SNAP_HASH}" ]]; then
  echo "ERROR: no snapshot directory found at "        >&2
  echo "  ${VOLUME}:/hub/models--BAAI--bge-m3/snapshots/" >&2
  echo "Did the tarball extract correctly?"            >&2
  exit 3
fi
SNAP_PATH="/root/.cache/huggingface/hub/models--BAAI--bge-m3/snapshots/${SNAP_HASH}"
echo "  snapshot hash: ${SNAP_HASH}"
echo "  snapshot path: ${SNAP_PATH}"

# --- 4. Update .env (in place, with .bak backup) -----------------------------
if [[ "${UPDATE_ENV}" -eq 1 ]]; then
  if [[ ! -f "${ENV_FILE}" ]]; then
    echo "▶ .env not found at ${ENV_FILE} — skipping update."
    echo "  Add this line manually:"
    echo "    EMBEDDING_MODEL=${SNAP_PATH}"
  else
    echo "▶ Updating ${ENV_FILE} …"
    if grep -q '^EMBEDDING_MODEL=' "${ENV_FILE}"; then
      # Replace the existing line. sed -i with .bak makes the backup atomic.
      sed -i.bak "s|^EMBEDDING_MODEL=.*|EMBEDDING_MODEL=${SNAP_PATH}|" "${ENV_FILE}"
      echo "  Replaced EMBEDDING_MODEL line. Backup: ${ENV_FILE}.bak"
    else
      # No existing line — append.
      printf '\n# Set by install-bge-m3.sh\nEMBEDDING_MODEL=%s\n' \
        "${SNAP_PATH}" >> "${ENV_FILE}"
      echo "  Appended EMBEDDING_MODEL line."
    fi
    # Show the operator the line they now have.
    echo "  Current value:"
    grep '^EMBEDDING_MODEL=' "${ENV_FILE}" | sed 's/^/    /'
  fi
fi

# --- 5. Smoke test: load the model from the volume --------------------------
if [[ "${SMOKE}" -eq 1 ]]; then
  echo "▶ Running smoke-test load (sentence-transformers from the snapshot) …"
  # Use a slim Python image; the test only needs torch + sentence_transformers
  # for one encode() call. ~60s the first time (downloads the deps).
  docker run --rm \
    -v "${VOLUME}:/root/.cache/huggingface:ro" \
    -e HF_HOME=/root/.cache/huggingface \
    -e TRANSFORMERS_OFFLINE=1 \
    -e HF_HUB_OFFLINE=1 \
    python:3.11-slim bash -c "
      set -e
      pip install --quiet 'sentence-transformers>=3.0.0' >/dev/null 2>&1
      python - <<'PY'
from sentence_transformers import SentenceTransformer
m = SentenceTransformer('${SNAP_PATH}', device='cpu')
v = m.encode('A 6.6 kV switchgear has an IP54 enclosure rating.', normalize_embeddings=True)
print('OK — encoded vector dim:', len(v))
assert len(v) == 1024, f'expected dim 1024, got {len(v)}'
print('Dimension matches QDRANT_COLLECTION_SIZE=1024.')
PY
    " || {
      echo
      echo "❌ Smoke test FAILED. The model files are in the volume but"
      echo "   sentence-transformers couldn't load them offline. Common"
      echo "   causes:"
      echo "     • Tarball was packed without the snapshot symlinks"
      echo "       (HF_HUB_ENABLE_HF_TRANSFER=0 in the workflow fixes this)."
      echo "     • Snapshot dir contains blob refs but no resolved files."
      echo "   Re-run the workflow, or inspect:"
      echo "     docker run --rm -v ${VOLUME}:/v alpine ls -la ${SNAP_PATH}"
      exit 4
    }
  echo
  echo "✅ Smoke test passed."
fi

# --- Done --------------------------------------------------------------------
cat <<EOF

============================================================
Installation complete.

Next steps:
  1. Verify the .env line (it's already updated):
       EMBEDDING_MODEL=${SNAP_PATH}
  2. Restart the services that load the embedder:
       docker compose restart project-agent-service context-search
  3. (First-time only) run the Qdrant migration to flip the
     existing dense-only collection to the hybrid schema:
       docker compose exec -T project-agent-service \\
         python3 /app/scripts/migrate_qdrant_hybrid.py --apply

If you also pre-downloaded BAAI/bge-reranker-v2-m3 (Phase 7),
extract it into the same simorgh_huggingface_cache volume —
no .env change needed; CONTENT_SEARCH_RERANKER_MODEL already
points at the HF repo id and will resolve from the local cache.
============================================================
EOF
