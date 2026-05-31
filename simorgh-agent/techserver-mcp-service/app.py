"""
techserver-mcp
==============
Read-only MCP surface over the legacy techserver (Windows SMB/CIFS host at
192.168.1.3), modelled on gitlab-mcp. Each engineering project is a
top-level SMB share named after its OE folder (e.g. ``OE12065`` or
``OE11071-Sunlight Co. of Singapore``).

The whole point of this service is to AVOID bulk-copying projects: those
trees are gigabytes (the ``Drawing/`` subtree alone is full of huge CAD
files — .dwg/.ema/.edb/.elk). Instead the CoT engine:

  1. ``techserver_get_tree(oenum)``   — list the project's files WITHOUT
     downloading (metadata only), Drawing/ and CAD hard-excluded, cached
     in Redis with a TTL.
  2. ``techserver_read_artifact(oenum, path)`` — copy exactly ONE file to
     a temp working dir, run it through doc-processor (→ markdown, VLM for
     images) and return the text. Mirrors gitlab-mcp.read_artifact_mcp.

Auth: SMB login ``EKC\\tech`` (domain EKC, user tech), password from
TECHSERVER_PASSWORD. Credentials are written to a 0600 auth file and
passed to smbclient via -A so they never appear in the process list.

Endpoints (REST mirrors + MCP at /mcp):
  GET  /health
  GET  /projects?search=
  GET  /tree?oenum=
  GET  /artifact?oenum=&path=
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import tempfile
import uuid
from typing import Any, Optional

import httpx
import redis as redis_lib
from fastapi import FastAPI, HTTPException, Query
from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("techserver-mcp")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
TECHSERVER_HOST     = os.getenv("TECHSERVER_HOST", "192.168.1.3")
TECHSERVER_USER     = os.getenv("TECHSERVER_USER", "EKC\\tech")
TECHSERVER_PASSWORD = os.getenv("TECHSERVER_PASSWORD", "")
TECHSERVER_DOMAIN   = os.getenv("TECHSERVER_DOMAIN", "")  # else parsed from USER
SMB_MAX_PROTO       = os.getenv("TECHSERVER_SMB_PROTO", "SMB3")
SMB_TIMEOUT         = float(os.getenv("TECHSERVER_SMB_TIMEOUT", "120"))
GET_TIMEOUT         = float(os.getenv("TECHSERVER_GET_TIMEOUT", "300"))

DOC_PROCESSOR_URL   = os.getenv("DOC_PROCESSOR_URL", "http://doc-processor:8000").rstrip("/")
REDIS_URL           = os.getenv("REDIS_URL", "redis://redis:6379/0")
TREE_TTL            = int(os.getenv("TECHSERVER_TREE_TTL", "3600"))   # 1h
SHARE_TTL           = int(os.getenv("TECHSERVER_SHARE_TTL", "86400")) # 24h

# Hard exclusions (requirement: never touch Drawing/, never pull CAD).
EXCLUDE_DIRS = {
    d.strip().lower()
    for d in os.getenv("TECHSERVER_EXCLUDE_DIRS", "Drawing").split(",")
    if d.strip()
}
EXCLUDE_EXTS = {
    e.strip().lower() if e.strip().startswith(".") else "." + e.strip().lower()
    for e in os.getenv(
        "TECHSERVER_EXCLUDE_EXTS",
        ".dwg,.dxf,.ema,.edb,.elk,.dwl,.bak,.7z,.rar,.zip",
    ).split(",")
    if e.strip()
}

# Max file size to fetch through read_artifact (bytes). Guards against a
# stray huge file slipping past the extension filter.
MAX_ARTIFACT_BYTES = int(os.getenv("TECHSERVER_MAX_ARTIFACT_BYTES", str(40 * 1024 * 1024)))


# ---------------------------------------------------------------------------
# Redis (best-effort cache; service still works if Redis is down)
# ---------------------------------------------------------------------------
_redis: Optional[redis_lib.Redis] = None


def _r() -> Optional[redis_lib.Redis]:
    global _redis
    if _redis is None:
        try:
            _redis = redis_lib.from_url(REDIS_URL, decode_responses=True,
                                        socket_connect_timeout=3, socket_timeout=3)
            _redis.ping()
        except Exception as e:
            log.warning("redis unavailable (%s); tree caching disabled", e)
            _redis = None
    return _redis


# ---------------------------------------------------------------------------
# SMB auth file (keeps the password out of argv / process list)
# ---------------------------------------------------------------------------
_auth_path: Optional[str] = None


def _auth_file() -> str:
    global _auth_path
    if _auth_path and os.path.exists(_auth_path):
        return _auth_path
    user = TECHSERVER_USER
    domain = TECHSERVER_DOMAIN
    if "\\" in user and not domain:
        domain, user = user.split("\\", 1)
    fd, path = tempfile.mkstemp(prefix=".smbauth_", text=True)
    with os.fdopen(fd, "w") as f:
        f.write(f"username = {user}\n")
        f.write(f"password = {TECHSERVER_PASSWORD}\n")
        if domain:
            f.write(f"domain = {domain}\n")
    os.chmod(path, 0o600)
    _auth_path = path
    return path


async def _smb(args: list[str], timeout: float) -> tuple[int, str, str]:
    """Run smbclient with the auth file prepended. args are everything
    AFTER the auth/proto flags. Returns (rc, stdout, stderr)."""
    cmd = [
        "smbclient", *args,
        "-A", _auth_file(),
        "-m", SMB_MAX_PROTO,
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        raise HTTPException(status_code=504, detail="smbclient timed out")
    return proc.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


# ---------------------------------------------------------------------------
# Share resolution: OENUM → SMB share name
# ---------------------------------------------------------------------------
async def _list_shares() -> list[str]:
    # -g => machine-readable "Disk|name|comment"
    rc, out, err = await _smb(["-L", f"//{TECHSERVER_HOST}", "-g"], SMB_TIMEOUT)
    shares: list[str] = []
    for line in out.splitlines():
        if line.startswith("Disk|"):
            parts = line.split("|")
            if len(parts) >= 2 and parts[1]:
                shares.append(parts[1])
    return shares


async def _resolve_share(oenum: str) -> str:
    digits = re.sub(r"\D", "", oenum)
    if not digits:
        raise HTTPException(status_code=400, detail=f"invalid oenum: {oenum!r}")

    cache = _r()
    ckey = f"techserver:share:{digits}"
    if cache:
        try:
            hit = cache.get(ckey)
            if hit:
                return hit
        except Exception:
            pass

    shares = await _list_shares()
    # Candidate match: share name's digit-run equals oenum digits AND it
    # looks like an OE folder. Handles "OE12065" and "OE11071-Sunlight…".
    exact, contains = None, None
    target = f"oe{digits}"
    for s in shares:
        low = s.strip().lower()
        if low.startswith("$") or low.endswith("$"):  # admin shares C$/D$…
            continue
        if low.replace(" ", "").startswith(target):
            exact = s
            break
        if digits in low and low.startswith("oe"):
            contains = contains or s
    share = exact or contains
    if not share:
        raise HTTPException(
            status_code=404,
            detail=f"no techserver share for OE {digits}; checked {len(shares)} shares",
        )
    if cache:
        try:
            cache.setex(ckey, SHARE_TTL, share)
        except Exception:
            pass
    return share


# ---------------------------------------------------------------------------
# Tree listing (recurse ls, parsed + pruned)
# ---------------------------------------------------------------------------
# smbclient recurse-ls entry line, e.g.:
#   "  Technical Specification.pdf         A   12345  Thu May 21 09:49:43 2026"
_ENTRY_RE = re.compile(
    r"^\s+(?P<name>.+?)\s+(?P<attr>[DAHNSRC]+)\s+(?P<size>\d+)\s+"
    r"\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4}\s*$"
)


def _excluded(path: str) -> bool:
    parts = [p for p in path.split("/") if p]
    if any(p.lower() in EXCLUDE_DIRS for p in parts):
        return True
    ext = os.path.splitext(path)[1].lower()
    if ext in EXCLUDE_EXTS:
        return True
    return False


def _parse_tree(listing: str) -> list[dict]:
    """Parse `smbclient -c 'recurse ON; ls'` output into [{path,type,size}],
    pruning excluded dirs (Drawing/) and CAD/archive extensions."""
    entries: list[dict] = []
    cur = ""  # current directory path relative to share root, "/"-joined
    for line in listing.splitlines():
        if line.startswith("\\"):
            # Directory header: "\Document\Client"
            cur = line.strip().lstrip("\\").replace("\\", "/")
            continue
        m = _ENTRY_RE.match(line)
        if not m:
            continue
        name = m.group("name").strip()
        if name in (".", ".."):
            continue
        is_dir = "D" in m.group("attr")
        path = f"{cur}/{name}" if cur else name
        if _excluded(path):
            continue
        if is_dir:
            entries.append({"path": path, "type": "tree", "size": 0})
        else:
            entries.append({"path": path, "type": "blob",
                            "size": int(m.group("size"))})
    return entries


async def get_tree_impl(oenum: str, refresh: bool = False) -> dict:
    share = await _resolve_share(oenum)
    digits = re.sub(r"\D", "", oenum)
    cache = _r()
    ckey = f"techserver:tree:{digits}"
    if cache and not refresh:
        try:
            hit = cache.get(ckey)
            if hit:
                data = json.loads(hit)
                data["cached"] = True
                return data
        except Exception:
            pass

    rc, out, err = await _smb(
        [f"//{TECHSERVER_HOST}/{share}", "-c", "recurse ON; ls"], SMB_TIMEOUT,
    )
    if "NT_STATUS" in out or "NT_STATUS" in err:
        raise HTTPException(status_code=502,
                            detail=f"smbclient error: {(err or out)[:200]}")
    files = _parse_tree(out)
    result = {
        "oenum": digits,
        "share": share,
        "host": TECHSERVER_HOST,
        "entries": files,
        "file_count": sum(1 for f in files if f["type"] == "blob"),
        "dir_count": sum(1 for f in files if f["type"] == "tree"),
        "excluded_dirs": sorted(EXCLUDE_DIRS),
        "cached": False,
    }
    if cache:
        try:
            cache.setex(ckey, TREE_TTL, json.dumps(result))
        except Exception:
            pass
    return result


# ---------------------------------------------------------------------------
# Single-file fetch → doc-processor → markdown
# ---------------------------------------------------------------------------
async def read_artifact_impl(oenum: str, path: str) -> dict:
    if not path or path in ("/", "*", "."):
        raise HTTPException(status_code=400, detail="path is required")
    norm = path.strip().lstrip("/").replace("\\", "/")
    if _excluded(norm):
        raise HTTPException(
            status_code=403,
            detail=(f"path '{norm}' is excluded (Drawing/ and CAD/archive "
                    "files are never fetched from techserver)"),
        )

    share = await _resolve_share(oenum)
    remote = norm.replace("/", "\\")  # smbclient wants backslash paths

    suffix = os.path.splitext(norm)[1] or ".bin"
    tmp = os.path.join(tempfile.gettempdir(), f"ts_{uuid.uuid4().hex}{suffix}")
    try:
        rc, out, err = await _smb(
            [f"//{TECHSERVER_HOST}/{share}", "-c", f'get "{remote}" "{tmp}"'],
            GET_TIMEOUT,
        )
        if not os.path.exists(tmp) or os.path.getsize(tmp) == 0:
            blob = (err or out)
            if "NT_STATUS_OBJECT_NAME_NOT_FOUND" in blob or "NT_STATUS_NO_SUCH_FILE" in blob:
                raise HTTPException(status_code=404, detail=f"not found: {norm}")
            raise HTTPException(status_code=502,
                                detail=f"smbclient get failed: {blob[:200]}")
        size = os.path.getsize(tmp)
        if size > MAX_ARTIFACT_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"file too large ({size} bytes > {MAX_ARTIFACT_BYTES})",
            )

        # Run through doc-processor (handles PDF/Office/text + VLM for images).
        filename = os.path.basename(norm)
        try:
            async with httpx.AsyncClient(timeout=GET_TIMEOUT) as c:
                with open(tmp, "rb") as fh:
                    files = {"file": (filename, fh, "application/octet-stream")}
                    data = {"user_id": "techserver-mcp"}
                    r = await c.post(f"{DOC_PROCESSOR_URL}/upload",
                                     files=files, data=data)
            if r.status_code == 200:
                body = r.json()
                content = body.get("content", "") or ""
            else:
                content = f"[doc-processor HTTP {r.status_code}: {r.text[:200]}]"
        except Exception as e:
            content = f"[doc-processor unavailable: {e}]"

        return {
            "oenum": re.sub(r"\D", "", oenum),
            "share": share,
            "path": norm,
            "filename": filename,
            "size": size,
            "content": content,
            "via": "techserver-smb+doc-processor",
        }
    finally:
        try:
            if os.path.exists(tmp):
                os.unlink(tmp)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# REST app
# ---------------------------------------------------------------------------
app = FastAPI(title="techserver-mcp", version="0.1.0")


@app.get("/health")
def health() -> dict:
    return {
        "status": "healthy",
        "service": "techserver-mcp",
        "host": TECHSERVER_HOST,
        "user": TECHSERVER_USER,
        "creds_configured": bool(TECHSERVER_PASSWORD),
        "excluded_dirs": sorted(EXCLUDE_DIRS),
        "excluded_exts": sorted(EXCLUDE_EXTS),
    }


@app.get("/projects")
async def projects(search: str = "") -> dict:
    shares = await _list_shares()
    oe = [s for s in shares if s.strip().lower().startswith("oe")]
    if search:
        s = search.lower()
        oe = [x for x in oe if s in x.lower()]
    return {"projects": oe, "count": len(oe)}


@app.get("/tree")
async def tree(oenum: str = Query(...), refresh: bool = False) -> dict:
    return await get_tree_impl(oenum, refresh=refresh)


@app.get("/artifact")
async def artifact(oenum: str = Query(...), path: str = Query(...)) -> dict:
    return await read_artifact_impl(oenum, path)


# ---------------------------------------------------------------------------
# MCP surface
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "techserver-mcp",
    instructions=(
        "Read legacy engineering projects on the techserver (SMB host). "
        "Each project is keyed by OE number. Use techserver_get_tree to "
        "browse a project's files (the huge Drawing/ CAD tree is excluded), "
        "then techserver_read_artifact to fetch and read ONE specific file. "
        "Never attempt to bulk-download a project."
    ),
)


@mcp.tool()
async def techserver_list_projects(search_term: str = "") -> dict:
    """List OE project shares on the techserver, optionally filtered."""
    return await projects(search=search_term)


@mcp.tool()
async def techserver_get_tree(oenum: str, refresh: bool = False) -> dict:
    """List a techserver project's file tree by OE number WITHOUT downloading.

    Returns {entries:[{path,type,size}], file_count, ...}. The Drawing/
    subtree and CAD/archive files (.dwg/.dxf/.ema/.edb/.elk/.zip/.rar/.7z)
    are hard-excluded. Result is cached in Redis; pass refresh=true to
    force a re-list.
    """
    return await get_tree_impl(oenum, refresh=refresh)


@mcp.tool()
async def techserver_read_artifact(oenum: str, path: str) -> dict:
    """Fetch ONE file from a techserver project and return it as markdown.

    `path` is a path from techserver_get_tree (e.g.
    "Document/Client/Spec/Technical Specification for 6.6KV Switchgears.pdf").
    The single file is copied to a temp dir, converted to markdown via
    doc-processor (PDF/Office/text natively; images via the VLM), then
    deleted. Paths under Drawing/ or with CAD/archive extensions are
    refused — use this for specs, datasheets, lists, correspondence.
    """
    return await read_artifact_impl(oenum, path)


_mcp_app = mcp.streamable_http_app()


@app.on_event("startup")
async def _mcp_start():
    cm = mcp.session_manager.run()
    app.state._mcp_cm = cm
    await cm.__aenter__()


@app.on_event("shutdown")
async def _mcp_stop():
    cm = getattr(app.state, "_mcp_cm", None)
    if cm is not None:
        await cm.__aexit__(None, None, None)


app.mount("/", _mcp_app)
