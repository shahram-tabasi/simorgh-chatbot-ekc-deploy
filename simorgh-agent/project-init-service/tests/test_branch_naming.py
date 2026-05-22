"""Tests for the simorgh branch naming helpers.

Module imports the helpers by AST extraction so we don't pull in the
service's full dependency tree (mcp, simorgh_logging, httpx, …) just to
test pure-python functions.
"""

import ast
import re
import secrets
import sys
from pathlib import Path

APP_PY = Path(__file__).resolve().parents[1] / "app.py"


def _load_helpers():
    src = APP_PY.read_text()
    tree = ast.parse(src)
    ns = {"re": re, "secrets": secrets}
    # Constants and helpers in dependency order.
    ns["_BRANCH_SAFE_RE"] = re.compile(r"[^a-zA-Z0-9._-]+")
    for fn_name in ("_sanitize_branch_segment", "_simorgh_branch_name"):
        node = next(
            n for n in tree.body
            if isinstance(n, ast.FunctionDef) and n.name == fn_name
        )
        exec(ast.unparse(node), ns)
    return ns["_sanitize_branch_segment"], ns["_simorgh_branch_name"]


sanitize, branch_name = _load_helpers()


# ---------------------------------------------------------------------------
# _sanitize_branch_segment
# ---------------------------------------------------------------------------
def test_sanitize_replaces_spaces_with_dashes():
    assert sanitize("Panel A redesign") == "panel-a-redesign"


def test_sanitize_strips_punctuation():
    assert sanitize("Panel-A: 'redesign'!") == "panel-a-redesign"


def test_sanitize_collapses_slashes():
    assert sanitize("a/b/c") == "a-b-c"


def test_sanitize_keeps_safe_punctuation():
    assert sanitize("v1.2.3_final-rc1") == "v1.2.3_final-rc1"


def test_sanitize_lowercases():
    assert sanitize("ABC") == "abc"


def test_sanitize_falls_back_to_work():
    assert sanitize("") == "work"
    assert sanitize("    ") == "work"
    assert sanitize("///") == "work"


def test_sanitize_caps_length():
    out = sanitize("a" * 200)
    assert len(out) == 40


def test_sanitize_strips_leading_trailing_dot_or_dash():
    assert sanitize(".hidden.") == "hidden"
    assert sanitize("-leading") == "leading"


# ---------------------------------------------------------------------------
# _simorgh_branch_name
# ---------------------------------------------------------------------------
def test_branch_name_default_shape():
    name = branch_name()
    assert name.startswith("simorgh/")
    assert name.count("/") == 1
    suffix = name.split("/", 1)[1]
    assert re.fullmatch(r"[0-9a-f]{6}", suffix), suffix


def test_branch_name_with_scope():
    name = branch_name(scope="12345")
    assert name.startswith("simorgh/12345/")
    suffix = name.rsplit("/", 1)[1]
    assert re.fullmatch(r"[0-9a-f]{6}", suffix)


def test_branch_name_with_hint_appends_hex():
    name = branch_name(scope="12345", hint="Panel A redesign")
    assert name.startswith("simorgh/12345/panel-a-redesign-")
    hex_part = name.rsplit("-", 1)[-1]
    assert re.fullmatch(r"[0-9a-f]{6}", hex_part)


def test_branch_name_two_calls_differ_for_same_hint():
    # The whole point of the hex suffix is collision avoidance — two
    # projects with the same hint must end up on distinct branches.
    a = branch_name(scope="12345", hint="rev")
    b = branch_name(scope="12345", hint="rev")
    assert a != b
    assert a.rsplit("-", 1)[0] == b.rsplit("-", 1)[0]


def test_branch_name_scope_is_also_sanitized():
    name = branch_name(scope="oenum/with-slash")
    # The scope is run through sanitize → no embedded slash in the
    # middle segment.
    parts = name.split("/")
    assert len(parts) == 3, parts
    assert "/" not in parts[1]


def test_branch_name_hint_empty_falls_back_to_hex_only():
    name = branch_name(scope="12345", hint="")
    parts = name.rsplit("/", 1)
    assert re.fullmatch(r"[0-9a-f]{6}", parts[1])
