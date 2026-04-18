CREATE INDEX IF NOT EXISTS "triple_mentions_page_triple_idx" ON "triple_mentions" USING btree ("page_id", "triple_id");
