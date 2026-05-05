# Sub-doc · S2 — Reorganize tools (interface decisions)

> **Status**: 구현 완료 검증 (2026-05-05)
> **Scope**: AUTO-2 — `move_page`, `rename_page`, `create_folder` agent tools
> **Parent RFC**: [`agent-tools-expand-plan.md`](agent-tools-expand-plan.md)

## 1. Tool signatures (Zod)

```typescript
// packages/shared/src/schemas/agent.ts

export const movePageToolInputSchema = z.object({
  pageId: z.string().uuid(),
  newParentPageId: z.string().uuid().nullable().optional(),
  newParentFolderId: z.string().uuid().nullable().optional(),
  newSortOrder: z.number().int().min(0).optional(),
  reorderIntent: z.enum(["before", "after", "append", "explicit"]).optional(),
  reorderAnchorPageId: z.string().uuid().optional(),
  reason: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
}).refine(
  (v) => v.newParentPageId !== undefined || v.newParentFolderId !== undefined || v.newSortOrder !== undefined || v.reorderIntent !== undefined,
  "At least one of newParentPageId / newParentFolderId / newSortOrder / reorderIntent must be provided",
);

export const renamePageToolInputSchema = z.object({
  pageId: z.string().uuid(),
  newTitle: z.string().min(1).max(500).optional(),
  newSlug: z.string().min(1).max(200).optional(),
  reason: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
}).refine(
  (v) => v.newTitle !== undefined || v.newSlug !== undefined,
  "At least one of newTitle / newSlug must be provided",
);

export const createFolderToolInputSchema = z.object({
  name: z.string().min(1).max(200),
  parentFolderId: z.string().uuid().nullable().optional(),
  reason: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
});
```

`AgentMutateToolName` 유니온에 3개 추가. `AgentPlanMutation.tool` enum 도 확장. INGESTION_ACTIONS 미변경 (사용자 결정).

## 2. Library function extraction

기존 인라인 핸들러 본문을 lib 으로 추출:

| 신규 lib | 기존 위치 | 책임 |
|---|---|---|
| [`packages/api/src/lib/move-page.ts`](../../packages/api/src/lib/move-page.ts) | [`pages.ts:764-1000`](../../packages/api/src/routes/v1/pages.ts#L764) PATCH `/pages/:id` 의 parent/sort 분기 | parent 검증 + reorderPage 호출 + pagePaths/redirect + audit + triple-extractor enqueue |
| [`packages/api/src/lib/rename-page.ts`](../../packages/api/src/lib/rename-page.ts) | [`pages.ts:813-880`](../../packages/api/src/routes/v1/pages.ts#L813) PATCH `/pages/:id` 의 title/slug 분기 | title/slug 갱신 + slug 변경 시 pagePaths/redirect + audit. revision 미생성. |
| [`packages/api/src/lib/create-folder.ts`](../../packages/api/src/lib/create-folder.ts) | [`folders.ts:76-238`](../../packages/api/src/routes/v1/folders.ts#L76) POST handler | parent 검증 + insert + audit |

기존 PATCH/POST 핸들러는 lib 호출로 단순화. 동작 동일성 회귀 테스트 필수.

## 3. Agent tool wrappers (mutate.ts)

```typescript
// packages/worker/src/lib/agent/tools/mutate.ts (createMutateTools 추가 entry)

move_page: {
  name: "move_page",
  description: "Move a page to a new parent folder/page or reorder within siblings. Use to consolidate or reorganize wiki structure.",
  schema: agentMutateToolInputSchemas.move_page,
  execute: (ctx, args) => movePage(input, ctx, args as MovePageToolInput),
},
rename_page: {
  name: "rename_page",
  description: "Change a page's title and/or slug. Does not create a new revision (title/slug live on the page row, not in revisions).",
  schema: agentMutateToolInputSchemas.rename_page,
  execute: (ctx, args) => renamePage(input, ctx, args as RenamePageToolInput),
},
create_folder: {
  name: "create_folder",
  description: "Create a new folder under an existing parent folder (or root). Use before move_page when target folder doesn't exist yet.",
  schema: agentMutateToolInputSchemas.create_folder,
  execute: (ctx, args) => createFolder(input, ctx, args as CreateFolderToolInput),
},
```

각 핸들러는 (a) seenPageIds/seenFolderIds 검증 → (b) lib 호출 → (c) ingestion_decisions row 생성 (action='update' / 'create' for folder, tool 필드에 정확한 도구명) → (d) state 갱신 (`mutatedPageIds`, `seenFolderIds.add` 등) → (e) result 반환.

## 4. seenFolderIds 추적

```typescript
// packages/worker/src/lib/agent/types.ts
export interface AgentRunState {
  seenPageIds: Set<string>;
  seenBlockIds: Set<string>;
  seenFolderIds: Set<string>;        // 신규
  observedPageRevisionIds: Map<string, string | null>;
  createdPageIds: Set<string>;
  createdFolderIds: Set<string>;     // 신규
  mutatedPageIds: Set<string>;
  destructiveCount: number;          // S1 추가
}
```

```typescript
// packages/worker/src/lib/agent/types.ts
export interface AgentToolResult<T = unknown> {
  data: T;
  observedPageIds?: string[];
  observedPageRevisions?: Array<{ pageId: string; revisionId: string | null }>;
  observedBlockIds?: string[];
  observedFolderIds?: string[];      // 신규 (list_folder, create_folder result)
  createdPageIds?: string[];
  createdFolderIds?: string[];       // 신규
  mutatedPageIds?: string[];
}
```

dispatcher `observeResult()` ([dispatcher.ts:82-100](../../packages/worker/src/lib/agent/dispatcher.ts)) 가 두 신규 필드를 set 에 누적.

`list_folder` tool 도 결과에 `observedFolderIds` 채우도록 read.ts 갱신.

## 5. Validation rules

### move_page

- `pageId !== newParentPageId` (self-parent 거부 — `validateParentPageAssignment` 가 이미 처리).
- 사이클 거부 — `validateParentPageAssignment` 의 ancestor walk 재사용.
- `newParentFolderId` 가 set 되면 `seenFolderIds` 에 있어야 함 (이번 run 에서 list_folder 또는 create_folder 로 관측). 미관측 시 recoverable error + `request_human_review` hint.
- `newParentPageId` 도 동일 — `seenPageIds` enforcement.
- `newSortOrder` < 0 거부.
- triple re-extraction enqueue 는 lib 내부에서 자동 (재사용).

### rename_page

- `newTitle` 또는 `newSlug` 둘 중 하나 필수.
- `newSlug` 가 unique 충돌 시 [`insertPageWithUniqueSlug`](../../packages/db/src/page-helpers.ts) 의 동일 패턴으로 자동 suffix? **결정**: agent tool 은 자동 suffix 하지 않고 명확한 충돌 에러 → agent 가 다른 slug 제안 (자율적 의사결정 보존).
- title-only 변경은 revision 미생성. agent system prompt 에 명시.

### create_folder

- `parentFolderId === null` 또는 undefined 면 root.
- `name` 의 slug 가 같은 부모 아래 unique — slug 자동 생성 (slugify) 후 충돌 시 unique-suffix.
- `validateParentFolderAssignment` 으로 부모 검증.

## 6. Decision row shapes

```typescript
// move_page
{
  action: "update",
  rationaleJson: {
    tool: "move_page",
    from: { parentPageId, parentFolderId, sortOrder },
    to: { newParentPageId, newParentFolderId, newSortOrder },
    reason: args.reason,
  },
}

// rename_page
{
  action: "update",
  rationaleJson: {
    tool: "rename_page",
    from: { title, slug },
    to: { newTitle, newSlug },
    reason: args.reason,
  },
}

// create_folder
{
  action: "create",        // 폴더 생성도 create
  targetPageId: null,
  rationaleJson: {
    tool: "create_folder",
    folderId: result.id,
    name: args.name,
    parentFolderId: args.parentFolderId,
    reason: args.reason,
  },
}
```

## 7. System prompt 갱신

[`packages/worker/src/lib/agent/loop.ts:59`](../../packages/worker/src/lib/agent/loop.ts#L59) `PLAN_SYSTEM_PROMPT` 의 tool 계약 섹션에 추가:

```
- move_page: { pageId, newParentPageId? | newParentFolderId?, newSortOrder?, confidence, reason }
- rename_page: { pageId, newTitle?, newSlug?, confidence, reason }
- create_folder: { name, parentFolderId?, confidence, reason }
```

가이드 한 문장 추가:
> "When restructuring is needed, prefer move_page/rename_page over recreating pages. Use create_folder before move_page when the target folder does not exist yet."

## 8. Discovered code constraints

- 기존 PATCH `/pages/:id` 핸들러는 title/slug/parent 를 한 번에 받음 (multi-field PATCH). agent tool 은 의도적으로 분리 — agent 가 명시적 의도를 표현하도록.
- [`reorderPage`](../../packages/api/src/lib/reorder.ts) 는 `intent` parameter 를 받음 ("before" / "after" / "append" / "explicit"). agent tool schema 에 동일 intent 노출.
- [`packages/api/src/routes/v1/folders.ts:415`](../../packages/api/src/routes/v1/folders.ts#L415) DELETE handler 는 ADMIN 권한 필요. **agent 의 폴더 *삭제* 는 본 sprint 외** — folder DELETE 도구는 별도 RFC. 폴더 *이동/리네임* 도 본 sprint 외 (agent reorganize 대부분은 페이지 이동으로 충분).

## 9. Reuse candidates

| 용도 | 함수/파일 |
|---|---|
| 페이지 reorder | [`reorderPage`](../../packages/api/src/lib/reorder.ts) (line 62) |
| 페이지 부모 검증 | [`validateParentPageAssignment`](../../packages/api/src/lib/page-hierarchy.ts) (line 41) |
| 폴더 부모 검증 | [`validateParentFolderAssignment`](../../packages/api/src/lib/folder-hierarchy.ts) (line 39) |
| Slug 생성 | [`slugify`](../../packages/shared/src/utils) |
| Triple re-extraction enqueue | [`pages.ts:984`](../../packages/api/src/routes/v1/pages.ts#L984) 패턴 |

## 10. Test fixtures

신규 단위 테스트:
- `packages/api/src/lib/move-page.test.ts` — happy path, cycle 거부, cross-workspace 거부, slug 충돌.
- `packages/api/src/lib/rename-page.test.ts` — title-only / slug-only / 둘 다, slug 충돌, pagePaths/redirects 행 생성.
- `packages/api/src/lib/create-folder.test.ts` — root 폴더, nested, slug 충돌, depth 제한.

[`mutate.test.ts`](../../packages/worker/src/lib/agent/tools/mutate.test.ts) 확장:
- move_page — seenPageIds/seenFolderIds 미관측 거부.
- rename_page — slug 충돌 명확한 에러.
- create_folder — 결과 folderId 가 seenFolderIds 에 등록.

회귀:
- 기존 PATCH `/pages/:id` 와 POST `/folders` 의 통합 테스트 모두 통과 (lib 추출 후에도).

## 11. Verification checklist

- [x] 기존 PATCH `/pages/:id` 회귀 테스트 모두 통과 (lib 추출)
- [x] 기존 POST `/folders` 회귀 테스트 모두 통과 (lib 추출)
- [x] 3 agent tool 의 단위 테스트 통과
- [x] move_page 후 triple-extractor enqueue 확인
- [x] move_page 후 pagePaths 신규 행 + 이전 행 isCurrent=false
- [x] rename_page slug 변경 시 redirect 행 생성
- [x] create_folder 후 seenFolderIds 등록 → 같은 run 의 후속 move_page 가 그 폴더로 정상 이동
- [x] AgentTracePanel 에 3 신규 tool 라벨 정상 렌더 (한/영)
- [x] activity feed 에 "AI moved *Page X* to *Folder Y*" 포맷 정상

## 12. Open questions

- agent 가 폴더를 *옮기거나 리네임* 해야 하는 시나리오 빈도 — 본 sprint 외, 별도 RFC.
- move_page 시 페이지의 `pages.depth` 컬럼 갱신 (있다면) — schema 확인 필요.
- multi-page atomic move — N 페이지를 한 번에 이동할 때 트랜잭션? 본 sprint 는 1회 1페이지, agent 는 multi-turn 으로 N번 호출 (S5 multi-turn 과 자연스럽게 결합).
