"""
Redis Caching Service
=====================
Multi-database Redis caching for sessions, chat history, LLM responses, auth, and project data.

Database Layout:
- DB 0: User sessions & profiles
- DB 1: Chat history
- DB 2: LLM response caching
- DB 3: Project authorization caching (1 hour TTL)
- DB 4: Project TPMS data caching (Neo4j context cache for faster LLM responses)

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
        self.project_client = self._create_client(db=4)  # Project TPMS data caching

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
                "auth_db": self.auth_client,
                "project_db": self.project_client
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
            offset: Offset from oldest (0 = start from oldest)

        Returns:
            List of messages sorted by CreatedAt ASC (oldest first)
        """
        try:
            key = f"chat:history:{chat_id}"

            # Get all messages or limited range (0 = start, -1 = end)
            if limit <= 0:
                messages_raw = self.chat_client.lrange(key, 0, -1)
            else:
                # Get messages with offset from beginning
                start = offset
                end = offset + limit - 1
                messages_raw = self.chat_client.lrange(key, start, end)

            # Parse messages (maintain insertion order = CreatedAt ASC)
            messages = [json.loads(msg) for msg in messages_raw]

            # Sort by timestamp to ensure CreatedAt ASC order
            messages.sort(key=lambda m: m.get('timestamp', ''))

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

    def get_project_chat_history(
        self,
        user_id: str,
        project_number: str,
        current_chat_id: str,
        limit: int = 30,
        include_current_chat: bool = True
    ) -> List[Dict[str, Any]]:
        """
        Get chat history from ALL chats in a project.

        This enables cross-chat memory within the same project.
        Messages are sorted by timestamp (oldest first) and limited.

        Args:
            user_id: User identifier
            project_number: Project number to get chats for
            current_chat_id: Current chat ID (for prioritization)
            limit: Maximum total messages to return
            include_current_chat: Whether to include current chat's messages

        Returns:
            List of messages from all project chats, sorted by timestamp
        """
        try:
            # Get all chat IDs for this project
            chat_ids = self.get_user_project_chats(user_id, project_number)

            if not chat_ids:
                logger.debug(f"No chats found for project {project_number}")
                return []

            logger.info(f"📚 Project {project_number} has {len(chat_ids)} chats: {chat_ids}")

            all_messages = []

            for chat_id in chat_ids:
                # Skip current chat if not included
                if not include_current_chat and chat_id == current_chat_id:
                    continue

                # Get messages from this chat (last 20 per chat to avoid overload)
                chat_messages = self.get_chat_history(chat_id, limit=20)

                # Add chat_id to each message for context
                for msg in chat_messages:
                    msg['source_chat_id'] = chat_id
                    msg['is_current_chat'] = (chat_id == current_chat_id)

                all_messages.extend(chat_messages)

            if not all_messages:
                return []

            # Sort by timestamp (oldest first for conversation flow)
            all_messages.sort(key=lambda m: m.get('timestamp', ''))

            # Prioritize: keep most recent messages, but ensure current chat is represented
            if len(all_messages) > limit:
                # Split into current chat and other chats
                current_chat_msgs = [m for m in all_messages if m.get('is_current_chat')]
                other_chat_msgs = [m for m in all_messages if not m.get('is_current_chat')]

                # Allocate: 60% for current chat, 40% for other project chats
                current_limit = int(limit * 0.6)
                other_limit = limit - current_limit

                # Take most recent from each
                current_chat_msgs = current_chat_msgs[-current_limit:] if len(current_chat_msgs) > current_limit else current_chat_msgs
                other_chat_msgs = other_chat_msgs[-other_limit:] if len(other_chat_msgs) > other_limit else other_chat_msgs

                # Combine and re-sort
                all_messages = current_chat_msgs + other_chat_msgs
                all_messages.sort(key=lambda m: m.get('timestamp', ''))

            logger.info(f"📚 Retrieved {len(all_messages)} messages from {len(chat_ids)} project chats")
            return all_messages

        except Exception as e:
            logger.error(f"Failed to get project chat history: {e}")
            return []

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
    # PROJECT TPMS DATA CACHING (DB 4)
    # =========================================================================

    def cache_project_tpms_context(
        self,
        project_number: str,
        context: Dict[str, Any],
        ttl: int = 1800  # 30 minutes default
    ) -> bool:
        """
        Cache project TPMS context from Neo4j for faster LLM responses.

        This caches the full project context including:
        - Project info (name, category, experts, etc.)
        - Project identity (technical specs)
        - Panels list with feeder counts
        - Summary counts

        Args:
            project_number: Project OENUM
            context: Full project context from Neo4j
            ttl: Cache lifetime (default 30 minutes)

        Returns:
            True if successful
        """
        try:
            key = f"project:tpms_context:{project_number}"
            value = json.dumps({
                "context": context,
                "cached_at": self._now()
            })

            self.project_client.setex(key, ttl, value)
            logger.info(f"📦 Project TPMS context cached: {project_number} (TTL: {ttl}s)")
            return True
        except RedisError as e:
            logger.error(f"Failed to cache project TPMS context: {e}")
            return False

    def get_cached_project_tpms_context(
        self,
        project_number: str
    ) -> Optional[Dict[str, Any]]:
        """
        Get cached project TPMS context.

        Returns:
            Cached context if available, None if cache miss
        """
        try:
            key = f"project:tpms_context:{project_number}"
            value = self.project_client.get(key)

            if value:
                data = json.loads(value)
                logger.debug(f"📦 Project context cache HIT: {project_number}")
                return data["context"]

            logger.debug(f"📦 Project context cache MISS: {project_number}")
            return None
        except (RedisError, json.JSONDecodeError) as e:
            logger.error(f"Failed to get cached project context: {e}")
            return None

    def cache_project_panels(
        self,
        project_number: str,
        panels: List[Dict[str, Any]],
        ttl: int = 1800
    ) -> bool:
        """
        Cache panel details for a project.

        Useful for quick panel lookups without hitting Neo4j.

        Args:
            project_number: Project OENUM
            panels: List of panel data dicts
            ttl: Cache lifetime
        """
        try:
            key = f"project:panels:{project_number}"
            value = json.dumps({
                "panels": panels,
                "count": len(panels),
                "cached_at": self._now()
            })

            self.project_client.setex(key, ttl, value)
            logger.debug(f"Cached {len(panels)} panels for project {project_number}")
            return True
        except RedisError as e:
            logger.error(f"Failed to cache project panels: {e}")
            return False

    def get_cached_project_panels(
        self,
        project_number: str
    ) -> Optional[List[Dict[str, Any]]]:
        """Get cached panel list for a project"""
        try:
            key = f"project:panels:{project_number}"
            value = self.project_client.get(key)

            if value:
                data = json.loads(value)
                return data["panels"]
            return None
        except (RedisError, json.JSONDecodeError) as e:
            logger.error(f"Failed to get cached panels: {e}")
            return None

    def cache_panel_feeders(
        self,
        project_number: str,
        panel_id: str,
        feeders: List[Dict[str, Any]],
        ttl: int = 1800
    ) -> bool:
        """
        Cache feeder details for a specific panel.

        Enables quick feeder lookups without hitting Neo4j.

        Args:
            project_number: Project OENUM
            panel_id: Panel identifier
            feeders: List of feeder data dicts
            ttl: Cache lifetime
        """
        try:
            key = f"project:panel_feeders:{project_number}:{panel_id}"
            value = json.dumps({
                "feeders": feeders,
                "count": len(feeders),
                "cached_at": self._now()
            })

            self.project_client.setex(key, ttl, value)
            logger.debug(f"Cached {len(feeders)} feeders for panel {panel_id}")
            return True
        except RedisError as e:
            logger.error(f"Failed to cache panel feeders: {e}")
            return False

    def get_cached_panel_feeders(
        self,
        project_number: str,
        panel_id: str
    ) -> Optional[List[Dict[str, Any]]]:
        """Get cached feeder list for a panel"""
        try:
            key = f"project:panel_feeders:{project_number}:{panel_id}"
            value = self.project_client.get(key)

            if value:
                data = json.loads(value)
                return data["feeders"]
            return None
        except (RedisError, json.JSONDecodeError) as e:
            logger.error(f"Failed to get cached feeders: {e}")
            return None

    def cache_project_equipment_summary(
        self,
        project_number: str,
        equipment_summary: Dict[str, Any],
        ttl: int = 1800
    ) -> bool:
        """
        Cache equipment summary (counts by type) for quick stats.

        Args:
            project_number: Project OENUM
            equipment_summary: Dict with equipment counts by type
            ttl: Cache lifetime
        """
        try:
            key = f"project:equipment_summary:{project_number}"
            value = json.dumps({
                "summary": equipment_summary,
                "cached_at": self._now()
            })

            self.project_client.setex(key, ttl, value)
            return True
        except RedisError as e:
            logger.error(f"Failed to cache equipment summary: {e}")
            return False

    def get_cached_equipment_summary(
        self,
        project_number: str
    ) -> Optional[Dict[str, Any]]:
        """Get cached equipment summary"""
        try:
            key = f"project:equipment_summary:{project_number}"
            value = self.project_client.get(key)

            if value:
                data = json.loads(value)
                return data["summary"]
            return None
        except (RedisError, json.JSONDecodeError) as e:
            logger.error(f"Failed to get cached equipment summary: {e}")
            return None

    def invalidate_project_cache(self, project_number: str) -> bool:
        """
        Invalidate all cached data for a project.

        Should be called when project data is updated (e.g., after TPMS sync).

        Args:
            project_number: Project OENUM
        """
        try:
            patterns = [
                f"project:tpms_context:{project_number}",
                f"project:panels:{project_number}",
                f"project:panel_feeders:{project_number}:*",
                f"project:equipment_summary:{project_number}"
            ]

            deleted_count = 0
            for pattern in patterns:
                if "*" in pattern:
                    for key in self.project_client.scan_iter(match=pattern):
                        self.project_client.delete(key)
                        deleted_count += 1
                else:
                    if self.project_client.delete(pattern):
                        deleted_count += 1

            logger.info(f"🗑️ Project cache invalidated: {project_number} ({deleted_count} keys)")
            return True
        except RedisError as e:
            logger.error(f"Failed to invalidate project cache: {e}")
            return False

    def get_project_cache_stats(self, project_number: str) -> Dict[str, Any]:
        """
        Get cache statistics for a project.

        Returns info about what's cached and TTL remaining.
        """
        try:
            stats = {
                "project_number": project_number,
                "cached_items": {}
            }

            keys = [
                f"project:tpms_context:{project_number}",
                f"project:panels:{project_number}",
                f"project:equipment_summary:{project_number}"
            ]

            for key in keys:
                ttl = self.project_client.ttl(key)
                exists = ttl >= 0
                stats["cached_items"][key.split(":")[-2]] = {
                    "cached": exists,
                    "ttl_seconds": ttl if exists else 0
                }

            # Count panel feeders
            feeder_keys = list(self.project_client.scan_iter(
                match=f"project:panel_feeders:{project_number}:*"
            ))
            stats["cached_items"]["panel_feeders"] = {
                "cached": len(feeder_keys) > 0,
                "panels_with_feeders_cached": len(feeder_keys)
            }

            return stats
        except RedisError as e:
            logger.error(f"Failed to get project cache stats: {e}")
            return {"error": str(e)}

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
            "auth": self.auth_client,
            "project": self.project_client
        }
        return clients.get(db_name, self.cache_client)

    def _now(self):
        """Get current timestamp"""
        from datetime import datetime
        return datetime.now().isoformat()

    # =========================================================================
    # ENHANCED CHAT SESSION MANAGEMENT (DB 1)
    # =========================================================================

    def add_chat_to_user_index(
        self,
        user_id: str,
        chat_id: str,
        chat_type: str,
        project_number: Optional[str] = None
    ) -> bool:
        """
        Add chat to user's chat index (organized by type and project)

        Args:
            user_id: User identifier
            chat_id: Chat identifier
            chat_type: "general" or "project"
            project_number: Project number (for project chats)
        """
        try:
            if chat_type == "general":
                # Add to general chats set
                key = f"user:{user_id}:chats:general"
                self.chat_client.sadd(key, chat_id)
            elif chat_type == "project" and project_number:
                # Add to project-specific chats set
                key = f"user:{user_id}:chats:project:{project_number}"
                self.chat_client.sadd(key, chat_id)

            # Also add to global user chats set
            global_key = f"user:{user_id}:chats:all"
            self.chat_client.sadd(global_key, chat_id)

            logger.debug(f"Chat {chat_id} added to user {user_id} index ({chat_type})")
            return True
        except RedisError as e:
            logger.error(f"Failed to add chat to user index: {e}")
            return False

    def get_user_general_chats(self, user_id: str) -> List[str]:
        """Get all general chat IDs for a user"""
        try:
            key = f"user:{user_id}:chats:general"
            chat_ids = self.chat_client.smembers(key)
            return list(chat_ids) if chat_ids else []
        except RedisError as e:
            logger.error(f"Failed to get user general chats: {e}")
            return []

    def get_user_project_chats(self, user_id: str, project_number: str) -> List[str]:
        """Get all project chat IDs for a user and project"""
        try:
            key = f"user:{user_id}:chats:project:{project_number}"
            chat_ids = self.chat_client.smembers(key)
            return list(chat_ids) if chat_ids else []
        except RedisError as e:
            logger.error(f"Failed to get user project chats: {e}")
            return []

    def get_user_all_chats(self, user_id: str) -> List[str]:
        """Get all chat IDs for a user"""
        try:
            key = f"user:{user_id}:chats:all"
            chat_ids = self.chat_client.smembers(key)
            return list(chat_ids) if chat_ids else []
        except RedisError as e:
            logger.error(f"Failed to get all user chats: {e}")
            return []

    def update_chat_metadata(
        self,
        chat_id: str,
        updates: Dict[str, Any]
    ) -> bool:
        """
        Update chat metadata fields

        Args:
            chat_id: Chat identifier
            updates: Dictionary of fields to update
        """
        try:
            key = f"chat:{chat_id}:metadata"
            # Get existing metadata
            existing = self.chat_client.get(key)
            if existing:
                metadata = json.loads(existing)
                metadata.update(updates)
                metadata['updated_at'] = self._now()
                self.chat_client.set(key, json.dumps(metadata))
                logger.debug(f"Chat metadata updated: {chat_id}")
                return True
            return False
        except (RedisError, json.JSONDecodeError) as e:
            logger.error(f"Failed to update chat metadata: {e}")
            return False

    def get_chat_metadata_list(self, chat_ids: List[str]) -> List[Dict[str, Any]]:
        """
        Get metadata for multiple chats

        Args:
            chat_ids: List of chat identifiers

        Returns:
            List of chat metadata dictionaries
        """
        metadata_list = []
        for chat_id in chat_ids:
            metadata = self.get(f"chat:{chat_id}:metadata", db="chat")
            if metadata:
                metadata_list.append(metadata)
        return metadata_list

    def delete_chat(self, chat_id: str, user_id: str) -> bool:
        """
        Delete a chat and all its data

        Args:
            chat_id: Chat identifier
            user_id: User identifier (for index cleanup)
        """
        try:
            # Delete metadata
            self.chat_client.delete(f"chat:{chat_id}:metadata")

            # Delete message history
            self.clear_chat_history(chat_id)

            # Remove from user indices
            self.chat_client.srem(f"user:{user_id}:chats:all", chat_id)
            self.chat_client.srem(f"user:{user_id}:chats:general", chat_id)

            # Remove from all project indices (scan and clean)
            pattern = f"user:{user_id}:chats:project:*"
            for key in self.chat_client.scan_iter(match=pattern):
                self.chat_client.srem(key, chat_id)

            logger.info(f"Chat deleted: {chat_id}")
            return True
        except RedisError as e:
            logger.error(f"Failed to delete chat: {e}")
            return False

    def close(self):
        """Close all Redis connections"""
        try:
            self.session_client.close()
            self.chat_client.close()
            self.cache_client.close()
            self.auth_client.close()
            self.project_client.close()
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
