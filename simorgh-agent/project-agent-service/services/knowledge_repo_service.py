"""
Knowledge-repo service — always-on grounding layer for project chats
====================================================================

Mirrors the design of hr-kb-service/ingest_local.py but targets a
SINGLE shared GitLab project (the "technical knowledge repo") rather
than a group. Every CoT plan picks knowledge-repo top-K passages for
free as the silent background grounding, regardless of which other
sources the user has selected.

Lifecycle
---------
1. project-agent-service starts → `start_background_refresh()` kicks
   off the asyncio task.
2. First tick: full reindex from gitlab-mcp /tree → /artifact, chunk
   structurally, embed via embeddings-service, upsert into Qdrant
   collection `technical_knowledge_kb` (configurable).
3. Subsequent ticks: every `KNOWLEDGE_REPO_REFRESH_HOURS` (default
   24h) re-runs the same pipeline. Same chunk IDs = upsert, no
   duplicates. Files that disappeared on the remote get pruned by
   tracking the last-seen ID set.
4. Runtime queries: `retrieve(query, top_k)` embeds the query and
   returns top-K passages from Qdrant. Used by every CoT plan as
   the "always-on" grounding layer.

Env
---
KNOWLEDGE_REPO_PROJECT       GitLab path of the knowledge repo
                              (e.g. "simorgh/technical-knowledge").
                              REQUIRED — service no-ops if unset
                              so it can't accidentally index the
                              wrong repo. Operator must set in .env.
KNOWLEDGE_REPO_BRANCH        Default "main".
KNOWLEDGE_REPO_COLLECTION    Qdrant collection name. Default
                              "technical_knowledge_kb".
KNOWLEDGE_REPO_REFRESH_HOURS Background refresh interval. Default 24.
GITLAB_MCP_URL               http://gitlab-mcp:8047 (existing).
EMBEDDINGS_URL               http://embeddings-service:8031 (existing,
                              hardcoded for the same reason as
                              chat-service — .env can override the
                              wrong host).
QDRANT_URL                   http://qdrant:6333 (existing).

Public API
----------
* start_background_refresh()  — call once at app startup
* reindex_now() -> dict       — force a full reindex (admin endpoint)
* retrieve(query, top_k, ...) -> list[dict]
                                — runtime grounding call (no LLM)
* is_ready() -> bool          — has at least one successful index run?
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import httpx
from qdrant_client import QdrantClient
from qdrant_client.http import models as qmodels

log = logging.getLogger("knowledge_repo")

# ---- config --------------------------------------------------------
# Use the existing GITLAB_TECH_KB_REPO env that's already wired into
# compose for project-agent (defaults to simorgh-knowledge/technical-
# knowledge). KNOWLEDGE_REPO_PROJECT kept as override for callers that
# want a per-deployment knowledge repo distinct from the global tech
# KB. Either being non-empty enables the service.
KNOWLEDGE_REPO_PROJECT       = (os.getenv("KNOWLEDGE_REPO_PROJECT", "").strip()
                                or os.getenv("GITLAB_TECH_KB_REPO", "").strip())
KNOWLEDGE_REPO_BRANCH        = os.getenv("KNOWLEDGE_REPO_BRANCH", "main")
KNOWLEDGE_REPO_COLLECTION    = os.getenv("KNOWLEDGE_REPO_COLLECTION", "technical_knowledge_kb")
KNOWLEDGE_REPO_REFRESH_HOURS = float(os.getenv("KNOWLEDGE_REPO_REFRESH_HOURS", "24"))
GITLAB_MCP_URL               = os.getenv("GITLAB_MCP_URL", "http://gitlab-mcp:8047")
EMBEDDINGS_URL               = os.getenv("EMBEDDINGS_URL", "http://embeddings-service:8031")
QDRANT_URL                   = os.getenv("QDRANT_URL", "http://qdrant:6333")

CHUNK_CHAR_SIZE              = int(os.getenv("KNOWLEDGE_CHUNK_CHARS", "1800"))
CHUNK_CHAR_OVERLAP           = int(os.getenv("KNOWLEDGE_CHUNK_OVERLAP", "200"))

# ---- module state --------------------------------------------------
_qdrant: Optional[QdrantClient] = None
_embed_dims: Optional[int] = None
_ready: bool = False
_last_indexed_ids: set[str] = set()
_refresh_task: Optional[asyncio.Task] = None


# ---------------------------------------------------------------------------
# Chunker — same shape as hr-kb-service/ingest_local.py.
# Duplicated rather than imported because the two services live in
# separate dirs; extracting to /shared/ is a follow-up if a third
# consumer ever appears.
# ---------------------------------------------------------------------------
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)


def _trim_heading(s: str, max_chars: int = 120) -> str:
    for sep in ("|", " — ", "—"):
        i = s.find(sep)
        if 5 < i < max_chars:
            return s[:i].strip()
    for term in ("؟", "!", ".", ":"):
        i = s.find(term)
        if 8 < i < max_chars:
            return s[:i + 1].strip()
    if len(s) > max_chars:
        return s[:max_chars].rstrip() + "…"
    return s


def _split_long(body: str) -> List[str]:
    n = len(body)
    if n <= CHUNK_CHAR_SIZE:
        return [body]
    out: List[str] = []
    i = 0
    while i < n:
        end = min(i + CHUNK_CHAR_SIZE, n)
        if end < n:
            from_ = max(i + int(CHUNK_CHAR_SIZE * 0.75), i + 1)
            for sep in ("\n\n", "\n", ". ", " "):
                cut = body.rfind(sep, from_, end)
                if cut != -1:
                    end = cut + len(sep)
                    break
        out.append(body[i:end])
        if end >= n:
            break
        i = max(end - CHUNK_CHAR_OVERLAP, i + 1)
    return out


def _chunk_markdown(md: str) -> List[Dict[str, Any]]:
    """Heading-aware section chunker with body-glued-to-heading recovery.
    See hr-kb-service/ingest_local.py for the longer-form rationale."""
    if not md:
        return []
    lines = md.split("\n")
    sections: List[Dict[str, Any]] = []
    stack: List[Tuple[int, str, str]] = []
    buf: List[str] = []

    def flush():
        body = "\n".join(buf).strip()
        if not stack and not body:
            return
        if (not body or len(body) < 30) and stack:
            full = stack[-1][2]
            trimmed = stack[-1][1]
            tail = full[len(trimmed):].lstrip(" :.،؛-—") if len(full) > len(trimmed) else ""
            if tail:
                body = (tail + ("\n\n" + body if body else "")).strip()
        if body:
            sections.append({
                "heading_path": [disp for _, disp, _ in stack],
                "body": body,
            })
        buf.clear()

    for ln in lines:
        m = _HEADING_RE.match(ln)
        if m:
            flush()
            level = len(m.group(1))
            full = m.group(2).strip()
            disp = _trim_heading(full)
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, disp, full))
            continue
        buf.append(ln)
    flush()

    out: List[Dict[str, Any]] = []
    for sec in sections:
        for w in _split_long(sec["body"]):
            out.append({
                "text": w,
                "heading_path": sec["heading_path"],
                "section_path": " > ".join(sec["heading_path"]) or "(no heading)",
            })
    return out


# ---------------------------------------------------------------------------
# GitLab + embedding HTTP helpers
# ---------------------------------------------------------------------------
async def _gitlab_tree(client: httpx.AsyncClient) -> List[str]:
    """Walk the knowledge repo's tree via gitlab-mcp /tree. Returns the
    list of blob paths (skipping the auto-extracted sidecars under
    .simorgh/ since read_artifact returns the extracted markdown of
    the source file itself — indexing the sidecar would double-index)."""
    r = await client.get(
        f"{GITLAB_MCP_URL}/tree",
        params={"project": KNOWLEDGE_REPO_PROJECT,
                "ref": KNOWLEDGE_REPO_BRANCH,
                "recursive": True},
        timeout=30.0,
    )
    r.raise_for_status()
    entries = r.json().get("entries", []) or []
    return [
        e["path"] for e in entries
        if isinstance(e, dict)
        and e.get("type") in (None, "blob")
        and e.get("path")
        and not e["path"].startswith(".simorgh/")
        and not e["path"].startswith(".git/")
    ]


async def _gitlab_artifact(path: str, client: httpx.AsyncClient) -> Optional[str]:
    """Fetch the markdown rendition of a file. Returns None on failure
    so a single bad file doesn't tank the whole reindex."""
    try:
        r = await client.get(
            f"{GITLAB_MCP_URL}/artifact",
            params={"project": KNOWLEDGE_REPO_PROJECT,
                    "path": path,
                    "ref": KNOWLEDGE_REPO_BRANCH},
            timeout=120.0,
        )
        r.raise_for_status()
        return (r.json() or {}).get("content") or None
    except Exception as e:
        log.warning("knowledge artifact failed path=%s err=%s", path, e)
        return None


async def _embed_batch(texts: List[str],
                        client: httpx.AsyncClient) -> List[Optional[List[float]]]:
    if not texts:
        return []
    try:
        r = await client.post(
            f"{EMBEDDINGS_URL}/embeddings/batch",
            json={"texts": texts},
            timeout=60.0,
        )
        r.raise_for_status()
        return r.json().get("embeddings", [])
    except Exception as e:
        log.warning("knowledge batch embed failed: %s; fallback per-text", e)
    out: List[Optional[List[float]]] = []
    for t in texts:
        try:
            r = await client.post(
                f"{EMBEDDINGS_URL}/embeddings",
                json={"text": t}, timeout=20.0,
            )
            r.raise_for_status()
            out.append(r.json().get("embedding"))
        except Exception:
            out.append(None)
    return out


async def _embed_one(text: str) -> Optional[List[float]]:
    if not text or not text.strip():
        return None
    async with httpx.AsyncClient(timeout=20.0) as c:
        try:
            r = await c.post(f"{EMBEDDINGS_URL}/embeddings", json={"text": text})
            r.raise_for_status()
            return r.json().get("embedding")
        except Exception as e:
            log.warning("knowledge query embed failed: %s", e)
            return None


# ---------------------------------------------------------------------------
# Qdrant helpers
# ---------------------------------------------------------------------------
def _qclient() -> QdrantClient:
    global _qdrant
    if _qdrant is None:
        _qdrant = QdrantClient(url=QDRANT_URL, timeout=30.0)
    return _qdrant


def _ensure_collection(dim: int) -> None:
    client = _qclient()
    try:
        existing = client.get_collection(KNOWLEDGE_REPO_COLLECTION)
        if existing.config.params.vectors.size != dim:
            log.error("knowledge collection dim mismatch existing=%d new=%d "
                      "— manual recreate required",
                      existing.config.params.vectors.size, dim)
        return
    except Exception:
        pass
    client.create_collection(
        collection_name=KNOWLEDGE_REPO_COLLECTION,
        vectors_config=qmodels.VectorParams(size=dim, distance=qmodels.Distance.COSINE),
    )
    for field in ("source_file", "section_path"):
        try:
            client.create_payload_index(
                collection_name=KNOWLEDGE_REPO_COLLECTION,
                field_name=field,
                field_schema=qmodels.PayloadSchemaType.KEYWORD,
            )
        except Exception as e:
            log.warning("knowledge payload index %s failed: %s", field, e)
    log.info("knowledge collection created name=%s dim=%d",
             KNOWLEDGE_REPO_COLLECTION, dim)


def _chunk_id(path: str, idx: int) -> str:
    return str(uuid.uuid5(
        uuid.NAMESPACE_URL,
        f"knowledge::{KNOWLEDGE_REPO_PROJECT}::{path}::{idx}",
    ))


# ---------------------------------------------------------------------------
# Indexing pipeline
# ---------------------------------------------------------------------------
@dataclass
class IndexStats:
    files: int = 0
    chunks: int = 0
    embedded: int = 0
    upserted: int = 0
    pruned: int = 0
    errors: int = 0


async def _do_reindex() -> IndexStats:
    """One full pass of the pipeline. Safe to call concurrently — the
    background loop awaits each call so they don't overlap, and on-
    demand admin calls just join the queue."""
    global _ready, _last_indexed_ids, _embed_dims
    stats = IndexStats()
    if not KNOWLEDGE_REPO_PROJECT:
        log.info("knowledge reindex skipped: KNOWLEDGE_REPO_PROJECT unset")
        return stats

    async with httpx.AsyncClient(timeout=180.0) as client:
        try:
            files = await _gitlab_tree(client)
        except Exception as e:
            log.warning("knowledge tree walk failed project=%s err=%s",
                        KNOWLEDGE_REPO_PROJECT, e)
            stats.errors += 1
            return stats

        pending: List[Dict[str, Any]] = []
        for path in files:
            stats.files += 1
            md = await _gitlab_artifact(path, client)
            if not md:
                continue
            try:
                chunks = _chunk_markdown(md)
            except Exception as e:
                log.warning("knowledge chunk failed path=%s err=%s", path, e)
                stats.errors += 1
                continue
            for idx, ch in enumerate(chunks):
                pending.append({
                    "id": _chunk_id(path, idx),
                    "text": ch["text"],
                    "payload": {
                        "text": ch["text"],
                        "source_file": path,
                        "section_path": ch["section_path"],
                        "heading_path": ch["heading_path"],
                        "repo": KNOWLEDGE_REPO_PROJECT,
                        "branch": KNOWLEDGE_REPO_BRANCH,
                        "chunk_idx": idx,
                    },
                })
        stats.chunks = len(pending)
        if not pending:
            log.warning("knowledge reindex: 0 chunks (check repo path / token)")
            return stats

        # Batched embed → batched upsert. Stable IDs make this an upsert
        # (no duplication) on subsequent runs.
        BATCH = 32
        points: List[qmodels.PointStruct] = []
        for i in range(0, len(pending), BATCH):
            batch = pending[i:i + BATCH]
            vecs = await _embed_batch([p["text"] for p in batch], client)
            for p, v in zip(batch, vecs):
                if v is None:
                    continue
                stats.embedded += 1
                if _embed_dims is None:
                    _embed_dims = len(v)
                    _ensure_collection(_embed_dims)
                points.append(qmodels.PointStruct(
                    id=p["id"], vector=v, payload=p["payload"],
                ))
        if not points:
            log.error("knowledge reindex: nothing embedded; check embeddings URL")
            return stats

        new_ids = {p.id for p in points}
        UP_BATCH = 200
        for i in range(0, len(points), UP_BATCH):
            try:
                _qclient().upsert(
                    collection_name=KNOWLEDGE_REPO_COLLECTION,
                    points=points[i:i + UP_BATCH],
                    wait=True,
                )
                stats.upserted += len(points[i:i + UP_BATCH])
            except Exception as e:
                log.exception("knowledge upsert failed offset=%d err=%s", i, e)
                stats.errors += 1

        # Prune chunks that disappeared from the remote (renamed/deleted
        # files). _last_indexed_ids is populated from the previous run;
        # diff gives us a clean drop-set.
        if _last_indexed_ids:
            stale = _last_indexed_ids - new_ids
            if stale:
                try:
                    _qclient().delete(
                        collection_name=KNOWLEDGE_REPO_COLLECTION,
                        points_selector=qmodels.PointIdsList(
                            points=list(stale),
                        ),
                        wait=True,
                    )
                    stats.pruned = len(stale)
                    log.info("knowledge pruned %d stale chunks", len(stale))
                except Exception as e:
                    log.warning("knowledge prune failed: %s", e)
        _last_indexed_ids = new_ids
        _ready = True

    log.info("knowledge reindex done: %s repo=%s branch=%s",
             stats, KNOWLEDGE_REPO_PROJECT, KNOWLEDGE_REPO_BRANCH)
    return stats


# ---------------------------------------------------------------------------
# Background loop + public surface
# ---------------------------------------------------------------------------
async def _background_loop() -> None:
    """Initial reindex + periodic refresh. Survives transient failures
    so the project-agent process doesn't crash on a flaky gitlab-mcp."""
    if not KNOWLEDGE_REPO_PROJECT:
        log.info("knowledge background loop disabled: "
                 "KNOWLEDGE_REPO_PROJECT not configured")
        return
    # Tiny stagger so we don't race the embeddings-service healthcheck
    # at cold start.
    await asyncio.sleep(5.0)
    interval_sec = max(60.0, KNOWLEDGE_REPO_REFRESH_HOURS * 3600.0)
    while True:
        try:
            await _do_reindex()
        except Exception as e:
            log.exception("knowledge background tick crashed: %s", e)
        try:
            await asyncio.sleep(interval_sec)
        except asyncio.CancelledError:
            log.info("knowledge background loop cancelled")
            return


def start_background_refresh() -> None:
    """Mount the background task. Idempotent — calling twice is a no-op.
    Always logs the effective config at INFO so operators can see at a
    glance whether the service is wired up (the legacy ekc_knowledge_
    service emits separate "index not found" warnings that look related
    but aren't — those are filesystem-based and unrelated to this
    GitLab-mirroring service)."""
    global _refresh_task
    if not KNOWLEDGE_REPO_PROJECT:
        log.warning(
            "knowledge_repo: NOT CONFIGURED — GITLAB_TECH_KB_REPO and "
            "KNOWLEDGE_REPO_PROJECT are both empty. Background loop will "
            "no-op. Set GITLAB_TECH_KB_REPO=<group>/<repo> in .env to "
            "enable the always-on knowledge grounding layer."
        )
    else:
        log.info(
            "knowledge_repo: CONFIGURED project=%s branch=%s "
            "collection=%s refresh_every_hours=%.1f embeddings=%s qdrant=%s",
            KNOWLEDGE_REPO_PROJECT, KNOWLEDGE_REPO_BRANCH,
            KNOWLEDGE_REPO_COLLECTION, KNOWLEDGE_REPO_REFRESH_HOURS,
            EMBEDDINGS_URL, QDRANT_URL,
        )
    if _refresh_task is not None and not _refresh_task.done():
        return
    _refresh_task = asyncio.create_task(_background_loop(),
                                         name="knowledge_repo_refresh")
    log.info("knowledge_repo: background refresh task started")


def stop_background_refresh() -> None:
    global _refresh_task
    if _refresh_task is not None and not _refresh_task.done():
        _refresh_task.cancel()
    _refresh_task = None


async def reindex_now() -> Dict[str, Any]:
    """Admin/debug entry point — kicks off an immediate reindex and
    returns the stats. Doesn't compete with the background loop because
    Qdrant upserts are idempotent on stable IDs."""
    if not KNOWLEDGE_REPO_PROJECT:
        return {"error": "KNOWLEDGE_REPO_PROJECT not configured",
                "configured": False}
    stats = await _do_reindex()
    return {
        "configured": True,
        "project": KNOWLEDGE_REPO_PROJECT,
        "branch": KNOWLEDGE_REPO_BRANCH,
        "collection": KNOWLEDGE_REPO_COLLECTION,
        "files": stats.files,
        "chunks": stats.chunks,
        "embedded": stats.embedded,
        "upserted": stats.upserted,
        "pruned": stats.pruned,
        "errors": stats.errors,
    }


async def retrieve(query: str,
                    top_k: int = 5,
                    score_threshold: Optional[float] = 0.15,
                    ) -> List[Dict[str, Any]]:
    """Top-K knowledge-repo passages for a query. Returns [] silently
    when the service isn't configured / hasn't indexed yet / qdrant is
    down — callers should treat empty as "no grounding available" and
    proceed with whatever other sources they have."""
    if not KNOWLEDGE_REPO_PROJECT or not _ready:
        return []
    if not query or not query.strip():
        return []
    vec = await _embed_one(query)
    if vec is None:
        return []
    try:
        hits = _qclient().search(
            collection_name=KNOWLEDGE_REPO_COLLECTION,
            query_vector=vec,
            limit=top_k,
            score_threshold=score_threshold,
            with_payload=True,
        )
    except Exception as e:
        log.warning("knowledge search failed: %s", e)
        return []
    return [{
        "score": float(h.score),
        "text": (h.payload or {}).get("text", ""),
        "source_file": (h.payload or {}).get("source_file"),
        "section_path": (h.payload or {}).get("section_path"),
        "repo": (h.payload or {}).get("repo"),
        "branch": (h.payload or {}).get("branch"),
    } for h in hits]


def is_ready() -> bool:
    """True iff at least one successful reindex has populated the
    collection. CoT plans can call this to decide whether to wait or
    proceed without knowledge grounding for the very first request
    after cold start."""
    return _ready and bool(KNOWLEDGE_REPO_PROJECT)


def status() -> Dict[str, Any]:
    """Diagnostic snapshot for the /knowledge/status admin endpoint."""
    return {
        "configured": bool(KNOWLEDGE_REPO_PROJECT),
        "project": KNOWLEDGE_REPO_PROJECT or None,
        "branch": KNOWLEDGE_REPO_BRANCH,
        "collection": KNOWLEDGE_REPO_COLLECTION,
        "refresh_hours": KNOWLEDGE_REPO_REFRESH_HOURS,
        "ready": _ready,
        "background_task_running": bool(
            _refresh_task is not None and not _refresh_task.done()
        ),
        "indexed_chunk_count": len(_last_indexed_ids),
    }
