-- =============================================================================
-- 007_projects_simorgh_soft_id.sql
--
-- Persist the mapping between a chatbot project (UUID) and its created
-- Simorgh Design Suite (simorgh-soft) project (Mongo ObjectId string), so
-- a later chat turn can deep-link the user back into the project they
-- already created without re-asking.
--
-- Nullable; backfill not needed.
-- =============================================================================
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS simorgh_soft_project_id VARCHAR(64);
