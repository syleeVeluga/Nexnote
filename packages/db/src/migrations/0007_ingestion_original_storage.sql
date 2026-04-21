-- MinIO(S3) 기반 원본 아카이빙. 업로드/URL 경로에서 원본 바이트를 S3에 저장하고,
-- ingestions 레코드에 그 포인터 + 메타만 기록한다. 텍스트 붙여넣기는 이미
-- raw_payload.content 에 원문이 있으므로 이 컬럼들은 NULL로 남는다.
-- 1:1 관계라 별도 테이블 대신 ingestions 컬럼 확장.

ALTER TABLE "ingestions" ADD COLUMN "storage_key" text;
ALTER TABLE "ingestions" ADD COLUMN "storage_bytes" bigint;
ALTER TABLE "ingestions" ADD COLUMN "storage_sha256" text;

-- purgeSubtree 는 subtree page_ids → ingestion_decisions → ingestions 로 역조인해
-- S3 object 정리 대상 storage_key 를 모은다. target_page_id 에 인덱스가 없으면
-- 대량 purge 가 트랜잭션 안에서 풀 스캔을 하게 된다.
CREATE INDEX IF NOT EXISTS "ingestion_decisions_target_page_idx"
  ON "ingestion_decisions" ("target_page_id")
  WHERE "target_page_id" IS NOT NULL;
