# Sub-doc · S5 — Multi-turn replan loop (interface decisions)

> **Status**: 초안 (2026-05-04) · 미착수 (S1~S4 머지 후 진입)
> **Scope**: AUTO-5 — turn-bounded plan/execute 반복 (subagent fork 없음)
> **Parent RFC**: [`agent-loop-strengthening-plan.md`](agent-loop-strengthening-plan.md)

## 1. Constants & limits

[`packages/shared/src/constants/index.ts`](../../packages/shared/src/constants/index.ts) `AGENT_LIMITS`:

```typescript
export const AGENT_LIMITS = {
  // 기존 (의미 변경 없음 — backward-compat)
  MAX_STEPS: 15,
  MAX_CALLS_PER_TURN: 5,
  MAX_MUTATIONS: 20,                  // 의미: per-turn (이전과 동일하나 명확화)
  TIMEOUT_MS: 180_000,                // 60s → 3분
  INPUT_TOKEN_BUDGET: 800_000,
  OUTPUT_TOKEN_BUDGET: 60_000,
  WORKSPACE_DAILY_TOKEN_CAP: 5_000_000,

  // 신규 (S5)
  MAX_MUTATIONS_PER_TURN: 20,         // === MAX_MUTATIONS, alias 명확화
  MAX_TURNS: 5,
  MAX_TOTAL_MUTATIONS: 100,
  TURN_REMAINING_TIME_THRESHOLD_MS: 30_000,  // 다음 turn 진입 전 잔여 시간 ≥ 30s 필수
} as const;
```

환경변수 override: `AGENT_MAX_TURNS`, `AGENT_MAX_TOTAL_MUTATIONS`, `AGENT_TURN_REMAINING_TIME_THRESHOLD_MS`.

`TIMEOUT_MS` 60s → 180s 변경은 **breaking-ish**. 기존 supervised mode 도 영향. step 진입 시 운영 영향 검토 후 별도 env 로 split 가능 (예: `AGENT_TIMEOUT_MS_AUTONOMOUS=180000`).

## 2. Loop structure

[`packages/worker/src/lib/agent/loop.ts`](../../packages/worker/src/lib/agent/loop.ts) 의 `runIngestionAgentShadow` 를 다음 구조로:

```typescript
async function runIngestionAgentShadow(input) {
  // ... existing setup (model selection, dispatcher, explore phase) ...

  let totalMutationsApplied = 0;
  const allTurns: TurnRecord[] = [];

  for (let turnIndex = 0; turnIndex < limits.maxTurns; turnIndex++) {
    // Pre-turn abort checks
    if (await checkAbortConditions(input, totals, totalMutationsApplied, deadlineMs)) {
      // mark status='aborted' or 'partial', break
      break;
    }

    // Plan turn (initial vs replan)
    const systemPrompt = turnIndex === 0
      ? withWorkspaceInstructions(PLAN_SYSTEM_PROMPT, mergedInstructions)
      : withWorkspaceInstructions(REPLAN_SYSTEM_PROMPT, mergedInstructions);

    const planContext = packPlanContextForTurn({
      ...packed,
      priorTurns: allTurns,           // turn-별 plan + outcome 요약
      turnIndex,
    });

    const planRequest = { ... };
    const planResponse = await chatBeforeDeadline(...);
    const parsed = parsePlan(planResponse.content);

    traceStep(input, steps, turnIndex === 0 ? "plan" : "replan", { turnIndex, ... });

    if (parsed.plan.proposedPlan.length === 0) {
      // agent finished
      break;
    }

    // Execute (sequential, ≤ MAX_MUTATIONS_PER_TURN)
    const remainingTotal = limits.maxTotalMutations - totalMutationsApplied;
    const turnCap = Math.min(limits.maxMutationsPerTurn, remainingTotal);
    const truncated = parsed.plan.proposedPlan.slice(0, turnCap);

    const execution = await executeMutations({
      ...
      plan: { ...parsed.plan, proposedPlan: truncated },
      ...
    });

    totalMutationsApplied += execution.succeeded;

    // Invalidate read cache for mutated pages → next turn read_page sees fresh content
    for (const pageId of dispatcher.state.mutatedPageIds) {
      dispatcher.invalidateReadCacheForPage(pageId);
    }

    allTurns.push({
      turnIndex,
      plan: parsed.plan,
      execution,
      mutatedPageIds: [...dispatcher.state.mutatedPageIds],
    });

    // Check if hit total cap
    if (totalMutationsApplied >= limits.maxTotalMutations) break;
  }

  // Determine final status: completed | partial | aborted
  // ...
  return { status, planJson: lastPlan, steps, decisionsCount: totalMutationsApplied, ... };
}
```

## 3. REPLAN_SYSTEM_PROMPT

```typescript
const REPLAN_SYSTEM_PROMPT = `You are continuing a multi-turn wiki maintenance plan for WekiFlow.
You previously planned and executed mutations on this run. Below is the original ingestion, your prior plan(s), the per-mutation outcomes, and the pages you mutated.

Propose remaining plan items if more work is needed, or return an empty proposedPlan to finish the run.

Rules:
- Do NOT re-propose mutations that already succeeded.
- If a previous mutation failed, propose a corrected version (or skip if not safe).
- Use the same tool-call contract as the initial plan turn.
- Re-read mutated pages via read_page if you need to verify your own changes — caches are invalidated for those pages.
- Empty proposedPlan = "I'm done." Do not pad.

Return only JSON with this exact shape:
{
  "summary": "short explanation of what remains",
  "proposedPlan": [...same shape as plan turn],
  "openQuestions": []
}`;
```

## 4. packPlanContextForTurn

신규 helper in [`packages/worker/src/lib/agent/budgeter.ts`](../../packages/worker/src/lib/agent/budgeter.ts):

```typescript
export interface TurnRecord {
  turnIndex: number;
  plan: IngestionAgentPlan;
  execution: { succeeded: number; failed: number };
  mutatedPageIds: string[];
}

export function packPlanContextForTurn(input: {
  // ... 기존 packAgentPlanContext input ...
  priorTurns: TurnRecord[];
  turnIndex: number;
}): PackedAgentContext {
  if (input.turnIndex === 0) return packAgentPlanContext(input);

  // priorTurns 를 압축 형태로 user message 에 추가
  const priorTurnsBlock: AgentContextBlock = {
    key: "prior_turns",
    label: "Prior turns",
    text: JSON.stringify(
      input.priorTurns.map(t => ({
        turn: t.turnIndex,
        summary: t.plan.summary,
        proposedCount: t.plan.proposedPlan.length,
        succeeded: t.execution.succeeded,
        failed: t.execution.failed,
        mutatedPageIds: t.mutatedPageIds,
        proposedActions: t.plan.proposedPlan.map(m => ({
          action: m.action,
          tool: m.tool,
          targetPageId: m.targetPageId,
        })),
      })),
      null,
      2,
    ),
    minTokens: 1_000,
    weight: 5,
  };

  return packAgentPlanContext({
    ...input,
    blocks: [...input.blocks, priorTurnsBlock],
  });
}
```

priorTurns 상세 mutation 본문 (newContentMd 등) 은 포함하지 않음 — 토큰 폭발 방지. agent 가 본문 필요시 read_page 로 fresh 데이터 재요청.

## 5. dispatcher.invalidateReadCacheForPage

[`packages/worker/src/lib/agent/dispatcher.ts`](../../packages/worker/src/lib/agent/dispatcher.ts) 신규 메서드:

```typescript
invalidateReadCacheForPage(pageId: string): void {
  // 캐시 키는 `${toolName}:${stableJson(args)}` (현재 dispatcher.ts 의 stableJson)
  // pageId 가 args 에 있는 항목 모두 제거
  for (const key of this.cache.keys()) {
    if (key.includes(`"pageId":"${pageId}"`)) {
      this.cache.delete(key);
    }
  }
}
```

`seenPageIds` 는 보존 — 이미 한 번 읽었다는 사실은 valid 하므로 후속 mutate tool 의 검증을 통과시킴.

기존 `invalidateCacheForToolCall(toolCall)` 는 그대로 유지.

## 6. Trace step types

[`packages/shared/src/schemas/agent.ts`](../../packages/shared/src/schemas/agent.ts) `AgentRunTraceStep` discriminated union 확장:

```typescript
type AgentRunTraceStep =
  | { type: "model_selection"; ... }
  | { type: "ai_response"; ... }
  | { type: "context_compaction"; ... }
  | { type: "tool_result"; ... }
  | { type: "plan"; ... }
  | { type: "replan"; turnIndex: number; payload: ... }       // 신규
  | { type: "mutation_result"; ... }
  | { type: "shadow_execute_skipped"; ... }
  | { type: "turn_aborted"; reason: string; turnIndex: number; payload: ... }  // 신규
  | { type: "error"; ... };
```

## 7. Final status determination

`agent_runs.status` 의 가능한 값:
- `running` — 진행 중
- `completed` — 정상 종료 (proposedPlan empty 로 끝남)
- `partial` — `MAX_TOTAL_MUTATIONS` 또는 `MAX_TURNS` 도달로 끝남, 일부 mutation 적용됨 — **신규**
- `aborted` — kill switch / token cap / wall-clock — **신규**
- `failed` — exception
- `timeout` — 기존
- `paused` — kill switch active when entering — **S1 에서 도입**
- `shadow` — shadow mode 종료

[`packages/db/src/schema/agent-runs.ts`](../../packages/db/src/schema/agent-runs.ts) check constraint 확장 필요. 신규 마이그레이션 `0021_agent_run_status_extend.sql`:

```sql
ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_status_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('running','completed','failed','timeout','shadow','partial','aborted','paused'));
```

`AGENT_RUN_STATUSES` 상수 ([`packages/shared/src/constants/index.ts`](../../packages/shared/src/constants/index.ts)) 확장.

## 8. Trace UI updates

[`packages/web/src/components/agents/AgentTracePanel.tsx`](../../packages/web/src/components/agents/AgentTracePanel.tsx):

- step 들을 `turnIndex` 별로 그룹핑. turnIndex 가 명시되지 않은 step (model_selection, explore tool_result 등) 은 turn 0 으로 묶거나 별도 "Setup" 그룹.
- 각 turn 헤더: "Turn N — N mutations proposed, M applied".
- replan step 은 plan step 과 시각적으로 구분 (다른 색).
- 최종 status 에 `partial` / `aborted` 시 명시적 배지.

## 9. Discovered code constraints

- 기존 `executeMutations` ([`loop.ts:693`](../../packages/worker/src/lib/agent/loop.ts#L693)) 는 dispatcher 의 `state` 를 in-place 수정. multi-turn 에서 `state` 가 turn 사이 carryover — destructiveCount, seenPageIds 등이 누적된다. 의도된 동작.
- `agent_runs.plan_json` 컬럼은 단일 plan 상정 — multi-turn 에서 어떻게 저장? **결정**: 마지막 turn 의 plan 만 저장, 모든 turn 의 plan 은 `steps_json` 에 누적 (현재도 plan step 이 거기 들어감).
- `MAX_TIMEOUT_MS` 를 60s → 180s 로 늘리면 BullMQ job timeout 도 그에 맞춰 조정 필요. queue 설정 확인.

## 10. Reuse candidates

| 용도 | 함수/파일 |
|---|---|
| Plan / execute / repair turn 본체 | 기존 `loop.ts` 의 plan/execute 부분 → `runPlanExecuteTurn` 으로 추출 |
| Context packing | [`packAgentPlanContext`](../../packages/worker/src/lib/agent/budgeter.ts) (확장) |
| Cache invalidation | 기존 `invalidateCacheForToolCall` 패턴 — pageId 기반 helper 추가 |
| Token reservation | 기존 `reserveWorkspaceTokensForRequest` ([loop.ts:949](../../packages/worker/src/lib/agent/loop.ts#L949)) — 그대로 사용 |

## 11. Test fixtures

- [`packages/worker/src/lib/agent/loop.test.ts`](../../packages/worker/src/lib/agent/loop.test.ts) 확장:
  - 30 mutation 시나리오 → turn 0 (20개) + turn 1 (10개) = total 30
  - empty proposedPlan 시 즉시 종료 (turn 1 에서 멈춤)
  - `MAX_TURNS` 도달 시 `partial` status
  - `MAX_TOTAL_MUTATIONS` 도달 시 `partial` status
  - kill switch (autonomy_paused_until set) 시 `aborted` status
  - token cap 초과 시 `aborted` status
- 통합: [`tests/integration/pipeline.smoke.test.ts`](../../tests/integration/pipeline.smoke.test.ts) — multi-turn shadow 시나리오, `agent_runs.steps_json` 에 turn-별 plan + mutation_result.
- 통합: autonomous + reorganize 50페이지 (S2 + S5 결합).

## 12. Verification checklist

- [ ] AGENT_LIMITS 상수 확장 + 환경변수 override 동작
- [ ] AgentRunTraceStep 신규 타입 (`replan`, `turn_aborted`) Zod 검증
- [ ] agent_runs.status check constraint 확장 마이그레이션 정·역방향
- [ ] runIngestionAgentShadow 가 multi-turn 으로 동작 — 기존 single-turn 회귀 무영향
- [ ] cache invalidation — turn 사이 mutated page 가 새로 read 되면 fresh content
- [ ] turn 사이 seenPageIds carryover
- [ ] empty proposedPlan 시 즉시 종료
- [ ] kill switch 매 turn 진입 시 재확인
- [ ] AgentTracePanel 의 turn 그룹핑 UI 정상
- [ ] BullMQ job timeout 조정 (180s) 적용

## 13. Open questions

- `MAX_TIMEOUT_MS` 를 supervised 와 autonomous 모드에 분리할지 — supervised 는 60s 유지, autonomous 만 180s.
- `partial` 결과를 ingestion-level 에서 어떻게 표현 — 사용자가 `/review` 에서 보는 결정 row 들에 turn 정보 노출?
- `replan` 의 system prompt 가 너무 길어지면 plan turn 자체 비용 증가 — prior turns 요약을 더 압축할지.
- subagent 진입 결정 metric 수집 자동화 — `agent_runs` 테이블에 `turn_count`, `final_status` 컬럼 추가? 또는 SQL view 로 충분?
