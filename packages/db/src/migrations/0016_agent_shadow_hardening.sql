-- Agent shadow hardening.
-- Adds workspace-scoped operator guidance and a first-pass parity view used
-- during shadow rollout.

ALTER TABLE "workspaces"
  ADD COLUMN "agent_instructions" text;
--> statement-breakpoint

CREATE VIEW "agent_vs_classic_agreement_rate" AS
WITH latest_agent AS (
  SELECT DISTINCT ON (ar.ingestion_id)
    ar.id AS agent_run_id,
    ar.workspace_id,
    ar.ingestion_id,
    ar.status,
    ar.plan_json,
    ar.decisions_count,
    ar.total_tokens,
    ar.started_at,
    ar.completed_at
  FROM agent_runs ar
  WHERE ar.status IN ('shadow', 'completed')
  ORDER BY ar.ingestion_id, ar.started_at DESC
),
agent_first AS (
  SELECT
    la.agent_run_id,
    la.workspace_id,
    la.ingestion_id,
    date_trunc('day', la.started_at)::date AS day,
    la.status,
    la.decisions_count,
    la.total_tokens,
    la.plan_json #>> '{proposedPlan,0,action}' AS agent_action,
    NULLIF(la.plan_json #>> '{proposedPlan,0,targetPageId}', '') AS agent_target_page_id
  FROM latest_agent la
),
classic_first AS (
  SELECT DISTINCT ON (d.ingestion_id)
    d.ingestion_id,
    d.action AS classic_action,
    d.target_page_id::text AS classic_target_page_id,
    d.status AS classic_status
  FROM ingestion_decisions d
  WHERE d.agent_run_id IS NULL
  ORDER BY d.ingestion_id, d.created_at ASC
)
SELECT
  af.workspace_id,
  af.day,
  count(*)::integer AS agent_run_count,
  count(cf.ingestion_id)::integer AS comparable_count,
  count(*) FILTER (
    WHERE cf.ingestion_id IS NOT NULL
      AND af.agent_action = cf.classic_action
  )::integer AS action_match_count,
  count(*) FILTER (
    WHERE cf.ingestion_id IS NOT NULL
      AND af.agent_target_page_id IS NOT DISTINCT FROM cf.classic_target_page_id
  )::integer AS target_page_match_count,
  count(*) FILTER (
    WHERE cf.ingestion_id IS NOT NULL
      AND af.agent_action = cf.classic_action
      AND af.agent_target_page_id IS NOT DISTINCT FROM cf.classic_target_page_id
  )::integer AS full_match_count,
  CASE
    WHEN count(cf.ingestion_id) = 0 THEN NULL
    ELSE (
      count(*) FILTER (
        WHERE cf.ingestion_id IS NOT NULL
          AND af.agent_action = cf.classic_action
      )::double precision / count(cf.ingestion_id)::double precision
    )
  END AS action_agreement_rate,
  CASE
    WHEN count(cf.ingestion_id) = 0 THEN NULL
    ELSE (
      count(*) FILTER (
        WHERE cf.ingestion_id IS NOT NULL
          AND af.agent_target_page_id IS NOT DISTINCT FROM cf.classic_target_page_id
      )::double precision / count(cf.ingestion_id)::double precision
    )
  END AS target_page_agreement_rate,
  CASE
    WHEN count(cf.ingestion_id) = 0 THEN NULL
    ELSE (
      count(*) FILTER (
        WHERE cf.ingestion_id IS NOT NULL
          AND af.agent_action = cf.classic_action
          AND af.agent_target_page_id IS NOT DISTINCT FROM cf.classic_target_page_id
      )::double precision / count(cf.ingestion_id)::double precision
    )
  END AS full_agreement_rate,
  COALESCE(sum(af.total_tokens), 0)::integer AS total_agent_tokens
FROM agent_first af
LEFT JOIN classic_first cf ON cf.ingestion_id = af.ingestion_id
GROUP BY af.workspace_id, af.day;
