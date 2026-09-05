DROP INDEX IF EXISTS idx_project_chat_sessions_active;

ALTER TABLE project_chat_sessions
    DROP COLUMN IF EXISTS archived_at;
