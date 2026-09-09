#!/usr/bin/env bash
#
# Build the Windows installer on Linux.
#
#   ./build-win.sh                 → release/SimorghDesignSuite-Setup-<version>.exe
#   ./build-win.sh http://192.168.1.68/simorgh-design-suite/
#                                  → the same, opening that server by itself
#
# electron-builder needs Windows tooling for an NSIS installer; on Linux that
# is wine, and it needs the 32-bit side of it — the NSIS stub and rcedit (which
# writes the icon and the version into the .exe) are both 32-bit programs.
# On Ubuntu 24.04:
#
#   sudo dpkg --add-architecture i386
#   sudo apt-get update
#   sudo apt-get install -y wine libgd3:i386 wine32:i386
#
# Everything else is downloaded by electron-builder on the first run (the
# Electron binaries, NSIS, rcedit) and cached in ~/.cache/electron-builder.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v wine >/dev/null; then
  echo "wine is not installed — see the header of this script." >&2
  exit 1
fi
if ! wine --version >/dev/null 2>&1; then
  echo "wine does not run here — see the header of this script." >&2
  exit 1
fi

# The address the installer opens by itself, when one was given. It is written
# beside main.js and packaged with it; the user can still change it from
# File → Change server address…
if [ "${1:-}" != "" ]; then
  node -e "require('fs').writeFileSync('server.json', JSON.stringify({ url: process.argv[1] }, null, 2))" "$1"
  echo "▶ the build will open $1"
else
  rm -f server.json
  echo "▶ the build will ask for the server address on first run"
fi

[ -d node_modules ] || npm ci --no-audit --no-fund
WINEDEBUG=-all npx electron-builder --win --x64

echo
ls -lh release/*.exe
sha256sum release/*.exe
cat <<'NOTE'

To serve it from the app itself, copy it into the download folder — it is
mounted into the container, so no rebuild is needed:

  cp release/*.exe ../simorgh-backend/downloads/
NOTE
