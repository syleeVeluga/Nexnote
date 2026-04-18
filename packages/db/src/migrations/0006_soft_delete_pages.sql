-- S6-1: Soft-delete + 휴지통. 기존 DELETE /pages/:id 는 CASCADE 기반 하드 삭제로
-- 실수 복구가 불가능했고, 발행 스냅샷이 즉시 사라져 공개 URL이 깨졌다.
-- 페이지 상태를 "관측 가능한 단일 축"(pages.deleted_at)으로 두고, triples 는
-- 'page_deleted' 상태로 숨긴다. 자손 테이블에 deleted_at 을 뿌리지 않는 이유는
-- 복원 시 복수 테이블 간 원자성을 보장하기 어렵기 때문이다.

ALTER TABLE "pages" ADD COLUMN "deleted_at" timestamptz;
ALTER TABLE "pages" ADD COLUMN "deleted_by_user_id" uuid
  REFERENCES "users"("id") ON DELETE SET NULL;

-- Active pages는 자주 조회된다. Partial index로 soft-deleted row가 쌓여도
-- 정상 쿼리에 영향이 없게 한다.
CREATE INDEX "pages_workspace_active_idx"
  ON "pages" ("workspace_id")
  WHERE "deleted_at" IS NULL;

CREATE INDEX "pages_workspace_trashed_idx"
  ON "pages" ("workspace_id", "deleted_at" DESC)
  WHERE "deleted_at" IS NOT NULL;

-- 기존 unique 제약(workspace_slug_uk)과의 충돌을 피하기 위해 구 제약을 active
-- 페이지에만 걸리도록 partial unique index로 교체한다. 같은 slug로 삭제-재생성
-- 을 허용해야 UX가 자연스럽다.
ALTER TABLE "pages" DROP CONSTRAINT IF EXISTS "pages_workspace_slug_uk";
DROP INDEX IF EXISTS "pages_workspace_slug_uk";
CREATE UNIQUE INDEX "pages_workspace_slug_active_uk"
  ON "pages" ("workspace_id", "slug")
  WHERE "deleted_at" IS NULL;

-- page_paths 의 is_current partial unique 도 동일한 이유로 삭제된 페이지의
-- path를 무시해야 한다. 해당 인덱스는 path만 본다(page_id 상태 모름).
-- 삭제 시 page_paths.is_current=false 로 내려주면 제약이 유지된다.
-- (application-level 에서 softDeletePages 가 UPDATE 한다.)

-- soft-delete 시 status='active' triples만 'page_deleted'로 전환한다. 기존
-- triples_source_page_idx 는 status를 포함하지 않아 대량 페이지 삭제에서 풀
-- 테이블 스캔이 일어날 수 있으므로 active triples에 한정된 부분 인덱스를 추가.
CREATE INDEX IF NOT EXISTS "triples_source_page_active_idx"
  ON "triples" ("source_page_id")
  WHERE "status" = 'active';
