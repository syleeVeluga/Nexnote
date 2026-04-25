-- Allow a page to be placed directly under a folder (previously only under another page).
-- The XOR check keeps "exactly one parent" honest: root pages have both NULL,
-- subpages have parent_page_id set, folder-top pages have parent_folder_id set.
ALTER TABLE "pages" ADD COLUMN "parent_folder_id" uuid;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_parent_folder_id_folders_id_fk"
  FOREIGN KEY ("parent_folder_id") REFERENCES "public"."folders"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_single_parent_chk"
  CHECK ("parent_page_id" IS NULL OR "parent_folder_id" IS NULL);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_workspace_folder_idx"
  ON "pages" USING btree ("workspace_id","parent_folder_id","sort_order");
