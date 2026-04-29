-- Ingestion agent run tracking.
-- Backwards-compatible: existing classic classifier rows keep NULL agent_run_id.

ALTER TABLE "workspaces"
  ADD COLUMN "ingestion_mode" text NOT NULL DEFAULT 'classic';
--> statement-breakpoint

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_ingestion_mode_chk"
  CHECK ("ingestion_mode" IN ('classic','shadow','agent'));
--> statement-breakpoint

CREATE TABLE "agent_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ingestion_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "status" text NOT NULL,
  "plan_json" jsonb,
  "steps_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "decisions_count" integer DEFAULT 0 NOT NULL,
  "total_tokens" integer DEFAULT 0 NOT NULL,
  "total_latency_ms" integer DEFAULT 0 NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "agent_runs_status_chk"
    CHECK ("status" IN ('running','completed','failed','timeout','shadow')),
  CONSTRAINT "agent_runs_decisions_count_chk"
    CHECK ("decisions_count" >= 0),
  CONSTRAINT "agent_runs_total_tokens_chk"
    CHECK ("total_tokens" >= 0),
  CONSTRAINT "agent_runs_total_latency_ms_chk"
    CHECK ("total_latency_ms" >= 0)
);
--> statement-breakpoint

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "agent_runs_ingestion_id_ingestions_id_fk"
  FOREIGN KEY ("ingestion_id") REFERENCES "public"."ingestions"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "agent_runs_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "model_runs"
  ADD COLUMN "agent_run_id" uuid;
--> statement-breakpoint

ALTER TABLE "model_runs"
  ADD CONSTRAINT "model_runs_agent_run_id_agent_runs_id_fk"
  FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "ingestion_decisions"
  ADD COLUMN "agent_run_id" uuid;
--> statement-breakpoint

ALTER TABLE "ingestion_decisions"
  ADD CONSTRAINT "ingestion_decisions_agent_run_id_agent_runs_id_fk"
  FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "agent_runs_ingestion_idx"
  ON "agent_runs" ("ingestion_id");
--> statement-breakpoint

CREATE INDEX "agent_runs_workspace_started_idx"
  ON "agent_runs" ("workspace_id", "started_at" DESC);
--> statement-breakpoint

CREATE INDEX "model_runs_agent_run_idx"
  ON "model_runs" ("agent_run_id");
--> statement-breakpoint

CREATE INDEX "ingestion_decisions_agent_run_idx"
  ON "ingestion_decisions" ("agent_run_id");
