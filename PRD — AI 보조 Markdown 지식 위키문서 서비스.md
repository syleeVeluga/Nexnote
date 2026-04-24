# PRD — AI 보조 Markdown 지식 위키/문서 서비스

## 1. 제품 한 줄 정의

외부 AI 에이전트와 사람이 함께 문서를 만들고, 수정하고, 연결하고, publish할 수 있는 Markdown 기반 지식 위키 플랫폼.

## 2. 문제 정의

현재 요구사항은 크게 네 가지 축으로 나뉩니다.

1. 사람은 VS Code/Notion 같은 경험으로 문서를 쉽게 작성해야 한다.
2. 외부 AI는 POST API로 지식을 넣고, 시스템은 그 내용을 분석해 새 페이지를 만들거나 기존 페이지를 수정해야 한다.
3. 문서 내용에서 triple을 추출해 별도 저장하고, 이를 이용해 우측 graph 패널과 문서 연결 경험을 제공해야 한다.
4. publish 후에는 GitBook 같은 외부 공개 문서 서비스처럼 동작해야 한다.

핵심 문제는 “문서 편집기”, “AI 자동 편집”, “지식 추출”, “문서 publish”가 각각 따로 노는 것이 아니라, 하나의 revision/audit 체계 안에서 일관되게 움직여야 한다는 점입니다.

## 3. 제품 목표

### 비즈니스 목표

* AI가 들어오는 지식을 문서 자산으로 누적한다.
* 문서를 단순 노트가 아니라 publish 가능한 knowledge base로 만든다.
* page 간 관계를 triple/graph로 시각화해 탐색성을 높인다.

### 사용자 목표

* 사용자는 폴더 트리 안에서 빠르게 페이지를 만들고 편집할 수 있다.
* AI가 수정한 부분을 눈으로 확인하고 수용/거절할 수 있다.
* 외부 AI가 보낸 정보가 새 문서 또는 기존 문서 업데이트로 자연스럽게 반영된다.
* publish 후 외부 사용자에게 공유 가능한 URL을 즉시 얻는다.

## 4. 핵심 사용자

### 4.1 Author / Editor

직접 문서를 작성하고 AI 편집을 검토하는 사용자.

### 4.2 External AI Agent

POST API를 통해 텍스트/컨텐츠를 넣는 외부 시스템.

### 4.3 Reviewer / Admin

AI 자동 수정 정책, publish, rollback, API 토큰을 관리하는 사용자.

### 4.4 Public Reader

publish된 문서를 외부 URL로 읽는 사용자.

## 5. MVP에서 고정할 제품 가정

* 최상위 단위는 **Workspace**다.
* Workspace 아래에 **Folder / Page** 계층이 있다.
* Page의 저장 정본은 **Markdown + frontmatter**다.
* 에디터 내부에서는 block editor용 JSON snapshot을 같이 저장할 수 있다.
* AI는 문서를 직접 수정할 수 있지만, **모든 변경은 revision으로 기록**된다.
* publish는 draft를 직접 노출하지 않고, **published snapshot**을 별도로 만든다.
* triple 추출은 save, AI apply, publish, ingest 시점마다 비동기로 수행한다.
* Graph DB는 사용하지 않고 PostgreSQL의 relational schema로 triple을 저장한다.

## 6. 주요 사용자 시나리오

### S1. 사용자가 새 문서를 직접 작성한다

1. 사용자는 좌측 폴더 트리에서 새 페이지를 생성한다.
2. 본문은 block editor로 작성한다.
3. 필요하면 Markdown source mode로 전환해 raw md를 직접 수정한다.
4. autosave가 동작하고 revision이 생성된다.
5. 우측 graph 패널은 현재 문서에서 추출된 triple과 연결 페이지를 보여준다.

성공 기준: 새 페이지 생성부터 첫 저장까지의 흐름이 끊기지 않고, block mode와 source mode가 같은 문서를 바라본다.

### S2. 사용자가 AI에게 선택 영역 수정을 요청한다

1. 사용자는 문단/블록/섹션을 선택한다.
2. “요약”, “더 자세히”, “문체 변경”, “사실 기반으로 정리”, “관련 문서 링크 추가” 같은 AI 액션을 실행한다.
3. AI는 변경안을 스트리밍으로 만든다.
4. UI는 변경 라인 또는 block diff를 시각화한다.
5. 사용자는 accept/reject 또는 부분 수락을 선택한다.
6. 적용 시 revision과 AI run log가 함께 저장된다.

성공 기준: AI 수정 내역이 사람이 읽을 수 있는 diff 형태로 남는다.

### S3. 외부 AI가 POST API로 새 지식을 보낸다

1. 외부 AI가 `/api/v1/ingestions`로 내용을 전송한다.
2. 시스템은 payload를 저장하고 analyze job을 큐에 넣는다.
3. AI 라우터가 “새 페이지 생성 / 기존 페이지 수정 / 기존 페이지 하단 append / noop / review 필요”를 판단한다.
4. 결과에 따라 draft revision 또는 새 draft page가 생성된다.
5. triple 추출이 수행된다.
6. 관련 페이지 graph에 반영된다.

성공 기준: 외부 입력이 유실되지 않고, 적절한 page action으로 연결된다.

### S4. 외부 AI가 기존 문서를 업데이트한다

1. 시스템은 제목 유사도, triple overlap, keyword search 결과를 기반으로 후보 페이지를 찾는다.
2. LLM이 target page를 선택하고 patch를 생성한다.
3. patch는 기존 revision 위에 적용되고 변경 diff가 남는다.
4. 충돌 시 auto-merge 대신 review queue로 보낸다.

성공 기준: 기존 문서를 덮어쓰지 않고, 추적 가능한 방식으로 업데이트한다.

### S5. 사용자가 graph를 통해 관련 지식을 탐색한다

1. 사용자가 현재 페이지를 열면 우측 패널에 관련 entity/node가 표시된다.
2. 특정 node를 클릭하면 관련 triple과 연결 페이지를 본다.
3. node 클릭으로 해당 페이지 또는 관련 revision으로 이동한다.

성공 기준: graph가 단순 장식이 아니라 탐색 도구로 기능한다.

### S6. 사용자가 변경 이력을 검토하고 복원한다

1. 페이지의 revision 히스토리를 연다.
2. 특정 revision의 diff, 작성 주체(user/ai/system), source(API/editor), 생성 시각을 확인한다.
3. 이전 revision으로 rollback하거나 새 revision으로 재적용한다.

성공 기준: AI가 잘못 수정해도 원복이 쉽다.

### S7. 사용자가 문서를 publish한다

1. 사용자는 draft 상태 페이지를 검토한다.
2. publish를 실행한다.
3. 시스템은 published snapshot을 만든다.
4. public URL을 발급한다.
5. 외부 사용자는 인증 없이 문서를 본다.

성공 기준: published 문서는 안정적인 URL과 snapshot 버전을 가진다.

## 7. 기능 요구사항

## 7.1 Workspace / Navigation

* 좌측 패널은 VS Code식 폴더 트리를 제공해야 한다.
* Folder / Page 생성, 이름 변경, 이동, 정렬, drag & drop을 지원해야 한다.
* 페이지 경로는 slug 기반으로 관리해야 한다.
* 최근 문서, 즐겨찾기, AI가 생성한 draft inbox를 제공해야 한다.

## 7.2 Editor

* block editor와 Markdown source mode를 모두 지원해야 한다.
* 최소 지원 블록:

  * heading
  * paragraph
  * bold / italic / strike / inline code / link
  * bulleted list / numbered list / task list
  * quote
  * code block
  * table
  * divider
  * callout
  * image/file embed
  * page mention / internal link
* slash command를 지원해야 한다.
* autosave를 지원해야 한다.
* block mode와 source mode는 동일 문서의 두 표현이어야 한다.
* 모든 블록은 Markdown으로 round-trip 가능해야 하며, 일반 Markdown으로 표현이 어려운 블록은 문서화된 custom directive syntax를 사용해야 한다.

## 7.3 AI 편집

* AI 액션 범위:

  * selection rewrite
  * section expand
  * tone/style transform
  * summarize
  * extract action items
  * add related links
  * merge external content into page
  * create new page from content
* AI는 편집 결과를 **streaming patch** 형태로 반환해야 한다.
* UI는 다음 두 방식 모두 지원해야 한다.

  * block diff view
  * line-based markdown diff view
* AI 변경은 작성 주체를 `actor_type = ai` 로 기록해야 한다.
* AI 자동 적용 정책은 workspace 단위로 설정 가능해야 한다.

  * suggest-only
  * auto-apply-to-draft
  * auto-apply-existing-draft-page
  * never-auto-publish

## 7.4 External Ingestion API

* 외부 시스템은 Bearer token으로 인증해야 한다.
* API는 idempotency key를 받아야 한다.
* 본문 타입은 최소 `text/plain`, `text/markdown`, `application/json` 을 지원해야 한다.
* 수신 후 즉시 `202 Accepted` 를 반환하고, 실제 분석은 비동기로 처리해야 한다.
* ingest 결과는 다음 상태를 가져야 한다.

  * queued
  * processing
  * created
  * updated
  * appended
  * no_op
  * needs_review
  * failed
* 외부 payload의 원문은 반드시 raw 형태로 저장해야 한다.

## 7.5 Triple Extraction / Knowledge Graph

* triple 추출은 page save, AI apply, publish, external ingest 시점에 실행되어야 한다.
* triple은 subject / predicate / object 구조를 가진다.
* object는 entity 또는 literal 둘 다 지원해야 한다.
* triple은 confidence, provenance, source revision, source span을 저장해야 한다.
* 동일 entity의 alias/정규화가 가능해야 한다.
* 우측 graph 패널은 현재 페이지와 직접 연결된 node를 우선 표시해야 한다.
* depth 1을 기본, depth 2를 옵션으로 제공해야 한다.
* 2D를 기본으로 하고 3D는 토글 가능한 확장 기능으로 둔다.

## 7.6 Revision / Audit / Logs

* 모든 저장은 revision을 생성해야 한다.
* revision은 base revision을 참조해야 한다.
* diff는 Markdown line diff와 structured op diff 둘 다 저장해야 한다.
* 누가, 무엇을, 어떤 source로 바꿨는지 audit log에 남겨야 한다.
* rollback은 새 revision 생성 방식으로 동작해야 한다.
* hard overwrite는 허용하지 않는다.

## 7.7 Publish / Public Docs

* draft와 published는 분리되어야 한다.
* publish 시 immutable snapshot을 생성해야 한다.
* public docs는 TOC, breadcrumbs, prev/next, heading anchors를 제공해야 한다.
* 문서별 public URL을 가져야 한다.
* unpublish와 republish를 지원해야 한다.
* public 문서는 read-only다.

## 7.8 Search / Retrieval

* keyword search
* title/path search
* typo-tolerant search
* entity 기반 탐색
* page-to-page related links
* optional semantic search

## 8. 비기능 요구사항

### 성능

* ingest API ack는 빠르게 반환되어야 한다.
* 에디터 autosave는 사용자 체감상 자연스러워야 한다.
* graph 패널은 현재 페이지 기준 제한된 node/edge 수로 빠르게 렌더링해야 한다.

### 신뢰성

* 모든 external ingest는 원문 저장 후 처리해야 한다.
* queue worker 실패 시 재시도 가능해야 한다.
* publish 실패는 snapshot 생성 이전 상태를 유지해야 한다.

### 보안

* API token은 해시 저장해야 한다.
* workspace 단위 rate limit이 필요하다.
* public page와 authoring page 권한을 분리해야 한다.
* 모델 API key는 서버 측 secret manager에서만 접근해야 한다.

### 관측성

* model run, prompt template version, latency, token usage, error reason을 기록해야 한다.
* ingest to page latency, AI acceptance rate, publish success rate를 대시보드화해야 한다.

## 9. 권장 기술 스택

현재 기준으로 핵심 런타임/프레임워크는 React 19.2, Vite 8.0, PostgreSQL 18.3, Node.js 24.14.1 LTS, TypeScript 6.0이다. 백엔드는 Fastify 최신 v5.8.x 라인, 입력 검증은 Zod 4.2, 비동기 파이프라인은 BullMQ 5.73.5 조합을 추천한다. ORM은 PostgreSQL 중심의 type-safe 도구로 두고, exact patch 버전은 실제 repo bootstrap 시 lockfile로 pinning 하는 방식이 안전하다. ([React][1])

에디터는 Tiptap 3.0을 중심으로 잡고, 실시간 동기화 계층은 Hocuspocus + Yjs를 쓰는 것이 가장 적합하다. Hocuspocus는 Y.js 기반 협업 도구이고, Yjs는 Tiptap/ProseMirror뿐 아니라 Monaco도 지원하므로 block mode와 raw markdown source mode를 함께 설계하기 좋다. 다만 Tiptap의 Markdown extension은 공식 문서상 early release이므로, 저장의 정본은 Markdown으로 유지하고 round-trip 회귀 테스트를 별도로 두는 것이 안전하다. AI 수정 diff는 prosemirror-changeset 기반 span 추적으로 구현한다. ([tiptap.dev][2])

AI 모델 계층은 OpenAI와 Google provider adapter를 공통 인터페이스로 감싸는 구조로 설계한다. OpenAI 공식 문서는 대부분의 reasoning 작업에 `gpt-5.4`를 시작점으로, 더 어려운 작업에는 `gpt-5.4-pro`를 권장하며 reasoning 모델은 Responses API를 우선 사용하라고 안내한다. Google 공식 문서는 Gemini 3 계열이 `thinking_level`을 지원하고 기본값이 `high`라고 설명하며, 현재 `Gemini 3.1 Pro Preview`는 software engineering과 agentic workflow에 최적화되어 있다. Google은 stable/preview/latest 모델 문자열을 정확히 pinning 하라고 안내하므로, PRD에도 exact model string pinning을 명시하는 것이 좋다. 또한 구형 `gemini-3-pro-preview`는 종료되었으므로 새 구현에서는 쓰지 않는 편이 안전하다. ([OpenAI 플랫폼][3])

검색과 ingest routing은 PostgreSQL 기본 Full Text Search와 `pg_trgm`으로 시작하고, semantic candidate retrieval이 필요하면 `pgvector` 0.8.2를 옵션으로 붙인다. PostgreSQL 문서는 `pg_trgm`이 full text index와 함께 오타/유사어 인식에 유용하다고 설명하고, `pgvector`는 Postgres 안에서 exact/approximate nearest neighbor search를 제공한다. 우측 graph UI는 Graph DB 없이 triple adjacency를 API로 내려주고 `react-force-graph-3d`로 2D/3D force-directed 렌더링을 구현한다. publish 렌더러는 `remark`/`rehype` 파이프라인으로 Markdown을 HTML로 변환하는 구성을 권장한다. ([PostgreSQL][4])

## 10. 추천 아키텍처

```text
[React/Vite Web App]
  ├─ Authoring UI
  ├─ Public Docs UI
  ├─ Graph Panel
  └─ AI Diff Viewer
          |
          v
[Fastify API]
  ├─ Auth / Workspace / Page API
  ├─ Ingestion API
  ├─ Publish API
  ├─ Graph API
  └─ SSE/WS for AI streaming
          |
    +-----+-------------------+
    |                         |
    v                         v
[PostgreSQL]             [Redis]
  ├─ pages               └─ BullMQ queues
  ├─ revisions
  ├─ published_snapshots
  ├─ entities
  ├─ triples
  └─ audit_logs
                               |
                               v
                         [Worker Services]
                          ├─ route classifier
                          ├─ patch generator
                          ├─ triple extractor
                          ├─ publish renderer
                          └─ search index updater
                               |
                               v
                         [AI Gateway]
                          ├─ OpenAI
                          └─ Gemini
```

## 11. 데이터 모델 초안

### 핵심 테이블

* `workspaces`
* `folders`
* `pages`
* `page_paths`
* `page_revisions`
* `revision_diffs`
* `published_snapshots`
* `ingestions`
* `ingestion_decisions`
* `entities`
* `entity_aliases`
* `triples`
* `triple_mentions`
* `model_runs`
* `api_tokens`
* `audit_logs`

### 주요 컬럼 제안

#### `pages`

* id
* workspace_id
* folder_id
* title
* slug
* status (`draft`, `published`, `archived`)
* current_revision_id
* latest_published_snapshot_id
* created_at
* updated_at

#### `page_revisions`

* id
* page_id
* base_revision_id
* actor_type (`user`, `ai`, `system`)
* actor_id
* source (`editor`, `ingest_api`, `publish`, `rollback`)
* content_md
* content_json
* summary
* created_at

#### `revision_diffs`

* id
* revision_id
* diff_md
* diff_ops_json

#### `ingestions`

* id
* workspace_id
* source_name
* external_ref
* idempotency_key
* content_type
* raw_payload
* normalized_text
* status
* received_at
* processed_at

#### `ingestion_decisions`

* id
* ingestion_id
* action (`create`, `update`, `append`, `noop`, `needs_review`)
* target_page_id
* confidence
* rationale_json
* model_run_id

#### `entities`

* id
* workspace_id
* canonical_name
* entity_type
* metadata_json

#### `triples`

* id
* workspace_id
* subject_entity_id
* predicate
* object_entity_id nullable
* object_literal nullable
* confidence
* source_page_id
* source_revision_id
* status (`active`, `candidate`, `rejected`)
* created_at

#### `triple_mentions`

* id
* triple_id
* page_id
* revision_id
* span_start
* span_end
* excerpt

## 12. API 초안

### 12.1 External Ingestion

`POST /api/v1/ingestions`

예시 요청:

```json
{
  "workspaceId": "wk_123",
  "folderId": "fd_inbox",
  "contentType": "text/markdown",
  "titleHint": "신규 결제 정책 변경",
  "content": "# 결제 정책 변경\n\n...",
  "metadata": {
    "source": "external-agent",
    "externalRef": "ticket-4821"
  },
  "policy": "auto"
}
```

예시 응답:

```json
{
  "ingestionId": "ig_123",
  "status": "queued"
}
```

### 12.2 AI Edit

`POST /api/v1/pages/:pageId/ai-edit`

```json
{
  "mode": "selection-rewrite",
  "selection": {
    "from": 120,
    "to": 280
  },
  "instruction": "이 부분을 더 명확한 제품 문서 문체로 수정"
}
```

### 12.3 Publish

`POST /api/v1/pages/:pageId/publish`

```json
{
  "revisionId": "rev_456",
  "visibility": "public"
}
```

### 12.4 Graph

`GET /api/v1/pages/:pageId/graph?depth=1&limit=60`

### 12.5 Revision History

`GET /api/v1/pages/:pageId/revisions`

## 13. AI 출력 계약(JSON Contract)

### 13.1 Route Decision

```json
{
  "action": "create",
  "targetPageId": null,
  "targetSectionAnchor": null,
  "confidence": 0.93,
  "reason": "입력 내용이 기존 페이지와 주제 overlap이 낮고 신규 entity가 다수 등장함",
  "proposedTitle": "결제 정책 변경사항"
}
```

### 13.2 Patch Proposal

```json
{
  "targetPageId": "pg_123",
  "baseRevisionId": "rev_456",
  "editType": "update",
  "ops": [
    {
      "type": "replace",
      "path": "section:billing-policy",
      "before": "기존 문단",
      "after": "새 문단"
    }
  ],
  "summary": "정책 변경 내용을 반영하여 예외 조건 문단을 업데이트"
}
```

### 13.3 Triple Extraction

```json
{
  "triples": [
    {
      "subject": "결제 정책",
      "predicate": "적용됨",
      "object": "2026년 2분기 결제 플로우",
      "objectType": "entity",
      "confidence": 0.88,
      "spans": [
        {
          "start": 15,
          "end": 31,
          "text": "2026년 2분기 결제 플로우"
        }
      ]
    }
  ]
}
```

## 14. 핵심 로직 설계

### 14.1 Ingest Routing

1. raw payload 저장
2. normalize text
3. candidate page retrieval

   * title/path match
   * FTS
   * trigram
   * entity overlap
   * optional vector similarity
4. LLM route decision
5. patch generation
6. revision 생성
7. triple extraction
8. graph/materialized read model 갱신

### 14.2 AI 자동 적용 정책

* confidence ≥ 0.85: draft에 auto-apply 가능
* 0.60 ~ 0.84: suggestion 생성, review queue로 이동
* < 0.60: needs_review 또는 inbox draft page 생성

### 14.3 충돌 처리

* base revision이 바뀌면 즉시 overwrite하지 않는다.
* 재생성 가능한 patch면 rebase 시도
* 실패 시 review queue로 보낸다.

## 15. Publish 정책

* publish는 반드시 특정 revision 기준으로 snapshot을 생성해야 한다.
* public route는 snapshot을 읽어야 한다.
* published snapshot은 rollback 가능해야 한다.
* publish 시 다음을 같이 생성한다.

  * rendered HTML
  * TOC JSON
  * internal link map
  * page metadata
  * search index entry
* public URL 예시:

  * `/docs/:workspaceSlug/:pagePath`

## 16. UX 요구사항

### 좌측 패널

* VS Code처럼 접고 펼칠 수 있는 tree
* drag & drop 이동
* 우클릭 메뉴
* 새 문서 / 새 폴더
* 최근 변경 표시
* AI 생성 초안 inbox

### 중앙 편집 영역

* block editor 기본
* source mode 전환
* slash command
* selection toolbar
* AI patch streaming overlay
* unsaved / saved 상태 표시

### 우측 패널

탭 구조를 권장합니다.

* Graph
* Triples
* Revision
* Linked Pages
* AI Activity

## 17. 완료 기준(acceptance criteria)

* 사용자는 nested folder 구조 안에서 Markdown 페이지를 만들 수 있다.
* 사용자는 block mode와 source mode를 오가며 같은 문서를 편집할 수 있다.
* AI가 selection edit를 수행하면 diff가 시각화된다.
* 외부 POST API로 들어온 내용은 새 페이지 생성 또는 기존 페이지 수정으로 이어질 수 있다.
* 모든 AI 변경은 revision과 audit log를 남긴다.
* page save/publish/ingest 후 triple이 저장된다.
* graph 패널에서 현재 페이지와 연결된 node를 볼 수 있다.
* publish 시 public URL이 생성되고 인증 없이 접근 가능하다.
* 특정 revision으로 rollback이 가능하다.
* typo가 있는 검색어도 관련 페이지를 어느 정도 찾을 수 있다.

## 18. MVP 범위와 다음 단계

### MVP

* single workspace
* folder/page CRUD
* block editor + source mode
* AI selection edit + diff
* external ingest API
* create/update/append/noop routing
* triple 저장
* graph 패널 2D
* revision history
* publish/public URL

### Next

* graph 3D 토글
* 다중 사용자 협업 편집
* approval workflow
* semantic search 고도화
* entity merge UI
* analytics dashboard
* role/permission 세분화
* SSO

## 19. AI coding agent를 위한 구현 우선순위

1. ✅ monorepo scaffold
2. ✅ auth/workspace/page schema
3. ✅ editor + markdown persistence
4. ✅ revisions + diff engine
5. ✅ ingestion API + queue
6. ✅ AI route decision + patch generation
7. ✅ triple extraction + graph read API
8. ✅ publish renderer + public docs
9. ✅ observability + audit polish

## 20. 현재 구현 현황 (2026-04-16 기준)

> 2026-04-24 문서 점검 메모: 이 섹션은 초기 PRD 스냅샷으로 보존한다. 최신 구현 상태와 활성 백로그는 [CLAUDE.md](CLAUDE.md#current-implementation-status-snapshot-2026-04-24-docs-reviewed)와 [TASKS.md](TASKS.md)를 기준으로 본다.
>
> 이후 코드에 반영된 주요 변경: review queue + ingestion detail, provenance source drill-down, freshness badge, human-edit conflict downgrade, workspace activity feed, queue admin page, soft-delete/trash/purge, archived original ingestion storage, predicate display-label cache, graph filters/evidence inspector, reviewed content reformatting, pipeline integration/e2e smoke tests, and large-context token-budget prompt assembly. 아직 없는 항목: persisted chunk layer, 3D graph toggle, CI, broad route-level API coverage, Yjs/Hocuspocus.

### 20.1 완료된 항목

| 영역 | 항목 | 비고 |
|---|---|---|
| 인프라 | 모노레포 scaffold (web/api/worker/shared/db) | pnpm workspace |
| DB | 전체 스키마 + 마이그레이션 | Drizzle ORM |
| Auth | JWT 기반 회원가입/로그인/me | |
| Workspace | CRUD + 멤버 역할 관리 | owner/admin/editor/viewer |
| Folder | 무한 깊이 폴더 CRUD + reorder | parent_folder_id self-ref |
| Page | CRUD + slug + page_paths 자동 삽입 | |
| Editor | Tiptap block editor + source mode 전환 | |
| Revision | 전체 이력 저장 + diff(line+ops) + rollback | |
| Ingestion | POST API 202 async + BullMQ pipeline | |
| Route classifier | AI 기반 create/update/append/noop 분류 | |
| Patch generator | AI 기반 diff patch 생성 + revision 적용 | |
| Triple extractor | AI 기반 triple 추출 + entity upsert + mention | save/ai-edit/ingest 후 큐잉 |
| Graph API | BFS depth 1-2 graph read API | |
| Graph UI | react-force-graph-2d 우측 패널 | |
| Publish | 불변 snapshot 생성 + remark/rehype 렌더링 | |
| Public Docs UI | /docs/:workspace/:path 읽기 전용 | |
| Audit logs | 전 엔티티 감사 로그 | |
| Model runs | AI 호출 latency/token 추적 | |
| Observability | pino structured logging + health check | |

### 20.2 미구현 항목 (다음 단계)

| 우선순위 | 항목 | 관련 섹션 |
|---|---|---|
| 높음 | 에디터 Autosave (2초 debounce) | §7.2 |
| 높음 | 사이드바 폴더 생성 UI | §7.1, §16 |
| 높음 | AI edit SSE 엔드포인트 + 스트리밍 diff UI | §7.3, §12.2 |
| 높음 | 검색 API (FTS + trigram) + search-index-updater worker | §7.8 |
| ~~중간~~ ✅ | 페이지 생성 시 폴더 선택 UI | §7.1 |
| ~~중간~~ ✅ | Slash command | §7.2 |
| ~~낮음~~ ✅ | 사이드바 우클릭 메뉴 (rename/delete) | §16 |
| ~~낮음~~ ✅ | Graph 3D 토글 | §7.5, §18 Next |
| 낮음 | 사이드바 drag & drop 정렬 | §7.1, §16 |
| 낮음 | 다중 사용자 실시간 협업 (Hocuspocus/Yjs) | §9, §18 Next |

## 22. 최종 권장 결론

이 제품의 핵심은 “문서 편집기”가 아니라 “AI가 계속 지식을 넣어도 망가지지 않는 문서 시스템”입니다. 그래서 설계의 중심은 다음 세 가지여야 합니다.

* **Markdown을 정본으로 유지할 것**
* **모든 AI 변경을 revision/diff로 남길 것**
* **triple과 page를 같은 PostgreS

QL 안에서 provenance까지 추적할 것**

이렇게 가면 Graph DB 없이도 충분히 시작할 수 있고, 나중에 graph/query complexity가 커질 때만 별도 graph layer를 검토하면 됩니다.

[1]: https://react.dev/versions "https://react.dev/versions"
[2]: https://tiptap.dev/blog/release-notes/tiptap-3-0-is-stable "https://tiptap.dev/blog/release-notes/tiptap-3-0-is-stable"
[3]: https://platform.openai.com/docs/guides/reasoning?api-mode=responses&example=planning "https://platform.openai.com/docs/guides/reasoning?api-mode=responses&example=planning"
[4]: https://www.postgresql.org/docs/current/textsearch.html "https://www.postgresql.org/docs/current/textsearch.html"
