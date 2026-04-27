"""
Async LLM HTTP Client
=====================
Replaces synchronous `requests` with async `httpx` for non-blocking LLM calls.

Features:
- Async HTTP calls (non-blocking)
- Connection pooling (reuse connections)
- Concurrent request support
- Per-user request tracking
- Automatic load balancing between LLM servers

Author: Simorgh Industrial Assistant
"""

import os
import asyncio
import logging
import json
from typing import Optional, Dict, Any, AsyncIterator, List
from dataclasses import dataclass, field
from datetime import datetime
import httpx

logger = logging.getLogger(__name__)


@dataclass
class UserRequestTracker:
    """Track active requests per user to prevent monopolization"""
    user_id: str
    active_requests: int = 0
    total_requests: int = 0
    last_request_time: datetime = field(default_factory=datetime.now)


class AsyncLLMClient:
    """
    Async HTTP client for LLM servers with connection pooling and load balancing.

    This client:
    - Uses httpx.AsyncClient for non-blocking HTTP
    - Pools connections for efficiency
    - Tracks requests per user
    - Load balances between multiple LLM servers
    """

    def __init__(
        self,
        llm_servers: List[str] = None,
        max_connections: int = 20,
        max_requests_per_user: int = 3,
        timeout: float = 180.0,
    ):
        """
        Initialize async LLM client.

        Args:
            llm_servers: List of LLM server URLs
            max_connections: Maximum concurrent connections
            max_requests_per_user: Max concurrent requests per user
            timeout: Request timeout in seconds
        """
        # LLM server URLs
        self.llm_servers = llm_servers or [
            os.getenv("LOCAL_LLM_URL", "http://localhost/api/llm")
        ]

        # Connection settings
        self.max_connections = max_connections
        self.timeout = timeout
        self.max_requests_per_user = max_requests_per_user

        # User request tracking
        self._user_trackers: Dict[str, UserRequestTracker] = {}
        self._tracker_lock = asyncio.Lock()

        # Server health tracking
        self._server_health: Dict[str, bool] = {url: True for url in self.llm_servers}
        self._current_server_index = 0

        # HTTP client (created lazily)
        self._client: Optional[httpx.AsyncClient] = None

        # Statistics
        self.stats = {
            "total_requests": 0,
            "successful_requests": 0,
            "failed_requests": 0,
            "rejected_requests": 0,  # Due to per-user limit
            "concurrent_peak": 0,
        }
        self._active_requests = 0

        logger.info(f"✅ AsyncLLMClient initialized with {len(self.llm_servers)} servers")

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create the HTTP client with connection pooling"""
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self.timeout, connect=10.0),
                limits=httpx.Limits(
                    max_connections=self.max_connections,
                    max_keepalive_connections=self.max_connections // 2,
                ),
                http2=True,  # Enable HTTP/2 for better multiplexing
            )
        return self._client

    async def close(self):
        """Close the HTTP client and release connections"""
        if self._client:
            await self._client.aclose()
            self._client = None
            logger.info("AsyncLLMClient closed")

    def _get_next_server(self) -> str:
        """Get next healthy server (round-robin with health check)"""
        # Try each server in round-robin order
        for _ in range(len(self.llm_servers)):
            self._current_server_index = (self._current_server_index + 1) % len(self.llm_servers)
            server = self.llm_servers[self._current_server_index]

            if self._server_health.get(server, True):
                return server

        # All servers unhealthy, try first one anyway
        return self.llm_servers[0]

    def _mark_server_health(self, server: str, healthy: bool):
        """Mark server health status"""
        self._server_health[server] = healthy
        if not healthy:
            logger.warning(f"⚠️ Marking server as unhealthy: {server}")

    async def _acquire_user_slot(self, user_id: str) -> bool:
        """
        Try to acquire a request slot for a user.
        Returns False if user has too many active requests.
        """
        async with self._tracker_lock:
            if user_id not in self._user_trackers:
                self._user_trackers[user_id] = UserRequestTracker(user_id=user_id)

            tracker = self._user_trackers[user_id]

            if tracker.active_requests >= self.max_requests_per_user:
                logger.warning(f"⚠️ User {user_id} has {tracker.active_requests} active requests (max: {self.max_requests_per_user})")
                self.stats["rejected_requests"] += 1
                return False

            tracker.active_requests += 1
            tracker.total_requests += 1
            tracker.last_request_time = datetime.now()

            self._active_requests += 1
            self.stats["total_requests"] += 1

            if self._active_requests > self.stats["concurrent_peak"]:
                self.stats["concurrent_peak"] = self._active_requests

            return True

    async def _release_user_slot(self, user_id: str):
        """Release a request slot for a user"""
        async with self._tracker_lock:
            if user_id in self._user_trackers:
                self._user_trackers[user_id].active_requests = max(
                    0, self._user_trackers[user_id].active_requests - 1
                )
            self._active_requests = max(0, self._active_requests - 1)

    async def generate(
        self,
        system_prompt: str,
        user_prompt: str,
        user_id: str = "anonymous",
        thinking_level: str = "medium",
    ) -> Dict[str, Any]:
        """
        Generate LLM response (non-streaming, async).

        Args:
            system_prompt: System prompt
            user_prompt: User prompt
            user_id: User identifier for rate limiting
            thinking_level: Thinking level for local LLM

        Returns:
            Response dict with 'response', 'mode', 'model', etc.
        """
        # Check user rate limit
        if not await self._acquire_user_slot(user_id):
            return {
                "response": "You have too many active requests. Please wait for current requests to complete.",
                "mode": "error",
                "model": "rate-limit",
                "error": "rate_limit_exceeded",
            }

        try:
            server = self._get_next_server()
            client = await self._get_client()

            payload = {
                "system_prompt": system_prompt,
                "user_prompt": user_prompt,
                "thinking_level": thinking_level,
                "stream": True,  # Must be True for /generate-stream endpoint
            }

            url = f"{server.rstrip('/')}/generate-stream"
            logger.info(f"🚀 Async LLM request to {url} for user {user_id}")

            # Use streaming internally but collect full response
            full_response = ""
            is_completed = False

            async with client.stream("POST", url, json=payload) as response:
                response.raise_for_status()

                async for line in response.aiter_lines():
                    if not line:
                        continue

                    # Handle SSE format
                    if line.startswith('data: '):
                        line = line[6:]

                    try:
                        data = json.loads(line)

                        if "chunk" in data:
                            full_response += data["chunk"]
                        elif "output" in data:
                            full_response = data["output"]
                            is_completed = True
                        elif "text" in data:
                            full_response += data["text"]
                        elif data.get('status') == 'completed':
                            is_completed = True

                    except json.JSONDecodeError:
                        continue

            self._mark_server_health(server, True)
            self.stats["successful_requests"] += 1

            return {
                "response": full_response,
                "mode": "offline",
                "model": "local-llm",
                "finish_reason": "stop" if is_completed else "length",
                "server": server,
            }

        except httpx.TimeoutException as e:
            logger.error(f"❌ LLM request timeout: {e}")
            self.stats["failed_requests"] += 1
            raise

        except httpx.HTTPStatusError as e:
            logger.error(f"❌ LLM HTTP error: {e}")
            self._mark_server_health(server, False)
            self.stats["failed_requests"] += 1
            raise

        except Exception as e:
            logger.error(f"❌ LLM request failed: {e}")
            self.stats["failed_requests"] += 1
            raise

        finally:
            await self._release_user_slot(user_id)

    async def generate_stream(
        self,
        system_prompt: str,
        user_prompt: str,
        user_id: str = "anonymous",
        thinking_level: str = "medium",
    ) -> AsyncIterator[str]:
        """
        Generate streaming LLM response (async generator).

        Args:
            system_prompt: System prompt
            user_prompt: User prompt
            user_id: User identifier for rate limiting
            thinking_level: Thinking level for local LLM

        Yields:
            Response chunks as they arrive
        """
        # Check user rate limit
        if not await self._acquire_user_slot(user_id):
            yield json.dumps({
                "error": "rate_limit_exceeded",
                "message": "You have too many active requests. Please wait.",
            })
            return

        try:
            server = self._get_next_server()
            client = await self._get_client()

            payload = {
                "system_prompt": system_prompt,
                "user_prompt": user_prompt,
                "thinking_level": thinking_level,
                "stream": True,
            }

            url = f"{server.rstrip('/')}/generate-stream"
            logger.info(f"🚀 Async streaming LLM request to {url} for user {user_id}")

            async with client.stream("POST", url, json=payload) as response:
                response.raise_for_status()

                async for line in response.aiter_lines():
                    if not line:
                        continue

                    # Handle SSE format
                    if line.startswith('data: '):
                        line = line[6:]

                    try:
                        data = json.loads(line)

                        if "chunk" in data:
                            yield data["chunk"]
                        elif data.get("status") == "completed":
                            # Don't yield the 'output' field from completion events
                            # because all content was already yielded via chunks.
                            # Yielding 'output' here would duplicate the entire response.
                            pass
                        elif "text" in data:
                            yield data["text"]

                    except json.JSONDecodeError:
                        continue

            self._mark_server_health(server, True)
            self.stats["successful_requests"] += 1

        except httpx.TimeoutException as e:
            logger.error(f"❌ LLM streaming timeout: {e}")
            self.stats["failed_requests"] += 1
            yield json.dumps({"error": "timeout", "message": str(e)})

        except Exception as e:
            logger.error(f"❌ LLM streaming failed: {e}")
            self.stats["failed_requests"] += 1
            yield json.dumps({"error": "failed", "message": str(e)})

        finally:
            await self._release_user_slot(user_id)

    async def health_check(self, server: str = None) -> Dict[str, Any]:
        """Check health of LLM server(s)"""
        servers_to_check = [server] if server else self.llm_servers
        results = {}

        client = await self._get_client()

        for srv in servers_to_check:
            try:
                response = await client.get(
                    f"{srv.rstrip('/')}/health",
                    timeout=5.0
                )
                healthy = response.status_code == 200
                self._mark_server_health(srv, healthy)
                results[srv] = {
                    "status": "healthy" if healthy else "unhealthy",
                    "status_code": response.status_code,
                }
            except Exception as e:
                self._mark_server_health(srv, False)
                results[srv] = {
                    "status": "unhealthy",
                    "error": str(e),
                }

        return results

    def get_stats(self) -> Dict[str, Any]:
        """Get client statistics"""
        return {
            **self.stats,
            "active_requests": self._active_requests,
            "servers": self.llm_servers,
            "server_health": self._server_health,
            "active_users": len([t for t in self._user_trackers.values() if t.active_requests > 0]),
        }


# =============================================================================
# SINGLETON INSTANCE
# =============================================================================

_async_client: Optional[AsyncLLMClient] = None


def get_async_llm_client() -> AsyncLLMClient:
    """Get or create async LLM client singleton"""
    global _async_client

    if _async_client is None:
        # Get LLM server URLs from environment
        servers = []

        # Primary load-balanced URL
        primary = os.getenv("LOCAL_LLM_URL", "http://localhost/api/llm")
        servers.append(primary)

        # Additional direct URLs (optional)
        url1 = os.getenv("LOCAL_LLM_URL_1")
        url2 = os.getenv("LOCAL_LLM_URL_2")

        if url1 and url1 not in servers:
            servers.append(url1)
        if url2 and url2 not in servers:
            servers.append(url2)

        _async_client = AsyncLLMClient(
            llm_servers=servers,
            max_connections=20,
            max_requests_per_user=3,
            timeout=180.0,
        )

    return _async_client


async def close_async_llm_client():
    """Close the async LLM client"""
    global _async_client
    if _async_client:
        await _async_client.close()
        _async_client = None
