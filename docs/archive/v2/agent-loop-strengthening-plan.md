# Agent Loop Strengthening — Umbrella RFC (S5)

> **상태**: 진행 중 (2026-05-05) · S5 multi-turn replan 구현/검증 중
> **유형**: 구현 RFC
> **모티브**: 대규모 reorganize / 100+ 페이지 ingestion 에서 단일-turn plan + 20-mutation 캡 한계를 multi-turn replan 으로 푼다 — subagent fork 는 별도 후속 RFC

본 RFC 는 docs/v2/ 묶음의 **세 번째 우산** — 기존 explore→plan→execute 루프를 multi-turn replan 으로 확장. **Subagent / Orchestrator 는 본 RFC 외 — [`spawn-subagent-rfc.md`](spawn-subagent-rfc.md) placeholder.**

## Context

기존 [`packages/worker/src/lib/agent/loop.ts`](../../packages/worker/src/lib/agent/loop.ts) 는 explore (max 15 step) → plan (single turn) → execute (sequential, max 20 mutations) 의 단일-pass 구조다. 이 구조의 한계:

1. **`MAX_MUTATIONS=20` 의 단단한 캡** ([`packages/shared/src/constants/index.ts`](../../packages/shared/src/constants/index.ts) `AGENT_LIMITS`) — 50페이지 reorganize 같은 시나리오에서 절반에서 멈춤.
2. **Plan 이 단일-turn** ([`loop.ts:1280-1315`](../../packages/worker/src/lib/agent/loop.ts#L1280)) — 첫 mutation 의 결과를 보고 후속 결정을 다시 내릴 수 없음. agent 의 자기 변경을 후속 read 에서 보지 못한 채 종료.
3. **Repair turn 은 per-mutation, 1회** ([`loop.ts:1422-1531`](../../packages/worker/src/lib/agent/loop.ts#L1422)) — 한 mutation 의 자체 오류 복구만 가능, 전체 plan 의 재구성 불가.

목표: **plan turn 을 turn-bounded 로 반복** — 각 turn 이 `MAX_MUTATIONS_PER_TURN=20` 까지 제안하고 실행, 다음 turn 진입 전 mutated 페이지 cache invalidation, `MAX_TURNS=5` 또는 propose 가 비면 종료. Subagent fork 없이도 **누적 100 mutation** 까지 확장.

## Sprint 5 — Multi-turn replan

### 5.1 한계 상수 확장

[`packages/shared/src/constants/index.ts`](../../packages/shared/src/constants/index.ts) `AGENT_LIMITS`:

```typescript
// 기존
MAX_STEPS: 15,
MAX_CALLS_PER_TURN: 5,
MAX_MUTATIONS: 20,
TIMEOUT_MS: 60_000,
INPUT_TOKEN_BUDGET: 800_000,
OUTPUT_TOKEN_BUDGET: 60_000,
WORKSPACE_DAILY_TOKEN_CAP: 5_000_000,

// 추가 (S5)
MAX_MUTATIONS_PER_TURN: 20,    // 한 plan turn 당
MAX_TURNS: 5,                  // 최대 plan 반복
MAX_TOTAL_MUTATIONS: 100,      // 누적 mutation 상한 (안전망)
TIMEOUT_MS: 180_000,           // 60s → 3분 (multi-turn 위해)
```

기존 `MAX_MUTATIONS` 는 backward-compat 위해 유지 (의미: per-turn). 환경변수 override 동일 패턴 (`AGENT_MAX_MUTATIONS_PER_TURN` 등).

### 5.2 루프 구조 변경

[`packages/worker/src/lib/agent/loop.ts:1010`](../../packages/worker/src/lib/agent/loop.ts#L1010) `runIngestionAgentShadow`:

```
기존:
  explore loop (≤ MAX_STEPS)
    → plan turn (single)
    → execute (sequential, ≤ MAX_MUTATIONS)
    → end

신규:
  explore loop (≤ MAX_STEPS)
    → for turn in 1..MAX_TURNS:
        → plan turn (system prompt: PLAN_SYSTEM_PROMPT or REPLAN_SYSTEM_PROMPT)
        → if proposedPlan.length === 0: break (agent finished)
        → execute (sequential, ≤ MAX_MUTATIONS_PER_TURN)
        → invalidate cache for mutated pageIds
        → check abort conditions:
            - remaining wall-clock < threshold
            - totalMutationsApplied >= MAX_TOTAL_MUTATIONS
            - autonomy_paused_until > now() (S1 kill switch)
            - workspace daily token cap exceeded
    → end (status: completed / partial / aborted)
```

**Replan turn 의 system prompt (`REPLAN_SYSTEM_PROMPT`)** — 신규 상수:

> "You are continuing a multi-turn wiki maintenance plan. You previously planned and executed [N] mutations on this run.
> Below is the original ingestion, your prior plan, the execution outcomes (success/fail per item), and the pages you mutated.
> Propose remaining plan items if more work is needed, or return an empty `proposedPlan` to finish the run.
> Use the same tool-call contract as the initial plan turn. Do not re-propose mutations that already succeeded."

### 5.3 데이터 모델 변경 (최소)

[`packages/db/src/schema/agent-runs.ts`](../../packages/db/src/schema/agent-runs.ts) `agent_runs.steps_json` 의 `AgentRunTraceStep` 유니온에 `"replan"` 타입 추가.

`agent_runs` 테이블 자체는 변경 없음 — `plan_json` 은 마지막 turn 의 plan 만 저장 (또는 모든 turn 의 plan 을 array 로 저장 — step-doc 에서 결정). steps_json 에는 turn 별 plan/mutation_result 가 순차 누적.

### 5.4 코드 변경

- [`packages/shared/src/constants/index.ts`](../../packages/shared/src/constants/index.ts) — `AGENT_LIMITS` 4개 신규 상수.
- [`packages/shared/src/schemas/agent.ts`](../../packages/shared/src/schemas/agent.ts) — `AgentRunTraceStep` discriminated union 에 `"replan"` 추가, `IngestionAgentPlan` 에 선택 `turnIndex?: number` 필드.
- [`packages/worker/src/lib/agent/budgeter.ts`](../../packages/worker/src/lib/agent/budgeter.ts) — `readAgentRuntimeLimits()` 에 신규 상수 read.
- [`packages/worker/src/lib/agent/loop.ts`](../../packages/worker/src/lib/agent/loop.ts):
  - `runIngestionAgentShadow` 의 plan/execute 부분을 `runPlanExecuteTurn(turnIndex, prevState)` 로 추출.
  - `for turn in 1..MAX_TURNS` 외부 루프 추가.
  - `REPLAN_SYSTEM_PROMPT` 상수 추가. `turnIndex >= 1` 시 PLAN_SYSTEM_PROMPT 대신 사용.
  - 각 turn 의 plan request 에 prior turns 의 요약 (executed mutations + outcomes + mutated pageIds) 을 user message 로 추가. budgeter 가 이 요약 토큰을 회계.
  - turn 사이 mutated pageId 의 read_page 캐시 invalidate (`dispatcher.invalidateCacheForToolCall` 의 친구로 `dispatcher.invalidateReadCacheForPage(pageId)` 신규 helper 추가).
  - abort condition check 헬퍼 — `autonomy_paused_until` (S1 의존), token cap, total mutation cap.
- [`packages/worker/src/lib/agent/dispatcher.ts`](../../packages/worker/src/lib/agent/dispatcher.ts) — `invalidateReadCacheForPage(pageId: string)` 신규. seenPageIds 는 보존 (이미 read 한 페이지는 turn 사이 그대로 valid).
- [`packages/web/src/components/agents/AgentTracePanel.tsx`](../../packages/web/src/components/agents/AgentTracePanel.tsx) — turn 별 그룹핑 UI (turn 1: plan + N mutations / turn 2: replan + M mutations / ...).

### 5.5 안전성 invariant

- **kill switch 즉시 반응**: 매 turn 진입 시 `autonomy_paused_until` 재확인.
- **per-turn destructive cap + 누적 destructive cap**: S1 의 `autonomy_max_destructive_per_run` 은 누적 기준이라 multi-turn 에서도 그대로 유효. per-turn 캡은 별도 상수 불필요 (run 단위로 관리).
- **turn 간 deadline**: `AGENT_TIMEOUT_MS` 는 전체 run 기준. 각 turn 진입 시 잔여 시간 ≤ 30s 면 abort.
- **abort 시 status**: 정상 종료 = `completed`, mutation 적용했으나 cap 초과로 멈춤 = `partial` (신규 status — `agent_runs.status` enum 확장 검토), kill switch / token cap / wall-clock = `aborted`.
- **idempotence**: 같은 ingestion 재실행 시 idempotency key 가 보호 (기존 동작) — replan 은 한 ingestion 내부 메커니즘이라 무관.

### 5.6 검증

- 단위: [`packages/worker/src/lib/agent/loop.test.ts`](../../packages/worker/src/lib/agent/loop.test.ts) — 30 mutation 시나리오: 첫 turn 20개 적용 → 두 번째 turn 10개 적용 → 합산 일치.
- 단위: turn 사이 mutated page 의 cache invalidation, seenPageIds 보존, mutated 페이지를 다음 turn 에서 다시 read_page 호출 시 fresh content.
- 단위: empty `proposedPlan` 시 즉시 종료, `MAX_TURNS` 도달 시 `partial` status.
- 단위: turn 간 abort condition (token cap / kill switch / wall-clock) 케이스별 status 분기.
- 통합: [`tests/integration/pipeline.smoke.test.ts`](../../tests/integration/pipeline.smoke.test.ts) — shadow 모드에서 multi-turn 시나리오, `agent_runs.steps_json` 에 turn-별 plan + mutation_result 가 순서대로 기록.
- 통합: autonomous 모드 + reorganize 시나리오 (S2 + S5 결합) — 50 페이지를 새 폴더 트리로 이동, 3 turn 에 걸쳐 적용.

### 5.7 측정 후 결정 (subagent 진입 기준)

S5 머지 후 사내 워크스페이스에서 1주 자율 운영 데이터 수집:

- run 의 turn 분포 (1턴/2턴/3턴+ 비율)
- `MAX_TOTAL_MUTATIONS=100` 도달 비율
- `partial` status 비율
- 평균 token 사용량 vs 단일-turn 대비 증가율
- 사용자 피드백 — 자율 결과의 정확도

**Subagent 진입 기준 ([`docs/v2/spawn-subagent-rfc.md`](spawn-subagent-rfc.md) trigger)**:
- `partial` status 비율 > 20% AND `MAX_TOTAL_MUTATIONS` 도달이 빈번 → 진정한 fan-out 필요 (subagent)
- 또는 한 plan 의 prompt 가 800k 토큰을 넘기 시작 → 책임 분리 필요 (subagent)
- 그 외 케이스는 S5 만으로 충분, subagent RFC 진입 보류

## Out of scope

- **Subagent / Orchestrator** — [`spawn-subagent-rfc.md`](spawn-subagent-rfc.md). agent_runs.parent_agent_run_id, agent_subtasks 테이블, spawn_subtask tool, BullMQ child job, 트레이스 트리 UI 모두 본 RFC 외.
- **Cross-run 학습** (이전 run 의 plan 을 다음 run 이 참조) — v3.
- **Plan caching** (동일 ingestion 의 plan 을 다른 워크스페이스에 재사용) — v3.

## Critical files

수정:
- [`packages/shared/src/constants/index.ts`](../../packages/shared/src/constants/index.ts)
- [`packages/shared/src/schemas/agent.ts`](../../packages/shared/src/schemas/agent.ts)
- [`packages/worker/src/lib/agent/loop.ts`](../../packages/worker/src/lib/agent/loop.ts)
- [`packages/worker/src/lib/agent/dispatcher.ts`](../../packages/worker/src/lib/agent/dispatcher.ts)
- [`packages/worker/src/lib/agent/budgeter.ts`](../../packages/worker/src/lib/agent/budgeter.ts)
- [`packages/web/src/components/agents/AgentTracePanel.tsx`](../../packages/web/src/components/agents/AgentTracePanel.tsx)

신규:
- [`docs/v2/agent-loop-step-5-multi-turn-replan.md`](agent-loop-step-5-multi-turn-replan.md) (sub-doc)

테스트:
- [`packages/worker/src/lib/agent/loop.test.ts`](../../packages/worker/src/lib/agent/loop.test.ts) (확장)
- [`tests/integration/pipeline.smoke.test.ts`](../../tests/integration/pipeline.smoke.test.ts) (확장)
