"""
TPMS Database Authentication Service
======================================
Connection to TPMS MySQL database for user authentication and authorization.

Tables:
- technical_users: User credentials
- draft_permission: Project access control

Author: Simorgh Industrial Assistant
"""

import os
import logging
from typing import Optional, Dict, Any, Tuple, List
import pymysql
from contextlib import contextmanager
from services.hash_detector import HashDetector

logger = logging.getLogger(__name__)


class TPMSAuthService:
    """
    TPMS MySQL Authentication Service

    Features:
    - User login verification against technical_users table
    - Auto-detects password hash type (SHA-256, MD5, bcrypt)
    - Password verification with HashDetector
    - Project permission checking via draft_permission table
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
        Authenticate user against technical_users table

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

                # Query technical_users table
                query = """
                SELECT ID, EMPUSERNAME, USER_UID, DraftPassword
                FROM technical_users
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
                FROM technical_users
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

        Checks draft_permission table for (project_ID, user) match
        """
        if not self.enabled:
            logger.warning("TPMS auth disabled, allowing access")
            return True

        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()

                # DEBUG: Check all permissions for this user
                debug_query = """
                SELECT project_ID, user
                FROM draft_permission
                WHERE user = %s
                LIMIT 10
                """
                cursor.execute(debug_query, (username,))
                user_perms = cursor.fetchall()
                logger.info(f"📋 User {username} has {len(user_perms)} permissions: {[p['project_ID'] for p in user_perms]}")

                # Query draft_permission table
                # Try both as string and as integer to handle type variations
                query = """
                SELECT COUNT(*) as has_access
                FROM draft_permission
                WHERE (project_ID = %s OR project_ID = CAST(%s AS CHAR))
                  AND user = %s
                """

                cursor.execute(query, (project_id, project_id, username))
                result = cursor.fetchone()

                has_access = result["has_access"] > 0 if result else False

                logger.info(
                    f"🔐 Permission check: user={username}, project={project_id}, access={has_access}"
                )

                # DEBUG: If no access, try to find why
                if not has_access:
                    # Check if project exists with different user
                    check_project = """
                    SELECT user FROM draft_permission WHERE project_ID = %s OR project_ID = CAST(%s AS CHAR) LIMIT 5
                    """
                    cursor.execute(check_project, (project_id, project_id))
                    project_users = cursor.fetchall()
                    logger.warning(f"⚠️ Project {project_id} has users: {[u['user'] for u in project_users]}")

                return has_access

        except Exception as e:
            logger.error(f"❌ Error checking project permission: {e}")
            import traceback
            logger.error(traceback.format_exc())
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
                FROM draft_permission
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

    # =========================================================================
    # PROJECT LOOKUP
    # =========================================================================

    def get_project_by_id(self, project_id: str) -> Optional[Dict[str, Any]]:
        """
        Get project details from View_Project_Main table

        Args:
            project_id: Project ID (IDProjectMain) to look up

        Returns:
            Project info dict with IDProjectMain and Project_Name, or None if not found

        Example return:
        {
            "IDProjectMain": 12345,
            "Project_Name": "Industrial Plant XYZ"
        }
        """
        if not self.enabled:
            logger.warning("TPMS database disabled, cannot lookup project")
            return None

        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()

                # Query View_Project_Main to get project details
                query = """
                SELECT IDProjectMain, Project_Name
                FROM View_Project_Main
                WHERE IDProjectMain = %s
                LIMIT 1
                """

                cursor.execute(query, (project_id,))
                project = cursor.fetchone()

                if not project:
                    logger.warning(f"Project not found in View_Project_Main: {project_id}")
                    return None

                logger.info(f"✅ Project found: {project_id} -> {project.get('Project_Name', 'N/A')}")

                return {
                    "IDProjectMain": project["IDProjectMain"],
                    "Project_Name": project["Project_Name"]
                }

        except Exception as e:
            logger.error(f"❌ Error looking up project: {e}")
            import traceback
            logger.error(traceback.format_exc())
            return None

    def get_project_by_oenum(self, oenum_suffix: str) -> Optional[Dict[str, Any]]:
        """
        Get project details from View_Project_Main table by last 5 digits of OENUM

        Args:
            oenum_suffix: Last 5 digits of OENUM (e.g., "12065" for "04A12065")

        Returns:
            Project info dict with IDProjectMain, Project_Name, and OENUM, or None if not found

        Example:
            Input: "12065"
            Finds: OENUM "04A12065"
            Returns: {
                "IDProjectMain": 12345,
                "Project_Name": "Industrial Plant XYZ",
                "OENUM": "04A12065"
            }
        """
        if not self.enabled:
            logger.warning("TPMS database disabled, cannot lookup project")
            return None

        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()

                # Query View_Project_Main by last 5 digits of OENUM using RIGHT()
                query = """
                SELECT TOP 1 IDProjectMain, Project_Name, OENUM
                FROM View_Project_Main
                WHERE RIGHT(OENUM, 5) = %s
                ORDER BY IDProjectMain DESC
                """

                cursor.execute(query, (oenum_suffix,))
                project = cursor.fetchone()

                if not project:
                    logger.warning(f"Project not found with OENUM ending in: {oenum_suffix}")
                    return None

                logger.info(f"✅ Project found by OENUM suffix '{oenum_suffix}': Full OENUM={project.get('OENUM')}, IDProjectMain={project.get('IDProjectMain')}, Name={project.get('Project_Name', 'N/A')}")

                return {
                    "IDProjectMain": project["IDProjectMain"],
                    "Project_Name": project["Project_Name"],
                    "OENUM": project["OENUM"]
                }

        except Exception as e:
            logger.error(f"❌ Error looking up project by OENUM: {e}")
            import traceback
            logger.error(traceback.format_exc())
            return None

    def search_oenum_autocomplete(self, search_query: str, limit: int = 20) -> List[Dict[str, Any]]:
        """
        Search OENUMs for autocomplete - finds all OENUMs containing the search query

        Args:
            search_query: Partial OENUM to search for (e.g., "120", "12065", "04A")
            limit: Maximum number of results to return (default 20)

        Returns:
            List of matching projects with OENUM, Project_Name, and IDProjectMain

        Example:
            Input: "120"
            Finds: OENUMs containing "120" anywhere (e.g., "04A12065", "12045B", "W120-45")
            Returns: [
                {"OENUM": "04A12065", "Project_Name": "Plant A", "IDProjectMain": 123},
                {"OENUM": "06B12045", "Project_Name": "Plant B", "IDProjectMain": 456},
                ...
            ]
        """
        if not self.enabled:
            logger.warning("TPMS database disabled, cannot search OENUMs")
            return []

        if not search_query or not search_query.strip():
            return []

        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()

                # Search for OENUMs containing the search query using LIKE '%query%'
                # This matches the query anywhere in the OENUM field
                query = """
                SELECT TOP %s OENUM, Project_Name, IDProjectMain
                FROM View_Project_Main
                WHERE OENUM LIKE %s
                ORDER BY OENUM DESC
                """

                # Use %query% pattern to search anywhere in OENUM
                search_pattern = f"%{search_query.strip()}%"

                cursor.execute(query, (limit, search_pattern))
                results = cursor.fetchall()

                if not results:
                    logger.info(f"No OENUMs found containing: {search_query}")
                    return []

                # Convert to list of dicts
                projects = []
                for row in results:
                    projects.append({
                        "OENUM": row["OENUM"],
                        "Project_Name": row["Project_Name"],
                        "IDProjectMain": row["IDProjectMain"]
                    })

                logger.info(f"✅ Found {len(projects)} OENUMs containing '{search_query}'")
                return projects

        except Exception as e:
            logger.error(f"❌ Error searching OENUMs: {e}")
            import traceback
            logger.error(traceback.format_exc())
            return []

    def validate_project_access(
        self,
        username: str,
        project_id: str
    ) -> Tuple[bool, Optional[str], Optional[str]]:
        """
        Validate project access with detailed error messages

        Combines project lookup and permission check into one call.

        Args:
            username: User's EMPUSERNAME
            project_id: Project ID to validate

        Returns:
            Tuple of (has_access, error_code, error_message)
            - (True, None, None) if access granted
            - (False, "project_not_found", "Project ID not found") if project doesn't exist
            - (False, "access_denied", "Access denied for project X") if no permission
            - (False, "error", "Error message") if database error

        Example:
            has_access, error_code, error_msg = validate_project_access("john", "12345")
            if not has_access:
                return {"error": error_code, "message": error_msg}, 403
        """
        if not self.enabled:
            # If auth is disabled, allow all access (development mode)
            logger.warning("TPMS auth disabled, allowing access")
            return (True, None, None)

        try:
            # Step 1: Check if project exists
            project = self.get_project_by_id(project_id)
            if not project:
                return (
                    False,
                    "project_not_found",
                    f"Project ID {project_id} not found in database"
                )

            # Step 2: Check user permission
            has_permission = self.check_project_permission(username, project_id)
            if not has_permission:
                return (
                    False,
                    "access_denied",
                    f"Access denied for project {project_id}"
                )

            # Access granted
            return (True, None, None)

        except Exception as e:
            logger.error(f"❌ Error validating project access: {e}")
            return (
                False,
                "error",
                f"Database error: {str(e)}"
            )


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
