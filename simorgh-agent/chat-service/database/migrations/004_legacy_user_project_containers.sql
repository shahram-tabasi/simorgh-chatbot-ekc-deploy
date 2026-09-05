-- Migration 004: Per-project session containers + GitLab repo selection + source ticks
-- Supports the new project-creation flow where:
--   * legacy users get project-only chat (no general chat)
--   * users may pick a GitLab repo + branch at project creation
--   * users may tick: tpms data, techserver oenum copy, ekc-technical-knowledge clone, upload-only
--   * each project owns a long-lived shell-runtime container; deleting the
--     session/project cascades to container removal.

-- =============================================================================
-- PROJECTS: new columns for GitLab repo selection, container, and source flags
-- =============================================================================
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS gitlab_repo_path   VARCHAR(500),     -- e.g. 'group/repo'
    ADD COLUMN IF NOT EXISTS gitlab_repo_url    VARCHAR(1000),    -- full clone URL (https or git@)
    ADD COLUMN IF NOT EXISTS gitlab_base_branch VARCHAR(255),     -- branch user selected to fork from
    ADD COLUMN IF NOT EXISTS simorgh_branch     VARCHAR(255),     -- e.g. simorgh/a3f9c2
    ADD COLUMN IF NOT EXISTS sources_enabled    JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- sources_enabled shape:
    --   {
    --     "gitlab":      bool,          -- user picked their own repo at creation
    --     "tpms":        bool,          -- pull tpms data into working dir (requires tpms auth)
    --     "techserver":  bool,          -- copy //192.168.1.3/techser/<oenum> (requires tpms auth)
    --     "techserver_oenum": "12345",  -- the oenum used for techserver copy
    --     "ekc":         bool,          -- clone simorgh-knowledge/technical-knowledge read-only
    --     "upload":      bool           -- accept document uploads into working dir
    --   }
    ADD COLUMN IF NOT EXISTS exploration_status VARCHAR(20) DEFAULT 'pending'
        CHECK (exploration_status IN ('pending', 'remote_done', 'container_done', 'failed', 'skipped'));

CREATE INDEX IF NOT EXISTS idx_projects_gitlab_repo
    ON projects(gitlab_repo_path) WHERE gitlab_repo_path IS NOT NULL;

-- =============================================================================
-- PROJECT_CONTAINERS: one per project, long-lived
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_containers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
    -- Docker identity
    container_name VARCHAR(255) NOT NULL UNIQUE,    -- 'simorgh-proj-<short>'
    container_id   VARCHAR(128),                    -- docker container id (may rotate)
    image          VARCHAR(255) NOT NULL,           -- which image was used
    volume_name    VARCHAR(255) NOT NULL,           -- docker named volume for /work
    working_dir    VARCHAR(500) NOT NULL DEFAULT '/work',
    -- Lifecycle
    status VARCHAR(20) NOT NULL DEFAULT 'created'
        CHECK (status IN ('created', 'starting', 'running', 'stopped', 'failed', 'removed')),
    last_started_at  TIMESTAMP WITH TIME ZONE,
    last_stopped_at  TIMESTAMP WITH TIME ZONE,
    last_used_at     TIMESTAMP WITH TIME ZONE,
    -- Init metadata
    initialised      BOOLEAN NOT NULL DEFAULT FALSE,
    init_log         TEXT,
    -- Audit
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_project_containers_status ON project_containers(status);

-- Trigger to keep updated_at fresh (reuses function from migration 003).
DROP TRIGGER IF EXISTS update_project_containers_updated_at ON project_containers;
CREATE TRIGGER update_project_containers_updated_at
    BEFORE UPDATE ON project_containers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- PROJECT_CHAT_SESSIONS: explicit session rows (for the deep-link
-- /chatbot/project/session_<id> URL pattern; messages still live in
-- project_messages, with chat_id pointing at session id).
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- Short session token used in the deep-link URL (e.g. session_011NZCaVggFiZfZ7wHXTqRTc).
    session_token VARCHAR(64) NOT NULL UNIQUE,
    title VARCHAR(255),
    stage VARCHAR(30) DEFAULT 'general',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_project_chat_sessions_project
    ON project_chat_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_project_chat_sessions_token
    ON project_chat_sessions(session_token);

-- =============================================================================
-- PROJECT_EXPLORATION: cached result of the project-explorer agent.
-- Redis is the hot path; this table is the durable copy.
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_exploration (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
    phase VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (phase IN ('pending', 'remote', 'container', 'done', 'failed')),
    -- Phase-1 (remote, via gitlab-mcp tree+read_file): fast summary
    remote_summary    TEXT,
    remote_completed_at TIMESTAMP WITH TIME ZONE,
    -- Phase-2 (container deep walk): file index, language stats, entry points
    container_summary TEXT,
    container_completed_at TIMESTAMP WITH TIME ZONE,
    -- Structured indices (kept JSONB so CoT can dig in without re-walking)
    file_index JSONB DEFAULT '[]'::jsonb,
    language_stats JSONB DEFAULT '{}'::jsonb,
    entry_points JSONB DEFAULT '[]'::jsonb,
    -- Error tracking
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS update_project_exploration_updated_at ON project_exploration;
CREATE TRIGGER update_project_exploration_updated_at
    BEFORE UPDATE ON project_exploration
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
