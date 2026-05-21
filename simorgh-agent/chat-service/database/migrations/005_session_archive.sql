-- =============================================================================
-- Migration 005 — soft-delete / archive support for project chat sessions.
--
-- Claude-Code-on-the-web lets the user Archive a finished session (hides it
-- from the default list, recoverable) in addition to permanently Deleting
-- it. We need the same: an `archived_at` timestamp on project_chat_sessions
-- and a partial index so the sidebar's "active sessions" query stays cheap.
--
-- Archive sets archived_at = now(); unarchive clears it. Cascade-delete still
-- works because we only added a nullable column.
-- =============================================================================

ALTER TABLE project_chat_sessions
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

-- Partial index: the sidebar's default view filters WHERE archived_at IS NULL.
-- Keeping this index partial means archived rows don't bloat it.
CREATE INDEX IF NOT EXISTS idx_project_chat_sessions_active
    ON project_chat_sessions(project_id, last_activity_at DESC)
    WHERE archived_at IS NULL;
