# Agent Autonomy & Rollback — Umbrella RFC (S1 + S4)

> **상태**: 초안 (2026-05-04) · S1·S4 미착수
> **유형**: 구현 RFC
> **모티브**: 외부 신호가 사람의 승인 없이도 위키에 즉시 반영되도록 한다 — 단, 자율 에이전트가 자기 실수를 자기가 되돌릴 수 있어야 한다

본 RFC 는 docs/v2/ 묶음의 **첫 번째 우산** — 자율 적용을 가능하게 하는 mode flag (S1) 과 그 안전망인 rollback tool (S4) 을 한 짝으로 다룬다. 사용자 결정으로 **S1 → S4** 순서.

## Context

기존 [`docs/ingestion-agent-plan.md`](../ingestion-agent-plan.md) 의 explore→plan→execute 루프와 [`docs/scheduled-agent-plan.md`](../scheduled-agent-plan.md) 의 `scheduled_auto_apply` 가 합쳐져 **scheduled origin 한정으로** 자율 mutation 이 동작한다. 일반 ingestion 은 여전히 confidence 0.85/0.60 임계로 `auto_applied` / `suggested` / `needs_review` 분기가 강제되며, [`packages/worker/src/workers/patch-generator.ts`](../../packages/worker/src/workers/patch-generator.ts) 의 `detectHumanConflict()` 가 인간 편집 위 AI 적용을 `suggested` 로 다운그레이드한다.

자율 운영의 차단 지점이 명확하므로, 이를 **워크스페이스 레벨 토글** (`autonomy_mode`) 로 우회하되, parity gate / kill switch / destructive throttle / rollback tool 까지 동시 도입해 안전망을 일치시킨다.

## Sprint 1 — Autonomy mode foundation

### 1.1 데이터 모델

신규 마이그레이션 [`packages/db/src/migrations/0020_agent_autonomy.sql`](../../packages/db/src/migrations/0020_agent_autonomy.sql) (신규):

```sql
ALTER TABLE workspaces ADD COLUMN autonomy_mode TEXT NOT NULL DEFAULT 'supervised'
  CHECK (autonomy_mode IN ('supervised','autonomous_shadow','autonomous'));
ALTER TABLE workspaces ADD COLUMN autonomy_promoted_at TIMESTAMPTZ;
ALTER TABLE workspaces ADD COLUMN autonomy_promoted_by UUID REFERENCES users(id);
ALTER TABLE workspaces ADD COLUMN autonomy_paused_until TIMESTAMPTZ;
ALTER TABLE workspaces ADD COLUMN autonomy_max_destructive_per_run INTEGER NOT NULL DEFAULT 3;
ALTER TABLE workspaces ADD COLUMN autonomy_max_destructive_per_day INTEGER NOT NULL DEFAULT 20;
```

| 컬럼 | 의미 |
|---|---|
| `autonomy_mode` | `supervised` (기존 동작) / `autonomous_shadow` (분류는 autonomous 로직, 결정 status 는 `suggested` 강제 — dry-run) / `autonomous` (정식 자율 적용) |
| `autonomy_promoted_at`/`_by` | `autonomous` 승격 시각·관리자 — 책임 추적 |
| `autonomy_paused_until` | kill switch — 미래 시각이면 worker 즉시 abort |
| `autonomy_max_destructive_per_run` | 한 run 내 `delete_page`/`merge_pages` 호출 상한 (default 3) |
| `autonomy_max_destructive_per_day` | 워크스페이스 일일 destructive 호출 상한 (default 20) |

### 1.2 코드 변경

**필수 수정**:

- [`packages/shared/src/lib/decision-classifier.ts:13`](../../packages/shared/src/lib/decision-classifier.ts#L13) — `classifyDecisionStatus(action, confidence, opts?: { autonomous?: boolean })` 시그니처 확장. `opts.autonomous && action !== "needs_review" && action !== "noop"` → `auto_applied`. action 우선순위 (noop/needs_review) 는 보존.
- [`packages/db/src/schema/users.ts:25-71`](../../packages/db/src/schema/users.ts#L25) — Drizzle schema 에 6개 컬럼 추가. `allowDestructiveScheduledAgent` 다음 인접 위치.
- [`packages/worker/src/lib/agent/tools/mutate.ts:1387`](../../packages/worker/src/lib/agent/tools/mutate.ts#L1387) — destructive tool 게이트 완화:
  ```
  before: input.origin === "scheduled" && input.allowDestructiveScheduledAgent
  after:  (input.origin === "scheduled" && input.allowDestructiveScheduledAgent)
       || input.autonomousMode === "autonomous"
  ```
- [`packages/worker/src/lib/agent/loop.ts`](../../packages/worker/src/lib/agent/loop.ts) `RunIngestionAgentShadowInput` 에 `autonomousMode?: "supervised"|"autonomous_shadow"|"autonomous"` 필드 추가, `createMutateTools` 호출에 propagate.
- [`packages/worker/src/lib/agent/tools/mutate.ts`](../../packages/worker/src/lib/agent/tools/mutate.ts) `createMutateTools` 의 `CreateMutateToolsInput` 에 `autonomousMode` 추가 → 모든 mutation 핸들러가 `classifyDecisionStatus` 호출 시 `autonomous: input.autonomousMode === "autonomous"` 전달.
- [`packages/worker/src/workers/patch-generator.ts`](../../packages/worker/src/workers/patch-generator.ts) — `detectHumanConflict()` 결과로 다운그레이드 분기에 autonomous 우회 추가. **단 `audit_logs` 에 `autonomous_overrode_human_conflict` action 으로 반드시 기록** — 기록 건너뛰지 않음.
- [`packages/api/src/routes/v1/ai-settings.ts`](../../packages/api/src/routes/v1/ai-settings.ts) (또는 `agent-runs.ts`) — `PATCH /workspaces/:id/autonomy` 엔드포인트 신규. body: `{ autonomyMode, maxDestructivePerRun?, maxDestructivePerDay? }`. ADMIN 권한. `autonomous` 승격 전 [`evaluateAgentParityGate()`](../../packages/api/src/lib/agent-parity-gate.ts#L164) 통과 필수, 미통과 시 `autonomous_shadow` 까지만 허용. `autonomy_promoted_at`/`_by` 자동 채움.
- [`packages/api/src/routes/v1/ai-settings.ts`](../../packages/api/src/routes/v1/ai-settings.ts) — `POST /workspaces/:id/autonomy/pause` (kill switch). body: `{ pauseUntil }`. ADMIN.

**Per-run 안전망 (loop.ts / dispatcher.ts)**:

- `dispatcher.ts` `AgentRunState` 에 `destructiveCount: number` 추가 — `delete_page`/`merge_pages` 실행 시 +1, `autonomy_max_destructive_per_run` 초과 시 recoverable error (`AgentToolError`, code: `destructive_limit_exceeded`).
- `loop.ts` 진입 시 `autonomy_paused_until > now()` → 즉시 `agent_runs.status='paused'` 설정 후 종료.
- 워크스페이스 일일 destructive 카운터: Redis fixed-window — [`packages/api/src/lib/rate-limit.ts`](../../packages/api/src/lib/rate-limit.ts) 의 `consumeRateLimit` 패턴 재사용. 키: `autonomy:destructive:{workspaceId}:{YYYY-MM-DD}`. 초과 시 mutate tool 에서 recoverable error.

### 1.3 UI

[`packages/web/src/pages/AISettingsPage.tsx`](../../packages/web/src/pages/AISettingsPage.tsx):

- 신규 "Autonomy" 섹션 (Scheduled 섹션과 자매 위치).
- 토글 그룹: `supervised` | `autonomous_shadow` | `autonomous`.
- parity gate 상태 표시 (`/agent-runs/diagnostics` 재사용) — 미통과 시 `autonomous` 옵션 disabled, 사유 인라인 표시.
- destructive cap 입력 (per-run, per-day).
- Kill switch 버튼 — `autonomy_paused_until = now() + 24h` set, 24h 후 자동 해제. 현재 paused 상태이면 카운트다운 표시 + "재개" 버튼.
- 일일 destructive 사용량 표시 (Redis 카운터 read).
- 모든 토글/버튼은 `audit_logs` 행 생성 — 책임 추적.

## Sprint 4 — Rollback tool

### 4.1 신규 도구

`rollback_to_revision({ pageId, revisionId, reason, confidence })`:

- 재사용: [`packages/api/src/routes/v1/pages.ts:1418-1532`](../../packages/api/src/routes/v1/pages.ts#L1418) 의 rollback handler 본체를 [`packages/api/src/lib/rollback-revision.ts`](../../packages/api/src/lib/rollback-revision.ts) (신규) 로 추출 → API route 와 agent tool 양쪽에서 호출.
- 동작: target revision 의 `contentMd` + `contentJson` 으로 새 revision stack (`source: "rollback"`), `pages.currentRevisionId` 갱신, [`revision_diffs`](../../packages/db/src/schema/revisions.ts) 생성.
- agent tool 은 `ingestion_decisions` 행 1개 생성 (`action='update'`, tool name `rollback_to_revision` — 사용자 결정에 따라 INGESTION_ACTIONS enum 미확장, `update` 로 분류).
- `seenPageIds` 검증: 본 run 에서 read 한 페이지만 롤백 허용 → UUID hallucination 방어.
- `pageRevisions.id === revisionId AND pageRevisions.pageId === pageId` 동일 워크스페이스 검증 → cross-workspace 롤백 거부.

### 4.2 보조 read 도구는 S3 로 위임

Plan 에이전트가 자기 history 를 보려면 `read_revision_history` / `read_revision` 이 필요하지만, 본 sprint 에서는 **S3 와 분리** — autonomy 운영을 시작하기 전 rollback 자체는 plan turn 의 system prompt 가이드 + 외부 reason (예: 사용자 피드백) 으로 발동 가능. 정밀한 자기 관찰은 S3 와 결합.

### 4.3 코드 변경

- [`packages/api/src/lib/rollback-revision.ts`](../../packages/api/src/lib/rollback-revision.ts) (신규) — `rollbackToRevision({ db, workspaceId, pageId, revisionId, actorUserId, actorType, source, revisionNote })` async 함수. 트랜잭션 내부에서 검증/insert/audit. 기존 PATCH 핸들러는 이 함수를 호출하도록 리팩터.
- [`packages/api/src/routes/v1/pages.ts:1418`](../../packages/api/src/routes/v1/pages.ts#L1418) — 인라인 로직을 `rollbackToRevision()` 호출로 교체. 동작 동일.
- [`packages/shared/src/schemas/agent.ts`](../../packages/shared/src/schemas/agent.ts) — `agentMutateToolInputSchemas.rollback_to_revision` Zod 스키마 추가, `AgentMutateToolName` 유니온 확장.
- [`packages/worker/src/lib/agent/tools/mutate.ts:1321`](../../packages/worker/src/lib/agent/tools/mutate.ts#L1321) — `rollback_to_revision` 핸들러 + tool entry. `actorType: "ai"`, `source: "rollback"`.
- [`packages/worker/src/lib/agent/loop.ts:50,59`](../../packages/worker/src/lib/agent/loop.ts#L50) `EXPLORE_SYSTEM_PROMPT` / `PLAN_SYSTEM_PROMPT` 에 `rollback_to_revision` 사용 가이드라인 한 단락 추가 — "use only when self-correcting a recent autonomous mistake; never roll back human-authored revisions."
- [`packages/worker/src/lib/agent/loop.ts`](../../packages/worker/src/lib/agent/loop.ts) `ACTION_TO_TOOL` map: rollback 은 `update` action 으로 분류.

### 4.4 안전성 invariant

- 본 run 의 `seenPageIds` 에 없는 pageId 거부.
- target revision 이 인간 작성 (`actorType === 'user'`) 이면서 그 revision 이 현재 head 의 직전이면 거부 → "사람의 최근 작업을 자율 롤백" 케이스 차단.
- `autonomous_shadow` 모드에서는 rollback 도 `suggested` 로 — dry-run 일관성.
- destructive cap 에 rollback 은 카운트하지 않음 (의도적 — undo 는 안전망).

## Verification

### Sprint 1

- 단위: [`packages/shared/src/lib/decision-classifier.test.ts`](../../packages/shared/src/lib/decision-classifier.test.ts) (신규/확장) — autonomous 분기, action 우선순위 보존.
- 단위: [`packages/worker/src/lib/agent/tools/mutate.test.ts`](../../packages/worker/src/lib/agent/tools/mutate.test.ts) — autonomous 모드에서 destructive tool 노출, per-run cap 초과 거부.
- 단위: [`packages/api/src/lib/agent-parity-gate.test.ts`](../../packages/api/src/lib/agent-parity-gate.test.ts) — `autonomous` 승격이 parity gate 미통과 시 거부.
- 통합: [`tests/integration/pipeline.smoke.test.ts`](../../tests/integration/pipeline.smoke.test.ts) — autonomous 모드 시나리오: confidence 0.5 update 가 `auto_applied`, audit row 확인.
- 통합: human-conflict 시나리오 → autonomous 적용 + `autonomous_overrode_human_conflict` audit 기록.
- 통합: kill switch — `autonomy_paused_until` set 후 다음 run 즉시 abort.
- E2E: AISettingsPage Autonomy 섹션 수동 토글 → DB 컬럼 갱신 확인.

### Sprint 4

- 단위: `rollback-revision.test.ts` (신규) — happy path, cross-workspace 거부, 인간 직전 revision 거부.
- 단위: agent tool — seenPageIds 미관측 거부, 적용 후 새 revision lineage 확인.
- 통합: autonomous 시나리오 — (a) 잘못 적용된 update revision → (b) 후속 run 에서 `rollback_to_revision` 자율 호출 → 페이지가 (a) 직전 상태로 복원, audit_logs 에 `source='rollback'` revision 행.

## Out of scope

- `autonomous` 모드에서 rollback 을 *강제* 트리거하는 스케줄러 (사용자 피드백 → 자동 rollback) — v3.
- multi-page 트랜잭션 rollback ("이 ingestion 으로 만든 모든 변경 되돌리기") — v3.
- Triple-level rollback — 현재 page revision 변경 시 triple-extractor 가 자동 재실행되므로 불필요.

## Critical files

신규:
- [`packages/db/src/migrations/0020_agent_autonomy.sql`](../../packages/db/src/migrations/0020_agent_autonomy.sql)
- [`packages/api/src/lib/rollback-revision.ts`](../../packages/api/src/lib/rollback-revision.ts)
- [`docs/v2/agent-autonomy-step-1-mode-flag.md`](agent-autonomy-step-1-mode-flag.md) (sub-doc)
- [`docs/v2/agent-autonomy-step-4-rollback.md`](agent-autonomy-step-4-rollback.md) (sub-doc)

수정:
- [`packages/shared/src/lib/decision-classifier.ts`](../../packages/shared/src/lib/decision-classifier.ts)
- [`packages/shared/src/schemas/agent.ts`](../../packages/shared/src/schemas/agent.ts)
- [`packages/db/src/schema/users.ts`](../../packages/db/src/schema/users.ts)
- [`packages/worker/src/lib/agent/tools/mutate.ts`](../../packages/worker/src/lib/agent/tools/mutate.ts)
- [`packages/worker/src/lib/agent/loop.ts`](../../packages/worker/src/lib/agent/loop.ts)
- [`packages/worker/src/lib/agent/dispatcher.ts`](../../packages/worker/src/lib/agent/dispatcher.ts)
- [`packages/worker/src/workers/patch-generator.ts`](../../packages/worker/src/workers/patch-generator.ts)
- [`packages/api/src/routes/v1/pages.ts`](../../packages/api/src/routes/v1/pages.ts)
- [`packages/api/src/routes/v1/ai-settings.ts`](../../packages/api/src/routes/v1/ai-settings.ts)
- [`packages/web/src/pages/AISettingsPage.tsx`](../../packages/web/src/pages/AISettingsPage.tsx)
