ALTER TABLE "agent_runs"
  DROP CONSTRAINT "agent_runs_status_chk";

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "agent_runs_status_chk"
  CHECK ("status" IN ('running','completed','failed','timeout','shadow','partial','aborted','paused'));
