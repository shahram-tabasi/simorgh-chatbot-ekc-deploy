"""
Project Init Workflow Service (v0.3 — per-project container era)
================================================================
NEW FLOW:

1. Create / start the project's session container (runtime-broker).
2. If user picked a GitLab repo:
     - Clone repo into /work/gitlab at the selected base branch
     - Create a new local branch `simorgh/<short-hex>`
     - Push the new branch to origin so the chatbot's later edits can be PR'd
3. If `sources_enabled.tpms`: pull TPMS data into /work/tpms (via tpms-fetcher).
4. If `sources_enabled.techserver` + techserver_oenum: smbclient pull
   `//192.168.1.3/techser/<oenum>` into /work/techserver.
5. If `sources_enabled.ekc`: clone the read-only ekc-technical-knowledge repo
   into /work/ekc-knowledge (no remote configured — it is read-only).
6. Ensure /work/uploads exists for the upload-fallback path.
7. Kick off project-explorer (two-phase: remote-fast then container-deep).
   Phase-1 results are written to Redis under `project:{id}:exploration`
   so the CoT engine can start answering questions immediately.

What is NO LONGER mandatory:
  • TPMS auth at project creation. It is now ONLY required when the user
    has ticked `tpms` or `techserver`. The wizard handles that prompt
    before posting to /init.
"""
import os
import secrets
import shlex
import uuid
from datetime import datetime, timezone
from typing import Any

import base64
import re

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field

from simorgh_artifacts import (
    DocProcessorClient,
    EXTRACTED_DIR,
    classify,
    extracted_path_for,
)
from simorgh_logging import configure, get_logger, request_id_middleware

configure(service="project-init")
log = get_logger(__name__)

GITLAB_MCP_URL        = os.getenv("GITLAB_MCP_URL",        "http://gitlab-mcp:8047")
RUNTIME_BROKER_URL    = os.getenv("RUNTIME_BROKER_URL",    "http://runtime-broker:8048")
TPMS_CONTEXT_URL      = os.getenv("TPMS_CONTEXT_URL",      "http://tpms-context-agent:8050")
TPMS_FETCHER_URL      = os.getenv("TPMS_FETCHER_URL",      "http://tpms-fetcher:8021")
CONTEXT_SEARCH_URL    = os.getenv("CONTEXT_SEARCH_URL",    "http://context-search:8049")
PROJECT_EXPLORER_URL  = os.getenv("PROJECT_EXPLORER_URL",  "http://project-explorer:8052")
PROJECTS_GROUP        = os.getenv("GITLAB_PROJECTS_GROUP", "simorgh-projects")
EKC_KB_REPO           = os.getenv("GITLAB_TECH_KB_REPO",   "simorgh-knowledge/technical-knowledge")
EKC_KB_CLONE_URL      = os.getenv("EKC_KB_CLONE_URL", "")  # set in compose
TECHSERVER_HOST       = os.getenv("TECHSERVER_HOST",       "192.168.1.3")
TECHSERVER_SHARE      = os.getenv("TECHSERVER_SHARE",      "techser")
TECHSERVER_USER       = os.getenv("TECHSERVER_USER",       "")
TECHSERVER_PASS       = os.getenv("TECHSERVER_PASS",       "")
AGENT_TOKEN           = os.getenv("AGENT_TOKEN",           "")
BROKER_TOKEN          = os.getenv("BROKER_TOKEN",          "")

app = FastAPI(title="project-init", version="0.3.0")
app.middleware("http")(request_id_middleware)

_init_status: dict[str, dict[str, Any]] = {}


class SourcesEnabled(BaseModel):
    gitlab: bool = False
    tpms: bool = False
    techserver: bool = False
    techserver_oenum: str | None = None
    ekc: bool = False
    upload: bool = True   # default-on; this is the catch-all working dir


class TpmsAuth(BaseModel):
    user: str
    password: str = Field(..., alias="pass")

    class Config:
        populate_by_name = True


class InitRequest(BaseModel):
    project_id: str = Field(..., description="Internal project UUID")
    project_name: str = Field(..., min_length=1)
    owner_id: str = Field(...)
    # New flow inputs
    gitlab_repo_path: str | None = None       # 'group/repo' chosen by the user
    gitlab_repo_url: str | None = None        # full clone URL (https or git@)
    gitlab_base_branch: str | None = None     # branch the user wants to fork from
    # Anything Git understands: branch / tag / SHA. Wins over
    # gitlab_base_branch when both are set, so the wizard can pin a
    # release tag or a specific revision without changing the request
    # shape further.
    base_ref: str | None = None
    # Optional friendly hint for the simorgh working branch name. We
    # always wrap it as `simorgh/<oenum-or-id>/<sanitized-hint>-<hex>`
    # so multiple projects from the same repo never collide on a name.
    branch_name_hint: str | None = None
    sources: SourcesEnabled = Field(default_factory=SourcesEnabled)
    # Optional TPMS credentials. Required by the user only when tpms or
    # techserver sources are ticked. Falls back to TECHSERVER_USER/PASS
    # env vars on this service if not supplied.
    tpms_auth: TpmsAuth | None = None
    # Legacy field — kept for backward compat. New flow uses sources.techserver_oenum.
    oenum: str | None = None


class InitResponse(BaseModel):
    init_id: str
    project_id: str
    status: str
    message: str
    simorgh_branch: str | None = None


def _agent_headers() -> dict[str, str]:
    return {"x-agent-auth": AGENT_TOKEN} if AGENT_TOKEN else {}


def _broker_headers() -> dict[str, str]:
    return {"authorization": f"Bearer {BROKER_TOKEN}"} if BROKER_TOKEN else {}


_BRANCH_SAFE_RE = re.compile(r"[^a-zA-Z0-9._-]+")


def _sanitize_branch_segment(s: str) -> str:
    """Reduce arbitrary user text to a git-branch-safe segment.

    git's reference rules are stricter than this but for the trailing
    segment of ``simorgh/<scope>/<hint>-<hex>`` this is enough — no
    spaces, no slashes, no leading dot, length-bounded.
    """
    cleaned = _BRANCH_SAFE_RE.sub("-", s or "").strip("-.").lower()
    return cleaned[:40] or "work"


def _simorgh_branch_name(
    scope: str | None = None, hint: str | None = None,
) -> str:
    """Compose the simorgh working branch name.

    Examples
    --------
    >>> _simorgh_branch_name()
    'simorgh/a3f9c2'
    >>> _simorgh_branch_name(scope='12345')
    'simorgh/12345/a3f9c2'
    >>> _simorgh_branch_name(scope='12345', hint='Panel A redesign')
    'simorgh/12345/panel-a-redesign-a3f9c2'

    The trailing hex keeps two concurrent projects on the same source
    repo from colliding on a branch name when both pick the same hint.
    """
    suffix = secrets.token_hex(3)
    parts: list[str] = ["simorgh"]
    if scope:
        parts.append(_sanitize_branch_segment(scope))
    if hint:
        parts.append(f"{_sanitize_branch_segment(hint)}-{suffix}")
    else:
        parts.append(suffix)
    return "/".join(parts)


# ---------------------------------------------------------------------------
# Step implementations
# ---------------------------------------------------------------------------
async def _start_container(client: httpx.AsyncClient, project_id: str) -> dict:
    r = await client.post(f"{RUNTIME_BROKER_URL}/sessions/{project_id}/start",
                          json={"project_id": project_id},
                          headers=_broker_headers())
    r.raise_for_status()
    return r.json()


async def _exec(client: httpx.AsyncClient, project_id: str, command: str,
                timeout_sec: int = 300, workdir: str | None = None) -> dict:
    payload: dict[str, Any] = {"command": command, "timeout_sec": timeout_sec}
    if workdir:
        payload["workdir"] = workdir
    r = await client.post(f"{RUNTIME_BROKER_URL}/sessions/{project_id}/exec",
                          json=payload, headers=_broker_headers())
    if r.status_code >= 400:
        # Surface the response body so 422 (Pydantic validation) and
        # 502 (docker exec failures) don't appear as opaque status codes
        # in the higher-level init log.
        body = r.text[:500]
        log.error("session_exec_failed", project_id=project_id,
                  status=r.status_code, body=body,
                  command_head=command.splitlines()[0][:120] if command else "")
        raise httpx.HTTPStatusError(
            f"runtime-broker exec returned {r.status_code}: {body}",
            request=r.request, response=r,
        )
    return r.json()


async def _clone_user_repo(
    client: httpx.AsyncClient, project_id: str,
    repo_url: str, base_ref: str | None, simorgh_branch: str,
) -> dict:
    """Clone the user's repo into /work/gitlab, branch from ``base_ref``,
    and push the new simorgh branch so ``origin`` tracks it.

    ``base_ref`` may be a branch, tag, or SHA. The clone is unconfigured
    (no ``--branch``); we resolve the ref locally with ``git checkout -B``
    after a full ``fetch --all`` so tags and arbitrary SHAs both work.
    """
    safe_ref = shlex.quote(base_ref) if base_ref else ""
    safe_branch = shlex.quote(simorgh_branch)
    safe_url = shlex.quote(repo_url)
    checkout = (
        f"git checkout -B {safe_branch} {safe_ref}\n"
        if base_ref
        else f"git checkout -B {safe_branch}\n"
    )
    script = (
        "set -e\n"
        "rm -rf /work/gitlab\n"
        f"git clone {safe_url} /work/gitlab\n"
        "cd /work/gitlab\n"
        "git fetch --all --tags --prune\n"
        f"{checkout}"
        "# Best-effort push; if write isn't granted yet we keep going.\n"
        f"git push -u origin {safe_branch} || echo 'push deferred — deploy key not granted yet'\n"
    )
    return await _exec(client, project_id, script, timeout_sec=600)


async def _pull_tpms(client: httpx.AsyncClient, project_id: str, oenum: str,
                     tpms_auth: TpmsAuth | None = None) -> dict:
    """Fetch TPMS rendered context and write it into the container as a file
    under /work/tpms/. The hot path is still tpms-context-agent → Redis; this
    just stages a local copy the CoT can reference as a doc.

    If `tpms_auth` is supplied, the credentials are forwarded to the
    tpms-context-agent so the request runs as that user; otherwise the
    agent falls back to its service-level credentials.
    """
    payload: dict[str, Any] = {"oenum": oenum, "refresh": True}
    if tpms_auth is not None:
        payload["auth"] = {"user": tpms_auth.user, "password": tpms_auth.password}
    r = await client.post(f"{TPMS_CONTEXT_URL}/context", json=payload)
    r.raise_for_status()
    rendered = r.json().get("rendered", "")
    write = await client.post(f"{RUNTIME_BROKER_URL}/sessions/{project_id}/write_file",
                              json={"path": f"tpms/{oenum}.md", "content": rendered},
                              headers=_broker_headers())
    write.raise_for_status()
    # Make sure the directory exists first via exec (write_file uses put_archive on /work).
    await _exec(client, project_id, "mkdir -p /work/tpms")
    return {"oenum": oenum, "bytes": len(rendered)}


async def _pull_techserver(client: httpx.AsyncClient, project_id: str, oenum: str,
                           tpms_auth: TpmsAuth | None = None) -> dict:
    """SMB-copy //TECHSERVER_HOST/TECHSERVER_SHARE/<oenum> into /work/techserver/<oenum>.

    Per-user credentials from the wizard take precedence over the
    service-level TECHSERVER_USER / TECHSERVER_PASS env vars.
    """
    user = tpms_auth.user     if tpms_auth else TECHSERVER_USER
    pwd  = tpms_auth.password if tpms_auth else TECHSERVER_PASS
    if not (user and pwd):
        raise RuntimeError(
            "Techserver credentials not provided (wizard tpms_auth missing and "
            "TECHSERVER_USER / TECHSERVER_PASS not configured)."
        )
    # Run the smbclient password through an env var so it doesn't end up in
    # the container's process list. shlex.quote on the oenum keeps the
    # remote `cd` safe.
    safe_oenum = shlex.quote(oenum)
    script = (
        f"set -e\n"
        f"mkdir -p /work/techserver/{oenum}\n"
        f"cd /work/techserver/{oenum}\n"
        f"export USER={shlex.quote(user)}\n"
        f"export PASSWD={shlex.quote(pwd)}\n"
        f"smbclient //{TECHSERVER_HOST}/{TECHSERVER_SHARE} \"$PASSWD\" "
        f"  -U \"$USER\" "
        f"  -c 'prompt OFF; recurse ON; lcd /work/techserver/{oenum}; "
        f"      cd {safe_oenum}; mget *'\n"
    )
    return await _exec(client, project_id, script, timeout_sec=1200)


async def _list_workspace_files(
    client: httpx.AsyncClient, project_id: str, root: str,
) -> list[str]:
    """Return paths relative to /work for every regular file under ``root``.

    Uses ``find`` inside the container — fast enough for tens of
    thousands of files, and we don't need to roundtrip per-file just to
    discover what's there.
    """
    script = (
        f"set -e\n"
        f"if [ -d {shlex.quote(root)} ]; then\n"
        f"  cd /work && find {shlex.quote(root.lstrip('/work/'))} -type f "
        f"    -not -path '*/.git/*' -not -path '*/.simorgh/*' "
        f"    -size -50M\n"
        f"fi\n"
    )
    r = await _exec(client, project_id, script, timeout_sec=120)
    out = (r.get("stdout") or "").strip()
    if not out:
        return []
    return [line for line in out.splitlines() if line.strip()]


async def _extract_one_artifact(
    client: httpx.AsyncClient,
    project_id: str,
    workspace_path: str,
    doc: DocProcessorClient,
) -> tuple[str, bool, str]:
    """Read one file from the container, send it to doc-processor, write
    the extracted markdown back into the container.

    Returns ``(path, ok, message)`` so the caller can report a summary
    without bailing on a single failure.
    """
    # 1. Read raw bytes out of the container via the broker.
    r = await client.get(
        f"{RUNTIME_BROKER_URL}/sessions/{project_id}/read_file",
        params={"path": workspace_path}, headers=_broker_headers(),
        timeout=120.0,
    )
    if r.status_code != 200:
        return workspace_path, False, f"read_file {r.status_code}"
    body = r.json()
    encoding = body.get("encoding", "utf-8")
    if encoding == "utf-8":
        # Text after all — no extraction needed.
        return workspace_path, True, "text-after-read"
    try:
        raw = base64.b64decode(body.get("content", "") or "")
    except Exception as e:
        return workspace_path, False, f"decode {e}"
    if not raw:
        return workspace_path, False, "empty"

    # 2. Hand to doc-processor.
    filename = workspace_path.rsplit("/", 1)[-1]
    res = await doc.process_bytes(raw, filename=filename,
                                  user_id="project-init")
    if not res.get("success"):
        return workspace_path, False, res.get("error", "doc-processor failed")
    markdown = res.get("content") or ""
    if not markdown.strip():
        return workspace_path, False, "doc-processor empty output"

    # 3. Write the extracted markdown back into the container at
    #    .simorgh/extracted/<path>.md so it's both available to CoT and
    #    committed alongside the source.
    target = extracted_path_for(workspace_path)
    # ensure parent directory exists in the container
    await _exec(
        client, project_id,
        f"mkdir -p {shlex.quote('/work/' + target.rsplit('/', 1)[0])}",
        timeout_sec=30,
    )
    w = await client.post(
        f"{RUNTIME_BROKER_URL}/sessions/{project_id}/write_file",
        json={"path": target, "content": markdown},
        headers=_broker_headers(), timeout=60.0,
    )
    if w.status_code != 200:
        return workspace_path, False, f"write_file {w.status_code}"
    return workspace_path, True, f"{len(markdown)}B"


async def _extract_artifacts(
    client: httpx.AsyncClient, project_id: str, simorgh_branch: str | None,
) -> dict:
    """Walk /work/gitlab, normalize every non-text file into
    ``.simorgh/extracted/<path>.md`` via doc-processor, then commit + push.

    Best-effort: one failing file does not fail the project init.
    Returns a small report dict the orchestrator can log.
    """
    doc = DocProcessorClient(timeout=240.0)
    if not await doc.health_check():
        return {"skipped": True, "reason": "doc-processor unhealthy"}

    paths = await _list_workspace_files(client, project_id, "/work/gitlab")
    extractable = [p for p in paths if classify(p) in {"doc", "image", "unknown"}]
    if not extractable:
        return {"scanned": len(paths), "extracted": 0}

    ok, fail = 0, 0
    failures: list[dict[str, str]] = []
    for p in extractable:
        _, success, msg = await _extract_one_artifact(client, project_id, p, doc)
        if success:
            ok += 1
        else:
            fail += 1
            failures.append({"path": p, "reason": msg})

    # Commit the extracted directory and push if we wrote anything.
    if ok > 0:
        commit_script = (
            f"set -e\n"
            f"cd /work/gitlab\n"
            f"git add -- {shlex.quote(EXTRACTED_DIR)} || true\n"
            f"git -c user.email=simorgh-agent@local -c user.name=simorgh-agent "
            f"  diff --cached --quiet || git -c user.email=simorgh-agent@local "
            f"  -c user.name=simorgh-agent commit -m 'simorgh: ingest-time artifact extraction'\n"
            f"git push -u origin HEAD || echo 'push deferred — deploy key not granted yet'\n"
        )
        try:
            await _exec(client, project_id, commit_script, timeout_sec=300)
        except httpx.HTTPError as e:
            log.warning("extract_commit_failed", error=str(e))

    log.info("ingest_extraction_done", project_id=project_id,
             ok=ok, fail=fail, scanned=len(paths))
    return {
        "scanned": len(paths), "extracted": ok, "failed": fail,
        "failures": failures[:20],  # truncate so init logs don't explode
    }


async def _index_for_search(
    client: httpx.AsyncClient, project_id: str,
    *, repo: str | None, ref: str | None,
) -> dict:
    """Bulk-index cloned project files into context-search's Elasticsearch
    ``simorgh-content`` index so the planner's ``search_context`` tool
    can do BM25 + kNN over them.

    Phase 1 of the auto-exploration pipeline. Without this step, the
    only way to reach project content is a live GitLab read via
    ``read_artifact_mcp`` (one file at a time, no relevance ranking) —
    which is why "what does the doc say about X" questions were
    routinely missing or guessing.

    Strategy:
      • Enumerate every file under /work/gitlab (skip .git, .simorgh
        artifacts skipped here because we re-discover them as
        extracted/<path>.md sidecars below).
      • For each file: prefer ``.simorgh/extracted/<path>.md`` if it
        exists (PDFs, docx, images already became markdown at
        _extract_artifacts time); otherwise read the source bytes if
        the file is small text.
      • Chunk into ~2000-char windows with 200-char overlap so the
        embedding model (768-dim, ~512-token context) gets coherent
        passages rather than full documents that would be truncated.
      • POST batches of 25 ContentDoc rows to /index/content/bulk.
        Server-side embeds title+body via the embeddings service.

    Best-effort: one failing file does NOT fail project init. The
    planner can still fall back to read_artifact_mcp for whatever
    isn't indexed.
    """
    paths = await _list_workspace_files(client, project_id, "/work/gitlab")
    if not paths:
        return {"skipped": True, "reason": "no files under /work/gitlab"}

    # Build the path -> extracted-sidecar map ONCE so we can prefer the
    # markdown sidecar when one exists. The extracted dir is a sibling
    # of /work/gitlab (write_file in runtime-broker resolves paths
    # against /work directly, so .simorgh/extracted/gitlab/X.md lives
    # at /work/.simorgh/extracted/gitlab/X.md — not inside the cloned
    # repo). _list_workspace_files also explicitly skips .simorgh/*,
    # so we do a one-off find here.
    extracted_paths: list[str] = []
    try:
        r = await _exec(
            client, project_id,
            "set -e\n"
            f"D=/work/{shlex.quote(EXTRACTED_DIR)}\n"
            'if [ -d "$D" ]; then cd /work && find '
            f"{shlex.quote(EXTRACTED_DIR)} -type f -name '*.md' -size -50M; fi\n",
            timeout_sec=60,
        )
        out = (r.get("stdout") or "").strip()
        extracted_paths = [line for line in out.splitlines() if line.strip()]
    except Exception as e:
        log.warning("extracted_listing_failed", project_id=project_id, error=str(e))
    # Sidecar layout: ".simorgh/extracted/<source>.md".
    # _list_workspace_files returns the source as "<source>" (the
    # /work/-relative path of the original file, e.g. "gitlab/spec.pdf").
    # So strip the leading EXTRACTED_DIR + '/' and the trailing '.md'
    # to recover the source-path key.
    _ext_prefix = EXTRACTED_DIR + "/"
    extracted_index = {
        p[len(_ext_prefix):-len(".md")]: p
        for p in extracted_paths
        if p.startswith(_ext_prefix) and p.endswith(".md")
    }

    headers = _broker_headers()
    batch: list[dict] = []
    indexed_chunks = 0
    indexed_files = 0
    skipped_binary = 0
    errors: list[dict] = []

    async def _flush() -> None:
        nonlocal batch, indexed_chunks, errors
        if not batch:
            return
        try:
            r = await client.post(
                f"{CONTEXT_SEARCH_URL}/index/content/bulk",
                json=batch, timeout=120.0,
            )
            r.raise_for_status()
            indexed_chunks += int((r.json() or {}).get("indexed", 0))
        except Exception as e:
            errors.append({"batch_size": len(batch), "error": str(e)[:200]})
        batch = []

    for source_path in paths:
        # source_path looks like "gitlab/path/inside/repo.ext".
        rel = source_path[len("gitlab/"):] if source_path.startswith("gitlab/") else source_path

        # Prefer the extracted markdown sidecar (PDF/docx/image already
        # turned into markdown) over the binary source. For native text
        # files (md, rst, txt, code) the source itself is what we want.
        sidecar = extracted_index.get(source_path)
        read_target = sidecar or source_path
        try:
            r = await client.get(
                f"{RUNTIME_BROKER_URL}/sessions/{project_id}/read_file",
                params={"path": read_target}, headers=headers, timeout=60.0,
            )
            if r.status_code != 200:
                errors.append({"path": source_path, "reason": f"read {r.status_code}"})
                continue
            body = r.json()
        except Exception as e:
            errors.append({"path": source_path, "reason": f"read exc {e}"[:200]})
            continue

        encoding = body.get("encoding", "utf-8")
        if encoding != "utf-8":
            # Binary file with no extracted sidecar — nothing useful to
            # embed. Tracked separately so the report distinguishes
            # "couldn't extract" from "wasn't text".
            skipped_binary += 1
            continue

        content = body.get("content", "") or ""
        if not content.strip():
            continue

        for chunk_idx, chunk in enumerate(_chunk_text(content, size=2000, overlap=200)):
            batch.append({
                "source": "gitlab",
                "project_id": project_id,
                "repo": repo,
                "ref": ref,
                # rel is the source path; sidecars are an extraction
                # detail the planner doesn't need to know about.
                "path": rel,
                "title": rel.rsplit("/", 1)[-1],
                "body": chunk,
                "tags": ["project_file"] + (
                    ["extracted"] if sidecar else ["native_text"]
                ),
                # Deterministic id so re-running init upserts instead
                # of duplicating. Keying on (project_id, path, chunk)
                # is enough; ref changes mean a new init anyway.
                "id": f"{project_id}::{rel}::{chunk_idx}",
            })
            if len(batch) >= 25:
                await _flush()

        indexed_files += 1

    await _flush()

    log.info("index_for_search_done", project_id=project_id,
             scanned=len(paths), indexed_files=indexed_files,
             indexed_chunks=indexed_chunks,
             skipped_binary=skipped_binary, errors=len(errors))
    return {
        "scanned": len(paths),
        "indexed_files": indexed_files,
        "indexed_chunks": indexed_chunks,
        "skipped_binary": skipped_binary,
        "errors": errors[:10],
    }


def _chunk_text(text: str, *, size: int, overlap: int) -> list[str]:
    """Split text into overlapping windows. Tries to break on a
    paragraph or sentence boundary inside the last ~10% of the window
    so chunks don't end mid-word; falls back to a hard cut if no
    boundary is in range."""
    if size <= 0:
        return [text] if text else []
    if len(text) <= size:
        return [text]
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        end = min(i + size, n)
        if end < n:
            # Look back up to 25% of the chunk for a natural break.
            # Tight windows (≤10%) silently fall through to hard cuts
            # for documents with sparse paragraph boundaries — common
            # in extracted Persian/Arabic markdown where one cell of a
            # table spans 1.5k characters before the next \n\n.
            search_from = max(i + int(size * 0.75), i + 1)
            for sep in ("\n\n", ". ", "\n", " "):
                cut = text.rfind(sep, search_from, end)
                if cut != -1:
                    end = cut + len(sep)
                    break
        out.append(text[i:end])
        if end >= n:
            break
        i = max(end - overlap, i + 1)
    return out


async def _clone_ekc(client: httpx.AsyncClient, project_id: str) -> dict:
    """Clone ekc-technical-knowledge into /work/ekc-knowledge as a read-only
    snapshot. No remote configured for write — it is consult-only."""
    url = EKC_KB_CLONE_URL or f"{os.getenv('GITLAB_URL','').rstrip('/')}/{EKC_KB_REPO}.git"
    script = (
        f"set -e\n"
        f"rm -rf /work/ekc-knowledge\n"
        f"git clone --depth 1 {url} /work/ekc-knowledge\n"
        f"cd /work/ekc-knowledge\n"
        f"# Remove origin so nothing can be pushed back accidentally.\n"
        f"git remote remove origin || true\n"
    )
    return await _exec(client, project_id, script, timeout_sec=600)


async def _ensure_uploads_dir(client: httpx.AsyncClient, project_id: str) -> dict:
    return await _exec(client, project_id, "mkdir -p /work/uploads && ls -la /work")


async def _kick_explorer(client: httpx.AsyncClient, req: InitRequest) -> dict:
    """Fire-and-poll the project-explorer. Phase-1 (remote) is fast and
    posts back to Redis; phase-2 (container) runs in background."""
    try:
        r = await client.post(f"{PROJECT_EXPLORER_URL}/explore",
                              json={
                                  "project_id": req.project_id,
                                  "gitlab_repo_path": req.gitlab_repo_path,
                                  "gitlab_base_branch": req.gitlab_base_branch,
                                  "simorgh_branch": None,    # filled in by phase-2
                                  "use_container": True,
                              })
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError as e:
        # Explorer is optional — don't fail init if it isn't up.
        log.warning("explorer_unavailable", error=str(e))
        return {"skipped": True, "reason": str(e)}


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------
async def _run_init(init_id: str, req: InitRequest) -> None:
    s = _init_status[init_id]
    s["status"] = "running"
    steps: list[dict[str, Any]] = []
    # init_project already computed the branch name and stored it on the
    # status dict so the wizard's response echoes the same name we use
    # here. Read it back rather than re-rolling the random suffix.
    simorgh_branch = s.get("simorgh_branch")
    # Branch / tag / SHA the user picked. base_ref wins over the older
    # gitlab_base_branch when both are provided.
    base_ref = req.base_ref or req.gitlab_base_branch
    s["base_ref"] = base_ref

    def _record(step: str, status: str, **extra: Any) -> None:
        steps.append({"step": step, "status": status, **extra})
        s["steps"] = steps

    try:
        async with httpx.AsyncClient(timeout=1800) as client:
            # 1. Start the session container.
            s["current_step"] = "start_container"
            try:
                cont = await _start_container(client, req.project_id)
                _record("start_container", "ok", container=cont.get("container_name"))
            except httpx.HTTPError as e:
                _record("start_container", "error", error=str(e))
                raise

            # 2. Optional: user gitlab repo clone + simorgh branch.
            cloned_ok = False
            if req.sources.gitlab and req.gitlab_repo_url:
                s["current_step"] = "clone_user_repo"
                try:
                    res = await _clone_user_repo(
                        client, req.project_id, req.gitlab_repo_url,
                        base_ref, simorgh_branch,
                    )
                    cloned_ok = True
                    _record("clone_user_repo", "ok",
                            simorgh_branch=simorgh_branch,
                            base_ref=base_ref,
                            exit_code=res.get("exit_code"))
                except httpx.HTTPError as e:
                    _record("clone_user_repo", "error", error=str(e))

            # 2.5 Ingest-time artifact extraction. PDFs, Office docs, and
            #     images become .simorgh/extracted/<path>.md so the CoT
            #     never has to reason on bytes. Safe to skip if the clone
            #     didn't land or doc-processor isn't running.
            if cloned_ok:
                s["current_step"] = "extract_artifacts"
                try:
                    res = await _extract_artifacts(client, req.project_id, simorgh_branch)
                    _record("extract_artifacts", "ok", **{
                        k: v for k, v in res.items() if k != "failures"
                    })
                    if res.get("failed"):
                        log.info("extract_artifacts_failures",
                                 project_id=req.project_id,
                                 failures=res.get("failures", []))
                except Exception as e:
                    _record("extract_artifacts", "error", error=str(e))

            # 2.6 Bulk-index project files into context-search so the
            #     planner's search_context tool actually has something
            #     to find for "what does the doc say about X" queries.
            #     Runs only after a successful clone — there's nothing
            #     to index otherwise. Best-effort: indexing failures
            #     don't block init, the planner can still fall back to
            #     live GitLab reads via read_artifact_mcp.
            if cloned_ok:
                s["current_step"] = "index_for_search"
                try:
                    res = await _index_for_search(
                        client, req.project_id,
                        repo=req.gitlab_repo_path, ref=base_ref,
                    )
                    _record("index_for_search", "ok", **{
                        k: v for k, v in res.items() if k != "errors"
                    })
                    if res.get("errors"):
                        log.info("index_for_search_errors",
                                 project_id=req.project_id,
                                 errors=res.get("errors", []))
                except Exception as e:
                    _record("index_for_search", "error", error=str(e))

            # 3. Optional: TPMS data.
            tpms_oe = req.sources.techserver_oenum or req.oenum
            if req.sources.tpms and tpms_oe:
                s["current_step"] = "pull_tpms"
                try:
                    res = await _pull_tpms(client, req.project_id, tpms_oe,
                                           tpms_auth=req.tpms_auth)
                    _record("pull_tpms", "ok", **res)
                except (httpx.HTTPError, RuntimeError) as e:
                    _record("pull_tpms", "error", error=str(e))

            # 4. Optional: techserver SMB copy.
            if req.sources.techserver and tpms_oe:
                s["current_step"] = "pull_techserver"
                try:
                    res = await _pull_techserver(client, req.project_id, tpms_oe,
                                                 tpms_auth=req.tpms_auth)
                    _record("pull_techserver", "ok", exit_code=res.get("exit_code"))
                except (httpx.HTTPError, RuntimeError) as e:
                    _record("pull_techserver", "error", error=str(e))

            # 5. Optional: EKC clone.
            if req.sources.ekc:
                s["current_step"] = "clone_ekc"
                try:
                    res = await _clone_ekc(client, req.project_id)
                    _record("clone_ekc", "ok", exit_code=res.get("exit_code"))
                except httpx.HTTPError as e:
                    _record("clone_ekc", "error", error=str(e))

            # 6. Uploads dir (always — the fallback).
            s["current_step"] = "ensure_uploads_dir"
            try:
                await _ensure_uploads_dir(client, req.project_id)
                _record("ensure_uploads_dir", "ok")
            except httpx.HTTPError as e:
                _record("ensure_uploads_dir", "error", error=str(e))

            # 7. Kick off the explorer.
            s["current_step"] = "kick_explorer"
            res = await _kick_explorer(client, req)
            _record("kick_explorer", "ok", **res)

        s["status"] = "completed"
        s["completed_at"] = datetime.now(timezone.utc).isoformat()
        log.info("init_done", project_id=req.project_id)

    except Exception as e:
        log.exception("init_failed", project_id=req.project_id, error=str(e))
        s["status"] = "failed"
        s["error"] = str(e)


@app.get("/health")
def health():
    return {"status": "healthy", "service": "project-init", "version": "0.3.0"}


@app.post("/init", response_model=InitResponse)
async def init_project(req: InitRequest, background_tasks: BackgroundTasks):
    init_id = str(uuid.uuid4())
    # Pre-compute the branch name so the response can echo it back to the
    # wizard immediately. _run_init re-derives the same name with the same
    # inputs — there's no clock or random state in flight here.
    scope = req.sources.techserver_oenum or req.oenum or req.project_id
    simorgh_branch = (
        _simorgh_branch_name(scope=scope, hint=req.branch_name_hint)
        if req.sources.gitlab else None
    )
    _init_status[init_id] = {
        "init_id": init_id,
        "project_id": req.project_id,
        "status": "pending",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "simorgh_branch": simorgh_branch,
        "steps": [],
    }
    background_tasks.add_task(_run_init, init_id, req)
    return InitResponse(init_id=init_id, project_id=req.project_id,
                        status="started", message="initialization queued",
                        simorgh_branch=simorgh_branch)


@app.get("/status/{init_id}")
def get_status(init_id: str):
    if init_id not in _init_status:
        raise HTTPException(status_code=404, detail="init_id not found")
    return _init_status[init_id]


# ---------------------------------------------------------------------------
# MCP
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "project-init",
    instructions=(
        "Initialise a project: start its session container, optionally "
        "clone the user's gitlab repo + create a simorgh/<hex> branch, "
        "optionally pull TPMS data, techserver SMB content, or the "
        "ekc-technical-knowledge read-only repo, then kick off the "
        "project-explorer agent."
    ),
)


@mcp.tool()
async def project_init(project_id: str, project_name: str, owner_id: str,
                       gitlab_repo_path: str = "",
                       gitlab_repo_url: str = "",
                       gitlab_base_branch: str = "",
                       enable_gitlab: bool = False,
                       enable_tpms: bool = False,
                       enable_techserver: bool = False,
                       enable_ekc: bool = False,
                       techserver_oenum: str = "") -> dict:
    """Initialise a new project synchronously."""
    init_id = str(uuid.uuid4())
    req = InitRequest(
        project_id=project_id,
        project_name=project_name,
        owner_id=owner_id,
        gitlab_repo_path=gitlab_repo_path or None,
        gitlab_repo_url=gitlab_repo_url or None,
        gitlab_base_branch=gitlab_base_branch or None,
        sources=SourcesEnabled(
            gitlab=enable_gitlab,
            tpms=enable_tpms,
            techserver=enable_techserver,
            techserver_oenum=techserver_oenum or None,
            ekc=enable_ekc,
            upload=True,
        ),
    )
    _init_status[init_id] = {
        "init_id": init_id, "project_id": project_id, "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(), "steps": [],
    }
    await _run_init(init_id, req)
    return _init_status[init_id]


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
