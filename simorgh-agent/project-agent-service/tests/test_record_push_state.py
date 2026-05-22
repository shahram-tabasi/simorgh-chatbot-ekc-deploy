"""Tests for shell_service._record_push_state.

The method writes branch state (branch_pushed / push_conflict /
pending_commit_sha / last_push_sha) into a project's metadata so the
sidebar's runtime_status picker sees the right icon. We exercise it by
extracting the function via AST (so we don't pull the full service's
heavy deps — httpx, psycopg, etc.) and feeding it a fake memory
service.
"""

import ast
import asyncio
import sys
import types
from pathlib import Path


SHELL_PY = Path(__file__).resolve().parents[1] / "services" / "shell_service.py"


def _load_record_push_state():
    """Pull just _record_push_state out of shell_service.py and bind it
    to a fake `self` so we don't have to construct the real client."""
    src = SHELL_PY.read_text()
    tree = ast.parse(src)

    fn_node = None
    for cls in tree.body:
        if isinstance(cls, ast.ClassDef):
            for item in cls.body:
                if (isinstance(item, ast.AsyncFunctionDef)
                        and item.name == "_record_push_state"):
                    fn_node = item
                    break
        if fn_node:
            break
    assert fn_node is not None, "_record_push_state not found in shell_service"

    # Re-emit as a free-standing async function (drops `self`).
    fn_src = ast.unparse(fn_node)
    ns: dict = {}
    exec(fn_src, ns)
    return ns["_record_push_state"]


_record_push_state = _load_record_push_state()


class _FakeMemory:
    def __init__(self, initial_meta: dict | None = None):
        self.meta = dict(initial_meta or {})
        self.updates: list[dict] = []

    async def get_project(self, project_id: str) -> dict:
        return {"id": project_id, "metadata": dict(self.meta)}

    async def update_project(self, project_id: str, **kwargs):
        if "metadata" in kwargs:
            self.meta = kwargs["metadata"]
            self.updates.append(dict(kwargs["metadata"]))
        return {"id": project_id, **kwargs}


def _install_memory_module(memory: _FakeMemory) -> None:
    """Inject a fake services.project_memory_service module so the
    function's `from services.project_memory_service import …` resolves."""
    mod = types.ModuleType("services.project_memory_service")
    mod.get_project_memory_service = lambda: memory
    # services namespace must exist for the relative import to land.
    sys.modules.setdefault("services", types.ModuleType("services"))
    sys.modules["services.project_memory_service"] = mod


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ---------------------------------------------------------------------------
# Successful push
# ---------------------------------------------------------------------------
def test_push_success_sets_pushed_and_clears_conflict():
    mem = _FakeMemory({"push_conflict": True, "pending_commit_sha": "old"})
    _install_memory_module(mem)
    result = {
        "pushed": True, "committed": True, "conflict": False,
        "commit_sha": "abc123", "branch": "simorgh/12345/work",
    }
    _run(_record_push_state(None, "proj-uuid", result))
    assert mem.meta["branch_pushed"] is True
    assert mem.meta["last_push_sha"] == "abc123"
    assert mem.meta["last_push_branch"] == "simorgh/12345/work"
    assert "push_conflict" not in mem.meta
    assert "pending_commit_sha" not in mem.meta


# ---------------------------------------------------------------------------
# Push rejected → conflict
# ---------------------------------------------------------------------------
def test_push_conflict_sets_flag_and_pending_sha():
    mem = _FakeMemory({"branch_pushed": True, "last_push_sha": "stale"})
    _install_memory_module(mem)
    result = {
        "pushed": False, "committed": True, "conflict": True,
        "requires_human_review": True,
        "commit_sha": "def456", "branch": "simorgh/12345/work",
    }
    _run(_record_push_state(None, "proj-uuid", result))
    assert mem.meta["push_conflict"] is True
    assert mem.meta["pending_commit_sha"] == "def456"
    # branch_pushed should stay (it was true before) — the conflict
    # bit is what wins the icon picker.
    assert mem.meta.get("branch_pushed") is True


# ---------------------------------------------------------------------------
# requires_human_review without explicit conflict still flagged
# ---------------------------------------------------------------------------
def test_requires_review_without_conflict_still_flags():
    mem = _FakeMemory({})
    _install_memory_module(mem)
    result = {
        "pushed": False, "committed": True, "conflict": False,
        "requires_human_review": True,
        "commit_sha": "abc", "branch": "x",
    }
    _run(_record_push_state(None, "proj-uuid", result))
    assert mem.meta["push_conflict"] is True
    assert mem.meta["pending_commit_sha"] == "abc"


# ---------------------------------------------------------------------------
# No-op: nothing to commit, prior metadata preserved
# ---------------------------------------------------------------------------
def test_no_commit_no_metadata_change():
    mem = _FakeMemory({"branch_pushed": True, "last_push_sha": "keep"})
    _install_memory_module(mem)
    result = {
        "pushed": False, "committed": False, "conflict": False,
        "requires_human_review": False,
    }
    _run(_record_push_state(None, "proj-uuid", result))
    # Untouched — no update_project call.
    assert mem.updates == []
    assert mem.meta == {"branch_pushed": True, "last_push_sha": "keep"}


# ---------------------------------------------------------------------------
# Project missing → silent no-op
# ---------------------------------------------------------------------------
def test_missing_project_is_silent():
    class _NoProject(_FakeMemory):
        async def get_project(self, project_id):
            return None

    mem = _NoProject()
    _install_memory_module(mem)
    _run(_record_push_state(None, "missing", {"pushed": True, "commit_sha": "x"}))
    assert mem.updates == []


# ---------------------------------------------------------------------------
# String metadata (jsonb stringified) is parsed before patching
# ---------------------------------------------------------------------------
def test_string_metadata_is_parsed():
    import json
    mem = _FakeMemory()
    # Override get_project to return string-shaped metadata.
    async def get(_self_pid):
        return {"id": "p", "metadata": json.dumps({"existing": "value"})}
    mem.get_project = get  # type: ignore
    _install_memory_module(mem)

    _run(_record_push_state(None, "p", {
        "pushed": True, "committed": True, "commit_sha": "abc", "branch": "br",
    }))
    assert mem.meta.get("existing") == "value"
    assert mem.meta["branch_pushed"] is True
