-- =============================================================================
-- 006_projects_has_documents.sql
--
-- Conversational-RAG best practice: an uploaded document's scope should
-- persist for the whole project, not just the turn it was attached to.
-- Previously the router decided "this turn has an upload" from the current
-- message's attachment (has_upload per-turn), so a follow-up text-only
-- question routed to knowledge_only and the planner never retrieved the
-- already-indexed document.
--
-- This flag is set TRUE the first time a document is successfully indexed
-- for a project (project_agent_routes.upload_document) and lets the router
-- pick an upload-aware plan on EVERY subsequent turn for that project.
-- Nullable/defaulted so existing rows survive.
-- =============================================================================

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS has_documents BOOLEAN DEFAULT FALSE;

-- Backfill: any project that already has at least one document record is
-- marked true so existing uploads become retrievable after deploy.
UPDATE projects p
   SET has_documents = TRUE
 WHERE has_documents IS DISTINCT FROM TRUE
   AND EXISTS (
       SELECT 1 FROM project_documents d WHERE d.project_id = p.id
   );
