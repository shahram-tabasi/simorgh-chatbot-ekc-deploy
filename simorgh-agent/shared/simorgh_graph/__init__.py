"""Shared Apache AGE client.

Apache AGE is a Postgres extension that adds openCypher property-graph
support. Every service that needs to query the simorgh entity graph
uses this client so they all share the same connection conventions,
``LOAD 'age'`` boilerplate, and parameter encoding.

Why this exists
---------------
The raw way to query AGE is verbose:

    LOAD 'age';
    SET search_path = ag_catalog, "$user", public;
    SELECT * FROM cypher('simorgh', $$
        MATCH (p:Project {oenum: $oenum})-[:HAS]->(d:Document)
        RETURN d.path AS path
    $$, $1) AS (path agtype);

This wrapper hides the boilerplate, handles the ``agtype`` decode, and
keeps a thread-safe connection pool.

Apache AGE quirks the wrapper papers over
-----------------------------------------
- Each new session must ``LOAD 'age'`` and set ``search_path``.
- Cypher parameters are passed as a single JSONB blob (``$1``).
- Results come back as ``agtype`` — JSON with type-tag suffixes
  (``42::integer``, ``"x"::string``) that have to be stripped.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
from typing import Any, Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Strip AGE's "::<typename>" suffix from agtype scalars before JSON parsing.
# Examples:
#   42::integer            → 42
#   "abc"::string          → "abc"
#   {"a":1}::vertex        → {"a":1}
_AGTYPE_SUFFIX_RE = re.compile(r'::(integer|float|numeric|string|boolean|vertex|edge|path|null)\b')


def _strip_agtype(raw: str) -> str:
    """Remove AGE's type-tag suffixes so the value is plain JSON."""
    if raw is None:
        return raw  # type: ignore[return-value]
    return _AGTYPE_SUFFIX_RE.sub("", raw)


def _decode_agtype(raw: Any) -> Any:
    """Decode one column value coming back from AGE.

    psycopg returns ``agtype`` as a ``str`` (or already-parsed dict in
    some adapters); we accept both.
    """
    if raw is None:
        return None
    if isinstance(raw, (dict, list, int, float, bool)):
        return raw
    if isinstance(raw, str):
        s = _strip_agtype(raw).strip()
        if not s:
            return None
        # AGE wraps strings in double quotes; let json handle that.
        try:
            return json.loads(s)
        except json.JSONDecodeError:
            # Some scalars (eg the empty path "[]") may still trip up
            # json.loads after stripping. Fall back to the stripped form.
            return s
    return raw


class AgeClient:
    """Lightweight Apache AGE client.

    The client owns a single Postgres connection pool (lazy) and exposes:

    * ``cypher(query, params=None, columns=...)`` — run an openCypher
      query, return list of dict rows.
    * ``upsert_node(label, key_prop, key_value, props)`` — convenience
      MERGE for the common "ensure this vertex exists" pattern.
    * ``upsert_edge(...)`` — same for edges.

    Connection management is intentionally simple — one shared
    connection guarded by a lock — because graph workloads here are
    bursty rather than steady-state and a pool would just be overhead.
    For higher throughput swap to ``psycopg_pool.ConnectionPool``.
    """

    DEFAULT_GRAPH = "simorgh"

    def __init__(
        self,
        dsn: Optional[str] = None,
        graph_name: Optional[str] = None,
        autocommit: bool = True,
    ):
        self.dsn = dsn or os.getenv(
            "AGE_DSN",
            "postgresql://simorgh_graph:simorgh_graph_2024@postgres_age:5432/simorgh_graph",
        )
        self.graph_name = graph_name or os.getenv("AGE_GRAPH_NAME", self.DEFAULT_GRAPH)
        self.autocommit = autocommit
        self._conn = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------
    def _connect(self):
        try:
            import psycopg  # psycopg3 preferred
            return psycopg.connect(self.dsn, autocommit=self.autocommit)
        except ImportError:
            import psycopg2  # type: ignore[import-not-found]
            from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT
            conn = psycopg2.connect(self.dsn)
            if self.autocommit:
                conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
            return conn

    def _ensure_conn(self):
        if self._conn is not None:
            return self._conn
        conn = self._connect()
        # Every new connection needs the AGE extension loaded and
        # ag_catalog on the search_path.
        with conn.cursor() as cur:
            cur.execute("LOAD 'age';")
            cur.execute('SET search_path = ag_catalog, "$user", public;')
        self._conn = conn
        return conn

    def close(self):
        if self._conn is not None:
            try:
                self._conn.close()
            finally:
                self._conn = None

    def health_check(self) -> bool:
        """Return True if the AGE server answers a SELECT 1."""
        try:
            with self._lock:
                conn = self._ensure_conn()
                with conn.cursor() as cur:
                    cur.execute("SELECT 1;")
                    cur.fetchone()
            return True
        except Exception as e:
            logger.warning("age health_check failed: %s", e)
            return False

    # ------------------------------------------------------------------
    # Cypher
    # ------------------------------------------------------------------
    def cypher(
        self,
        query: str,
        params: Optional[Dict[str, Any]] = None,
        columns: Optional[List[Tuple[str, str]]] = None,
    ) -> List[Dict[str, Any]]:
        """Run an openCypher query against ``self.graph_name``.

        ``columns`` is a list of ``(alias, agtype_kind)`` pairs that names
        the columns the cypher block returns. For most queries you can
        leave it as ``None`` — the wrapper will introspect the cursor
        description and decode every column as agtype. Provide ``columns``
        when you need explicit Postgres typing (eg counting rows as
        ``bigint``).

        Parameters are passed as a single JSON blob, the same way AGE
        expects: the cypher source must reference them as ``$key``.
        """
        if not columns:
            columns_clause = "(result agtype)"
            multi = False
        else:
            columns_clause = "(" + ", ".join(f"{name} {kind}" for name, kind in columns) + ")"
            multi = True

        sql = "SELECT * FROM cypher(%s, $$ " + query + " $$"
        sql_params: List[Any] = [self.graph_name]
        if params:
            sql += ", %s"
            sql_params.append(json.dumps(params))
        sql += ") AS " + columns_clause + ";"

        with self._lock:
            conn = self._ensure_conn()
            with conn.cursor() as cur:
                cur.execute(sql, sql_params)
                rows = cur.fetchall()
                col_names = [d[0] for d in cur.description] if cur.description else []

        decoded: List[Dict[str, Any]] = []
        for row in rows:
            if multi:
                decoded.append({col_names[i]: _decode_agtype(row[i]) for i in range(len(col_names))})
            else:
                decoded.append({"result": _decode_agtype(row[0])})
        return decoded

    # ------------------------------------------------------------------
    # Upserts
    # ------------------------------------------------------------------
    def upsert_node(
        self, label: str, key_prop: str, key_value: Any,
        props: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """``MERGE (n:{label} {key_prop: $key}) SET n += $props RETURN n``."""
        _check_identifier(label)
        _check_identifier(key_prop)
        props = props or {}
        query = (
            f"MERGE (n:{label} {{{key_prop}: $key}}) "
            f"SET n += $props "
            f"RETURN n"
        )
        out = self.cypher(query, {"key": key_value, "props": props})
        return out[0] if out else {}

    def upsert_edge(
        self,
        from_label: str, from_key_prop: str, from_key_value: Any,
        to_label: str, to_key_prop: str, to_key_value: Any,
        edge_label: str, props: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """``MATCH ... MERGE (a)-[r:{edge}]->(b) SET r += $props``."""
        for ident in (from_label, from_key_prop, to_label, to_key_prop, edge_label):
            _check_identifier(ident)
        props = props or {}
        query = (
            f"MATCH (a:{from_label} {{{from_key_prop}: $a_key}}), "
            f"      (b:{to_label} {{{to_key_prop}: $b_key}}) "
            f"MERGE (a)-[r:{edge_label}]->(b) "
            f"SET r += $props "
            f"RETURN r"
        )
        out = self.cypher(query, {
            "a_key": from_key_value,
            "b_key": to_key_value,
            "props": props,
        })
        return out[0] if out else {}

    # ------------------------------------------------------------------
    # Traversal helpers
    # ------------------------------------------------------------------
    def neighborhood(
        self, label: str, key_prop: str, key_value: Any, hops: int = 2,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """Bounded BFS — return the subgraph within ``hops`` of a vertex.

        Useful first call from the agent: "give me what you know about
        component ``F-103``" → a small subgraph the LLM can reason on.
        """
        _check_identifier(label)
        _check_identifier(key_prop)
        if hops < 1:
            hops = 1
        query = (
            f"MATCH p = (start:{label} {{{key_prop}: $key}})-[*1..{hops}]-(other) "
            f"RETURN p LIMIT {int(limit)}"
        )
        return self.cypher(query, {"key": key_value})


def _check_identifier(s: str) -> None:
    """Reject anything that isn't a plain SQL/Cypher identifier.

    We string-interpolate labels and property names into the Cypher
    block because AGE doesn't parameterize those — this guard prevents
    any caller from sneaking SQL/Cypher in through a label name.
    """
    if not isinstance(s, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", s):
        raise ValueError(f"invalid identifier: {s!r}")


__all__ = [
    "AgeClient",
    "_decode_agtype",
    "_strip_agtype",
]
