# UI Reference Implementation Plan

> 작성일: 2026-04-29
> 입력 자료: `design reference sources/`의 Vite 프로토타입, 스크린샷 PNG, SVG/PNG 에셋
> 목적: 참조 UI를 WekiFlow에 이식하되, 현재 제품에 없는 기능은 별도 백로그로 분리한다.

## 1. 참조 자료 요약

`design reference sources`는 독립 Vite/React 프로토타입이다. `src/App.jsx` 하나에 목업 데이터, 화면 컴포넌트, 인라인 스타일이 모두 들어 있으며 실제 API 연동은 없다. 화면 의도는 PNG 스크린샷 쪽이 더 신뢰 가능하다.

참조 화면:

- `데시보드.png`: 홈 대시보드, AI 자동 반영/확인 필요 카드, 폴더별 위키 현황
- `신규지식.png`: 신규 학습/검토 큐, 좌측 리스트와 우측 결정 상세, AI 판단 이유와 변경 내용
- `전사위키.png`: 폴더별 문서 테이블, 챗봇 반영 상태, 등록 방법, 최근 변경
- `지식 등록하기.png`: 저장 위치 선택, 파일/웹/직접 입력/외부 연동 탭
- `학습 기록.png`: AI/사용자 활동 타임라인
- `시스템 상태.png`: 7단계 처리 파이프라인 요약
- `페이지.png`: 폴더 상세 또는 문서 미리보기형 화면

에셋 분류:

- 사용 후보: `public/favicon.svg`, `public/icons.svg`의 로고/아이콘 심볼
- 참조 전용: 화면 PNG 7개
- 제외 후보: `src/assets/react.svg`, `src/assets/vite.svg`, `src/assets/hero.png`는 Vite 템플릿 성격이 강함

## 2. 현재 WekiFlow와의 매핑

| 참조 화면 | 현재 대응 | 상태 | 주요 차이 |
|---|---|---:|---|
| 대시보드 | `/`의 `PageListPage` | 신규 필요 | 현재는 단순 페이지 테이블. AI 자동 반영/확인 필요 카드와 폴더별 현황이 없음 |
| 신규 지식 | `/review`의 `ReviewQueuePage` | 부분 대응 | 검토 큐는 있음. 자동 반영 항목의 되돌리기 UX, 참조안 스타일의 상세 패널은 없음 |
| 전사 위키 | `/` + 사이드바 트리 | 부분 대응 | 폴더별 그룹 테이블, 등록 방법, 챗봇 반영 상태, 폴더 상세 라우트가 없음 |
| 지식 등록하기 | `/import`의 `ImportPage` | 대부분 대응 | 기능은 있음. 참조안 스타일과 상단 위치 선택 구조로 재정렬 필요 |
| 학습 기록 | `/activity`의 `ActivityPage` | 대부분 대응 | 데이터는 있음. 참조안의 타임라인형 표시와 요약 문구 보강 필요 |
| 시스템 상태 | `/admin/queues`의 `QueueHealthPage` | 부분 대응 | 큐 상세는 있음. 참조안의 7단계 파이프라인 요약 화면은 별도 필요 |
| 페이지/폴더 화면 | `PageEditorPage`, 사이드바 폴더 | 부분 대응 | 문서 편집기는 더 기능적이나 폴더 상세/문서 미리보기 화면은 없음 |
| 상단 검색/브레드크럼 | 부분적으로 각 페이지 내부 | 신규 공통화 필요 | 글로벌 `TopBar`, 검색 팝오버, 라우트별 브레드크럼 필요 |

## 3. 제품 원칙

1. `src/App.jsx`를 그대로 복사하지 않는다. 목업 데이터와 인라인 스타일을 제품 코드로 끌어오면 유지보수가 급격히 나빠진다.
2. 현재 기능이 이미 구현된 화면은 재구현하지 않고 스타일과 정보 구조만 재배치한다.
3. 참조안이 암시하는 신규 기능은 API/데이터 계약을 먼저 정의하고 작은 단위로 추가한다.
4. 모든 AI 관련 액션은 기존 `ingestion_decisions`, `page_revisions`, `audit_logs` 흐름을 유지한다.
5. 한국어/영어 i18n 키를 같이 추가한다. 참조 프로토타입의 한글 문자열은 인코딩이 깨진 부분이 있어 스크린샷 기준으로 재작성한다.

## 4. 구현 단계

### Phase 0 - 기준 정리와 디자인 토큰

목표: 화면을 바꾸기 전에 공통 레이아웃과 UI 원자를 만든다.

작업:

- `packages/web`에 아이콘 전략 결정
  - 권장: `lucide-react` 추가
  - 대안: 기존 문자/간단 SVG 유지, 단 디자인 완성도가 낮음
- 공통 토큰 추가
  - 색: 흰색 배경, warm gray 사이드바, 검정 본문, teal/blue/orange 상태색
  - 간격: 4/8px 계열, 카드 radius 8px 이하
  - 그림자: 참조안 수준의 절제된 shadow만 사용
- 공통 컴포넌트 추가
  - `TopBar`
  - `Badge`
  - `IconButton`
  - `SegmentedTabs`
  - `PageShell`
  - `StatusDot`
  - `PipelineStage`
- 글로벌 CSS 정리
  - 현재 `globals.css`가 사이드바/페이지/에디터 스타일을 모두 포함한다.
  - 대규모 변경 전에 `layout.css`, `ui.css`, `dashboard.css`, `wiki.css`, `system.css`처럼 화면별 파일로 분리한다.

검증:

- `pnpm --filter web typecheck`
- 기존 페이지가 스타일 분리 후에도 깨지지 않는지 Playwright smoke 확인

### Phase 1 - 기존 API로 가능한 UI 이식

목표: 새 백엔드 없이 가능한 화면부터 적용한다.

#### 1.1 사이드바 리디자인

현재 파일:

- `packages/web/src/components/layout/Sidebar.tsx`
- `packages/web/src/styles/globals.css`

작업:

- 참조안처럼 상단 브랜드, 워크스페이스 선택, 주요 메뉴, 문서 목록, 사용자 푸터로 구획을 명확히 나눈다.
- 메뉴명 매핑:
  - 대시보드: `/`
  - 신규 지식: `/review`
  - 전사 위키: `/wiki` 또는 기존 `/`에서 분리
  - 지식 등록하기: `/import`
  - 학습 기록: `/activity`
  - 시스템 상태: `/system`
  - 휴지통/관리 큐는 보조 메뉴로 유지
- 현재 구현된 폴더/페이지 트리, drag-and-drop, context menu는 유지한다.
- pending review badge는 `decisions.counts()` 기반으로 유지한다.

주의:

- 참조안에는 폴더 클릭 시 폴더 상세 화면이 열린다. 현재 폴더 클릭은 expand만 한다. 폴더 라우트 추가 전까지는 expand 동작을 유지한다.

#### 1.2 ImportPage 재배치

현재 파일:

- `packages/web/src/pages/ImportPage.tsx`
- `packages/web/src/components/import/DestinationPicker.tsx`
- `packages/web/src/components/import/ApiGuidePanel.tsx`
- `packages/web/src/styles/import.css`

작업:

- 참조안의 `지식 등록하기` 레이아웃으로 재배치한다.
- destination 영역을 페이지 상단 카드로 고정한다.
- 파일/웹 페이지/직접 입력/외부 연동 탭에 아이콘을 넣는다.
- 현재 기능은 유지한다.
  - 파일 업로드
  - URL 추출
  - 텍스트 입력
  - API 가이드
  - reconciliation 옵션
  - force refresh

추가하지 않을 것:

- 이 단계에서는 새 ingestion 기능을 만들지 않는다.
- API 토큰 생성/폐지는 Phase 4로 분리한다.

#### 1.3 ReviewQueuePage를 신규 지식 화면으로 정리

현재 파일:

- `packages/web/src/pages/ReviewQueuePage.tsx`
- `packages/web/src/components/review/ReviewDetail.tsx`
- `packages/web/src/styles/review.css`

작업:

- 페이지 제목을 `신규 지식`으로 바꾸되 라우트는 우선 `/review` 유지
- 탭을 참조안처럼 `전체`, `확인 필요`, `처리 실패`, 필요 시 `최근 처리`로 재구성
- 좌측 리스트 카드에 표시:
  - 상태: AI 자동 반영, 확인 필요, 처리 실패
  - confidence
  - 제목
  - sourceName
  - receivedAt/createdAt
  - conflict chip
- 우측 상세에 표시:
  - 제목
  - source chip
  - AI 판단 이유
  - proposed diff/content
  - `위키에서 보기`
  - approve/reject/edit target 액션

현재 API로 가능한 것:

- suggested/needs_review/failed/recent 조회
- decision detail
- approve/reject
- ingestion detail 링크

부족한 것:

- auto_applied 항목의 안전한 되돌리기 액션
- proposed content를 UI에서 직접 수정 후 승인

#### 1.4 ActivityPage를 학습 기록 타임라인으로 리디자인

현재 파일:

- `packages/web/src/pages/ActivityPage.tsx`
- `packages/web/src/styles/activity.css`

작업:

- 필터는 유지하되 화면 기본 형태를 타임라인으로 바꾼다.
- 각 row는 `AI/User/System chip + actor + action + target + time + summary` 구조로 표시한다.
- page/ingestion link는 유지한다.

현재 API로 가능한 것:

- actor, action, entity, ingestion context

부족한 것:

- 변경 요약, 변경 block 수, diff summary는 `activity` DTO에 없음.
- Phase 3에서 `audit_logs.afterJson` 요약 또는 revision diff join을 보강한다.

#### 1.5 QueueHealthPage와 별개로 시스템 상태 요약 화면 추가

현재 파일:

- `packages/web/src/pages/QueueHealthPage.tsx`
- `packages/api/src/routes/v1/admin-queues.ts`

작업:

- `/admin/queues`는 상세 운영 화면으로 유지한다.
- 새 `/system` 화면은 참조안처럼 7단계 요약만 보여준다.
- 초기 구현은 `adminQueues.overview()`의 queue counts를 매핑한다.

권한:

- admin/owner: 숫자 상세 표시
- editor/viewer: 전체 상태 또는 "권한 필요" 메시지 표시

## 5. Phase 2 - 라우팅과 정보 구조 개편

목표: 대시보드, 전사 위키, 폴더 상세, 상단 검색을 제품 정보 구조로 편입한다.

### 2.1 글로벌 TopBar

새 파일 후보:

- `packages/web/src/components/layout/TopBar.tsx`
- `packages/web/src/components/layout/Breadcrumbs.tsx`
- `packages/web/src/components/search/GlobalSearchBox.tsx`

작업:

- `WorkspaceLayout`에 `TopBar`를 추가한다.
- 라우트별 breadcrumb 생성:
  - `/`: workspace > 대시보드
  - `/review`: workspace > 신규 지식
  - `/wiki`: workspace > 전사 위키
  - `/folders/:folderId`: workspace > 전사 위키 > folder
  - `/pages/:pageId`: workspace > 전사 위키 > parent chain > page
  - `/import`: workspace > 지식 등록하기
  - `/activity`: workspace > 학습 기록
  - `/system`: workspace > 시스템 상태
- 검색 팝오버는 기존 `pages.search()`를 사용한다.
- debounce 150-250ms 적용.
- 검색 결과는 제목, excerpt, 상태, 최근 변경일을 표시한다.

API 보강 후보:

- `pages.search()` 결과에 `excerpt`, `parentFolderId`, `parentPageId` 포함
- 가능하면 `rank`와 highlight snippet 추가

### 2.2 DashboardPage 추가

새 파일 후보:

- `packages/web/src/pages/DashboardPage.tsx`
- `packages/web/src/styles/dashboard.css`

라우팅:

- `/`를 `DashboardPage`로 변경
- 기존 `PageListPage`는 `/wiki`로 이동하거나 `WikiPage`로 대체

초기 데이터 조합:

- `decisions.counts(workspaceId)`로 확인 필요 카드
- `decisions.list(workspaceId, { status: ["auto_applied"], sinceDays: 1 })`로 최근 자동 반영 카드
- `folders.list(workspaceId, { limit: 200 })`
- `pages.list(workspaceId, { limit: 200 })`

표시:

- 사용자 이름 기반 greeting
- 자동 반영 수
- 확인 필요 수
- 폴더별 문서 목록
- 최근 AI 작성/수정 badge

성능 후속:

- 페이지/폴더가 많아지면 `GET /workspaces/:id/dashboard` 집계 endpoint로 교체한다.

### 2.3 WikiPage와 FolderPage 추가

새 파일 후보:

- `packages/web/src/pages/WikiPage.tsx`
- `packages/web/src/pages/FolderPage.tsx`
- `packages/web/src/styles/wiki.css`

라우팅:

- `/wiki`: 전사 위키 전체
- `/folders/:folderId`: 폴더 상세

WikiPage 표시:

- 폴더별 그룹
- 컬럼:
  - 제목
  - 반영 상태
  - 등록 방법
  - 최근 변경
- 새 문서 만들기 버튼

FolderPage 표시:

- 폴더 제목/설명
- 해당 폴더의 직접 하위 문서
- 필요 시 하위 폴더 섹션
- 문서 preview는 너무 무거우면 처음에는 제목/요약만 표시

현재 API로 가능한 것:

- 폴더/페이지 트리 구성
- status, updatedAt

부족한 것:

- 등록 방법: 최신 revision의 `actorType/source/sourceIngestionId` 필요
- "챗봇 반영" 상태: 제품 의미 정의 필요
  - 1차 가정: `page.status === "published"`면 반영됨
  - 장기적으로는 search index/bot index 반영 상태를 별도 추적해야 함

## 6. Phase 3 - API/DTO 보강

목표: 참조 UI가 요구하는 상태와 요약 데이터를 일관된 API로 제공한다.

### 3.1 Page summary DTO 확장

현재 `Page` DTO는 최신 revision의 작성 주체와 source를 제공하지 않는다.

추가 후보:

```ts
interface PageSummaryMeta {
  latestRevisionActorType: "user" | "ai" | "system" | null;
  latestRevisionSource: string | null;
  latestRevisionCreatedAt: string | null;
  latestRevisionSourceIngestionId: string | null;
  latestRevisionSourceDecisionId: string | null;
  publishedAt: string | null;
  isLivePublished: boolean;
}
```

사용처:

- DashboardPage의 "방금 학습됨", "AI 자동"
- WikiPage의 "등록 방법"
- FolderPage의 문서 요약
- TopBar search result

구현 위치:

- `packages/api/src/routes/v1/pages.ts`
- `packages/web/src/lib/api-client.ts`
- 필요 시 `@wekiflow/shared` DTO 타입

### 3.2 Dashboard aggregate endpoint

대규모 워크스페이스에서 클라이언트가 여러 endpoint를 병렬 호출하지 않도록 집계 endpoint를 둔다.

Endpoint 후보:

```http
GET /api/v1/workspaces/:workspaceId/dashboard
```

응답 후보:

```ts
interface DashboardDto {
  counts: {
    pages: number;
    folders: number;
    pendingDecisions: number;
    autoAppliedToday: number;
    failedDecisions: number;
  };
  recentAutoApplied: DecisionListItem[];
  pendingPreview: DecisionListItem[];
  folders: Array<{
    folder: Folder;
    pageCount: number;
    pages: Array<Page & PageSummaryMeta>;
  }>;
}
```

### 3.3 Activity summary 보강

현재 `ActivityItem`은 action/entity 중심이다. 참조안처럼 "무엇을 배웠는지"를 보여주려면 요약이 필요하다.

추가 후보:

```ts
interface ActivityItem {
  summary: string | null;
  changedBlocks: number | null;
  decisionConfidence: number | null;
  sourceName: string | null;
}
```

데이터 소스:

- `audit_logs.afterJson.revisionId`
- `revision_diffs.changed_blocks`
- `ingestion_decisions.confidence`
- `ingestions.source_name`
- `page_revisions.revision_note`

### 3.4 System pipeline summary endpoint

참조안의 7단계는 BullMQ queue와 바로 1:1 매핑되지 않는다. API에서 제품 언어로 변환한다.

Endpoint 후보:

```http
GET /api/v1/workspaces/:workspaceId/system/pipeline
```

단계 매핑 후보:

| UI 단계 | 내부 데이터 후보 |
|---|---|
| 받기 | ingestion queue waiting/active + 최근 pending ingestions |
| 분석 | route-classifier 처리 중/대기 |
| 통합 | patch queue waiting/active |
| 정리 | reformat queue waiting/active |
| 반영 | auto apply/publish queue waiting/active |
| 색인 | search queue waiting/active |
| 연결 | extraction queue waiting/active |

권한:

- admin/owner만 상세 count
- 그 외 role은 `overallStatus`만 제공하거나 403

## 7. Phase 4 - 참조 UI가 암시하는 신규 기능

이 단계는 단순 UI 이식이 아니라 제품 기능 추가다.

### 4.1 자동 반영 되돌리기

참조안 `신규 지식`에는 AI가 자동 반영한 항목을 "되돌리기" 할 수 있는 UX가 있다.

케이스:

- create auto-applied: 생성된 페이지를 soft-delete하거나 "undo revision" 처리
- update/append auto-applied: base revision으로 rollback revision 생성
- noop: 되돌릴 내용 없음

필요 API:

```http
POST /api/v1/workspaces/:workspaceId/decisions/:decisionId/undo
```

요구사항:

- undo도 새 revision 또는 audit log로 추적
- hard overwrite 금지
- 이미 사람이 후속 편집한 경우 conflict warning 필요
- create undo는 페이지 soft-delete가 적절한지 제품 결정 필요

### 4.2 결정 target override UI 완성

`PATCH /decisions/:id`는 이미 존재한다. UI가 부족하다.

작업:

- Review detail/ingestion detail에 page search dropdown 추가
- action 변경: create/update/append/noop/needs_review
- target 변경 시 proposed revision이 무효화되는 점을 UI에 명확히 표시

### 4.3 수정 후 승인

참조안에는 "수정 후 가르치기"에 가까운 UX가 있다. 현재는 proposed markdown을 직접 수정해서 승인할 수 없다.

옵션:

- 단기: target/action/title만 수정 허용
- 중기: proposed content editor 제공
- 승인 시 수정된 content를 새 AI+human reviewed revision으로 저장

필요 데이터:

- decision draft content
- reviewer edit diff
- audit log before/after

### 4.4 API token management

참조안의 외부 연동 탭을 실제 온보딩 기능으로 만들려면 토큰 관리가 필요하다.

라우트 후보:

- `/settings/tokens`
- 또는 `/system/tokens`

기능:

- token list
- create with one-time reveal
- revoke
- scopes
- last used at
- source name hint

기존 백로그의 S4-4와 동일한 작업이다.

### 4.5 챗봇 반영 상태 정의

참조안의 "챗봇 반영"은 현재 WekiFlow 데이터 모델에 직접 대응하지 않는다.

결정 필요:

- "반영됨"을 published snapshot으로 볼 것인가
- search index updater 완료로 볼 것인가
- 외부 챗봇/RAG index 동기화 상태를 별도 테이블로 둘 것인가

권장:

- 1차 UI: `published`를 "공개 반영"으로 표시
- 추후: `bot_index_entries` 또는 `search_index_jobs` 상태를 추가해 "챗봇 반영"으로 분리

## 8. 테스트 계획

단위/컴포넌트:

- `DashboardPage` 데이터 빈 상태, pending 상태, auto-applied 상태
- `WikiPage` 폴더 없는 상태, 폴더/페이지 그룹 정렬
- `GlobalSearchBox` debounce, 결과 클릭 navigation
- `ReviewQueuePage` approve/reject/target edit
- `SystemStatusPage` admin/non-admin 상태

API:

- dashboard aggregate endpoint role guard
- page summary DTO latest revision join
- activity summary join
- system pipeline endpoint admin guard
- decision undo conflict guard

E2E/visual:

- desktop: 1120x900 참조 스크린샷 기준 레이아웃
- mobile: 390x844 사이드바 drawer, TopBar search collapse
- 핵심 플로우:
  - import text -> decision appears in 신규 지식
  - approve -> wiki/dashboard/activity updates
  - auto-applied decision -> detail -> wiki link
  - system status loads for admin

명령:

```bash
pnpm --filter web typecheck
pnpm --filter web test
pnpm --filter api test
pnpm test
```

## 9. 권장 PR 분할

1. PR 1: 디자인 토큰, 공통 UI 컴포넌트, Sidebar shell restyle
2. PR 2: TopBar/search/breadcrumb, DashboardPage 기본 구현
3. PR 3: ImportPage, ActivityPage, ReviewQueuePage 참조 레이아웃 적용
4. PR 4: WikiPage/FolderPage 라우트와 폴더별 테이블
5. PR 5: Page summary DTO, dashboard aggregate endpoint, activity summary 보강
6. PR 6: SystemStatusPage와 pipeline summary endpoint
7. PR 7: decision undo, target override UI, API token management

## 10. 우선순위

P0:

- 사이드바/TopBar/디자인 토큰
- DashboardPage
- ReviewQueuePage를 신규 지식 화면으로 정리
- ImportPage 재배치

P1:

- WikiPage/FolderPage
- Activity timeline
- SystemStatus summary
- Page summary DTO

P2:

- auto-applied undo
- target override UI
- API token management
- 챗봇 반영 상태 정식화

## 11. 리스크와 결정 사항

- `lucide-react` 추가 여부: 참조 UI 품질을 맞추려면 추가가 가장 간단하다.
- `챗봇 반영` 의미: 현재 모델에는 정확히 대응되는 상태가 없다. 제품 용어를 먼저 확정해야 한다.
- 대시보드 데이터 로딩: 초기에는 기존 endpoint 조합으로 충분하지만, 워크스페이스가 커지면 aggregate endpoint가 필요하다.
- decision undo: 데이터 보존 원칙 때문에 단순 삭제가 아니라 revision/audit 기반으로 설계해야 한다.
- 참조 코드 인코딩: `App.jsx`의 한글 문자열 일부가 깨져 있으므로 텍스트는 스크린샷 기준으로 재작성한다.
- 스타일 적용 범위: 기존 editor/graph/revision 기능은 참조안보다 더 앞서 있으므로 기능을 줄이지 않는다.
