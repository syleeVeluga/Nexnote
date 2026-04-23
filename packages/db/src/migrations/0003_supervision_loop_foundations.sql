-- P0-1: pages.search_vector for FTS — referenced by search-index-updater worker
-- but previously missing, causing the worker to silently skip.
ALTER TABLE "pages" ADD COLUMN "search_vector" tsvector;
CREATE INDEX "pages_search_vector_idx" ON "pages" USING gin ("search_vector");

-- Backfill: build the tsvector for existing pages from title + current revision content.
UPDATE "pages" p
SET "search_vector" = to_tsvector(
  'simple',
  coalesce(p."title", '') || ' ' || coalesce(r."content_md", '')
)
FROM "page_revisions" r
WHERE r."id" = p."current_revision_id";

-- P0-2: structured provenance from revision back to the ingestion / decision that caused it.
-- Replaces free-text parsing of revision_note.
ALTER TABLE "page_revisions" ADD COLUMN "source_ingestion_id" uuid;
ALTER TABLE "page_revisions" ADD CONSTRAINT "page_revisions_source_ingestion_id_fk"
  FOREIGN KEY ("source_ingestion_id") REFERENCES "ingestions"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "page_revisions" ADD COLUMN "source_decision_id" uuid;
ALTER TABLE "page_revisions" ADD CONSTRAINT "page_revisions_source_decision_id_fk"
  FOREIGN KEY ("source_decision_id") REFERENCES "ingestion_decisions"("id") ON DELETE set null ON UPDATE no action;

CREATE INDEX "page_revisions_source_ingestion_idx" ON "page_revisions" ("source_ingestion_id");

-- S3-1: three-band decision status. Previously the route-classifier only branched on
-- AUTO_APPLY_MIN (0.85); decisions in the 0.60–0.84 suggestion band were written with
-- no status and never surfaced. This column gives the supervision UI something to query.
--
-- Values (matching DECISION_STATUSES in @wekiflow/shared):
--   auto_applied  — confidence ≥ 0.85, already applied to a page
--   suggested     — 0.60 ≤ confidence < 0.85, awaiting human approval
--   needs_review  — confidence < 0.60 OR action = 'needs_review', low-trust
--   approved      — human approved a suggested decision (set by approve API)
--   rejected      — human rejected the decision
--   noop          — AI decided no action was needed
--   failed        — patch-generator failed to produce a revision
ALTER TABLE "ingestion_decisions" ADD COLUMN "status" text NOT NULL DEFAULT 'suggested';
CREATE INDEX "ingestion_decisions_status_idx" ON "ingestion_decisions" ("status", "created_at");
