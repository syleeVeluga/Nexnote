# WekiFlow — Task Backlog

> **Snapshot:** 2026-04-30
> **North-star goal:** External signals flow in continuously; the wiki stays automatically up-to-date under human supervision. AI classifies/merges/deduplicates; humans review/correct/approve.
>
> **Status of the core loop** — see [CLAUDE.md](../CLAUDE.md#current-implementation-status-snapshot-2026-04-24-docs-reviewed). The ingest/classify/apply path works, AGENT-1~7 + AGENT-4.5 and AGENT-8 start (tool-calling ingestion agent backend, parity gate, mutate tier 1·2·3, settings UI, fan-out review surfaces, pre-promotion hardening) have landed, and remaining trust gaps are conflict breadth (concurrent ingestions / triple contradictions), API-token management, sidebar/digest surfacing, parity observation, and eventual classic retirement.

Tasks are grouped by **loop stage**, not by package. Within each stage, **[HIGH] / [MED] / [LOW]** marks urgency toward the goal.

> **Tranche 1 landed (2026-04-17):** migration `0003_supervision_loop_foundations` (search_vector column + GIN index, `page_revisions.source_ingestion_id` + `source_decision_id` FKs, `ingestion_decisions.status`); route-classifier now does three-band routing and tags decisions `auto_applied` / `suggested` / `needs_review` / `noop`; patch-generator populates provenance FKs and sets status on success/failure; the `POST /ingestions/:id/apply` endpoint transitions decision status to `approved` / `rejected` on human action.
>
> **Tranche 2 landed (2026-04-17):** dedicated `/workspaces/:id/decisions` API (list with joined ingestion/page context, per-status counts, detail with proposed diff, `approve` / `reject` / `PATCH` endpoints writing `audit_logs`); `apply-decision.ts` helper shared between the old apply endpoint and the new approve flow; `api-client.ts` gains `ingestions` + `decisions` surfaces; `/review` page with tabs (suggested / needs review / failed / recent), j/k/a/r keyboard shortcuts, and a detail panel that renders the proposed diff and reject-with-reason form; sidebar shows a pending-review badge.
>
> **Tranche 3 landed (2026-04-17):** migration `0004_page_freshness` adds `pages.last_ai_updated_at` + `last_human_edited_at` (backfilled from existing revisions), bumped by every revision writer (route-classifier create, patch-generator, apply-decision, editor save, rollback); `FreshnessBadge` renders in the editor status bar in three tones (ai/human/stale) with a hover tooltip carrying both timestamps; revision summary DTO now returns `sourceIngestionId` + `sourceDecisionId`, surfaced in `RevisionHistoryPanel` as a "⛓" chip + "View source" button that opens `IngestionSourcePanel` — a drill-down reusing the existing `GET /workspaces/:id/decisions/:decisionId` endpoint to show action, confidence, decision reason, normalized text, and raw payload.
>
> **S4-2 landed (2026-04-22):** route-classifier persists its candidate snapshot into `ingestion_decisions.rationaleJson.candidates` (id/title/slug + matchSources[]); `GET /decisions/:id` surfaces them as a first-class `candidates` array; new `/ingestions/:ingestionId` page shows ingestion meta, payload, per-decision panels with candidate lists + match-source chips + chosen-target indicator + inline approve/reject + proposed diff; ReviewQueuePage detail pane links out.
>
> **S5-3 landed (2026-04-22):** patch-generator accepts `baseRevisionId` from the classifier's enqueue snapshot; before auto-applying it runs `detectHumanConflict()` on `page_revisions` and, if any `actor_type='user'` revision landed after the base, writes the proposed revision as `suggested` with `rationaleJson.conflict = { type: 'conflict_with_human_edit', humanRevisionId, humanEditedAt, humanRevisionNote, baseRevisionId }` instead of promoting to current. Decision list returns `hasConflict`; detail returns full `conflict` object. ReviewQueuePage list chips and ReviewDetail / IngestionDetailPage banners highlight these with an "approve will stack on human edits" warning.
>
> **S6-1 landed (2026-04-22):** member-readable `GET /workspaces/:id/activity` endpoint joins `audit_logs` with `users` + `model_runs`, batch-loads page/ingestion/folder labels, derives `actor_type` (ai/user/system). New `/activity` page renders "AI (gpt-5.4) updated _Page X_ from ingestion _Slack_" style rows with actor/entity/action/date filters and load-more pagination; sidebar gains an Activity nav link. Next up: S5-4 (triple contradictions), S6-2 (sidebar badges).
>
> **Post-S6 updates observed (2026-04-24):** soft-delete/trash/purge flows (`0006`), archived original ingestion storage (`0007`), predicate display-label cache/backfill (`0008`/`0009`), graph filters + confidence visual encoding + node evidence inspector, reviewed AI content reformatting via the `reformat` queue, pipeline integration tests, and Playwright smoke tests are in the codebase. Still not present: persisted chunk tables/workers, 3D graph toggle, CI, broad route-level API coverage, and Yjs/Hocuspocus.
>
> **Doc reorg + Ingestion Agent RFC (2026-04-29):** all product/design/RFC docs moved from repo root into [`docs/`](.); orchestrator guides (`AGENTS.md`, `CLAUDE.md`) stay at root and got a Documentation map. The single-shot Classify stage is slated to be replaced by a tool-calling ingestion agent — see new epic **AGENT-1..AGENT-8** below. RFC: [`docs/ingestion-agent-plan.md`](ingestion-agent-plan.md).
>
> **Ingestion agent through AGENT-8 start landed (2026-04-29 → 2026-04-30):** AGENT-1 (gateway tool-calling normalization), AGENT-2 (`agent_runs` schema + `workspaces.ingestion_mode`), AGENT-3 (read-only dispatcher), AGENT-4 (shadow loop + budgeter), **AGENT-4.5** (parity SQL view + diagnostics API + AISettingsPage dashboard, daily token cap enforcement, dedupe system-message hint, Redis pub/sub SSE live trace, `workspaces.agent_instructions` + system prompt prepend), **AGENT-5** (mutate tier 1·2·3 direct revisions + update_page/append_to_page fallback + create_page/noop/request_human_review, oldest-first 80% context compaction with cache invalidation, mutate self-correction repair turn), **AGENT-6** (`/settings/ai` mode toggle + workspace-scoped model picker + token cap + parity dashboard with server-side promotion gate), **AGENT-7** (IngestionDetailPage fan-out decisions, AgentTracePanel post-hoc/live trace, ReviewQueuePage sibling badge, Activity feed `agent_run_completed` row), and **AGENT-8 start** (`read_page` large-markdown auto blocks fallback, agent-mode execute smoke coverage, model diagnostic strip, BullMQ-safe agent job IDs). Production 'agent' promotion is now mainly gated by parity observation / staged rollout; global classic retirement still requires 2 weeks of clean `agent` operation.

---

## Stage ②/③ refactor — Ingestion Agent (NEW EPIC, 2026-04-29)

The single-shot route-classifier always creates new pages because (a) only top-3 of 10 DB candidates are shown to the LLM, (b) candidate token budget is 100 tokens vs 80k for incoming, (c) the prompt is biased toward `needs_review`, and (d) the architecture is one LLM call → one decision (no fan-out, no tool calls). Replacing it with a tool-calling agent unlocks "1 ingest → 10+ surgical updates across existing pages" — Karpathy's wiki-maintenance pattern. Full RFC: [`docs/ingestion-agent-plan.md`](ingestion-agent-plan.md). All safeguards (0.85/0.60 confidence gates, baseRevisionId conflict detection, audit_logs, model_runs) are preserved by delegating to the existing [`apply-decision.ts`](../packages/api/src/lib/apply-decision.ts).

**Phasing (RFC `## Implementation order` 참조):** Phase A foundation (AGENT-1/2/3 — 1과 2 병렬, 3은 둘 다 차단) → Phase B shadow validation (AGENT-4 + 1주 parity gate) → Phase C go-live (AGENT-5/6/7 병렬) → Phase D cleanup (AGENT-8). 무거운 단계 (AGENT-1/3/4/5) 는 진입 시점에 `docs/ingestion-agent-step-N-<scope>.md` sub-doc 신규 생성, 가벼운 단계 (AGENT-2/6/7/8) 는 sub-doc 없이 PR description + RFC 갱신만.

### AGENT-1 · [DONE · 2026-04-29] AI gateway tool-calling extension

_Phase A · Size M · Blocked by: nothing (entry point) · Sub-doc on entry: `docs/ingestion-agent-step-1-gateway.md`_

Extend [ai-gateway.ts](../packages/worker/src/ai-gateway.ts) `AIRequest`/`AIResponse` with normalized `tools` / `toolCalls` fields. OpenAI `tool_calls`/`tool` role ↔ Gemini `functionCall`/`functionResponse` translated at adapter boundary. Conformance test: same fixture must produce identical `NormalizedToolCall[]` from both adapters. **Prerequisite for everything else.**

- Done: shared gateway types now expose optional `tools`, `toolChoice`, tool-result messages, prior assistant tool calls, and response `toolCalls`; OpenAI/Gemini adapters translate provider-native tool formats to deterministic normalized calls; `ai-gateway.test.ts` covers cross-provider conformance.

### AGENT-2 · [DONE · 2026-04-29] Schema migration `0015_agent_runs`

_Phase A · Size S · Blocked by: nothing (parallel with AGENT-1) · No sub-doc_

New `agent_runs` table (`{ ingestion_id, workspace_id, status, plan_json, steps_json, decisions_count, total_tokens, started_at, completed_at }`) + nullable `agent_run_id` FKs on `model_runs` and `ingestion_decisions` + new `workspaces.ingestion_mode TEXT NOT NULL DEFAULT 'classic'`. Backwards-compatible — existing classic rows have NULL FKs.

- Done: migration `0015_agent_runs.sql` adds `agent_runs`, FK/index wiring, and the `workspaces.ingestion_mode` guard; Drizzle schema and shared constants now expose `agentRuns`, `agentRunId`, `IngestionMode`, `AgentRunStatus`, and agent default limits.

### AGENT-3 · [DONE · 2026-04-29] Read-only tool layer + dispatcher

_Phase A · Size M · Blocked by: AGENT-1 + AGENT-2 · Sub-doc on entry: `docs/ingestion-agent-step-3-tools-dispatcher.md`_

Five tools (`search_pages`, `read_page`, `list_folder`, `find_related_entities`, `list_recent_pages`) as pure SQL. Dispatcher closes over `workspaceId` (LLM-supplied workspaceId arg is ignored — cross-workspace leak defence), enforces per-tool quotas (search ≤8, read ≤20), dedupes identical args, validates Zod, tracks `seenUUIDs`/`seenBlockIds`.

- Done: shared tool input schemas landed in `packages/shared/src/schemas/agent.ts`; worker read tools live under `packages/worker/src/lib/agent/tools/read.ts`; `createAgentDispatcher()` validates, strips LLM-supplied workspace IDs, dedupes parsed args, enforces quotas/turn limits, and records seen page/block IDs. Tests cover dispatcher safety and markdown block IDs.

### AGENT-4 · [DONE · 2026-04-29] Agent loop in shadow mode

_Phase B · Size L · Blocked by: AGENT-1 + AGENT-2 + AGENT-3 · Followed by: 1-week parity gate · Sub-doc on entry: `docs/ingestion-agent-step-4-loop-shadow.md`_

Explore→plan→execute orchestrator. Shadow mode: agent runs alongside the classic classifier, writes only to `agent_runs.plan_json`; classic still owns `ingestion_decisions`. **One-week parity dashboard** (action match-rate, target-page match-rate) before any workspace flips to `agent`. Token budgeter (800k input / 60k output, model routing fast vs Opus-1M/Gemini-1M/gpt-5.4-pro), adaptive read truncation.

- Done: `ingestionAgentPlanSchema` and `agent_plan` model-run mode landed; `budgeter.ts` handles env-backed limits, fast/large model routing, and plan-context packing; `loop.ts` runs read-only tool exploration then writes a structured shadow plan; `ingestion-agent` BullMQ worker records `agent_runs.plan_json` / `steps_json` / linked `model_runs`; enqueue runs classic classifier plus a separate `ingestion-agent` queue in `shadow` mode. Classic remains the decision owner in `shadow`; `agent` mode ownership lands in AGENT-5.
- Gate active: `PATCH /workspaces/:id` now blocks promotion to `agent` until shadow parity has enough observed days/comparable ingestions and meets action/target agreement thresholds. `/settings/ai` shows the same gate status and disables Agent promotion until it passes. Thresholds are env-tunable via `AGENT_PARITY_GATE_MIN_*`.

### AGENT-4.5 · [DONE · 2026-04-30] Shadow hardening before parity gate

_Phase B/C bridge · Size M · Blocked by: AGENT-4 · Can run beside AGENT-5 · No sub-doc_

Track the shadow-only gaps that must not be forgotten before production promotion: parity SQL/dashboard (`agent_vs_classic_agreement_rate` by action and target page), exploration prompt hardening, read-result dedupe hinting, workspace daily token cap enforcement, and operator-visible shadow diagnostics. Read context compaction moved into AGENT-5 (80% threshold, oldest-first summary, re-read notice + cache invalidation), so this ticket owns the remaining shadow-rollout hardening rather than mutate execution itself.

- Done: migration `0016_agent_shadow_hardening.sql` adds `workspaces.agent_instructions` plus the `agent_vs_classic_agreement_rate` SQL view; `/workspaces/:id/agent-runs/diagnostics` exposes action/target/full agreement, recent mismatches, and daily token usage; worker preflights/enforces `AGENT_WORKSPACE_DAILY_TOKEN_CAP`; explore/plan prompts now prepend workspace operator instructions and harden duplicate-avoidance; repeated read calls get an explicit cached-result system hint; worker publishes live trace events through Redis and the API streams them via SSE.

### AGENT-5 · [DONE · 2026-04-29] Mutate tool wrappers (3-tier patches)

_Phase C · Size L · Rollout still gated by: parity observation + AGENT-6/7 UI · Sub-doc: `docs/ingestion-agent-step-5-mutate-tiers.md`_

`replace_in_page` (find/replace, exact-N match enforce), `edit_page_blocks` (markdown block ops via stable block parser), `edit_page_section` (heading anchor), plus fallback `update_page` / `append_to_page` / `create_page` / `noop` / `request_human_review`. Tier-1/2/3 build the new revision directly without re-calling the LLM (cost + intent preservation). Per-page mutation lock within a run prevents AI-vs-AI race. Plan validator: "if proposed `update_page` keeps ≥70% of existing content, reject and force decompose to `edit_page_blocks`."

- Done: shared mutate schemas landed; `tools/mutate.ts` creates fan-out `ingestion_decisions` with `agent_run_id`; direct patch tiers create proposed/current revisions with provenance, diffs, audit logs, and triple/search enqueue; `update_page` / `append_to_page` hand off high-confidence fallback work to patch-generator with agent-supplied content; enqueue now runs classic+agent in `shadow`, but agent-only in `agent` mode. Added Claude Code-style context compaction (80% threshold, oldest-first summaries, re-read notice + cache invalidation) and mutate self-correction hints with one repair turn. Tests cover patch primitives, compaction, dispatcher cache invalidation, and agent-mode repair execution.
- 잔여 hardening: (a) **`read_page` 큰 본문 자동 `blocks` 폴백 (DONE · AGENT-8 start)** — 모델 입력 capacity 비율과 30k-token 상한 중 작은 값 초과 시 compact block listing으로 자동 전환하고 system notice를 주입. (b) **mutate execute 통합 smoke (DONE · AGENT-8 start)** — agent 모드 create_page happy path와 direct patch conflict downgrade가 `ingestion_decisions` / `page_revisions` / `audit_logs` / `agentRunId`까지 검증됨; repair turn은 기존 worker loop test가 커버. (c) Plan validator 70% full-rewrite self-correct (P2 — RFC §AGENT-5 spec).

### AGENT-6 · [DONE · 2026-04-30] Workspace toggle + `/settings/ai` UI

_Phase C · Size S · Blocked by: AGENT-2 (column exists); usefulness blocked by AGENT-5 · No sub-doc_

`workspaces.ingestion_mode` switch (classic / shadow / agent), model picker, daily token cap. Default classic; flip internal workspaces to shadow first.

- Done: `/settings/ai` lets owners/admins switch classic/shadow/agent, edit workspace `agent_instructions`, inspect parity/token diagnostics, configure workspace-scoped agent provider/fast model/large-context model/fast-threshold, and set a workspace daily token cap. `/system/ai` redirects to the settings route. Agent promotion is server-gated until parity passes; unset model/cap values inherit deployment env defaults.

### AGENT-7 · [DONE · 2026-04-30 · MED] UI fan-out for multiple decisions per ingestion

_Phase C · Size M · Blocked by: AGENT-2 (`agent_run_id` FK); usefulness blocked by AGENT-4 · No sub-doc_

[IngestionDetailPage](../packages/web/src/pages/IngestionDetailPage.tsx) renders decision[] (currently single), [ReviewQueuePage](../packages/web/src/pages/ReviewQueuePage.tsx) sibling badge "(2 of 7 from ingestion X)", new `AgentTracePanel` visualises `agent_runs.steps_json` (thought / tool_call / tool_result timeline). v1 keeps each sibling decision independently approve/rejectable — no bulk approve.

- Done:
  - `AgentTracePanel` (post-hoc `steps_json` + Redis pub/sub SSE live updates) on `/ingestions/:ingestionId`
  - IngestionDetailPage renders `decisions[]` (다중 fan-out) — single-decision 가정 깨짐
  - `/workspaces/:id/agent-runs/:runId` GET + `/events` SSE endpoint (workspace member-only)
  - ReviewQueuePage sibling 배지 "(N of M from ingestion {sourceName})" — visible queue rows are grouped client-side by `ingestion.id`.
  - Activity feed `agent_run_completed` 행 — ingestion-agent worker writes one `audit_logs` row per completed/shadow run and `deriveActivitySummary` renders proposed/auto-applied/queued counts.

### AGENT-PARITY-UI · [DONE · 2026-04-30] Workspace-scoped parity gate threshold UI

_Out-of-band hardening · Size S · No sub-doc_

env-only `AGENT_PARITY_GATE_MIN_*` 변수를 워크스페이스별 nullable 컬럼으로 노출 + AI Settings 페이지에 collapsible "승격 기준 (실험용)" 패널 추가. NULL 시 env 값 fallback (backwards-compat). 한국어 라벨 + "실험·테스트 워크스페이스에서만 사용" 경고 + "기본값으로 되돌리기" 버튼. RFC: [`docs/agent-parity-gate-ui-plan.md`](agent-parity-gate-ui-plan.md).

- Done: migration `0018_agent_parity_gate_overrides.sql` adds 4 nullable columns + range CHECK constraints; `applyAgentParityGateOverrides` + `readAgentParityGateCriteriaForWorkspace` enable per-field workspace → env fallback (`PATCH /workspaces/:id` gate check + `/agent-runs/diagnostics` both use it); `updateWorkspaceSchema` + `Workspace` DTO + api-client expose the 4 fields end-to-end; AISettingsPage renders the collapsible Korean-language panel with effective-value microcopy and reset action; unit tests cover NULL fallback / numeric-string parsing / [0,1] clamp.

### AGENT-8 · [IN PROGRESS · 2026-04-30] Cutover & retire classic

_Phase D · Size S · Blocked by: 2 weeks of clean `agent`-mode operation · No sub-doc_

Promote one workspace at a time after parity ≥ target. Retire `route-classifier.ts` after 2 weeks of clean `agent`-mode operation. Existing classic decision rows preserved via NULL `agent_run_id` FK.

- Started: removed the remaining pre-promotion hard blockers discovered before cutover: large `read_page(format="markdown")` calls now auto-return compact blocks, agent-mode enqueue uses BullMQ-safe job IDs, `/settings/ai` shows the effective provider/base/fast/large model strip, and smoke coverage now exercises agent-mode direct create plus human-conflict downgrade. Classic retirement itself is intentionally deferred until clean production observation.

---

## Stage ③ — Remaining follow-ups

### S3-3 · [MED] Retry / dead-letter path for failed patch-generator jobs

Currently a failed patch-generator sets `ingestions.status="failed"` and logs. The new `/admin/queues` page (S3-4) now exposes BullMQ-level failed jobs with retry/remove, which partially covers the operator case. Still open: surface the per-ingestion error excerpt in `/review` itself, and wire an "Abandon" (audit-logged close) action next to the queue-level retry.

### S3-4 · [DONE · 2026-04-18] Queue observability + DLQ visibility

- Admin-only `/admin/queues` page shows per-queue counts (waiting/active/failed/delayed/stalled/paused) for all six queues (ingestion, patch, extraction, publish, search, reformat).
- Failed and stalled (active > 2min) jobs listed with `failedReason`, attempts/max, timestamps, and workspace/ingestion/page chips drilled from job data.
- Retry and remove actions per job; cross-workspace jobs are read-only guard-rails.
- Backend: [packages/api/src/routes/v1/admin-queues.ts](../packages/api/src/routes/v1/admin-queues.ts) mounted under `/workspaces/:id/admin/queues`, gated by `ADMIN_PLUS_ROLES`; queue plugin updated to expose the `patch` queue. Frontend: [packages/web/src/pages/QueueHealthPage.tsx](../packages/web/src/pages/QueueHealthPage.tsx) with optional 10s auto-refresh.

---

## Stage ④ — Human review UI

The primary review surface shipped in Tranche 2: [/review](../packages/web/src/pages/ReviewQueuePage.tsx) with tabs, list + detail panes, keyboard shortcuts, and a sidebar badge. Remaining work drills deeper into individual ingestions and makes onboarding of new ingestion sources self-serve.

### S4-2 · [DONE · 2026-04-22] Ingestion detail view

- Route: `/ingestions/:ingestionId` ([IngestionDetailPage.tsx](../packages/web/src/pages/IngestionDetailPage.tsx))
- Shows ingestion meta (source, external ref, content-type, receivedAt), raw payload + normalized text (collapsible), "Download original" when the MinIO archive is present, and one panel per decision in reverse-chronological order.
- Each decision panel renders the AI's reason, the chosen target, and the **candidate pages the classifier was choosing from** with per-candidate match-source chips (title / FTS / trigram / entity overlap) and a "chosen target" indicator on the selected one. Proposed diff and approve/reject controls are inline so the reviewer doesn't bounce back to `/review` to act.
- Route-classifier now persists its candidate snapshot into `ingestion_decisions.rationaleJson.candidates` (id/title/slug + matchSources[]); the `GET /workspaces/:id/decisions/:decisionId` endpoint returns them as a first-class `candidates` array.
- ReviewQueuePage detail pane links out via "View full ingestion detail →".

### S4-2-followup · [MED] Re-run classification + target-page override UI

Deferred from S4-2. The PATCH `/decisions/:id` endpoint already accepts `{action, targetPageId, proposedPageTitle}` — needs a small page-search dropdown inside the decision panel to mutate `targetPageId` before approving. "Re-run with a different LLM" is a net-new feature: new endpoint + new BullMQ job that re-enqueues the classifier with an explicit `{provider, model}` override on the payload, writes a second `ingestion_decisions` row, and lets the UI diff the two.

### S4-4 · [MED] API token management UI (prerequisite for onboarding external AI sources)

`api_tokens` table exists; the only way to mint one is via DB seed. Without this, onboarding a new ingestion source requires a DBA.

- `/workspaces/:slug/settings/tokens` — list, create (one-time reveal), revoke, scopes, last-used-at

---

## Stage ⑤ — Provenance, freshness, conflicts (the "trust" layer)

If users can't tell what's current, where a sentence came from, or whether AI is about to overwrite their edit, they won't trust the system to run autonomously.

### S5-1-followup · [MED] Page-list staleness column / sort

Tranche 3 added `last_ai_updated_at` / `last_human_edited_at` + the editor-header badge. The sidebar/page-list view still has no way to sort or filter by staleness, and there's no "who last touched it" attribution in the badge (we only show timestamps, not the actor name or originating ingestion). Add:

- Sidebar: tiny "⚠ stale" dot for pages whose latest change is > 30d
- `/workspaces/:slug/pages` list view: sort by "most recently AI-updated" / "most recently human-edited" / "stalest first"
- Extend the editor-header freshness tooltip to include "from ingestion _X_" when the latest change was an AI write — query the latest `page_revisions` row with `source_ingestion_id` set

### S5-3 · [DONE · 2026-04-22] Concurrent-edit guard

- Route-classifier snapshots `pages.current_revision_id` at enqueue time and passes it to the patch-generator via `PatchGeneratorJobData.baseRevisionId`; also records it on `ingestion_decisions.rationaleJson.baseRevisionId` for auditing.
- Patch-generator runs `detectHumanConflict()` after merging but before applying — the query finds the most recent `page_revisions` row on the target page with `actor_type='user'` and `createdAt > base.createdAt`. If one exists, the job still writes the proposed revision + diff (so the reviewer has something to inspect) but sets the decision status to `suggested` (not `auto_applied`), stamps `rationaleJson.conflict = { type: 'conflict_with_human_edit', humanRevisionId, humanUserId, humanEditedAt, humanRevisionNote, baseRevisionId }`, and skips the promote-to-current + `lastAiUpdatedAt` bump + triple-extractor enqueue. Audit-log source is `patch_generator_conflict_downgrade`.
- AI-to-AI drift is not treated as a conflict — the patch merges against current head regardless so output is never stale; only `actor_type='user'` rows trigger the downgrade, matching the spec wording "human session".
- API: `GET /decisions/:id` returns `conflict` as a first-class field; list endpoint returns `hasConflict: boolean` for list items.
- UI: ReviewQueuePage list items show a red "⚠ conflict" chip next to the status badge; [ReviewDetail.tsx](../packages/web/src/components/review/ReviewDetail.tsx) and the IngestionDetailPage decision panels render a prominent conflict banner with the human's edit timestamp + revision note and an "approving will stack on top of human edits" warning.
- Follow-up: approve-of-conflicted decision is currently permissive (creates a new AI revision on top of the human's edits; history is preserved). A stricter mode would require `{ force: true }` on the approve endpoint or auto-regenerate against current head. Punt until users report the permissive behavior as surprising.

### S5-4 · [MED] Contradicting-triple detection

When triple-extractor produces a triple `(S, P, O1)` but `(S, P, O2)` already exists with different object and overlapping time window, mark both as `conflict=true` and surface in a workspace "Contradictions" view. Do not auto-delete — let a human resolve.

### S5-5 · [LOW] Stale-knowledge sweep

Cron job: flag pages with no AI update in N days AND no human edit in M days as `stale`. Surface on workspace dashboard.

---

## Stage ⑥ — Activity feed & notifications (the "what just happened" layer)

Reviewers and workspace owners need to see the AI's work in aggregate, not just by clicking into individual pages.

### S6-1 · [DONE · 2026-04-22] Workspace activity feed

- New member-readable endpoint `GET /workspaces/:id/activity` ([activity.ts](../packages/api/src/routes/v1/activity.ts)) joins `audit_logs` with `users` + `model_runs`, batch-loads referenced pages/ingestions/folders for labels, and derives `actor_type` from `userId` / `modelRunId` (ai / user / system). Filters: `actorType`, `entityType`, `action`, `from`, `to`, `limit`, `offset`.
- `/activity` page ([ActivityPage.tsx](../packages/web/src/pages/ActivityPage.tsx)) renders each row as `<actor-chip> <action> <entity-link> <from ingestion ...>` with AI/user/system actor chips, click-through links into the page editor or ingestion detail page, "from ingestion X" clause pulled from `afterJson.ingestionId`, date/actor/entity/action filter bar, reset + load-more pagination.
- Sidebar gets an "Activity" nav link above "Import", translations in [en/activity.json](../packages/web/src/i18n/locales/en/activity.json) + [ko/activity.json](../packages/web/src/i18n/locales/ko/activity.json), CSS in [activity.css](../packages/web/src/styles/activity.css).
- Follow-up: S6-2 (sidebar counts for pending decisions/conflicts/failed jobs, optional webhook/email digest).

### S6-2 · [MED] Sidebar badges & in-app notifications

- Sidebar shows counts: pending decisions, conflicts, failed jobs
- Optional: webhook / email digest for reviewers

---

## In-editor AI interaction

### E-1 · [MED] Accept/reject UI for `POST /pages/:id/ai-edit` output

Current SSE result streams into the editor but there's no explicit "Accept this rewrite" / "Reject" step. Users lose track of what changed.

- Render AI output in a side-by-side proposal pane
- Accept = apply as new revision with `source="ai_edit_command"`, `actor_type="ai"`
- Reject = stored as `ai_edit_rejections` for future prompt improvement

### E-2 · [LOW] Inline highlight of recent AI changes

For N minutes after an AI edit, highlight the affected blocks in the editor so human collaborators see what AI touched.

---

## Notion-like UX — layout & editor (UX-N)

The platform's credibility as a knowledge wiki depends on the editor feeling native. Current state: hierarchical sidebar + slash menu + autosave are in; most of what makes Notion _feel_ like Notion is not.

### UX-N1 · [HIGH] Page metadata: icon (emoji) + cover image

Without these, pages look like filesystem entries rather than living documents — users can't create visual landmarks in a large wiki.

- Schema: add `pages.icon TEXT NULL` (emoji shortcode or file-ref), `pages.cover_url TEXT NULL`, `pages.cover_position SMALLINT`
- Sidebar: render icon next to title
- Editor header: click icon to pick from emoji picker; hover cover to change / remove / reposition
- Public docs: render icon + cover in list and detail pages

### UX-N2 · [HIGH] Drag-and-drop reparent + reorder — ✅ DONE (2026-04-25)

Sidebar is now a **unified explorer** over folders + pages with native HTML5 drag-and-drop. Rows expose a dedicated drag handle (row clicks still navigate), pointer-Y → `before` / `after` / `asChild` drop intent, auto-expand on ~500 ms hover over collapsed parents, and a fallback right-click **Move** dialog is preserved. Scope landed together because the previous tree rendered pages only — folders now have full UI (create / rename / delete / move).

- Schema: `pages.parent_folder_id` + XOR CHECK (`parent_page_id IS NULL OR parent_folder_id IS NULL`) via migration `0011_page_parent_folder`.
- API: `PATCH /pages/:id` and `PATCH /folders/:id` accept `reorderIntent` (`before` / `after` / `asFirstChild` / `asLastChild`). Transactional helper in [reorder.ts](../packages/api/src/lib/reorder.ts) rewrites affected siblings with spaced `sortOrder = i * 1024`.
- Folder cycle guard: new [folder-hierarchy.ts](../packages/api/src/lib/folder-hierarchy.ts) mirrors page-hierarchy (self-parent / descendant cycle / cross-workspace). Pages moving into a folder get the same workspace-existence check via `validateFolderExistsInWorkspace`.
- Sort rule: inside every parent, folders render first then pages — no interleaving, so each group keeps its own `sortOrder` sequence.
- Tests: `folder-hierarchy.test.ts`, `reorder.test.ts` (before/after/asFirst/asLast), `explorer-tree.test.ts` (bucketing + drop-intent matrix including "folder cannot drop on page" and "page→folder before/after downgrades to asChild").
- Out of scope (intentionally): workspace-wide graph, page `path` / slug uniqueness changes, route-classifier becoming folder-aware (still creates at root).

### UX-N3 · [HIGH] Block drag handle + "+" button

Each block needs the hover affordances that make Notion's editor feel tactile: `⋮⋮` drag handle on the left, `+` button to insert below.

- Tiptap: custom `NodeView` or global handle extension
- Operations: move up/down, duplicate, delete, convert block type
- Keyboard: `Opt+Shift+↑/↓` to move, `Cmd+D` to duplicate

### UX-N4 · [HIGH] Page links & mentions (`@`, `[[…]]`)

A knowledge wiki without internal linking is not a wiki.

- Slash/`@`/`[[` triggers an inline search across workspace pages
- Inserts a Tiptap `pageLink` mark/node with `pageId`; renders as a live, click-through pill
- Backlinks panel at page bottom: "Referenced by: _Foo_, _Bar_" — query `page_links` edge table (new) updated on revision save
- Public docs: resolve internal links to `/docs/:ws/:path`

### UX-N5 · [MED] Missing block types

PRD calls for a rich editor. Add progressively:

- **Callout** (with icon + color): info/warn/success/error presets
- **Toggle** (collapsible children blocks)
- **Math** (inline `$…$` and block `$$…$$` via KaTeX)
- **Embed** (YouTube, Loom, Figma — URL-sniffing with allowlist)
- **Database/Table view** — defer unless clearly demanded
- Each new type must round-trip cleanly to Markdown (custom directive syntax); add round-trip tests

### UX-N6 · [MED] Breadcrumb + in-editor TOC

Public docs already render a TOC ([PublicDocPage.tsx](../packages/web/src/pages/PublicDocPage.tsx)); editors get nothing.

- Breadcrumb above title: `Workspace / Parent / Current` with click-through
- Right rail: sticky TOC built from the editor's heading tree; active-section highlighting on scroll

### UX-N7 · [MED] Inline title + slug editing

[PageEditorPage.tsx](../packages/web/src/pages/PageEditorPage.tsx) separates title from body; Notion makes title an H1 atop the document.

- Merge title into the editor as a locked first block or a styled input directly above
- Slug auto-derives from title; manual override available in page settings

### UX-N8 · [MED] Cmd+K command palette

Global keyboard-first navigation is table-stakes for a wiki of any size.

- `Cmd+K` — search pages, jump, recent, "create new page under current"
- `Cmd+P` — quick-open
- `Cmd+/` — toggle slash menu help
- Reuse the FTS search API (once P0-1 lands) + recency from `audit_logs`

### UX-N9 · [LOW] Keyboard shortcut surface

Document and expose: Cmd+B/I/U, Cmd+K link, Cmd+Shift+1/2/3 headings, Cmd+Enter toggle task, Tab/Shift+Tab list nesting. Help sheet behind `?`.

---

## Triple quality & graph exploration (G)

The knowledge graph is the payoff of the whole pipeline but currently produces low-fidelity triples and offers almost no exploration UX beyond a per-page BFS.

### G-1 · [HIGH] Audit triple-extractor quality & entity typing

Spot-check: entities get typed almost entirely as `concept`. Without meaningful types (person/org/product/event/place), the graph's color legend is noise and filters are useless.

- Review the LLM prompt in [triple-extractor.ts](../packages/worker/src/workers/triple-extractor.ts) — does it explicitly ask for entity type? Add an enum with definitions
- Run extraction on a 20-page seed corpus, manually label, measure precision/recall
- Gate merges: if type confidence < 0.5, fall back to `concept` but flag for review

### G-2 · [HIGH] Entity alias / merge handling

`entity_aliases` table exists but confirm the worker actually writes to it and reuses aliases before creating a new entity. Without this, the graph fragments ("GPT-5.4", "gpt5.4-pro", "GPT 5.4" become three nodes).

- On extraction, match incoming subject/object against `entities.normalized_key` AND `entity_aliases.alias`
- Merge UI: "Entity _X_ and _Y_ look like duplicates — merge?" in a workspace admin view

### G-3 · [HIGH] Deduplicate triples on re-extraction

Same page re-extracted (after edit) should update confidence / span on existing triples, not insert duplicates. Verify current behavior; add a uniqueness constraint on `(subject_entity_id, predicate, object_entity_id_or_literal_hash, revision_id)` if missing.

### G-4 · [HIGH] Workspace-wide graph view

Per-page BFS is good for focus; users also need the big picture.

- `GET /workspaces/:id/graph?predicate=&minConfidence=&type=&limit=` — density-aware sampling (cap nodes, prefer high-degree)
- `/workspaces/:slug/graph` page (not a side panel) with full-screen force-graph
- Stats: total entities, top predicates, orphaned pages

### G-5 · [HIGH] Entity detail panel

Clicking a node currently doesn't open anything meaningful.

- Update: the page-side graph panel now has a first-pass entity inspector with direct incoming/outgoing relations, source pages, and evidence excerpts. Remaining work below is for a fuller ontology browser.
- Side panel: entity label, type, aliases, all triples where it appears (in/out), pages that mention it (via `triple_mentions`), confidence distribution
- Actions: rename, merge with another entity, change type, delete

### G-6 · [PARTIAL · 2026-04-24] Graph filters + confidence encoding

The editor graph panel now has predicate filters, entity-type filters, a min-confidence control, focus dimming, predicate display labels, and confidence-based edge opacity/width.

- Update: predicate multiselect, confidence slider, entity-type toggles, and edge opacity/width encoding are now shipped in the editor graph panel.
- Update: predicate labels can now be served from a locale-aware cache (`ko` / `en`) in graph edges and provenance excerpts, with regional browser locales normalized on the client and a worker backfill script for existing triples.
- Remaining: add time-range filtering (`triples.created_at`) and conflict-specific styling once `conflict=true` triples land.
- Conflict styling: dashed edges for `conflict=true` triples after S5-4 lands.

### G-7 · [MED] Node search + focus

- Search box above graph — fuzzy match on entity label + aliases
- Match → highlight node, pan camera, dim others
- "Find path between X and Y" — shortest-path query over triples

### G-8 · [MED] 3D toggle UX surface

The current editor graph panel is still 2D-only (`react-force-graph-2d`). Add a lazy-loaded 3D renderer only if it remains useful after workspace-wide graph work lands.

- Add a 2D / 3D toggle.
- Persist the choice per user.
- Evaluate graph-specific camera defaults before enabling 3D broadly.

### G-9 · [LOW] Graph export

`.graphml` / `.json` export for external tooling (Gephi, Cytoscape).

### G-10 · [LOW] Time-lapse / "what changed this week"

Overlay recent triple additions (last 7d) with a pulse animation so users see the graph growing.

---

## Cross-cutting infra (not tied to a loop stage but blocks confident iteration)

### X-1 · [HIGH] CI workflow (`.github/workflows/ci.yml`)

Install, lint, typecheck, unit tests, migration sanity. Services: Postgres + Redis. Every PR runs this.

### X-2 · [DONE · 2026-04-24] Pipeline integration tests

- `tests/integration/pipeline.smoke.test.ts` covers synthetic ingestion through route-classifier, revision creation, triple extraction, and audit persistence with deterministic AI fixtures.
- `tests/integration/pipeline.nightly.test.ts` covers suggested/needs-review decisions, approval/rejection, publish snapshot serving, and failed-ingestion behavior.
- Remaining test gap is CI enforcement, not local coverage definition.

### X-3 · [MED] API route integration tests

`packages/api` has unit tests for shared helpers, but still lacks route-level integration coverage. Cover at minimum: auth flows, role guards, ingestion intake, decision approve/reject, graph endpoint, ai-edit SSE.

### X-4 · [MED] Observability: queue depth + job duration metrics

`prom-client` endpoint on api + worker. Surface: queue depth per stage, job duration histogram, AI latency + cost. Without this, pipeline stalls are invisible.

### X-5 · [LOW] pgvector-based candidate search (gated by flag)

Currently route-classifier uses FTS + trigram. pgvector would help when incoming text uses different vocabulary than the page.

### X-6 · [LOW] Yjs/Hocuspocus collaboration

PRD calls for it; not installed. S5-3 reduced the worst AI-vs-human overwrite risk, but real collaboration should still wait until edit-session UX, accept/reject AI proposals, and conflict notifications are more mature.

---

## How to work this list

1. **P0 first** — they corrupt data or break the trust story.
2. **Close the supervision loop next: S3 → S4 → S5.** Fix routing, then the UI that consumes it, then the trust layer.
3. **In parallel, run two tracks:**
   - **UX-N (Notion-like polish)** — can be worked by a frontend-focused contributor without blocking the backend loop work. UX-N1 through UX-N4 are what visitors notice first.
   - **G (graph & triple quality)** — G-1/G-2/G-3 are backend/prompt work; G-4/G-5/G-6 are frontend. G-1 should land before G-4/G-5 or the big graph view will be full of `concept`-typed noise.
4. **[HIGH] within each section** before anything lower.
5. Keep the review/supervision surfaces coherent when adding new AI flows; every AI proposal should land in the same decision/provenance/activity model unless there is a clear reason not to.
6. When a task completes, delete it from this file in the same PR. The goal is for this file to shrink.

Avoid:

- Adding more AI capabilities (better prompts, more models, smarter extraction) before the supervision loop is closed. AI quality doesn't matter if nobody can review its output.
- Building the workspace-wide graph (G-4) before G-1/G-2 — a dense graph of `concept` nodes with fragmented duplicates is worse than no graph.
- Reviving "Yjs collaboration" (X-6) before edit-session UX and AI proposal accept/reject are strong enough for real concurrent editing.
