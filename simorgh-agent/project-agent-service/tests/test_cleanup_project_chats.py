"""Tests for ProjectMemoryService._sweep_redis_project_chats.

The sweep is what makes "delete project" actually remove the sidebar's
chats. Tested by extracting the method via AST and driving it against
a fake redis client — same trick as test_record_push_state.
"""

import ast
import json
import sys
import types
from pathlib import Path

SRC = (Path(__file__).resolve().parents[1]
       / "services" / "project_memory_service.py").read_text()


def _load_sweep():
    tree = ast.parse(SRC)
    fn_node = None
    for cls in tree.body:
        if isinstance(cls, ast.ClassDef):
            for item in cls.body:
                if (isinstance(item, ast.FunctionDef)
                        and item.name == "_sweep_redis_project_chats"):
                    fn_node = item
                    break
        if fn_node:
            break
    assert fn_node is not None
    import logging
    ns = {
        "json": json,
        "logger": logging.getLogger("test"),
        "Optional": __import__("typing").Optional,
    }
    exec(ast.unparse(fn_node), ns)
    return ns["_sweep_redis_project_chats"]


_sweep = _load_sweep()


class _FakeRedis:
    """Minimal in-memory redis impl supporting the surface the sweep uses."""

    def __init__(self, store: dict, sets: dict | None = None):
        self.store = store
        self.sets = sets or {}
        self.deletes: list[str] = []
        self.srems: list[tuple[str, str]] = []

    def scan_iter(self, match=None, count=None):
        # Return matching keys. The pattern in production is
        # "chat:*:metadata" — keep it dumb (substring).
        prefix = match.split("*", 1)[0]
        suffix = match.split("*", 1)[1] if "*" in match else ""
        for k in list(self.store.keys()):
            if k.startswith(prefix) and k.endswith(suffix):
                yield k

    def get(self, key):
        return self.store.get(key)

    def delete(self, key):
        self.store.pop(key, None)
        self.deletes.append(key)

    def srem(self, key, member):
        self.sets.setdefault(key, set()).discard(member)
        self.srems.append((key, member))


class _Self:
    """Stand-in for ProjectMemoryService self with the redis attribute."""
    def __init__(self, chat_client):
        self.redis = types.SimpleNamespace(chat_client=chat_client)


# ---------------------------------------------------------------------------
def test_sweep_drops_chats_matching_project_id():
    store = {
        "chat:c1:metadata": json.dumps({"chat_id": "c1", "project_number": "uuid-A"}),
        "chat:c2:metadata": json.dumps({"chat_id": "c2", "project_number": "uuid-B"}),
        "chat:c3:metadata": json.dumps({"chat_id": "c3"}),  # general, no project
        "chat:history:c1": "[...]",
        "chat:history:c2": "[...]",
    }
    redis = _FakeRedis(store)
    me = _Self(redis)
    removed = _sweep(me, {"uuid-A"}, owner_id="user-1")
    assert removed == 1
    assert "chat:c1:metadata" in redis.deletes
    assert "chat:history:c1" in redis.deletes
    # Untouched:
    assert "chat:c2:metadata" not in redis.deletes
    assert "chat:c3:metadata" not in redis.deletes


def test_sweep_also_matches_on_legacy_oenum():
    store = {
        "chat:c1:metadata": json.dumps({"chat_id": "c1", "project_number": "12345"}),
        "chat:c2:metadata": json.dumps({"chat_id": "c2", "project_number": "uuid-A"}),
    }
    redis = _FakeRedis(store)
    me = _Self(redis)
    # Both UUID and oenum land in the set so either match wins.
    removed = _sweep(me, {"uuid-A", "12345"}, owner_id="user-1")
    assert removed == 2


def test_sweep_supports_project_id_main_field():
    # Some chats were stored with the alt field name.
    store = {
        "chat:cX:metadata": json.dumps({"chat_id": "cX", "project_id_main": "uuid-A"}),
    }
    redis = _FakeRedis(store)
    removed = _sweep(_Self(redis), {"uuid-A"}, owner_id="u")
    assert removed == 1


def test_sweep_returns_zero_on_empty_ident_set():
    redis = _FakeRedis({"chat:c1:metadata": json.dumps({"project_number": "x"})})
    assert _sweep(_Self(redis), set(), owner_id="u") == 0
    # Nothing got deleted either.
    assert redis.deletes == []


def test_sweep_skips_when_chat_client_missing():
    class _NoClient:
        redis = types.SimpleNamespace()  # no chat_client
    assert _sweep(_NoClient(), {"uuid-A"}, owner_id="u") == 0


def test_sweep_handles_malformed_metadata():
    store = {
        "chat:c1:metadata": "not json",
        "chat:c2:metadata": json.dumps({"project_number": "uuid-A"}),
    }
    redis = _FakeRedis(store)
    # Bad json is skipped; good one is still cleaned.
    removed = _sweep(_Self(redis), {"uuid-A"}, owner_id="u")
    assert removed == 1
    assert "chat:c2:metadata" in redis.deletes
    assert "chat:c1:metadata" not in redis.deletes


def test_sweep_removes_chat_from_user_indices():
    store = {
        "chat:c1:metadata": json.dumps({"project_number": "uuid-A"}),
    }
    sets = {
        "user:bob:chats:all":              {"c1", "c-other"},
        "user:bob:chats:project:uuid-A":   {"c1"},
        "user:bob:chats:general":          {"c-general"},
    }
    redis = _FakeRedis(store, sets)
    _sweep(_Self(redis), {"uuid-A"}, owner_id="bob")
    assert "c1" not in sets["user:bob:chats:all"]
    assert "c-other" in sets["user:bob:chats:all"]
    assert "c1" not in sets["user:bob:chats:project:uuid-A"]


def test_sweep_no_owner_skips_index_cleanup_but_still_deletes_chat():
    store = {"chat:c1:metadata": json.dumps({"project_number": "uuid-A"})}
    redis = _FakeRedis(store)
    removed = _sweep(_Self(redis), {"uuid-A"}, owner_id=None)
    assert removed == 1
    assert "chat:c1:metadata" in redis.deletes
    # No srems happened.
    assert redis.srems == []
