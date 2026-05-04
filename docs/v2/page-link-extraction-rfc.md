# Page Link Extraction — Placeholder RFC (deferred)

> **상태**: 보류 (2026-05-04) · S3 의 ILIKE 한계가 운영에서 검증된 후 진입
> **유형**: 후속 RFC placeholder
> **모티브**: `find_backlinks` Tier 1 (Postgres ILIKE) 의 정확도 한계가 자율 reorganize / merge 결정의 신뢰성을 깎으면, 진짜 link 인덱스를 만든다.

본 RFC 는 **placeholder** — 사용자 결정 ([`docs/v2/README.md`](README.md) §사용자 결정 사항): find_backlinks 는 Tier 1 만, Tier 2 (page_links 마이그레이션) 는 본 RFC 로 분리.

## 진입 트리거 (RFC 작성 개시 조건)

[`agent-tools-expand-step-3-read-intel.md`](agent-tools-expand-step-3-read-intel.md) §11 의 운영 신호 중 **하나 이상** 충족 시 본 RFC 본문 작성:

1. `find_backlinks` 의 false-positive 또는 false-negative 가 자율 `delete_page` / `merge_pages` 결정을 명확히 잘못 유도하는 사례 발생.
2. 워크스페이스가 500 페이지 초과로 커지면서 ILIKE 스캔이 dispatcher quota (`find_backlinks: 5/run`) 를 항상 소진.
3. 사용자가 "이 페이지를 누가 참조하나" 류 UI 기능을 요구.

## 의도된 구조 (개략)

작성 시작 시점에 본 섹션을 본문으로 확장. 현재는 결정 후보만 메모.

### 데이터 모델

```sql
CREATE TABLE page_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source_revision_id UUID NOT NULL REFERENCES page_revisions(id) ON DELETE CASCADE,
  target_page_id UUID REFERENCES pages(id) ON DELETE SET NULL,   -- nullable: 타겟 페이지 부재 (broken link)
  target_slug TEXT,                                              -- raw slug as written
  link_text TEXT,                                                -- "[label](slug)" 의 label
  link_type TEXT NOT NULL,                                       -- 'wikilink' | 'markdown'
  position_in_md INT,                                            -- 본문 내 offset
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX page_links_target_idx ON page_links(workspace_id, target_page_id) WHERE target_page_id IS NOT NULL;
CREATE INDEX page_links_source_revision_idx ON page_links(source_revision_id);
CREATE INDEX page_links_broken_idx ON page_links(workspace_id, target_slug) WHERE target_page_id IS NULL;
```

### 추출 트리거

- revision 적용 hook ([`packages/api/src/lib/apply-decision.ts`](../../packages/api/src/lib/apply-decision.ts) `enqueuePostApply`) 에 신규 job `LINK_EXTRACTOR` 추가.
- worker 가 새 revision 의 contentMd 를 파싱:
  - `[[Page Title]]` / `[[slug]]` → wikilink_type
  - `[label](slug-or-path)` → markdown_type
  - 정규식 + 위치 capture
- 해당 revision 의 기존 link 행 모두 삭제 후 새로 insert (idempotent).

### Backfill

기존 페이지들의 latest revision 을 일회성 batch 작업으로 처리. `pnpm --filter db backfill:page-links` 명령.

### find_backlinks Tier 2

ILIKE 대신 SQL JOIN:

```sql
SELECT p.id, p.title, p.slug, pr.content_md, pl.position_in_md, pl.link_type
FROM page_links pl
JOIN pages p ON p.id = pl.source_page_id AND p.deleted_at IS NULL
JOIN page_revisions pr ON pr.id = p.current_revision_id
WHERE pl.workspace_id = $1
  AND pl.target_page_id = $2
  AND pl.source_revision_id = p.current_revision_id   -- only links from current head
ORDER BY p.last_ai_updated_at DESC NULLS LAST
LIMIT $3;
```

snippet 은 `position_in_md` 기준 정확히 추출.

### Broken-link surfacing

`target_page_id IS NULL` 인 행들로 워크스페이스의 깨진 링크 리포트:
- `/admin/broken-links` UI
- 자율 에이전트가 reorganize 시 broken-link 우선 정정

### find_outgoing_links (보너스)

Tier 2 도입과 함께 자매 도구 추가 — `read_outgoing_links({ pageId })` 가 source = pageId 인 모든 link 반환.

## Out of scope

- markdown 외 형식 (JSON 본문, callout 안의 link 등) — v3
- 외부 URL 의 도메인 분류 / 모니터링 — 별도 RFC
- 그래프 시각화 (workspace-wide link graph) — v3
