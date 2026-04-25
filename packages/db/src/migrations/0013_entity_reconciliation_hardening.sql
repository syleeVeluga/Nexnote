-- Entity reconciliation hardening.
-- Adds workspace defaults, alias review state, LLM-judge suggestions, and
-- aligns triple status constraints with the worker's forward-only supersede
-- behavior.

ALTER TABLE "workspaces"
  ADD COLUMN "use_reconciliation_default" boolean NOT NULL DEFAULT true;
--> statement-breakpoint

ALTER TABLE "entity_aliases"
  ADD COLUMN "status" text NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE "entity_aliases"
  ADD COLUMN "rejected_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "entity_aliases"
  ADD COLUMN "rejected_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "entity_aliases"
  ADD CONSTRAINT "entity_aliases_status_chk"
  CHECK ("status" IN ('active','rejected'));
--> statement-breakpoint
ALTER TABLE "entity_aliases"
  ADD CONSTRAINT "entity_aliases_rejected_by_user_id_users_id_fk"
  FOREIGN KEY ("rejected_by_user_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_aliases_entity_status_idx"
  ON "entity_aliases" ("entity_id", "status", "created_at");
--> statement-breakpoint

CREATE TABLE "entity_reconciliation_suggestions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "source_entity_id" uuid NOT NULL,
  "target_entity_id" uuid NOT NULL,
  "alias_text" text NOT NULL,
  "normalized_alias" text NOT NULL,
  "method" text NOT NULL,
  "confidence" real NOT NULL,
  "reason" text NOT NULL,
  "evidence_json" jsonb,
  "model_run_id" uuid,
  "status" text NOT NULL DEFAULT 'pending',
  "approved_by_user_id" uuid,
  "approved_at" timestamp with time zone,
  "rejected_by_user_id" uuid,
  "rejected_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "entity_reconciliation_suggestions_method_chk"
    CHECK ("method" IN ('llm_judge')),
  CONSTRAINT "entity_reconciliation_suggestions_status_chk"
    CHECK ("status" IN ('pending','approved','rejected')),
  CONSTRAINT "entity_reconciliation_suggestions_confidence_chk"
    CHECK ("confidence" >= 0 AND "confidence" <= 1)
);
--> statement-breakpoint
ALTER TABLE "entity_reconciliation_suggestions"
  ADD CONSTRAINT "entity_reconciliation_suggestions_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_reconciliation_suggestions"
  ADD CONSTRAINT "entity_reconciliation_suggestions_source_entity_id_entities_id_fk"
  FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_reconciliation_suggestions"
  ADD CONSTRAINT "entity_reconciliation_suggestions_target_entity_id_entities_id_fk"
  FOREIGN KEY ("target_entity_id") REFERENCES "public"."entities"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_reconciliation_suggestions"
  ADD CONSTRAINT "entity_reconciliation_suggestions_model_run_id_model_runs_id_fk"
  FOREIGN KEY ("model_run_id") REFERENCES "public"."model_runs"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_reconciliation_suggestions"
  ADD CONSTRAINT "entity_reconciliation_suggestions_approved_by_user_id_users_id_fk"
  FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_reconciliation_suggestions"
  ADD CONSTRAINT "entity_reconciliation_suggestions_rejected_by_user_id_users_id_fk"
  FOREIGN KEY ("rejected_by_user_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "entity_reconciliation_suggestions_workspace_status_idx"
  ON "entity_reconciliation_suggestions" ("workspace_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX "entity_reconciliation_suggestions_source_idx"
  ON "entity_reconciliation_suggestions" ("source_entity_id");
--> statement-breakpoint
CREATE INDEX "entity_reconciliation_suggestions_target_idx"
  ON "entity_reconciliation_suggestions" ("target_entity_id");
--> statement-breakpoint

-- Keep existing loose text data, but make the allowed set explicit going
-- forward. Older migrations did not create a status CHECK on triples.
ALTER TABLE "triples"
  ADD CONSTRAINT "triples_status_chk"
  CHECK ("status" IN ('active','deprecated','rejected','page_deleted','superseded'));
