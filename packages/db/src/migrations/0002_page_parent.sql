-- Add parent_page_id for Notion-style page hierarchy
ALTER TABLE "pages" ADD COLUMN "parent_page_id" uuid;
ALTER TABLE "pages" ADD CONSTRAINT "pages_parent_page_id_pages_id_fk"
  FOREIGN KEY ("parent_page_id") REFERENCES "pages"("id") ON DELETE set null ON UPDATE no action;

-- Drop old folder-based indexes
DROP INDEX IF EXISTS "pages_workspace_folder_slug_uk";
DROP INDEX IF EXISTS "pages_workspace_folder_idx";

-- New indexes: slug unique per workspace, parent-based tree traversal
CREATE UNIQUE INDEX "pages_workspace_slug_uk" ON "pages" ("workspace_id", "slug");
CREATE INDEX "pages_workspace_parent_idx" ON "pages" ("workspace_id", "parent_page_id", "sort_order");
