-- Rollback for migration 004: per-project session containers + GitLab selection + sources.
-- Order: drop dependent tables first, then drop ALTERed columns on projects.

DROP TRIGGER IF EXISTS update_project_exploration_updated_at ON project_exploration;
DROP TABLE IF EXISTS project_exploration;

DROP TABLE IF EXISTS project_chat_sessions;

DROP TRIGGER IF EXISTS update_project_containers_updated_at ON project_containers;
DROP TABLE IF EXISTS project_containers;

DROP INDEX IF EXISTS idx_projects_gitlab_repo;

ALTER TABLE projects
    DROP COLUMN IF EXISTS exploration_status,
    DROP COLUMN IF EXISTS sources_enabled,
    DROP COLUMN IF EXISTS simorgh_branch,
    DROP COLUMN IF EXISTS gitlab_base_branch,
    DROP COLUMN IF EXISTS gitlab_repo_url,
    DROP COLUMN IF EXISTS gitlab_repo_path;
