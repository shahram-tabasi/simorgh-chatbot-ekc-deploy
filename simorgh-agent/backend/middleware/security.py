# middleware/security.py
"""
Security Middleware for Simorgh Backend
- Rate limiting
- Request validation
- Security headers
"""

from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response
import time
from collections import defaultdict
from typing import Dict, Tuple
import asyncio
import logging

logger = logging.getLogger(__name__)


class RateLimitMiddleware(BaseHTTPMiddleware):
    """
    Rate limiting middleware for API endpoints.

    Different limits for different endpoint types:
    - Auth endpoints: 10 requests per minute
    - General API: 100 requests per minute
    - File uploads: 20 requests per minute
    """

    def __init__(
        self,
        app,
        auth_limit: int = 10,
        api_limit: int = 100,
        upload_limit: int = 20,
        window_seconds: int = 60
    ):
        super().__init__(app)
        self.auth_limit = auth_limit
        self.api_limit = api_limit
        self.upload_limit = upload_limit
        self.window_seconds = window_seconds

        # Track requests: {ip: {endpoint_type: [(timestamp, count)]}}
        self.requests: Dict[str, Dict[str, list]] = defaultdict(lambda: defaultdict(list))
        self._lock = asyncio.Lock()

    def _get_client_ip(self, request: Request) -> str:
        """Extract client IP from request, handling proxies."""
        forwarded = request.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()

        real_ip = request.headers.get("X-Real-IP")
        if real_ip:
            return real_ip

        return request.client.host if request.client else "unknown"

    def _get_endpoint_type(self, path: str) -> str:
        """Categorize endpoint for rate limiting."""
        if "/auth" in path:
            return "auth"
        if "/upload" in path or "/document" in path:
            return "upload"
        return "api"

    def _get_limit(self, endpoint_type: str) -> int:
        """Get rate limit for endpoint type."""
        limits = {
            "auth": self.auth_limit,
            "upload": self.upload_limit,
            "api": self.api_limit
        }
        return limits.get(endpoint_type, self.api_limit)

    async def _check_rate_limit(self, client_ip: str, endpoint_type: str) -> Tuple[bool, int]:
        """
        Check if request is within rate limit.
        Returns (allowed, remaining_requests).
        """
        async with self._lock:
            current_time = time.time()
            window_start = current_time - self.window_seconds

            # Clean old requests
            self.requests[client_ip][endpoint_type] = [
                ts for ts in self.requests[client_ip][endpoint_type]
                if ts > window_start
            ]

            # Check limit
            limit = self._get_limit(endpoint_type)
            request_count = len(self.requests[client_ip][endpoint_type])

            if request_count >= limit:
                return False, 0

            # Record request
            self.requests[client_ip][endpoint_type].append(current_time)
            return True, limit - request_count - 1

    async def dispatch(self, request: Request, call_next):
        # Skip rate limiting for health checks
        if request.url.path in ["/health", "/", "/docs", "/openapi.json"]:
            return await call_next(request)

        client_ip = self._get_client_ip(request)
        endpoint_type = self._get_endpoint_type(request.url.path)

        allowed, remaining = await self._check_rate_limit(client_ip, endpoint_type)

        if not allowed:
            logger.warning(f"Rate limit exceeded for {client_ip} on {endpoint_type} endpoints")
            return Response(
                content='{"detail": "Too many requests. Please try again later."}',
                status_code=429,
                media_type="application/json",
                headers={
                    "Retry-After": str(self.window_seconds),
                    "X-RateLimit-Limit": str(self._get_limit(endpoint_type)),
                    "X-RateLimit-Remaining": "0",
                    "X-RateLimit-Reset": str(int(time.time() + self.window_seconds))
                }
            )

        response = await call_next(request)

        # Add rate limit headers
        response.headers["X-RateLimit-Limit"] = str(self._get_limit(endpoint_type))
        response.headers["X-RateLimit-Remaining"] = str(remaining)

        return response


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add security headers to all responses."""

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)

        # Security headers
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"

        # Remove server header if present
        if "server" in response.headers:
            del response.headers["server"]

        return response


class RequestValidationMiddleware(BaseHTTPMiddleware):
    """Validate incoming requests for security."""

    MAX_CONTENT_LENGTH = 100 * 1024 * 1024  # 100MB max

    async def dispatch(self, request: Request, call_next):
        # Check content length
        content_length = request.headers.get("content-length")
        if content_length and int(content_length) > self.MAX_CONTENT_LENGTH:
            return Response(
                content='{"detail": "Request too large"}',
                status_code=413,
                media_type="application/json"
            )

        return await call_next(request)
