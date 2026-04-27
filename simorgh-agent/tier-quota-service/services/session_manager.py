"""
Session Manager Service
========================
Manages session lifecycle including creation, tracking, and complete deletion.
Ensures strict data isolation and cascade deletion across all storage layers.

Author: Simorgh Industrial Assistant
"""

import os
import logging
import shutil
from typing import Dict, Any, Optional
from pathlib import Path

logger = logging.getLogger(__name__)


class SessionManager:
    """
    Session manager for handling session lifecycle and data deletion
    """

    def __init__(
        self,
        qdrant_service=None,
        neo4j_driver=None,
        redis_service=None,
        upload_dir: Optional[str] = None
    ):
        """
        Initialize Session Manager

        Args:
            qdrant_service: QdrantService instance
            neo4j_driver: Neo4j driver instance
            redis_service: RedisService instance
            upload_dir: Upload directory path (default: /app/uploads)
        """
        self.qdrant_service = qdrant_service
        self.neo4j_driver = neo4j_driver
        self.redis_service = redis_service
        self.upload_dir = upload_dir or os.getenv("UPLOAD_DIR", "/app/uploads")

    def delete_session_completely(
        self,
        user_id: str,
        session_id: Optional[str] = None,
        project_oenum: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Complete cascade deletion of session data across ALL storage layers

        This method ensures NO data remains after deletion:
        - Qdrant: Delete session-specific collection
        - Neo4j: Delete all nodes and relationships for project/session
        - File Storage: Delete all uploaded documents
        - Redis: Delete all cached data

        Args:
            user_id: User identifier
            session_id: Optional session ID for general chats
            project_oenum: Optional project OE number for project chats

        Returns:
            Deletion result with statistics
        """
        stats = {
            "qdrant_deleted": False,
            "neo4j_deleted": False,
            "files_deleted": False,
            "redis_deleted": False,
            "errors": []
        }

        session_type = "project" if project_oenum else "session"
        session_identifier = project_oenum or session_id

        logger.info(f"🗑️ Starting complete deletion for {session_type}: {session_identifier}, user: {user_id}")

        # 1. Delete Qdrant collection
        if self.qdrant_service:
            try:
                logger.info(f"🗑️ Deleting Qdrant collection...")
                success = self.qdrant_service.delete_session_collection(
                    user_id=user_id,
                    session_id=session_id,
                    project_oenum=project_oenum
                )
                stats["qdrant_deleted"] = success
                if success:
                    logger.info(f"✅ Qdrant collection deleted")
            except Exception as e:
                logger.error(f"❌ Qdrant deletion failed: {e}")
                stats["errors"].append(f"Qdrant: {str(e)}")

        # 2. Delete Neo4j graph data (for projects)
        if self.neo4j_driver and project_oenum:
            try:
                logger.info(f"🗑️ Deleting Neo4j graph data for project {project_oenum}...")
                deleted_count = self._delete_neo4j_project_data(project_oenum)
                stats["neo4j_deleted"] = deleted_count > 0
                stats["neo4j_nodes_deleted"] = deleted_count
                logger.info(f"✅ Deleted {deleted_count} Neo4j nodes/relationships")
            except Exception as e:
                logger.error(f"❌ Neo4j deletion failed: {e}")
                stats["errors"].append(f"Neo4j: {str(e)}")

        # 3. Delete file storage
        try:
            logger.info(f"🗑️ Deleting uploaded files...")
            deleted_files = self._delete_session_files(user_id, session_identifier, session_type)
            stats["files_deleted"] = deleted_files > 0
            stats["files_deleted_count"] = deleted_files
            logger.info(f"✅ Deleted {deleted_files} files")
        except Exception as e:
            logger.error(f"❌ File deletion failed: {e}")
            stats["errors"].append(f"Files: {str(e)}")

        # 4. Delete Redis cache entries
        if self.redis_service:
            try:
                logger.info(f"🗑️ Deleting Redis cache entries...")
                cache_keys = self._delete_redis_cache(user_id, session_identifier, session_type)
                stats["redis_deleted"] = cache_keys > 0
                stats["redis_keys_deleted"] = cache_keys
                logger.info(f"✅ Deleted {cache_keys} Redis cache entries")
            except Exception as e:
                logger.error(f"❌ Redis deletion failed: {e}")
                stats["errors"].append(f"Redis: {str(e)}")

        # Calculate success
        stats["success"] = (
            stats["qdrant_deleted"] and
            (stats["neo4j_deleted"] if project_oenum else True) and
            len(stats["errors"]) == 0
        )

        if stats["success"]:
            logger.info(f"✅ Complete deletion successful for {session_type}: {session_identifier}")
        else:
            logger.warning(f"⚠️ Deletion completed with errors: {stats['errors']}")

        return stats

    def _delete_neo4j_project_data(self, project_oenum: str) -> int:
        """
        Delete all Neo4j nodes and relationships for a project

        Args:
            project_oenum: Project OE number

        Returns:
            Number of deleted nodes/relationships
        """
        if not self.neo4j_driver:
            return 0

        with self.neo4j_driver.session() as session:
            # Delete all nodes and relationships connected to the project
            query = """
            MATCH (p:Project {oenum: $project_oenum})
            OPTIONAL MATCH (p)-[r*]-(connected)
            DETACH DELETE p, connected
            RETURN count(p) + count(connected) as deleted_count
            """

            result = session.run(query, project_oenum=project_oenum)
            record = result.single()
            return record["deleted_count"] if record else 0

    def _delete_session_files(
        self,
        user_id: str,
        session_identifier: str,
        session_type: str
    ) -> int:
        """
        Delete uploaded files for a session

        Args:
            user_id: User identifier
            session_identifier: Session ID or project OE number
            session_type: "session" or "project"

        Returns:
            Number of deleted files
        """
        deleted_count = 0

        # Construct possible file paths
        if session_type == "project":
            # Project files: /uploads/projects/{project_oenum}/
            session_dir = Path(self.upload_dir) / "projects" / session_identifier
        else:
            # Session files: /uploads/users/{user_id}/sessions/{session_id}/
            session_dir = Path(self.upload_dir) / "users" / user_id / "sessions" / session_identifier

        if session_dir.exists():
            try:
                # Count files before deletion
                deleted_count = sum(1 for _ in session_dir.rglob("*") if _.is_file())

                # Delete directory and all contents
                shutil.rmtree(session_dir)
                logger.info(f"🗑️ Deleted session directory: {session_dir}")
            except Exception as e:
                logger.error(f"❌ Failed to delete directory {session_dir}: {e}")
                raise

        return deleted_count

    def _delete_redis_cache(
        self,
        user_id: str,
        session_identifier: str,
        session_type: str
    ) -> int:
        """
        Delete Redis cache entries for a session

        Args:
            user_id: User identifier
            session_identifier: Session ID or project OE number
            session_type: "session" or "project"

        Returns:
            Number of deleted cache keys
        """
        if not self.redis_service:
            return 0

        deleted_count = 0

        # Patterns to match session-specific cache keys
        patterns = [
            f"session:{session_identifier}:*",
            f"user:{user_id}:session:{session_identifier}:*",
            f"chat:{session_identifier}:*",
        ]

        if session_type == "project":
            patterns.extend([
                f"project:{session_identifier}:*",
                f"spec_task:*:project:{session_identifier}:*",
            ])

        try:
            for pattern in patterns:
                # Find matching keys
                keys = self.redis_service.client.keys(pattern)

                # Delete each key
                for key in keys:
                    self.redis_service.client.delete(key)
                    deleted_count += 1

                if keys:
                    logger.info(f"🗑️ Deleted {len(keys)} Redis keys matching pattern: {pattern}")

        except Exception as e:
            logger.error(f"❌ Redis cache deletion error: {e}")
            raise

        return deleted_count

    def list_user_sessions(self, user_id: str) -> Dict[str, Any]:
        """
        List all sessions for a user (from Qdrant collections)

        Args:
            user_id: User identifier

        Returns:
            Dict with general sessions and project sessions
        """
        if not self.qdrant_service:
            return {"general_sessions": [], "project_sessions": []}

        try:
            # Get all collections
            collections = self.qdrant_service.client.get_collections().collections

            # Filter for user's collections
            user_prefix = f"user_{user_id.replace('-', '_').replace('.', '_').lower()}"

            general_sessions = []
            project_sessions = []

            for collection in collections:
                if collection.name.startswith(user_prefix):
                    if "_session_" in collection.name:
                        # General session
                        session_id = collection.name.split("_session_")[-1]
                        general_sessions.append({
                            "session_id": session_id,
                            "collection_name": collection.name,
                            "vectors_count": collection.vectors_count
                        })
                    elif "_project_" in collection.name:
                        # Project session
                        project_oenum = collection.name.split("_project_")[-1]
                        project_sessions.append({
                            "project_oenum": project_oenum,
                            "collection_name": collection.name,
                            "vectors_count": collection.vectors_count
                        })

            return {
                "user_id": user_id,
                "general_sessions": general_sessions,
                "project_sessions": project_sessions,
                "total_sessions": len(general_sessions) + len(project_sessions)
            }

        except Exception as e:
            logger.error(f"❌ Failed to list user sessions: {e}")
            return {
                "user_id": user_id,
                "general_sessions": [],
                "project_sessions": [],
                "error": str(e)
            }
