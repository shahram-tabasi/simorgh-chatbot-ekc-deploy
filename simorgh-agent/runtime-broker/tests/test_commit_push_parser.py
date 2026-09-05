"""Tests for _parse_commit_push_output.

Loads the helper by AST extraction so the test doesn't pull in the
service's docker / mcp / pydantic deps.
"""

import ast
from pathlib import Path


def _load_parser():
    src = (Path(__file__).resolve().parents[1] / "app.py").read_text()
    tree = ast.parse(src)
    fn = next(n for n in tree.body
              if isinstance(n, ast.FunctionDef) and n.name == "_parse_commit_push_output")
    ns: dict = {}
    exec(ast.unparse(fn), ns)
    return ns["_parse_commit_push_output"]


parse = _load_parser()


def test_clean_success():
    stdout = (
        "__SIMORGH_COMMIT__:abc123:simorgh/12345/work\n"
        "__SIMORGH_PUSH_OK__\n"
    )
    committed, pushed, conflict, sha, branch = parse(stdout, "")
    assert committed is True
    assert pushed is True
    assert conflict is False
    assert sha == "abc123"
    assert branch == "simorgh/12345/work"


def test_no_changes_returns_none_committed():
    stdout = "__SIMORGH_NO_CHANGES__\n"
    committed, pushed, conflict, sha, branch = parse(stdout, "")
    assert committed is False
    assert pushed is False
    assert conflict is False
    assert sha is None
    assert branch is None


def test_commit_ok_push_fail_non_fast_forward_flagged_as_conflict():
    stdout = (
        "__SIMORGH_COMMIT__:def456:simorgh/12345/work\n"
        "__SIMORGH_PUSH_FAIL__\n"
    )
    stderr = (
        " ! [rejected]        simorgh/12345/work -> simorgh/12345/work (non-fast-forward)\n"
        "error: failed to push some refs; hint: fetch first\n"
    )
    committed, pushed, conflict, sha, _ = parse(stdout, stderr)
    assert committed is True
    assert pushed is False
    assert conflict is True
    assert sha == "def456"


def test_commit_ok_push_fail_other_error_not_conflict():
    stdout = (
        "__SIMORGH_COMMIT__:111:simorgh/12345/work\n"
        "__SIMORGH_PUSH_FAIL__\n"
    )
    stderr = "fatal: could not read from remote repository\n"
    committed, pushed, conflict, _, _ = parse(stdout, stderr)
    assert committed is True
    assert pushed is False
    assert conflict is False


def test_malformed_commit_line_still_flags_committed():
    # Sometimes the script gets truncated mid-print. Should still say
    # something was committed so the caller's requires_human_review
    # logic kicks in.
    stdout = "__SIMORGH_COMMIT__:partial\n__SIMORGH_PUSH_FAIL__\n"
    committed, pushed, _, _, _ = parse(stdout, "")
    assert committed is True
    assert pushed is False
