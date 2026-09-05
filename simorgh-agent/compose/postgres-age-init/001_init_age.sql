-- =============================================================================
-- Apache AGE bootstrap for the simorgh graph.
--
-- Loaded once by the apache/age:PG16_latest container on first start.
-- Idempotent: every CREATE-like statement is guarded so re-running
-- against a populated volume is a no-op.
--
-- Schema:
--   :Project        (oenum, name, customer)
--   :Document       (path, sha, doc_type)
--   :Component      (tag, kind)              -- breakers, transformers, motors
--   :Net            (name)                   -- electrical nets
--   :Spec           (key, value, unit)
--   :Decision       (ts, author, kind)
--   :CoTStep        (chain_id, step_number, tool)
--
-- Edges:
--   (:Project)-[:HAS]->(:Document|:Component|:Decision)
--   (:Document)-[:MENTIONS]->(:Component|:Spec)
--   (:Component)-[:CONNECTS_TO {net:String}]->(:Component)
--   (:Component)-[:HAS_SPEC]->(:Spec)
--   (:Decision)-[:ABOUT]->(:Component|:Spec)
--   (:CoTStep)-[:USED]->(:Document|:Component|:Spec)
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS age;
LOAD 'age';
SET search_path = ag_catalog, "$user", public;

-- Create the graph if it doesn't exist. create_graph itself raises
-- on conflict, so we wrap in a DO block.
DO $$
BEGIN
  PERFORM create_graph('simorgh');
EXCEPTION
  WHEN unique_violation THEN
    RAISE NOTICE 'graph "simorgh" already exists, skipping create_graph';
  WHEN OTHERS THEN
    -- AGE raises invalid_schema_name if a graph with that name was already
    -- present and partially set up; ignore so the init script is idempotent.
    IF SQLERRM LIKE '%already exists%' THEN
      RAISE NOTICE 'graph "simorgh" already exists, skipping (%)', SQLERRM;
    ELSE
      RAISE;
    END IF;
END
$$;

-- Vertex labels — declared up front so the first cypher() invocation
-- in production doesn't pay the create-label cost.
DO $$
DECLARE
  lbl text;
BEGIN
  FOREACH lbl IN ARRAY ARRAY[
    'Project', 'Document', 'Component', 'Net',
    'Spec', 'Decision', 'CoTStep'
  ]
  LOOP
    BEGIN
      PERFORM create_vlabel('simorgh', lbl);
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'vlabel % already exists', lbl;
    END;
  END LOOP;
END
$$;

-- Edge labels.
DO $$
DECLARE
  lbl text;
BEGIN
  FOREACH lbl IN ARRAY ARRAY[
    'HAS', 'MENTIONS', 'CONNECTS_TO', 'HAS_SPEC', 'ABOUT', 'USED'
  ]
  LOOP
    BEGIN
      PERFORM create_elabel('simorgh', lbl);
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'elabel % already exists', lbl;
    END;
  END LOOP;
END
$$;

-- Helpful B-tree indexes on the most-queried properties. AGE stores
-- vertex/edge properties as JSONB, so we index the JSONB path.
CREATE INDEX IF NOT EXISTS idx_simorgh_project_oenum
    ON simorgh."Project"
    USING btree ((properties->'oenum'));

CREATE INDEX IF NOT EXISTS idx_simorgh_document_path
    ON simorgh."Document"
    USING btree ((properties->'path'));

CREATE INDEX IF NOT EXISTS idx_simorgh_component_tag
    ON simorgh."Component"
    USING btree ((properties->'tag'));
