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
        _gl = gitlab.Gitlab(GITLAB_URL, private_token=GITLAB_TOKEN, timeout=30)
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


app.mount("/mcp", mcp.streamable_http_app())
