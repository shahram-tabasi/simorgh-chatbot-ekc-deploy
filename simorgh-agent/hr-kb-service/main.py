"""
HR / Organization Knowledge Base Service
========================================
Owns the **organization general knowledge** corpus: HR policies, monthly
holidays documents, corporate-loan rules, hiring period announcements,
and the strategic vision / mission / values from human-capital/* repos.

Three ways to add content:

1. **GitLab ingest (primary)** — POST /reindex pulls every project in the
   `human-capital/` GitLab group via gitlab-mcp, walks each tree, reads
   docx/PDF/text via read_artifact_mcp (auto-converted to markdown by
   doc-processor), chunks structurally (markdown headings, table rows,
   2 KB overlapping windows), embeds via embeddings-service, and upserts
   into the Qdrant collection named by HR_KB_COLLECTION (default
   "hr_general_kb"). Idempotent — re-running upserts on
   (source_project, source_file, chunk_idx). Per-project category is
   derived from the project slug: organizational-strategy-* → org_strategy,
   anything else under human-capital/* → hr_manner.

2. **Filesystem drop** — drop a file into HR_DOCS_PATH (default
   /app/hr_docs). The watcher picks it up, normalises through
   doc-processor, and indexes with category="fs_drop". Useful for one-off
   HR memos that aren't in GitLab.

3. **REST /upload** — multipart admin upload. Same pipeline as #2.

Search:
  search_hr_kb(query, top_k=5, category?) — chat-service queries this over
  MCP during a *general* session. Optional category filter narrows to one
  of {hr_manner, org_strategy, fs_drop}; omit to search everything.
  Returns top-K passages with rich citation metadata (source_project,
  source_file, parent_heading, section_path, category) so the chat layer
  can render "From: <file>" badges and the grounded LLM can quote.

Per the agreed convention "AI/COT uses MCP, others use REST", this
service exposes BOTH:
  * REST /reindex, /upload, /list, /delete, /search
  * MCP /mcp tools: search_hr_kb, list_hr_docs

Sources of truth:
  - GitLab projects under group `human-capital/` (primary corpus)
  - Raw filesystem drops: HR_DOCS_PATH bind volume
  - Vectors: Qdrant collection HR_KB_COLLECTION ("hr_general_kb")

This service does NOT call the LLM directly — embedding generation goes
to embeddings-service, conversion goes to doc-processor (via gitlab-mcp's
read_artifact_mcp for GitLab content, or directly for filesystem drops).
"""
import asyncio
import hashlib
import logging
import os
import re
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from mcp.server.fastmcp import FastMCP
from qdrant_client import QdrantClient
from qdrant_client.http import models as qmodels

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("hr-kb-service")

HR_DOCS_PATH         = Path(os.getenv("HR_DOCS_PATH", "/app/hr_docs"))
HR_KB_COLLECTION     = os.getenv("HR_KB_COLLECTION", "hr_general_kb")
HR_KB_GITLAB_GROUP   = os.getenv("HR_KB_GITLAB_GROUP", "human-capital")
DOC_PROCESSOR_URL    = os.getenv("DOC_PROCESSOR_URL", "http://doc-processor:8000")
EMBEDDINGS_URL       = os.getenv("EMBEDDINGS_URL", "http://embeddings:8037")
QDRANT_URL           = os.getenv("QDRANT_URL", "http://qdrant:6333")
GITLAB_MCP_URL       = os.getenv("GITLAB_MCP_URL", "http://gitlab-mcp:8047")
WATCH_INTERVAL_SEC   = int(os.getenv("HR_DOCS_WATCH_INTERVAL", "30"))

# Embedding dimension is discovered lazily on first ensure_collection call
# so a misconfigured embeddings-service doesn't crash service startup.
EMBED_DIMS_FALLBACK  = int(os.getenv("HR_KB_EMBED_DIMS", "384"))  # all-MiniLM-L6-v2

# Chunking knobs. 2000 chars ≈ ~500 tokens, comfortably inside the
# embeddings model's 512-token context. Overlap preserves cross-sentence
# context at the chunk boundary so retrieval doesn't lose mid-paragraph
# answers.
CHUNK_CHAR_SIZE      = int(os.getenv("HR_KB_CHUNK_CHARS", "2000"))
CHUNK_CHAR_OVERLAP   = int(os.getenv("HR_KB_CHUNK_OVERLAP", "200"))


_qdrant: Optional[QdrantClient] = None
_embed_dims: Optional[int] = None


def _qdrant_client() -> QdrantClient:
    global _qdrant
    if _qdrant is None:
        _qdrant = QdrantClient(url=QDRANT_URL, timeout=30.0)
    return _qdrant


async def _embed_one(text: str) -> Optional[List[float]]:
    """Single-text embedding via embeddings-service. Returns None on failure
    (caller should skip the chunk rather than crashing the whole reindex)."""
    if not text or not text.strip():
        return None
    try:
        async with httpx.AsyncClient(timeout=30.0) as c:
            r = await c.post(f"{EMBEDDINGS_URL}/embeddings", json={"text": text})
            r.raise_for_status()
            return r.json().get("embedding")
    except Exception as e:
        logger.warning("embed_failed text_len=%d err=%s", len(text), e)
        return None


async def _embed_batch(texts: List[str]) -> List[Optional[List[float]]]:
    """Batch embedding. Falls back to per-text on error so a single bad
    chunk doesn't tank the rest of the batch."""
    if not texts:
        return []
    try:
        async with httpx.AsyncClient(timeout=60.0) as c:
            r = await c.post(
                f"{EMBEDDINGS_URL}/embeddings/batch",
                json={"texts": texts}, timeout=60.0,
            )
            r.raise_for_status()
            return r.json().get("embeddings", [])
    except Exception as e:
        logger.warning("embed_batch_failed n=%d err=%s; falling back to per-text",
                       len(texts), e)
        out: List[Optional[List[float]]] = []
        for t in texts:
            out.append(await _embed_one(t))
        return out


def _ensure_collection(dim: int) -> None:
    """Create the Qdrant collection on first use. Idempotent: skips
    creation when the collection already exists; logs (does not raise)
    on a dimension mismatch so the operator can fix it manually rather
    than the service refusing to start."""
    client = _qdrant_client()
    try:
        existing = client.get_collection(HR_KB_COLLECTION)
        cur_dim = existing.config.params.vectors.size
        if cur_dim != dim:
            logger.warning(
                "qdrant_collection_dim_mismatch existing=%d new=%d "
                "(reindex aborted; drop collection or set HR_KB_EMBED_DIMS=%d)",
                cur_dim, dim, cur_dim,
            )
        return
    except Exception:
        # get_collection raises when the collection doesn't exist; create it.
        pass
    client.create_collection(
        collection_name=HR_KB_COLLECTION,
        vectors_config=qmodels.VectorParams(
            size=dim, distance=qmodels.Distance.COSINE,
        ),
    )
    # Payload indexes on the fields we filter by, so category /
    # source_project queries don't do a full collection scan.
    for field in ("category", "source_project", "source_file"):
        try:
            client.create_payload_index(
                collection_name=HR_KB_COLLECTION,
                field_name=field,
                field_schema=qmodels.PayloadSchemaType.KEYWORD,
            )
        except Exception as e:
            logger.warning("payload_index_failed field=%s err=%s", field, e)


# ---------------------------------------------------------------------------
# Chunker — structural, no LLM
# ---------------------------------------------------------------------------
_HEADING_RE   = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)
_TABLE_ROW_RE = re.compile(r"^\s*\|.*\|\s*$", re.MULTILINE)


def _split_into_sections(markdown: str) -> List[Dict[str, Any]]:
    """Walk the markdown, returning a list of {heading_path, body} sections.

    Heading_path is the chain of parent headings as a list, so the chunker
    can preserve "this is section 3.2.1" context in the chunk metadata.
    Sections without a heading get heading_path=[]; sections under a
    deeper heading inherit the path of the most recent shallower one.
    """
    if not markdown:
        return []
    lines = markdown.split("\n")
    sections: List[Dict[str, Any]] = []
    stack: List[tuple[int, str]] = []  # (level, heading_text)
    buffer: List[str] = []

    def flush():
        if not buffer:
            return
        body = "\n".join(buffer).strip()
        if body:
            sections.append({
                "heading_path": [h for _, h in stack],
                "body": body,
            })
        buffer.clear()

    for ln in lines:
        m = _HEADING_RE.match(ln)
        if m:
            flush()
            level = len(m.group(1))
            text = m.group(2).strip()
            # Drop deeper-or-equal headings off the stack so nested
            # headings reflect the current depth.
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, text))
            continue
        buffer.append(ln)
    flush()
    return sections


def _split_long_body(body: str) -> List[str]:
    """Window split for bodies that exceed CHUNK_CHAR_SIZE. Tries to break
    on \\n\\n / ". " / \\n / space in the last 25% of the window; falls
    back to a hard cut. Same shape as the Phase 1 project chunker."""
    n = len(body)
    if n <= CHUNK_CHAR_SIZE:
        return [body]
    out: List[str] = []
    i = 0
    while i < n:
        end = min(i + CHUNK_CHAR_SIZE, n)
        if end < n:
            search_from = max(i + int(CHUNK_CHAR_SIZE * 0.75), i + 1)
            for sep in ("\n\n", ". ", "\n", " "):
                cut = body.rfind(sep, search_from, end)
                if cut != -1:
                    end = cut + len(sep)
                    break
        out.append(body[i:end])
        if end >= n:
            break
        i = max(end - CHUNK_CHAR_OVERLAP, i + 1)
    return out


def _extract_table_rows(body: str) -> List[str]:
    """Pull individual table rows as discrete chunks. Each row becomes its
    own search hit so a single matching cell doesn't drag the whole table
    into context. Returns empty list when the body has no tables."""
    rows = _TABLE_ROW_RE.findall(body)
    if len(rows) < 2:
        # A "table" with one row is almost always not a table; skip.
        return []
    # Drop separator rows (|---|---|).
    return [r.strip() for r in rows
            if not re.match(r"^\s*\|[-:|\s]+\|\s*$", r)]


def chunk_markdown(markdown: str) -> List[Dict[str, Any]]:
    """Structural chunker. Output: list of {text, chunk_type, heading_path}.

    chunk_type ∈ {section, table_row, window}:
      • section    — a whole heading-bounded section that fits in one chunk
      • table_row  — one row of a markdown table (own search unit)
      • window     — a slice of a section that was too long for one chunk
    """
    out: List[Dict[str, Any]] = []
    for sec in _split_into_sections(markdown):
        heading_path = sec["heading_path"]
        body = sec["body"]
        if not body:
            continue
        # Extract table rows first; if there are any, the section's body
        # becomes (heading prose) + (rows-as-individual-chunks).
        rows = _extract_table_rows(body)
        # The non-table body is what remains after stripping table rows.
        if rows:
            non_table_body = re.sub(_TABLE_ROW_RE, "", body).strip()
            if non_table_body:
                for w in _split_long_body(non_table_body):
                    out.append({
                        "text": w,
                        "chunk_type": "window" if len(non_table_body) > CHUNK_CHAR_SIZE
                                      else "section",
                        "heading_path": heading_path,
                    })
            for r in rows:
                out.append({
                    "text": r,
                    "chunk_type": "table_row",
                    "heading_path": heading_path,
                })
        else:
            for w in _split_long_body(body):
                out.append({
                    "text": w,
                    "chunk_type": "window" if len(body) > CHUNK_CHAR_SIZE
                                  else "section",
                    "heading_path": heading_path,
                })
    return out


def _category_for_project(project_path: str) -> str:
    """Map a GitLab project path to a KB category.

    `human-capital/organizational-strategy-values` → org_strategy
    `human-capital/hr-operations-manual`           → hr_manner
    `human-capital/<anything else>`                → hr_manner
      (default: HR ops covers most policy / procedure content)
    """
    last = project_path.rsplit("/", 1)[-1].lower()
    if "strateg" in last or "vision" in last or "values" in last:
        return "org_strategy"
    return "hr_manner"


# ---------------------------------------------------------------------------
# GitLab ingest — primary corpus
# ---------------------------------------------------------------------------
async def _list_human_capital_projects() -> List[Dict[str, Any]]:
    """Enumerate every project in the human-capital group via gitlab-mcp."""
    async with httpx.AsyncClient(timeout=30.0) as c:
        r = await c.get(f"{GITLAB_MCP_URL}/projects",
                        params={"group": HR_KB_GITLAB_GROUP})
        r.raise_for_status()
        data = r.json()
    return data if isinstance(data, list) else data.get("projects", [])


async def _list_project_files(project_path: str,
                               client: httpx.AsyncClient) -> List[str]:
    r = await client.get(
        f"{GITLAB_MCP_URL}/tree",
        params={"project": project_path, "ref": "main", "recursive": True},
    )
    r.raise_for_status()
    entries = r.json().get("entries", []) or []
    return [
        e["path"] for e in entries
        if isinstance(e, dict)
        and e.get("type") in (None, "blob")
        and e.get("path")
        # Skip the auto-extracted sidecars — read_artifact_mcp on the source
        # file already returns the extracted markdown, including the sidecar
        # would double-index.
        and not e["path"].startswith(".simorgh/")
        and not e["path"].startswith(".git/")
    ]


async def _read_artifact(project_path: str, file_path: str,
                          client: httpx.AsyncClient) -> Optional[str]:
    """Fetch the file's markdown representation via gitlab-mcp's
    /artifact endpoint (type-aware: PDFs / docx / images all become
    markdown via doc-processor). Returns None if the read fails or the
    content is empty."""
    try:
        r = await client.get(
            f"{GITLAB_MCP_URL}/artifact",
            params={"project": project_path, "path": file_path, "ref": "main"},
            timeout=180.0,
        )
        r.raise_for_status()
        body = r.json()
        return body.get("content") or None
    except Exception as e:
        logger.warning("artifact_read_failed project=%s path=%s err=%s",
                       project_path, file_path, e)
        return None


def _chunk_id(project_path: str, file_path: str, chunk_idx: int) -> str:
    """Stable UUID5 keyed on (project, path, chunk_idx) so reindex upserts."""
    name = f"{project_path}::{file_path}::{chunk_idx}"
    return str(uuid.uuid5(uuid.NAMESPACE_URL, name))


async def _index_project(project: Dict[str, Any]) -> Dict[str, int]:
    """Ingest one human-capital project. Returns per-project stats."""
    project_path = project.get("path") or project.get("path_with_namespace")
    if not project_path:
        return {"skipped": 1}
    category = _category_for_project(project_path)
    project_name = project.get("name") or project_path

    stats = {"files": 0, "chunks": 0, "embedded": 0, "upserted": 0,
             "skipped": 0, "errors": 0}

    async with httpx.AsyncClient(timeout=180.0) as client:
        try:
            files = await _list_project_files(project_path, client)
        except Exception as e:
            logger.warning("tree_failed project=%s err=%s", project_path, e)
            return {**stats, "errors": stats["errors"] + 1}

        all_chunks: List[Dict[str, Any]] = []
        for file_path in files:
            stats["files"] += 1
            markdown = await _read_artifact(project_path, file_path, client)
            if not markdown:
                stats["skipped"] += 1
                continue
            try:
                chunks = chunk_markdown(markdown)
            except Exception as e:
                logger.warning("chunk_failed project=%s path=%s err=%s",
                               project_path, file_path, e)
                stats["errors"] += 1
                continue
            for idx, ch in enumerate(chunks):
                all_chunks.append({
                    "id": _chunk_id(project_path, file_path, idx),
                    "text": ch["text"],
                    "chunk_type": ch["chunk_type"],
                    "heading_path": ch["heading_path"],
                    "source_project": project_path,
                    "source_project_name": project_name,
                    "source_file": file_path,
                    "category": category,
                    "chunk_idx": idx,
                })
        stats["chunks"] = len(all_chunks)

    if not all_chunks:
        return stats

    # Embed in batches of 32 so a slow embeddings-service doesn't time out.
    points: List[qmodels.PointStruct] = []
    BATCH = 32
    for i in range(0, len(all_chunks), BATCH):
        batch = all_chunks[i:i + BATCH]
        vecs = await _embed_batch([c["text"] for c in batch])
        for ch, v in zip(batch, vecs):
            if v is None:
                continue
            stats["embedded"] += 1
            points.append(qmodels.PointStruct(
                id=ch["id"],
                vector=v,
                payload={
                    "text": ch["text"],
                    "chunk_type": ch["chunk_type"],
                    "heading_path": ch["heading_path"],
                    "section_path": " > ".join(ch["heading_path"]),
                    "source_project": ch["source_project"],
                    "source_project_name": ch["source_project_name"],
                    "source_file": ch["source_file"],
                    "category": ch["category"],
                    "chunk_idx": ch["chunk_idx"],
                },
            ))
        # Discover embed dim once per reindex.
        global _embed_dims
        if _embed_dims is None and points:
            _embed_dims = len(points[0].vector)
            _ensure_collection(_embed_dims)

    if points:
        try:
            _qdrant_client().upsert(
                collection_name=HR_KB_COLLECTION,
                points=points, wait=True,
            )
            stats["upserted"] = len(points)
        except Exception as e:
            logger.exception("qdrant_upsert_failed project=%s err=%s",
                             project_path, e)
            stats["errors"] += 1

    logger.info("indexed project=%s category=%s stats=%s",
                project_path, category, stats)
    return stats


async def reindex_all() -> Dict[str, Any]:
    """Pull every human-capital/* project and reindex. Returns a per-project
    summary that the admin can read in the /reindex response."""
    try:
        projects = await _list_human_capital_projects()
    except Exception as e:
        logger.exception("list_projects_failed")
        raise HTTPException(status_code=502,
                            detail=f"gitlab-mcp /projects failed: {e}")
    results: Dict[str, Dict[str, int]] = {}
    totals = {"files": 0, "chunks": 0, "embedded": 0, "upserted": 0,
              "skipped": 0, "errors": 0}
    for p in projects:
        stats = await _index_project(p)
        path = p.get("path") or p.get("path_with_namespace") or "?"
        results[path] = stats
        for k in totals:
            totals[k] += stats.get(k, 0)
    logger.info("reindex_done totals=%s projects=%d", totals, len(results))
    return {"projects": results, "totals": totals,
            "collection": HR_KB_COLLECTION}


# ---------------------------------------------------------------------------
# Filesystem path — legacy drop-in for one-off HR memos
# ---------------------------------------------------------------------------
def doc_id(path: Path) -> str:
    """Stable doc_id derived from filename so re-uploads replace cleanly."""
    return hashlib.sha1(path.name.encode("utf-8")).hexdigest()[:16]


async def index_file(path: Path, category: Optional[str] = None,
                      source_label: str = "fs_drop") -> Dict[str, Any]:
    """Index a filesystem-dropped file. Uses doc-processor directly.
    Synthesises a single 'project' record so it lands in Qdrant with the
    same payload shape as GitLab content.

    `category` defaults to whatever ``_category_for_path(path)`` returns
    so the watcher / reindex driver gets directory-aware classification
    out of the box (Human Capital/HR Operations Manual/* → hr_manner,
    Human Capital/Organizational Strategy Values/* → org_strategy).
    Pass `category="fs_drop"` for ad-hoc files where the directory
    structure shouldn't influence the category.
    """
    if category is None:
        category = _category_for_path(path)
    try:
        with path.open("rb") as f:
            raw = f.read()
        async with httpx.AsyncClient(timeout=180.0) as c:
            files = {"file": (path.name, raw, "application/octet-stream")}
            r = await c.post(f"{DOC_PROCESSOR_URL}/process",
                             files=files, timeout=180.0)
            r.raise_for_status()
            markdown = (r.json() or {}).get("content") or ""
    except Exception as e:
        logger.warning("fs_index_failed path=%s err=%s", path.name, e)
        return {"document_id": doc_id(path), "filename": path.name,
                "status": "error", "error": str(e)}

    if not markdown.strip():
        return {"document_id": doc_id(path), "filename": path.name,
                "status": "empty"}

    chunks = chunk_markdown(markdown)
    if not chunks:
        return {"document_id": doc_id(path), "filename": path.name,
                "status": "no_chunks"}
    texts = [c["text"] for c in chunks]
    vecs = await _embed_batch(texts)
    points: List[qmodels.PointStruct] = []
    # relative-to-mount path is more informative than just the filename
    # for files in nested subdirectories (e.g. "HR Operations
    # Manual/مرخصی.md.docx" vs bare "مرخصی.md.docx").
    try:
        rel = str(path.relative_to(HR_DOCS_PATH))
    except Exception:
        rel = path.name
    for idx, (ch, v) in enumerate(zip(chunks, vecs)):
        if v is None:
            continue
        points.append(qmodels.PointStruct(
            id=str(uuid.uuid5(uuid.NAMESPACE_URL,
                              f"{source_label}::{rel}::{idx}")),
            vector=v,
            payload={
                "text": ch["text"],
                "chunk_type": ch["chunk_type"],
                "heading_path": ch["heading_path"],
                "section_path": " > ".join(ch["heading_path"]),
                "source_project": source_label,
                "source_project_name": path.parent.name or "Filesystem",
                "source_file": rel,
                "category": category,
                "chunk_idx": idx,
            },
        ))
    global _embed_dims
    if _embed_dims is None and points:
        _embed_dims = len(points[0].vector)
        _ensure_collection(_embed_dims)
    if points:
        _qdrant_client().upsert(collection_name=HR_KB_COLLECTION,
                                 points=points, wait=True)
    return {"document_id": doc_id(path), "filename": rel,
            "category": category, "chunks": len(chunks),
            "indexed": len(points)}


def _category_for_path(path: Path) -> str:
    """Derive a KB category from a filesystem path under HR_DOCS_PATH.

    Walks the relative path's directory parts looking for a substring
    match against known category markers. Catches both spelling
    variants ("HR Operations Manual" and "HR Operations Manua" — the
    repo has both at different times due to a name-correction commit).
    Defaults to "hr_manner" because that's the larger of the two
    curated corpora and the safer fallback for HR-flavoured content.
    """
    try:
        rel = path.relative_to(HR_DOCS_PATH)
    except Exception:
        return "fs_drop"
    parts_lower = [p.lower() for p in rel.parent.parts]
    for p in parts_lower:
        if "strateg" in p or "vision" in p or "values" in p:
            return "org_strategy"
        if "hr" in p or "operations" in p or "manual" in p or "manua" in p \
                or "human" in p or "capital" in p:
            return "hr_manner"
    # File sat directly under HR_DOCS_PATH with no informative parent
    # — treat as an ad-hoc drop the chat layer shouldn't surface
    # unless it explicitly asks for category="fs_drop".
    return "fs_drop"


async def _index_local_filesystem() -> Dict[str, int]:
    """Walk HR_DOCS_PATH recursively and index every regular file.

    This is the PRIMARY corpus path now — the curated HR/strategy docs
    are versioned in the repo at Human Capital/ and bind-mounted into
    the container. The GitLab ingest below is kept for setups that
    prefer a separate GitLab corpus, but it's no longer the default.
    """
    stats = {"files": 0, "chunks": 0, "indexed": 0, "skipped": 0, "errors": 0}
    if not HR_DOCS_PATH.exists():
        return {**stats, "skipped": stats["skipped"] + 1,
                "skipped_reason": f"{HR_DOCS_PATH} does not exist"}
    # Stable sort so logs/re-runs are deterministic.
    for path in sorted(HR_DOCS_PATH.rglob("*")):
        if not path.is_file():
            continue
        if path.name.startswith(".") or path.name.endswith("~"):
            continue
        stats["files"] += 1
        try:
            res = await index_file(path)
            if res.get("status") in ("error", "empty", "no_chunks"):
                stats["skipped"] += 1
            else:
                stats["chunks"] += int(res.get("chunks", 0) or 0)
                stats["indexed"] += int(res.get("indexed", 0) or 0)
        except Exception as e:
            stats["errors"] += 1
            logger.warning("local_index_failed path=%s err=%s", path, e)
    logger.info("local_reindex_done stats=%s root=%s", stats, HR_DOCS_PATH)
    return stats


async def remove_doc(document_id: str) -> bool:
    """Best-effort delete by relative-path match. Local-fs files index
    with source_file=<relative_path_from_HR_DOCS_PATH>, so we find the
    target by matching doc_id (sha1 of filename) and then delete every
    Qdrant point whose source_file equals the relative path."""
    try:
        target: Optional[Path] = None
        for p in HR_DOCS_PATH.rglob("*"):
            if p.is_file() and doc_id(p) == document_id:
                target = p
                break
        if target is None:
            return False
        try:
            rel = str(target.relative_to(HR_DOCS_PATH))
        except Exception:
            rel = target.name
        _qdrant_client().delete(
            collection_name=HR_KB_COLLECTION,
            points_selector=qmodels.FilterSelector(
                filter=qmodels.Filter(must=[qmodels.FieldCondition(
                    key="source_file",
                    match=qmodels.MatchValue(value=rel),
                )]),
            ),
            wait=True,
        )
        try:
            target.unlink()
        except Exception:
            pass
        return True
    except Exception as e:
        logger.exception("remove_doc_failed id=%s err=%s", document_id, e)
        return False


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------
async def search_chunks(query: str, top_k: int = 5,
                         category: Optional[str] = None,
                         score_threshold: Optional[float] = None,
                         ) -> List[Dict[str, Any]]:
    """Vector search over HR_KB_COLLECTION. Optional category filter:
    one of {hr_manner, org_strategy, fs_drop}; None searches everything.
    `score_threshold` is honored when set so off-topic queries return
    empty instead of low-confidence noise."""
    if not query or not query.strip():
        return []
    vec = await _embed_one(query)
    if vec is None:
        return []
    qfilter = None
    if category:
        qfilter = qmodels.Filter(must=[qmodels.FieldCondition(
            key="category",
            match=qmodels.MatchValue(value=category),
        )])
    try:
        hits = _qdrant_client().search(
            collection_name=HR_KB_COLLECTION,
            query_vector=vec,
            limit=top_k,
            query_filter=qfilter,
            score_threshold=score_threshold,
            with_payload=True,
        )
    except Exception as e:
        # Collection doesn't exist yet, or qdrant down.
        logger.warning("search_failed err=%s", e)
        return []
    return [{
        "score": float(h.score),
        "text": (h.payload or {}).get("text", ""),
        "source_project": (h.payload or {}).get("source_project"),
        "source_project_name": (h.payload or {}).get("source_project_name"),
        "source_file": (h.payload or {}).get("source_file"),
        "section_path": (h.payload or {}).get("section_path"),
        "category": (h.payload or {}).get("category"),
        "chunk_type": (h.payload or {}).get("chunk_type"),
    } for h in hits]


# ---------------------------------------------------------------------------
# Filesystem watcher (drop a file in HR_DOCS_PATH → auto-index)
# ---------------------------------------------------------------------------
async def watch_dir():
    """Poll HR_DOCS_PATH every WATCH_INTERVAL_SEC; index new files."""
    seen: Dict[str, float] = {}
    HR_DOCS_PATH.mkdir(parents=True, exist_ok=True)
    while True:
        try:
            for path in HR_DOCS_PATH.rglob("*"):
                if not path.is_file():
                    continue
                mtime = path.stat().st_mtime
                if seen.get(path.name) == mtime:
                    continue
                logger.info("Detected new/changed HR doc: %s", path.name)
                try:
                    await index_file(path)
                    seen[path.name] = mtime
                except Exception:
                    logger.exception("Failed to index %s", path.name)
        except Exception:
            logger.exception("Watcher loop error")
        await asyncio.sleep(WATCH_INTERVAL_SEC)


# ---------------------------------------------------------------------------
# FastAPI app + lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    async with mcp.session_manager.run():
        HR_DOCS_PATH.mkdir(parents=True, exist_ok=True)
        task = asyncio.create_task(watch_dir())
        logger.info("hr-kb-service ready, watching %s, collection=%s",
                    HR_DOCS_PATH, HR_KB_COLLECTION)
        yield
        task.cancel()


app = FastAPI(title="Simorgh HR Knowledge Base", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class SearchRequest(BaseModel):
    query: str
    top_k: int = 5
    category: Optional[str] = None
    score_threshold: Optional[float] = None


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.get("/health")
def health():
    return {
        "status": "healthy",
        "service": "hr-kb-service",
        "docs_path": str(HR_DOCS_PATH),
        "collection": HR_KB_COLLECTION,
        "gitlab_group": HR_KB_GITLAB_GROUP,
    }


# ---------------------------------------------------------------------------
# REST
# ---------------------------------------------------------------------------
@app.post("/reindex")
async def reindex(local: bool = True, gitlab: bool = False):
    """Rebuild the HR/strategy KB. Idempotent — upserts by
    (source, path, chunk_idx) so re-running doesn't duplicate.

    By default, walks the local-filesystem corpus only (HR_DOCS_PATH;
    bind-mounted from the repo's Human Capital/ directory). Pass
    `gitlab=true` to ALSO pull from gitlab-mcp's
    HR_KB_GITLAB_GROUP projects — used when the curated KB lives in
    a separate GitLab group rather than in this repo.
    """
    out: Dict[str, Any] = {"collection": HR_KB_COLLECTION}
    if local:
        out["local"] = await _index_local_filesystem()
    if gitlab:
        try:
            out["gitlab"] = await reindex_all()
        except HTTPException as he:
            out["gitlab"] = {"error": he.detail}
    return out


@app.get("/list")
def list_docs() -> Dict[str, Any]:
    """List filesystem-dropped documents (GitLab corpus tracked in Qdrant
    payload; query via /search or the Qdrant admin UI)."""
    docs = []
    if HR_DOCS_PATH.exists():
        for p in sorted(HR_DOCS_PATH.rglob("*")):
            if p.is_file():
                docs.append({
                    "document_id": doc_id(p),
                    "filename": p.name,
                    "size": p.stat().st_size,
                    "mtime": p.stat().st_mtime,
                })
    return {"docs": docs}


@app.post("/upload")
async def upload(file: UploadFile = File(...)) -> Dict[str, Any]:
    """Admin upload — writes the file into HR_DOCS_PATH and indexes
    immediately (no need to wait for the watcher tick)."""
    target = HR_DOCS_PATH / file.filename
    HR_DOCS_PATH.mkdir(parents=True, exist_ok=True)
    with target.open("wb") as f:
        f.write(await file.read())
    return await index_file(target)


@app.delete("/docs/{document_id}")
async def delete(document_id: str) -> Dict[str, Any]:
    ok = await remove_doc(document_id)
    if not ok:
        raise HTTPException(status_code=404, detail="not found")
    return {"deleted": document_id}


@app.post("/search")
async def search(req: SearchRequest) -> Dict[str, Any]:
    return {"results": await search_chunks(
        req.query, req.top_k, req.category, req.score_threshold,
    )}


# ---------------------------------------------------------------------------
# MCP — tools chat-service connects to during a "general" session
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "hr-kb-service",
    instructions=(
        "Search the company HR and organization-strategy knowledge base. "
        "Use this for questions about HR policies, hiring, vision, mission, "
        "ratified values, organizational structure, and any other "
        "human-capital topics. The corpus is curated from the GitLab "
        "human-capital/* projects plus any filesystem drops."
    ),
)


@mcp.tool()
async def search_hr_kb(query: str, top_k: int = 5,
                        category: Optional[str] = None) -> List[Dict[str, Any]]:
    """Search the HR / organization knowledge base. Returns up to top_k
    passages with citation metadata.

    Args:
      query: The user's question or topic, in any language indexed
        (English, Persian — embeddings are multilingual via
        sentence-transformers).
      top_k: Number of hits to return (default 5).
      category: Optional filter — "hr_manner" for HR ops / policies,
        "org_strategy" for vision / mission / values, "fs_drop" for
        ad-hoc filesystem drops. Omit to search everything.

    Returns: list of dicts each with {score, text, source_project,
      source_project_name, source_file, section_path, category,
      chunk_type}. The chat layer should use source_file + section_path
      to render "From: <file> > <heading>" citations.
    """
    return await search_chunks(query, top_k, category)


@mcp.tool()
async def list_hr_docs() -> List[Dict[str, Any]]:
    """List filesystem-dropped HR documents."""
    return list_docs()["docs"]


_mcp_streamable_app = mcp.streamable_http_app()


@app.on_event("startup")
async def _mcp_session_manager_start():
    cm = mcp.session_manager.run()
    app.state._mcp_session_manager_cm = cm
    await cm.__aenter__()


@app.on_event("shutdown")
async def _mcp_session_manager_stop():
    cm = getattr(app.state, "_mcp_session_manager_cm", None)
    if cm is not None:
        await cm.__aexit__(None, None, None)


app.mount("/", _mcp_streamable_app)
