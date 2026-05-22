"""Shared artifact-type classification and doc-processor client.

Used by three services to implement the same contract:

  * **project-init-service** walks the cloned workspace and pre-extracts
    every non-text artifact into ``.simorgh/extracted/<path>.md``,
    committing the result so the CoT never has to reason on bytes.
  * **gitlab-mcp-service** exposes ``read_artifact`` — prefers the cached
    markdown from ``.simorgh/extracted/<path>.md``, otherwise routes the
    blob through doc-processor on demand.
  * **runtime-broker** does the same for files inside the per-project
    session container.

Keeping classification and the doc-processor client in one place lets
all three services agree on what counts as "text" without each
re-implementing extension lists.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Iterable, Optional

import httpx

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Extension classes
# ---------------------------------------------------------------------------
# Files we send raw to the LLM. The list is intentionally generous —
# unknown text-shaped extensions are also treated as text via heuristic
# below, so the model never asks for a tool just to read source code.
TEXT_EXTS = frozenset({
    ".txt", ".md", ".markdown", ".rst", ".csv", ".tsv", ".json", ".yaml",
    ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".log", ".xml",
    ".html", ".htm", ".css", ".scss", ".less",
    ".py", ".pyi", ".ipynb",
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".java", ".kt", ".kts",
    ".rs", ".go", ".rb", ".php", ".pl", ".pm", ".lua", ".sh", ".bash",
    ".zsh", ".fish", ".ps1", ".bat", ".cmd",
    ".sql", ".graphql", ".gql", ".proto",
    ".dockerfile", ".gitignore", ".gitattributes", ".editorconfig",
})

# Image-shaped binaries. Routed through doc-processor (EasyOCR) by
# default; callers that have a VLM available may layer description on
# top — that integration lives outside this module.
IMG_EXTS = frozenset({
    ".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp", ".gif",
})

# Office / PDF / spreadsheet — doc-processor handles all of these.
BINARY_DOC_EXTS = frozenset({
    ".pdf",
    ".doc", ".docx",
    ".xls", ".xlsx", ".xlsm",
    ".ppt", ".pptx",
    ".odt", ".ods", ".odp",
})

# Stuff we deliberately do **not** try to extract from — opaque blobs
# the model can't meaningfully reason on even after extraction.
SKIP_EXTS = frozenset({
    ".zip", ".tar", ".tgz", ".gz", ".bz2", ".xz", ".7z", ".rar",
    ".jar", ".war", ".ear",
    ".so", ".dll", ".dylib", ".o", ".a", ".obj", ".exe", ".bin",
    ".pyc", ".pyo", ".class",
    ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav", ".flac", ".ogg",
    ".ttf", ".otf", ".woff", ".woff2",
    ".db", ".sqlite", ".sqlite3",
})

# Where extracted markdown lives, relative to the workspace root.
EXTRACTED_DIR = ".simorgh/extracted"


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------
def _ext(path: str | os.PathLike[str]) -> str:
    return PurePosixPath(str(path)).suffix.lower()


def classify(path: str | os.PathLike[str]) -> str:
    """Return one of ``"text" | "doc" | "image" | "skip" | "unknown"``.

    The "unknown" bucket is treated like a binary doc by callers — they
    should attempt doc-processor and fall back to "skip" if it refuses.
    """
    ext = _ext(path)
    if ext in TEXT_EXTS:
        return "text"
    if ext in IMG_EXTS:
        return "image"
    if ext in BINARY_DOC_EXTS:
        return "doc"
    if ext in SKIP_EXTS:
        return "skip"
    # Dotfiles with no extension (`.env`, `Dockerfile`) — treat as text.
    base = PurePosixPath(str(path)).name
    if base in {"Dockerfile", "Makefile", "Jenkinsfile", "README", "LICENSE"}:
        return "text"
    if not ext:
        return "text"
    return "unknown"


def is_text(path: str | os.PathLike[str]) -> bool:
    return classify(path) == "text"


def needs_extraction(path: str | os.PathLike[str]) -> bool:
    """True if doc-processor should be invoked for this file."""
    return classify(path) in {"doc", "image", "unknown"}


def extracted_path_for(path: str | os.PathLike[str]) -> str:
    """Map a workspace-relative path to its ``.simorgh/extracted/...md``.

    Examples
    --------
    >>> extracted_path_for("reports/q1.pdf")
    '.simorgh/extracted/reports/q1.pdf.md'
    >>> extracted_path_for("/work/gitlab/a/b.xlsx")
    '.simorgh/extracted/work/gitlab/a/b.xlsx.md'
    """
    p = PurePosixPath(str(path))
    # Drop any leading slash so we end up with a clean relative path
    # under EXTRACTED_DIR — keeps the mirror walkable by the user.
    parts = [pt for pt in p.parts if pt not in ("", "/")]
    rel = PurePosixPath(*parts) if parts else PurePosixPath(p.name)
    return f"{EXTRACTED_DIR}/{rel.as_posix()}.md"


# ---------------------------------------------------------------------------
# Doc-processor client (minimal, async, shared)
# ---------------------------------------------------------------------------
_MIME_BY_EXT: Dict[str, str] = {
    ".pdf":  "application/pdf",
    ".jpg":  "image/jpeg",  ".jpeg": "image/jpeg",
    ".png":  "image/png",   ".bmp":  "image/bmp",
    ".tif":  "image/tiff",  ".tiff": "image/tiff",
    ".webp": "image/webp",  ".gif":  "image/gif",
    ".doc":  "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls":  "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt":  "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".csv":  "text/csv",
    ".txt":  "text/plain",
    ".md":   "text/markdown",
}


def _mime_for(filename: str) -> str:
    return _MIME_BY_EXT.get(_ext(filename), "application/octet-stream")


class DocProcessorClient:
    """Async client for doc-processor's ``/upload`` endpoint.

    The chat-service has its own copy under
    ``chat-service/services/doc_processor_client.py``; this one lives in
    ``shared/`` so project-init, gitlab-mcp, and runtime-broker can use
    the same shape without copy-pasting the MIME table.
    """

    def __init__(self, base_url: Optional[str] = None, timeout: float = 300.0):
        self.base_url = (base_url or os.getenv("DOC_PROCESSOR_URL",
                                               "http://doc-processor:8000")).rstrip("/")
        self.timeout = timeout

    async def health_check(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(f"{self.base_url}/health")
                return r.status_code == 200
        except Exception:
            return False

    async def process_bytes(
        self, file_bytes: bytes, filename: str, user_id: str = "simorgh-agent",
    ) -> Dict[str, Any]:
        """POST raw bytes to doc-processor. Returns the service's JSON body.

        On failure returns ``{"success": False, "error": str}`` rather
        than raising, matching the chat-service variant.
        """
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                files = {"file": (filename, file_bytes, _mime_for(filename))}
                data = {"user_id": user_id}
                r = await client.post(f"{self.base_url}/upload",
                                       files=files, data=data)
            if r.status_code != 200:
                detail = "upstream error"
                try:
                    detail = r.json().get("detail", detail)
                except Exception:
                    detail = r.text[:200]
                return {"success": False, "error": f"doc-processor {r.status_code}: {detail}"}
            return r.json()
        except httpx.TimeoutException:
            return {"success": False, "error": f"timeout processing {filename}"}
        except Exception as e:
            return {"success": False, "error": f"{type(e).__name__}: {e}"}


# Convenience walker — used by project-init at ingest time.
def iter_extractable(paths: Iterable[str]) -> Iterable[tuple[str, str]]:
    """Yield ``(path, class)`` for every input that needs_extraction()."""
    for p in paths:
        cls = classify(p)
        if cls in {"doc", "image", "unknown"}:
            yield p, cls


__all__ = [
    "TEXT_EXTS", "IMG_EXTS", "BINARY_DOC_EXTS", "SKIP_EXTS", "EXTRACTED_DIR",
    "classify", "is_text", "needs_extraction",
    "extracted_path_for", "iter_extractable",
    "DocProcessorClient",
]
