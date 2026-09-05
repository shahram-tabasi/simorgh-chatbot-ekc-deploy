"""
Core structlog configuration. Emits JSON to stdout (where filebeat picks it
up) and, when LOGSTASH_HOST is set, also ships a copy directly to
logstash:5045 over a non-blocking TCP socket — this is the path used by the
context-search-service to back-fill ES even when filebeat is down.
"""
import logging
import os
import socket
import sys
import threading
import time
from contextvars import ContextVar
from queue import Queue, Full
from typing import Any, Dict

import structlog

_request_id: ContextVar[str] = ContextVar("request_id", default="")
_user_id:    ContextVar[str] = ContextVar("user_id",    default="")
_project_id: ContextVar[str] = ContextVar("project_id", default="")

_SERVICE: str = "unknown"


# ----------------------------------------------------------------------------
# TCP shipper — fire-and-forget, bounded queue, never blocks the caller.
# ----------------------------------------------------------------------------
class _LogstashTcpShipper:
    def __init__(self, host: str, port: int, queue_size: int = 10_000):
        self.host = host
        self.port = port
        self.queue: Queue = Queue(maxsize=queue_size)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="logstash-tcp")
        self._thread.start()

    def submit(self, line: str) -> None:
        try:
            self.queue.put_nowait(line)
        except Full:
            pass  # drop-on-overflow; we never block app code on logging.

    def _loop(self) -> None:
        sock = None
        backoff = 1.0
        while not self._stop.is_set():
            try:
                if sock is None:
                    sock = socket.create_connection((self.host, self.port), timeout=5)
                    backoff = 1.0
                line = self.queue.get(timeout=1.0)
                sock.sendall((line.rstrip("\n") + "\n").encode("utf-8"))
            except Exception:
                if sock is not None:
                    try: sock.close()
                    except Exception: pass
                sock = None
                time.sleep(backoff)
                backoff = min(backoff * 2, 30.0)


_shipper: _LogstashTcpShipper | None = None


def _ship_processor(_logger, _name, event_dict: Dict[str, Any]) -> Dict[str, Any]:
    """structlog processor: ship each event JSON-line to logstash."""
    if _shipper is not None:
        import json as _json
        try:
            _shipper.submit(_json.dumps(event_dict, default=str))
        except Exception:
            pass
    return event_dict


# ----------------------------------------------------------------------------
# Context binders — populated by middleware, attached to every event.
# ----------------------------------------------------------------------------
def _attach_context(_logger, _name, event_dict: Dict[str, Any]) -> Dict[str, Any]:
    event_dict.setdefault("service", _SERVICE)
    rid = _request_id.get()
    if rid: event_dict.setdefault("request_id", rid)
    uid = _user_id.get()
    if uid: event_dict.setdefault("user_id", uid)
    pid = _project_id.get()
    if pid: event_dict.setdefault("project_id", pid)
    return event_dict


def bind_context(*, request_id: str = "", user_id: str = "", project_id: str = "") -> None:
    if request_id: _request_id.set(request_id)
    if user_id:    _user_id.set(user_id)
    if project_id: _project_id.set(project_id)


def clear_context() -> None:
    _request_id.set("")
    _user_id.set("")
    _project_id.set("")


# ----------------------------------------------------------------------------
# Public configure() — call once at process start.
# ----------------------------------------------------------------------------
def configure(*, service: str, level: str | None = None) -> None:
    """
    Configure structlog + stdlib logging for a service.

    Reads LOGSTASH_HOST / LOGSTASH_PORT from env. If unset, we still emit
    JSON to stdout — filebeat will catch it.
    """
    global _SERVICE, _shipper
    _SERVICE = service

    log_level = (level or os.getenv("LOG_LEVEL", "INFO")).upper()
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=getattr(logging, log_level, logging.INFO),
    )

    host = os.getenv("LOGSTASH_HOST", "").strip()
    port = int(os.getenv("LOGSTASH_PORT", "5045"))
    if host:
        _shipper = _LogstashTcpShipper(host, port)

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            _attach_context,
            _ship_processor,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(getattr(logging, log_level, logging.INFO)),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str | None = None):
    return structlog.get_logger(name or _SERVICE)
