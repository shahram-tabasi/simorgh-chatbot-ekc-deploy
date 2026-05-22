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
