CREATE UNIQUE INDEX "published_snapshots_public_path_live_uk" ON "published_snapshots" USING btree ("public_path") WHERE "published_snapshots"."is_live" = true;
