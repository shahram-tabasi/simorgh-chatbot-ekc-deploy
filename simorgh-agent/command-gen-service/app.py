"""
Dynamic Command Generation Service
======================================
Generates shell commands (grep, find, awk, etc.) based on COT task descriptions.
The LLM decides WHAT to do, this service translates it into safe shell commands.

Endpoints:
  POST /generate       - Generate commands from task description
  POST /validate       - Validate a command for safety
  GET  /health         - Health check
  /mcp                 - MCP Streamable HTTP endpoint
"""

import logging
import os
import re
from typing import Optional, List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Command Generation Service", version="1.0.0")

# Commands that are always blocked
BLOCKED_PATTERNS = [
    r"rm\s+-rf\s+/",
    r"rm\s+-rf\s+/\*",
    r"mkfs\b",
    r"dd\s+if=",
    r":\(\)\{",
    r"shutdown",
    r"reboot",
    r"halt\b",
    r"poweroff",
    r"chmod\s+-R\s+777\s+/",
    r"curl\s+.*\|\s*sh",
    r"wget\s+.*\|\s*sh",
    r"python\s+-c\s+.*import\s+os",
]


class GenerateRequest(BaseModel):
    task_description: str = Field(..., min_length=1, max_length=2000)
    task_type: str = Field("search", description="search, file_ops, analysis, git")
    project_id: str = Field(...)
    context: Optional[str] = Field(None, description="Additional context for command generation")


class CommandResult(BaseModel):
    command: str
    description: str
    safe: bool
    timeout: int = 30


class GenerateResponse(BaseModel):
    commands: List[CommandResult]
    task_description: str
    warnings: List[str] = []


class ValidateRequest(BaseModel):
    command: str = Field(..., min_length=1)


class ValidateResponse(BaseModel):
    command: str
    safe: bool
    reason: str = ""


def _is_safe(command: str) -> tuple:
    """Check if a command is safe to execute."""
    cmd_lower = command.lower().strip()
    for pattern in BLOCKED_PATTERNS:
        if re.search(pattern, cmd_lower):
            return False, f"Blocked pattern: {pattern}"
    return True, "ok"


def _generate_search_commands(desc: str, project_id: str) -> List[CommandResult]:
    """Generate search commands from description."""
    commands = []
    desc_lower = desc.lower()

    # Pattern extraction
    keywords = []
    for word in desc.split():
        if len(word) > 2 and word.isalpha():
            keywords.append(word)

    if "file" in desc_lower or "find" in desc_lower:
        # File search
        ext = ""
        if "pdf" in desc_lower:
            ext = "-name '*.pdf'"
        elif "excel" in desc_lower or "xlsx" in desc_lower:
            ext = "-name '*.xlsx' -o -name '*.xls'"
        elif "word" in desc_lower or "docx" in desc_lower:
            ext = "-name '*.docx'"
        elif "markdown" in desc_lower or ".md" in desc_lower:
            ext = "-name '*.md'"
        else:
            ext = "-type f"

        commands.append(CommandResult(
            command=f"find . {ext} 2>/dev/null | head -50",
            description=f"Find files matching pattern",
            safe=True,
        ))

    if keywords and ("search" in desc_lower or "grep" in desc_lower or "find" in desc_lower or "content" in desc_lower):
        # Content search
        search_term = keywords[-1] if keywords else "TODO"
        commands.append(CommandResult(
            command=f"grep -r -i -l '{search_term}' . --include='*.md' --include='*.txt' 2>/dev/null | head -20",
            description=f"Search for '{search_term}' in text files",
            safe=True,
        ))

    if "size" in desc_lower or "large" in desc_lower:
        commands.append(CommandResult(
            command="find . -type f -exec du -h {} + 2>/dev/null | sort -rh | head -20",
            description="Find largest files",
            safe=True,
        ))

    if "tree" in desc_lower or "structure" in desc_lower:
        commands.append(CommandResult(
            command="find . -type d 2>/dev/null | head -30",
            description="Show directory structure",
            safe=True,
        ))

    if not commands:
        commands.append(CommandResult(
            command="ls -la",
            description="List files in project root",
            safe=True,
        ))

    return commands


def _generate_analysis_commands(desc: str, project_id: str) -> List[CommandResult]:
    """Generate analysis commands."""
    commands = []
    desc_lower = desc.lower()

    commands.append(CommandResult(
        command="wc -l $(find . -type f -name '*.md' -o -name '*.txt' 2>/dev/null) 2>/dev/null | tail -1",
        description="Count total lines in text files",
        safe=True,
    ))

    if "count" in desc_lower:
        commands.append(CommandResult(
            command="find . -type f 2>/dev/null | wc -l",
            description="Count total files",
            safe=True,
        ))

    if "disk" in desc_lower or "space" in desc_lower:
        commands.append(CommandResult(
            command="du -sh . 2>/dev/null",
            description="Total disk usage",
            safe=True,
        ))

    return commands


def _generate_file_ops_commands(desc: str, project_id: str) -> List[CommandResult]:
    """Generate file operation commands."""
    commands = []
    desc_lower = desc.lower()

    if "create" in desc_lower and "dir" in desc_lower:
        # Extract directory name (best effort)
        commands.append(CommandResult(
            command="mkdir -p new_directory",
            description="Create directory",
            safe=True,
        ))

    if "list" in desc_lower:
        commands.append(CommandResult(
            command="ls -la",
            description="List files",
            safe=True,
        ))

    if "read" in desc_lower or "cat" in desc_lower:
        commands.append(CommandResult(
            command="cat README.md 2>/dev/null || echo 'File not found'",
            description="Read README",
            safe=True,
        ))

    return commands


def _generate_git_commands(desc: str, project_id: str) -> List[CommandResult]:
    """Generate git commands."""
    commands = []
    desc_lower = desc.lower()

    if "log" in desc_lower or "history" in desc_lower:
        commands.append(CommandResult(
            command="git log --oneline -20 2>/dev/null",
            description="Show git history",
            safe=True,
        ))

    if "status" in desc_lower:
        commands.append(CommandResult(
            command="git status 2>/dev/null",
            description="Show git status",
            safe=True,
        ))

    if "diff" in desc_lower:
        commands.append(CommandResult(
            command="git diff --stat 2>/dev/null",
            description="Show changed files",
            safe=True,
        ))

    if not commands:
        commands.append(CommandResult(
            command="git status && git log --oneline -5 2>/dev/null",
            description="Git overview",
            safe=True,
        ))

    return commands


@app.get("/health")
async def health():
    return {"status": "healthy", "service": "command-gen"}


@app.post("/generate", response_model=GenerateResponse)
async def generate_commands(req: GenerateRequest):
    """Generate shell commands from a task description."""
    generators = {
        "search": _generate_search_commands,
        "file_ops": _generate_file_ops_commands,
        "analysis": _generate_analysis_commands,
        "git": _generate_git_commands,
    }

    gen_func = generators.get(req.task_type, _generate_search_commands)
    commands = gen_func(req.task_description, req.project_id)

    # Validate all generated commands
    warnings = []
    safe_commands = []
    for cmd in commands:
        is_safe, reason = _is_safe(cmd.command)
        cmd.safe = is_safe
        if is_safe:
            safe_commands.append(cmd)
        else:
            warnings.append(f"Blocked: {cmd.command} ({reason})")

    return GenerateResponse(
        commands=safe_commands,
        task_description=req.task_description,
        warnings=warnings,
    )


@app.post("/validate", response_model=ValidateResponse)
async def validate_command(req: ValidateRequest):
    """Validate if a command is safe to execute."""
    is_safe, reason = _is_safe(req.command)
    return ValidateResponse(command=req.command, safe=is_safe, reason=reason)


# =============================================================================
# MCP Server - Exposes command generation tools via Model Context Protocol
# =============================================================================
mcp = FastMCP("command-gen", instructions="Generate safe shell commands from task descriptions")


@mcp.tool()
def command_generate(task_description: str, project_id: str,
                     task_type: str = "search", context: str = None) -> str:
    """Generate safe shell commands from a task description. task_type: search, file_ops, analysis, git."""
    import json as _json
    generators = {
        "search": _generate_search_commands,
        "file_ops": _generate_file_ops_commands,
        "analysis": _generate_analysis_commands,
        "git": _generate_git_commands,
    }
    gen_func = generators.get(task_type, _generate_search_commands)
    commands = gen_func(task_description, project_id)

    warnings = []
    safe_commands = []
    for cmd in commands:
        is_safe, reason = _is_safe(cmd.command)
        cmd.safe = is_safe
        if is_safe:
            safe_commands.append(cmd)
        else:
            warnings.append(f"Blocked: {cmd.command} ({reason})")

    result = {
        "commands": [{"command": c.command, "description": c.description,
                       "safe": c.safe, "timeout": c.timeout} for c in safe_commands],
        "task_description": task_description,
        "warnings": warnings,
    }
    return _json.dumps(result)


@mcp.tool()
def command_validate(command: str) -> str:
    """Validate if a shell command is safe to execute. Returns JSON with safe (bool) and reason."""
    import json as _json
    is_safe, reason = _is_safe(command)
    return _json.dumps({"command": command, "safe": is_safe, "reason": reason})


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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8024)
