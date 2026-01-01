"""
Message Persistence Service
===========================
PostgreSQL-based persistent storage for chat messages.
Provides durable backup of all messages beyond Redis cache.

Author: Simorgh Industrial Assistant
"""

import os
import logging
from typing import List, Dict, Any, Optional
from datetime import datetime
import json
import asyncio
from contextlib import asynccontextmanager

logger = logging.getLogger(__name__)

# Try to import asyncpg, fall back to sync psycopg2 if not available
try:
    import asyncpg
    ASYNC_PG_AVAILABLE = True
except ImportError:
    ASYNC_PG_AVAILABLE = False
    logger.warning("asyncpg not available, using synchronous fallback")

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor, Json
    PSYCOPG2_AVAILABLE = True
except ImportError:
    PSYCOPG2_AVAILABLE = False
    logger.warning("psycopg2 not available")


class MessagePersistenceService:
    """
    PostgreSQL message persistence layer.

    Features:
    - Persistent storage for all chat messages
    - Full message history retrieval
    - Search and filtering capabilities
    - Backup/recovery support
    """

    # Table creation SQL
    CREATE_TABLES_SQL = """
    -- Messages table
    CREATE TABLE IF NOT EXISTS chat_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        message_id VARCHAR(255) UNIQUE NOT NULL,
        chat_id VARCHAR(255) NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL,
        content TEXT NOT NULL,
        project_number VARCHAR(255),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON chat_messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_messages_user_id ON chat_messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_project ON chat_messages(project_number);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON chat_messages(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON chat_messages(chat_id, created_at);

    -- Chat summaries table
    CREATE TABLE IF NOT EXISTS chat_summaries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chat_id VARCHAR(255) UNIQUE NOT NULL,
        summary TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_summaries_chat_id ON chat_summaries(chat_id);

    -- Chat metadata table
    CREATE TABLE IF NOT EXISTS chat_metadata (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chat_id VARCHAR(255) UNIQUE NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        chat_type VARCHAR(50) NOT NULL DEFAULT 'general',
        chat_name VARCHAR(500),
        project_number VARCHAR(255),
        project_name VARCHAR(500),
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_chat_meta_user ON chat_metadata(user_id);
    CREATE INDEX IF NOT EXISTS idx_chat_meta_project ON chat_metadata(project_number);
    """

    def __init__(self, database_url: str = None):
        """
        Initialize message persistence service.

        Args:
            database_url: PostgreSQL connection URL
        """
        self.database_url = database_url or os.getenv(
            "MESSAGE_DATABASE_URL",
            os.getenv("COCOINDEX_DATABASE_URL", "postgresql://cocoindex:cocoindex_2024@cocoindex_db:5432/cocoindex")
        )

        self._pool = None
        self._sync_conn = None
        self._initialized = False

        logger.info(f"MessagePersistenceService initialized")

    async def initialize(self):
        """Initialize database connection and create tables"""
        if self._initialized:
            return

        try:
            if ASYNC_PG_AVAILABLE:
                self._pool = await asyncpg.create_pool(
                    self.database_url,
                    min_size=2,
                    max_size=10,
                    command_timeout=60
                )
                await self._create_tables_async()
            elif PSYCOPG2_AVAILABLE:
                self._sync_conn = psycopg2.connect(self.database_url)
                self._create_tables_sync()
            else:
                logger.error("No PostgreSQL driver available")
                return

            self._initialized = True
            logger.info("Message persistence initialized successfully")

        except Exception as e:
            logger.error(f"Failed to initialize message persistence: {e}")
            raise

    async def _create_tables_async(self):
        """Create tables using async connection"""
        async with self._pool.acquire() as conn:
            await conn.execute(self.CREATE_TABLES_SQL)

    def _create_tables_sync(self):
        """Create tables using sync connection"""
        with self._sync_conn.cursor() as cur:
            cur.execute(self.CREATE_TABLES_SQL)
            self._sync_conn.commit()

    async def store_message(
        self,
        message_id: str,
        chat_id: str,
        user_id: str,
        role: str,
        content: str,
        project_number: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> bool:
        """
        Store a message in PostgreSQL.

        Args:
            message_id: Unique message identifier
            chat_id: Chat identifier
            user_id: User identifier
            role: Message role (user/assistant)
            content: Message content
            project_number: Optional project number
            metadata: Optional metadata dict

        Returns:
            True if successful
        """
        if not self._initialized:
            await self.initialize()

        try:
            sql = """
            INSERT INTO chat_messages (message_id, chat_id, user_id, role, content, project_number, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (message_id) DO UPDATE SET
                content = EXCLUDED.content,
                metadata = EXCLUDED.metadata,
                updated_at = CURRENT_TIMESTAMP
            """

            metadata_json = json.dumps(metadata or {})

            if ASYNC_PG_AVAILABLE and self._pool:
                async with self._pool.acquire() as conn:
                    await conn.execute(
                        sql,
                        message_id, chat_id, user_id, role, content,
                        project_number, metadata_json
                    )
            elif PSYCOPG2_AVAILABLE and self._sync_conn:
                with self._sync_conn.cursor() as cur:
                    cur.execute(
                        sql.replace('$1', '%s').replace('$2', '%s').replace('$3', '%s')
                           .replace('$4', '%s').replace('$5', '%s').replace('$6', '%s').replace('$7', '%s'),
                        (message_id, chat_id, user_id, role, content, project_number, metadata_json)
                    )
                    self._sync_conn.commit()

            return True

        except Exception as e:
            logger.error(f"Failed to store message: {e}")
            return False

    async def get_chat_messages(
        self,
        chat_id: str,
        limit: int = 100,
        offset: int = 0,
        order: str = "ASC"
    ) -> List[Dict[str, Any]]:
        """
        Get messages for a chat.

        Args:
            chat_id: Chat identifier
            limit: Maximum messages to return
            offset: Offset for pagination
            order: Sort order (ASC or DESC)

        Returns:
            List of message dictionaries
        """
        if not self._initialized:
            await self.initialize()

        try:
            sql = f"""
            SELECT message_id, chat_id, user_id, role, content,
                   project_number, metadata, created_at
            FROM chat_messages
            WHERE chat_id = $1
            ORDER BY created_at {order}
            LIMIT $2 OFFSET $3
            """

            messages = []

            if ASYNC_PG_AVAILABLE and self._pool:
                async with self._pool.acquire() as conn:
                    rows = await conn.fetch(sql, chat_id, limit, offset)
                    for row in rows:
                        messages.append({
                            "message_id": row["message_id"],
                            "chat_id": row["chat_id"],
                            "user_id": row["user_id"],
                            "role": row["role"],
                            "content": row["content"],
                            "project_number": row["project_number"],
                            "metadata": json.loads(row["metadata"]) if row["metadata"] else {},
                            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
                            "timestamp": row["created_at"].isoformat() if row["created_at"] else None
                        })
            elif PSYCOPG2_AVAILABLE and self._sync_conn:
                with self._sync_conn.cursor(cursor_factory=RealDictCursor) as cur:
                    cur.execute(
                        sql.replace('$1', '%s').replace('$2', '%s').replace('$3', '%s'),
                        (chat_id, limit, offset)
                    )
                    for row in cur.fetchall():
                        messages.append({
                            "message_id": row["message_id"],
                            "chat_id": row["chat_id"],
                            "user_id": row["user_id"],
                            "role": row["role"],
                            "content": row["content"],
                            "project_number": row["project_number"],
                            "metadata": json.loads(row["metadata"]) if row["metadata"] else {},
                            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
                            "timestamp": row["created_at"].isoformat() if row["created_at"] else None
                        })

            return messages

        except Exception as e:
            logger.error(f"Failed to get chat messages: {e}")
            return []

    async def get_user_chats(
        self,
        user_id: str,
        chat_type: Optional[str] = None,
        project_number: Optional[str] = None,
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        """
        Get chat list for a user.

        Args:
            user_id: User identifier
            chat_type: Optional filter by chat type
            project_number: Optional filter by project
            limit: Maximum chats to return

        Returns:
            List of chat metadata
        """
        if not self._initialized:
            await self.initialize()

        try:
            conditions = ["user_id = $1"]
            params = [user_id]
            param_idx = 2

            if chat_type:
                conditions.append(f"chat_type = ${param_idx}")
                params.append(chat_type)
                param_idx += 1

            if project_number:
                conditions.append(f"project_number = ${param_idx}")
                params.append(project_number)
                param_idx += 1

            sql = f"""
            SELECT chat_id, user_id, chat_type, chat_name, project_number,
                   project_name, status, created_at, updated_at
            FROM chat_metadata
            WHERE {' AND '.join(conditions)}
            ORDER BY updated_at DESC
            LIMIT ${param_idx}
            """
            params.append(limit)

            chats = []

            if ASYNC_PG_AVAILABLE and self._pool:
                async with self._pool.acquire() as conn:
                    rows = await conn.fetch(sql, *params)
                    for row in rows:
                        chats.append(dict(row))

            return chats

        except Exception as e:
            logger.error(f"Failed to get user chats: {e}")
            return []

    async def store_chat_metadata(
        self,
        chat_id: str,
        user_id: str,
        chat_type: str = "general",
        chat_name: Optional[str] = None,
        project_number: Optional[str] = None,
        project_name: Optional[str] = None
    ) -> bool:
        """
        Store chat metadata in PostgreSQL.

        Args:
            chat_id: Chat identifier
            user_id: User identifier
            chat_type: Type of chat
            chat_name: Chat name/title
            project_number: Project number
            project_name: Project name

        Returns:
            True if successful
        """
        if not self._initialized:
            await self.initialize()

        try:
            sql = """
            INSERT INTO chat_metadata (chat_id, user_id, chat_type, chat_name, project_number, project_name)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (chat_id) DO UPDATE SET
                chat_name = EXCLUDED.chat_name,
                updated_at = CURRENT_TIMESTAMP
            """

            if ASYNC_PG_AVAILABLE and self._pool:
                async with self._pool.acquire() as conn:
                    await conn.execute(
                        sql, chat_id, user_id, chat_type, chat_name,
                        project_number, project_name
                    )

            return True

        except Exception as e:
            logger.error(f"Failed to store chat metadata: {e}")
            return False

    async def delete_chat(self, chat_id: str) -> bool:
        """
        Delete a chat and all its messages.

        Args:
            chat_id: Chat identifier

        Returns:
            True if successful
        """
        if not self._initialized:
            await self.initialize()

        try:
            if ASYNC_PG_AVAILABLE and self._pool:
                async with self._pool.acquire() as conn:
                    await conn.execute("DELETE FROM chat_messages WHERE chat_id = $1", chat_id)
                    await conn.execute("DELETE FROM chat_summaries WHERE chat_id = $1", chat_id)
                    await conn.execute("DELETE FROM chat_metadata WHERE chat_id = $1", chat_id)

            logger.info(f"Deleted chat from PostgreSQL: {chat_id}")
            return True

        except Exception as e:
            logger.error(f"Failed to delete chat: {e}")
            return False

    async def store_summary(
        self,
        chat_id: str,
        summary: str,
        message_count: int
    ) -> bool:
        """
        Store chat summary in PostgreSQL.

        Args:
            chat_id: Chat identifier
            summary: Summary text
            message_count: Number of messages summarized

        Returns:
            True if successful
        """
        if not self._initialized:
            await self.initialize()

        try:
            sql = """
            INSERT INTO chat_summaries (chat_id, summary, message_count)
            VALUES ($1, $2, $3)
            ON CONFLICT (chat_id) DO UPDATE SET
                summary = EXCLUDED.summary,
                message_count = EXCLUDED.message_count,
                updated_at = CURRENT_TIMESTAMP
            """

            if ASYNC_PG_AVAILABLE and self._pool:
                async with self._pool.acquire() as conn:
                    await conn.execute(sql, chat_id, summary, message_count)

            return True

        except Exception as e:
            logger.error(f"Failed to store summary: {e}")
            return False

    async def get_summary(self, chat_id: str) -> Optional[Dict[str, Any]]:
        """
        Get chat summary from PostgreSQL.

        Args:
            chat_id: Chat identifier

        Returns:
            Summary dict or None
        """
        if not self._initialized:
            await self.initialize()

        try:
            sql = "SELECT summary, message_count, updated_at FROM chat_summaries WHERE chat_id = $1"

            if ASYNC_PG_AVAILABLE and self._pool:
                async with self._pool.acquire() as conn:
                    row = await conn.fetchrow(sql, chat_id)
                    if row:
                        return {
                            "summary": row["summary"],
                            "message_count": row["message_count"],
                            "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None
                        }

            return None

        except Exception as e:
            logger.error(f"Failed to get summary: {e}")
            return None

    async def sync_from_redis(
        self,
        redis_service,
        chat_id: str
    ) -> int:
        """
        Sync messages from Redis to PostgreSQL.

        Args:
            redis_service: Redis service instance
            chat_id: Chat to sync

        Returns:
            Number of messages synced
        """
        try:
            # Get all messages from Redis
            messages = redis_service.get_chat_history(chat_id, limit=-1)

            synced = 0
            for msg in messages:
                success = await self.store_message(
                    message_id=msg.get("message_id", str(hash(msg.get("content", "")))),
                    chat_id=chat_id,
                    user_id=msg.get("user_id", "unknown"),
                    role=msg.get("role", "user"),
                    content=msg.get("content", msg.get("text", "")),
                    project_number=msg.get("project_id"),
                    metadata={
                        "timestamp": msg.get("timestamp"),
                        "llm_mode": msg.get("llm_mode"),
                        "context_used": msg.get("context_used")
                    }
                )
                if success:
                    synced += 1

            logger.info(f"Synced {synced} messages from Redis to PostgreSQL for chat {chat_id}")
            return synced

        except Exception as e:
            logger.error(f"Failed to sync from Redis: {e}")
            return 0

    async def close(self):
        """Close database connections"""
        try:
            if self._pool:
                await self._pool.close()
            if self._sync_conn:
                self._sync_conn.close()
            logger.info("Message persistence connections closed")
        except Exception as e:
            logger.error(f"Error closing connections: {e}")


# =============================================================================
# SINGLETON INSTANCE
# =============================================================================

_persistence_service: Optional[MessagePersistenceService] = None


def get_message_persistence() -> MessagePersistenceService:
    """Get or create message persistence singleton"""
    global _persistence_service

    if _persistence_service is None:
        _persistence_service = MessagePersistenceService()

    return _persistence_service


async def init_message_persistence() -> MessagePersistenceService:
    """Initialize and return message persistence service"""
    service = get_message_persistence()
    await service.initialize()
    return service
