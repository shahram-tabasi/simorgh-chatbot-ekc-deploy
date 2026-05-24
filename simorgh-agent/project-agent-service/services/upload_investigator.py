"""Upload investigator — hierarchical MapReduce for large uploads.

When a user uploads a document and asks a question, the
UploadDeepPlan needs to feed the planner relevant passages from it.
Small files (<200K chars by default) can be read inline by the
planner via doc-processor. Large files need MapReduce:

  1. EXTRACT — doc-processor converts the binary to markdown.
  2. CHUNK   — heading/section-aware splitter (same chunker as
                knowledge_repo_service for consistency).
  3. EMBED   — vectors stored in a per-upload ephemeral Qdrant
                collection (`upload_<upload_id>`) so we can do
                semantic retrieval against just THIS upload.
  4. MAP     — for each top-K chunk relevant to the user's
                question, write a leaf-summary that quotes the
                most relevant lines verbatim and adds a one-line
                relevance gloss. Per-chunk LLM call (cheap; small
                input).
  5. REDUCE  — CoT-augmented merge: take the leaf summaries plus
                the user's question and produce a structured
                section-by-section answer with [U1]…[Un] citations
                pointing back to chunk indices.

Why MapReduce vs single-pass long-context? Two reasons backed by
2026 research:
  - Hallucination amplification — recursive merging blows up
    fabrication risk; per-chunk leaf-summaries with explicit
    "quote verbatim" constraint pins each fact to a source line.
  - Context-window economics — 500K-char specs blow past gpt-oss-
    20b's effective context; chunking lets us stay in the model's
    sweet spot at every step.

The pipeline is callable from UploadDeepPlan.gather_grounding via:
  passages = await investigate(upload_id, question, top_k=8)
which returns PlanGrounding-compatible blocks.

Lifecycle of the ephemeral collection:
  - Created on first investigate() call for a given upload_id.
  - Reused for the duration of the chat session (no re-embed on
    follow-up questions about the same upload).
  - Best-effort dropped when the parent session is deleted —
    delete_session in project_chat_session.py will gain a hook
    in Phase 5; for now it accumulates and the cleanup script
    can prune `upload_*` collections older than N days.

Env knobs:
  KNOWLEDGE_UPLOAD_MAPREDUCE_THRESHOLD  big-doc cutoff (default 200_000)
  KNOWLEDGE_UPLOAD_CHUNK_CHARS          default 1800
  KNOWLEDGE_UPLOAD_CHUNK_OVERLAP        default 200
  KNOWLEDGE_UPLOAD_LEAF_TOP_K           default 8
  KNOWLEDGE_UPLOAD_LEAF_SUMMARY_TOKENS  default 350
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import httpx
from qdrant_client import QdrantClient
from qdrant_client.http import models as qmodels

log = logging.getLogger("upload_investigator")

# ---- config --------------------------------------------------------
DOC_PROCESSOR_URL  = os.getenv("DOC_PROCESSOR_URL", "http://doc-processor:8000")
EMBEDDINGS_URL     = os.getenv("EMBEDDINGS_URL", "http://embeddings-service:8031")
QDRANT_URL         = os.getenv("QDRANT_URL", "http://qdrant:6333")
LLM_GATEWAY_URL    = os.getenv("LLM_GATEWAY_URL", "http://llm-gateway:8030")

MAPREDUCE_THRESHOLD = int(os.getenv("KNOWLEDGE_UPLOAD_MAPREDUCE_THRESHOLD", "200000"))
CHUNK_CHAR_SIZE     = int(os.getenv("KNOWLEDGE_UPLOAD_CHUNK_CHARS", "1800"))
CHUNK_CHAR_OVERLAP  = int(os.getenv("KNOWLEDGE_UPLOAD_CHUNK_OVERLAP", "200"))
LEAF_TOP_K          = int(os.getenv("KNOWLEDGE_UPLOAD_LEAF_TOP_K", "8"))
LEAF_SUMMARY_TOKENS = int(os.getenv("KNOWLEDGE_UPLOAD_LEAF_SUMMARY_TOKENS", "350"))

# ---- module state --------------------------------------------------
_qdrant: Optional[QdrantClient] = None
# upload_id -> set of chunk-ids we know are already embedded.
# Lets follow-up questions skip the extract/embed step.
_indexed_uploads: Dict[str, int] = {}


def _qclient() -> QdrantClient:
    global _qdrant
    if _qdrant is None:
        _qdrant = QdrantClient(url=QDRANT_URL, timeout=30.0)
    return _qdrant


def _collection_name(upload_id: str) -> str:
    """Per-upload ephemeral collection. Hashed to keep the name short
    + alphanumeric (Qdrant collection names are stricter than UUIDs)."""
    h = hashlib.sha1(upload_id.encode("utf-8")).hexdigest()[:16]
    return f"upload_{h}"


# ---------------------------------------------------------------------------
# Chunker — same shape as knowledge_repo_service for consistency. Trimmed
# duplicate; if a third consumer ever appears we should extract to /shared/.
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
                "heading_path": [d for _, d, _ in stack],
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
# Pipeline steps
# ---------------------------------------------------------------------------
async def _extract_to_markdown(upload_path_or_bytes: Any,
                                filename: str) -> str:
    """Call doc-processor /process with raw bytes; returns markdown."""
    if isinstance(upload_path_or_bytes, (bytes, bytearray)):
        raw = bytes(upload_path_or_bytes)
    else:
        with open(upload_path_or_bytes, "rb") as f:
            raw = f.read()
    async with httpx.AsyncClient(timeout=300.0) as c:
        files = {"file": (filename, raw, "application/octet-stream")}
        r = await c.post(f"{DOC_PROCESSOR_URL}/process", files=files, timeout=300.0)
        r.raise_for_status()
        return (r.json() or {}).get("content") or ""


async def _embed_batch(texts: List[str],
                        client: httpx.AsyncClient) -> List[Optional[List[float]]]:
    if not texts:
        return []
    try:
        r = await client.post(
            f"{EMBEDDINGS_URL}/embeddings/batch",
            json={"texts": texts}, timeout=120.0,
        )
        r.raise_for_status()
        return r.json().get("embeddings", [])
    except Exception as e:
        log.warning("upload batch embed failed: %s; per-text fallback", e)
    out: List[Optional[List[float]]] = []
    for t in texts:
        try:
            r = await client.post(f"{EMBEDDINGS_URL}/embeddings",
                                   json={"text": t}, timeout=30.0)
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
            log.warning("upload query embed failed: %s", e)
            return None


def _ensure_collection(name: str, dim: int) -> None:
    client = _qclient()
    try:
        existing = client.get_collection(name)
        if existing.config.params.vectors.size != dim:
            log.error("upload coll %s dim mismatch existing=%d new=%d",
                       name, existing.config.params.vectors.size, dim)
        return
    except Exception:
        pass
    client.create_collection(
        collection_name=name,
        vectors_config=qmodels.VectorParams(size=dim, distance=qmodels.Distance.COSINE),
    )


async def _index_upload(upload_id: str,
                         markdown: str,
                         filename: str) -> int:
    """Chunk + embed + upsert. Idempotent — stable UUID5s mean re-runs
    update in place. Returns the chunk count."""
    chunks = _chunk_markdown(markdown)
    if not chunks:
        return 0
    coll = _collection_name(upload_id)
    points: List[qmodels.PointStruct] = []
    async with httpx.AsyncClient(timeout=180.0) as client:
        BATCH = 32
        dim: Optional[int] = None
        for i in range(0, len(chunks), BATCH):
            batch = chunks[i:i + BATCH]
            vecs = await _embed_batch([c["text"] for c in batch], client)
            for j, (c, v) in enumerate(zip(batch, vecs)):
                if v is None:
                    continue
                if dim is None:
                    dim = len(v)
                    _ensure_collection(coll, dim)
                idx = i + j
                points.append(qmodels.PointStruct(
                    id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"upload::{upload_id}::{idx}")),
                    vector=v,
                    payload={
                        "text": c["text"],
                        "section_path": c["section_path"],
                        "heading_path": c["heading_path"],
                        "filename": filename,
                        "chunk_idx": idx,
                    },
                ))
    if not points:
        return 0
    UP_BATCH = 200
    for i in range(0, len(points), UP_BATCH):
        try:
            _qclient().upsert(collection_name=coll,
                               points=points[i:i + UP_BATCH], wait=True)
        except Exception as e:
            log.exception("upload upsert failed offset=%d err=%s", i, e)
    _indexed_uploads[upload_id] = len(points)
    log.info("upload indexed id=%s file=%s chunks=%d",
              upload_id, filename, len(points))
    return len(points)


async def _retrieve_top_k(upload_id: str, question: str,
                            top_k: int) -> List[Dict[str, Any]]:
    coll = _collection_name(upload_id)
    vec = await _embed_one(question)
    if vec is None:
        return []
    try:
        hits = _qclient().search(
            collection_name=coll, query_vector=vec,
            limit=top_k, with_payload=True,
        )
    except Exception as e:
        log.warning("upload retrieve failed coll=%s err=%s", coll, e)
        return []
    return [{
        "score": float(h.score),
        "text": (h.payload or {}).get("text", ""),
        "section_path": (h.payload or {}).get("section_path"),
        "filename": (h.payload or {}).get("filename"),
        "chunk_idx": (h.payload or {}).get("chunk_idx"),
    } for h in hits]


async def _leaf_summarize(question: str, chunk: Dict[str, Any]) -> str:
    """Per-chunk MAP step. The LLM gets the chunk + the user question
    and writes one short paragraph: quoted relevant lines + one-line
    relevance gloss. Output goes into the REDUCE step's input.

    Single offline_text gateway call per chunk; the whole MAP step
    parallelises via asyncio.gather in investigate()."""
    sys = (
        "You are a careful technical reader. Given ONE excerpt from a larger "
        "document and the user's question, produce a short summary in this "
        "EXACT format:\n"
        "  QUOTE: \"<the most relevant verbatim line(s), max 280 chars>\"\n"
        "  WHY:   <one sentence on why this answers / partially answers the question>\n"
        "If the excerpt has nothing relevant, output literally: NOT_RELEVANT\n"
        "Never paraphrase the QUOTE — copy text verbatim from the excerpt."
    )
    section = chunk.get("section_path") or "(no heading)"
    user = (
        f"User question: {question}\n\n"
        f"Excerpt source: {chunk.get('filename')} > {section} "
        f"(chunk #{chunk.get('chunk_idx')})\n\n"
        f"Excerpt:\n{chunk.get('text', '')}"
    )
    try:
        async with httpx.AsyncClient(timeout=60.0) as c:
            r = await c.post(
                f"{LLM_GATEWAY_URL}/generate",
                json={
                    "messages": [
                        {"role": "system", "content": sys},
                        {"role": "user", "content": user},
                    ],
                    "mode": "offline",
                    "force_backend": "text",
                    "temperature": 0.1,
                    "max_tokens": LEAF_SUMMARY_TOKENS,
                },
                timeout=60.0,
            )
            r.raise_for_status()
            body = r.json() or {}
            return (body.get("response") or body.get("content") or "").strip()
    except Exception as e:
        log.warning("leaf summarize failed chunk=%s err=%s",
                     chunk.get("chunk_idx"), e)
        return ""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
@dataclass
class InvestigationResult:
    blocks: List[Dict[str, Any]]   # PlanGrounding-compatible blocks
    method: str                      # "mapreduce" | "inline" | "skipped"
    chunk_count: int
    leaves_kept: int


async def ensure_indexed(upload_id: str,
                          markdown: Optional[str] = None,
                          raw: Optional[bytes] = None,
                          filename: str = "upload") -> int:
    """Idempotent extract+chunk+embed for an upload. Pass markdown if
    you already have it (faster), or raw bytes (will call doc-processor).
    Returns chunk count. Cached per upload_id."""
    if upload_id in _indexed_uploads:
        return _indexed_uploads[upload_id]
    if markdown is None and raw is None:
        raise ValueError("ensure_indexed requires markdown or raw")
    if markdown is None:
        markdown = await _extract_to_markdown(raw, filename)
    return await _index_upload(upload_id, markdown or "", filename)


async def investigate(upload_id: str,
                       question: str,
                       upload_size_chars: int = 0,
                       top_k: int = LEAF_TOP_K,
                       markdown: Optional[str] = None,
                       raw: Optional[bytes] = None,
                       filename: str = "upload") -> InvestigationResult:
    """Main entry. Decides inline vs MapReduce based on
    upload_size_chars vs MAPREDUCE_THRESHOLD, then either:
      INLINE:    returns the upload text as a single grounding block
                  (no per-chunk LLM calls — fast for small files).
      MAPREDUCE: extract → chunk → embed → top-K retrieve → leaf-
                  summarize each top-K chunk in parallel → return
                  the surviving leaves as grounding blocks.

    Returns InvestigationResult with PlanGrounding-shape blocks
    that UploadDeepPlan.gather_grounding can splice into its
    bundle. method="skipped" when neither markdown nor raw was
    supplied; the plan should degrade to "ask the planner to read
    via doc-processor" in that case."""
    if not question or not question.strip():
        return InvestigationResult(blocks=[], method="skipped",
                                    chunk_count=0, leaves_kept=0)

    # Inline path — small upload, no need for MapReduce overhead.
    if upload_size_chars and upload_size_chars <= MAPREDUCE_THRESHOLD:
        if markdown is None and raw is not None:
            try:
                markdown = await _extract_to_markdown(raw, filename)
            except Exception as e:
                log.warning("investigate inline extract failed: %s", e)
                markdown = None
        if not markdown:
            return InvestigationResult(blocks=[], method="skipped",
                                        chunk_count=0, leaves_kept=0)
        # One big block; the planner will read it inline.
        return InvestigationResult(
            blocks=[{
                "text": markdown[:18000],   # ~6K tokens upper bound
                "source": filename,
                "section": "(full inline)",
                "score": 1.0,
                "origin": "upload",
            }],
            method="inline",
            chunk_count=1,
            leaves_kept=1,
        )

    # MapReduce path. Ensure the upload is indexed (idempotent), do
    # top-K vector retrieval, leaf-summarize each survivor in parallel.
    try:
        await ensure_indexed(upload_id, markdown=markdown, raw=raw,
                              filename=filename)
    except Exception as e:
        log.warning("investigate index failed upload_id=%s err=%s", upload_id, e)
        return InvestigationResult(blocks=[], method="skipped",
                                    chunk_count=0, leaves_kept=0)

    top = await _retrieve_top_k(upload_id, question, top_k)
    if not top:
        return InvestigationResult(blocks=[], method="mapreduce",
                                    chunk_count=_indexed_uploads.get(upload_id, 0),
                                    leaves_kept=0)

    # Parallel MAP step.
    leaves = await asyncio.gather(
        *[_leaf_summarize(question, c) for c in top],
        return_exceptions=False,
    )
    blocks: List[Dict[str, Any]] = []
    kept = 0
    for c, leaf in zip(top, leaves):
        text = (leaf or "").strip()
        if not text or text == "NOT_RELEVANT":
            continue
        kept += 1
        blocks.append({
            "text": text,
            "source": c.get("filename") or "upload",
            "section": f"{c.get('section_path') or '?'} (chunk #{c.get('chunk_idx')})",
            "score": c.get("score"),
            "origin": "upload",
        })
    return InvestigationResult(
        blocks=blocks,
        method="mapreduce",
        chunk_count=_indexed_uploads.get(upload_id, 0),
        leaves_kept=kept,
    )


def drop_upload(upload_id: str) -> bool:
    """Best-effort delete of an upload's ephemeral collection.
    Called by the session-delete hook (Phase 5)."""
    coll = _collection_name(upload_id)
    try:
        _qclient().delete_collection(coll)
        _indexed_uploads.pop(upload_id, None)
        return True
    except Exception as e:
        log.warning("drop_upload failed id=%s coll=%s err=%s",
                     upload_id, coll, e)
        return False
