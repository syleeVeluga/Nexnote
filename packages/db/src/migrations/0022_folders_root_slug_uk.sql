-- Defense-in-depth: enforce slug uniqueness for root folders.
-- The composite index folders_workspace_parent_slug_uk treats NULL parent_folder_id
-- rows as distinct, so two concurrent root-level creates with the same slug were
-- not actually protected by a database-level uniqueness constraint.
CREATE UNIQUE INDEX "folders_workspace_root_slug_uk"
  ON "folders" USING btree ("workspace_id", "slug")
  WHERE "parent_folder_id" IS NULL;
