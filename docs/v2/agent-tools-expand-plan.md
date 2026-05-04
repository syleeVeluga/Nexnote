# Agent Tools Expansion — Umbrella RFC (S2 + S3)

> **상태**: 초안 (2026-05-04) · S2·S3 미착수
> **유형**: 구현 RFC
> **모티브**: 자율 에이전트가 "find / read / create / delete / merge / edit" 6동사를 모두 수행하려면 reorganize 도구 + 메타데이터/백링크/리비전 read 도구가 필요하다

본 RFC 는 docs/v2/ 묶음의 **두 번째 우산** — 빠진 도구 surface 를 채운다. S2 는 reorganize tools (page move / rename / create folder), S3 는 read intelligence tools (frontmatter / backlinks / revision history) 다. **두 sprint 는 disjoint 코드 경로 (mutate.ts vs read.ts) 라 병행 PR 가능.**

## Context

코드 감사 결과, agent 가 자율적으로 위키를 유지하려면 다음이 부족하다 ([`docs/v2/README.md`](README.md) §사용자 결정 사항):

- **Move / Rename / Create Folder** — API 엔드포인트는 존재하나 agent tool wrapper 부재. reorganize 시나리오 구조적 불가.
- **Page metadata 조회** — frontmatter / tags / parent path / 발행 상태를 한 번에 보는 read 도구 없음. agent 는 read_page 로 매번 본문 전체를 받아 파싱해야 함 → token 낭비, 부정확.
- **Backlinks** — 페이지 삭제/이동 전 의존성 평가 불가. 현재는 triples 만 있고 진짜 link map 없음.
- **Revision history** — agent 가 자기 (또는 사람의) 과거 작업을 보지 못해 "어제 잘못 적용한 update" 인식 불가 → S4 rollback 의 효용 제한.

INGESTION_ACTIONS enum 확장은 사용자 결정으로 **하지 않음**. 신규 tool 결과는 모두 기존 `update`/`noop`/... action 으로 분류, 분석 granularity 는 audit_logs + tool name 으로 보존. 단 cascade 영향 (parity gate / classifier / audit renderer / trace UI / i18n) 는 모두 새 tool name 을 처리.

## Sprint 2 — Reorganize tools

### 2.1 신규 도구 3종

#### `move_page({ pageId, newParentPageId?, newParentFolderId?, newSortOrder?, reason, confidence })`

- **재사용**: [`reorderPage()`](../../packages/api/src/lib/reorder.ts) (line 62), [`validateParentPageAssignment()`](../../packages/api/src/lib/page-hierarchy.ts) (line 41), `getNextPageSortOrder()` ([`pages.ts:905`](../../packages/api/src/routes/v1/pages.ts#L905) 인라인 패턴).
- **부수 효과**: triple re-extraction enqueue ([`pages.ts:984`](../../packages/api/src/routes/v1/pages.ts#L984) 패턴 — `useReconciliation: true`), pagePaths 갱신, redirect 행 생성.
- **decision row**: `action='update'`, `tool='move_page'`, `rationaleJson` 에 `{from: {parentPageId, parentFolderId, sortOrder}, to: {...}}` 기록.
- **검증**: workspaceId 경계, self-parent 거부, 사이클 거부, 본 run 의 `seenPageIds` 검증.

#### `rename_page({ pageId, newTitle, newSlug?, reason, confidence })`

- **재사용**: [`pages.ts:813-880`](../../packages/api/src/routes/v1/pages.ts#L813) PATCH 의 title/slug 분기 → [`packages/api/src/lib/rename-page.ts`](../../packages/api/src/lib/rename-page.ts) (신규) 로 추출.
- **revision 미생성** — 현재 PATCH 핸들러는 title/slug 변경 시 새 revision 을 만들지 않음 (의도된 모델). agent tool 도 동일.
- **slug 변경 시**: `pagePaths` 신규 행 + 이전 행 `isCurrent=false`, `pageRedirects` 행 생성 → SEO 안정성.
- **decision row**: `action='update'`, `tool='rename_page'`.

#### `create_folder({ name, parentFolderId?, reason, confidence })`

- **재사용**: [`packages/api/src/routes/v1/folders.ts:76`](../../packages/api/src/routes/v1/folders.ts#L76) POST handler 본체를 [`packages/api/src/lib/create-folder.ts`](../../packages/api/src/lib/create-folder.ts) (신규) 로 추출.
- **재사용**: [`validateParentFolderAssignment()`](../../packages/api/src/lib/folder-hierarchy.ts) (line 39).
- **결과 folderId 추적**: dispatcher `state` 에 신규 `seenFolderIds: Set<string>` 추가, 후속 `move_page` 의 `newParentFolderId` 검증에 사용.
- **decision row**: `action='create'`, `tool='create_folder'` — 페이지 생성과 구분.

### 2.2 cascade 변경

- [`packages/shared/src/schemas/agent.ts`](../../packages/shared/src/schemas/agent.ts) — Zod 스키마 3개 (`agentMutateToolInputSchemas.move_page` 등), `AgentMutateToolName` 유니온 확장, `AgentPlanMutation.tool` enum 확장.
- [`packages/shared/src/constants/index.ts`](../../packages/shared/src/constants/index.ts) — 변경 없음 (INGESTION_ACTIONS 미확장).
- [`packages/worker/src/lib/agent/tools/mutate.ts:1321`](../../packages/worker/src/lib/agent/tools/mutate.ts#L1321) — `createMutateTools()` 에 3 entry 추가.
- [`packages/worker/src/lib/agent/dispatcher.ts`](../../packages/worker/src/lib/agent/dispatcher.ts) `AgentRunState` 에 `seenFolderIds: Set<string>` 추가, `observeResult()` ([dispatcher.ts:82-100](../../packages/worker/src/lib/agent/dispatcher.ts)) 에 folderId 관측 분기.
- [`packages/worker/src/lib/agent/types.ts`](../../packages/worker/src/lib/agent/types.ts) `AgentToolResult` 에 `observedFolderIds?` / `createdFolderIds?` 옵션 필드 추가.
- [`packages/worker/src/lib/agent/loop.ts:59`](../../packages/worker/src/lib/agent/loop.ts#L59) `PLAN_SYSTEM_PROMPT` 에 새 tool 계약 3개 추가, `ACTION_TO_TOOL` map 미변경.
- [`packages/api/src/lib/agent-parity-gate.ts`](../../packages/api/src/lib/agent-parity-gate.ts) — agreement 산정은 `action` 기준이라 **무변경 작동**. 단 회귀 테스트로 `move_page`/`rename_page`/`create_folder` 결정이 update bucket 으로 정상 집계 확인.
- [`packages/web/src/components/agents/AgentTracePanel.tsx`](../../packages/web/src/components/agents/AgentTracePanel.tsx) — tool name → 라벨 매핑에 3개 추가.
- [`packages/web/src/i18n/locales/ko/`](../../packages/web/src/i18n/locales/ko) 와 `en/` — `move_page`/`rename_page`/`create_folder` 다국어 라벨 키 추가.
- [`packages/web/src/pages/IngestionDetailPage.tsx`](../../packages/web/src/pages/IngestionDetailPage.tsx) — decision card tool-name 칩 신규 라벨.
- [`packages/api/src/routes/v1/activity.ts`](../../packages/api/src/routes/v1/activity.ts) — actor/action 라벨 매핑에 신규 tool 추가, "AI moved *Page X* to *Folder Y*" 식 표현.

### 2.3 검증 (Sprint 2)

- 단위: 각 도구 — 권한, hierarchy validation, 부모 슬러그 충돌, redirect 행 생성, audit_logs 행, seenPageIds/seenFolderIds 검증.
- 단위: `move_page` — 사이클 거부, 워크스페이스 경계 위반 거부, sortOrder 정상.
- 단위: `rename_page` — slug 변경 시 pagePaths/redirects 생성, slug 충돌 시 unique-slug 헬퍼 fallback.
- 단위: `create_folder` — 부모 폴더 슬러그 충돌, depth 제한 (folder-hierarchy.ts 의 cycle/depth 검증).
- 단위: parity gate 회귀 — 신규 tool 결정이 update agreement bucket 에 정상 집계.
- 통합: autonomous 시나리오 — 폴더 신설 → 5페이지 이동 → 1페이지 rename → audit_logs / triple-extraction enqueue / pagePaths 모두 정상.

## Sprint 3 — Read intelligence tools

### 3.1 신규 도구 4종

#### `read_page_metadata({ pageId })`

- **재사용**: `read_page` 의 page row + revision contentMd 조회 패턴.
- **신규 helper**: [`packages/worker/src/lib/agent/lib/frontmatter.ts`](../../packages/worker/src/lib/agent/lib/frontmatter.ts) (신규) — 자체 정규식 (`^---\n([\s\S]*?)\n---\n`) + `js-yaml` (이미 monorepo 어딘가 있으면 재사용, 없으면 가벼운 자체 파서). 의존성 추가 결정은 [`agent-tools-expand-step-3-read-intel.md`](agent-tools-expand-step-3-read-intel.md) sub-doc 에서.
- **반환**:
  ```typescript
  {
    pageId, title, slug, parentPageId, parentFolderId, parentPath,
    currentRevisionId, lastAiUpdatedAt, lastHumanEditedAt,
    frontmatter: Record<string, unknown> | null,
    childCount, isPublished, hasOpenSuggestions
  }
  ```
- **이점**: agent 가 본문 다운로드 없이 메타만 받아 분류/dedupe 판단 → 토큰 절약 + 정확도.

#### `find_backlinks({ pageId, limit? })` — **Tier 1 (사용자 확정)**

- **동작**: 대상 페이지의 `slug` + `title` 로 워크스페이스 모든 활성 페이지의 latest revision contentMd 에 ILIKE 스캔.
- **SQL 패턴**: [`packages/db/src/page-deletion.ts`](../../packages/db/src/page-deletion.ts) 의 latest-revision JOIN 패턴 재사용 (`pages` ⨝ `pageRevisions ON currentRevisionId`).
- **검색 식**: `[[Page Title]]`, `[[slug]]`, `](slug)`, `](/path/slug)` 4가지 패턴 ILIKE OR 결합. step-doc 에서 정확한 정규식 결정.
- **반환**: `{ backlinks: [{ pageId, title, snippet, matchType }], total, limited }`.
- **한계 명시**: 위키링크 정확도 ≤ 100%, ≤500 페이지 워크스페이스 권장. 본 도구의 docstring + step-doc 의 `## Limitations` 섹션 모두에 표기.
- **후속 RFC**: [`docs/v2/page-link-extraction-rfc.md`](page-link-extraction-rfc.md) — 사용자 피드백 후 진입.

#### `read_revision_history({ pageId, limit? })`

- **재사용**: GET `/pages/:pageId/revisions` SQL ([`pages.ts:1164-1224`](../../packages/api/src/routes/v1/pages.ts#L1164)) → [`packages/api/src/lib/revision-history.ts`](../../packages/api/src/lib/revision-history.ts) (신규) 로 추출, 양쪽에서 호출.
- **반환**: `RevisionSummaryDto[]` (이미 정의된 타입 재사용).
- **agent 활용**: rollback target 선정, 자기 작업 회고, 인간/AI 편집 패턴 파악.

#### `read_revision({ revisionId })`

- **신규 SQL**: `pageRevisions` JOIN `revisionDiffs` (lineDiff/blockOpsDiff). workspaceId 경계 enforce.
- **반환**: `{ id, pageId, contentMd, contentJson, source, actorType, actorUserId, baseRevisionId, createdAt, lineDiff?, blockOpsDiff? }`.
- **agent 활용**: rollback 전 target 검토, diff 기반 의사결정.

### 3.2 cascade 변경

- [`packages/shared/src/schemas/agent.ts`](../../packages/shared/src/schemas/agent.ts) — Zod 스키마 4개, `AgentReadToolName` 유니온 확장.
- [`packages/worker/src/lib/agent/tools/read.ts:911`](../../packages/worker/src/lib/agent/tools/read.ts#L911) `createReadOnlyTools()` 에 4 entry 추가.
- [`packages/worker/src/lib/agent/dispatcher.ts`](../../packages/worker/src/lib/agent/dispatcher.ts) `DEFAULT_READ_TOOL_QUOTAS` 확장:
  ```
  read_page_metadata: 30
  find_backlinks: 5      // 무거운 ILIKE → 보수적
  read_revision_history: 10
  read_revision: 30
  ```
  정확한 값은 step-doc 에서 확정.
- [`packages/worker/src/lib/agent/loop.ts:50`](../../packages/worker/src/lib/agent/loop.ts#L50) `EXPLORE_SYSTEM_PROMPT` 에 신규 도구 사용 가이드 추가:
  - "Use `read_page_metadata` when you only need title/parent/timestamps — avoid full `read_page` for triage."
  - "Use `find_backlinks` before proposing `delete_page` or `merge_pages` to evaluate dependencies."
- [`packages/worker/src/lib/agent/budgeter.ts`](../../packages/worker/src/lib/agent/budgeter.ts) — neue tool 결과의 `executionToContextBlock` 가중치 (mutate.ts 의 `read_page` 와 다른 weight) — step-doc 에서 결정.

### 3.3 frontmatter 미존재 정책

- contentMd 가 `---\n` 으로 시작하지 않으면 `frontmatter: null` 반환 (에러 아님).
- YAML 파싱 실패 시 `frontmatter: { __parseError: "..." }` 반환 — agent 가 인지하고 다른 신호로 의사결정 가능.
- 본문은 본 도구가 반환하지 않음 (agent 가 본문 필요시 `read_page` 별도 호출) — 토큰 절약 의도 보존.

### 3.4 검증 (Sprint 3)

- 단위: 각 도구 — 본 run 에 read 안 된 pageId 거부 (seenPageIds 보호 — 단 `find_backlinks` 는 *모든* 페이지를 결과로 반환하므로 입력 pageId 만 검증), workspace 경계, 빈 결과.
- 단위: `find_backlinks` — 정확한 위키링크 / 부분 매칭 / false-positive (slug 가 다른 단어의 일부) fixture.
- 단위: frontmatter parser — 누락 / 잘못된 YAML / 빈 frontmatter / 불완전한 `---` 경계 / 본문 없는 frontmatter only.
- 단위: `read_revision_history` — pagination, workspaceId 경계, 본 run seenPageIds 검증.
- 단위: `read_revision` — workspaceId 경계, 다른 페이지의 revisionId 거부.
- 통합: 한 ingestion 에서 read_page → read_page_metadata → find_backlinks → 의존성 발견 후 plan 분기 시나리오 (shadow 모드).

## Cross-cutting

- [`docs/v2/README.md`](README.md) §사용자 결정 사항 의 baseline 준수 — INGESTION_ACTIONS 미확장.
- 두 sprint 모두 [`packages/web/src/components/agents/AgentTracePanel.tsx`](../../packages/web/src/components/agents/AgentTracePanel.tsx) tool-result 렌더러 갱신.
- [`docs/TASKS.md`](../TASKS.md) 에 AUTO-2 (S2) / AUTO-3 (S3) ticket 추가.
- [`CLAUDE.md`](../../CLAUDE.md) "Current Implementation Status" 표 갱신 (S2, S3 머지 시).

## Out of scope

- 진짜 link extraction (page_links 테이블 + 트리거) — [`page-link-extraction-rfc.md`](page-link-extraction-rfc.md) placeholder.
- frontmatter 를 별도 컬럼으로 정규화 — 현재 contentMd 내부 유지.
- `read_outgoing_links` (forward 방향) — find_backlinks 와 자매이지만 v3.
- `update_frontmatter` mutate tool — 현재는 `update_page` 또는 `edit_page_blocks` 로 가능, 자율 모드 운영 데이터 본 후 재평가.
- Page tag/alias DB 모델링 — 별도 RFC.

## Critical files

신규:
- [`packages/api/src/lib/rename-page.ts`](../../packages/api/src/lib/rename-page.ts)
- [`packages/api/src/lib/create-folder.ts`](../../packages/api/src/lib/create-folder.ts)
- [`packages/api/src/lib/revision-history.ts`](../../packages/api/src/lib/revision-history.ts)
- [`packages/worker/src/lib/agent/lib/frontmatter.ts`](../../packages/worker/src/lib/agent/lib/frontmatter.ts)
- [`docs/v2/agent-tools-expand-step-2-reorganize.md`](agent-tools-expand-step-2-reorganize.md) (sub-doc)
- [`docs/v2/agent-tools-expand-step-3-read-intel.md`](agent-tools-expand-step-3-read-intel.md) (sub-doc)

수정:
- [`packages/shared/src/schemas/agent.ts`](../../packages/shared/src/schemas/agent.ts)
- [`packages/worker/src/lib/agent/tools/mutate.ts`](../../packages/worker/src/lib/agent/tools/mutate.ts)
- [`packages/worker/src/lib/agent/tools/read.ts`](../../packages/worker/src/lib/agent/tools/read.ts)
- [`packages/worker/src/lib/agent/dispatcher.ts`](../../packages/worker/src/lib/agent/dispatcher.ts)
- [`packages/worker/src/lib/agent/loop.ts`](../../packages/worker/src/lib/agent/loop.ts)
- [`packages/worker/src/lib/agent/types.ts`](../../packages/worker/src/lib/agent/types.ts)
- [`packages/worker/src/lib/agent/budgeter.ts`](../../packages/worker/src/lib/agent/budgeter.ts)
- [`packages/api/src/routes/v1/pages.ts`](../../packages/api/src/routes/v1/pages.ts)
- [`packages/api/src/routes/v1/folders.ts`](../../packages/api/src/routes/v1/folders.ts)
- [`packages/api/src/routes/v1/activity.ts`](../../packages/api/src/routes/v1/activity.ts)
- [`packages/web/src/components/agents/AgentTracePanel.tsx`](../../packages/web/src/components/agents/AgentTracePanel.tsx)
- [`packages/web/src/pages/IngestionDetailPage.tsx`](../../packages/web/src/pages/IngestionDetailPage.tsx)
- [`packages/web/src/i18n/locales/ko/`](../../packages/web/src/i18n/locales/ko) 와 `en/`
