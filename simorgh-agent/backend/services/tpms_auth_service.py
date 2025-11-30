"""
TPMS Database Authentication Service
======================================
Connection to TPMS MySQL database for user authentication and authorization.

Tables:
- technical_user: User credentials
- draft.permission: Project access control

Author: Simorgh Industrial Assistant
"""

import os
import logging
from typing import Optional, Dict, Any
import pymysql
from contextlib import contextmanager
from services.hash_detector import HashDetector

logger = logging.getLogger(__name__)


class TPMSAuthService:
    """
    TPMS MySQL Authentication Service

    Features:
    - User login verification against technical_user table
    - Auto-detects password hash type (SHA-256, MD5, bcrypt)
    - Password verification with HashDetector
    - Project permission checking via draft.permission table
    - Secure, read-only database access
    """

    def __init__(
        self,
        host: str = None,
        port: int = None,
        user: str = None,
        password: str = None,
        database: str = None
    ):
        """Initialize TPMS MySQL connection parameters"""
        self.host = host or os.getenv("MYSQL_HOST", "localhost")
        self.port = port or int(os.getenv("MYSQL_PORT", "3306"))
        self.user = user or os.getenv("MYSQL_USER", "root")
        self.password = password or os.getenv("MYSQL_PASSWORD", "")
        self.database = database or os.getenv("MYSQL_DATABASE", "TPMS")

        if not all([self.host, self.user, self.password, self.database]):
            logger.warning("⚠️ TPMS MySQL credentials not fully configured")
            self.enabled = False
        else:
            self.enabled = True
            logger.info(f"✅ TPMS Auth Service initialized: {self.host}:{self.port}/{self.database}")

    @contextmanager
    def get_connection(self):
        """
        Context manager for database connections
        Ensures connections are properly closed
        """
        if not self.enabled:
            raise ValueError("TPMS authentication not configured")

        conn = None
        try:
            conn = pymysql.connect(
                host=self.host,
                port=self.port,
                user=self.user,
                password=self.password,
                database=self.database,
                connect_timeout=10,
                read_timeout=10,
                write_timeout=10,
                charset='utf8mb4',
                cursorclass=pymysql.cursors.DictCursor
            )
            yield conn
        except pymysql.Error as e:
            logger.error(f"TPMS MySQL connection error: {e}")
            raise
        finally:
            if conn:
                conn.close()

    def health_check(self) -> Dict[str, Any]:
        """Check TPMS database connectivity"""
        if not self.enabled:
            return {
                "status": "disabled",
                "message": "TPMS authentication not configured"
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
            logger.error(f"TPMS health check failed: {e}")
            return {
                "status": "unhealthy",
                "error": str(e)
            }

    # =========================================================================
    # AUTHENTICATION
    # =========================================================================

    def authenticate_user(
        self,
        username: str,
        password: str
    ) -> Optional[Dict[str, Any]]:
        """
        Authenticate user against technical_user table

        Args:
            username: User's EMPUSERNAME
            password: Plain text password to verify

        Returns:
            User info dict if authentication successful, None otherwise

        Example return:
        {
            "ID": 123,
            "EMPUSERNAME": "ali.rezaei",
            "USER_UID": "AR001"
        }
        """
        if not self.enabled:
            logger.warning("TPMS auth disabled, denying access")
            return None

        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()

                # Query technical_user table
                query = """
                SELECT ID, EMPUSERNAME, USER_UID, DraftPassword
                FROM technical_user
                WHERE EMPUSERNAME = %s
                LIMIT 1
                """

                cursor.execute(query, (username,))
                user = cursor.fetchone()

                if not user:
                    logger.warning(f"User not found: {username}")
                    return None

                # Get stored password hash
                stored_password = user.get("DraftPassword")
                if not stored_password:
                    logger.error(f"No password hash found for user: {username}")
                    return None

                # Convert binary/bytes to hex string if needed
                if isinstance(stored_password, bytes):
                    stored_password = stored_password.hex()

                # Auto-detect hash type and verify
                hash_detector = HashDetector()
                is_valid, hash_type = hash_detector.verify_password(password, stored_password)

                if not is_valid:
                    logger.warning(f"Invalid password for user: {username} (hash type: {hash_type})")
                    return None

                logger.info(f"Authentication successful for {username} (hash type: {hash_type})")

                # Authentication successful - return user info (without password)
                return {
                    "ID": user["ID"],
                    "EMPUSERNAME": user["EMPUSERNAME"],
                    "USER_UID": user["USER_UID"]
                }

        except Exception as e:
            logger.error(f"Authentication error: {e}")
            return None

    def get_user_by_username(self, username: str) -> Optional[Dict[str, Any]]:
        """
        Get user information by username (without authentication)

        Args:
            username: User's EMPUSERNAME

        Returns:
            User info dict or None if not found
        """
        if not self.enabled:
            return None

        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()

                query = """
                SELECT ID, EMPUSERNAME, USER_UID
                FROM technical_user
                WHERE EMPUSERNAME = %s
                LIMIT 1
                """

                cursor.execute(query, (username,))
                user = cursor.fetchone()

                return user

        except Exception as e:
            logger.error(f"Error getting user: {e}")
            return None

    # =========================================================================
    # AUTHORIZATION
    # =========================================================================

    def check_project_permission(
        self,
        username: str,
        project_id: str
    ) -> bool:
        """
        Check if user has permission to access a project

        Args:
            username: User's EMPUSERNAME
            project_id: Project ID (e.g., "11849")

        Returns:
            True if user has access, False otherwise

        Checks draft.permission table for (project_ID, user) match
        """
        if not self.enabled:
            logger.warning("TPMS auth disabled, allowing access")
            return True

        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()

                # Query draft.permission table
                query = """
                SELECT COUNT(*) as has_access
                FROM draft.permission
                WHERE project_ID = %s
                  AND user = %s
                """

                cursor.execute(query, (project_id, username))
                result = cursor.fetchone()

                has_access = result["has_access"] > 0 if result else False

                logger.info(
                    f"Project permission check: {username} -> {project_id} = {has_access}"
                )
                return has_access

        except Exception as e:
            logger.error(f"Error checking project permission: {e}")
            # Fail closed - deny access on error
            return False

    def get_user_projects(self, username: str) -> list[str]:
        """
        Get all project IDs that a user has access to

        Args:
            username: User's EMPUSERNAME

        Returns:
            List of project IDs
        """
        if not self.enabled:
            return []

        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()

                query = """
                SELECT project_ID
                FROM draft.permission
                WHERE user = %s
                ORDER BY project_ID
                """

                cursor.execute(query, (username,))
                results = cursor.fetchall()

                project_ids = [row["project_ID"] for row in results]

                logger.info(f"User projects retrieved: {username} -> {len(project_ids)} projects")
                return project_ids

        except Exception as e:
            logger.error(f"Error getting user projects: {e}")
            return []


# =============================================================================
# SINGLETON INSTANCE
# =============================================================================

_tpms_auth_instance: Optional[TPMSAuthService] = None


def get_tpms_auth_service() -> TPMSAuthService:
    """Get or create TPMS Auth service singleton"""
    global _tpms_auth_instance

    if _tpms_auth_instance is None:
        _tpms_auth_instance = TPMSAuthService()

    return _tpms_auth_instance
