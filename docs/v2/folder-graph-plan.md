# Folder-scoped knowledge graph (FolderPage Graph 탭)

> **상태**: 계획 (2026-05-05)
> **유형**: 단일 feature RFC (UI/시각화 stream — 기존 v2 agent autonomy 묶음과 별도)
> **모티브**: "폴더 선택 시 그 안의 entity 관계 전체를 한눈에" — 페이지 단위 그래프의 폴더 단위 일반화

## Context

지금까지 knowledge graph 시각화는 **개별 페이지 단위**로만 가능했다. `GET /workspaces/:wsId/pages/:pageId/graph` 가 `triples.source_page_id = pageId` 를 시드로 BFS 를 돌려 그 페이지 1개의 entity-predicate 그래프를 반환하고, [`packages/web/src/components/graph/GraphPanel.tsx`](../../packages/web/src/components/graph/GraphPanel.tsx) 가 그것만 그린다. 폴더에 페이지가 많을수록 "이 폴더 전체가 어떤 개념들로 구성됐는가" 를 한눈에 볼 수 없다는 게 흠이다.

이번 변경의 목표: **폴더를 선택했을 때, 그 폴더(및 하위 폴더/하위 페이지) 안에서 추출된 triple 들로 구성된 closed entity 그래프를 [`packages/web/src/pages/FolderPage.tsx`](../../packages/web/src/pages/FolderPage.tsx) 안의 새 "Graph" 탭에서 보여준다.** "Closed" 의 정확한 정의 — **폴더 바깥 페이지에서 추출된 triple 은 노드/엣지 모두에 포함하지 않는다**.

### 사용자 결정 사항

1. 그래프 종류 = **엔티티/triple 그래프** (page_links 가 아님)
2. 범위 = **closed** (폴더 안 ↔ 폴더 안)
3. 위치 = **FolderPage 안의 새 탭**

### v2 묶음과의 관계

본 RFC 는 agent autonomy / 도구 surface 와 **무관한 UX 개선**이다. v2 폴더에 두는 이유는 동시대 작업이라는 분류상의 편의일 뿐, sprint 시퀀싱(S1~S5)에 종속되지 않으며 어느 시점에든 병행 진행 가능하다.

## 핵심 파일 / 재사용

| 파일 | 역할 |
|---|---|
| [`packages/api/src/routes/v1/pages.ts`](../../packages/api/src/routes/v1/pages.ts) (라인 2042-2336) | 기존 페이지 graph 핸들러 — 시드/BFS/truncate/edges 조립 로직. 이 알고리즘을 helper 로 추출 후 재사용 |
| [`packages/api/src/routes/v1/folders.ts`](../../packages/api/src/routes/v1/folders.ts) | 신규 핸들러를 등록할 곳 |
| [`packages/db/src/page-deletion.ts`](../../packages/db/src/page-deletion.ts) (라인 133, `collectDescendantPageIds`) | 페이지 자손용 — 폴더 자손에는 사용 불가, 폴더용 helper 신규 |
| [`packages/db/src/schema/pages.ts`](../../packages/db/src/schema/pages.ts) (라인 23, 60, 106) | `folders.parentFolderId` / `pages.parentFolderId` / `pages.parentPageId` (single-parent CHECK) — 재귀 SQL 의 모델 |
| [`packages/web/src/components/graph/GraphPanel.tsx`](../../packages/web/src/components/graph/GraphPanel.tsx) (라인 26-31) | Props 를 `pageId` → discriminated union 으로 확장 |
| [`packages/web/src/pages/FolderPage.tsx`](../../packages/web/src/pages/FolderPage.tsx) | List/Graph 탭 UI 추가 |
| [`packages/shared/src/types/graph.ts`](../../packages/shared/src/types/graph.ts) (라인 19-29) | `GraphData.meta` 에 `scope: "page" \| "folder"` 와 optional `folderId` 추가 |
| [`packages/web/src/lib/api-client.ts`](../../packages/web/src/lib/api-client.ts) | `foldersApi.graph()` 추가 |

## 구현 계획

### 1. DB helper — 폴더 자손 페이지 ID 수집 (신규)

**파일**: `packages/db/src/folder-pages.ts` (신규).

```ts
export async function collectFolderDescendantPageIds(
  db: AnyDb,
  workspaceId: string,
  rootFolderId: string,
  opts?: { includeDeleted?: boolean },
): Promise<string[]>
```

SQL — 두 단계 재귀:

```sql
WITH RECURSIVE folder_tree AS (
  SELECT id FROM folders
  WHERE id = $rootFolderId AND workspace_id = $ws
  UNION ALL
  SELECT f.id FROM folders f
  JOIN folder_tree t ON f.parent_folder_id = t.id
  WHERE f.workspace_id = $ws
),
folder_pages AS (
  -- 폴더에 직속한 페이지
  SELECT p.id FROM pages p
  WHERE p.workspace_id = $ws
    AND p.parent_folder_id IN (SELECT id FROM folder_tree)
    AND (deleted_at IS NULL OR $includeDeleted)
  UNION ALL
  -- parent_page_id 로 매달린 자손 페이지
  SELECT p.id FROM pages p
  JOIN folder_pages fp ON p.parent_page_id = fp.id
  WHERE p.workspace_id = $ws
    AND (deleted_at IS NULL OR $includeDeleted)
)
SELECT DISTINCT id FROM folder_pages;
```

`pages.parent_page_id` 와 `pages.parent_folder_id` 는 mutually exclusive (CHECK `pages_single_parent_chk`) — 폴더 안의 페이지 트리는 root 페이지가 `parent_folder_id`, 그 자손은 `parent_page_id` 체인이라는 것이 전제.

### 2. API — 신규 엔드포인트 `GET /folders/:folderId/graph`

**파일**: `packages/api/src/routes/v1/folders.ts`.

**쿼리 스키마**: `pages.ts` 의 `graphQuerySchema` 재사용 (`depth`, `limit`, `minConfidence`, `locale`).

#### 핵심 로직 — pages.ts 의 graph 핸들러를 helper 로 추출

`packages/api/src/lib/graph-builder.ts` (신규) 로 BFS / truncate / edge-assembly 를 다음 시그니처로 추출:

```ts
export async function buildEntityGraph(
  db: AnyDb,
  args: {
    workspaceId: string;
    seedPageIds: string[];          // 페이지 모드: [pageId], 폴더 모드: 폴더 자손 전부
    depth: 1 | 2;
    limit: number;
    minConfidence: number;
    locale: SupportedLocale;
    /** Closed 모드. true 이면 BFS edge 와 최종 edge query 모두
     *  source_page_id IN seedPageIds 로 제한 */
    restrictToSeedScope: boolean;
  },
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }>
```

#### Closed 그래프 구현 핵심

- **시드 entities**: `triples.source_page_id IN seedPageIds AND status='active' AND confidence >= minConfidence` 의 subject/object entity 들.
- **BFS 이웃 확장** (`pages.ts` 라인 2120-2167) 에 `restrictToSeedScope` 일 때 `triples.source_page_id IN seedPageIds` 제약 추가 — 폴더 밖 페이지의 triple 로는 BFS 가 뻗어나가지 못함.
- **최종 `edgeRows` 쿼리** (`pages.ts` 라인 2269-2290) 에도 `restrictToSeedScope` 일 때 `inArray(triples.sourcePageId, seedPageIds)` 추가.
- **`pageCountRows`**: closed 스코프에서 페이지 카운트는 폴더 안 페이지 등장 횟수만 의미하도록 동일 제약 추가.

#### 기존 페이지 핸들러 위임

`pages.ts` 의 graph 핸들러도 이 helper 를 호출하도록 변경 (`seedPageIds=[pageId]`, `restrictToSeedScope=false`). 동작 동일성은 기존 통합 테스트로 보증.

#### Folder graph 핸들러 흐름

1. `getMemberRole` 권한 확인. 비-멤버는 403.
2. `collectFolderDescendantPageIds` 호출.
3. 결과 빈 배열이면 빈 graph 응답 (200, `{ nodes:[], edges:[], meta:{ scope:"folder", folderId, depth, totalNodes:0, totalEdges:0, truncated:false } }`).
4. 페이지 ID 가 매우 많으면 (예: > 5000) — **MVP 는 그대로 진행**, 운영 데이터로 임계 결정. 후속 모니터링 항목.
5. `buildEntityGraph` 호출 후 응답 조립.

### 3. Shared 타입 변경

`packages/shared/src/types/graph.ts` 의 `GraphData.meta` 를:

```ts
meta: {
  scope: "page" | "folder";
  pageId?: string;     // scope === "page" 일 때만
  folderId?: string;   // scope === "folder" 일 때만
  depth: number;
  totalNodes: number;
  totalEdges: number;
  truncated: boolean;
}
```

`scope` 를 명시 필드로 두어 클라이언트 분기 가능하게. 기존 `pageId` 컨슈머는 `meta.scope === "page"` 가드 후 사용.

### 4. Frontend — api-client 확장

`packages/web/src/lib/api-client.ts` 의 `folders` 객체에 추가:

```ts
graph(workspaceId: string, folderId: string, opts: GraphQueryOpts): Promise<GraphData>
```

### 5. GraphPanel — 폴더 모드 지원

`GraphPanel.tsx` props 를 discriminated union 으로:

```ts
type GraphPanelProps =
  | { mode: "page";   workspaceId: string; pageId: string;
      onClose: () => void; onNavigateToPage: (id: string) => void }
  | { mode: "folder"; workspaceId: string; folderId: string;
      onClose: () => void; onNavigateToPage: (id: string) => void };
```

내부 `useEffect` (라인 175-191) 의 fetcher 분기:

```ts
const fetcher = props.mode === "page"
  ? () => pagesApi.graph(workspaceId, props.pageId, opts)
  : () => foldersApi.graph(workspaceId, props.folderId, opts);
```

`useEffect` dependency array 에 `mode + (pageId | folderId)` 등록.

`NodeInspector` 의 `currentPageId` (라인 605) 는 폴더 모드에서 `null` 허용 → `NodeInspector` 도 currentPageId optional 처리 (현재 페이지 강조 로직만 비활성).

### 6. FolderPage — Graph 탭 추가

`FolderPage.tsx`:

- 상태 추가: `const [tab, setTab] = useState<"list" | "graph">("list")`. URL 동기화는 `useSearchParams("tab")` 로.
- 헤더 영역 아래 탭 UI (List / Graph). 기존 컨텐츠는 List 탭으로 이동.
- Graph 탭 활성 시:
  ```tsx
  <GraphPanel
    mode="folder"
    workspaceId={current.id}
    folderId={folderId}
    onClose={() => setTab("list")}
    onNavigateToPage={(id) => navigate(`/pages/${id}`)}
  />
  ```
- GraphPanel 의 닫기 버튼은 폴더 모드에선 List 탭으로 돌아가는 동작.
- 빈 폴더(페이지 0개) 면 GraphPanel 의 기본 empty state ("No graph data") 가 그대로 보임.

### 7. i18n

`pages` 또는 새 `graph` 네임스페이스에 키 추가 (한/영):

- `wiki.tabList`
- `wiki.tabGraph`
- `wiki.folderGraphEmpty`

## 비범위 (Out of scope)

- **페이지 ↔ 페이지 wikilink 그래프 (page_links 기반)** — 사용자가 명시적으로 entity/triple 모드를 선택. 후속 RFC 에서 별개 모드로 검토 ([`page-link-extraction-rfc.md`](page-link-extraction-rfc.md) 와 별개 stream).
- **폴더 바깥과의 1-hop ghost 노드** — closed 만 선택. 후속 옵션으로 고려 가능.
- **Broken link 토글** — page_links 모드 한정 기능, 본 변경 범위 밖.
- **그래프 캐싱** — 폴더가 클 경우 응답이 무거울 수 있으나 MVP 는 매 요청 계산. 후속 모니터링 후 결정.

## 검증

### 단위 테스트

1. `collectFolderDescendantPageIds` — 픽스처: 폴더 A → 하위 폴더 B + 페이지 P1 (`parent_folder_id=A`), B 안의 P2, P2 의 자식 페이지 P3 (`parent_page_id=P2`). Expected: `[P1, P2, P3]`. 다른 워크스페이스의 폴더는 절대 포함 안 됨.
2. `buildEntityGraph` — `restrictToSeedScope: true` 로 호출 시 폴더 밖 페이지에서 추출된 triple 의 subject 가 시드 entity 와 동일하더라도 결과 nodes/edges 에 포함되지 않는지.
3. Pages graph 라우트 — helper 추출 후에도 기존 통합 테스트가 그대로 통과 (회귀 없음).

### API 통합 테스트

`packages/api/src/routes/v1/folders.test.ts` (또는 신규):

1. 폴더에 페이지 0개 → `nodes:[], edges:[], meta.scope="folder", truncated:false`.
2. 폴더 안 P1, P2 가 entity E1, E2, E3 로 triple 을 가지고, 폴더 밖 P3 가 E1↔E4 triple 보유 → 응답에 E4 가 **없음**.
3. 권한: 비-멤버 사용자 → 403.

### E2E 수동 검증

1. dev server 실행 (`pnpm --filter web dev` + `pnpm --filter api dev`).
2. 폴더가 있는 워크스페이스에서 사이드바 → 폴더 클릭 → URL `/folders/:id`.
3. 새 "Graph" 탭 클릭 → 그래프 렌더링 확인.
4. 노드 클릭 → NodeInspector 열림, 페이지 네비게이션 동작.
5. 폴더 밖 페이지의 entity 가 보이지 않는지 시각 검증 (테스트 데이터로 비교).
6. depth 1/2 토글 정상 동작.

### 회귀 검증

- 기존 페이지 그래프 (`/pages/:id` 의 GraphPanel) 동작 변화 없음.

## 영향 범위

- `@wekiflow/db` — 신규 helper 1개 (`folder-pages.ts`).
- `@wekiflow/api` — 신규 엔드포인트 + helper 추출 (기존 핸들러 위임).
- `@wekiflow/shared` — `GraphData.meta` 타입 확장 (소비자 보강 필요).
- `@wekiflow/web` — api-client + GraphPanel props + FolderPage 탭 + i18n.

DB 스키마 변경 / 마이그레이션 / 워커 변경 / 큐 잡 변경은 **없음**.
