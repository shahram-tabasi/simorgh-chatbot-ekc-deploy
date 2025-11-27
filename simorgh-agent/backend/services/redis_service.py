"""
Redis Caching Service
=====================
Multi-database Redis caching for sessions, chat history, LLM responses, and auth.

Database Layout:
- DB 0: User sessions & profiles
- DB 1: Chat history
- DB 2: LLM response caching
- DB 3: Project authorization caching (1 hour TTL)

Author: Simorgh Industrial Assistant
"""

import os
import json
import logging
from typing import List, Dict, Any, Optional
from datetime import timedelta
import redis
from redis.exceptions import RedisError, ConnectionError

logger = logging.getLogger(__name__)


class RedisService:
    """
    Multi-Database Redis Service

    Features:
    - Separate logical databases for different data types
    - Automatic serialization/deserialization
    - TTL support for cache expiration
    - Connection pooling
    - Health checks
    """

    def __init__(self, url: str = None):
        """Initialize Redis connections for all databases"""
        self.base_url = url or os.getenv("REDIS_URL", "redis://localhost:6379")

        # Create separate clients for each database
        self.session_client = self._create_client(db=0)  # User sessions/profiles
        self.chat_client = self._create_client(db=1)     # Chat history
        self.cache_client = self._create_client(db=2)    # LLM response caching
        self.auth_client = self._create_client(db=3)     # Authorization caching

        logger.info(f"✅ Redis service initialized: {self.base_url}")

    def _create_client(self, db: int) -> redis.Redis:
        """Create a Redis client for a specific database"""
        url_parts = self.base_url.rsplit("/", 1)
        db_url = f"{url_parts[0]}/{db}"

        return redis.Redis.from_url(
            db_url,
            decode_responses=True,
            socket_connect_timeout=5,
            socket_timeout=5,
            retry_on_timeout=True,
            health_check_interval=30
        )

    def health_check(self) -> Dict[str, Any]:
        """Check Redis health across all databases"""
        try:
            # Test each database
            dbs = {
                "session_db": self.session_client,
                "chat_db": self.chat_client,
                "cache_db": self.cache_client,
                "auth_db": self.auth_client
            }

            db_status = {}
            for name, client in dbs.items():
                try:
                    client.ping()
                    db_status[name] = "healthy"
                except Exception as e:
                    db_status[name] = f"error: {str(e)}"

            overall_status = "healthy" if all(
                v == "healthy" for v in db_status.values()
            ) else "degraded"

            return {
                "status": overall_status,
                "databases": db_status,
                "url": self.base_url
            }
        except Exception as e:
            logger.error(f"Redis health check failed: {e}")
            return {
                "status": "unhealthy",
                "error": str(e)
            }

    # =========================================================================
    # SESSION & PROFILE MANAGEMENT (DB 0)
    # =========================================================================

    def set_user_profile(
        self,
        user_id: str,
        profile: Dict[str, Any],
        ttl: Optional[int] = None
    ) -> bool:
        """
        Store user profile data

        Args:
            user_id: User identifier
            profile: Profile data dict
            ttl: Optional time-to-live in seconds

        Returns:
            True if successful
        """
        try:
            key = f"user:profile:{user_id}"
            value = json.dumps(profile)

            if ttl:
                self.session_client.setex(key, ttl, value)
            else:
                self.session_client.set(key, value)

            logger.debug(f"User profile saved: {user_id}")
            return True
        except RedisError as e:
            logger.error(f"Failed to set user profile: {e}")
            return False

    def get_user_profile(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Retrieve user profile"""
        try:
            key = f"user:profile:{user_id}"
            value = self.session_client.get(key)

            if value:
                return json.loads(value)
            return None
        except (RedisError, json.JSONDecodeError) as e:
            logger.error(f"Failed to get user profile: {e}")
            return None

    def set_user_preference(
        self,
        user_id: str,
        preference_key: str,
        preference_value: Any
    ) -> bool:
        """
        Store individual user preference (e.g., LLM mode)

        Args:
            user_id: User identifier
            preference_key: Preference name (e.g., "llm_mode")
            preference_value: Preference value (e.g., "online" or "offline")
        """
        try:
            key = f"user:pref:{user_id}:{preference_key}"
            value = json.dumps(preference_value)
            self.session_client.set(key, value)
            logger.debug(f"User preference saved: {user_id}:{preference_key}")
            return True
        except RedisError as e:
            logger.error(f"Failed to set user preference: {e}")
            return False

    def get_user_preference(
        self,
        user_id: str,
        preference_key: str,
        default: Any = None
    ) -> Any:
        """Retrieve user preference with optional default"""
        try:
            key = f"user:pref:{user_id}:{preference_key}"
            value = self.session_client.get(key)

            if value:
                return json.loads(value)
            return default
        except (RedisError, json.JSONDecodeError) as e:
            logger.error(f"Failed to get user preference: {e}")
            return default

    def set_session(
        self,
        session_id: str,
        session_data: Dict[str, Any],
        ttl: int = 3600  # 1 hour default
    ) -> bool:
        """Store session data with TTL"""
        try:
            key = f"session:{session_id}"
            value = json.dumps(session_data)
            self.session_client.setex(key, ttl, value)
            return True
        except RedisError as e:
            logger.error(f"Failed to set session: {e}")
            return False

    def get_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Retrieve session data"""
        try:
            key = f"session:{session_id}"
            value = self.session_client.get(key)

            if value:
                return json.loads(value)
            return None
        except (RedisError, json.JSONDecodeError) as e:
            logger.error(f"Failed to get session: {e}")
            return None

    def delete_session(self, session_id: str) -> bool:
        """Delete session (logout)"""
        try:
            key = f"session:{session_id}"
            self.session_client.delete(key)
            return True
        except RedisError as e:
            logger.error(f"Failed to delete session: {e}")
            return False

    # =========================================================================
    # CHAT HISTORY MANAGEMENT (DB 1)
    # =========================================================================

    def cache_chat_message(
        self,
        chat_id: str,
        message: Dict[str, Any],
        max_messages: int = 100
    ) -> bool:
        """
        Add message to chat history (FIFO list)

        Args:
            chat_id: Chat identifier
            message: Message data
            max_messages: Maximum messages to keep (oldest removed)
        """
        try:
            key = f"chat:history:{chat_id}"
            value = json.dumps(message)

            # Add to list (right push)
            self.chat_client.rpush(key, value)

            # Trim to max length (keep most recent)
            self.chat_client.ltrim(key, -max_messages, -1)

            logger.debug(f"Message cached for chat: {chat_id}")
            return True
        except RedisError as e:
            logger.error(f"Failed to cache chat message: {e}")
            return False

    def get_chat_history(
        self,
        chat_id: str,
        limit: int = 50,
        offset: int = 0
    ) -> List[Dict[str, Any]]:
        """
        Retrieve chat message history

        Args:
            chat_id: Chat identifier
            limit: Number of messages to retrieve
            offset: Offset from most recent (0 = most recent)

        Returns:
            List of messages (newest first)
        """
        try:
            key = f"chat:history:{chat_id}"

            # Get messages (negative indices for recent messages)
            start = -(offset + limit)
            end = -offset - 1 if offset > 0 else -1

            messages_raw = self.chat_client.lrange(key, start, end)

            # Parse and reverse (newest first)
            messages = [json.loads(msg) for msg in messages_raw]
            messages.reverse()

            return messages
        except (RedisError, json.JSONDecodeError) as e:
            logger.error(f"Failed to get chat history: {e}")
            return []

    def clear_chat_history(self, chat_id: str) -> bool:
        """Delete all messages for a chat"""
        try:
            key = f"chat:history:{chat_id}"
            self.chat_client.delete(key)
            logger.info(f"Chat history cleared: {chat_id}")
            return True
        except RedisError as e:
            logger.error(f"Failed to clear chat history: {e}")
            return False

    def get_chat_count(self, chat_id: str) -> int:
        """Get total message count for a chat"""
        try:
            key = f"chat:history:{chat_id}"
            return self.chat_client.llen(key)
        except RedisError as e:
            logger.error(f"Failed to get chat count: {e}")
            return 0

    # =========================================================================
    # LLM RESPONSE CACHING (DB 2)
    # =========================================================================

    def cache_llm_response(
        self,
        prompt_hash: str,
        response: str,
        metadata: Dict[str, Any] = None,
        ttl: int = 3600  # 1 hour default
    ) -> bool:
        """
        Cache LLM response to avoid redundant API calls

        Args:
            prompt_hash: Hash of prompt + model + parameters
            response: LLM response text
            metadata: Optional metadata (tokens, cost, etc.)
            ttl: Cache lifetime in seconds

        Returns:
            True if successful
        """
        try:
            key = f"llm:response:{prompt_hash}"
            value = json.dumps({
                "response": response,
                "metadata": metadata or {},
                "cached_at": str(self._now())
            })

            self.cache_client.setex(key, ttl, value)
            logger.debug(f"LLM response cached: {prompt_hash[:16]}...")
            return True
        except RedisError as e:
            logger.error(f"Failed to cache LLM response: {e}")
            return False

    def get_cached_llm_response(
        self,
        prompt_hash: str
    ) -> Optional[Dict[str, Any]]:
        """Retrieve cached LLM response"""
        try:
            key = f"llm:response:{prompt_hash}"
            value = self.cache_client.get(key)

            if value:
                logger.debug(f"LLM cache HIT: {prompt_hash[:16]}...")
                return json.loads(value)

            logger.debug(f"LLM cache MISS: {prompt_hash[:16]}...")
            return None
        except (RedisError, json.JSONDecodeError) as e:
            logger.error(f"Failed to get cached LLM response: {e}")
            return None

    def clear_llm_cache(self) -> bool:
        """Clear all LLM response cache"""
        try:
            pattern = "llm:response:*"
            for key in self.cache_client.scan_iter(match=pattern):
                self.cache_client.delete(key)
            logger.info("LLM cache cleared")
            return True
        except RedisError as e:
            logger.error(f"Failed to clear LLM cache: {e}")
            return False

    # =========================================================================
    # AUTHORIZATION CACHING (DB 3)
    # =========================================================================

    def cache_project_authorization(
        self,
        user_id: str,
        project_number: str,
        has_access: bool,
        ttl: int = 3600  # 1 hour default
    ) -> bool:
        """
        Cache project access authorization result

        Args:
            user_id: User identifier
            project_number: Project number
            has_access: Whether user has access
            ttl: Cache lifetime (default 1 hour)

        Returns:
            True if successful
        """
        try:
            key = f"auth:project:{user_id}:{project_number}"
            value = json.dumps({
                "has_access": has_access,
                "cached_at": str(self._now())
            })

            self.auth_client.setex(key, ttl, value)
            logger.debug(f"Authorization cached: {user_id} -> {project_number}")
            return True
        except RedisError as e:
            logger.error(f"Failed to cache authorization: {e}")
            return False

    def get_cached_authorization(
        self,
        user_id: str,
        project_number: str
    ) -> Optional[bool]:
        """
        Check cached project authorization

        Returns:
            True/False if cached, None if not found
        """
        try:
            key = f"auth:project:{user_id}:{project_number}"
            value = self.auth_client.get(key)

            if value:
                data = json.loads(value)
                logger.debug(f"Auth cache HIT: {user_id} -> {project_number}")
                return data["has_access"]

            logger.debug(f"Auth cache MISS: {user_id} -> {project_number}")
            return None
        except (RedisError, json.JSONDecodeError) as e:
            logger.error(f"Failed to get cached authorization: {e}")
            return None

    def invalidate_user_authorizations(self, user_id: str) -> bool:
        """Invalidate all cached authorizations for a user"""
        try:
            pattern = f"auth:project:{user_id}:*"
            for key in self.auth_client.scan_iter(match=pattern):
                self.auth_client.delete(key)
            logger.info(f"Authorizations invalidated for user: {user_id}")
            return True
        except RedisError as e:
            logger.error(f"Failed to invalidate authorizations: {e}")
            return False

    def cache_user_projects(
        self,
        user_id: str,
        project_numbers: List[str],
        ttl: int = 3600
    ) -> bool:
        """
        Cache list of projects a user has access to

        Args:
            user_id: User identifier
            project_numbers: List of authorized project numbers
            ttl: Cache lifetime
        """
        try:
            key = f"auth:user_projects:{user_id}"
            value = json.dumps({
                "projects": project_numbers,
                "cached_at": str(self._now())
            })

            self.auth_client.setex(key, ttl, value)
            logger.debug(f"User projects cached: {user_id} ({len(project_numbers)} projects)")
            return True
        except RedisError as e:
            logger.error(f"Failed to cache user projects: {e}")
            return False

    def get_cached_user_projects(self, user_id: str) -> Optional[List[str]]:
        """Retrieve cached list of user's projects"""
        try:
            key = f"auth:user_projects:{user_id}"
            value = self.auth_client.get(key)

            if value:
                data = json.loads(value)
                return data["projects"]
            return None
        except (RedisError, json.JSONDecodeError) as e:
            logger.error(f"Failed to get cached user projects: {e}")
            return None

    # =========================================================================
    # GENERAL KEY-VALUE OPERATIONS
    # =========================================================================

    def set(
        self,
        key: str,
        value: Any,
        ttl: Optional[int] = None,
        db: str = "cache"
    ) -> bool:
        """
        Generic set operation

        Args:
            key: Redis key
            value: Value (will be JSON serialized)
            ttl: Optional TTL in seconds
            db: Database to use ("session", "chat", "cache", "auth")
        """
        try:
            client = self._get_client(db)
            serialized = json.dumps(value)

            if ttl:
                client.setex(key, ttl, serialized)
            else:
                client.set(key, serialized)

            return True
        except RedisError as e:
            logger.error(f"Failed to set key {key}: {e}")
            return False

    def get(
        self,
        key: str,
        default: Any = None,
        db: str = "cache"
    ) -> Any:
        """Generic get operation"""
        try:
            client = self._get_client(db)
            value = client.get(key)

            if value:
                return json.loads(value)
            return default
        except (RedisError, json.JSONDecodeError) as e:
            logger.error(f"Failed to get key {key}: {e}")
            return default

    def delete(self, key: str, db: str = "cache") -> bool:
        """Generic delete operation"""
        try:
            client = self._get_client(db)
            client.delete(key)
            return True
        except RedisError as e:
            logger.error(f"Failed to delete key {key}: {e}")
            return False

    def exists(self, key: str, db: str = "cache") -> bool:
        """Check if key exists"""
        try:
            client = self._get_client(db)
            return client.exists(key) > 0
        except RedisError as e:
            logger.error(f"Failed to check key existence {key}: {e}")
            return False

    # =========================================================================
    # UTILITIES
    # =========================================================================

    def _get_client(self, db_name: str) -> redis.Redis:
        """Get Redis client by database name"""
        clients = {
            "session": self.session_client,
            "chat": self.chat_client,
            "cache": self.cache_client,
            "auth": self.auth_client
        }
        return clients.get(db_name, self.cache_client)

    def _now(self):
        """Get current timestamp"""
        from datetime import datetime
        return datetime.now().isoformat()

    def close(self):
        """Close all Redis connections"""
        try:
            self.session_client.close()
            self.chat_client.close()
            self.cache_client.close()
            self.auth_client.close()
            logger.info("Redis connections closed")
        except Exception as e:
            logger.error(f"Error closing Redis connections: {e}")


# =============================================================================
# SINGLETON INSTANCE
# =============================================================================

_redis_instance: Optional[RedisService] = None


def get_redis_service() -> RedisService:
    """Get or create Redis service singleton"""
    global _redis_instance

    if _redis_instance is None:
        _redis_instance = RedisService()

    return _redis_instance


def close_redis_service():
    """Close Redis service connections"""
    global _redis_instance

    if _redis_instance:
        _redis_instance.close()
        _redis_instance = None
