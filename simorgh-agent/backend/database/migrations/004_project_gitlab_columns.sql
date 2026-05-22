-- =============================================================================
-- 004_project_gitlab_columns.sql
--
-- The 2026-05 enterprise migration switched simorgh from the SMB techserver
-- model to a per-project GitLab repo + simorgh/<oenum>/<hex> working branch.
-- project_memory_service.create_project has been writing the new fields
-- since then but the matching ALTER TABLE never landed — every create
-- failed with:
--
--     column "gitlab_repo_path" of relation "projects" does not exist
--
-- This migration adds the columns the code already references:
--
--   gitlab_repo_path    'group/repo' selected in the wizard
--   gitlab_repo_url     full HTTPS / SSH clone URL
--   gitlab_base_branch  branch / tag / SHA the user forked from
--   simorgh_branch      the simorgh/<...> branch project-init created
--   sources_enabled     {"gitlab":true,"tpms":false,...} per-project source map
--
-- All columns are nullable so existing rows survive the upgrade.
-- =============================================================================

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS gitlab_repo_path    VARCHAR(500),
    ADD COLUMN IF NOT EXISTS gitlab_repo_url     VARCHAR(500),
    ADD COLUMN IF NOT EXISTS gitlab_base_branch  VARCHAR(255),
    ADD COLUMN IF NOT EXISTS simorgh_branch      VARCHAR(255),
    ADD COLUMN IF NOT EXISTS sources_enabled     JSONB DEFAULT '{}';

-- Helpful index for the runtime-status batch probe, which looks projects
-- up by oenum *or* by gitlab_repo_path depending on which sidebar
-- list owns the row.
CREATE INDEX IF NOT EXISTS idx_projects_gitlab_repo_path
    ON projects (gitlab_repo_path)
    WHERE gitlab_repo_path IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_projects_simorgh_branch
    ON projects (simorgh_branch)
    WHERE simorgh_branch IS NOT NULL;


-- =============================================================================
-- project_chat_sessions
--
-- Deep-link surface for the "create a chat tied to this project" flow
-- exposed via chat-service /api/v2/chatbot/project/sessions. The table
-- was referenced by the route the day the route shipped but the CREATE
-- TABLE was never written, so every POST/GET/DELETE on that surface
-- returns 500 ("relation project_chat_sessions does not exist").
--
-- Cascades to project_messages via project_id FK (already in 003), so
-- deleting a session removes its history.
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_chat_sessions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        UUID NOT NULL
                          REFERENCES projects(id) ON DELETE CASCADE,
    session_token     TEXT NOT NULL UNIQUE,
    title             VARCHAR(255),
    stage             VARCHAR(50) DEFAULT 'general',
    is_active         BOOLEAN     DEFAULT TRUE,
    -- The user who created the session. Matches projects.owner_id type
    -- (TEXT) — UUID for modern users, EMPUSERNAME for legacy.
    created_by        TEXT,
    created_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_activity_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    archived_at       TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_pcs_project_id
    ON project_chat_sessions (project_id);
CREATE INDEX IF NOT EXISTS idx_pcs_last_activity_at
    ON project_chat_sessions (last_activity_at DESC);
-- session_token already has a unique constraint above (used by all the
-- /sessions/{token} lookups), so no extra index needed there.
