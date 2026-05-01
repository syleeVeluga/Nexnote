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

The intended product surface is still the same: an admin enables Scheduled Agent, sets conservative policy, schedules recurring maintenance, or triggers a selected-page/folder-scoped reorganize run. By default, scheduled mutations land in `/review` as human-visible suggestions.

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
  - scheduled_auto_apply=false forces suggestions regardless of confidence
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
- `PATCH /workspaces/:id/scheduled-tasks/:taskId`
- `DELETE /workspaces/:id/scheduled-tasks/:taskId`

Important implementation note: the current frontend "run now" path for a task reuses `POST /workspaces/:id/reorganize-runs` with the task target pages. `api-client.ts` still exposes `triggerTask()` for `POST /scheduled-tasks/:taskId/trigger`, but the backend route is not currently implemented. Either add the route or remove the dead client method.

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
  - scheduled auto-apply toggle
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

Default behavior:

- If `origin === "scheduled"` and `workspace.scheduled_auto_apply === false`, all mutation decisions are forced to `suggested`.
- Humans approve/reject in the existing `/review` queue.

Override:

- If `workspace.scheduled_auto_apply === true`, scheduled decisions follow the normal confidence policy:
  - confidence >= 0.85 can auto-apply
  - 0.60-0.84 becomes suggested
  - lower confidence goes to review/failure paths depending on tool result

This is implemented in `packages/worker/src/lib/agent/tools/mutate.ts`.

## Known Gaps

These are the remaining Scheduled Agent-specific tasks from the current code review.

### 1. Review Queue origin surfacing

Current gap:

- `ingestion_decisions.scheduled_run_id` exists.
- `/review` still mostly shows scheduled output as a normal ingestion from `sourceName="scheduled-agent"`.
- `/decisions` list/detail DTOs do not expose a first-class `origin` or `scheduledRunId`.
- ReviewQueue has no ingestion/scheduled filter chip and no Scheduled Agent badge.

Recommended fix:

- Add `scheduledRunId` and `origin: "ingestion" | "scheduled"` to decision list/detail DTOs.
- Add optional `origin` filter to `GET /workspaces/:id/decisions`.
- Add origin badge/filter in `ReviewQueuePage`.
- Keep `sourceName` visible, but do not rely on it as the only origin signal.

### 2. Backend/client route mismatch for task trigger

Current gap:

- `scheduledAgent.triggerTask()` exists in `api-client.ts`.
- `POST /workspaces/:id/scheduled-tasks/:taskId/trigger` is not implemented in `scheduled-tasks.ts`.
- Current UI avoids the mismatch by calling `triggerReorganize()` with task fields.

Acceptable resolutions:

- Implement `POST /scheduled-tasks/:taskId/trigger` and use it from the UI, or
- remove `triggerTask()` from `api-client.ts` until the backend route is needed.

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
- scheduled decisions appear in review as `suggested` when auto-apply is off.

## Verification Checklist

Manual verification:

1. Enable Scheduled Agent in `/settings/ai`.
2. Set `scheduled_auto_apply=false`, a daily token cap, and a per-run page limit.
3. Open `/settings/scheduled-agent`.
4. Create a task with a valid hourly-or-slower cron expression and one or more target pages.
5. Confirm the task appears with a `nextRunAt` value.
6. Trigger a one-off run from the task or manual run modal.
7. Confirm `scheduled_runs` moves `running -> completed`.
8. Open the trace drawer and verify live/post-hoc `AgentTracePanel` steps.
9. Open `/review` and confirm scheduled decisions are visible as suggestions.
10. Approve one scheduled decision and verify a new revision with `source="scheduled"` and updated `last_ai_updated_at`.
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

- dry-run preview and approval modal
- scheduled-specific dry-run/shadow/live promotion gate
- richer schedule builder presets instead of raw cron only
- stronger `must_block_commit` signal for dangerous maintenance actions
- `workspace.domain` policy presets
- `model_runs.origin` if origin joins become too expensive/noisy
- `idle_recurring` diagnostic after repeated noop runs
- workspace-wide maintenance jobs with explicit infinite-loop guards

## Operational Notes

- Cron schedules should remain conservative; server validation currently enforces at least one hour between runs.
- Scheduled Agent should normally start with `scheduled_auto_apply=false`.
- `scheduled_daily_token_cap` should be set for every workspace that enables cron.
- Scheduled output shares the same review/provenance/activity model as ingestion output. Avoid introducing a parallel approval path.
