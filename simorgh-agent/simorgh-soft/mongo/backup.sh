#!/bin/bash
# The nightly dump of the simorgh-soft database.
#
# This used to be thirty lines of bash inlined into the compose file's
# `command:`. That works until it does not: every `$` has to be written `$$`
# so compose does not interpolate it, a stray one is a silent substitution
# rather than an error, and nothing about it can be tested without bringing
# the stack up. It is a script now, in the image, where it can be read and run
# on its own.
#
# The database keeps sixty versions of every project, which answers "it was
# there this morning". This answers the other question — what if the database
# itself is lost — so it deliberately writes somewhere the database is not:
# /backups is a bind mount onto the host.
set -u

: "${MONGO_URI:=mongodb://simorgh-soft-mongo:27017}"
: "${BACKUP_AT:=02:30}"
: "${KEEP_DAYS:=30}"
: "${BACKUP_DIR:=/backups}"

log() { echo "$(date -Iseconds) backup: $*"; }

dump() {
  local out="$BACKUP_DIR/simorgh-soft-$(date +%Y-%m-%d_%H%M%S).archive.gz"
  log "dumping to $out"
  if mongodump --uri="$MONGO_URI" --archive="$out" --gzip --quiet; then
    log "ok, $(du -h "$out" | cut -f1)"
  else
    # Said loudly. A backup that has been failing quietly for three weeks is
    # the worst of both worlds: no copy, and everybody sure there is one.
    log "DUMP FAILED — the database was NOT backed up" >&2
    rm -f "$out"
    return 1
  fi
}

prune() {
  # Old dumps go, or the disk fills and takes the database down with it —
  # which would be this script causing the loss it exists to prevent.
  find "$BACKUP_DIR" -name 'simorgh-soft-*.archive.gz' -type f \
       -mtime "+$KEEP_DAYS" -print -delete 2>/dev/null || true
}

# `once` is for running it by hand: docker exec … backup.sh once
if [ "${1:-}" = "once" ]; then
  dump
  exit $?
fi

log "nightly at $BACKUP_AT, keeping $KEEP_DAYS days, into $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"

# One at start-up, so a fresh deployment is not a whole day with nothing and a
# misconfiguration is found now rather than tonight.
dump || true
prune

while true; do
  if [ "$(date +%H:%M)" = "$BACKUP_AT" ]; then
    dump || true
    prune
    # Past the minute, so the same minute does not fire twice.
    sleep 61
  fi
  sleep 20
done
