# Sub-doc · S1 — Autonomy mode flag (interface decisions)

> **Status**: 초안 (2026-05-04) · 미착수
> **Scope**: AUTO-1 — workspace-level autonomy mode + safety nets
> **Parent RFC**: [`agent-autonomy-plan.md`](agent-autonomy-plan.md)

본 sub-doc 은 S1 진입 시 **인터페이스 결정 / 발견된 코드 제약 / 재사용 후보 / 테스트 fixture / verification** 만 담는다. 본 RFC 본문 복붙 금지.

## 1. Interface decisions

### 1.1 `classifyDecisionStatus` 시그니처

**결정**: 3rd argument 를 옵션 객체로. 위치 인자가 아닌 named option 이라 후속 확장 (예: `forceManual`) 가능.

```typescript
// packages/shared/src/lib/decision-classifier.ts
export interface ClassifyDecisionStatusOptions {
  autonomous?: boolean;
}

export function classifyDecisionStatus(
  action: IngestionAction,
  confidence: number,
  options?: ClassifyDecisionStatusOptions,
): DecisionStatus {
  if (action === "noop") return "noop";
  if (action === "needs_review") return "needs_review";
  if (options?.autonomous) return "auto_applied";
  if (confidence >= CONFIDENCE.AUTO_APPLY) return "auto_applied";
  if (confidence >= CONFIDENCE.SUGGESTION_MIN) return "suggested";
  return "needs_review";
}
```

**불변량**: action 우선순위 (noop / needs_review) 는 autonomous 보다 강함. agent 가 명시적으로 noop / needs_review 라고 말하면 그대로 따른다.

### 1.2 `autonomyMode` 전파 경로

```
PATCH /workspaces/:id/autonomy
  → workspaces.autonomy_mode column update
                        ↓
enqueueIngestion (read column from workspace row)
                        ↓
ingestion-agent BullMQ job data: { ..., autonomyMode }
                        ↓
runIngestionAgentShadow input: { ..., autonomousMode }
                        ↓
createMutateTools input: { ..., autonomousMode }
                        ↓
each mutate handler: classifyDecisionStatus(action, conf, { autonomous: autonomousMode === "autonomous" })
```

**`autonomous_shadow` 처리**: classifier 에는 `autonomous: false` 전달 (정상 분류), 단 mutate 핸들러가 결정 status 를 `suggested` 로 강제 (분류는 보았으나 적용은 사람 승인). 즉 shadow 는 agent 결정을 *한 번 더* 다운그레이드하는 layer. 코드 위치: 각 mutate 핸들러의 status 결정 직후 (`if (input.autonomousMode === "autonomous_shadow") status = "suggested";`).

### 1.3 Kill switch read path

worker hot path 에서 100ms 이내 read 필요. **결정**: 해당 워크스페이스의 ingestion BullMQ job 진입 시점에 1회 SELECT (다른 컬럼들과 함께 묶어서 1 round-trip).

```typescript
// packages/worker/src/workers/ingestion-agent.ts (또는 enqueue 시점)
const ws = await db.select({
  ingestionMode: workspaces.ingestionMode,
  autonomyMode: workspaces.autonomyMode,
  autonomyPausedUntil: workspaces.autonomyPausedUntil,
  agentInstructions: workspaces.agentInstructions,
  // ...
}).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);

if (ws.autonomyPausedUntil && ws.autonomyPausedUntil > new Date()) {
  await markAgentRun(agentRunId, "paused", { until: ws.autonomyPausedUntil });
  return;
}
```

`runIngestionAgentShadow` 내부에서는 **턴마다 재확인하지 않음** (S5 의 multi-turn 진입 시 추가 결정). S1 단계에서는 job 진입 시 1회만 충분.

### 1.4 Destructive throttle 구현

**Per-run cap**: dispatcher state 에서 메모리 카운터.

```typescript
// packages/worker/src/lib/agent/types.ts
export interface AgentRunState {
  seenPageIds: Set<string>;
  seenBlockIds: Set<string>;
  // ... 기존 필드
  destructiveCount: number;  // 신규
}
```

mutate.ts 의 `deletePage` / `mergePages` 진입 시 `state.destructiveCount += 1`, `input.autonomyMaxDestructivePerRun` 와 비교. 초과 시 `AgentToolError("destructive_limit_exceeded", { hint: "Already used N destructive ops this run; limit is M." })` recoverable error.

**Per-day cap**: Redis fixed-window. [`packages/api/src/lib/rate-limit.ts`](../../packages/api/src/lib/rate-limit.ts) `consumeRateLimit` 패턴 그대로:

```typescript
const key = `autonomy:destructive:${workspaceId}:${todayUTCDate}`;
const result = await consumeRateLimit({
  redis,
  key,
  limit: workspace.autonomyMaxDestructivePerDay,
  windowSeconds: 86400,
});
if (!result.allowed) {
  throw new AgentToolError("destructive_daily_limit_exceeded", {
    hint: `Workspace daily destructive cap (${workspace.autonomyMaxDestructivePerDay}) reached. Resets at ${result.resetAt}.`,
  });
}
```

Rollback 은 destructive 카운트에 포함하지 않음 — undo 는 안전망.

### 1.5 Parity gate 통합

**결정**: `autonomous` 승격은 `evaluateAgentParityGate()` 통과 필수, `autonomous_shadow` 는 게이트 무관하게 즉시 가능.

API `PATCH /workspaces/:id/autonomy`:

```typescript
if (body.autonomyMode === "autonomous") {
  const gate = await evaluateAgentParityGate({ db, workspaceId });
  if (!gate.canPromote) {
    return reply.code(409).send({
      error: "Parity gate not passed",
      code: "AUTONOMY_PARITY_BLOCKED",
      details: gate,
    });
  }
}
```

`autonomous_shadow` → `autonomous` 직접 전환은 허용 (게이트 통과 시). `autonomous` → `supervised` 또는 `autonomous_shadow` 다운그레이드는 자유.

## 2. Discovered code constraints

- [`packages/db/src/schema/users.ts`](../../packages/db/src/schema/users.ts) 의 `workspaces` 테이블에 이미 `agentParityMin*` 컬럼이 5개 — autonomy 컬럼은 그 다음에 인접 배치하면 grouping 자연스러움.
- [`packages/api/src/lib/agent-parity-gate.ts:164`](../../packages/api/src/lib/agent-parity-gate.ts#L164) `evaluateAgentParityGate()` 가 이미 `agent_vs_classic_agreement_rate` view 를 query 함 — autonomy 진입 조건으로 그대로 재사용.
- [`packages/worker/src/lib/agent/loop.ts:1010`](../../packages/worker/src/lib/agent/loop.ts#L1010) `RunIngestionAgentShadowInput` 가 이미 `scheduledAutoApply` / `allowDestructiveScheduledAgent` 두 개의 옵셔널 옵션을 받음 — `autonomousMode` 도 같은 패턴으로 추가.
- patch-generator 의 `detectHumanConflict` 다운그레이드 분기는 [`packages/worker/src/workers/patch-generator.ts`](../../packages/worker/src/workers/patch-generator.ts) 안에 있고 audit_logs 를 직접 쓰지 않고 `rationaleJson.conflict` 만 채움 — autonomous 우회 시 별도 `audit_logs.action='autonomous_overrode_human_conflict'` 행을 명시적으로 insert 해야 함.

## 3. Reuse candidates

| 용도 | 함수/파일 |
|---|---|
| Rate limiter | [`consumeRateLimit`](../../packages/api/src/lib/rate-limit.ts) |
| Parity gate | [`evaluateAgentParityGate`](../../packages/api/src/lib/agent-parity-gate.ts#L164) |
| Audit log insert 패턴 | [`packages/api/src/lib/apply-decision.ts`](../../packages/api/src/lib/apply-decision.ts) `auditLogs` insert 들 |
| Decision status 분류 | [`classifyDecisionStatus`](../../packages/shared/src/lib/decision-classifier.ts) (확장 대상) |

## 4. Test fixtures

- 신규 `packages/shared/src/lib/decision-classifier.test.ts` — autonomous 분기 + action 우선순위 케이스.
- [`packages/worker/src/lib/agent/tools/mutate.test.ts`](../../packages/worker/src/lib/agent/tools/mutate.test.ts) 확장 — autonomous 모드에서 destructive 노출, per-run cap 거부, per-day cap 거부.
- [`packages/api/src/lib/agent-parity-gate.test.ts`](../../packages/api/src/lib/agent-parity-gate.test.ts) 확장 — autonomous 승격 차단 케이스.
- [`tests/integration/pipeline.smoke.test.ts`](../../tests/integration/pipeline.smoke.test.ts) 확장 — confidence 0.5 update → autonomous 모드에서 auto_applied, autonomous_shadow 모드에서 suggested.

## 5. Verification checklist

- [x] migration `0020_agent_autonomy.sql` 정방향/역방향 동작
- [x] Drizzle schema 와 SQL migration 컬럼명/타입 일치
- [x] `classifyDecisionStatus` 단위 테스트 (action 우선순위 보존 포함)
- [x] `mutate.ts` autonomous 모드 destructive 노출 + per-run cap
- [x] Per-day Redis 카운터 — 정확한 reset 시각, fail-open (Redis 다운 시) 동작
- [x] `PATCH /workspaces/:id/autonomy` — parity gate 미통과 시 409
- [x] Kill switch — `autonomy_paused_until > now()` 면 ingestion-agent worker 진입 즉시 abort
- [x] AISettingsPage — 토글 / kill switch / destructive 사용량 모두 동작
- [x] human-conflict + autonomous → patch 적용 + `audit_logs.action='autonomous_overrode_human_conflict'` 행
- [x] autonomous_shadow + confidence 0.95 update → 결정 status `suggested` (shadow downgrade)

## 6. Open questions

- `autonomy_paused_until` 기본 일시정지 길이 (24h 권장 vs 무기한 — 무기한은 기억 못 하면 위험).
- per-day cap 의 windowing — 워크스페이스 timezone vs UTC. step 진입 시 결정.
- `autonomous_shadow` 운영 권장 기간 — 1주 default, AISettingsPage 에 안내.
