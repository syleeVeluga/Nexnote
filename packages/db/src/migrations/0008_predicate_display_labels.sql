-- migrate:up
CREATE TABLE IF NOT EXISTS "predicate_display_labels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "predicate" text NOT NULL,
  "locale" text NOT NULL,
  "display_label" text NOT NULL,
  "source" text NOT NULL DEFAULT 'ai',
  "model_run_id" uuid REFERENCES "model_runs"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "predicate_display_labels_locale_predicate_uk"
  ON "predicate_display_labels" ("locale", "predicate");

CREATE INDEX IF NOT EXISTS "predicate_display_labels_predicate_idx"
  ON "predicate_display_labels" ("predicate");
