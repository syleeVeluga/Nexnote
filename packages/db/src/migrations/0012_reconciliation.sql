-- Folder/Page-aware triple reconciliation.
-- Adds destination context to ingestions, alias provenance + uniqueness, and
-- the pg_trgm index used by post-extraction entity matching.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- Ingestions: target destination + reconciliation opt-out.
ALTER TABLE "ingestions" ADD COLUMN "target_folder_id" uuid;
--> statement-breakpoint
ALTER TABLE "ingestions" ADD COLUMN "target_parent_page_id" uuid;
--> statement-breakpoint
ALTER TABLE "ingestions" ADD COLUMN "use_reconciliation" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "ingestions" ADD CONSTRAINT "ingestions_target_folder_id_folders_id_fk"
  FOREIGN KEY ("target_folder_id") REFERENCES "public"."folders"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ingestions" ADD CONSTRAINT "ingestions_target_parent_page_id_pages_id_fk"
  FOREIGN KEY ("target_parent_page_id") REFERENCES "public"."pages"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ingestions" ADD CONSTRAINT "ingestions_target_xor_chk"
  CHECK ("target_folder_id" IS NULL OR "target_parent_page_id" IS NULL);
--> statement-breakpoint

-- Entity aliases: provenance + uniqueness so reconciliation is idempotent.
ALTER TABLE "entity_aliases" ADD COLUMN "created_by_extraction_id" uuid;
--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD COLUMN "source_page_id" uuid;
--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD COLUMN "similarity_score" real;
--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD COLUMN "match_method" text;
--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_match_method_chk"
  CHECK ("match_method" IS NULL OR "match_method" IN ('exact','honorific','trigram'));
--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_created_by_extraction_id_model_runs_id_fk"
  FOREIGN KEY ("created_by_extraction_id") REFERENCES "public"."model_runs"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_source_page_id_pages_id_fk"
  FOREIGN KEY ("source_page_id") REFERENCES "public"."pages"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_entity_norm_uk"
  UNIQUE ("entity_id", "normalized_alias");
--> statement-breakpoint

-- Trigram GIN index for similarity-scoped lookup during reconciliation.
CREATE INDEX IF NOT EXISTS "entities_normalized_key_trgm_idx"
  ON "entities" USING gin ("normalized_key" gin_trgm_ops);
