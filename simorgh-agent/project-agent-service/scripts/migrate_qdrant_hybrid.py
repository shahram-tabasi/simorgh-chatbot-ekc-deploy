#!/usr/bin/env python3
"""
migrate_qdrant_hybrid.py
========================
One-shot migration: convert the legacy single-dense `project_documents`
Qdrant collection (768-dim all-MiniLM-L6-v2) into the named-vector
hybrid schema used by services/qdrant_hybrid.py:

  dense  = 1024-dim bge-m3 (multilingual, Persian-capable)
  sparse = BM25 (via fastembed)

WHY: the legacy single-dense path was English-only and embedded
identifiers (part numbers, IEC clause refs, OE numbers) poorly. Hybrid
retrieval gives the chat path real recall on engineering queries —
"L11B fault current rating", "IEC 62271-200 § 5.3", Persian project
descriptions — without changing the call shape downstream.

WHAT IT DOES (destructive, run during a maintenance window):
  - Scrolls every point from the existing `project_documents` collection
    and serialises (id, payload) to disk under
    /tmp/qdrant_migration_<timestamp>/<batch>.jsonl.
    Vectors are NOT saved (we re-embed from payload['text']).
  - DELETES the old collection.
  - Re-creates `project_documents` with the named-vector + sparse
    schema, plus the `tenant_id` keyword payload index.
  - Re-embeds every saved point's text through bge-m3 (dense) and BM25
    (sparse) and upserts. Point IDs are preserved.
  - Reports per-batch progress + a final summary.

DRY-RUN by default. Pass --apply to actually mutate.

USAGE (inside a container on the app network):
    docker compose exec -T project-agent-service \\
        python3 /app/scripts/migrate_qdrant_hybrid.py
    docker compose exec -T project-agent-service \\
        python3 /app/scripts/migrate_qdrant_hybrid.py --apply

Env vars: QDRANT_URL (http://qdrant:6333), EMBEDDING_MODEL (BAAI/bge-m3
default), QDRANT_DOCS_COLLECTION (project_documents),
QDRANT_SPARSE_MODEL (Qdrant/bm25), QDRANT_COLLECTION_SIZE (1024).

Pre-requisites:
  - bge-m3 model cached locally (~2.2 GB). Pre-download:
        python -c "from sentence_transformers import SentenceTransformer; \\
                   SentenceTransformer('BAAI/bge-m3')"
  - fastembed BM25 model cached. Pre-download:
        python -c "from fastembed import SparseTextEmbedding; \\
                   SparseTextEmbedding(model_name='Qdrant/bm25')"
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterator, List, Tuple

# Make the project-agent-service "services" package importable when this
# script is launched from /app/scripts/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("qdrant-hybrid-migration")

COLLECTION = os.getenv("QDRANT_DOCS_COLLECTION", "project_documents")
BATCH = int(os.getenv("MIGRATE_BATCH_SIZE", "256"))


def _connect():
    from qdrant_client import QdrantClient
    url = os.getenv("QDRANT_URL", "http://qdrant:6333")
    api_key = os.getenv("QDRANT_API_KEY") or None
    if api_key:
        return QdrantClient(url=url, api_key=api_key)
    if url.startswith("http://") or url.startswith("https://"):
        return QdrantClient(url=url)
    return QdrantClient(host=url, port=int(os.getenv("QDRANT_PORT", "6333")))


def _scroll_all(client, collection_name: str) -> Iterator[Tuple[str, Dict[str, Any]]]:
    """Yield (point_id, payload) for every point in the legacy collection."""
    offset = None
    total = 0
    while True:
        points, offset = client.scroll(
            collection_name=collection_name,
            limit=BATCH,
            with_payload=True,
            with_vectors=False,
            offset=offset,
        )
        if not points:
            break
        for p in points:
            yield str(p.id), p.payload or {}
            total += 1
        if offset is None:
            break
    logger.info("scrolled %d points from %s", total, collection_name)


def _snapshot_to_disk(it: Iterator[Tuple[str, Dict[str, Any]]],
                      out_dir: Path) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    total = 0
    batch: List[Dict[str, Any]] = []
    batch_num = 0
    for pid, payload in it:
        batch.append({"id": pid, "payload": payload})
        total += 1
        if len(batch) >= BATCH:
            batch_num += 1
            (out_dir / f"batch_{batch_num:06d}.jsonl").write_text(
                "\n".join(json.dumps(r, ensure_ascii=False) for r in batch),
                encoding="utf-8",
            )
            logger.info("snapshot batch %06d (%d pts, total %d)",
                        batch_num, len(batch), total)
            batch.clear()
    if batch:
        batch_num += 1
        (out_dir / f"batch_{batch_num:06d}.jsonl").write_text(
            "\n".join(json.dumps(r, ensure_ascii=False) for r in batch),
            encoding="utf-8",
        )
        logger.info("snapshot batch %06d (final %d pts, total %d)",
                    batch_num, len(batch), total)
    return total


def _iter_snapshot(snapshot_dir: Path
                   ) -> Iterator[Tuple[str, Dict[str, Any]]]:
    for f in sorted(snapshot_dir.glob("batch_*.jsonl")):
        for line in f.read_text(encoding="utf-8").splitlines():
            if not line:
                continue
            obj = json.loads(line)
            yield obj["id"], obj["payload"]


def _delete_and_recreate(client) -> None:
    from services.qdrant_hybrid import ensure_hybrid_collection
    try:
        client.delete_collection(COLLECTION)
        logger.info("deleted legacy collection %s", COLLECTION)
    except Exception as e:  # noqa: BLE001
        logger.warning("delete_collection (likely already gone): %s", e)
    ok = ensure_hybrid_collection(client, COLLECTION)
    if not ok:
        raise RuntimeError(f"ensure_hybrid_collection {COLLECTION} failed")
    logger.info("created hybrid collection %s", COLLECTION)


def _reembed_and_upsert(client, snapshot_dir: Path) -> Tuple[int, int]:
    """Re-embed each saved point's text and write hybrid points back."""
    from services.qdrant_hybrid import build_point
    written, skipped = 0, 0
    buf: List[Any] = []
    BATCH_WRITE = 64
    for pid, payload in _iter_snapshot(snapshot_dir):
        text = payload.get("text") or ""
        if not text.strip():
            skipped += 1
            continue
        point = build_point(point_id=pid, text=text, payload=payload)
        if point is None:
            skipped += 1
            continue
        buf.append(point)
        if len(buf) >= BATCH_WRITE:
            client.upsert(collection_name=COLLECTION, points=buf)
            written += len(buf)
            logger.info("upserted %d (running total %d, skipped %d)",
                        len(buf), written, skipped)
            buf.clear()
    if buf:
        client.upsert(collection_name=COLLECTION, points=buf)
        written += len(buf)
        logger.info("upserted final batch %d (total %d, skipped %d)",
                    len(buf), written, skipped)
    return written, skipped


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true",
                    help="Actually mutate. Default: dry-run only.")
    ap.add_argument("--snapshot-dir", type=str, default="",
                    help="Override the default /tmp snapshot location.")
    ap.add_argument("--skip-snapshot", action="store_true",
                    help="Reuse an existing snapshot dir (skip the scroll).")
    args = ap.parse_args()

    client = _connect()
    try:
        collections = {c.name for c in client.get_collections().collections}
    except Exception as e:
        logger.error("Could not list collections: %s", e)
        return 1

    if COLLECTION not in collections:
        logger.info("Collection %s does not exist — nothing to migrate. "
                    "First write through the hybrid path will create it.",
                    COLLECTION)
        return 0

    # Detect schema state — if it's already hybrid we exit clean.
    try:
        info = client.get_collection(COLLECTION)
        v_cfg = getattr(info.config.params, "vectors", None)
        s_cfg = getattr(info.config.params, "sparse_vectors", None)
        is_named = isinstance(v_cfg, dict) and "dense" in v_cfg
        has_sparse = isinstance(s_cfg, dict) and "sparse" in s_cfg
        if is_named and has_sparse:
            logger.info("%s already uses the hybrid schema — nothing to do.",
                        COLLECTION)
            return 0
    except Exception as e:  # noqa: BLE001
        logger.warning("get_collection: %s — proceeding with migration", e)

    ts = int(time.time())
    snap = Path(args.snapshot_dir
                or f"/tmp/qdrant_migration_{ts}")
    logger.info("snapshot dir: %s", snap)

    if not args.skip_snapshot:
        total = _snapshot_to_disk(_scroll_all(client, COLLECTION), snap)
        logger.info("snapshot complete: %d points", total)
    else:
        total = sum(1 for _ in _iter_snapshot(snap))
        logger.info("reusing snapshot at %s: %d points", snap, total)

    if not args.apply:
        logger.info("DRY-RUN: would now delete %s, recreate it with the "
                    "hybrid schema, and re-embed/upsert %d points. "
                    "Re-run with --apply to commit.",
                    COLLECTION, total)
        return 0

    _delete_and_recreate(client)
    written, skipped = _reembed_and_upsert(client, snap)
    logger.info("DONE: wrote %d points, skipped %d (no-text or encoder fail). "
                "Snapshot kept at %s — delete after verification.",
                written, skipped, snap)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
