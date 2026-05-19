"""
Project Memory Service
=======================
Unified memory layer for the Project Manager Agent.
Manages 4-tier memory: Redis (hot) → PostgreSQL (persistent) → Qdrant (vectors) → Neo4j (graph).

No TPMS data is used in memory allocation for modern users.
Legacy users can optionally access TPMS data through separate endpoints.
"""

import json
import logging
import uuid
from datetime import datetime
from typing import Optional, List, Dict, Any, Tuple

logger = logging.getLogger(__name__)

# Redis key patterns for project agent
REDIS_PREFIX = "project_agent"
TTL_AGENT_STATE = 86400      # 24h - agent state
TTL_TASK_CACHE = 3600        # 1h - task cache
TTL_CONTEXT_CACHE = 1800     # 30m - context cache
TTL_COT_RESULT = 7200        # 2h - COT analysis results


class ProjectMemoryService:
    """Unified memory service for project agent operations."""

    def __init__(self, redis_service=None, postgres_service=None,
                 qdrant_service=None, neo4j_service=None):
        self.redis = redis_service
        self.pg = postgres_service
        self.qdrant = qdrant_service
        self.neo4j = neo4j_service

    def set_services(self, redis=None, postgres=None, qdrant=None, neo4j=None):
        if redis:
            self.redis = redis
        if postgres:
            self.pg = postgres
        if qdrant:
            self.qdrant = qdrant
        if neo4j:
            self.neo4j = neo4j

    # =========================================================================
    # REDIS (HOT CACHE) - Agent State & Task Cache
    # =========================================================================

    async def set_agent_state(self, project_id: str, state: Dict[str, Any]) -> None:
        """Store agent state in Redis."""
        key = f"{REDIS_PREFIX}:{project_id}:state"
        self.redis.set(key, json.dumps(state, default=str), ttl=TTL_AGENT_STATE, db="session")

    async def get_agent_state(self, project_id: str) -> Optional[Dict[str, Any]]:
        """Get agent state from Redis."""
        key = f"{REDIS_PREFIX}:{project_id}:state"
        data = self.redis.get(key, db="session")
        return json.loads(data) if data else None

    async def cache_cot_analysis(self, chain_id: str, analysis: Dict[str, Any]) -> None:
        """Cache COT analysis result."""
        key = f"{REDIS_PREFIX}:cot:{chain_id}"
        self.redis.set(key, json.dumps(analysis, default=str), ttl=TTL_COT_RESULT, db="cache")

    async def get_cached_cot(self, chain_id: str) -> Optional[Dict[str, Any]]:
        """Get cached COT analysis."""
        key = f"{REDIS_PREFIX}:cot:{chain_id}"
        data = self.redis.get(key, db="cache")
        return json.loads(data) if data else None

    async def cache_task_list(self, project_id: str, tasks: List[Dict]) -> None:
        """Cache current task list for quick access."""
        key = f"{REDIS_PREFIX}:{project_id}:tasks"
        self.redis.set(key, json.dumps(tasks, default=str), ttl=TTL_TASK_CACHE, db="cache")

    async def get_cached_tasks(self, project_id: str) -> Optional[List[Dict]]:
        """Get cached task list."""
        key = f"{REDIS_PREFIX}:{project_id}:tasks"
        data = self.redis.get(key, db="cache")
        return json.loads(data) if data else None

    async def invalidate_task_cache(self, project_id: str) -> None:
        """Invalidate task cache (after task update)."""
        key = f"{REDIS_PREFIX}:{project_id}:tasks"
        self.redis.delete(key, db="cache")

    async def store_working_memory(self, project_id: str, key: str, value: Any) -> None:
        """Store arbitrary working memory for agent."""
        redis_key = f"{REDIS_PREFIX}:{project_id}:memory:{key}"
        self.redis.set(redis_key, json.dumps(value, default=str), ttl=TTL_CONTEXT_CACHE, db="cache")

    async def get_working_memory(self, project_id: str, key: str) -> Optional[Any]:
        """Get working memory value."""
        redis_key = f"{REDIS_PREFIX}:{project_id}:memory:{key}"
        data = self.redis.get(redis_key, db="cache")
        return json.loads(data) if data else None

    # =========================================================================
    # POSTGRESQL - Projects, Tasks, Messages, Documents
    # =========================================================================

    async def create_project(self, owner_id: str, name: str,
                             description: str = None, tpms_oenum: str = None,
                             agent_model: str = "gpt-4o",
                             metadata: Dict = None,
                             gitlab_repo_path: str = None,
                             gitlab_repo_url: str = None,
                             gitlab_base_branch: str = None,
                             sources_enabled: Dict = None) -> Dict[str, Any]:
        """Create a new project in PostgreSQL.

        Extra fields land in the migration-004 columns; older callers that
        don't pass them get NULL/`{}` defaults.
        """
        project_id = str(uuid.uuid4())
        query = """
            INSERT INTO projects (
                id, owner_id, name, description, tpms_oenum,
                agent_model, metadata,
                gitlab_repo_path, gitlab_repo_url, gitlab_base_branch,
                sources_enabled
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
            RETURNING id, owner_id, name, description, tpms_oenum, status,
                      agent_enabled, agent_model, git_repo_initialized,
                      gitlab_repo_path, gitlab_repo_url, gitlab_base_branch,
                      simorgh_branch, sources_enabled,
                      metadata, created_at, updated_at
        """
        result = await self.pg.execute_one_async(
            query, project_id, owner_id, name, description, tpms_oenum,
            agent_model, json.dumps(metadata or {}),
            gitlab_repo_path, gitlab_repo_url, gitlab_base_branch,
            json.dumps(sources_enabled or {}),
        )
        return dict(result) if result else None

    async def get_project(self, project_id: str) -> Optional[Dict[str, Any]]:
        """Get a project by ID."""
        query = """
            SELECT id, owner_id, name, description, tpms_oenum, status,
                   agent_enabled, agent_model, git_repo_initialized,
                   metadata, created_at, updated_at
            FROM projects WHERE id = $1
        """
        result = await self.pg.execute_one_async(query, project_id)
        return dict(result) if result else None

    async def list_projects(self, owner_id: str) -> List[Dict[str, Any]]:
        """List all projects for a user with counts."""
        query = """
            SELECT p.id, p.owner_id, p.name, p.description, p.tpms_oenum,
                   p.status, p.agent_enabled, p.agent_model,
                   p.git_repo_initialized, p.metadata, p.created_at, p.updated_at,
                   COALESCE(tc.task_count, 0) as task_count,
                   COALESCE(tc.active_tasks, 0) as active_task_count,
                   COALESCE(mc.msg_count, 0) as message_count,
                   COALESCE(dc.doc_count, 0) as document_count
            FROM projects p
            LEFT JOIN LATERAL (
                SELECT COUNT(*) as task_count,
                       COUNT(*) FILTER (WHERE status IN ('pending', 'in_progress')) as active_tasks
                FROM project_tasks WHERE project_id = p.id
            ) tc ON TRUE
            LEFT JOIN LATERAL (
                SELECT COUNT(*) as msg_count FROM project_messages WHERE project_id = p.id
            ) mc ON TRUE
            LEFT JOIN LATERAL (
                SELECT COUNT(*) as doc_count FROM project_documents WHERE project_id = p.id
            ) dc ON TRUE
            WHERE p.owner_id = $1 AND p.status != 'archived'
            ORDER BY p.updated_at DESC
        """
        results = await self.pg.execute_async(query, owner_id)
        return [dict(r) for r in results]

    async def update_project(self, project_id: str, **kwargs) -> Optional[Dict]:
        """Update project fields."""
        set_clauses = []
        params = [project_id]
        idx = 2
        for key, value in kwargs.items():
            if value is not None:
                if key == 'metadata':
                    set_clauses.append(f"{key} = ${idx}::jsonb")
                    params.append(json.dumps(value))
                else:
                    set_clauses.append(f"{key} = ${idx}")
                    params.append(value)
                idx += 1

        if not set_clauses:
            return await self.get_project(project_id)

        query = f"""
            UPDATE projects SET {', '.join(set_clauses)}
            WHERE id = $1
            RETURNING id, owner_id, name, description, tpms_oenum, status,
                      agent_enabled, agent_model, git_repo_initialized,
                      metadata, created_at, updated_at
        """
        result = await self.pg.execute_one_async(query, *params)
        return dict(result) if result else None

    async def delete_project(self, project_id: str) -> bool:
        """Delete a project (cascades to tasks, messages, etc.)."""
        query = "DELETE FROM projects WHERE id = $1 RETURNING id"
        result = await self.pg.execute_one_async(query, project_id)
        return result is not None

    # --- Tasks ---

    async def create_task(self, project_id: str, task_data: Dict) -> Dict[str, Any]:
        """Create a task in PostgreSQL."""
        task_id = str(uuid.uuid4())
        query = """
            INSERT INTO project_tasks (
                id, project_id, instruction_id, parent_task_id, cot_chain_id,
                title, description, task_type, priority,
                tool_used, tool_input, sort_order, triggered_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING *
        """
        result = await self.pg.execute_one_async(
            query, task_id, project_id,
            task_data.get('instruction_id'),
            task_data.get('parent_task_id'),
            task_data.get('cot_chain_id'),
            task_data['title'],
            task_data.get('description'),
            task_data.get('task_type', 'action'),
            task_data.get('priority', 5),
            task_data.get('tool_used'),
            json.dumps(task_data.get('tool_input')) if task_data.get('tool_input') else None,
            task_data.get('sort_order', 0),
            task_data.get('triggered_by', 'user'),
        )
        await self.invalidate_task_cache(project_id)
        return dict(result) if result else None

    async def update_task(self, task_id: str, project_id: str, **kwargs) -> Optional[Dict]:
        """Update a task."""
        set_clauses = []
        params = [task_id]
        idx = 2

        for key, value in kwargs.items():
            if value is not None:
                if key in ('tool_input', 'result_metadata'):
                    set_clauses.append(f"{key} = ${idx}::jsonb")
                    params.append(json.dumps(value))
                else:
                    set_clauses.append(f"{key} = ${idx}")
                    params.append(value)
                idx += 1

        # Auto-set timestamps
        if kwargs.get('status') == 'in_progress' and 'started_at' not in kwargs:
            set_clauses.append(f"started_at = ${idx}")
            params.append(datetime.utcnow())
            idx += 1
        if kwargs.get('status') in ('completed', 'failed') and 'completed_at' not in kwargs:
            set_clauses.append(f"completed_at = ${idx}")
            params.append(datetime.utcnow())
            idx += 1

        if not set_clauses:
            return None

        query = f"UPDATE project_tasks SET {', '.join(set_clauses)} WHERE id = $1 RETURNING *"
        result = await self.pg.execute_one_async(query, *params)
        await self.invalidate_task_cache(project_id)
        return dict(result) if result else None

    async def get_tasks(self, project_id: str, status: str = None,
                        cot_chain_id: str = None, limit: int = 50) -> List[Dict]:
        """Get tasks for a project."""
        conditions = ["project_id = $1"]
        params = [project_id]
        idx = 2

        if status:
            conditions.append(f"status = ${idx}")
            params.append(status)
            idx += 1
        if cot_chain_id:
            conditions.append(f"cot_chain_id = ${idx}")
            params.append(cot_chain_id)
            idx += 1

        where = " AND ".join(conditions)
        query = f"""
            SELECT * FROM project_tasks
            WHERE {where}
            ORDER BY sort_order ASC, created_at ASC
            LIMIT ${idx}
        """
        params.append(limit)

        results = await self.pg.execute_async(query, *params)
        return [dict(r) for r in results]

    async def get_task(self, task_id: str) -> Optional[Dict]:
        """Get a single task."""
        result = await self.pg.execute_one_async(
            "SELECT * FROM project_tasks WHERE id = $1", task_id
        )
        return dict(result) if result else None

    async def get_next_pending_task(self, project_id: str,
                                     cot_chain_id: str = None) -> Optional[Dict]:
        """Get the next pending task to execute."""
        conditions = ["project_id = $1", "status = 'pending'"]
        params = [project_id]
        idx = 2

        if cot_chain_id:
            conditions.append(f"cot_chain_id = ${idx}")
            params.append(cot_chain_id)
            idx += 1

        where = " AND ".join(conditions)
        query = f"""
            SELECT * FROM project_tasks
            WHERE {where}
            ORDER BY sort_order ASC, priority DESC, created_at ASC
            LIMIT 1
        """
        result = await self.pg.execute_one_async(query, *params)
        return dict(result) if result else None

    # --- Messages ---

    async def store_message(self, project_id: str, role: str, content: str,
                            channel: str = "chat", chat_id: str = None,
                            task_id: str = None, **kwargs) -> Dict:
        """Store a project message.

        Write-through: after the Postgres insert succeeds, mirror the
        message into the project's runtime-broker session container under
        /work/.simorgh/messages.jsonl. Mirror failures are logged but never
        raised — Postgres remains the source of truth.
        """
        # Strip null bytes that cause PostgreSQL CharacterNotInRepertoireError
        if content:
            content = content.replace('\x00', '')
        msg_id = str(uuid.uuid4())
        query = """
            INSERT INTO project_messages (
                id, project_id, chat_id, channel, role, content, task_id,
                email_from, email_subject, email_message_id,
                document_id, document_filename, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING *
        """
        result = await self.pg.execute_one_async(
            query, msg_id, project_id, chat_id, channel, role, content, task_id,
            kwargs.get('email_from'), kwargs.get('email_subject'),
            kwargs.get('email_message_id'),
            kwargs.get('document_id'), kwargs.get('document_filename'),
            json.dumps(kwargs.get('metadata', {})),
        )
        # Mirror into the project's session container — best-effort, async.
        if result:
            try:
                from services.container_mirror import mirror_message
                await mirror_message(project_id, role, content,
                                     session_token=chat_id,
                                     metadata=kwargs.get('metadata'))
            except Exception:
                # Never let mirror failure break message persistence.
                pass
        return dict(result) if result else None

    async def get_messages(self, project_id: str, channel: str = None,
                           chat_id: str = None, limit: int = 50) -> List[Dict]:
        """Get messages for a project."""
        conditions = ["project_id = $1"]
        params = [project_id]
        idx = 2

        if channel:
            conditions.append(f"channel = ${idx}")
            params.append(channel)
            idx += 1
        if chat_id:
            conditions.append(f"chat_id = ${idx}")
            params.append(chat_id)
            idx += 1

        where = " AND ".join(conditions)
        query = f"""
            SELECT * FROM project_messages
            WHERE {where}
            ORDER BY created_at ASC
            LIMIT ${idx}
        """
        params.append(limit)

        results = await self.pg.execute_async(query, *params)
        return [dict(r) for r in results]

    async def get_recent_context(self, project_id: str, limit: int = 10) -> List[Dict]:
        """Get recent messages across all channels for context."""
        query = """
            SELECT role, content, channel, created_at
            FROM project_messages
            WHERE project_id = $1
            ORDER BY created_at DESC
            LIMIT $2
        """
        results = await self.pg.execute_async(query, project_id, limit)
        return [dict(r) for r in reversed(results)]

    # --- Instructions ---

    async def create_instruction(self, project_id: str, data: Dict) -> Dict:
        """Create a project instruction."""
        inst_id = str(uuid.uuid4())
        query = """
            INSERT INTO project_instructions (
                id, project_id, step_number, title, content,
                dependencies, allowed_tools, stage, requires_approval, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *
        """
        result = await self.pg.execute_one_async(
            query, inst_id, project_id,
            data['step_number'], data['title'], data['content'],
            data.get('dependencies', []),
            data.get('allowed_tools', []),
            data.get('stage', 'general'),
            data.get('requires_approval', False),
            json.dumps(data.get('metadata', {})),
        )
        return dict(result) if result else None

    async def get_instructions(self, project_id: str) -> List[Dict]:
        """Get all active instructions for a project."""
        query = """
            SELECT * FROM project_instructions
            WHERE project_id = $1 AND is_active = TRUE
            ORDER BY step_number ASC
        """
        results = await self.pg.execute_async(query, project_id)
        return [dict(r) for r in results]

    # --- Documents ---

    async def create_document_record(self, project_id: str, filename: str,
                                     original_filename: str = None,
                                     file_type: str = None,
                                     file_size: int = None,
                                     uploaded_by: str = None) -> Dict:
        """Create a document record."""
        doc_id = str(uuid.uuid4())
        query = """
            INSERT INTO project_documents (
                id, project_id, filename, original_filename,
                file_type, file_size, uploaded_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
        """
        result = await self.pg.execute_one_async(
            query, doc_id, project_id, filename, original_filename,
            file_type, file_size, uploaded_by,
        )
        return dict(result) if result else None

    async def update_document(self, doc_id: str, **kwargs) -> Optional[Dict]:
        """Update document record."""
        set_clauses = []
        params = [doc_id]
        idx = 2
        for key, value in kwargs.items():
            if value is not None:
                if key == 'metadata':
                    set_clauses.append(f"{key} = ${idx}::jsonb")
                    params.append(json.dumps(value))
                elif key in ('qdrant_point_ids', 'neo4j_node_ids'):
                    set_clauses.append(f"{key} = ${idx}")
                    params.append(value)
                else:
                    set_clauses.append(f"{key} = ${idx}")
                    params.append(value)
                idx += 1

        if not set_clauses:
            return None

        query = f"UPDATE project_documents SET {', '.join(set_clauses)} WHERE id = $1 RETURNING *"
        result = await self.pg.execute_one_async(query, *params)
        return dict(result) if result else None

    # --- Git Commits ---

    async def record_git_commit(self, project_id: str, task_id: str,
                                commit_hash: str, message: str,
                                files_changed: List[str] = None) -> Dict:
        """Record a git commit."""
        commit_id = str(uuid.uuid4())
        query = """
            INSERT INTO project_git_commits (id, project_id, task_id,
                                             commit_hash, commit_message, files_changed)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        """
        result = await self.pg.execute_one_async(
            query, commit_id, project_id, task_id,
            commit_hash, message, files_changed or [],
        )
        return dict(result) if result else None

    # =========================================================================
    # QDRANT (VECTORS) - Semantic search across project documents
    # =========================================================================

    async def semantic_search(self, project_id: str, query: str,
                              limit: int = 5) -> List[Dict]:
        """Search project documents semantically via Qdrant."""
        if not self.qdrant:
            return []
        try:
            results = self.qdrant.semantic_search(
                user_id="system",
                query=query,
                limit=limit,
                project_oenum=project_id,
            )
            return results if results else []
        except Exception as e:
            logger.warning(f"Qdrant search failed for project {project_id}: {e}")
            return []

    # =========================================================================
    # NEO4J (GRAPH) - Project knowledge graph
    # =========================================================================

    async def init_project_graph(self, project_id: str, name: str,
                                 owner_id: str, tpms_oenum: str = None) -> Dict:
        """Initialize project node in Neo4j.

        For modern users (no tpms_oenum): creates only the Project node.
        For legacy users (with tpms_oenum): creates full EKC template hierarchy.
        """
        if not self.neo4j:
            return {"status": "neo4j_unavailable"}
        try:
            # Modern projects skip the 57-node EKC template graph
            skip_full_init = not bool(tpms_oenum)
            result = self.neo4j.create_project(
                project_number=project_id,
                project_name=name,
                owner_id=owner_id,
                skip_graph_init=skip_full_init,
            )
            return result
        except Exception as e:
            logger.warning(f"Neo4j project init failed: {e}")
            return {"status": "error", "error": str(e)}

    async def query_graph(self, project_id: str, query: str = None,
                          entity_type: str = None, depth: int = 2) -> Dict:
        """Query the project knowledge graph."""
        if not self.neo4j:
            return {"nodes": [], "relationships": []}
        try:
            if entity_type:
                results = self.neo4j.semantic_search(
                    project_number=project_id,
                    entity_type=entity_type,
                )
                return {"entities": results}
            else:
                graph = self.neo4j.get_full_project_graph(project_id)
                return graph
        except Exception as e:
            logger.warning(f"Neo4j query failed for project {project_id}: {e}")
            return {"nodes": [], "relationships": [], "error": str(e)}

    async def store_graph_entity(self, project_id: str, entity_type: str,
                                 entity_id: str, properties: Dict) -> Dict:
        """Store an entity in the project graph."""
        if not self.neo4j:
            return {"status": "neo4j_unavailable"}
        try:
            result = self.neo4j.create_entity(
                project_number=project_id,
                entity_type=entity_type,
                entity_id=entity_id,
                properties=properties,
            )
            return result
        except Exception as e:
            logger.warning(f"Neo4j entity creation failed: {e}")
            return {"status": "error", "error": str(e)}

    async def store_graph_relationship(self, project_id: str,
                                       from_id: str, to_id: str,
                                       rel_type: str) -> Dict:
        """Store a relationship in the project graph."""
        if not self.neo4j:
            return {"status": "neo4j_unavailable"}
        try:
            result = self.neo4j.create_relationship(
                project_number=project_id,
                from_entity_id=from_id,
                to_entity_id=to_id,
                relationship_type=rel_type,
            )
            return result
        except Exception as e:
            logger.warning(f"Neo4j relationship creation failed: {e}")
            return {"status": "error", "error": str(e)}

    # =========================================================================
    # UNIFIED CONTEXT BUILDER
    # =========================================================================

    async def build_agent_context(self, project_id: str,
                                  query: str = None) -> Dict[str, Any]:
        """
        Build comprehensive context for the agent from all memory layers.
        Used by COT engine and task executor.
        """
        context = {
            "project": None,
            "instructions": [],
            "recent_messages": [],
            "active_tasks": [],
            "semantic_results": [],
            "graph_context": {},
        }

        # 1. Project info (PostgreSQL)
        try:
            context["project"] = await self.get_project(project_id)
        except Exception as e:
            logger.warning(f"Failed to get project info: {e}")

        # 2. Instructions (PostgreSQL)
        try:
            context["instructions"] = await self.get_instructions(project_id)
        except Exception as e:
            logger.warning(f"Failed to get instructions: {e}")

        # 3. Recent messages (PostgreSQL)
        try:
            context["recent_messages"] = await self.get_recent_context(project_id)
        except Exception as e:
            logger.warning(f"Failed to get recent messages: {e}")

        # 4. Active tasks (Redis cache → PostgreSQL fallback)
        try:
            cached = await self.get_cached_tasks(project_id)
            if cached:
                context["active_tasks"] = [t for t in cached if t.get('status') in ('pending', 'in_progress')]
            else:
                tasks = await self.get_tasks(project_id, limit=20)
                context["active_tasks"] = [t for t in tasks if t.get('status') in ('pending', 'in_progress')]
        except Exception as e:
            logger.warning(f"Failed to get active tasks: {e}")

        # 5. Semantic search (Qdrant) - if query provided
        if query:
            try:
                context["semantic_results"] = await self.semantic_search(project_id, query)
            except Exception as e:
                logger.warning(f"Semantic search failed: {e}")

        # 6. Graph context (Neo4j)
        try:
            context["graph_context"] = await self.query_graph(project_id)
        except Exception as e:
            logger.warning(f"Graph query failed: {e}")

        return context

    async def cleanup_project(self, project_id: str) -> Dict[str, Any]:
        """Clean up all memory for a project across all layers."""
        results = {}

        # Redis cleanup
        try:
            keys_to_delete = [
                f"{REDIS_PREFIX}:{project_id}:state",
                f"{REDIS_PREFIX}:{project_id}:tasks",
            ]
            for key in keys_to_delete:
                self.redis.delete(key, db="session")
                self.redis.delete(key, db="cache")
            results["redis"] = "cleaned"
        except Exception as e:
            results["redis"] = f"error: {e}"

        # PostgreSQL cleanup (cascade delete from projects table)
        try:
            deleted = await self.delete_project(project_id)
            results["postgresql"] = "deleted" if deleted else "not_found"
        except Exception as e:
            results["postgresql"] = f"error: {e}"

        # Qdrant cleanup
        try:
            if self.qdrant:
                self.qdrant.delete_all_project_collections(project_id)
                results["qdrant"] = "cleaned"
        except Exception as e:
            results["qdrant"] = f"error: {e}"

        # Neo4j cleanup
        try:
            if self.neo4j:
                self.neo4j.delete_project(project_id, owner_id=None)
                results["neo4j"] = "cleaned"
        except Exception as e:
            results["neo4j"] = f"error: {e}"

        return results


# Singleton
_project_memory: Optional[ProjectMemoryService] = None


def get_project_memory_service() -> ProjectMemoryService:
    global _project_memory
    if _project_memory is None:
        _project_memory = ProjectMemoryService()
    return _project_memory
