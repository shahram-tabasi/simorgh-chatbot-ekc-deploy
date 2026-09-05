#!/usr/bin/env python3
"""
migrate_qdrant_unified.py
=========================
One-shot migration: copy document chunks from the legacy per-project /
per-session Qdrant collections (user_{uid}_project_{oenum},
user_{uid}_session_{sid}) into the single unified collection
`project_documents`, partitioned by the `tenant_id` payload field.

WHY: collection-per-tenant doesn't scale (Qdrant docs) and caused the
"Too many open files" failures. The app now reads/writes one collection
filtered by tenant_id. This script moves existing data into that model so
previously-uploaded documents stay searchable.

WHAT IT DOES (idempotent, non-destructive):
  - Ensures `project_documents` exists (768-dim, Cosine) + a keyword
    payload index on tenant_id.
  - For every legacy user_*_project_* / user_*_session_* collection:
      * scrolls all points (payload only)
      * derives tenant_id from each point's payload
        (project_oenum -> "project:<oenum>", session_id -> "session:<sid>")
      * RE-EMBEDS the chunk text via embeddings-service (so every migrated
        vector is the same 768-dim model the app now queries with —
        legacy collections may have used a different model/dim)
      * upserts into project_documents with a DETERMINISTIC point id
        (uuid5 of "<source_collection>:<source_point_id>") so re-running
        the script overwrites rather than duplicates.
  - Does NOT delete the legacy collections. Verify, then delete them
    manually to reclaim file descriptors:
        DELETE /collections/{name}

RUN (inside a container on the app network, e.g. project-agent-service):
    docker compose exec -T project-agent-service \
        python3 /app/scripts/migrate_qdrant_unified.py            # dry-run
    docker compose exec -T project-agent-service \
        python3 /app/scripts/migrate_qdrant_unified.py --apply    # do it

Env: QDRANT_URL (http://qdrant:6333), EMBEDDINGS_URL
(http://embeddings-service:8031), QDRANT_DOCS_COLLECTION (project_documents).
"""
import json
import os
import sys
import time
import urllib.request
import uuid

QDRANT = os.getenv("QDRANT_URL", "http://qdrant:6333").rstrip("/")
EMBEDDINGS = os.getenv("EMBEDDINGS_URL", "http://embeddings-service:8031").rstrip("/")
DOCS = os.getenv("QDRANT_DOCS_COLLECTION", "project_documents")
TENANT_FIELD = "tenant_id"
APPLY = "--apply" in sys.argv
NS = uuid.UUID("00000000-0000-0000-0000-0000deadbeef")  # stable namespace


def _req(method, path, body=None, base=QDRANT):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def embed(text):
    return _req("POST", "/embeddings", {"text": text}, base=EMBEDDINGS)["embedding"]


def ensure_docs_collection(dim):
    cols = [c["name"] for c in _req("GET", "/collections")["result"]["collections"]]
    if DOCS not in cols:
        if APPLY:
            _req("PUT", f"/collections/{DOCS}",
                 {"vectors": {"size": dim, "distance": "Cosine"}})
            print(f"  created {DOCS} (dim={dim})")
        else:
            print(f"  [dry-run] would create {DOCS} (dim={dim})")
    # tenant payload index (idempotent)
    if APPLY:
        try:
            _req("PUT", f"/collections/{DOCS}/index",
                 {"field_name": TENANT_FIELD, "field_schema": "keyword"})
        except Exception as e:
            print(f"  tenant index note: {e}")


def tenant_of(payload):
    oe = payload.get("project_oenum")
    sid = payload.get("session_id")
    if oe:
        return f"project:{str(oe).strip().lower()}"
    if sid:
        return f"session:{str(sid).strip().lower()}"
    return None


def scroll(coll):
    offset = None
    while True:
        body = {"limit": 128, "with_payload": True, "with_vector": False}
        if offset is not None:
            body["offset"] = offset
        res = _req("POST", f"/collections/{coll}/points/scroll", body)["result"]
        pts = res.get("points", [])
        for p in pts:
            yield p
        offset = res.get("next_page_offset")
        if not offset:
            break


def main():
    print(f"Qdrant={QDRANT}  Embeddings={EMBEDDINGS}  target={DOCS}  "
          f"mode={'APPLY' if APPLY else 'DRY-RUN'}")
    cols = [c["name"] for c in _req("GET", "/collections")["result"]["collections"]]
    legacy = [c for c in cols
              if ("_project_" in c or "_session_" in c) and c != DOCS
              and not c.startswith("user_memory_")]
    print(f"legacy doc collections: {legacy}")

    # Probe embedding dimension once.
    dim = len(embed("dimension probe"))
    ensure_docs_collection(dim)

    total_in = total_out = skipped = 0
    for coll in legacy:
        n_in = n_out = 0
        batch = []
        for p in scroll(coll):
            n_in += 1
            payload = p.get("payload", {}) or {}
            text = payload.get("text") or ""
            tenant = tenant_of(payload)
            if not text or not tenant:
                skipped += 1
                continue
            payload[TENANT_FIELD] = tenant
            pid = str(uuid.uuid5(NS, f"{coll}:{p.get('id')}"))
            if APPLY:
                batch.append({"id": pid, "vector": embed(text), "payload": payload})
                if len(batch) >= 64:
                    _req("PUT", f"/collections/{DOCS}/points?wait=true",
                         {"points": batch})
                    batch = []
            n_out += 1
        if APPLY and batch:
            _req("PUT", f"/collections/{DOCS}/points?wait=true", {"points": batch})
        print(f"  {coll}: scanned={n_in} migrated={n_out}")
        total_in += n_in
        total_out += n_out

    print(f"\nDONE  scanned={total_in}  migrated={total_out}  skipped={skipped}")
    if not APPLY:
        print("This was a DRY RUN. Re-run with --apply to write.")
    else:
        print(f"Verify: GET {QDRANT}/collections/{DOCS}  → points_count")
        print("Then delete legacy collections to reclaim FDs (manual).")


if __name__ == "__main__":
    main()
