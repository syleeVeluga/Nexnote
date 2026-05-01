# Scheduled Agent — WekiFlow 적용 플랜 (v1)

## Context

현재 WekiFlow의 `ingestion-agent`는 **외부 신호가 들어왔을 때만** 동작한다. 사용자의 목표는 두 가지다:

1. **수동**: 사용자가 페이지(+하위 트리)를 골라 즉시 재구성/재작성/재정리를 트리거
2. **주기**: AI가 외부 입력 없이도 cron에 따라 알아서 문서를 정리

v0.2 spec(*Scheduled Agent — single-loop edition*)이 그 방향성을 정의한다. 본 플랜은 spec을 **WekiFlow 현재 코드와 정렬**해서, **이미 있는 부품(탐색→계획→실행 루프, 도구 카탈로그, dispatcher, parity 패턴, SSE 트레이스)을 80% 그대로 재사용**하고 신규로 만드는 것은 cron 레지스트리 + 실행 기록 + UI에 한정한다.

실험 페이즈가 목적이므로, **v1은 Phase 1만 출하**한다 — 사용자가 수일 내에 "AI가 실제로 정리하는 모습"을 관찰할 수 있는 게 목표. dry_run/shadow/live 3단 모드, promotion gate, Claude adapter, workspace.domain은 후속 phase로 분리.

**확정된 결정** (사용자 답변):
- Loop은 기존 `runIngestionAgentShadow()` 재사용 (별도 loop 파일 신설 X)
- v1 스코프는 Phase 1로 한정
- Scheduled origin의 mutation은 **기본적으로 모두 `suggested`로 강제**, 단 워크스페이스 설정으로 confidence 기반 auto-apply도 활성화 가능

---

## v1 Architecture

```
┌─ Trigger ────────────────────────────────────────────────────────┐
│ A) 수동: POST /workspaces/:id/reorganize-runs                    │
│    body: { pageIds, includeDescendants, instruction }            │
│ B) 주기: scheduled_tasks 행 + BullMQ repeatable                  │
│    (UI 등록은 v1에 포함, cron 실행도 동작)                       │
└──────────────────────┬───────────────────────────────────────────┘
                       │
                       ▼
            scheduled-agent-queue (BullMQ)
                       │
                       ▼
   scheduled-agent worker (얇은 래퍼, ~200줄)
   ├─ scheduled_runs INSERT (status='running', triggered_by)
   ├─ input adapter: scheduled_tasks/manual body → ScheduledAgentInput
   └─ runIngestionAgentShadow(input, { origin: 'scheduled', ... })
                       │
                       ▼
   기존 dispatcher + read/mutate 도구 그대로
   ├─ seedPageIds로 사용자 선택 페이지 사전 주입
   ├─ origin='scheduled' 태그가 모든 산출물에 전파
   └─ mutation 발행 시:
      - workspace.scheduled_auto_apply=false (기본) → 항상 'suggested'
      - workspace.scheduled_auto_apply=true → 기존 임계값(≥0.85) 적용
                       │
                       ▼
   ingestion_decisions / page_revisions / audit_logs / model_runs
   (origin='scheduled' + scheduled_run_id FK로 추적)
                       │
                       ▼
   /review UI (origin 필터 칩 1개 추가)
   AISettingsPage (Scheduled Agent 섹션 신설)
```

---

## 코드 변경 — 파일별

### 마이그레이션 `0019_scheduled_agent.sql`

```sql
-- workspaces 확장 (v1에 필요한 것만)
ALTER TABLE workspaces
  ADD COLUMN scheduled_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN scheduled_auto_apply boolean NOT NULL DEFAULT false,
  ADD COLUMN scheduled_daily_token_cap integer,
  ADD COLUMN scheduled_per_run_page_limit integer NOT NULL DEFAULT 50;

-- 스케줄 레지스트리
CREATE TABLE scheduled_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  cron_expression text NOT NULL,        -- BullMQ repeatable pattern
  target_page_ids uuid[] NOT NULL,      -- 사용자가 고른 페이지(들)
  include_descendants boolean NOT NULL DEFAULT true,
  instruction text,                     -- 자유 지시문 (system prompt에 주입)
  enabled boolean NOT NULL DEFAULT true,
  bull_repeat_key text,                 -- BullMQ repeat key (cleanup용)
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_tasks_workspace_idx ON scheduled_tasks(workspace_id) WHERE enabled = true;

-- 실행 기록
CREATE TABLE scheduled_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid REFERENCES scheduled_tasks(id) ON DELETE SET NULL,  -- 수동 trigger는 NULL
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_run_id uuid REFERENCES agent_runs(id),    -- SSE 트레이스 재사용
  triggered_by text NOT NULL CHECK (triggered_by IN ('cron','manual')),
  status text NOT NULL CHECK (status IN ('running','completed','failed')),
  decision_count integer NOT NULL DEFAULT 0,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  cost_usd numeric(10,4) NOT NULL DEFAULT 0,
  diagnostics_json jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX scheduled_runs_workspace_started_idx
  ON scheduled_runs(workspace_id, started_at DESC);

-- ingestion_decisions에 origin 추적
ALTER TABLE ingestion_decisions
  ADD COLUMN scheduled_run_id uuid REFERENCES scheduled_runs(id) ON DELETE SET NULL;
CREATE INDEX ingestion_decisions_scheduled_run_idx
  ON ingestion_decisions(scheduled_run_id) WHERE scheduled_run_id IS NOT NULL;
```

> **`model_runs.origin`은 v1에 추가하지 않는다** — 기존 `agent_run_id` FK + `agent_runs ↔ scheduled_runs` 조인으로 origin 분리 가능. 컬럼 추가는 후속 phase에서 관측이 무거워질 때 도입.

### 신규 파일

| 파일 | 책임 | 라인 추정 |
|---|---|---|
| `packages/worker/src/workers/scheduled-agent.ts` | BullMQ Worker, scheduled_runs 생성, runIngestionAgentShadow 호출, outcome 기록 | ~200 |
| `packages/worker/src/lib/scheduled/input-adapter.ts` | scheduled_tasks/manual body → AgentInput 변환, `collectDescendantPageIds()`로 트리 확장, system prompt에 "재구성 모드" 한 단락 prepend | ~120 |
| `packages/api/src/routes/v1/scheduled-tasks.ts` | CRUD + 수동 trigger + BullMQ repeatable 등록/제거 | ~280 |
| `packages/api/src/lib/scheduled-agent-enqueue.ts` | 워커에 job 넣는 헬퍼 (수동·cron 공용) | ~80 |
| `packages/web/src/pages/ScheduledAgentPage.tsx` | 스케줄 등록/편집/일시정지 + 최근 run 목록 | ~320 |
| `packages/web/src/components/scheduled/RunReorganizeButton.tsx` | 페이지 헤더에 "AI 재정리" 버튼 + 모달 (지시문 입력, 하위 포함 토글) | ~150 |

### 수정 파일

| 파일 | 변경 내용 |
|---|---|
| `packages/worker/src/lib/agent/loop.ts:158-186` | `RunIngestionAgentShadowInput`에 `origin?: 'ingestion' \| 'scheduled'`, `seedPageIds?: string[]`, `instruction?: string`, `scheduledRunId?: string` 추가 |
| `packages/worker/src/lib/agent/loop.ts` (시스템 프롬프트) | `origin === 'scheduled'`일 때 시스템 메시지에 한 단락 prepend: "이건 새 정보 인입이 아니라 기존 페이지 정리 요청이다. `replace_in_page`/`edit_page_section`을 우선하고 `create_page`는 마지막 수단" + 사용자 instruction 포함 |
| `packages/worker/src/lib/agent/dispatcher.ts:120-206` | state 초기화 시 `seedPageIds`를 `seenPageIds`에 prefill |
| `packages/worker/src/lib/agent/tools/mutate.ts` | mutation 결과를 decision으로 떨어뜨릴 때, `workspace.scheduled_auto_apply === false` AND origin === 'scheduled'면 status를 항상 `suggested`로 강제 (confidence 무관) |
| `packages/api/src/lib/apply-decision.ts` | decision 적용 시 scheduled_run_id가 있으면 같이 stamping; revision의 `source` 필드에 `scheduled` 값 허용 |
| `packages/worker/src/index.ts` | `createScheduledAgentWorker()` 등록 |
| `packages/shared/src/constants/index.ts:237` | `QUEUE_NAMES.SCHEDULED_AGENT = 'scheduled-agent-queue'` |
| `packages/web/src/pages/ReviewQueuePage.tsx` | origin 필터 칩(ingestion/scheduled) + 결정 카드에 origin 뱃지 |
| `packages/web/src/pages/AISettingsPage.tsx` | "Scheduled Agent" 섹션: enabled 토글, auto_apply 토글, daily token cap, per-run page limit |
| `packages/web/src/App.tsx` 또는 라우터 | `/settings/scheduled-agent` 라우트 추가 |

---

## 재사용 부품 (그대로 import — 신규 코드 0)

| 함수/모듈 | 위치 | 용도 |
|---|---|---|
| `runIngestionAgentShadow()` | `packages/worker/src/lib/agent/loop.ts:845` | explore→plan→execute 루프 본체 |
| `createAgentDispatcher()` | `packages/worker/src/lib/agent/dispatcher.ts:120` | 도구 디스패치 + 할당량 + dedupe |
| `createReadOnlyTools()` | `packages/worker/src/lib/agent/tools/read.ts:911` | search_pages, read_page, list_folder, find_related_entities, list_recent_pages |
| `createMutateTools()` | `packages/worker/src/lib/agent/tools/mutate.ts:823` | replace_in_page, edit_page_blocks, edit_page_section, update_page, append_to_page, create_page, noop, request_human_review |
| `getAIAdapter()` | `packages/worker/src/ai-gateway.ts:546` | OpenAI/Gemini 라우팅 (Claude는 v1 미포함) |
| `agentTraceChannel()` | `packages/shared/src/constants/index.ts:38` | SSE 라이브 트레이스 — `AgentTracePanel` 그대로 사용 |
| `applyDecision()` / `detectHumanConflict()` | `packages/api/src/lib/apply-decision.ts`, `packages/worker/src/workers/patch-generator.ts:56` | conflict-aware persist (그대로 동작) |
| `collectDescendantPageIds()` | `packages/api/src/lib/page-deletion.ts:133` | 하위 페이지 트리 (재귀 CTE) |
| Token Lua 스크립트 | `packages/worker/src/workers/ingestion-agent.ts:182-217` | daily token cap (workspace.scheduled_daily_token_cap에 적용) |

---

## Auto-apply 정책 (확정)

기본 동작: **scheduled origin의 모든 mutation은 confidence 무관 `suggested`** — 사람이 `/review`에서 확인.

오버라이드: `workspaces.scheduled_auto_apply = true`일 때만 기존 ingestion 정책(≥0.85 auto-apply, 0.60~0.84 suggested) 적용.

구현 위치: `mutate.ts`에서 decision INSERT 직전에 한 줄 가드:
```ts
if (input.origin === 'scheduled' && !workspace.scheduledAutoApply) {
  decisionStatus = 'suggested';   // confidence 무시
}
```

UI: `AISettingsPage`에 토글 명시 — "Auto-apply scheduled agent decisions (off recommended for experiments)".

---

## Verification (v1 종료 시점에 수행)

**Phase 1 종료 조건**: 두 시나리오가 끝까지 동작.

**시나리오 A — 수동 재구성**:
1. 테스트 워크스페이스에 페이지 5개(부모 1 + 자식 4) 작성
2. 부모 페이지 헤더의 "AI 재정리" 버튼 클릭, 지시문 "중복된 섹션을 정리하고 핵심만 남겨줘", 하위 포함 ON
3. 모달이 닫히고 toast로 "Run started"
4. `scheduled_runs`에 row 생성 → 'running' → 'completed'
5. AgentTracePanel(SSE)에 explore→plan→execute 단계 트레이스 노출
6. `/review`에 origin='scheduled' 결정 N개, 모두 status='suggested'
7. 한 결정 승인 → page_revisions 새 row, source='scheduled', `last_ai_updated_at` 갱신

**시나리오 B — 주기 실행**:
1. `/settings/scheduled-agent`에서 task 생성: cron `*/5 * * * *`, target=특정 페이지, instruction="진부한 표현 점검"
2. BullMQ Bull Board(`/admin/queues`)에서 repeatable job 등록 확인
3. 5분 후 자동 발화 → scheduled_runs row 생성, 위와 동일 흐름
4. task disable 토글 → BullMQ에서 repeat key 제거 확인

**부수 검증**:
- conflict 시나리오: 인간 편집과 동시 trigger → 기존 `detectHumanConflict()`가 그대로 동작해 'suggested'로 다운그레이드
- 비용: `model_runs` 집계 쿼리에서 `agent_run_id IN (SELECT agent_run_id FROM scheduled_runs)` 조건으로 일일 토큰/$ 확인
- 토큰 캡: `scheduled_daily_token_cap` 도달 시 다음 tick이 자동 스킵

**테스트 명령**:
```bash
pnpm --filter db migrate
pnpm --filter shared build
pnpm --filter worker dev   # 별도 터미널
pnpm --filter api dev      # 별도 터미널
pnpm --filter web dev      # 별도 터미널
# Playwright로 시나리오 A를 e2e: tests/e2e/scheduled-agent.spec.ts (신규)
pnpm test -- scheduled-agent
```

---

## v2+ 후속 (이번 v1 범위 아님)

- **dry_run preview** + 승인 모달 (`dry_run_previews` 테이블 + UI)
- **dry_run → shadow → live promotion gate** (`scheduled-agent-gate.ts`, `evaluateAgentParityGate` 패턴 재사용)
- **Claude adapter** (ai-gateway.ts:536 TODO 마커)
- **fallback_rewrite를 spec의 명시적 brief 인터페이스로 분리**
- **`must_block_commit` 강한 차단 신호**
- **workspace.domain 필드** (public/school/enterprise/personal/dev) + 도메인별 confidence 정책
- **`model_runs.origin`** 컬럼 (관측이 무거워지면)
- **`idle_recurring` 진단** (3회 연속 noop 감지)

---

## 위험 / 운영 주의

1. **무한 루프 방어** — scheduled run이 만든 revision이 다른 scheduled를 또 트리거하면 안 됨. v1에서는 cron이 페이지 ID로 명시 타깃하므로 문제 없으나, v2에서 "워크스페이스 전체 lint" 도입 시 origin='scheduled'인 변경은 다음 cron의 입력에서 제외하는 가드 필요.
2. **BullMQ repeatable cleanup** — scheduled_task DELETE 시 `bull_repeat_key`로 BullMQ에서 반드시 제거. API 핸들러에 트랜잭션-after-commit hook 또는 DB row를 캐스케이드 삭제하지 말고 명시적 정리 단계 거치기.
3. **토큰 폭주** — 첫 출하에는 `scheduled_daily_token_cap = 100k` 같은 보수적 기본값 권장. cron interval은 ≥1시간으로 시작.
4. **conflict 동시성** — 같은 페이지에 두 scheduled run이 동시 작성 시 두 번째는 patch-generator의 `parent_revision_id` 기반 검출에서 'suggested'로 다운그레이드됨. v1에서 별도 처리 불필요.
5. **트레이스 SSE 재사용** — 기존 `agent-runs:trace:{agentRunId}` 채널을 그대로 쓰므로 `AgentTracePanel`이 scheduled run에도 자동 동작. URL만 `?agentRunId=...`로 같으면 됨.
