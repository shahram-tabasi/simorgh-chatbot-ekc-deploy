#!/usr/bin/env python3
"""
migrate_qdrant_tenant_to_uuid.py
================================
One-shot migration: documents indexed under tenant `project:<short>`
(where <short> was the chatbot project's tpms_oenum — e.g. "12065") are
copied so each chatbot project that shares that OE gets its own
per-UUID tenant copy.

Why: multiple chatbot projects could share the same TPMS OE; using OE as
the Qdrant tenant key meant they all wrote into the same tenant and saw
each other's uploads. The fix (already deployed in code) makes tenant key
= project UUID at every storage/read site. This script re-stamps the
existing chunks accordingly.

Safe to re-run. Non-destructive: legacy tenants stay intact; only NEW
points are added under per-UUID tenants. Deterministic ids
(uuid5 of <orig_tenant>:<orig_point_id>:<target_uuid>) make duplicate
copies idempotent.

USAGE:
  docker compose exec -T project-agent-service \
      python3 /app/scripts/migrate_qdrant_tenant_to_uuid.py           # dry-run
  docker compose exec -T project-agent-service \
      python3 /app/scripts/migrate_qdrant_tenant_to_uuid.py --apply
"""
import json
import os
import re
import sys
import urllib.request
import uuid

import asyncpg

QDRANT = os.getenv("QDRANT_URL", "http://qdrant:6333").rstrip("/")
DOCS = os.getenv("QDRANT_DOCS_COLLECTION", "project_documents")
PG_DSN = (
    f"postgresql://{os.getenv('POSTGRES_AUTH_USER', 'simorgh')}"
    f":{os.getenv('POSTGRES_AUTH_PASSWORD', 'simorgh_secure_2024')}"
    f"@{os.getenv('POSTGRES_AUTH_HOST', 'postgres_auth')}"
    f":{os.getenv('POSTGRES_AUTH_PORT', '5432')}"
    f"/{os.getenv('POSTGRES_AUTH_DATABASE', 'simorgh_auth')}"
)
APPLY = "--apply" in sys.argv
NS = uuid.UUID("00000000-0000-0000-0000-00cafefeeb1d")

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def _req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        QDRANT + path, data=data, method=method,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def scroll_tenant(tenant):
    """Yield every point under a given tenant_id."""
    body = {"limit": 256, "with_payload": True, "with_vector": True,
            "filter": {"must": [{"key": "tenant_id",
                                  "match": {"value": tenant}}]}}
    offset = None
    while True:
        if offset is not None:
            body["offset"] = offset
        res = _req("POST",
                   f"/collections/{DOCS}/points/scroll", body)["result"]
        for p in res.get("points", []):
            yield p
        offset = res.get("next_page_offset")
        if not offset:
            break


def stamp_id(orig_tenant, orig_id, target_uuid):
    return str(uuid.uuid5(NS, f"{orig_tenant}:{orig_id}:{target_uuid}"))


async def main():
    print(f"Qdrant={QDRANT}  target collection={DOCS}  "
          f"mode={'APPLY' if APPLY else 'DRY-RUN'}")
    # 1. Postgres: build oenum → [uuids] map for every chatbot project
    #    with a non-null tpms_oenum.
    conn = await asyncpg.connect(dsn=PG_DSN)
    try:
        rows = await conn.fetch(
            "SELECT id, tpms_oenum FROM projects WHERE tpms_oenum IS NOT NULL")
    finally:
        await conn.close()
    by_oenum: dict[str, list[str]] = {}
    for r in rows:
        oe = str(r["tpms_oenum"] or "").strip().lower()
        if not oe:
            continue
        by_oenum.setdefault(oe, []).append(str(r["id"]))
    print(f"postgres: {len(rows)} projects with tpms_oenum; "
          f"distinct OEs={len(by_oenum)}")

    # 2. Walk every tenant in the unified collection that looks like a
    #    legacy "project:<short>" (NOT already a UUID).
    #    Qdrant has no direct "list distinct payload values" so we scroll
    #    a small sample and gather unique tenant_ids; then process each.
    seen_tenants: set[str] = set()
    body = {"limit": 512, "with_payload": True, "with_vector": False}
    offset = None
    while True:
        if offset is not None:
            body["offset"] = offset
        res = _req("POST",
                   f"/collections/{DOCS}/points/scroll", body)["result"]
        for p in res.get("points", []):
            t = (p.get("payload") or {}).get("tenant_id")
            if isinstance(t, str):
                seen_tenants.add(t)
        offset = res.get("next_page_offset")
        if not offset:
            break

    legacy = [t for t in seen_tenants
              if t.startswith("project:")
              and not UUID_RE.match(t.split("project:", 1)[1])]
    print(f"qdrant: {len(seen_tenants)} tenants seen; "
          f"legacy (non-UUID) tenants={len(legacy)}")
    for t in legacy:
        oe = t.split("project:", 1)[1]
        uuids = by_oenum.get(oe, [])
        if not uuids:
            print(f"  {t}: no matching chatbot projects — skipped")
            continue
        print(f"  {t}: will copy to {len(uuids)} project UUID(s)")

    if not APPLY:
        print("\nDRY RUN — re-run with --apply to copy.")
        return

    # 3. Apply: for each legacy tenant, copy every chunk to each target
    #    project UUID's tenant, with a deterministic point id so re-runs
    #    are idempotent.
    total_in = total_out = 0
    for legacy_t in legacy:
        oe = legacy_t.split("project:", 1)[1]
        target_uuids = by_oenum.get(oe, [])
        if not target_uuids:
            continue
        batch = []
        for p in scroll_tenant(legacy_t):
            total_in += 1
            payload = dict(p.get("payload") or {})
            vec = p.get("vector")
            for target in target_uuids:
                new_payload = dict(payload)
                new_payload["tenant_id"] = f"project:{target}"
                new_payload["legacy_tenant_id"] = legacy_t
                batch.append({
                    "id":      stamp_id(legacy_t, p.get("id"), target),
                    "vector":  vec,
                    "payload": new_payload,
                })
                total_out += 1
                if len(batch) >= 128:
                    _req("PUT", f"/collections/{DOCS}/points?wait=true",
                         {"points": batch})
                    batch = []
        if batch:
            _req("PUT", f"/collections/{DOCS}/points?wait=true",
                 {"points": batch})
        print(f"  {legacy_t}: copied {total_in} chunks -> {total_out} "
              f"target points ({len(target_uuids)}x fan-out)")

    print(f"\nDONE. scanned={total_in}  written={total_out}.")
    print("Legacy tenants left intact (safe to read). Verify, then "
          "manually clear them once isolation is confirmed.")


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
