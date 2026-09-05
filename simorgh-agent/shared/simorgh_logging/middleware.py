"""FastAPI middleware: assigns/propagates request-id and binds it to the
structlog context so every log line during the request carries it.
"""
import time
import uuid

from .core import bind_context, clear_context, get_logger

_log = get_logger("http")


async def request_id_middleware(request, call_next):
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex
    uid = request.headers.get("x-user-id", "")
    pid = request.headers.get("x-project-id", "")
    bind_context(request_id=rid, user_id=uid, project_id=pid)
    t0 = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        _log.exception(
            "http_error",
            method=request.method,
            path=request.url.path,
            latency_ms=int((time.perf_counter() - t0) * 1000),
        )
        clear_context()
        raise

    latency_ms = int((time.perf_counter() - t0) * 1000)
    response.headers["x-request-id"] = rid
    if request.url.path != "/health":
        _log.info(
            "http",
            method=request.method,
            path=request.url.path,
            status=response.status_code,
            latency_ms=latency_ms,
        )
    clear_context()
    return response
