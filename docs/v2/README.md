# WekiFlow docs/v2/ — Agent autonomy & tool surface expansion

> **상태**: 초안 (2026-05-04)
> **유형**: RFC 묶음 인덱스
> **모티브**: 외부 신호 → 자율 적용 (사람 승인 없이) 의 약속을 코드로 닫기

`docs/v2/` 는 기존 `docs/ingestion-agent-plan.md` / `docs/scheduled-agent-plan.md` 가 만든 explore→plan→execute 루프 위에, **승인 게이트 우회 (autonomy mode)** + **부족한 도구 surface 보완** + **multi-turn replan 으로 루프 강화** 를 묶은 차세대 RFC 들이다. 모두 **사용자 승인 없이 페이지를 생성/편집/병합/삭제할 수 있는 자율 에이전트** 라는 단일 목표에 종속된다.

## 문서 구조

| 파일 | 성격 | 다루는 sprint |
|---|---|---|
| [`agent-autonomy-plan.md`](agent-autonomy-plan.md) | umbrella RFC | S1 (autonomy mode), S4 (rollback) |
| [`agent-tools-expand-plan.md`](agent-tools-expand-plan.md) | umbrella RFC | S2 (reorganize tools), S3 (read intel tools) |
| [`agent-loop-strengthening-plan.md`](agent-loop-strengthening-plan.md) | umbrella RFC | S5 (multi-turn replan) |
| [`agent-autonomy-step-1-mode-flag.md`](agent-autonomy-step-1-mode-flag.md) | sub-doc | S1 인터페이스 |
| [`agent-autonomy-step-4-rollback.md`](agent-autonomy-step-4-rollback.md) | sub-doc | S4 인터페이스 |
| [`agent-tools-expand-step-2-reorganize.md`](agent-tools-expand-step-2-reorganize.md) | sub-doc | S2 인터페이스 |
| [`agent-tools-expand-step-3-read-intel.md`](agent-tools-expand-step-3-read-intel.md) | sub-doc | S3 인터페이스 |
| [`agent-loop-step-5-multi-turn-replan.md`](agent-loop-step-5-multi-turn-replan.md) | sub-doc | S5 인터페이스 |
| [`spawn-subagent-rfc.md`](spawn-subagent-rfc.md) | placeholder RFC | S6 (후속 — S5 운영 데이터 수집 후 진입) |
| [`page-link-extraction-rfc.md`](page-link-extraction-rfc.md) | placeholder RFC | S3.5 (find_backlinks Tier 2 — 후속) |

## Sprint 시퀀싱

```
S1 autonomy + safety nets   → S4 rollback
                                  ↓
                              S2 ‖ S3 (병행 가능)
                                  ↓
                              S5 multi-turn replan
                                  ↓
                              [측정 후 결정]
                                  ↓
                              spawn-subagent-rfc.md (별도 RFC)
                              page-link-extraction-rfc.md (별도 RFC)
```

S2/S3 는 disjoint 코드 경로 (mutate.ts vs read.ts) 라 병행 PR 가능. S5 는 S1~S4 의 도구 surface 가 안정된 뒤 진입.

## 사용자 결정 사항 (이 묶음의 baseline)

1. Sprint 순서: **S1(autonomy) → S4(rollback) → S2 ‖ S3 → S5**.
2. `INGESTION_ACTIONS` enum: **확장하지 않음**. 신규 도구 결과는 기존 `update` action 으로 분류, granularity 는 audit_logs + tool name 으로 보존. 단 parity gate / classifier / audit renderer / trace UI / 다국어 라벨은 신규 tool name 을 처리하도록 cascade.
3. Subagent / Orchestrator: **본 묶음 외 — `spawn-subagent-rfc.md` placeholder 만**.
4. `find_backlinks` 구현: **Tier 1 (Postgres ILIKE 풀텍스트 스캔) 만**, Tier 2 (page_links 마이그레이션) 는 `page-link-extraction-rfc.md` placeholder.

## 기존 문서와의 관계

| 기존 문서 | docs/v2/ 와의 관계 |
|---|---|
| [`docs/PRD ...`](../PRD%20%E2%80%94%20AI%20%EB%B3%B4%EC%A1%B0%20Markdown%20%EC%A7%80%EC%8B%9D%20%EC%9C%84%ED%82%A4%EB%AC%B8%EC%84%9C%20%EC%84%9C%EB%B9%84%EC%8A%A4.md) | 비전 — 변경 없음 |
| [`docs/ERD ...`](../ERD%20%EC%B4%88%EC%95%88%20%E2%80%94%20AI%20%EA%B8%B0%EB%B0%98%20Markdown%20%EC%A7%80%EC%8B%9D%20%EC%9C%84%ED%82%A4%20%EC%84%9C%EB%B9%84%EC%8A%A4.md) | 데이터 모델 — `workspaces` 컬럼 6개 추가 (S1) |
| [`docs/ingestion-agent-plan.md`](../ingestion-agent-plan.md) | **선행 RFC**. v2 는 그 위에 autonomy 게이트 우회 + 도구 보완 |
| [`docs/scheduled-agent-plan.md`](../scheduled-agent-plan.md) | **선행 RFC**. autonomy 모드는 scheduled_auto_apply 의 일반화 |
| [`docs/scheduled-agent-merge-delete-plan.md`](../scheduled-agent-merge-delete-plan.md) | destructive tool gate 완화는 v2 S1 에서 일반 ingestion 까지 확장 |
| [`docs/TASKS.md`](../TASKS.md) | sprint 머지 시 신규 ticket 행 (AUTO-1 ~ AUTO-5) 갱신 |
| [`AGENTS.md`](../../AGENTS.md) | documentation map 에 `docs/v2/` 항목 1줄 추가 |

## 명명 규칙

- umbrella RFC: `<scope>-plan.md` (`agent-autonomy-plan.md` 처럼 동사+범위)
- sub-doc: `<scope>-step-N-<descriptor>.md`
- placeholder/후속 RFC: `<scope>-rfc.md`

루트 `AGENTS.md` documentation map 의 규칙 (`docs/<verb>-<scope>-plan.md` 또는 `docs/<scope>-rfc.md`) 과 일치.
