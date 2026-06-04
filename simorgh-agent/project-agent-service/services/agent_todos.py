"""
agent_todos.py — externalised TODO state for the ReAct loop.

Mirrors Claude Code's TodoWrite / TaskUpdate pattern: instead of the
model re-deriving "what's next?" from the rolling transcript on every
turn (which gets trimmed, and Persian/English code-switching makes the
re-derivation brittle), the agent maintains a small explicit checklist
it WRITES TO and READS FROM through tools.

Scope
=====
- One :class:`AgentTodos` instance per ReAct chain_id, kept in process
  memory for the duration of the run. Disposed after the loop exits.
- Backed by a plain list + dict for O(1) upsert; the loop is one
  process / one event loop, so no locking.
- Rendered as a sentinel-tagged ``<todos>…</todos>`` block that the
  loop patches into ``messages[0].content`` on every turn — sits
  next to ``<project_facts>`` so the model never has to look
  backwards for state.

Why not persist in ``project_tasks``?
-------------------------------------
That table holds the STATIC plan the CoT planner emitted upfront and is
read by ``_execute_task_chain``. Mixing the dynamic ReAct todos into
the same table would muddle the two state machines (and ``project_tasks``
has no ``depends_on`` column, so it can't represent the DAG anyway).
The two coexist: the planner's table is the *static* plan; this
in-memory store is the *running* checklist. If the user re-runs a
request, a fresh chain_id gets a fresh store.

Statuses
--------
``pending``      not started
``in_progress``  the agent is on it RIGHT NOW (max one per chain)
``done``         completed successfully
``blocked``      a dependency / prerequisite failed
``cancelled``    no longer needed
"""
from __future__ import annotations

import logging
import threading
import uuid
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


TODOS_OPEN  = "<todos immutable=\"true\">"
TODOS_CLOSE = "</todos>"

_VALID_STATUSES = {"pending", "in_progress", "done", "blocked", "cancelled"}


class AgentTodos:
    """In-memory todo list scoped to one ReAct chain."""

    __slots__ = ("chain_id", "_items", "_index")

    def __init__(self, chain_id: str) -> None:
        self.chain_id = chain_id
        self._items: List[Dict[str, Any]] = []
        self._index: Dict[str, int] = {}

    # ---- mutation ---------------------------------------------------------
    def write(self, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Bulk upsert. Each item may carry ``id`` (string) — if absent or
        unknown, a new todo is inserted; if known, the existing todo is
        merged with the new fields. Returns the FULL list after the write
        so the caller can echo it back to the model.
        """
        if not isinstance(items, list):
            raise TypeError("todo_write expects a list of todo dicts")
        for raw in items:
            if not isinstance(raw, dict):
                continue
            tid = str(raw.get("id") or "").strip()
            if tid and tid in self._index:
                idx = self._index[tid]
                existing = self._items[idx]
                # Merge: caller-provided keys overwrite; unset keys keep prior.
                for k in ("title", "status", "depends_on", "priority", "notes"):
                    if k in raw:
                        existing[k] = raw[k]
                self._normalise(existing)
            else:
                if not tid:
                    tid = uuid.uuid4().hex[:8]
                todo = {
                    "id":         tid,
                    "title":      str(raw.get("title") or "").strip(),
                    "status":     str(raw.get("status") or "pending").strip(),
                    "depends_on": list(raw.get("depends_on") or []),
                    "priority":   int(raw.get("priority") or 5),
                    "notes":      str(raw.get("notes") or "").strip(),
                }
                self._normalise(todo)
                self._index[tid] = len(self._items)
                self._items.append(todo)
        return list(self._items)

    @staticmethod
    def _normalise(todo: Dict[str, Any]) -> None:
        if todo.get("status") not in _VALID_STATUSES:
            todo["status"] = "pending"
        # depends_on is a list of todo ids; coerce to strings, drop self-refs.
        deps = todo.get("depends_on") or []
        if not isinstance(deps, list):
            deps = [deps]
        todo["depends_on"] = [str(d) for d in deps if str(d) != todo["id"]]

    # ---- read -------------------------------------------------------------
    def list(self) -> List[Dict[str, Any]]:
        return list(self._items)

    def render(self) -> str:
        """Render the sentinel-tagged block for the model. Compact: one
        line per todo, format ``[id] status title [blocked_by:a,b]``."""
        if not self._items:
            return (f"{TODOS_OPEN}\n"
                    "(no todos yet — use todo_write to plan multi-step work)\n"
                    f"{TODOS_CLOSE}")
        lines = [TODOS_OPEN]
        for t in self._items:
            line = f"[{t['id']}] {t['status']:<11} {t['title']}"
            if t.get("depends_on"):
                line += f"  blocked_by:{','.join(t['depends_on'])}"
            if t.get("notes"):
                line += f"  · {t['notes'][:120]}"
            lines.append(line)
        lines.append(TODOS_CLOSE)
        return "\n".join(lines)

    # ---- DAG view (used by the executor when it batches steps) ------------
    def ready(self) -> List[Dict[str, Any]]:
        """All pending todos whose dependencies are all done."""
        done_ids = {t["id"] for t in self._items if t["status"] == "done"}
        return [t for t in self._items
                if t["status"] == "pending"
                and all(d in done_ids for d in t.get("depends_on") or [])]


# ----------- module-level registry ---------------------------------------
_stores: Dict[str, AgentTodos] = {}
_lock = threading.Lock()


def get_store(chain_id: str) -> AgentTodos:
    with _lock:
        s = _stores.get(chain_id)
        if s is None:
            s = AgentTodos(chain_id)
            _stores[chain_id] = s
        return s


def clear_store(chain_id: str) -> None:
    """Called by the ReAct loop on exit so we don't leak memory across runs."""
    with _lock:
        _stores.pop(chain_id, None)


def looks_like_todos(s: str) -> bool:
    return TODOS_OPEN in (s or "")
