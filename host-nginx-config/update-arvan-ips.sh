#!/usr/bin/env bash
#
# Regenerate the list of ArvanCDN addresses nginx trusts for client IPs.
#
#     ./update-arvan-ips.sh https://…/arvan-ip-ranges.txt
#     ./update-arvan-ips.sh ./ranges.txt
#
# The source is Arvan's own published list — their documentation or panel. This
# script deliberately does not know a URL: a wrong list here is not a broken
# page, it is nginx believing the X-Forwarded-For of whoever is in it. Read the
# list before you feed it in.
#
# Input is one CIDR (or bare address) per line; blank lines and # comments are
# ignored. Anything that is not an address is refused rather than written.
#
# Writes /etc/nginx/conf.d/arvan-real-ip.conf, tests the result, and reloads
# nginx. A failed test restores the previous file and reloads nothing.
set -euo pipefail

src=${1:-}
out=${OUT:-/etc/nginx/conf.d/arvan-real-ip.conf}
here=$(cd "$(dirname "$0")" && pwd)

# Overridable so the script can be exercised against a throwaway nginx, and so
# it still works where nginx is not managed by systemd.
nginx_test=${NGINX_TEST:-"nginx -t"}
nginx_reload=${NGINX_RELOAD:-"systemctl reload nginx"}

if [ -z "$src" ]; then
  sed -n '3,20p' "$0" | sed 's/^#\s\?//'
  exit 2
fi

raw=$(mktemp); trap 'rm -f "$raw" "$raw.body"' EXIT
case $src in
  http://*|https://*) curl -fsS --max-time 30 "$src" > "$raw" ;;
  *)                  cat "$src" > "$raw" ;;
esac

# Keep only well-formed IPv4/IPv6 addresses and CIDRs. Refuse the whole file if
# a line is neither that nor a comment — a list we cannot parse is a list we
# should not be trusting.
ranges=$(grep -vE '^\s*(#|$)' "$raw" | tr -d '\r' | awk '{print $1}' || true)
[ -n "$ranges" ] || { echo "no ranges found in $src" >&2; exit 1; }
while read -r r; do
  case $r in
    *:*)                                                      continue ;;  # IPv6
    *[!0-9./]*) echo "refusing unparseable entry: $r" >&2;     exit 1 ;;
  esac
  case $r in
    0.0.0.0/0) echo "refusing 0.0.0.0/0 — that trusts every client" >&2; exit 1 ;;
  esac
done <<< "$ranges"

tmp=$(mktemp)
sed -n '1,/^# --- ranges below/p' "$here/arvan-real-ip.conf" > "$tmp"
{
  echo "# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) from: $src"
  echo "# $(wc -l <<< "$ranges") range(s)."
  echo
  while read -r r; do echo "set_real_ip_from $r;"; done <<< "$ranges"
} >> "$tmp"

[ -f "$out" ] && cp -a "$out" "$out.prev"
install -m 0644 "$tmp" "$out"; rm -f "$tmp"

if $nginx_test; then
  $nginx_reload
  echo "✔ $(grep -c '^set_real_ip_from' "$out") range(s) trusted; nginx reloaded"
else
  if [ -f "$out.prev" ]; then mv "$out.prev" "$out"; echo "✘ test failed — previous file restored" >&2
  else rm -f "$out"; echo "✘ test failed — file removed" >&2; fi
  exit 1
fi
