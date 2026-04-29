-- Workspace-scoped overrides for agent parity gate thresholds.
-- NULL means inherit the deployment-level env defaults.

ALTER TABLE "workspaces"
  ADD COLUMN "agent_parity_min_observed_days" integer;
--> statement-breakpoint

ALTER TABLE "workspaces"
  ADD COLUMN "agent_parity_min_comparable_count" integer;
--> statement-breakpoint

ALTER TABLE "workspaces"
  ADD COLUMN "agent_parity_min_action_agreement_rate" numeric(4,3);
--> statement-breakpoint

ALTER TABLE "workspaces"
  ADD COLUMN "agent_parity_min_target_page_agreement_rate" numeric(4,3);
--> statement-breakpoint

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_agent_parity_min_observed_days_chk"
  CHECK (
    "agent_parity_min_observed_days" IS NULL
    OR ("agent_parity_min_observed_days" BETWEEN 1 AND 30)
  );
--> statement-breakpoint

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_agent_parity_min_comparable_count_chk"
  CHECK (
    "agent_parity_min_comparable_count" IS NULL
    OR ("agent_parity_min_comparable_count" BETWEEN 1 AND 1000)
  );
--> statement-breakpoint

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_agent_parity_min_action_agreement_rate_chk"
  CHECK (
    "agent_parity_min_action_agreement_rate" IS NULL
    OR ("agent_parity_min_action_agreement_rate" BETWEEN 0 AND 1)
  );
--> statement-breakpoint

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_agent_parity_min_target_page_agreement_rate_chk"
  CHECK (
    "agent_parity_min_target_page_agreement_rate" IS NULL
    OR ("agent_parity_min_target_page_agreement_rate" BETWEEN 0 AND 1)
  );
