"""
Session ID Generator Service
=============================
Generates unique, human-friendly session IDs with atomic Redis counters.

Session ID Formats:
- General sessions: G-yyyyMM-nnnnnn (e.g., G-202512-000123)
- Project sessions: P-ProjectID-nnnnnn (e.g., P-12345-000123)

Chat Message IDs:
- Format: S-{sessionId}-M-nnn (e.g., S-G-202512-000123-M-001)

Features:
- Atomic counter operations using Redis INCR
- Deterministic, sortable IDs
- Project isolation for project sessions
- Monthly counter reset for general sessions

Author: Simorgh Industrial Assistant
"""

import logging
from datetime import datetime
from typing import Tuple
from redis.exceptions import RedisError
import redis

logger = logging.getLogger(__name__)


class SessionIDService:
    """
    Session ID Generator with Redis-backed atomic counters

    Uses Redis INCR for lock-free, atomic counter increments.
    Counters are stored per category and reset monthly for general sessions.
    """

    def __init__(self, redis_client: redis.Redis):
        """
        Initialize Session ID Service

        Args:
            redis_client: Redis client (should be session DB)
        """
        self.redis = redis_client
        logger.info("✅ Session ID Service initialized")

    def generate_general_session_id(self) -> str:
        """
        Generate a unique general session ID

        Format: G-yyyyMM-nnnnnn
        Example: G-202512-000123

        Uses monthly counter that resets each month.

        Returns:
            Session ID string

        Raises:
            RedisError: If Redis operation fails
        """
        try:
            # Get current year-month
            now = datetime.now()
            year_month = now.strftime("%Y%m")  # e.g., "202512"

            # Atomic counter increment
            counter_key = f"session:counter:general:{year_month}"
            counter = self.redis.incr(counter_key)

            # Set TTL to expire counter after 2 months (in case of low activity)
            # This prevents indefinite accumulation of old counters
            self.redis.expire(counter_key, 60 * 24 * 3600)  # 60 days

            # Format session ID
            session_id = f"G-{year_month}-{counter:06d}"

            logger.info(f"✅ Generated general session ID: {session_id}")
            return session_id

        except RedisError as e:
            logger.error(f"❌ Failed to generate general session ID: {e}")
            raise

    def generate_project_session_id(self, project_id: str) -> str:
        """
        Generate a unique project session ID

        Format: P-ProjectID-nnnnnn
        Example: P-12345-000123

        Counter is per-project and never resets.

        Args:
            project_id: Project identifier (e.g., "12345" from IDProjectMain)

        Returns:
            Session ID string

        Raises:
            RedisError: If Redis operation fails
        """
        try:
            # Atomic counter increment per project
            counter_key = f"session:counter:project:{project_id}"
            counter = self.redis.incr(counter_key)

            # Format session ID
            session_id = f"P-{project_id}-{counter:06d}"

            logger.info(f"✅ Generated project session ID: {session_id}")
            return session_id

        except RedisError as e:
            logger.error(f"❌ Failed to generate project session ID: {e}")
            raise

    def generate_message_id(self, session_id: str, message_sequence: int) -> str:
        """
        Generate a unique message ID within a session

        Format: S-{sessionId}-M-nnn
        Example: S-G-202512-000123-M-001

        Args:
            session_id: Parent session ID
            message_sequence: Message sequence number (1-indexed)

        Returns:
            Message ID string
        """
        message_id = f"S-{session_id}-M-{message_sequence:03d}"
        return message_id

    def parse_session_id(self, session_id: str) -> Tuple[str, str]:
        """
        Parse a session ID to extract category and metadata

        Args:
            session_id: Session ID to parse

        Returns:
            Tuple of (category, identifier)
            - For general: ("general", "202512")
            - For project: ("project", "12345")

        Raises:
            ValueError: If session ID format is invalid
        """
        parts = session_id.split("-")

        if len(parts) < 3:
            raise ValueError(f"Invalid session ID format: {session_id}")

        category_prefix = parts[0]

        if category_prefix == "G":
            # General session: G-202512-000123
            return ("general", parts[1])
        elif category_prefix == "P":
            # Project session: P-12345-000123
            return ("project", parts[1])
        else:
            raise ValueError(f"Unknown session category: {category_prefix}")

    def validate_session_id(self, session_id: str) -> bool:
        """
        Validate a session ID format

        Args:
            session_id: Session ID to validate

        Returns:
            True if valid, False otherwise
        """
        try:
            parts = session_id.split("-")

            if len(parts) < 3:
                return False

            category = parts[0]
            if category not in ["G", "P"]:
                return False

            # Validate counter is numeric and 6 digits
            counter = parts[-1]
            if len(counter) != 6 or not counter.isdigit():
                return False

            return True

        except Exception:
            return False

    def get_counter_status(self, category: str, identifier: str = None) -> int:
        """
        Get current counter value (for diagnostics)

        Args:
            category: "general" or "project"
            identifier: Year-month for general (e.g., "202512") or project ID for project

        Returns:
            Current counter value (0 if not set)
        """
        try:
            if category == "general":
                counter_key = f"session:counter:general:{identifier}"
            elif category == "project":
                counter_key = f"session:counter:project:{identifier}"
            else:
                raise ValueError(f"Invalid category: {category}")

            value = self.redis.get(counter_key)
            return int(value) if value else 0

        except RedisError as e:
            logger.error(f"❌ Failed to get counter status: {e}")
            return 0


# =============================================================================
# FACTORY FUNCTION
# =============================================================================

def create_session_id_service(redis_service) -> SessionIDService:
    """
    Create SessionIDService instance from RedisService

    Args:
        redis_service: RedisService instance

    Returns:
        SessionIDService instance
    """
    # Use session DB (DB 0) for counters
    return SessionIDService(redis_service.session_client)
