"""
gitlab-mcp-service
==================
Sole entry point in the simorgh stack to the local GitLab CE instance.
Wraps python-gitlab and exposes both REST + MCP tools used by the agent and
the project-init flow.

Replaces:
  • tech-kb-service (clone of corporate technical-knowledge into shell-service)
  • techserver-service → shell tarball path (now: techserver content lives in
    a GitLab project per oenum, imported once by tools/techserver-importer)

Tools exposed (both REST and MCP):
  • list_projects(group?)                — list projects, optionally filtered to a group
  • get_project_tree(project, ref?, path?) — recursive tree
  • read_file(project, path, ref?)        — file contents (utf-8 or base64)
  • search_blobs(query, project?, group?) — code/text search
  • create_branch(project, branch, ref?)  — branch from ref
  • commit_file(project, branch, path, content, message)
  • open_mr(project, source, target, title, description?)
  • merge_mr(project, mr_iid, squash?)
  • list_pipelines(project, ref?)
  • get_issue(project, issue_iid)

The CoT-friendly tools (read-only) are exposed via MCP without auth wrapping;
the write tools require an X-Agent-Auth header that matches AGENT_TOKEN.
"""
import base64
import os
from typing import Any

import gitlab
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field

from simorgh_logging import configure, get_logger, request_id_middleware

configure(service="gitlab-mcp")
log = get_logger(__name__)

GITLAB_URL          = os.environ["GITLAB_URL"]
GITLAB_TOKEN        = os.environ["GITLAB_TOKEN"]
PROJECTS_GROUP      = os.getenv("GITLAB_PROJECTS_GROUP", "simorgh-projects")
TECH_KB_REPO        = os.getenv("GITLAB_TECH_KB_REPO", "simorgh-knowledge/technical-knowledge")
AGENT_TOKEN         = os.getenv("AGENT_TOKEN", "")    # required for write tools
DEFAULT_REF         = os.getenv("GITLAB_DEFAULT_REF", "main")


# ---------------------------------------------------------------------------
# Lazy GitLab client (lets the service start before GitLab is fully ready).
# ---------------------------------------------------------------------------
_gl: gitlab.Gitlab | None = None


def _client() -> gitlab.Gitlab:
    global _gl
    if _gl is None:
        # keep_base_url=True: after .auth(), python-gitlab would otherwise
        # rewrite the client URL to GitLab's configured external_url
        # (https://simorghai.electrokavir.com/gitlab). Inside the docker
        # network the internal URL (http://gitlab/gitlab) is what we want
        # to keep using — the external one would force TLS through nginx
        # with a self-signed cert and may not even resolve.
        _gl = gitlab.Gitlab(GITLAB_URL, private_token=GITLAB_TOKEN,
                            timeout=30, keep_base_url=True)
        _gl.auth()
    return _gl


def _project(ref: str | int):
    """Resolve a project by 'group/path' or numeric id."""
    return _client().projects.get(ref)


# ---------------------------------------------------------------------------
# REST app
# ---------------------------------------------------------------------------
app = FastAPI(title="gitlab-mcp", version="0.1.0")
app.middleware("http")(request_id_middleware)


def require_agent(x_agent_auth: str | None = Header(default=None)):
    if not AGENT_TOKEN:
        return  # not enforced if not configured
    if x_agent_auth != AGENT_TOKEN:
        raise HTTPException(status_code=403, detail="forbidden")


@app.get("/health")
def health():
    return {"status": "ok", "service": "gitlab-mcp", "gitlab_url": GITLAB_URL}


@app.get("/health/deep")
def health_deep():
    try:
        _client().version()
        return {"status": "ok"}
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))


# ----- Read endpoints -------------------------------------------------------
@app.get("/projects")
def list_projects(group: str | None = None, search: str | None = None, per_page: int = 50):
    gl = _client()
    if group:
        try:
            g = gl.groups.get(group)
        except gitlab.exceptions.GitlabGetError:
            raise HTTPException(status_code=404, detail=f"group {group!r} not found")
        items = g.projects.list(search=search, per_page=per_page, all=False, include_subgroups=True)
    else:
        items = gl.projects.list(search=search, per_page=per_page, all=False)
    return [{"id": p.id, "path": p.path_with_namespace, "name": p.name,
             "default_branch": getattr(p, "default_branch", None),
             "web_url": p.web_url} for p in items]


@app.get("/user-projects")
def list_user_projects(user_token: str | None = None, search: str | None = None,
                       per_page: int = 50,
                       x_user_gitlab_token: str | None = Header(default=None)):
    """List projects the *end user* owns or is a member of on GitLab.

    Requires the end user's personal access token (preferred via the
    `X-User-Gitlab-Token` header; query param `user_token` is a fallback).
    The simorgh agent token is NOT used here — we want the user's own
    visibility, not the service account's.
    """
    token = x_user_gitlab_token or user_token
    if not token:
        raise HTTPException(status_code=401, detail="user gitlab token required")
    try:
        ugl = gitlab.Gitlab(GITLAB_URL, private_token=token, timeout=30,
                            keep_base_url=True)
        ugl.auth()
    except gitlab.exceptions.GitlabAuthenticationError:
        raise HTTPException(status_code=401, detail="invalid gitlab token")
    items = ugl.projects.list(membership=True, search=search, per_page=per_page,
                              order_by="last_activity_at", all=False)
    return [{"id": p.id, "path": p.path_with_namespace, "name": p.name,
             "default_branch": getattr(p, "default_branch", None),
             "web_url": p.web_url,
             "ssh_url": getattr(p, "ssh_url_to_repo", None),
             "http_url": getattr(p, "http_url_to_repo", None)} for p in items]


@app.get("/branches")
def list_branches(project: str, search: str | None = None, per_page: int = 100):
    """List branches for a project. Used by the project-creation wizard so
    the user can pick which branch to clone into the container."""
    p = _project(project)
    items = p.branches.list(search=search, per_page=per_page, all=False)
    return [{"name": b.name,
             "default": getattr(b, "default", False),
             "protected": getattr(b, "protected", False),
             "commit": (b.commit or {}).get("id") if hasattr(b, "commit") else None}
            for b in items]


class DeployKeyRequest(BaseModel):
    project: str
    title: str = "simorgh-chatbot"
    key: str                       # public key, e.g. ssh-ed25519 AAAA... simorgh
    can_push: bool = True


@app.post("/deploy-keys", dependencies=[Depends(require_agent)])
def add_deploy_key(req: DeployKeyRequest):
    """Add the chatbot's public deploy key to a user's project so the
    session container can `git push` to the simorgh working branch.
    This is invoked from the wizard when the user grants access."""
    p = _project(req.project)
    try:
        k = p.keys.create({"title": req.title, "key": req.key, "can_push": req.can_push})
    except gitlab.exceptions.GitlabCreateError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"id": k.id, "title": k.title, "can_push": k.can_push}


@app.get("/access-instructions")
def access_instructions(project: str | None = None):
    """Human-readable guide returned to the wizard when the user has not yet
    granted the chatbot access to their project. The frontend shows this
    inline so the user knows exactly what to do on GitLab."""
    chatbot_pubkey = os.getenv("SIMORGH_DEPLOY_PUBKEY", "")
    return {
        "title": "Grant the chatbot access to your GitLab project",
        "steps": [
            "1. Open your project on GitLab",
            "2. Go to Settings → Repository → Deploy keys",
            "3. Click 'Add deploy key'",
            "4. Title: simorgh-chatbot",
            "5. Paste the public key shown below",
            "6. Tick 'Grant write permissions' so the chatbot can push the simorgh/<hex> working branch",
            "7. Click 'Add key'",
            "8. Return here and re-select your repository",
        ],
        "public_key": chatbot_pubkey or "(SIMORGH_DEPLOY_PUBKEY not configured on the server)",
        "project": project,
    }


@app.get("/tree")
def get_tree(project: str, ref: str = DEFAULT_REF, path: str = "", recursive: bool = True,
             per_page: int = 200):
    p = _project(project)
    items = p.repository_tree(ref=ref, path=path, recursive=recursive, per_page=per_page,
                              get_all=True)
    return {"project": project, "ref": ref, "path": path, "entries": items}


@app.get("/file")
def read_file(project: str, path: str, ref: str = DEFAULT_REF):
    p = _project(project)
    try:
        f = p.files.get(file_path=path, ref=ref)
    except gitlab.exceptions.GitlabGetError as e:
        raise HTTPException(status_code=404, detail=str(e))
    raw = base64.b64decode(f.content)
    try:
        text = raw.decode("utf-8")
        return {"project": project, "path": path, "ref": ref, "encoding": "utf-8",
                "size": len(raw), "content": text}
    except UnicodeDecodeError:
        return {"project": project, "path": path, "ref": ref, "encoding": "base64",
                "size": len(raw), "content": f.content}


@app.get("/search")
def search(query: str = Query(..., min_length=1), project: str | None = None,
           group: str | None = None, scope: str = "blobs"):
    """Search via GitLab's search API. Scope: blobs|commits|issues|merge_requests."""
    gl = _client()
    if project:
        return _project(project).search(scope=scope, search=query)
    if group:
        return gl.groups.get(group).search(scope=scope, search=query)
    return gl.search(scope=scope, search=query)


# ----- Write endpoints (need agent auth) -----------------------------------
class CreateProjectRequest(BaseModel):
    name: str
    namespace: str | None = None      # group full_path; default = PROJECTS_GROUP
    description: str | None = None
    visibility: str = "private"
    initialize_with_readme: bool = True


@app.post("/projects", dependencies=[Depends(require_agent)])
def create_project(req: CreateProjectRequest):
    gl = _client()
    ns_path = req.namespace or PROJECTS_GROUP
    try:
        ns = gl.groups.get(ns_path)
    except gitlab.exceptions.GitlabGetError:
        raise HTTPException(status_code=404, detail=f"namespace {ns_path!r} not found")
    p = gl.projects.create({
        "name": req.name,
        "namespace_id": ns.id,
        "description": req.description or "",
        "visibility": req.visibility,
        "initialize_with_readme": req.initialize_with_readme,
        "default_branch": DEFAULT_REF,
    })
    return {"id": p.id, "path": p.path_with_namespace, "web_url": p.web_url}


class CreateBranchRequest(BaseModel):
    project: str
    branch: str
    ref: str = DEFAULT_REF


@app.post("/branches", dependencies=[Depends(require_agent)])
def create_branch(req: CreateBranchRequest):
    p = _project(req.project)
    b = p.branches.create({"branch": req.branch, "ref": req.ref})
    return {"name": b.name, "commit": b.commit.get("id")}


class CommitFileRequest(BaseModel):
    project: str
    branch: str
    path: str
    content: str
    message: str
    encoding: str = "text"   # text | base64
    author_email: str | None = None
    author_name: str | None = None


@app.post("/commit-file", dependencies=[Depends(require_agent)])
def commit_file(req: CommitFileRequest):
    p = _project(req.project)
    # Try update; on 404 create.
    action = "update"
    try:
        p.files.get(file_path=req.path, ref=req.branch)
    except gitlab.exceptions.GitlabGetError:
        action = "create"
    payload: dict[str, Any] = {
        "branch": req.branch,
        "commit_message": req.message,
        "actions": [{
            "action": action,
            "file_path": req.path,
            "content": req.content,
            "encoding": req.encoding,
        }],
    }
    if req.author_email: payload["author_email"] = req.author_email
    if req.author_name:  payload["author_name"]  = req.author_name
    commit = p.commits.create(payload)
    return {"id": commit.id, "short_id": commit.short_id, "title": commit.title}


class OpenMRRequest(BaseModel):
    project: str
    source_branch: str
    target_branch: str = DEFAULT_REF
    title: str
    description: str = ""
    remove_source_branch: bool = True


@app.post("/merge-requests", dependencies=[Depends(require_agent)])
def open_mr(req: OpenMRRequest):
    p = _project(req.project)
    mr = p.mergerequests.create({
        "source_branch": req.source_branch,
        "target_branch": req.target_branch,
        "title": req.title,
        "description": req.description,
        "remove_source_branch": req.remove_source_branch,
    })
    return {"iid": mr.iid, "web_url": mr.web_url, "state": mr.state}


@app.post("/merge-requests/{project:path}/{mr_iid}/merge",
          dependencies=[Depends(require_agent)])
def merge_mr(project: str, mr_iid: int, squash: bool = False):
    p = _project(project)
    mr = p.mergerequests.get(mr_iid)
    mr.merge(squash=squash)
    return {"iid": mr.iid, "state": mr.state}


# ---------------------------------------------------------------------------
# MCP — read-only surface for agent use
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "gitlab-mcp",
    instructions=(
        "Read GitLab project repositories. Use list_projects to discover, "
        "get_project_tree to browse, read_file for contents, search_blobs "
        "for keyword search across blobs."
    ),
)


@mcp.tool()
async def list_projects_mcp(group: str = "", search_term: str = "") -> list[dict]:
    """List GitLab projects, optionally filtered by group full path or search term."""
    return list_projects(group=group or None, search=search_term or None)


@mcp.tool()
async def get_project_tree(project: str, ref: str = DEFAULT_REF, path: str = "") -> dict:
    """Recursively list files in a project at the given ref + path."""
    return get_tree(project=project, ref=ref, path=path)


@mcp.tool()
async def read_file_mcp(project: str, path: str, ref: str = DEFAULT_REF) -> dict:
    """Read a file from a GitLab project. Returns utf-8 text or base64 if binary."""
    return read_file(project=project, path=path, ref=ref)


@mcp.tool()
async def search_blobs(query: str, project: str = "", group: str = "") -> Any:
    """Full-text search across blobs in a project, group, or globally."""
    return search(query=query, project=project or None, group=group or None, scope="blobs")


@mcp.tool()
async def search_technical_knowledge(query: str) -> Any:
    """Convenience: search the corporate technical-knowledge repo for relevant content."""
    return search(query=query, project=TECH_KB_REPO, scope="blobs")


@mcp.tool()
async def list_branches_mcp(project: str, search_term: str = "") -> list[dict]:
    """List branches in a project. Used by the wizard for branch selection."""
    return list_branches(project=project, search=search_term or None)


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
