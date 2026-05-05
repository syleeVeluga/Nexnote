# Ingestion Agent Step 4: Shadow Loop

Status: completed (2026-04-29)

Scope: AGENT-4 from `docs/TASKS.md`.

## Goal

Add the first runnable ingestion-agent loop without letting it mutate wiki
content:

- explore with read-only tools
- plan with structured `plan_json`
- persist trace in `agent_runs.steps_json`
- record every AI call in `model_runs.agent_run_id`
- run beside the classic classifier when `workspaces.ingestion_mode` is
  `shadow`

Classic `ingestion_decisions` ownership remains unchanged in this step.

## Interface Decisions

- The agent plan contract lives in `packages/shared/src/schemas/agent.ts` as
  `ingestionAgentPlanSchema`.
- Agent AI calls use `model_runs.mode = "agent_plan"` and prompt version
  `ingestion-agent-shadow-v1`.
- `packages/worker/src/lib/agent/budgeter.ts` owns env-backed limits, model
  routing, and plan-turn context packing.
- `packages/worker/src/lib/agent/loop.ts` is dependency-injected for tests:
  callers can pass a fake `AIAdapter`, fake tools, and a model-run recorder.
- Shadow execution records `shadow_execute_skipped` in the trace so reviewers
  can distinguish a deliberate no-op from a failed mutate phase.

## Code Constraints Found

- BullMQ workers on the same queue do not route jobs by `job.name`. A second
  worker on `QUEUE_NAMES.INGESTION` could steal route-classifier jobs or vice
  versa. AGENT-4 therefore adds a separate `QUEUE_NAMES.INGESTION_AGENT`
  queue instead of putting both named jobs on the same queue.
- AGENT-4 keeps the classic classifier active even if a workspace is manually
  set to `agent`; mutate execution is not implemented until AGENT-5, so the
  classifier remains the decision fallback for now.
- The agent worker only updates `ingestions.normalized_text` when missing. It
  does not set ingestion status or write `ingestion_decisions`.

## Tests

- `packages/worker/src/lib/agent/budgeter.test.ts`
  - fast vs large-context routing
  - context packing truncation
- `packages/worker/src/lib/agent/loop.test.ts`
  - tool-call exploration
  - model-run recorder calls
  - structured shadow plan output
  - trace contains `tool_result` and `shadow_execute_skipped`

## Verification

- `corepack pnpm --filter @wekiflow/shared build`
- `corepack pnpm --filter @wekiflow/worker test`
- `corepack pnpm --filter @wekiflow/worker typecheck`
- `corepack pnpm --filter @wekiflow/api typecheck`
