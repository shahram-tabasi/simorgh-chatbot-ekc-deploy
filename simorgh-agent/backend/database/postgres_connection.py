"""
PostgreSQL Database Connection Module

Handles connection pooling and database operations for the authentication system.
Supports both synchronous (psycopg2) and asynchronous (asyncpg) connections.
"""

import os
import logging
from typing import Optional, AsyncGenerator, Generator
from contextlib import contextmanager, asynccontextmanager
import asyncpg
import psycopg2
from psycopg2 import pool
from psycopg2.extras import RealDictCursor

logger = logging.getLogger(__name__)


class PostgresConnection:
    """PostgreSQL connection manager with connection pooling."""

    _instance = None
    _sync_pool: Optional[pool.ThreadedConnectionPool] = None
    _async_pool: Optional[asyncpg.Pool] = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        self.host = os.getenv("POSTGRES_AUTH_HOST", "localhost")
        self.port = int(os.getenv("POSTGRES_AUTH_PORT", "5432"))
        self.database = os.getenv("POSTGRES_AUTH_DATABASE", "simorgh_auth")
        self.user = os.getenv("POSTGRES_AUTH_USER", "simorgh")
        self.password = os.getenv("POSTGRES_AUTH_PASSWORD", "simorgh_secure_2024")
        self.min_connections = int(os.getenv("POSTGRES_MIN_CONNECTIONS", "2"))
        self.max_connections = int(os.getenv("POSTGRES_MAX_CONNECTIONS", "20"))

    @property
    def dsn(self) -> str:
        """Get the PostgreSQL connection string."""
        return f"postgresql://{self.user}:{self.password}@{self.host}:{self.port}/{self.database}"

    def init_sync_pool(self) -> None:
        """Initialize the synchronous connection pool."""
        if self._sync_pool is None:
            try:
                self._sync_pool = pool.ThreadedConnectionPool(
                    minconn=self.min_connections,
                    maxconn=self.max_connections,
                    host=self.host,
                    port=self.port,
                    database=self.database,
                    user=self.user,
                    password=self.password,
                    cursor_factory=RealDictCursor
                )
                logger.info(f"PostgreSQL sync pool initialized: {self.host}:{self.port}/{self.database}")
            except Exception as e:
                logger.error(f"Failed to initialize PostgreSQL sync pool: {e}")
                raise

    async def init_async_pool(self) -> None:
        """Initialize the asynchronous connection pool."""
        if self._async_pool is None:
            try:
                self._async_pool = await asyncpg.create_pool(
                    host=self.host,
                    port=self.port,
                    database=self.database,
                    user=self.user,
                    password=self.password,
                    min_size=self.min_connections,
                    max_size=self.max_connections
                )
                logger.info(f"PostgreSQL async pool initialized: {self.host}:{self.port}/{self.database}")
            except Exception as e:
                logger.error(f"Failed to initialize PostgreSQL async pool: {e}")
                raise

    @contextmanager
    def get_sync_connection(self) -> Generator:
        """Get a synchronous database connection from the pool."""
        if self._sync_pool is None:
            self.init_sync_pool()

        connection = None
        try:
            connection = self._sync_pool.getconn()
            yield connection
            connection.commit()
        except Exception as e:
            if connection:
                connection.rollback()
            logger.error(f"Database error: {e}")
            raise
        finally:
            if connection:
                self._sync_pool.putconn(connection)

    @asynccontextmanager
    async def get_async_connection(self) -> AsyncGenerator:
        """Get an asynchronous database connection from the pool."""
        if self._async_pool is None:
            await self.init_async_pool()

        async with self._async_pool.acquire() as connection:
            yield connection

    def close_sync_pool(self) -> None:
        """Close the synchronous connection pool."""
        if self._sync_pool:
            self._sync_pool.closeall()
            self._sync_pool = None
            logger.info("PostgreSQL sync pool closed")

    async def close_async_pool(self) -> None:
        """Close the asynchronous connection pool."""
        if self._async_pool:
            await self._async_pool.close()
            self._async_pool = None
            logger.info("PostgreSQL async pool closed")

    def execute_sync(self, query: str, params: tuple = None) -> list:
        """Execute a synchronous query and return results."""
        with self.get_sync_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                if cursor.description:
                    return cursor.fetchall()
                return []

    async def execute_async(self, query: str, *args) -> list:
        """Execute an asynchronous query and return results."""
        async with self.get_async_connection() as conn:
            return await conn.fetch(query, *args)

    async def execute_one_async(self, query: str, *args) -> Optional[dict]:
        """Execute an asynchronous query and return one result."""
        async with self.get_async_connection() as conn:
            row = await conn.fetchrow(query, *args)
            return dict(row) if row else None

    async def execute_many_async(self, query: str, args_list: list) -> None:
        """Execute multiple asynchronous queries."""
        async with self.get_async_connection() as conn:
            await conn.executemany(query, args_list)

    async def execute_transaction_async(self, queries: list) -> None:
        """Execute multiple queries in a transaction."""
        async with self.get_async_connection() as conn:
            async with conn.transaction():
                for query, args in queries:
                    await conn.execute(query, *args)

    async def health_check(self) -> bool:
        """Check if the database connection is healthy."""
        try:
            async with self.get_async_connection() as conn:
                result = await conn.fetchval("SELECT 1")
                return result == 1
        except Exception as e:
            logger.error(f"Health check failed: {e}")
            return False

    async def run_migration(self, migration_file: str) -> bool:
        """Run a SQL migration file."""
        try:
            with open(migration_file, 'r') as f:
                migration_sql = f.read()

            async with self.get_async_connection() as conn:
                await conn.execute(migration_sql)
                logger.info(f"Migration completed: {migration_file}")
                return True
        except Exception as e:
            logger.error(f"Migration failed: {e}")
            return False


# Global instance
_postgres = PostgresConnection()


def get_db() -> PostgresConnection:
    """Get the PostgreSQL connection instance."""
    return _postgres


async def init_database() -> None:
    """Initialize the database connection pools."""
    db = get_db()
    await db.init_async_pool()


async def close_database() -> None:
    """Close all database connections."""
    db = get_db()
    await db.close_async_pool()
    db.close_sync_pool()
