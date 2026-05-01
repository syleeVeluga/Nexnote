# Plan — `delete_page` / `merge_pages` for Scheduled Agent

> Snapshot: 2026-05-01
> Scope: Scheduled Agent only (origin='scheduled'). Ingestion-agent exposure deferred.

## Context

오늘 사용자가 "인사 문의사항" 폴더의 4개 페이지를 Scheduled Agent로 정리했지만, 짧은 페이지들이 한 주제로 통합되지 않았다. 원인은 아키텍처가 아니라 **도구 부재**다 — 현재 mutate 도구는 모두 단일 페이지 in-place 편집(`replace_in_page` / `edit_page_blocks` / `edit_page_section` / `update_page` / `append_to_page` / `create_page`)이거나 `noop`/`request_human_review`이라, 4개 페이지를 1개로 합치거나 페이지를 삭제할 방법이 없다.

ReAct 루프는 이미 한 run에서 여러 페이지에 fan-out하므로 Orchestrator/subagent로 바꿀 필요는 없다. **`delete_page`와 `merge_pages` 두 mutate 도구를 추가하고, `ingestion_decisions.action`에 `delete`/`merge` 두 값을 더해 apply-decision/리뷰 UI에 분기를 넣는 것**으로 충분하다.

설계 결정 (사용자 확인, 2026-05-01):
- **Merge는 atomic 단일 decision** (`action='merge'`, `rationaleJson`에 source/canonical 정보)
- **`origin='scheduled'`일 때만 노출** — 외부 ingestion에서 destructive 변경 차단
- **항상 `suggested`로 강제** — `scheduled_auto_apply=true` + confidence ≥ 0.85여도 destructive는 무조건 사람 승인

## Architecture

```
Agent loop (변경 없음)
   ↓ chooses tool
delete_page / merge_pages   ← NEW mutate tools (scheduled origin only)
   ↓ creates ingestion_decision
   action='delete'  status='suggested'  rationaleJson={ pageIds: [...] }
   action='merge'   status='suggested'  rationaleJson={ canonicalPageId, sourcePageIds[] }
                                        proposedRevisionId=<canonical 신규 revision>
   ↓ human approves in /review
apply-decision.ts                        ← NEW branches
   delete: softDeleteSubtree(targetPageId), enqueue search-removal
   merge:  promote canonical revision, softDeleteSubtree(each source), enqueue triple/search
   ↓
audit_logs + activity feed
```

## File-by-File Changes

### 1. Shared types — `packages/shared/src/`

**[constants/index.ts](../packages/shared/src/constants/index.ts)** (line 74-80)
```ts
export const INGESTION_ACTIONS = [
  "create", "update", "append",
  "delete", "merge",        // NEW
  "noop", "needs_review",
] as const;
```

**[schemas/agent.ts](../packages/shared/src/schemas/agent.ts)** (line 18-27, 185-194)
- `AGENT_MUTATE_TOOL_NAMES`에 `"delete_page"`, `"merge_pages"` 추가.
- 새 Zod 스키마:
  ```ts
  export const deletePageToolInputSchema = z.object({
    pageId: z.string().uuid(),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1),
  });
  export const mergePagesToolInputSchema = z.object({
    canonicalPageId: z.string().uuid(),
    sourcePageIds: z.array(z.string().uuid()).min(1).max(10),
    mergedContentMd: z.string().min(1),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1),
  }).refine(d => !d.sourcePageIds.includes(d.canonicalPageId),
    { message: "canonicalPageId must not appear in sourcePageIds" });
  ```
- `agentMutateToolInputSchemas`에 두 스키마 등록.

### 2. Agent loop — `packages/worker/src/lib/agent/loop.ts`

- **`ACTION_TO_TOOL`** (line 506-515): `delete: "delete_page"`, `merge: "merge_pages"` 추가.
- **`MUTATE_TOOL_TO_ACTION`** (line ~510): 역매핑 추가.
- **`scheduledPromptPrefix`** (line 253-271): 한 줄 추가 —
  ```
  - Use delete_page when a selected page is fully redundant with another existing page.
  - Use merge_pages to consolidate 2+ short pages into a canonical page; provide the
    full mergedContentMd. Both delete_page and merge_pages always land as suggestions
    for human review and are only available in scheduled-origin runs.
  ```
- **PLAN_SYSTEM_PROMPT** (line 64-80): 도구 contract 섹션에 `delete_page`/`merge_pages` 인자 명세 추가.
- **Origin gating**: 도구 노출 자체를 `origin === "scheduled"` 일 때만 한다. `executeMutations` 근처에서 `mutateTools` 빌드 시 origin 체크해 두 도구를 제외하거나 포함한다.

### 3. Mutate tool 구현 — `packages/worker/src/lib/agent/tools/mutate.ts`

기존 `createDecision()` / `persistDirectPatch()` / `assertObservedPage()` / `detectHumanConflict()` 헬퍼를 재사용한다.

**`deletePage` 핸들러:**
1. `assertObservedPage(ctx, args.pageId)` — 에이전트가 `read_page`로 본 적 있는지 확인.
2. `detectHumanConflict(db, pageId, baseRevisionId)` — 사람 편집 있으면 reason에 사유 첨부.
3. **`createDecision()`** 호출:
   - `action: "delete"`, `status: "suggested"` (강제), `targetPageId: args.pageId`,
   - `rationaleJson: { kind: "delete", reason, conflict?, baseRevisionId }`,
   - `proposedRevisionId: null` (tombstone revision은 만들지 않음 — `audit_logs` + `ingestion_decisions`만으로 추적).
4. revision/diff 생성 안 함, 큐 enqueue 안 함 (apply 시점까지 대기).

**`mergePages` 핸들러:**
1. `assertObservedPage`로 canonical + 모든 source가 read context에 있는지 검증.
2. canonical에 대해 `detectHumanConflict`, source 각각도 동일하게 검사 — 충돌 시 `rationaleJson.conflict`에 기록 (`status='suggested'` 그대로 유지, 사람 판단).
3. canonical에 새 `pageRevisions` 행 INSERT (`actorType: "ai"`, `source: "scheduled"`, `contentMd: args.mergedContentMd`, `baseRevisionId: canonical.currentRevisionId`, `revisionNote: "Agent merge_pages"`); `revisionDiffs`도 INSERT.
4. **`createDecision()`** 호출:
   - `action: "merge"`, `status: "suggested"`, `targetPageId: canonicalPageId`,
   - `proposedRevisionId: <새 canonical revision>`,
   - `rationaleJson: { kind: "merge", canonicalPageId, sourcePageIds, conflicts?, baseRevisionId }`.
5. apply 전까지 `pages.currentRevisionId` 안 바꿈, `deleted_at`도 안 건드림.

**`createMutateTools()` 등록** (line 868-927): `delete_page`, `merge_pages` 두 항목 추가. 단 `input.origin === "scheduled"`일 때만 반환 객체에 포함.

### 4. Apply-decision — `packages/api/src/lib/apply-decision.ts`

기존 `softDeleteSubtree()` ([page-deletion.ts:176-277](../packages/api/src/lib/page-deletion.ts))를 재사용한다 — `pages.deleted_at` set, `search_vector` 클리어, 트리플을 `page_deleted`로 표시, `page_paths` 비활성, `audit_logs` 기록까지 다 처리한다.

**`approveDecision`에 새 분기 추가:**

```ts
if (decision.action === "delete") {
  if (!decision.targetPageId) return { code: ..., statusCode: 400 };
  await softDeleteSubtree(db, {
    pageId: decision.targetPageId,
    workspaceId,
    actorUserId: userId,
    reason: `Approved delete from decision ${decision.id}`,
  });
  await db.update(ingestionDecisions)
    .set({ status: "approved" })
    .where(eq(ingestionDecisions.id, decision.id));
  // search index 제거가 softDeleteSubtree 내부에서 이뤄지는지 확인 후 보강
  await writeAuditLog(db, { action: "approve_delete", entity: "ingestion_decision", entityId: decision.id, userId, ... });
  return { ... };
}

if (decision.action === "merge") {
  const meta = parseMergeMeta(decision); // rationaleJson에서 canonical/sources 추출
  if (!meta || !decision.targetPageId || !decision.proposedRevisionId)
    return { code: ..., statusCode: 400 };
  // 1) canonical 승격
  await db.update(pages).set({
    currentRevisionId: decision.proposedRevisionId,
    updatedAt: now, lastAiUpdatedAt: now,
  }).where(eq(pages.id, decision.targetPageId));
  // 2) sources soft delete
  for (const sourceId of meta.sourcePageIds) {
    await softDeleteSubtree(db, { pageId: sourceId, workspaceId, actorUserId: userId,
      reason: `Merged into ${decision.targetPageId} (decision ${decision.id})` });
  }
  // 3) 큐 — canonical에 triple-extractor + search-index-updater
  await extractionQueue.add(...);
  await searchQueue.add(...);
  // 4) decision 상태
  await db.update(ingestionDecisions).set({ status: "approved" })...;
  return { ... };
}
```

**Reject 경로** ([decisions.ts:392-419](../packages/api/src/routes/v1/decisions.ts)): 변경 불필요 — `status='rejected'`만 찍는 균일 경로라 새 action도 자동 동작. canonical에 만들어둔 proposed revision은 `pages.currentRevisionId`로 승격된 적 없으니 그냥 dangling으로 남는다 (history엔 보임).

**Undo 경로** (`undoCreateDecision` / `undoRevisionDecision`):
- v1에서는 **delete/merge undo 미지원** ([decisions.ts:556-565](../packages/api/src/routes/v1/decisions.ts) 가드 그대로 두어 409 반환).
- 사유: soft-delete 복구는 가능하지만 search/triple/path 재생성이 trickier — 별도 RFC로 분리.
- 검토 화면에 "이 결정은 승인 후 되돌릴 수 없습니다" 경고 띄움.

### 5. Decisions API — `packages/api/src/routes/v1/decisions.ts`

- `INGESTION_ACTIONS` 확장 자체는 자동 적용됨 (Zod enum이 상수를 import).
- **PATCH endpoint 가드** (line 649-664, 691-704): 사람이 action을 `delete`/`merge`로 수동 변경하는 것은 v1에서 **금지** — destructive 결정은 reviewer가 새로 만드는 게 아니라 에이전트가 만든 것을 승인/거부만. PATCH 검증에서 `delete`/`merge`로의 전환 차단.

### 6. Review UI

**[ReviewDetail.tsx](../packages/web/src/components/review/ReviewDetail.tsx)** (line 72-74, 114, 134)
- `canUndo`: `delete`/`merge`는 false 유지 (v1).
- Action chip 라벨에 `delete`/`merge` 케이스 추가.
- **Merge 전용 패널**: rationaleJson에서 sourcePageIds 읽어 "다음 페이지가 삭제됩니다 (link list)" + "병합 결과는 [canonical title]로 저장됩니다" + 기존 proposed-diff (canonical content) 노출.
- **Delete 전용 패널**: "이 페이지가 삭제됩니다 (자식 페이지 포함)" + 자식 페이지 목록(있다면) — `softDeleteSubtree`가 subtree 단위 삭제이므로 사용자가 영향 범위를 미리 봐야 함.
- 두 액션 모두 빨간 경고 배너 + 승인 시 "되돌릴 수 없음" 문구.

**[IngestionDetailPage.tsx](../packages/web/src/pages/IngestionDetailPage.tsx)** (line 137-143)
- `touchesPage` 검사에 `delete`/`merge` 추가하여 승인 시 페이지 트리 새로고침.

### 7. i18n — `packages/web/src/i18n/locales/{en,ko}/review.json`

`action.delete` / `action.merge` 라벨 + 경고 문구 키 추가:
- en: `"delete": "delete page"`, `"merge": "merge pages"`, `"destructive_warning": "This action cannot be undone."`
- ko: `"delete": "페이지 삭제"`, `"merge": "페이지 통합"`, `"destructive_warning": "이 작업은 되돌릴 수 없습니다."`

## Policy Gates (요약)

| 조건 | 동작 |
|---|---|
| `origin !== "scheduled"` | 도구 자체를 노출하지 않음 |
| `confidence < 0.60` | 에이전트가 `request_human_review`로 우회하도록 프롬프트 유도 |
| 어떤 confidence든 | `status='suggested'` 강제 (auto-apply 안 함) |
| canonical 또는 source에 사람 편집 충돌 | `rationaleJson.conflicts`에 기록, UI 빨간 배너 |
| sourcePageIds.length > 10 | Zod에서 거부 |
| 자식 페이지가 있는 page를 delete | `softDeleteSubtree`가 subtree 통째로 — UI에서 영향 범위 명시 |

## Critical Files

| 파일 | 변경 요지 |
|---|---|
| [packages/shared/src/constants/index.ts](../packages/shared/src/constants/index.ts) | `INGESTION_ACTIONS` 확장 |
| [packages/shared/src/schemas/agent.ts](../packages/shared/src/schemas/agent.ts) | 두 도구의 Zod 스키마 + `agentMutateToolInputSchemas` 등록 |
| [packages/worker/src/lib/agent/loop.ts](../packages/worker/src/lib/agent/loop.ts) | 프롬프트 + `ACTION_TO_TOOL` + scheduled-only 게이팅 |
| [packages/worker/src/lib/agent/tools/mutate.ts](../packages/worker/src/lib/agent/tools/mutate.ts) | `deletePage`/`mergePages` 핸들러 + `createMutateTools` 등록 |
| [packages/api/src/lib/apply-decision.ts](../packages/api/src/lib/apply-decision.ts) | `delete`/`merge` 분기 (재사용: `softDeleteSubtree`) |
| [packages/api/src/lib/page-deletion.ts](../packages/api/src/lib/page-deletion.ts) | 변경 없음 — 기존 `softDeleteSubtree` 재사용 |
| [packages/api/src/routes/v1/decisions.ts](../packages/api/src/routes/v1/decisions.ts) | PATCH 가드 (수동 action 전환 차단), undo 가드 그대로 |
| [packages/web/src/components/review/ReviewDetail.tsx](../packages/web/src/components/review/ReviewDetail.tsx) | 액션 라벨 + delete/merge 전용 패널 + 경고 배너 |
| [packages/web/src/pages/IngestionDetailPage.tsx](../packages/web/src/pages/IngestionDetailPage.tsx) | `touchesPage` 확장 |
| [packages/web/src/i18n/locales/{en,ko}/review.json](../packages/web/src/i18n/locales/) | 새 액션 라벨 + 경고 문구 |

**스키마 마이그레이션 불필요** — `ingestion_decisions.action`은 CHECK 없는 text 컬럼이고, `pages.deleted_at`은 이미 존재.

## Verification

1. **단위 테스트** (`packages/worker/src/lib/agent/tools/mutate.test.ts` 또는 신규):
   - `deletePage`가 `assertObservedPage` 미통과 시 거부
   - `mergePages`가 canonicalPageId가 sourcePageIds에 포함되면 Zod 거부
   - 두 도구 모두 `status='suggested'`로 항상 작성 (auto-apply 안 됨)
   - origin이 'scheduled'가 아니면 도구 자체가 `createMutateTools` 결과에 없음
   - merge 시 canonical에 새 revision + diff 정상 INSERT
2. **apply-decision 단위 테스트** (`packages/api/src/lib/apply-decision.test.ts` 추가):
   - delete 승인 → `pages.deleted_at` set, decision `status='approved'`, audit log 기록
   - merge 승인 → canonical promoted + sources soft-deleted + triple/search 큐 enqueue
3. **e2e 수동 시나리오**:
   - `/settings/ai`에서 Scheduled Agent enable, scheduled_auto_apply=false (기본).
   - 폴더 4개 페이지 선택 → "AI reorganize this folder" + instruction "통합 가능한 페이지를 합쳐 정리하라".
   - `/settings/scheduled-agent`에서 run 추적, trace에 `merge_pages` 호출 확인.
   - `/review`에서 merge decision 카드 — "다음 페이지 삭제: A, B, C" + canonical diff + 빨간 경고 표시.
   - 승인 → 4개 중 3개가 trash로 이동 (`pages.deleted_at`), canonical 페이지가 통합 본문으로 갱신.
   - `/activity`에서 "AI merged pages B, C, D into A" 항목 확인 (audit_logs 결합).
4. **Reject 시나리오**: merge decision 거부 → canonical에 만들어둔 proposed revision은 dangling, `currentRevisionId` 미변경, 어떤 page도 `deleted_at` 안 받음.

```bash
pnpm --filter shared build
pnpm --filter worker test -- --test-name-pattern="delete_page|merge_pages"
pnpm --filter api test -- --test-name-pattern="apply-decision.*(delete|merge)"
pnpm --filter web typecheck
pnpm --filter web lint
```

## v2 Follow-up Progress

Implemented in follow-up:

- **delete/merge undo** — approved delete decisions restore the soft-deleted subtree; approved merge decisions restore source pages, disable merge redirects, and create a rollback revision on the canonical page.
- **Page redirects** — `page_redirects` redirects source page public paths to the canonical page's live public snapshot after merge approval.
- **Ingestion-origin exposure** — review DTOs and UI keep `origin` / `scheduledRunId` visible, including a direct Scheduled Agent run link.
- **Workspace destructive-tools toggle** — `workspaces.allow_destructive_scheduled_agent` gates `delete_page` / `merge_pages` tool exposure in Scheduled Agent runs.
- **Bulk delete UI** — `/review` can select multiple pending delete decisions and approve/reject them together.
- **Merge dry-run / inline preview** — pending merge decisions expose an editable merged Markdown preview; saving rewrites the proposed revision and diff before approval.

Remaining out of scope:

- **Ingestion-agent (origin='ingestion') 노출**: 운영 데이터 쌓이고 parity 안정화된 후.
- Dedicated e2e coverage for destructive undo, redirects, bulk delete, and inline merge preview.

## CLAUDE.md / Documentation Map 업데이트

새 RFC를 [CLAUDE.md](../CLAUDE.md) Documentation map 표에 추가:

```
| 구현 RFC — Scheduled Agent destructive tools | docs/scheduled-agent-merge-delete-plan.md |
```

[scheduled-agent-plan.md](scheduled-agent-plan.md)의 "v2+ Follow-ups" 섹션에 다음 줄 추가:

```
- merge_pages / delete_page tools — see scheduled-agent-merge-delete-plan.md
```
