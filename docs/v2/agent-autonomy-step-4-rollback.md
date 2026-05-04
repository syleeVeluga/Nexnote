# Sub-doc · S4 — Rollback tool (interface decisions)

> **Status**: 초안 (2026-05-04) · 미착수 (S1 머지 후 진입)
> **Scope**: AUTO-4 — `rollback_to_revision` agent tool
> **Parent RFC**: [`agent-autonomy-plan.md`](agent-autonomy-plan.md)

## 1. Interface decisions

### 1.1 Tool signature (Zod)

```typescript
// packages/shared/src/schemas/agent.ts
export const rollbackToRevisionToolInputSchema = z.object({
  pageId: z.string().uuid(),
  revisionId: z.string().uuid(),
  reason: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
});
export type RollbackToRevisionToolInput = z.infer<typeof rollbackToRevisionToolInputSchema>;
```

`AgentMutateToolName` 유니온에 `"rollback_to_revision"` 추가.

### 1.2 Library function

[`packages/api/src/lib/rollback-revision.ts`](../../packages/api/src/lib/rollback-revision.ts) 신규:

```typescript
export interface RollbackToRevisionInput {
  db: Database | TxInstance;
  workspaceId: string;
  pageId: string;
  revisionId: string;
  actorUserId: string | null;
  actorType: "user" | "ai" | "system";
  source: "rollback";
  revisionNote?: string | null;
  agentRunId?: string | null;
  modelRunId?: string | null;
  ingestionDecisionId?: string | null;
}

export async function rollbackToRevision(
  input: RollbackToRevisionInput,
): Promise<{
  newRevisionId: string;
  pageId: string;
  baseRevisionId: string;       // = input.revisionId (rollback target)
  previousHeadRevisionId: string; // 이전 currentRevisionId (= 롤백 직전 head)
}>;
```

기존 [`packages/api/src/routes/v1/pages.ts:1418-1532`](../../packages/api/src/routes/v1/pages.ts#L1418) PATCH 의 본체를 이 함수로 추출 → API route 와 agent tool 양쪽에서 호출. 동작 동일.

### 1.3 Agent tool wrapper

```typescript
// packages/worker/src/lib/agent/tools/mutate.ts
async function rollbackTool(
  input: CreateMutateToolsInput,
  ctx: AgentToolContext,
  args: RollbackToRevisionToolInput,
): Promise<AgentToolResult> {
  // 1. seenPageIds 검증
  if (!ctx.state.seenPageIds.has(args.pageId)) {
    throw new AgentToolError("page_not_observed", {
      hint: "Read the page first via read_page or list_folder before rolling back.",
    });
  }
  // 2. target revision 검증 — workspaceId + pageId 일치
  const target = await loadRevision(ctx.db, args.revisionId);
  if (!target || target.pageId !== args.pageId) {
    throw new AgentToolError("revision_mismatch", {
      hint: "revisionId does not belong to this page.",
    });
  }
  // 3. (옵션) 인간 직전 revision 거부 — §1.5 참조
  // 4. ingestion_decisions row + apply via rollbackToRevision()
  const decisionId = await createDecisionRow(/* action='update', tool='rollback_to_revision', ... */);
  const result = await rollbackToRevision({
    db: ctx.db,
    workspaceId: ctx.workspaceId,
    pageId: args.pageId,
    revisionId: args.revisionId,
    actorUserId: null,
    actorType: "ai",
    source: "rollback",
    revisionNote: args.reason.slice(0, 500),
    agentRunId: input.agentRunId,
    modelRunId: input.modelRunId,
    ingestionDecisionId: decisionId,
  });
  // 5. seenPageIds 에 신규 revisionId 등록 (다음 mutation 의 baseline 으로)
  ctx.state.observedPageRevisionIds.set(args.pageId, result.newRevisionId);
  ctx.state.mutatedPageIds.add(args.pageId);
  return { data: { decisionId, newRevisionId: result.newRevisionId, baseRevisionId: result.baseRevisionId } };
}
```

### 1.4 Decision row shape

```typescript
{
  ingestionId: input.ingestion.id,
  workspaceId: ctx.workspaceId,
  agentRunId: input.agentRunId,
  modelRunId: input.modelRunId,
  scheduledRunId: input.scheduledRunId ?? null,
  action: "update",                 // INGESTION_ACTIONS 미확장
  status: classifyDecisionStatus("update", args.confidence, {
    autonomous: input.autonomousMode === "autonomous",
  }),
  targetPageId: args.pageId,
  baseRevisionId: previousHeadRevisionId,
  confidence: args.confidence,
  rationaleJson: {
    tool: "rollback_to_revision",
    targetRevisionId: args.revisionId,
    reason: args.reason,
  },
}
```

### 1.5 Safety invariants

1. **seenPageIds enforcement**: 본 run 에서 read 안 된 pageId 는 rollback 불가. UUID hallucination 방어.
2. **인간 직전 revision 거부 (선택)**:
   - target revision 이 `actorType === 'user'` AND target.id === pages.currentRevisionId 직전 revision (== `currentRevision.baseRevisionId === target.id`) 이면 거부.
   - 의도: "사람의 가장 최근 작업을 자율 롤백" 케이스 차단.
   - 단점: 정당한 자율 undo 가 막힐 수 있음. **결정**: 본 단계에서는 *경고* 만 (recoverable error 로 hint 제공), 거부는 step-doc 추가 결정 후. 초기에는 rationale 에 `"human_recent_revision_warning": true` 만 표시하고 적용 허용.
3. **target 이 본인 (AI) 의 가장 최근 revision** 이면 정상 허용 (자율 self-correct 의 본 목적).
4. **`autonomous_shadow` 모드**: rollback 결정도 status 를 `suggested` 로 강제 — dry-run 일관성. 즉 mutate 핸들러의 status 결정 직후 shadow 다운그레이드 layer 가 그대로 적용.
5. **destructive cap 비포함**: rollback 은 카운트하지 않음.

## 2. Discovered code constraints

- 기존 [`pages.ts:1418-1532`](../../packages/api/src/routes/v1/pages.ts#L1418) rollback 핸들러는 transaction 내부에서 audit_logs 직접 insert. 추출 시 audit insert 도 lib 으로 옮김.
- [`packages/db/src/schema/revisions.ts`](../../packages/db/src/schema/revisions.ts) `pageRevisions.source` 의 enum 에 `'rollback'` 이 이미 허용됨 (rollback API 가 이미 사용 중).
- agent 의 mutate 핸들러는 일반적으로 ingestion_decisions row 를 만든 후 `approveDecision()` 을 호출하는데, rollback 은 `approveDecision` 의 표준 update path 와 동작이 다름 (target 이 *과거* revision). 따라서 **`approveDecision` 우회**, 직접 `rollbackToRevision()` lib 호출 + decision row 는 별도 insert 후 `status='auto_applied'` (또는 shadow 면 `suggested`) 직접 설정.

## 3. Reuse candidates

| 용도 | 함수/파일 |
|---|---|
| Rollback 본체 | 기존 [`pages.ts:1418-1532`](../../packages/api/src/routes/v1/pages.ts#L1418) PATCH 본문 → lib 으로 추출 |
| Revision diff insert | [`packages/db/src/schema/revisions.ts`](../../packages/db/src/schema/revisions.ts) `insertRevisionDiff` |
| Decision classify | [`classifyDecisionStatus`](../../packages/shared/src/lib/decision-classifier.ts) (S1 확장) |
| Audit log insert 패턴 | [`apply-decision.ts`](../../packages/api/src/lib/apply-decision.ts) |

## 4. Test fixtures

- 신규 `packages/api/src/lib/rollback-revision.test.ts` — happy path, cross-workspace 거부, target revision 이 다른 페이지 거부.
- [`packages/worker/src/lib/agent/tools/mutate.test.ts`](../../packages/worker/src/lib/agent/tools/mutate.test.ts) 확장 — seenPageIds 미관측 거부, 인간 직전 revision 경고 (rationale 에 표기), destructive cap 비포함.
- 통합: 기존 PATCH `/pages/:id/revisions/:revisionId/rollback` 회귀 테스트가 lib 추출 후에도 통과해야 함.
- 통합: autonomous + 잘못된 update → 후속 run 에서 rollback → 페이지가 직전 상태 + audit/revision row.

## 5. Verification checklist

- [ ] PATCH `/pages/:id/revisions/:revisionId/rollback` 기존 테스트 모두 통과 (lib 추출 회귀)
- [ ] `rollback_to_revision` agent tool — seenPageIds 미관측 거부
- [ ] 새 revision 의 `source='rollback'`, `actorType='ai'`, `baseRevisionId=target.id`
- [ ] `pages.currentRevisionId` 가 새 revision 으로 갱신
- [ ] `revision_diffs` 행 생성 (lineDiff/blockOpsDiff)
- [ ] `audit_logs` 에 `action='rollback'` 행 (ingestion 경로 / API 경로 둘 다)
- [ ] autonomous_shadow 에서 결정 status `suggested`
- [ ] `triple-extractor` enqueue (revision 갱신 → triple 재추출 — 기존 동작)

## 6. Open questions

- 인간 직전 revision 거부 vs 경고만 — 운영 1주 후 데이터 보고 결정.
- ingestion 없이 rollback 하는 경우 (운영자가 의도적 rollback 발동) — agent tool 경로 외 manual API 가 이미 있으므로 별도 행동 없음.
- multi-page rollback ("이 ingestion 이 만든 모든 변경 되돌리기") — 본 sub-doc 외, v3 RFC.
