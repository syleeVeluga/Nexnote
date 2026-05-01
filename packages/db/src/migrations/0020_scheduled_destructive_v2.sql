ALTER TABLE "workspaces"
  ADD COLUMN "allow_destructive_scheduled_agent" boolean DEFAULT false NOT NULL;

CREATE TABLE "page_redirects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "from_page_id" uuid,
  "to_page_id" uuid NOT NULL,
  "from_path" text NOT NULL,
  "created_by_decision_id" uuid,
  "disabled_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "page_redirects_from_path_not_empty_chk"
    CHECK (length(trim("from_path")) > 0)
);

ALTER TABLE "page_redirects"
  ADD CONSTRAINT "page_redirects_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "page_redirects"
  ADD CONSTRAINT "page_redirects_from_page_id_pages_id_fk"
  FOREIGN KEY ("from_page_id") REFERENCES "public"."pages"("id")
  ON DELETE set null ON UPDATE no action;

ALTER TABLE "page_redirects"
  ADD CONSTRAINT "page_redirects_to_page_id_pages_id_fk"
  FOREIGN KEY ("to_page_id") REFERENCES "public"."pages"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "page_redirects"
  ADD CONSTRAINT "page_redirects_created_by_decision_id_ingestion_decisions_id_fk"
  FOREIGN KEY ("created_by_decision_id") REFERENCES "public"."ingestion_decisions"("id")
  ON DELETE set null ON UPDATE no action;

CREATE UNIQUE INDEX "page_redirects_workspace_from_path_active_uk"
  ON "page_redirects" ("workspace_id", "from_path")
  WHERE "disabled_at" IS NULL;

CREATE INDEX "page_redirects_to_page_idx"
  ON "page_redirects" ("to_page_id");

CREATE INDEX "page_redirects_decision_idx"
  ON "page_redirects" ("created_by_decision_id");
