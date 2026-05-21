"""
HR / Organization Knowledge Base Service
========================================
Owns the **organization general knowledge** corpus: HR policies, monthly
holidays documents, corporate-loan rules, hiring period announcements,
and any other company-wide written content the HR manager wants the
chatbot to be able to answer questions about during a *general* chat
session.

Two ways to add content:

1. **Filesystem drop** — the HR manager copies / SCPs / SMB-shares files
   into the host directory mounted to /app/hr_docs (env HR_DOCS_PATH).
   A directory watcher picks them up, runs them through doc-processor,
   embeds via embeddings-service, and indexes into the Qdrant collection
   named by HR_KB_COLLECTION (default "hr_general_kb"). One file = one
   document_id (sha1 of path); re-uploading replaces the old version.

2. **REST upload** — admin UI calls POST /upload (multipart). Same pipeline.

Search: chat-service queries this service over MCP (`search_hr_kb`) when
the user is in a *general* session. The tool returns top-K passages
with citations.

Per the agreed convention "AI/COT uses MCP, others use REST", this
service exposes BOTH:
  * REST /upload, /list, /delete, /search   (admin / chat-service direct)
  * MCP /mcp tools: search_hr_kb, list_hr_docs, get_hr_doc

Sources of truth:
  - Raw files: HR_DOCS_PATH bind volume (named volume simorgh_hr_docs)
  - Vectors:   Qdrant collection HR_KB_COLLECTION ("hr_general_kb")
  - Metadata:  postgres_auth table hr_kb_docs   (document_id, filename,
               sha1, uploaded_by, uploaded_at, processed_at, chunk_count)

This service does NOT call the LLM directly — embedding generation goes
to embeddings-service, conversion goes to doc-processor.
"""
import asyncio
import hashlib
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("hr-kb-service")

HR_DOCS_PATH         = Path(os.getenv("HR_DOCS_PATH", "/app/hr_docs"))
HR_KB_COLLECTION     = os.getenv("HR_KB_COLLECTION", "hr_general_kb")
DOC_PROCESSOR_URL    = os.getenv("DOC_PROCESSOR_URL", "http://doc-processor:8000")
EMBEDDINGS_URL       = os.getenv("EMBEDDINGS_URL", "http://embeddings-service:8031")
QDRANT_URL           = os.getenv("QDRANT_URL", "http://qdrant:6333")
WATCH_INTERVAL_SEC   = int(os.getenv("HR_DOCS_WATCH_INTERVAL", "30"))


def doc_id(path: Path) -> str:
    """Stable doc_id derived from filename so re-uploads replace cleanly."""
    return hashlib.sha1(path.name.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Indexing pipeline (TODO: flesh out)
# ---------------------------------------------------------------------------
async def index_file(path: Path) -> Dict[str, Any]:
    """
    Pipeline:
      1. doc-processor: convert path → markdown
      2. chunk markdown (semantic / header-aware)
      3. embeddings-service: chunks → vectors
      4. qdrant: upsert into HR_KB_COLLECTION with payload
         {document_id, filename, chunk_idx, text, uploaded_at}
      5. write metadata row to postgres_auth.hr_kb_docs
    Idempotent: re-upserting the same document_id replaces.
    """
    # TODO(hr-kb): implement the pipeline. Stub returns a placeholder.
    logger.info("would index %s", path)
    return {"document_id": doc_id(path), "filename": path.name, "status": "stubbed"}


async def remove_doc(document_id: str) -> bool:
    """Delete all chunks for document_id from Qdrant + remove metadata row."""
    # TODO(hr-kb): implement deletion.
    logger.info("would delete document_id=%s", document_id)
    return True


async def search_chunks(query: str, top_k: int = 5) -> List[Dict[str, Any]]:
    """
    1. embeddings-service /embeddings → vector
    2. qdrant search in HR_KB_COLLECTION → top_k chunks
    3. return [{document_id, filename, score, text, chunk_idx}]
    """
    # TODO(hr-kb): implement search. Stub returns empty.
    return []


# ---------------------------------------------------------------------------
# Filesystem watcher (drop a file in HR_DOCS_PATH → auto-index)
# ---------------------------------------------------------------------------
async def watch_dir():
    """Poll HR_DOCS_PATH every WATCH_INTERVAL_SEC; index new files."""
    seen: Dict[str, float] = {}  # filename → mtime when last indexed
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
# FastAPI lifespan: start the watcher
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    # FastAPI ignores @app.on_event when lifespan= is set, so the MCP
    # streamable-http session manager has to be started here.
    async with mcp.session_manager.run():
        HR_DOCS_PATH.mkdir(parents=True, exist_ok=True)
        task = asyncio.create_task(watch_dir())
        logger.info("hr-kb-service ready, watching %s", HR_DOCS_PATH)
        yield
        task.cancel()


app = FastAPI(title="Simorgh HR Knowledge Base", version="0.1.0", lifespan=lifespan)

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
    }


# ---------------------------------------------------------------------------
# REST
# ---------------------------------------------------------------------------
@app.get("/list")
def list_docs() -> Dict[str, Any]:
    """List indexed documents (from filesystem; metadata lookup TODO)."""
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
    """Admin upload endpoint — writes the file into HR_DOCS_PATH (the watcher will pick it up)."""
    target = HR_DOCS_PATH / file.filename
    HR_DOCS_PATH.mkdir(parents=True, exist_ok=True)
    with target.open("wb") as f:
        f.write(await file.read())
    # Index immediately (don't wait for watcher tick)
    result = await index_file(target)
    return result


@app.delete("/docs/{document_id}")
async def delete(document_id: str) -> Dict[str, Any]:
    ok = await remove_doc(document_id)
    if not ok:
        raise HTTPException(status_code=404, detail="not found")
    return {"deleted": document_id}


@app.post("/search")
async def search(req: SearchRequest) -> Dict[str, Any]:
    return {"results": await search_chunks(req.query, req.top_k)}


# ---------------------------------------------------------------------------
# MCP — tools chat-service connects to during a "general" session
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "hr-kb-service",
    instructions=(
        "Search the company HR / organization knowledge base. Use this for "
        "questions about HR policies, monthly holidays, corporate loans, "
        "hiring periods, and other organisation-wide written information."
    ),
)


@mcp.tool()
async def search_hr_kb(query: str, top_k: int = 5) -> List[Dict[str, Any]]:
    """Search the HR knowledge base. Returns top_k passages with citations."""
    return await search_chunks(query, top_k)


@mcp.tool()
async def list_hr_docs() -> List[Dict[str, Any]]:
    """List all available HR knowledge-base documents."""
    return list_docs()["docs"]


# FastMCP's streamable_http_app exposes route /mcp internally. Mount at
# "/" so its public path is /mcp (mounting at "/mcp" would produce /mcp/mcp).
# Its session_manager needs an active TaskGroup; when the inner app is
# mounted under another FastAPI, the inner lifespan never fires — start
# the session manager from the outer app's lifespan instead, otherwise
# every POST returns 500 with "Task group is not initialized".
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
