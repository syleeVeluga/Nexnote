# Spawn Subagent — Placeholder RFC (deferred)

> **상태**: 보류 (2026-05-04) · S5 운영 데이터 수집 후 진입 결정
> **유형**: 후속 RFC placeholder
> **모티브**: Orchestrator + Subagent 구조로 대규모 reorganize / cross-domain 책임 분리. 단, **S5 multi-turn replan 만으로 충분한지 먼저 측정** 한 후에만 진입.

본 RFC 는 **placeholder** — 본문은 트리거 조건이 충족된 후 작성한다. 사용자 결정 ([`docs/v2/README.md`](README.md) §사용자 결정 사항): subagent 는 docs/v2 묶음 외, S5 운영 데이터로 필요성 확정 시 진입.

## 진입 트리거 (RFC 작성 개시 조건)

[`agent-loop-strengthening-plan.md`](agent-loop-strengthening-plan.md) §5.7 의 측정 결과 중 **하나 이상** 충족 시 본 RFC 본문 작성 시작:

1. **`partial` status 비율 > 20%** AND `MAX_TOTAL_MUTATIONS=100` 도달이 빈번 → 진정한 fan-out 필요.
2. **한 plan 의 prompt 가 800k 토큰을 넘기 시작** → 책임 분리 (specialized prompts) 가 비용·정확도 모두 우위.
3. **이질적 task 가 한 run 에서 반복** → 예: "5 페이지 dedupe + 10 페이지 메타 재구성 + 30 페이지 frontmatter 정리" 같은 mixed workload 가 빈번하면 task type 별 specialized agent 가 prompt 길이/품질을 더 절약.
4. **사용자 피드백** — 자율 결과의 정확도가 task type 별로 편차 큼 (예: rename 은 정확하나 merge 결정은 자주 실수).

위 신호 없이 S5 만으로 안정적이면 본 RFC 진입 보류 — over-engineering 회피.

## 의도된 구조 (개략)

작성 시작 시점에 본 섹션을 본문으로 확장한다. 현재는 핵심 결정 후보만 메모:

### 책임 분해 (1차 후보)

| Subagent | 입력 | 좁은 tool surface | 출력 |
|---|---|---|---|
| **PlannerAgent** (Orchestrator) | ingestion / instruction | read-only 5+4종 + `spawn_subtask` | 서브태스크 그래프 (DAG) |
| **PageWriterAgent** | `{ pageId, intent, evidence }` 1건 | read_page, replace_in_page, edit_page_blocks, edit_page_section, update_page | revision 1개 또는 needs_review |
| **ReorganizerAgent** | `{ scope: folderId, instruction }` | list_folder, read_page_metadata, move_page, rename_page, create_folder, merge_pages, delete_page | 다수 reorganize decision |
| **DedupeAgent** | `{ candidatePages: [...] }` | read_page, find_backlinks, merge_pages, noop | merge 또는 noop 결정 |
| **ValidatorAgent** | 적용된 revision | read-only | round-trip / triple 일관성 리포트 |

### 데이터 모델

```sql
ALTER TABLE agent_runs ADD COLUMN parent_agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL;
ALTER TABLE agent_runs ADD COLUMN subtask_type TEXT;        -- 'page_write' | 'reorganize' | 'dedupe' | 'validate' | NULL (orchestrator)

CREATE TABLE agent_subtasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_agent_run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  child_agent_run_id  UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL,         -- 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  spec_json JSONB NOT NULL,
  result_json JSONB,
  attempt INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);
```

### 실행 메커니즘

기존 `INGESTION_AGENT` 큐를 type discriminator 로 분기:
- planner job: `{ kind: 'orchestrator', ingestionId }`
- subagent job: `{ kind: 'subtask', subtaskId }`

**v1 단순화**: planner 1번만 실행, subagent fan-out 한 번만 (재귀 spawn 금지). dependency 그래프는 무시 — subagent 실행 순서는 큐 순서. 진정한 DAG 는 v2.

### 안전 invariant 상속

- workspaceId 클로저 캡처 — 각 subagent dispatcher 가 동일 패턴
- seenPageIds — 자식 dispatcher 는 부모로부터 받은 spec.allowedPageIds 만 등록한 fresh state 로 시작
- per-page 락 — workspace 단위 redlock 으로 격상 (현재는 메모리)
- workspace daily token cap — 전체 트리가 공유 (subtask 마다 reservation)

### 트레이스

[`packages/web/src/components/agents/AgentTracePanel.tsx`](../../packages/web/src/components/agents/AgentTracePanel.tsx) 트리 모드 — 부모 run 펼치면 자식 run 들 표시.

## Out of scope

본 RFC 본문 작성 시점에서도 다음은 v1 외:
- 자식 subagent 가 또 spawn 하는 재귀 구조
- 트랜잭션 분산 처리 (여러 subagent 가 동일 페이지 동시 mutation)
- subagent 사이 직접 message 전달 — 모두 DB 를 거침
- subagent 실행 재시도 정책 — 1차는 BullMQ 기본 retry 만
