"""
DB Shell — arbitrary query surface for admins, across multiple backends.

POST /api/v2/admin/db/query
  body: {"sql": "<query|command|http>", "database": "auth"|"chat"|"redis"|"qdrant"}

  auth/chat  → SQL against the matching Postgres database
  redis      → raw redis-cli style command (e.g. "GET foo", "KEYS *", "HGETALL bar")
  qdrant     → HTTP passthrough. First line is "METHOD /path", optional JSON body
               follows on subsequent lines (e.g. "GET /collections" or
               "POST /collections/my/points/search\n{\"vector\":[…],\"limit\":10}")

GET /api/v2/admin/db/tables?database=…
  auth/chat → pg user tables with row estimates
  redis     → up to 200 keys via SCAN
  qdrant    → list of collections
"""
from __future__ import annotations

import json
import logging
import os
import shlex
import time
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

import asyncpg
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from routes._auth import require_admin
from services import audit_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/admin", tags=["DB Shell"])


# ── Connection config ────────────────────────────────────────────────────────
_PG_URLS = {
    "auth": os.getenv(
        "POSTGRES_AUTH_URL",
        "postgresql://simorgh:simorgh_secure_2024@postgres_auth:5432/simorgh_auth",
    ),
    "chat": os.getenv(
        "POSTGRES_CHAT_URL",
        os.getenv("POSTGRES_AUTH_URL",
                  "postgresql://simorgh:simorgh_secure_2024@postgres_auth:5432/simorgh_auth"),
    ),
}
_REDIS_URL  = os.getenv("REDIS_URL", "redis://redis:6379/0")
_QDRANT_URL = os.getenv("QDRANT_URL", "http://qdrant:6333")
_QDRANT_KEY = os.getenv("QDRANT_API_KEY", "")

_KNOWN_DBS = {"auth", "chat", "redis", "qdrant"}

_pg_pools: Dict[str, Optional[asyncpg.Pool]] = {k: None for k in _PG_URLS}
_redis_client = None
_qdrant_http: Optional[httpx.AsyncClient] = None

MAX_ROWS = 5000


async def _get_pg_pool(name: str) -> asyncpg.Pool:
    if name not in _PG_URLS:
        raise HTTPException(status_code=400, detail=f"unknown postgres database: {name}")
    if _pg_pools[name] is None:
        _pg_pools[name] = await asyncpg.create_pool(_PG_URLS[name], min_size=1, max_size=4)
    return _pg_pools[name]


async def _get_redis():
    global _redis_client
    if _redis_client is None:
        try:
            from redis import asyncio as aioredis  # redis-py 4.2+
        except ImportError as e:
            raise HTTPException(status_code=503, detail="redis-py not installed") from e
        _redis_client = aioredis.from_url(_REDIS_URL, decode_responses=False)
    return _redis_client


def _get_qdrant() -> httpx.AsyncClient:
    global _qdrant_http
    if _qdrant_http is None:
        headers = {"api-key": _QDRANT_KEY} if _QDRANT_KEY else {}
        _qdrant_http = httpx.AsyncClient(base_url=_QDRANT_URL, headers=headers, timeout=30.0)
    return _qdrant_http


# ── JSON helpers ─────────────────────────────────────────────────────────────
def _jsonify(v: Any) -> Any:
    """asyncpg / general value → JSON-safe."""
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, UUID):
        return str(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        b = bytes(v)
        try:
            return b.decode("utf-8")
        except UnicodeDecodeError:
            return f"<{len(b)} bytes>"
    if isinstance(v, (list, tuple)):
        return [_jsonify(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _jsonify(val) for k, val in v.items()}
    return str(v)


# ── Request schema ───────────────────────────────────────────────────────────
class QueryRequest(BaseModel):
    sql: str = Field(..., min_length=1, max_length=200_000)
    database: str = Field("auth", pattern="^(auth|chat|redis|qdrant)$")


def _classify_sql(sql: str) -> str:
    s = sql.strip()
    while s.startswith("--") or s.startswith("/*"):
        if s.startswith("--"):
            nl = s.find("\n"); s = s[nl + 1:] if nl != -1 else ""
        else:
            end = s.find("*/"); s = s[end + 2:] if end != -1 else ""
        s = s.lstrip()
    head = s.split(None, 1)[0].upper() if s else ""
    return head or "UNKNOWN"


# ── Dispatcher ───────────────────────────────────────────────────────────────
@router.post("/db/query")
async def run_query(
    req: QueryRequest, request: Request, admin: dict = Depends(require_admin),
) -> Dict[str, Any]:
    if req.database == "redis":
        return await _run_redis(req, request, admin)
    if req.database == "qdrant":
        return await _run_qdrant(req, request, admin)
    return await _run_postgres(req, request, admin)


# ── Postgres path ───────────────────────────────────────────────────────────
async def _run_postgres(req, request, admin) -> Dict[str, Any]:
    pool = await _get_pg_pool(req.database)
    op = _classify_sql(req.sql)
    t0 = time.perf_counter()

    error: Optional[str] = None
    columns: List[str] = []
    rows_out: List[List[Any]] = []
    rowcount: Optional[int] = None
    truncated = False

    try:
        async with pool.acquire() as conn:
            if op in {"SELECT", "WITH", "SHOW", "EXPLAIN", "VALUES", "TABLE"}:
                records = await conn.fetch(req.sql)
                if records:
                    columns = list(records[0].keys())
                    for rec in records[:MAX_ROWS]:
                        rows_out.append([_jsonify(rec[c]) for c in columns])
                    truncated = len(records) > MAX_ROWS
                    rowcount = len(records)
                else:
                    rowcount = 0
            else:
                status = await conn.execute(req.sql)
                parts = status.split()
                if parts and parts[-1].isdigit():
                    rowcount = int(parts[-1])
    except (asyncpg.exceptions.PostgresError, asyncpg.exceptions.InterfaceError, ValueError) as e:
        error = f"{type(e).__name__}: {e}"
    except Exception as e:  # pragma: no cover
        error = f"{type(e).__name__}: {e}"

    elapsed_ms = round((time.perf_counter() - t0) * 1000, 2)

    await audit_service.record(
        admin, "db.query",
        target_type="database", target_id=req.database,
        metadata={
            "engine": "postgres", "op": op,
            "sql": req.sql[:4000],
            "elapsed_ms": elapsed_ms,
            "rowcount": rowcount, "error": error,
        },
        request=request,
    )

    return {
        "ok": error is None,
        "op": op,
        "database": req.database,
        "elapsed_ms": elapsed_ms,
        "columns": columns,
        "rows": rows_out,
        "rowcount": rowcount,
        "truncated": truncated,
        "error": error,
    }


# ── Redis path ───────────────────────────────────────────────────────────────
def _format_redis_result(result: Any) -> Tuple[List[str], List[List[Any]], Optional[int]]:
    """Shape a Redis response into the same columns/rows envelope so the UI
    can render it the same way Postgres results render."""
    if result is None:
        return ["result"], [[None]], 1
    if isinstance(result, (str, int, float, bool, bytes)):
        return ["result"], [[_jsonify(result)]], 1
    if isinstance(result, list):
        return ["value"], [[_jsonify(x)] for x in result], len(result)
    if isinstance(result, dict):
        return ["field", "value"], [[_jsonify(k), _jsonify(v)] for k, v in result.items()], len(result)
    if isinstance(result, set):
        return ["member"], [[_jsonify(x)] for x in result], len(result)
    return ["result"], [[_jsonify(result)]], 1


async def _run_redis(req, request, admin) -> Dict[str, Any]:
    t0 = time.perf_counter()
    error: Optional[str] = None
    op = "REDIS"
    columns: List[str] = []
    rows_out: List[List[Any]] = []
    rowcount: Optional[int] = None

    cmd_text = req.sql.strip()
    try:
        parts = shlex.split(cmd_text)
        if not parts:
            raise ValueError("empty command")
        op = parts[0].upper()
        client = await _get_redis()
        result = await client.execute_command(*parts)
        columns, rows_out, rowcount = _format_redis_result(result)
    except Exception as e:
        error = f"{type(e).__name__}: {e}"

    elapsed_ms = round((time.perf_counter() - t0) * 1000, 2)

    await audit_service.record(
        admin, "db.query",
        target_type="database", target_id="redis",
        metadata={
            "engine": "redis", "op": op,
            "sql": cmd_text[:4000],
            "elapsed_ms": elapsed_ms,
            "rowcount": rowcount, "error": error,
        },
        request=request,
    )

    return {
        "ok": error is None,
        "op": op,
        "database": "redis",
        "elapsed_ms": elapsed_ms,
        "columns": columns,
        "rows": rows_out,
        "rowcount": rowcount,
        "truncated": False,
        "error": error,
    }


# ── Qdrant path ──────────────────────────────────────────────────────────────
async def _run_qdrant(req, request, admin) -> Dict[str, Any]:
    """Body format:

       GET /collections
       POST /collections/my_col/points/search
       {"vector":[…],"limit":10}
    """
    t0 = time.perf_counter()
    error: Optional[str] = None
    op = "HTTP"
    columns: List[str] = []
    rows_out: List[List[Any]] = []
    rowcount: Optional[int] = None
    status_code: Optional[int] = None

    text = req.sql.strip()
    method = path = ""
    body_json: Any = None

    try:
        if not text:
            raise ValueError("empty request")
        first_nl = text.find("\n")
        first = text if first_nl == -1 else text[:first_nl]
        rest = "" if first_nl == -1 else text[first_nl + 1:].strip()

        head = first.split(None, 1)
        if len(head) < 2:
            raise ValueError("first line must be: METHOD /path")
        method, path = head[0].upper(), head[1].strip()
        op = method
        if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
            raise ValueError(f"unsupported HTTP method: {method}")

        if rest:
            try:
                body_json = json.loads(rest)
            except json.JSONDecodeError as e:
                raise ValueError(f"body is not valid JSON: {e}") from e

        if not path.startswith("/"):
            path = "/" + path

        client = _get_qdrant()
        resp = await client.request(method, path, json=body_json)
        status_code = resp.status_code

        try:
            data = resp.json()
        except Exception:
            data = resp.text

        if resp.status_code >= 400:
            error = f"HTTP {resp.status_code}: {_short(data)}"
        else:
            columns = ["response"]
            rows_out = [[_jsonify(data)]]
            rowcount = 1
    except Exception as e:
        error = f"{type(e).__name__}: {e}"

    elapsed_ms = round((time.perf_counter() - t0) * 1000, 2)

    await audit_service.record(
        admin, "db.query",
        target_type="database", target_id="qdrant",
        metadata={
            "engine": "qdrant", "op": op,
            "method": method, "path": path,
            "sql": text[:4000],
            "elapsed_ms": elapsed_ms,
            "status_code": status_code,
            "error": error,
        },
        request=request,
    )

    return {
        "ok": error is None,
        "op": op,
        "database": "qdrant",
        "elapsed_ms": elapsed_ms,
        "columns": columns,
        "rows": rows_out,
        "rowcount": rowcount,
        "truncated": False,
        "error": error,
        "status_code": status_code,
    }


def _short(v: Any, limit: int = 200) -> str:
    s = json.dumps(v) if not isinstance(v, str) else v
    return s if len(s) <= limit else s[:limit] + "…"


# ── Schema browser ───────────────────────────────────────────────────────────
@router.get("/db/tables")
async def list_tables(
    database: str = "auth", _: dict = Depends(require_admin),
) -> Dict[str, Any]:
    if database not in _KNOWN_DBS:
        raise HTTPException(status_code=400, detail=f"unknown database: {database}")

    if database == "redis":
        try:
            client = await _get_redis()
            keys: List[str] = []
            cursor = 0
            while len(keys) < 200:
                cursor, batch = await client.scan(cursor=cursor, count=100)
                for k in batch:
                    keys.append(k.decode() if isinstance(k, (bytes, bytearray)) else str(k))
                if cursor == 0:
                    break
            return {
                "database": "redis",
                "tables": [{"schema": "redis", "name": k, "est_rows": 0} for k in keys[:200]],
            }
        except Exception as e:
            return {"database": "redis", "tables": [], "error": f"{type(e).__name__}: {e}"}

    if database == "qdrant":
        try:
            client = _get_qdrant()
            resp = await client.get("/collections")
            if resp.status_code >= 400:
                return {"database": "qdrant", "tables": [], "error": f"HTTP {resp.status_code}"}
            data = resp.json()
            collections = data.get("result", {}).get("collections", [])
            return {
                "database": "qdrant",
                "tables": [{"schema": "qdrant", "name": c.get("name"), "est_rows": 0} for c in collections],
            }
        except Exception as e:
            return {"database": "qdrant", "tables": [], "error": f"{type(e).__name__}: {e}"}

    # Postgres
    pool = await _get_pg_pool(database)
    rows = await pool.fetch(
        """
        SELECT n.nspname AS schema, c.relname AS name, c.reltuples::bigint AS est_rows
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r'
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY n.nspname, c.relname
        """
    )
    return {
        "database": database,
        "tables": [{"schema": r["schema"], "name": r["name"], "est_rows": r["est_rows"]} for r in rows],
    }
