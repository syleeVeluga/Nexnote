-- Scheduled agent foundation.
-- Phase 1-a: registry, run tracking, workspace controls, and decision linkage.

ALTER TABLE "workspaces"
  ADD COLUMN "scheduled_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

ALTER TABLE "workspaces"
  ADD COLUMN "scheduled_auto_apply" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

ALTER TABLE "workspaces"
  ADD COLUMN "scheduled_daily_token_cap" integer;
--> statement-breakpoint

ALTER TABLE "workspaces"
  ADD COLUMN "scheduled_per_run_page_limit" integer DEFAULT 50 NOT NULL;
--> statement-breakpoint

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_scheduled_daily_token_cap_chk"
  CHECK (
    "scheduled_daily_token_cap" IS NULL
    OR "scheduled_daily_token_cap" > 0
  );
--> statement-breakpoint

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_scheduled_per_run_page_limit_chk"
  CHECK ("scheduled_per_run_page_limit" BETWEEN 1 AND 500);
--> statement-breakpoint

ALTER TABLE "agent_runs"
  ALTER COLUMN "ingestion_id" DROP NOT NULL;
--> statement-breakpoint

CREATE TABLE "scheduled_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "name" text NOT NULL,
  "cron_expression" text NOT NULL,
  "target_page_ids" uuid[] NOT NULL,
  "include_descendants" boolean DEFAULT true NOT NULL,
  "instruction" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "bull_repeat_key" text,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scheduled_tasks_name_not_empty_chk"
    CHECK (length(trim("name")) > 0),
  CONSTRAINT "scheduled_tasks_cron_not_empty_chk"
    CHECK (length(trim("cron_expression")) > 0),
  CONSTRAINT "scheduled_tasks_target_page_ids_not_empty_chk"
    CHECK (cardinality("target_page_ids") > 0)
);
--> statement-breakpoint

ALTER TABLE "scheduled_tasks"
  ADD CONSTRAINT "scheduled_tasks_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "scheduled_tasks"
  ADD CONSTRAINT "scheduled_tasks_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "public"."users"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "scheduled_tasks_workspace_idx"
  ON "scheduled_tasks" ("workspace_id")
  WHERE "enabled" = true;
--> statement-breakpoint

CREATE TABLE "scheduled_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid,
  "workspace_id" uuid NOT NULL,
  "agent_run_id" uuid,
  "triggered_by" text NOT NULL,
  "status" text NOT NULL,
  "decision_count" integer DEFAULT 0 NOT NULL,
  "tokens_in" integer DEFAULT 0 NOT NULL,
  "tokens_out" integer DEFAULT 0 NOT NULL,
  "cost_usd" numeric(10,4) DEFAULT 0 NOT NULL,
  "diagnostics_json" jsonb,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "scheduled_runs_triggered_by_chk"
    CHECK ("triggered_by" IN ('cron','manual')),
  CONSTRAINT "scheduled_runs_status_chk"
    CHECK ("status" IN ('running','completed','failed')),
  CONSTRAINT "scheduled_runs_decision_count_chk"
    CHECK ("decision_count" >= 0),
  CONSTRAINT "scheduled_runs_tokens_in_chk"
    CHECK ("tokens_in" >= 0),
  CONSTRAINT "scheduled_runs_tokens_out_chk"
    CHECK ("tokens_out" >= 0),
  CONSTRAINT "scheduled_runs_cost_usd_chk"
    CHECK ("cost_usd" >= 0)
);
--> statement-breakpoint

ALTER TABLE "scheduled_runs"
  ADD CONSTRAINT "scheduled_runs_task_id_scheduled_tasks_id_fk"
  FOREIGN KEY ("task_id") REFERENCES "public"."scheduled_tasks"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "scheduled_runs"
  ADD CONSTRAINT "scheduled_runs_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "scheduled_runs"
  ADD CONSTRAINT "scheduled_runs_agent_run_id_agent_runs_id_fk"
  FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "scheduled_runs_workspace_started_idx"
  ON "scheduled_runs" ("workspace_id", "started_at" DESC);
--> statement-breakpoint

ALTER TABLE "ingestion_decisions"
  ADD COLUMN "scheduled_run_id" uuid;
--> statement-breakpoint

ALTER TABLE "ingestion_decisions"
  ADD CONSTRAINT "ingestion_decisions_scheduled_run_id_scheduled_runs_id_fk"
  FOREIGN KEY ("scheduled_run_id") REFERENCES "public"."scheduled_runs"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "ingestion_decisions_scheduled_run_idx"
  ON "ingestion_decisions" ("scheduled_run_id")
  WHERE "scheduled_run_id" IS NOT NULL;
