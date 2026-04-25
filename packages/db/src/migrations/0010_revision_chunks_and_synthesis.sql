CREATE TABLE IF NOT EXISTS "revision_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"parent_chunk_id" uuid,
	"chunk_index" integer NOT NULL,
	"chunk_kind" text NOT NULL,
	"heading_path" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"content_md" text NOT NULL,
	"digest_text" text NOT NULL,
	"content_hash" text NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"token_estimate" integer NOT NULL,
	"structure_confidence" real NOT NULL DEFAULT 1,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "revision_chunks_kind_check"
		CHECK ("chunk_kind" IN ('document', 'section', 'leaf')),
	CONSTRAINT "revision_chunks_offsets_check"
		CHECK ("char_start" >= 0 AND "char_end" >= "char_start")
);
--> statement-breakpoint
ALTER TABLE "revision_chunks" ADD CONSTRAINT "revision_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_chunks" ADD CONSTRAINT "revision_chunks_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_chunks" ADD CONSTRAINT "revision_chunks_revision_id_page_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."page_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_chunks" ADD CONSTRAINT "revision_chunks_parent_chunk_id_revision_chunks_id_fk" FOREIGN KEY ("parent_chunk_id") REFERENCES "public"."revision_chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "revision_chunks_revision_index_uk" ON "revision_chunks" USING btree ("revision_id","chunk_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revision_chunks_revision_kind_idx" ON "revision_chunks" USING btree ("revision_id","chunk_kind","chunk_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revision_chunks_workspace_hash_idx" ON "revision_chunks" USING btree ("workspace_id","content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revision_chunks_page_revision_idx" ON "revision_chunks" USING btree ("page_id","revision_id");--> statement-breakpoint
ALTER TABLE "triple_mentions" ADD COLUMN IF NOT EXISTS "revision_chunk_id" uuid;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "triple_mentions" ADD CONSTRAINT "triple_mentions_revision_chunk_id_revision_chunks_id_fk" FOREIGN KEY ("revision_chunk_id") REFERENCES "public"."revision_chunks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triple_mentions_chunk_idx" ON "triple_mentions" USING btree ("revision_chunk_id");
