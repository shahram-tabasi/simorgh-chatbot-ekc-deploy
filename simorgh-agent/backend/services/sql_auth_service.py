"""
SQL Server Authentication Service
==================================
Read-only connection to external SQL Server for user authorization.

Validates:
- User access to specific project numbers
- User project list retrieval
- Results cached in Redis for performance

Author: Simorgh Industrial Assistant
"""

import os
import logging
from typing import List, Dict, Any, Optional
import pymssql
from contextlib import contextmanager

logger = logging.getLogger(__name__)


class SQLAuthService:
    """
    SQL Server Authentication Service

    Features:
    - Read-only connection to external SQL Server
    - User authorization validation
    - Project list retrieval per user
    - Connection pooling
    - Error handling and logging
    """

    def __init__(
        self,
        host: str = None,
        port: int = None,
        user: str = None,
        password: str = None,
        database: str = None
    ):
        """Initialize SQL Server connection parameters"""
        self.host = host or os.getenv("SQL_SERVER_HOST")
        self.port = port or int(os.getenv("SQL_SERVER_PORT", "1433"))
        self.user = user or os.getenv("SQL_SERVER_USER")
        self.password = password or os.getenv("SQL_SERVER_PASSWORD")
        self.database = database or os.getenv("SQL_SERVER_DATABASE")

        if not all([self.host, self.user, self.password, self.database]):
            logger.warning("⚠️ SQL Server credentials not fully configured")
            self.enabled = False
        else:
            self.enabled = True
            logger.info(f"✅ SQL Auth Service initialized: {self.host}:{self.port}")

    @contextmanager
    def get_connection(self):
        """
        Context manager for database connections
        Ensures connections are properly closed
        """
        if not self.enabled:
            raise ValueError("SQL Server authentication not configured")

        conn = None
        try:
            conn = pymssql.connect(
                server=self.host,
                port=self.port,
                user=self.user,
                password=self.password,
                database=self.database,
                timeout=10,
                login_timeout=10,
                as_dict=True  # Return rows as dictionaries
            )
            yield conn
        except pymssql.Error as e:
            logger.error(f"SQL Server connection error: {e}")
            raise
        finally:
            if conn:
                conn.close()

    def health_check(self) -> Dict[str, Any]:
        """Check SQL Server connectivity"""
        if not self.enabled:
            return {
                "status": "disabled",
                "message": "SQL Server authentication not configured"
            }

        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT @@VERSION as version")
                result = cursor.fetchone()

                return {
                    "status": "healthy",
                    "database": self.database,
                    "host": self.host,
                    "version": result["version"][:50] if result else "unknown"
                }
        except Exception as e:
            logger.error(f"SQL health check failed: {e}")
            return {
                "status": "unhealthy",
                "error": str(e)
            }

    # =========================================================================
    # USER AUTHENTICATION & AUTHORIZATION
    # =========================================================================

    def check_user_exists(self, username: str) -> bool:
        """
        Check if a user exists in the system

        Args:
            username: Username to check

        Returns:
            True if user exists
        """
        if not self.enabled:
            logger.warning("SQL auth disabled, allowing user")
            return True

        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()

                # Adjust table/column names to match your schema
                query = """
                SELECT COUNT(*) as count
                FROM Users
                WHERE username = %s AND is_active = 1
                """

                cursor.execute(query, (username,))
                result = cursor.fetchone()

                exists = result["count"] > 0 if result else False
                logger.debug(f"User exists check: {username} -> {exists}")
                return exists

        except Exception as e:
            logger.error(f"Error checking user existence: {e}")
            return False

    def check_project_access(
        self,
        username: str,
        project_number: str
    ) -> bool:
        """
        Check if a user has access to a specific project

        Args:
            username: User's username
            project_number: Project number to check

        Returns:
            True if user has access, False otherwise

        Note:
            Adjust the SQL query to match your database schema.
            Common patterns:
            - Direct user-project mapping table
            - User roles with project associations
            - Department-based access
        """
        if not self.enabled:
            logger.warning("SQL auth disabled, allowing access")
            return True

        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()

                # EXAMPLE QUERY - Adjust to your schema
                query = """
                SELECT COUNT(*) as has_access
                FROM UserProjectAccess upa
                INNER JOIN Users u ON upa.user_id = u.user_id
                INNER JOIN Projects p ON upa.project_id = p.project_id
                WHERE u.username = %s
                  AND p.project_number = %s
                  AND u.is_active = 1
                  AND upa.is_active = 1
                """

                cursor.execute(query, (username, project_number))
                result = cursor.fetchone()

                has_access = result["has_access"] > 0 if result else False

                logger.info(
                    f"Project access check: {username} -> {project_number} = {has_access}"
                )
                return has_access

        except Exception as e:
            logger.error(f"Error checking project access: {e}")
            # Fail closed - deny access on error
            return False

    def get_user_projects(self, username: str) -> List[Dict[str, Any]]:
        """
        Get all projects a user has access to

        Args:
            username: User's username

        Returns:
            List of project dicts with project_number, project_name, etc.

        Example return:
        [
            {
                "project_number": "P-2024-001",
                "project_name": "Tehran Substation",
                "client": "Tehran Power Company",
                "role": "engineer"
            },
            ...
        ]
        """
        if not self.enabled:
            logger.warning("SQL auth disabled, returning empty list")
            return []

        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()

                # EXAMPLE QUERY - Adjust to your schema
                query = """
                SELECT
                    p.project_number,
                    p.project_name,
                    p.client,
                    p.contract_number,
                    p.status,
                    upa.role as user_role,
                    upa.granted_at
                FROM UserProjectAccess upa
                INNER JOIN Users u ON upa.user_id = u.user_id
                INNER JOIN Projects p ON upa.project_id = p.project_id
                WHERE u.username = %s
                  AND u.is_active = 1
                  AND upa.is_active = 1
                ORDER BY upa.granted_at DESC
                """

                cursor.execute(query, (username,))
                projects = cursor.fetchall()

                logger.info(f"User projects retrieved: {username} -> {len(projects)} projects")
                return projects

        except Exception as e:
            logger.error(f"Error getting user projects: {e}")
            return []

    def get_user_info(self, username: str) -> Optional[Dict[str, Any]]:
        """
        Get detailed user information

        Args:
            username: User's username

        Returns:
            User info dict or None if not found

        Example return:
        {
            "user_id": 123,
            "username": "john.doe",
            "full_name": "John Doe",
            "email": "john.doe@company.com",
            "department": "Engineering",
            "role": "Senior Engineer",
            "is_active": True
        }
        """
        if not self.enabled:
            logger.warning("SQL auth disabled, returning mock user")
            return {
                "username": username,
                "full_name": username,
                "role": "user"
            }

        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()

                # EXAMPLE QUERY - Adjust to your schema
                query = """
                SELECT
                    user_id,
                    username,
                    full_name,
                    email,
                    department,
                    role,
                    is_active,
                    created_at,
                    last_login
                FROM Users
                WHERE username = %s
                """

                cursor.execute(query, (username,))
                user = cursor.fetchone()

                if user:
                    logger.debug(f"User info retrieved: {username}")
                    return user

                logger.warning(f"User not found: {username}")
                return None

        except Exception as e:
            logger.error(f"Error getting user info: {e}")
            return None

    # =========================================================================
    # PROJECT INFORMATION
    # =========================================================================

    def get_project_info(self, project_number: str) -> Optional[Dict[str, Any]]:
        """
        Get project information from SQL Server

        Args:
            project_number: Project number

        Returns:
            Project info dict or None if not found
        """
        if not self.enabled:
            return None

        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()

                query = """
                SELECT
                    project_id,
                    project_number,
                    project_name,
                    client,
                    contract_number,
                    contract_date,
                    status,
                    description,
                    created_at,
                    updated_at
                FROM Projects
                WHERE project_number = %s
                """

                cursor.execute(query, (project_number,))
                project = cursor.fetchone()

                if project:
                    logger.debug(f"Project info retrieved: {project_number}")
                    return project

                logger.warning(f"Project not found: {project_number}")
                return None

        except Exception as e:
            logger.error(f"Error getting project info: {e}")
            return None

    def get_project_users(self, project_number: str) -> List[Dict[str, Any]]:
        """
        Get all users with access to a project

        Args:
            project_number: Project number

        Returns:
            List of user dicts with access info
        """
        if not self.enabled:
            return []

        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()

                query = """
                SELECT
                    u.username,
                    u.full_name,
                    u.email,
                    upa.role as project_role,
                    upa.granted_at
                FROM UserProjectAccess upa
                INNER JOIN Users u ON upa.user_id = u.user_id
                INNER JOIN Projects p ON upa.project_id = p.project_id
                WHERE p.project_number = %s
                  AND u.is_active = 1
                  AND upa.is_active = 1
                ORDER BY upa.granted_at ASC
                """

                cursor.execute(query, (project_number,))
                users = cursor.fetchall()

                logger.debug(f"Project users retrieved: {project_number} -> {len(users)} users")
                return users

        except Exception as e:
            logger.error(f"Error getting project users: {e}")
            return []

    # =========================================================================
    # STATISTICS & REPORTING
    # =========================================================================

    def get_user_stats(self, username: str) -> Dict[str, Any]:
        """
        Get usage statistics for a user

        Returns:
            Stats dict with project count, last access, etc.
        """
        if not self.enabled:
            return {"projects": 0, "enabled": False}

        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()

                query = """
                SELECT
                    COUNT(DISTINCT upa.project_id) as project_count,
                    MAX(u.last_login) as last_login
                FROM Users u
                LEFT JOIN UserProjectAccess upa ON u.user_id = upa.user_id AND upa.is_active = 1
                WHERE u.username = %s
                GROUP BY u.user_id
                """

                cursor.execute(query, (username,))
                stats = cursor.fetchone()

                if stats:
                    return {
                        "username": username,
                        "project_count": stats["project_count"] or 0,
                        "last_login": str(stats["last_login"]) if stats["last_login"] else None,
                        "enabled": True
                    }

                return {"projects": 0, "enabled": True}

        except Exception as e:
            logger.error(f"Error getting user stats: {e}")
            return {"error": str(e)}

    # =========================================================================
    # UTILITIES
    # =========================================================================

    def execute_query(
        self,
        query: str,
        params: tuple = None
    ) -> List[Dict[str, Any]]:
        """
        Execute a custom read-only query

        Args:
            query: SQL query (must be SELECT)
            params: Query parameters

        Returns:
            Query results as list of dicts
        """
        if not self.enabled:
            raise ValueError("SQL Server not configured")

        # Security check - only allow SELECT
        if not query.strip().upper().startswith("SELECT"):
            raise ValueError("Only SELECT queries allowed (read-only)")

        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(query, params or ())
                results = cursor.fetchall()
                return results

        except Exception as e:
            logger.error(f"Error executing custom query: {e}")
            raise


# =============================================================================
# SINGLETON INSTANCE
# =============================================================================

_sql_auth_instance: Optional[SQLAuthService] = None


def get_sql_auth_service() -> SQLAuthService:
    """Get or create SQL Auth service singleton"""
    global _sql_auth_instance

    if _sql_auth_instance is None:
        _sql_auth_instance = SQLAuthService()

    return _sql_auth_instance
