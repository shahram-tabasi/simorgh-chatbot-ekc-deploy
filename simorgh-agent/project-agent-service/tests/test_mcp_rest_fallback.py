"""Tests for MCPManager._gitlab_rest_recipe.

Pure dict-mapping logic — exercises every gitlab-mcp tool's REST
translation without touching the MCP transport, httpx, or a live
GitLab. Extracts the method via AST so we don't need to construct
the full MCPManager (which requires asyncio/MCP/etc.)."""

import ast
import os
import sys
import types
from pathlib import Path

SRC_FILE = (Path(__file__).resolve().parents[1]
            / "services" / "mcp_manager.py").read_text()


def _load_recipe():
    tree = ast.parse(SRC_FILE)
    # Pull the method body out of MCPManager.
    cls = next(n for n in tree.body
               if isinstance(n, ast.ClassDef) and n.name == "MCPManager")
    fn = next(item for item in cls.body
              if isinstance(item, ast.FunctionDef)
              and item.name == "_gitlab_rest_recipe")
    ns = {"os": os, "Optional": __import__("typing").Optional,
          "Dict": dict, "Any": object}
    exec(ast.unparse(fn), ns)
    return ns["_gitlab_rest_recipe"]


_recipe = _load_recipe()


class _FakeSelf:
    GITLAB_MCP_REST_BASE = "http://gitlab-mcp:8047"
    TECH_KB_REPO         = "simorgh-knowledge/technical-knowledge"


# ---------------------------------------------------------------------------
def test_get_project_tree():
    method, url, params = _recipe(_FakeSelf(),
        "get_project_tree", {"project": "shahram-tabasi/mci", "ref": "main"})
    assert method == "GET"
    assert url.endswith("/tree")
    assert params["project"] == "shahram-tabasi/mci"
    assert params["ref"] == "main"
    assert params["recursive"] == "true"


def test_get_project_tree_default_ref():
    _, _, params = _recipe(_FakeSelf(),
        "get_project_tree", {"project": "g/r"})
    assert params["ref"] == "main"


def test_read_artifact_mcp_includes_path():
    method, url, params = _recipe(_FakeSelf(),
        "read_artifact_mcp",
        {"project": "g/r", "path": "docs/spec.pdf", "ref": "main"})
    assert method == "GET"
    assert url.endswith("/artifact")
    assert params == {"project": "g/r", "path": "docs/spec.pdf", "ref": "main"}


def test_read_file_mcp_includes_path():
    _, url, params = _recipe(_FakeSelf(),
        "read_file_mcp", {"project": "g/r", "path": "README.md"})
    assert url.endswith("/file")
    assert params["path"] == "README.md"
    assert params["ref"] == "main"


def test_search_blobs_passthrough():
    _, url, params = _recipe(_FakeSelf(),
        "search_blobs", {"query": "VFD", "project": "g/r"})
    assert url.endswith("/search")
    assert params["query"] == "VFD"
    assert params["project"] == "g/r"
    assert params["scope"] == "blobs"


def test_search_technical_knowledge_hardcoded_repo():
    _, url, params = _recipe(_FakeSelf(),
        "search_technical_knowledge", {"query": "IEC 61439"})
    assert params["project"] == "simorgh-knowledge/technical-knowledge"
    assert params["scope"] == "blobs"


def test_list_projects_supports_group_and_search():
    _, _, params = _recipe(_FakeSelf(),
        "list_projects_mcp", {"group": "simorgh-projects", "search_term": "mci"})
    assert params["group"] == "simorgh-projects"
    assert params["search"] == "mci"


def test_list_branches_takes_search_term():
    _, url, params = _recipe(_FakeSelf(),
        "list_branches_mcp", {"project": "g/r", "search_term": "simorgh/"})
    assert url.endswith("/branches")
    assert params["project"] == "g/r"
    assert params["search"] == "simorgh/"


def test_unknown_tool_returns_none():
    assert _recipe(_FakeSelf(), "no_such_tool", {}) is None
    # MCP tools not in the gitlab fallback set also return None.
    assert _recipe(_FakeSelf(), "create_branch", {"project": "g/r"}) is None
    assert _recipe(_FakeSelf(), "commit_file", {}) is None


def test_base_url_can_be_overridden():
    class _Self:
        GITLAB_MCP_REST_BASE = "http://gitlab-mcp.staging:8047"
        TECH_KB_REPO         = "x/y"
    _, url, _ = _recipe(_Self(), "get_project_tree", {"project": "g/r"})
    assert url == "http://gitlab-mcp.staging:8047/tree"


def test_trailing_slash_on_base_is_normalised():
    class _Self:
        GITLAB_MCP_REST_BASE = "http://gitlab-mcp:8047/"
        TECH_KB_REPO         = "x/y"
    _, url, _ = _recipe(_Self(), "get_project_tree", {"project": "g/r"})
    assert url == "http://gitlab-mcp:8047/tree"
