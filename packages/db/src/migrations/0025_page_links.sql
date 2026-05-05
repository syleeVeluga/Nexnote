CREATE TABLE IF NOT EXISTS "page_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "source_page_id" uuid NOT NULL REFERENCES "pages"("id") ON DELETE cascade,
  "source_revision_id" uuid NOT NULL REFERENCES "page_revisions"("id") ON DELETE cascade,
  "target_page_id" uuid REFERENCES "pages"("id") ON DELETE set null,
  "target_slug" text NOT NULL,
  "link_text" text,
  "link_type" text NOT NULL,
  "position_in_md" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "page_links_type_chk" CHECK ("page_links"."link_type" IN ('wikilink', 'markdown')),
  CONSTRAINT "page_links_position_chk" CHECK ("page_links"."position_in_md" IS NULL OR "page_links"."position_in_md" >= 0)
);

CREATE INDEX IF NOT EXISTS "page_links_target_idx"
  ON "page_links" ("workspace_id", "target_page_id")
  WHERE "target_page_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "page_links_source_revision_idx"
  ON "page_links" ("source_revision_id");

CREATE UNIQUE INDEX IF NOT EXISTS "page_links_revision_position_uk"
  ON "page_links" ("source_revision_id", "position_in_md", "link_type", "target_slug");

CREATE INDEX IF NOT EXISTS "page_links_broken_idx"
  ON "page_links" ("workspace_id", "target_slug")
  WHERE "target_page_id" IS NULL;
