-- API token management.
-- Adds reviewer-visible metadata and explicit scopes while preserving existing
-- hidden system token rows.

ALTER TABLE "api_tokens"
  ADD COLUMN "source_name_hint" text;
--> statement-breakpoint

ALTER TABLE "api_tokens"
  ADD COLUMN "scopes" text[] NOT NULL DEFAULT ARRAY['ingestions:write']::text[];
--> statement-breakpoint

CREATE INDEX "api_tokens_workspace_revoked_idx"
  ON "api_tokens" ("workspace_id", "revoked_at", "created_at");
