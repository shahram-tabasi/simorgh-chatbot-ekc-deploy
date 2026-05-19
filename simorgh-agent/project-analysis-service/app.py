"""
Project Analysis Service
==========================
Claude Code-style autonomous project analysis.
Scans a project workspace (via shell-service) to build a comprehensive
understanding: file tree, key files, patterns, and summary.

Endpoints:
  POST /analyze          - Analyze a project workspace
  GET  /report/{id}      - Get analysis report
  GET  /health           - Health check
  /mcp                   - MCP Streamable HTTP endpoint
"""

import logging
import os
import uuid
from datetime import datetime
from typing import Optional, Dict, Any, List

import httpx
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field
from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Project Analysis Service", version="1.0.0")

# 2026-05: shell-service retired. We now talk to the per-project session
# container via runtime-broker /sessions/{project_id}/exec for tree
# listing, file reads, and git log.
RUNTIME_BROKER_URL   = os.getenv("RUNTIME_BROKER_URL", "http://runtime-broker:8048")
RUNTIME_BROKER_TOKEN = os.getenv("BROKER_TOKEN", "")

_reports: Dict[str, Dict] = {}


class AnalyzeRequest(BaseModel):
    project_id: str = Field(...)
    depth: str = Field("medium", description="quick, medium, or thorough")


class AnalyzeResponse(BaseModel):
    report_id: str
    project_id: str
    status: str
    message: str


def _broker_headers():
    return ({"authorization": f"Bearer {RUNTIME_BROKER_TOKEN}"}
            if RUNTIME_BROKER_TOKEN else {})


async def _broker_exec(client: httpx.AsyncClient, project_id: str,
                       command: str, timeout_sec: int = 60) -> dict:
    r = await client.post(
        f"{RUNTIME_BROKER_URL}/sessions/{project_id}/exec",
        json={"command": command, "timeout_sec": timeout_sec},
        headers=_broker_headers(),
    )
    r.raise_for_status()
    return r.json()


async def _run_analysis(report_id: str, req: AnalyzeRequest):
    """Background: analyze project workspace inside its session container."""
    report = _reports[report_id]
    report["status"] = "running"

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            # Step 1: list all files via the container (gitlab clone lives
            # at /work/gitlab when a repo was selected, otherwise /work).
            ls_cmd = (
                "( [ -d /work/gitlab ] && cd /work/gitlab || cd /work ) && "
                "find . -not -path '*/\\.git/*' -printf '%y\\t%s\\t%p\\n'"
            )
            ls = await _broker_exec(client, req.project_id, ls_cmd, timeout_sec=60)
            file_list = []
            for line in (ls.get("stdout") or "").splitlines():
                parts = line.split("\t", 2)
                if len(parts) != 3:
                    continue
                kind, size, path = parts
                file_list.append({
                    "path": path.lstrip("./"),
                    "is_dir": kind == "d",
                    "size": int(size) if size.isdigit() else 0,
                })

            # Build file tree
            tree_lines = []
            dirs = set()
            files_by_ext: Dict[str, int] = {}
            total_size = 0

            for f in file_list:
                path = f["path"]
                is_dir = f.get("is_dir", False)
                size = f.get("size", 0)

                if is_dir:
                    dirs.add(path)
                else:
                    ext = path.rsplit(".", 1)[-1] if "." in path else "no_ext"
                    files_by_ext[ext] = files_by_ext.get(ext, 0) + 1
                    total_size += size

                indent = "  " * path.count("/")
                name = path.split("/")[-1]
                icon = "/" if is_dir else ""
                tree_lines.append(f"{indent}{name}{icon}")

            # Step 2: read key files via the container.
            key_files_content = {}
            key_patterns = ["README.md", "requirements.txt", "package.json",
                            "Dockerfile", "docker-compose.yml", ".gitignore",
                            "tpms_project_data.md"]

            for f in file_list:
                path = f["path"]
                name = path.split("/")[-1]
                if name in key_patterns and not f.get("is_dir"):
                    try:
                        r2 = await client.get(
                            f"{RUNTIME_BROKER_URL}/sessions/{req.project_id}/read_file",
                            params={"path": path if path.startswith("gitlab/")
                                    else f"gitlab/{path}"},
                            headers=_broker_headers(),
                        )
                        if r2.status_code == 200 and r2.json().get("encoding") == "utf-8":
                            key_files_content[path] = (r2.json().get("content", ""))[:2000]
                    except Exception:
                        pass

            # Step 3: git log via the container.
            git_log = []
            try:
                gl = await _broker_exec(
                    client, req.project_id,
                    "cd /work/gitlab 2>/dev/null && "
                    "git log -n 10 --pretty=format:'%H%x09%an%x09%s'",
                    timeout_sec=30,
                )
                for line in (gl.get("stdout") or "").splitlines():
                    h, author, subject = (line.split("\t", 2) + ["", ""])[:3]
                    if h:
                        git_log.append({"sha": h, "author": author, "subject": subject})
            except Exception:
                pass

            # Build summary
            summary_parts = [
                f"# Project Analysis Report",
                f"Project ID: {req.project_id}",
                f"Analyzed at: {datetime.utcnow().isoformat()}",
                f"",
                f"## Overview",
                f"- Total files: {len([f for f in file_list if not f.get('is_dir')])}",
                f"- Total directories: {len(dirs)}",
                f"- Total size: {total_size:,} bytes",
                f"- Git commits: {len(git_log)}",
                f"",
                f"## File Types",
            ]
            for ext, count in sorted(files_by_ext.items(), key=lambda x: -x[1]):
                summary_parts.append(f"  .{ext}: {count} files")

            summary_parts.append("")
            summary_parts.append("## File Tree")
            summary_parts.extend(tree_lines[:100])  # Limit tree output

            if key_files_content:
                summary_parts.append("")
                summary_parts.append("## Key Files")
                for path, content in key_files_content.items():
                    summary_parts.append(f"\n### {path}")
                    summary_parts.append(f"```\n{content}\n```")

            if git_log:
                summary_parts.append("")
                summary_parts.append("## Recent Git History")
                for c in git_log:
                    summary_parts.append(f"- {c.get('hash', '?')[:8]} {c.get('message', '')}")

            report["status"] = "completed"
            report["summary"] = "\n".join(summary_parts)
            report["stats"] = {
                "total_files": len([f for f in file_list if not f.get("is_dir")]),
                "total_dirs": len(dirs),
                "total_size": total_size,
                "file_types": files_by_ext,
                "git_commits": len(git_log),
                "key_files": list(key_files_content.keys()),
            }
            report["completed_at"] = datetime.utcnow().isoformat()
            logger.info(f"Analysis completed: {req.project_id}")

    except Exception as e:
        logger.error(f"Analysis failed: {e}", exc_info=True)
        report["status"] = "failed"
        report["error"] = str(e)


@app.get("/health")
async def health():
    return {"status": "healthy", "service": "project-analysis"}


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze_project(req: AnalyzeRequest, background_tasks: BackgroundTasks):
    """Start project workspace analysis."""
    report_id = str(uuid.uuid4())
    _reports[report_id] = {
        "report_id": report_id,
        "project_id": req.project_id,
        "status": "pending",
        "started_at": datetime.utcnow().isoformat(),
    }

    background_tasks.add_task(_run_analysis, report_id, req)

    return AnalyzeResponse(
        report_id=report_id,
        project_id=req.project_id,
        status="started",
        message="Analysis started",
    )


@app.get("/report/{report_id}")
async def get_report(report_id: str):
    """Get analysis report."""
    if report_id not in _reports:
        raise HTTPException(status_code=404, detail="Report not found")
    return _reports[report_id]


# =============================================================================
# MCP Server - Exposes project analysis tool via Model Context Protocol
# =============================================================================
mcp = FastMCP("project-analysis", instructions="Analyze project workspace structure and contents")


@mcp.tool()
async def project_analyze(project_id: str, depth: str = "medium") -> str:
    """Analyze a project workspace. Returns file tree, key files, git history, and summary. Depth: quick, medium, thorough."""
    import json as _json
    report_id = str(uuid.uuid4())
    _reports[report_id] = {
        "report_id": report_id, "project_id": project_id,
        "status": "running", "started_at": datetime.utcnow().isoformat(),
    }
    req = AnalyzeRequest(project_id=project_id, depth=depth)
    await _run_analysis(report_id, req)
    report = _reports[report_id]
    if report.get("status") == "completed":
        return report.get("summary", _json.dumps(report, default=str))
    return _json.dumps(report, default=str)


app.mount("/mcp", mcp.streamable_http_app())

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8023)
