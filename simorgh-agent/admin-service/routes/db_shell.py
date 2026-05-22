"""
DB Shell — arbitrary SQL execution surface for admins.

POST /api/v2/admin/db/query
  body: {"sql": "SELECT ...", "database": "auth" | "chat"}

Executes the SQL against the chosen Postgres database and returns columns +
rows (or rowcount for DML). Every query is audit-logged with the actor, the
SQL text, and (for writes) the rowcount.

This is intentionally powerful and unrestricted — protect by admin role only,
expose nowhere else. Reads >5_000 rows are truncated and flagged.
"""
from __future__ import annotations

import logging
import os
import time
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from routes._auth import require_admin
from services import audit_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/admin", tags=["DB Shell"])


# We only expose the two Postgres databases the stack actually uses. Both
# share the same instance in default deployments but are distinct logical DBs.
_DB_URLS = {
    "auth": os.getenv(
        "POSTGRES_AUTH_URL",
        "postgresql://simorgh:simorgh_secure_2024@postgres_auth:5432/simorgh_auth",
    ),
    # Same physical Postgres in the current deploy, kept as a separate key so
    # we can split later without changing the API.
    "chat": os.getenv(
        "POSTGRES_CHAT_URL",
        os.getenv("POSTGRES_AUTH_URL",
                  "postgresql://simorgh:simorgh_secure_2024@postgres_auth:5432/simorgh_auth"),
    ),
}

_pools: Dict[str, Optional[asyncpg.Pool]] = {k: None for k in _DB_URLS}

MAX_ROWS = 5000


async def _get_pool(name: str) -> asyncpg.Pool:
    if name not in _DB_URLS:
        raise HTTPException(status_code=400, detail=f"unknown database: {name}")
    if _pools[name] is None:
        _pools[name] = await asyncpg.create_pool(_DB_URLS[name], min_size=1, max_size=4)
    return _pools[name]


def _jsonify(v: Any) -> Any:
    """Convert asyncpg-returned values to JSON-safe primitives."""
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, UUID):
        return str(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        return f"<{len(bytes(v))} bytes>"
    if isinstance(v, (list, tuple)):
        return [_jsonify(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _jsonify(val) for k, val in v.items()}
    return str(v)


class QueryRequest(BaseModel):
    sql: str = Field(..., min_length=1, max_length=200_000)
    database: str = Field("auth", pattern="^(auth|chat)$")


def _classify(sql: str) -> str:
    """Roughly classify the statement for the audit log. The first non-comment
    token is enough for the UI badge — we don't try to be a SQL parser."""
    s = sql.strip()
    # Strip leading SQL comments
    while s.startswith("--") or s.startswith("/*"):
        if s.startswith("--"):
            nl = s.find("\n")
            s = s[nl + 1:] if nl != -1 else ""
        else:
            end = s.find("*/")
            s = s[end + 2:] if end != -1 else ""
        s = s.lstrip()
    head = s.split(None, 1)[0].upper() if s else ""
    return head or "UNKNOWN"


@router.post("/db/query")
async def run_query(
    req: QueryRequest, request: Request, admin: dict = Depends(require_admin),
) -> Dict[str, Any]:
    pool = await _get_pool(req.database)
    op = _classify(req.sql)
    t0 = time.perf_counter()

    error: Optional[str] = None
    columns: List[str] = []
    rows_out: List[List[Any]] = []
    rowcount: Optional[int] = None
    truncated = False

    try:
        async with pool.acquire() as conn:
            # SELECT / WITH / SHOW / EXPLAIN → return rows. Anything else → execute.
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
                # asyncpg returns e.g. "DELETE 3" / "UPDATE 7" / "INSERT 0 5"
                parts = status.split()
                if parts and parts[-1].isdigit():
                    rowcount = int(parts[-1])
    except (
        asyncpg.exceptions.PostgresError,
        asyncpg.exceptions.InterfaceError,
        ValueError,
    ) as e:
        error = f"{type(e).__name__}: {e}"
    except Exception as e:  # pragma: no cover
        error = f"{type(e).__name__}: {e}"

    elapsed_ms = round((time.perf_counter() - t0) * 1000, 2)

    # Audit every query, success or fail. SELECTs are still recorded but with
    # rowcount, not the actual rows, to keep the audit log small.
    await audit_service.record(
        admin, "db.query",
        target_type="database", target_id=req.database,
        metadata={
            "op": op,
            "sql": req.sql[:4000],
            "elapsed_ms": elapsed_ms,
            "rowcount": rowcount,
            "error": error,
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


@router.get("/db/tables")
async def list_tables(
    database: str = "auth", _: dict = Depends(require_admin),
) -> Dict[str, Any]:
    """Lightweight schema browser — list user tables with row counts."""
    pool = await _get_pool(database)
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
