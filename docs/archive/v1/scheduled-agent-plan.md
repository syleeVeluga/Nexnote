# Scheduled Agent — implementation status and remaining work

> Snapshot: 2026-05-01
> Source of truth: current code in `packages/api`, `packages/worker`, `packages/web`, plus the UI implementation plan that followed the older v1 backend plan.

## Context

Scheduled Agent extends the ingestion-agent loop from "react to external input" to "maintain selected wiki areas on demand or on a schedule".

The older v1 plan in this file assumed backend work existed but UI did not. That is no longer accurate. The current code already includes:

- workspace Scheduled Agent settings in `/settings/ai`
- `/settings/scheduled-agent` management page
- cron task CRUD and BullMQ job scheduler registration/removal
- manual reorganize runs
- folder-level "AI reorganize this folder" entry point
- scheduled-agent BullMQ worker
- `scheduled_runs` / `scheduled_tasks` schema
- live/post-hoc trace drawer through the existing `AgentTracePanel`

The intended product surface is still the same: an admin enables Scheduled Agent, sets conservative policy, schedules recurring maintenance, or triggers a selected-page/folder-scoped reorganize run. Scheduled mutations now apply autonomously and do not create `/review` approval work.

## Current Architecture

```
Trigger
  A) Manual: POST /workspaces/:id/reorganize-runs
     body: { pageIds, includeDescendants, instruction }

  B) Cron: scheduled_tasks row + BullMQ job scheduler
     API: /workspaces/:id/scheduled-tasks

        |
        v

scheduled-agent-queue
        |
        v

scheduled-agent worker
  - creates/updates scheduled_runs
  - expands selected pages through scheduled input adapter
  - creates an internal ingestion row for provenance/idempotency
  - creates an agent_runs trace row
  - calls runIngestionAgentShadow(..., {
      mode: "agent",
      origin: "scheduled",
      seedPageIds,
      instruction,
      scheduledRunId,
      scheduledAutoApply
    })

        |
        v

existing ingestion-agent dispatcher + read/mutate tools
  - read_page/search_pages/list_folder/etc.
  - replace_in_page/edit_page_blocks/edit_page_section
  - update_page/append_to_page/create_page/noop/request_human_review

        |
        v

ingestion_decisions / page_revisions / audit_logs / model_runs
  - scheduled decisions are linked by ingestion_decisions.scheduled_run_id
  - revisions use source="scheduled" when applied
  - scheduled mutation decisions auto-apply without approval
  - delete_page / merge_pages permanently purge affected source subtrees
```

## Implemented

### Database and shared types

- Migration `0019_scheduled_agent.sql` adds:
  - `workspaces.scheduled_enabled`
  - `workspaces.scheduled_auto_apply`
  - `workspaces.scheduled_daily_token_cap`
  - `workspaces.scheduled_per_run_page_limit`
  - `scheduled_tasks`
  - `scheduled_runs`
  - `ingestion_decisions.scheduled_run_id`
- Drizzle schema exists in `packages/db/src/schema/scheduled.ts`.
- Shared constants expose `QUEUE_NAMES.SCHEDULED_AGENT = "scheduled-agent-queue"` and scheduled run status/trigger types.
- Shared schemas expose `scheduledTaskBodySchema` and `updateScheduledTaskBodySchema`.

### API

Implemented route surfaces:

- `POST /workspaces/:id/reorganize-runs`
  - queues a manual scheduled run
  - requires editor-plus role
  - requires `workspaces.scheduled_enabled=true`
- `GET /workspaces/:id/scheduled-runs`
  - lists recent scheduled run records
- `GET /workspaces/:id/scheduled-tasks`
- `POST /workspaces/:id/scheduled-tasks`
- `GET /workspaces/:id/scheduled-tasks/:taskId`
- `POST /workspaces/:id/scheduled-tasks/:taskId/trigger`
  - queues a manual run from the persisted task payload
- `PATCH /workspaces/:id/scheduled-tasks/:taskId`
- `DELETE /workspaces/:id/scheduled-tasks/:taskId`

Important implementation note: the frontend task "run now" path uses `POST /workspaces/:id/scheduled-tasks/:taskId/trigger`. Ad-hoc manual runs still use `POST /workspaces/:id/reorganize-runs`.

Cron validation is server-side and intentionally conservative: `validateScheduledCronExpression()` rejects expressions that run more than once per hour.

### Worker

`packages/worker/src/workers/scheduled-agent.ts`:

- consumes `scheduled-agent-queue`
- skips cron jobs when the task or workspace has been disabled
- builds the selected page scope through `buildScheduledAgentInput()`
- creates an internal "Scheduled Agent Internal" API token if needed
- persists an internal ingestion row with `idempotencyKey = scheduled-run:<runId>`
- creates an `agent_runs` trace row and streams live steps through Redis
- calls the existing ingestion-agent loop in `mode="agent"` with `origin="scheduled"`
- updates `scheduled_runs` with status, decision count, token totals, diagnostics, completion time
- stamps `ingestion_decisions.scheduled_run_id` after execution
- writes `scheduled_agent_run_completed` activity

`packages/worker/src/lib/scheduled/input-adapter.ts`:

- accepts selected page IDs
- optionally expands descendants
- caps scope by `scheduled_per_run_page_limit`
- builds normalized text that tells the agent this is a scheduled wiki reorganize request

### Frontend

Implemented UI:

- `/settings/ai`
  - Scheduled Agent enable toggle
  - scheduled auto-apply toggle (legacy; backend now runs scheduled mutations autonomously)
  - scheduled daily token cap
  - per-run page limit
  - link to `/settings/scheduled-agent`
- `/settings/scheduled-agent`
  - disabled-state panel linking back to `/settings/ai`
  - cron task table
  - task create/edit modal
  - task enable/disable toggle
  - delete confirmation
  - manual "run once" modal
  - recent scheduled runs table
  - trace drawer using `AgentTracePanel`
- folder page entry point
  - "AI reorganize this folder" action
  - recursive page collection with scope guard
  - shared reorganize run form
  - deep link to `/settings/scheduled-agent?run=<scheduledRunId>`
- sidebar and breadcrumbs include Scheduled Agent navigation.
- i18n lives in `packages/web/src/i18n/locales/{en,ko}/scheduled-agent.json`.

The plan changed from the earlier page-header button idea: the entry points are selected-page and folder scoped. `PageEditorPage`'s existing single-page reformat/rewrite flow is intentionally left alone.

## Auto-apply Policy

Current behavior:

- If `origin === "scheduled"`, mutation decisions auto-apply regardless of confidence and regardless of the legacy `workspace.scheduled_auto_apply` value.
- `request_human_review` from a scheduled run is converted to `noop`, so Scheduled Agent does not create approval work.
- Human-edit conflicts are recorded in decision rationale but do not downgrade scheduled mutations to `/review`.
- `delete_page` and `merge_pages` permanently purge affected source subtrees after applying, so deleted/merged pages do not remain in trash and cannot create restore conflicts.

This is implemented in `packages/worker/src/lib/agent/tools/mutate.ts`.

## Known Gaps

These are the Scheduled Agent-specific tasks from the current code review. Completed items are retained here for traceability.

### 1. Review Queue origin surfacing

Status: done 2026-05-01.

- `GET /workspaces/:id/decisions` list/detail DTOs expose `scheduledRunId` and `origin: "ingestion" | "scheduled"`.
- Decision list accepts optional `origin=ingestion|scheduled` filtering.
- `/review` renders origin filter chips, Scheduled Agent badges, and a scheduled-run deep link from the detail pane.
- `sourceName` remains visible as payload provenance, but is no longer the only scheduled-origin signal.

### 2. Backend/client route mismatch for task trigger

Status: done 2026-05-01.

- `POST /workspaces/:id/scheduled-tasks/:taskId/trigger` is implemented.
- The route queues a manual scheduled-agent run using the persisted task scope, instruction, include-descendants flag, and task id.
- `/settings/scheduled-agent` uses `scheduledAgent.triggerTask()` for task "run now".

### 3. Manual reorganize page validation

Current gap:

- scheduled task create/update validates target pages before persistence.
- manual `POST /reorganize-runs` validates UUID shape but not that all target pages exist in the workspace before queueing.
- worker eventually drops missing/deleted pages, but a synchronous 400 would be clearer.

Recommended fix:

- Share the active-target-page validation from scheduled task routes or move it into a small API helper.

### 4. Cost display is not backed by cost calculation

Current gap:

- `scheduled_runs.cost_usd` exists and `ScheduledAgentPage` renders cost.
- worker updates token totals but does not calculate/write cost.
- UI likely displays `$0.0000` for all runs.

Recommended fix:

- Either add cost estimation from provider/model pricing into scheduled worker summaries, or hide the `$` column until real cost data exists.

### 5. End-to-end coverage

Current gap:

- Unit tests exist for cron validation, scheduler helpers, and scheduled prompt seeding.
- No dedicated Scheduled Agent e2e test exists under `tests/e2e`.

Recommended coverage:

- `/settings/ai` saves Scheduled Agent settings.
- `/settings/scheduled-agent` creates/disables/deletes a task.
- manual run queues and opens a trace drawer.
- folder action sends the expected page IDs.
- scheduled decisions auto-apply and do not create `/review` approval items.

## Verification Checklist

Manual verification:

1. Enable Scheduled Agent in `/settings/ai`.
2. Set a daily token cap and a per-run page limit.
3. Open `/settings/scheduled-agent`.
4. Create a task with a valid hourly-or-slower cron expression and one or more target pages.
5. Confirm the task appears with a `nextRunAt` value.
6. Trigger a one-off run from the task or manual run modal.
7. Confirm `scheduled_runs` moves `running -> completed`.
8. Open the trace drawer and verify live/post-hoc `AgentTracePanel` steps.
9. Confirm scheduled decisions are `auto_applied` or `noop`, not `suggested` / `needs_review`.
10. Verify a new revision with `source="scheduled"` and updated `last_ai_updated_at`.
11. Disable/delete the task and verify the BullMQ scheduler is removed.

Useful commands:

```bash
pnpm --filter db migrate
pnpm --filter shared build
pnpm --filter api test -- --test-name-pattern=scheduled
pnpm --filter worker test -- --test-name-pattern=scheduled
pnpm --filter web typecheck
pnpm --filter web lint
pnpm --filter web test
```

For local manual testing:

```bash
pnpm --filter worker dev
pnpm --filter api dev
pnpm --filter web dev
```

## v2+ Follow-ups

These remain out of v1 scope:

- optional dry-run preview mode
- scheduled-specific dry-run/shadow/live promotion gate
- richer schedule builder presets instead of raw cron only
- stronger `must_block_commit` signal for dangerous maintenance actions
- destructive `delete_page` / `merge_pages` tools — see [`scheduled-agent-merge-delete-plan.md`](scheduled-agent-merge-delete-plan.md)
- `workspace.domain` policy presets
- `model_runs.origin` if origin joins become too expensive/noisy
- `idle_recurring` diagnostic after repeated noop runs
- workspace-wide maintenance jobs with explicit infinite-loop guards

## Operational Notes

- Cron schedules should remain conservative; server validation currently enforces at least one hour between runs.
- Scheduled Agent runs autonomously once enabled; use page scope and token caps as the primary guardrails.
- `scheduled_daily_token_cap` should be set for every workspace that enables cron.
- Scheduled output shares the same provenance/activity model as ingestion output, but not its approval queue.
