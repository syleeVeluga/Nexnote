-- Workspace-scoped ingestion agent routing and budget settings.
-- NULL means inherit the deployment-level env defaults.

ALTER TABLE "workspaces"
  ADD COLUMN "agent_provider" text;
--> statement-breakpoint

ALTER TABLE "workspaces"
  ADD COLUMN "agent_model_fast" text;
--> statement-breakpoint

ALTER TABLE "workspaces"
  ADD COLUMN "agent_model_large_context" text;
--> statement-breakpoint

ALTER TABLE "workspaces"
  ADD COLUMN "agent_fast_threshold_tokens" integer;
--> statement-breakpoint

ALTER TABLE "workspaces"
  ADD COLUMN "agent_daily_token_cap" integer;
--> statement-breakpoint

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_agent_provider_chk"
  CHECK ("agent_provider" IS NULL OR "agent_provider" IN ('openai','gemini'));
--> statement-breakpoint

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_agent_fast_threshold_tokens_chk"
  CHECK (
    "agent_fast_threshold_tokens" IS NULL
    OR "agent_fast_threshold_tokens" > 0
  );
--> statement-breakpoint

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_agent_daily_token_cap_chk"
  CHECK (
    "agent_daily_token_cap" IS NULL
    OR "agent_daily_token_cap" > 0
  );
