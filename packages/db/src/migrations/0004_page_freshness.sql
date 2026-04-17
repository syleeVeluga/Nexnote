-- S5-1: Page freshness signals. The core refresh loop has no visible "what's fresh vs. stale"
-- read-out. These two columns denormalise the latest AI-authored and latest human-authored
-- revision timestamps onto the page so the editor header can render a badge without
-- scanning the full revision history every render.
--
-- Each writer bumps exactly one column:
--   last_ai_updated_at     — route-classifier auto-create, patch-generator, apply-decision
--                            (approved ingestion writes a new AI revision)
--   last_human_edited_at   — editor save (POST /pages/:id/revisions) and rollback
--                            (rollback re-surfaces a prior revision as a human action)

ALTER TABLE "pages" ADD COLUMN "last_ai_updated_at" timestamptz;
ALTER TABLE "pages" ADD COLUMN "last_human_edited_at" timestamptz;

-- Backfill from existing revisions so staleness reads correctly on day-one. Use the max
-- created_at per actor_type; `source = 'rollback'` counts as human by construction
-- (actor_type = 'user' at insert time — see pages.ts rollback handler).
UPDATE "pages" p
SET "last_ai_updated_at" = sub.ts
FROM (
  SELECT "page_id", max("created_at") AS ts
  FROM "page_revisions"
  WHERE "actor_type" = 'ai'
  GROUP BY "page_id"
) sub
WHERE sub."page_id" = p."id";

UPDATE "pages" p
SET "last_human_edited_at" = sub.ts
FROM (
  SELECT "page_id", max("created_at") AS ts
  FROM "page_revisions"
  WHERE "actor_type" = 'user'
  GROUP BY "page_id"
) sub
WHERE sub."page_id" = p."id";
