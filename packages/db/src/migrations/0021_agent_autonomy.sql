ALTER TABLE "workspaces"
  ADD COLUMN "autonomy_mode" text DEFAULT 'supervised' NOT NULL,
  ADD COLUMN "autonomy_promoted_at" timestamptz,
  ADD COLUMN "autonomy_promoted_by" uuid,
  ADD COLUMN "autonomy_paused_until" timestamptz,
  ADD COLUMN "autonomy_max_destructive_per_run" integer DEFAULT 3 NOT NULL,
  ADD COLUMN "autonomy_max_destructive_per_day" integer DEFAULT 20 NOT NULL;

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_autonomy_mode_chk"
  CHECK ("autonomy_mode" IN ('supervised','autonomous_shadow','autonomous'));

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_autonomy_max_destructive_per_run_chk"
  CHECK ("autonomy_max_destructive_per_run" >= 0);

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_autonomy_max_destructive_per_day_chk"
  CHECK ("autonomy_max_destructive_per_day" >= 0);

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_autonomy_promoted_by_users_id_fk"
  FOREIGN KEY ("autonomy_promoted_by") REFERENCES "public"."users"("id")
  ON DELETE no action ON UPDATE no action;

ALTER TABLE "agent_runs"
  DROP CONSTRAINT "agent_runs_status_chk";

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "agent_runs_status_chk"
  CHECK ("status" IN ('running','completed','failed','timeout','shadow','paused'));
