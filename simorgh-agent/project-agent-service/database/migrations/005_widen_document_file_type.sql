-- =============================================================================
-- 005_widen_document_file_type.sql
--
-- project_documents.file_type was VARCHAR(50). It stores the uploaded
-- file's MIME content-type. Modern Office MIME types are LONGER than 50
-- chars, e.g.:
--
--   application/vnd.openxmlformats-officedocument.spreadsheetml.sheet   (65)
--   application/vnd.openxmlformats-officedocument.wordprocessingml.document (71)
--   application/vnd.openxmlformats-officedocument.presentationml.presentation (73)
--
-- So EVERY xlsx / docx / pptx upload crashed create_document_record with:
--
--   asyncpg.exceptions.StringDataRightTruncationError:
--       value too long for type character varying(50)
--
-- → HTTP 500 from POST /api/v2/agent/projects/{id}/documents, the file
-- never reached doc-processor / Qdrant, and the chatbot answered "I don't
-- see any uploaded file". PDFs (application/pdf, 15) and images
-- (image/png, 9) fit, which is why only Office files broke.
--
-- Widen to VARCHAR(255) — comfortably covers every registered MIME type.
-- Idempotent: ALTER TYPE to the same/compatible width is a no-op on
-- re-run, and existing rows are preserved (widening never truncates).
-- =============================================================================

ALTER TABLE project_documents
    ALTER COLUMN file_type TYPE VARCHAR(255);
