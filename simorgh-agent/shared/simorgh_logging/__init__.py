"""
Simorgh shared logging — structured JSON to stdout (filebeat-friendly) and
optional direct TCP shipment to logstash:5045.

Usage in any service:
    from simorgh_logging import configure, get_logger, request_id_middleware

    configure(service="gitlab-mcp")
    log = get_logger(__name__)
    log.info("started", port=8047)

    # FastAPI:
    app = FastAPI()
    app.middleware("http")(request_id_middleware)
"""
from .core import configure, get_logger, bind_context, clear_context
from .middleware import request_id_middleware

__all__ = [
    "configure",
    "get_logger",
    "bind_context",
    "clear_context",
    "request_id_middleware",
]
