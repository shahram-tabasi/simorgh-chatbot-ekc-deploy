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
"""

import logging
import os
import uuid
from datetime import datetime
from typing import Optional, Dict, Any, List

import httpx
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Project Analysis Service", version="1.0.0")

SHELL_SERVICE_URL = os.getenv("SHELL_SERVICE_URL", "http://192.168.1.69:8010")
SHELL_SERVICE_TOKEN = os.getenv("SHELL_SERVICE_TOKEN", "")

_reports: Dict[str, Dict] = {}


class AnalyzeRequest(BaseModel):
    project_id: str = Field(...)
    depth: str = Field("medium", description="quick, medium, or thorough")


class AnalyzeResponse(BaseModel):
    report_id: str
    project_id: str
    status: str
    message: str


def _shell_headers():
    h = {}
    if SHELL_SERVICE_TOKEN:
        h["Authorization"] = f"Bearer {SHELL_SERVICE_TOKEN}"
    return h


async def _run_analysis(report_id: str, req: AnalyzeRequest):
    """Background: analyze project workspace."""
    report = _reports[report_id]
    report["status"] = "running"

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            # Step 1: List all files
            resp = await client.post(
                f"{SHELL_SERVICE_URL}/file/list",
                json={"project_id": req.project_id, "path": ".", "recursive": True},
                headers=_shell_headers(),
            )
            resp.raise_for_status()
            file_list = resp.json().get("files", [])

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

            # Step 2: Read key files (README, config files)
            key_files_content = {}
            key_patterns = ["README.md", "requirements.txt", "package.json",
                            "Dockerfile", "docker-compose.yml", ".gitignore",
                            "tpms_project_data.md"]

            for f in file_list:
                path = f["path"]
                name = path.split("/")[-1]
                if name in key_patterns and not f.get("is_dir"):
                    try:
                        resp = await client.post(
                            f"{SHELL_SERVICE_URL}/file/read",
                            json={"project_id": req.project_id, "path": path},
                            headers=_shell_headers(),
                        )
                        if resp.status_code == 200:
                            content = resp.json().get("content", "")
                            key_files_content[path] = content[:2000]
                    except Exception:
                        pass

            # Step 3: Get git history
            git_log = []
            try:
                resp = await client.post(
                    f"{SHELL_SERVICE_URL}/git/log",
                    json={"project_id": req.project_id, "limit": 10},
                    headers=_shell_headers(),
                )
                if resp.status_code == 200:
                    git_log = resp.json().get("commits", [])
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8023)
