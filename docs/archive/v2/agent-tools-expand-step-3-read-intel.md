# Sub-doc · S3 — Read intelligence tools (interface decisions)

> **Status**: 구현 완료 검증 (2026-05-05)
> **Scope**: AUTO-3 — `read_page_metadata`, `find_backlinks`, `read_revision_history`, `read_revision`
> **Parent RFC**: [`agent-tools-expand-plan.md`](agent-tools-expand-plan.md)

## 1. Tool signatures (Zod)

```typescript
// packages/shared/src/schemas/agent.ts

export const readPageMetadataToolInputSchema = z.object({
  pageId: z.string().uuid(),
});

export const findBacklinksToolInputSchema = z.object({
  pageId: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(30),
});

export const readRevisionHistoryToolInputSchema = z.object({
  pageId: z.string().uuid(),
  limit: z.number().int().min(1).max(50).default(20),
});

export const readRevisionToolInputSchema = z.object({
  revisionId: z.string().uuid(),
  includeContent: z.boolean().default(true),
});
```

`AgentReadToolName` 유니온에 4개 추가.

## 2. Return types

### read_page_metadata

```typescript
{
  pageId: string;
  title: string;
  slug: string;
  parentPageId: string | null;
  parentFolderId: string | null;
  parentPath: string;                  // breadcrumb 문자열, e.g. "Engineering / API"
  currentRevisionId: string | null;
  lastAiUpdatedAt: string | null;      // ISO
  lastHumanEditedAt: string | null;    // ISO
  frontmatter: Record<string, unknown> | null;
  childCount: number;
  isPublished: boolean;
  hasOpenSuggestions: boolean;         // ingestion_decisions.status='suggested' AND target=pageId
}
```

본문은 미반환 — token 절약 의도.

### find_backlinks

```typescript
{
  backlinks: Array<{
    pageId: string;
    title: string;
    slug: string;
    snippet: string;            // 매치 주변 100자
    matchType: "wikilink_title" | "wikilink_slug" | "markdown_link";
  }>;
  total: number;
  limited: boolean;             // total > limit 인 경우 true
  searchedPattern: string;      // 디버깅용 — 실제 사용된 ILIKE 패턴
}
```

### read_revision_history

```typescript
{
  revisions: RevisionSummaryDto[];   // 기존 타입 재사용
  total: number;
  limited: boolean;
}
```

### read_revision

```typescript
{
  id: string;
  pageId: string;
  contentMd: string;            // includeContent=true 일 때만
  contentJson: unknown;
  source: string;
  actorType: "user" | "ai" | "system";
  actorUserId: string | null;
  baseRevisionId: string | null;
  createdAt: string;
  revisionNote: string | null;
  lineDiff: string | null;
  blockOpsDiff: unknown | null;
}
```

## 3. Frontmatter parser

[`packages/worker/src/lib/agent/lib/frontmatter.ts`](../../packages/worker/src/lib/agent/lib/frontmatter.ts) 신규:

```typescript
export interface ParsedFrontmatter {
  data: Record<string, unknown> | null;
  parseError?: string;
}

export function parseFrontmatter(contentMd: string): ParsedFrontmatter {
  const match = contentMd.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return { data: null };
  try {
    const yaml = await import("js-yaml");  // 동적 import 또는 의존성 추가
    const data = yaml.load(match[1]);
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { data: null, parseError: "frontmatter is not a key-value map" };
    }
    return { data: data as Record<string, unknown> };
  } catch (err) {
    return { data: null, parseError: err instanceof Error ? err.message : String(err) };
  }
}
```

**의존성 결정**: `js-yaml` 은 monorepo 어딘가 이미 있는지 먼저 확인 (publish-renderer 가 remark/rehype 쓰지만 frontmatter 처리 여부 확인). 없으면 `js-yaml@^4` 추가 (worker 패키지). 자체 정규식 파서는 정확도 손실이 커서 비추.

`__parseError` 필드 노출 정책:
- 파싱 성공 → `frontmatter: { ...data }`
- frontmatter 자체가 없음 → `frontmatter: null`
- 파싱 실패 → `frontmatter: null` + 응답 메타에 `parseError: "..."` (agent 가 인지)

## 4. find_backlinks ILIKE 패턴 (Tier 1)

대상 페이지의 `title` 과 `slug` 로 4종 패턴 매칭:

```sql
SELECT p.id, p.title, p.slug, pr.contentMd, ...
FROM pages p
JOIN page_revisions pr ON pr.id = p.current_revision_id
WHERE p.workspace_id = $1
  AND p.deleted_at IS NULL
  AND p.id != $2
  AND (
    pr.content_md ILIKE '%[[' || $3 || ']]%'           -- wikilink by title
    OR pr.content_md ILIKE '%[[' || $4 || ']]%'        -- wikilink by slug
    OR pr.content_md ~ ('\]\(' || $5 || '\)')          -- ](slug) markdown link
    OR pr.content_md ~ ('\]\(/[^)]*' || $5 || '\)')    -- ](/path/slug)
  )
ORDER BY p.last_ai_updated_at DESC NULLS LAST
LIMIT $6 + 1;                                          -- +1 to detect "limited"
```

`matchType` 분류는 메모리에서 결과 contentMd 를 다시 정규식으로 검사해 정확히 어느 패턴이 매치됐는지 결정 (성능 허용 범위 — limit 30 기본).

snippet 추출: 매치 위치 ±50 자, `\n` 제거.

**예외 케이스 step-doc 에서 결정**:
- title 이 흔한 단어 (예: "AI", "API") 인 경우 false-positive 폭발. 길이 < 3 인 title 은 wikilink_title 패턴 비활성화 + warning 메타 반환.
- slug 가 다른 단어의 일부인 경우 (예: slug "test" 가 "testing" 안에) — 정규식에 `\b` (word boundary) 또는 `[\W]` lookahead 추가.

## 5. Quota assignments

[`packages/worker/src/lib/agent/dispatcher.ts`](../../packages/worker/src/lib/agent/dispatcher.ts) `DEFAULT_READ_TOOL_QUOTAS`:

```typescript
const DEFAULT_READ_TOOL_QUOTAS = {
  search_pages: 8,
  read_page: 20,
  list_folder: 10,
  find_related_entities: 8,
  list_recent_pages: 5,
  // 신규
  read_page_metadata: 30,        // 가벼운 read, 자주 호출 허용
  find_backlinks: 5,             // 무거운 ILIKE, 보수적
  read_revision_history: 10,
  read_revision: 30,
};
```

## 6. seenPageIds enforcement

| 도구 | seenPageIds 입력 검증 | 결과로 seenPageIds 갱신 |
|---|---|---|
| `read_page_metadata` | ✅ | ✅ (재확인) |
| `find_backlinks` | ✅ (입력 pageId) | ✅ (결과 모든 backlink page → seenPageIds 추가, 후속 read_page 허용) |
| `read_revision_history` | ✅ | revisionId 들을 `state.observedPageRevisionIds` 와 별도 `state.seenRevisionIds: Set<string>` (신규) 에 등록 |
| `read_revision` | revisionId 가 seenRevisionIds 에 있어야 함 OR 입력된 revisionId 의 page 가 seenPageIds 에 있고 그 페이지의 baseRevisionId chain 안에 있어야 함 | 본문 read 했으니 pageId/revisionId 등록 |

`seenRevisionIds: Set<string>` 신규 — `read_revision_history` 결과를 신뢰하는 chain 만들기 위함.

## 7. System prompt 갱신

[`packages/worker/src/lib/agent/loop.ts:50`](../../packages/worker/src/lib/agent/loop.ts#L50) `EXPLORE_SYSTEM_PROMPT` 에 가이드 한 단락 추가:

```
Use these read tools:
- read_page_metadata when you only need title/parent/timestamps. Saves tokens vs full read_page.
- find_backlinks before proposing delete_page or merge_pages — evaluate dependencies.
- read_revision_history + read_revision when self-correcting (i.e. before rollback_to_revision).
```

[`packages/worker/src/lib/agent/loop.ts:59`](../../packages/worker/src/lib/agent/loop.ts#L59) `PLAN_SYSTEM_PROMPT` 변경 없음 (read 도구는 explore phase 에서만 호출).

## 8. Discovered code constraints

- [`pages.ts:1164-1224`](../../packages/api/src/routes/v1/pages.ts#L1164) GET revisions endpoint 는 `RevisionSummaryDto` 를 반환. 이 타입은 [`packages/shared/src/schemas/`](../../packages/shared/src/schemas) 에 정의 — 그대로 재사용.
- [`packages/db/src/schema/revisions.ts`](../../packages/db/src/schema/revisions.ts) `pageRevisions` JOIN `revisionDiffs` (1:1) — `read_revision` SQL 그대로 활용.
- frontmatter 처리는 publish-renderer ([`packages/worker/src/workers/publish-renderer.ts`](../../packages/worker/src/workers/publish-renderer.ts)) 가 remark 로 한다. 그 파이프라인을 agent 도구에 가져오면 의존성 폭증 — 가벼운 자체 파서 + js-yaml 만 사용.

## 9. Reuse candidates

| 용도 | 함수/파일 |
|---|---|
| Revision summary fetch | [`pages.ts:1164-1224`](../../packages/api/src/routes/v1/pages.ts#L1164) → [`packages/api/src/lib/revision-history.ts`](../../packages/api/src/lib/revision-history.ts) (신규로 추출) |
| Latest-revision JOIN 패턴 | [`packages/db/src/page-deletion.ts`](../../packages/db/src/page-deletion.ts) (소프트 삭제 시 사용) |
| breadcrumb / parent path 구성 | 기존 페이지 탐색 endpoint 가 이미 비슷한 SQL 사용 — 재사용 |

## 10. Test fixtures

- 신규 `packages/worker/src/lib/agent/lib/frontmatter.test.ts` — 8개 케이스 (없음 / 정상 / 잘못된 YAML / 빈 / `\r\n` / `---` 만 / 본문 없는 / 매우 긴 frontmatter).
- 신규 `packages/worker/src/lib/agent/tools/read.test.ts` 확장 — 4 도구 단위 테스트.
- find_backlinks 회귀 fixture — 위키링크 / markdown link / 부분 매칭 / 짧은 title (false-positive 방어) / 같은 페이지 자기참조 제외.
- 통합: 한 ingestion 에서 `read_page → read_page_metadata → find_backlinks → plan` 순서로 시나리오 (shadow 모드).

## 11. Verification checklist

- [x] 4 agent tool 단위 테스트 통과
- [x] frontmatter parser — 8 케이스 모두 통과
- [x] find_backlinks — 위키링크 정확 매칭, false-positive 방어 (짧은 title)
- [x] find_backlinks — 결과의 backlink page 들이 seenPageIds 에 등록 → 후속 read_page 정상
- [x] read_revision_history — pagination, workspaceId 경계
- [x] read_revision — workspaceId 경계, 다른 페이지 revision 거부
- [x] dispatcher quota — 4 도구 모두 정확히 enforce
- [x] AISettingsPage diagnostics 에 4 도구 사용량 표시 (선택)

## 12. Open questions

- `js-yaml` 의존성 — worker 패키지 추가 vs shared (shared 가 더 자연스럽지만 frontend 번들에 들어갈지 여부 확인 필요).
- `find_backlinks` 의 정확도 한계를 plan turn 에 어떻게 전달할지 — 결과 메타에 `confidenceHint: "ILIKE-based; verify before destructive ops"` 같은 필드 추가?
- `read_revision` 시 `lineDiff` 가 매우 큰 경우 (수천 줄 변경) 잘라서 반환할지 — 본문은 자르지 않고 그대로 반환, agent budgeter 가 후속 처리.
- `seenRevisionIds` 와 `observedPageRevisionIds` 의 분리/통합 — 단일 데이터 구조로 가는 게 자연스럽지만 기존 코드 영향 클 수 있음.
