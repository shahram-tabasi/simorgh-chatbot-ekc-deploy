"""Tests for the simorgh_graph AGE client.

These tests focus on the pure parts — agtype decoding, identifier
validation, query string assembly — without requiring a live Postgres.
The integration tests against a real apache/age container live next to
the compose file and run only when ``AGE_DSN`` is set in CI.
"""

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from simorgh_graph import AgeClient, _decode_agtype, _strip_agtype  # noqa: E402


def test_strip_agtype_removes_type_suffix():
    assert _strip_agtype("42::integer") == "42"
    assert _strip_agtype('"abc"::string') == '"abc"'
    assert _strip_agtype("3.14::float") == "3.14"
    assert _strip_agtype("true::boolean") == "true"
    assert _strip_agtype('{"a":1}::vertex') == '{"a":1}'


def test_strip_agtype_leaves_plain_strings():
    assert _strip_agtype("no suffix here") == "no suffix here"


def test_decode_agtype_none_passes_through():
    assert _decode_agtype(None) is None


def test_decode_agtype_int():
    assert _decode_agtype("42::integer") == 42


def test_decode_agtype_string_with_suffix():
    assert _decode_agtype('"hello"::string') == "hello"


def test_decode_agtype_vertex_json():
    raw = '{"id": 1, "label": "Project", "properties": {"oenum": "12345"}}::vertex'
    decoded = _decode_agtype(raw)
    assert isinstance(decoded, dict)
    assert decoded["label"] == "Project"
    assert decoded["properties"]["oenum"] == "12345"


def test_decode_agtype_falls_back_to_string_on_unparseable():
    # Strip the suffix, fail to JSON-parse, return the stripped form.
    weird = "definitely not json::string"
    assert _decode_agtype(weird) == "definitely not json"


def test_decode_agtype_passes_through_native_types():
    assert _decode_agtype(42) == 42
    assert _decode_agtype({"a": 1}) == {"a": 1}
    assert _decode_agtype([1, 2]) == [1, 2]


def test_ageclient_rejects_bad_identifiers():
    c = AgeClient(dsn="postgresql://nope/nope")
    with pytest.raises(ValueError):
        c.upsert_node("Bad Label", "tag", "x")  # space in label
    with pytest.raises(ValueError):
        c.upsert_node("Project", "tag; DROP TABLE", "x")  # injection attempt
    with pytest.raises(ValueError):
        c.upsert_node("1Project", "tag", "x")  # leading digit


def test_ageclient_accepts_valid_identifiers_for_build_only(monkeypatch):
    """We can't connect from the sandbox, but we can confirm the SQL
    assembly path completes without raising for legitimate inputs."""
    c = AgeClient(dsn="postgresql://nope/nope")

    captured = {}

    class FakeCursor:
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def execute(self, sql, params=None):
            captured["sql"] = sql
            captured["params"] = params
        def fetchall(self): return []
        @property
        def description(self): return [("result",)]

    class FakeConn:
        def cursor(self): return FakeCursor()

    # Skip the actual LOAD 'age' + SET search_path round-trip; just
    # pretend the connection is already alive.
    c._conn = FakeConn()

    out = c.upsert_node("Project", "oenum", "12345", {"name": "demo"})
    # MERGE statement was assembled with the right shape.
    assert "MERGE (n:Project {oenum: $key})" in captured["sql"]
    assert "SET n += $props" in captured["sql"]
    assert out == {}  # FakeCursor returned no rows


def test_ageclient_env_default_dsn(monkeypatch):
    monkeypatch.setenv("AGE_DSN", "postgresql://test/test")
    monkeypatch.setenv("AGE_GRAPH_NAME", "test_graph")
    c = AgeClient()
    assert c.dsn == "postgresql://test/test"
    assert c.graph_name == "test_graph"
