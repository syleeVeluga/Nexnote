ALTER TABLE "scheduled_runs"
  DROP CONSTRAINT "scheduled_runs_status_chk";

ALTER TABLE "scheduled_runs"
  ADD CONSTRAINT "scheduled_runs_status_chk"
  CHECK ("status" IN ('running','completed','partial','failed'));
