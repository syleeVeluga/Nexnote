# Ingestion Agent — Tool-calling 기반 다중 페이지 위키 유지보수 계획

> **상태**: 승인됨 (2026-04-29) · AGENT-1~4 완료, shadow parity gate 대기
> **유형**: 구현 RFC (PRD 아님)
> **모티브**: [Karpathy gist — LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 의 *"한 번의 ingest로 LLM이 10–15개 페이지를 동시에 갱신한다"* 패턴

## Document location & separation from PRD/ERD

이 계획은 PRD가 아니라 **구현 RFC**다. 프로젝트의 기존 상위 문서와 명확히 분리:

| 종류 | 위치 | 성격 |
|---|---|---|
| 제품 비전·요구사항 | [`docs/PRD — AI 보조 Markdown 지식 위키문서 서비스.md`](PRD%20%E2%80%94%20AI%20%EB%B3%B4%EC%A1%B0%20Markdown%20%EC%A7%80%EC%8B%9D%20%EC%9C%84%ED%82%A4%EB%AC%B8%EC%84%9C%20%EC%84%9C%EB%B9%84%EC%8A%A4.md) | 무엇을·왜 |
| 데이터 모델 | [`docs/ERD 초안 — AI 기반 Markdown 지식 위키 서비스.md`](ERD%20%EC%B4%88%EC%95%88%20%E2%80%94%20AI%20%EA%B8%B0%EB%B0%98%20Markdown%20%EC%A7%80%EC%8B%9D%20%EC%9C%84%ED%82%A4%20%EC%84%9C%EB%B9%84%EC%8A%A4.md) | 테이블·관계 |
| 백로그 / 진행 상태 | [`docs/TASKS.md`](TASKS.md) | 진척도 |
| **구현 계획·RFC** | [`docs/`](.) | **어떻게** (이 문서 포함) |
| 운영 가이드 | [`docs/slack-webhook.md`](slack-webhook.md) 등 | 운영 절차 |
| 오케스트레이터 가이드 | 루트 [`AGENTS.md`](../AGENTS.md), [`CLAUDE.md`](../CLAUDE.md) | 에이전트 지시 |

`docs/` 안에서 `ingestion-agent-plan.md`처럼 **구현 RFC는 명시적 동사+범위 prefix** 사용 → PRD/ERD와 자연스럽게 구분. PR마다 본 문서 갱신.

## Context

WekiFlow의 핵심 약속은 "외부 신호가 들어와도 위키가 자동 최신화된다"인데, 현재 ingestion은 **사실상 항상 새 페이지를 만든다**. 코드 조사로 원인을 확정:

- [route-classifier.ts:240](../packages/worker/src/workers/route-classifier.ts#L240) ROUTE_SYSTEM_PROMPT가 *"Be conservative — prefer needs_review if confidence < 0.6"* 로 보수 편향
- DB에서 후보 10개 찾지만 LLM에는 **상위 3개만** 노출되고 후보당 100토큰만 할당 → incoming 80k에 묻힘 ([route-classifier.ts:293,302](../packages/worker/src/workers/route-classifier.ts#L293))
- 후보 검색이 0개를 반환하면 LLM이 `"(no existing pages found)"`만 보고 **무조건 create**
- **단일 LLM 호출** 구조라 능동 탐색·다중 페이지 갱신·tool calling이 구조적으로 불가능 ([ai-gateway.ts:7-9](../packages/worker/src/ai-gateway.ts#L7))
- 반면 apply 단계의 [apply-decision.ts](../packages/api/src/lib/apply-decision.ts) + [patch-generator.ts:159-299](../packages/worker/src/workers/patch-generator.ts#L159)은 update(LLM 병합)/append(concat) 모두 동작 — **분류 단계만 막혀 있다**

목표 결과: Karpathy gist의 *"한 번의 ingest로 LLM이 10–15개 페이지를 동시에 갱신한다"* 패턴을 도입. 한 ingestion이 search/read 도구를 능동적으로 써서 워크스페이스를 탐색한 뒤, 필요한 만큼의 create/update/append 결정을 fan-out으로 발행한다. 모든 안전장치(0.85/0.60 confidence 게이트, baseRevisionId 충돌 검출, audit_logs, model_runs)는 그대로 보존.

스택 결정: **기존 ai-gateway에 native tool-calling 확장** (TS 유지, pydantic-ai 미도입). Workspace-level feature flag로 **첫 주는 shadow mode**, 합의도 검증 후 단계 전환.

---

## Architecture

### Loop: Explore → Plan → Execute (하이브리드)

순수 ReAct는 update_page 발행 후 후속 관측이 다른 페이지가 맞다고 알려주는 *commit-too-early* 사고가 잦다. 따라서:

1. **Explore** (read-only ReAct): search_pages / read_page / list_folder / find_related_entities / list_recent_pages 자유 호출
2. **Plan** (구조화된 1-turn): `proposed_plan: Mutation[]` JSON을 강제 출력 — 검토용 단일 아티팩트, shadow mode 비교 기준점
3. **Execute** (mutate tools): create_page / update_page / append_to_page / noop / request_human_review를 plan 항목 단위로 발행

### Hard limits (전부 dispatcher에서 enforce)

| 제한 | 값 | env |
|---|---|---|
| 총 step | 15 | `AGENT_MAX_STEPS` |
| 1턴당 tool call | 5 | `AGENT_MAX_CALLS_PER_TURN` |
| 한 run의 mutation | 20 | `AGENT_MAX_MUTATIONS` |
| wall-clock | 60s | `AGENT_TIMEOUT_MS` |
| 입력 토큰 budget (1턴 max) | 800k (Opus 1M·Gemini 1M 활용 위해 ↑) | `AGENT_INPUT_TOKEN_BUDGET` |
| 출력 토큰 budget (run 누적) | 60k | `AGENT_OUTPUT_TOKEN_BUDGET` |
| per-tool 호출 (search ≤8, read ≤20) | dispatcher 상수 |
| workspace 일일 토큰 cap | 5M (조정 가능) | `AGENT_WORKSPACE_DAILY_TOKEN_CAP` |

기존 100k 통합 budget은 **컨텍스트 활용을 일부러 줄이는 잘못된 보수성**이었다. agent의 가장 큰 가치가 "관련 페이지 전부를 한 번에 보고 판단"인데 그걸 막으면 안 됨. 대신 입출력 분리 (입력은 크게 / 출력은 빠듯하게).

### Context window strategy (대형 컨텍스트 적극 활용)

**원칙**: search/read로 발견된 모든 관련 페이지를 가능한 한 **plan turn에서 동시에 본다**. truncate는 dispatcher가 token-aware로 적응적으로 결정.

1. **read_page는 기본 full-content 반환** (구 100토큰 snippet 폐기). 페이지가 크면 (>30k 토큰) 자동으로 `format=blocks` 모드로 전환 → 헤딩 + 첫 N토큰의 블록 목록 반환, agent가 필요한 blockId만 재요청.

2. **턴 직전 budgeter** (`packages/worker/src/lib/agent/budgeter.ts` 신규):
   - 누적 메시지 + 새 read 결과의 토큰 합산
   - 모델별 컨텍스트 한계 - 출력 reservation - 안전 마진 = 사용 가능량
   - 초과 시: 가장 오래된 read_page 결과를 "summary form"으로 압축 (이미 plan에 인용된 부분은 보존), 압축 못 하면 가장 오래된 thought 제거
   - 모든 압축 사실을 system message로 agent에 통지 ("page X가 요약 형태로 변환됨, 원본 필요 시 read_page 재호출")

3. **모델 선택 적응**:
   - 워크스페이스 ingestion_mode = `agent` 시 `AGENT_MODEL_LARGE_CONTEXT` (예: `claude-opus-4-7`, `gemini-3.1-pro`, `gpt-5.4-pro`)
   - 입력 토큰 추정 < 50k 인 가벼운 케이스만 `AGENT_MODEL_FAST` (작은 모델)로 다운라우트 — 비용 절감
   - 모델 선택 사실은 `agent_runs.steps_json`에 step 0로 기록

4. **Read 결과 캐시**: 같은 run에서 동일 pageId 재요청 시 캐시 (이미 `dispatcher.ts`의 dedupe와 통합). 다만 mutate 후 해당 pageId는 캐시 무효화 (agent가 자기 변경을 봐야 하므로).

5. **Plan turn 전용 패킹**: explore phase 종료 후 plan turn 진입 시 dispatcher가 **모든 read 결과 + 원본 ingestion + 후보 트리거**를 단일 user message로 재정렬해 `[CONTEXT]` 블록에 packing → 모델이 cross-reference 하기 쉬움. ReAct 단계의 산발적 turn 누적이 아니라 의도적 배치.

| 모델 | 입력 컨텍스트 | 1턴 input cap (안전 마진 후) | 출력 reservation |
|---|---|---|---|
| claude-opus-4-7 (1M) | 1,000,000 | 800,000 | 16,000 |
| gpt-5.4-pro | 200,000* | 160,000 | 16,000 |
| gemini-3.1-pro | 1,000,000 | 800,000 | 8,000 |

\* 정확한 수치는 [packages/shared/src/constants/index.ts](../packages/shared/src/constants/index.ts) AI_MODELS에서 핀. 변경 시 한 곳만 수정.

초과 시 → `agent_runs.status='timeout'`, partial trace 보존, ingestion_decisions에 단일 `needs_review` 행 작성.

### Tool surface (모든 tool은 dispatcher가 workspaceId를 closed-over로 주입 — LLM 인자 무시)

**Read (순수 SQL, AI 호출 없음)**
- `search_pages({ query, limit? })` — title LIKE + FTS + trigram (route-classifier의 검색을 재사용)
- `read_page({ pageId, format?: "markdown"|"summary"|"blocks" })` — 본문/요약/블록 목록 반환
- `list_folder({ folderId? })` — 폴더 트리 / 루트
- `find_related_entities({ text, limit? })` — entity 매칭으로 페이지 찾기 (기존 entity overlap)
- `list_recent_pages({ limit? })` — lastAiUpdatedAt / lastHumanEditedAt 기준

**Mutate (각 호출이 ingestion_decisions row 1개 생성, 편집 granularity 3-tier)**

VS Code의 인라인 AI 편집처럼 **변경이 필요한 부분만 정확히 패치**한다. 전체 페이지 재작성은 fallback이지 default가 아니다. 기존 [revision_diffs](../packages/db/src/schema/revisions.ts) 스키마가 이미 `lineDiff` + `blockOpsDiff` 양쪽을 저장하므로 자연스럽게 매핑됨.

| Tier | Tool | 용도 | 발행 diff 형태 |
|---|---|---|---|
| 1. 가장 정밀 | `replace_in_page({ pageId, find, replace, occurrence?, confidence, reason })` | inline 한 단어/문장 수정 (오타·수치·날짜) | line diff, 검증 후 적용 |
| 2. 블록 단위 | `edit_page_blocks({ pageId, ops: [{ blockId, op: "replace"\|"insert_after"\|"insert_before"\|"delete", content? }], confidence, reason })` | 특정 단락·리스트·코드블록 교체/삽입 | block ops diff |
| 3. 섹션 단위 | `edit_page_section({ pageId, sectionAnchor, op: "replace"\|"append"\|"prepend"\|"delete", content, confidence, reason })` | `## API Reference` 같은 heading 하위 전체 처리 | block ops + line diff |
| (구) 페이지 전체 | `update_page({ pageId, newContentMd, confidence, reason })` | 위 3종으로 표현 불가한 대규모 재구성 시 fallback | full rewrite |
| 끝부분 추가 | `append_to_page({ pageId, contentMd, sectionHint?, confidence, reason })` | 새 섹션 신설 | concat |
| 신규 | `create_page({ title, contentMd, parentFolderId?, confidence, reason })` | — | 신규 revision |
| 보조 | `noop({ reason })`, `request_human_review({ reason, suggestedAction?, suggestedPageIds[]? })` | | 결정만 기록 |

**Plan turn에서 tier 선택을 강제**: agent가 mutation을 제안할 때 가장 좁은 tier를 우선. Plan validator가 *"전체 페이지 70% 이상이 동일하면 update_page 금지, edit_page_blocks로 분해하라"* 규칙으로 self-correct 1턴 부여. Tier 1·2·3는 **patch-generator 호출 없이** 직접 새 revision을 만든다 (LLM 재호출 없음 → 비용 절감 + 의도 보존). update_page/append_to_page만 patch-generator를 거침.

Mutate는 **DB에 직접 쓰지 않고** [apply-decision.ts approveDecision()](../packages/api/src/lib/apply-decision.ts)을 호출 → confidence 게이트, baseRevisionId 충돌 검출, audit_logs, modelRunId 추적이 그대로 동작. tier 1·2·3는 approveDecision에 미리 만든 newContentMd를 전달하는 새 경로 추가.

Tier 1·2·3는 동기 적용 (LLM 호출 없으니 즉시), update_page/append_to_page는 patch-generator 대기 (20s cap). 그래야 agent가 자기 변경을 후속 read에서 본다.

**Validation (dispatcher에서)**
- `replace_in_page`: `find` 문자열이 본문에 정확히 N개 매치되어야 함 (occurrence 미지정 시 1개만 허용). 미매치/다중매치 시 recoverable error → agent가 더 정확한 find로 재시도
- `edit_page_blocks`: `blockId`는 본 run에서 read_page(format=`blocks`)로 관측한 ID여야 함 (UUID hallucination 방어와 동일 메커니즘)
- `edit_page_section`: `sectionAnchor`가 현재 markdown에서 정확히 1개 heading과 매치되어야 함

### Safety invariants

1. **Cross-workspace leak**: 모든 tool dispatcher가 job context의 `workspaceId`를 클로저로 캡처. LLM이 `workspaceId` 인자를 보내도 무시. 위조 인자 거부 통합 테스트 필수.
2. **UUID hallucination**: mutate tool args의 `pageId`는 (a) 본 run에서 read tool로 관측됐거나 (b) 본 run에서 create_page가 mint한 UUID여야 함. dispatcher가 in-memory `seenUUIDs` set 유지. 위반 시 recoverable error 반환 (agent가 재탐색 가능).
3. **AI-vs-AI race**: 같은 turn 내 동일 `targetPageId`에 대한 병렬 mutation 거부. mutation 직전 매번 `currentRevisionId` 재조회.
4. **Tool dedupe**: 동일 args의 read 호출은 캐시 + system message로 안내 ("you already searched X").

### AI gateway 확장 (가장 위험한 변경 — 먼저 만든다)

[ai-gateway.ts](../packages/worker/src/ai-gateway.ts)의 `AIRequest`/`AIResponse`에 normalized tool 필드 추가:

```typescript
interface AIRequest {
  messages: Message[];
  responseFormat?: "json" | "text";
  tools?: ToolDefinition[];           // 신규
  toolChoice?: "auto" | "required" | "none";  // 신규
}
interface AIResponse {
  content: string;
  toolCalls?: NormalizedToolCall[];   // 신규
  // ...existing
}
```

OpenAI(`tool_calls`/`tool` role) ↔ Gemini(`functionCall`/`functionResponse`) 차이는 어댑터 경계에서 흡수. **Gemini는 strict JSON schema 미지원**이라고 가정하고 모든 tool args는 Zod로 dispatcher에서 재검증. 두 어댑터가 동일 fixture에 대해 동일한 `NormalizedToolCall[]`을 반환하는지 conformance 테스트 1개 필수.

### Schema 변경 (backwards-compatible, NULL fallback)

신규 migration `0015_agent_runs.sql`:

```sql
CREATE TABLE agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ingestion_id UUID NOT NULL REFERENCES ingestions(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL,                -- running|completed|failed|timeout|shadow
  plan_json JSONB,                     -- explore→plan 단계의 proposed_plan
  steps_json JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{step,type,payload,ts}]
  decisions_count INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_latency_ms INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX agent_runs_ingestion_idx ON agent_runs(ingestion_id);
CREATE INDEX agent_runs_workspace_started_idx ON agent_runs(workspace_id, started_at DESC);

ALTER TABLE model_runs ADD COLUMN agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL;
ALTER TABLE ingestion_decisions ADD COLUMN agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL;
ALTER TABLE workspaces ADD COLUMN ingestion_mode TEXT NOT NULL DEFAULT 'classic';  -- classic|shadow|agent
```

기존 classic classifier 행은 모두 NULL FK → 영구 구분 가능, 마이그레이션 없이 공존.

### Migration & rollout

- 워크스페이스 토글 `workspaces.ingestion_mode = 'classic' | 'shadow' | 'agent'`
- [enqueue-ingestion.ts](../packages/api/src/lib/enqueue-ingestion.ts)이 모드를 읽어 `classic`은 route-classifier만, `shadow`는 route-classifier + `JOB_NAMES.INGESTION_AGENT`를 병행 enqueue. BullMQ worker가 같은 queue에서 job name별 자동 라우팅을 하지 않으므로 agent는 별도 `QUEUE_NAMES.INGESTION_AGENT` queue를 사용한다.
- **shadow 모드**: agent가 plan_json까지만 만들고 `agent_runs` 기록, ingestion_decisions는 classic이 소유. 합의도(% agreement) 대시보드 1주일 관찰
- 합의도 OK → 워크스페이스 단위로 `agent` 모드 승격
- classic은 2주 후 제거 (기존 classic decision 행 보존)

### UI 변경 (최소 set)

| 파일 | 변경 |
|---|---|
| [IngestionDetailPage.tsx](../packages/web/src/pages/IngestionDetailPage.tsx) | 단일 decision → decision[] 렌더링, 신규 "Agent trace" 탭 |
| [ReviewQueuePage.tsx](../packages/web/src/pages/ReviewQueuePage.tsx) | decision 카드에 "(2 of 7 from ingestion X)" 배지 |
| 신규 `AISettingsPage.tsx` + 사이드바 nav | 모드 토글 (classic/shadow/agent), 모델·budget 노출 |
| 신규 `AgentTracePanel.tsx` | `agent_runs.steps_json` 시각화 (thought / tool_call / tool_result 타임라인) |

v1에서는 sibling decision의 bulk approve 금지 — 각자 독립 검토 (의도된 fan-out 보존).

---

## Critical files

**신규**
- `packages/worker/src/lib/agent/types.ts` — ToolDefinition, NormalizedToolCall, AgentRunState
- `packages/worker/src/lib/agent/tools/read.ts` — 5종 read tool, workspaceId 클로저 캡처, full-content 반환
- `packages/worker/src/lib/agent/tools/mutate.ts` — 7종 mutate (replace_in_page, edit_page_blocks, edit_page_section, update_page, append_to_page, create_page, noop, request_human_review), apply-decision 래핑
- `packages/worker/src/lib/agent/patch/inline-patch.ts` — replace_in_page (find/replace 검증, 정확히 N매치 enforce)
- `packages/worker/src/lib/agent/patch/block-patch.ts` — markdown → 블록 파싱(remark), blockId 부여, blockOps 적용
- `packages/worker/src/lib/agent/patch/section-patch.ts` — heading anchor 매칭, 섹션 단위 op
- `packages/worker/src/lib/agent/budgeter.ts` — 컨텍스트 토큰 회계, 적응적 truncation, 모델 라우팅
- `packages/worker/src/lib/agent/dispatcher.ts` — quota, dedupe, seenUUIDs/seenBlockIds, validation
- `packages/worker/src/lib/agent/loop.ts` — explore→plan→execute orchestrator
- `packages/worker/src/workers/ingestion-agent.ts` — BullMQ entry
- `packages/db/src/schema/agent-runs.ts`
- `packages/db/src/migrations/0015_agent_runs.sql`
- `packages/shared/src/schemas/agent.ts` — tool schemas, plan schema
- `packages/api/src/routes/v1/agent-runs.ts` — GET trace
- `packages/api/src/routes/v1/ai-settings.ts` — 모드 토글 PATCH
- `packages/web/src/pages/AISettingsPage.tsx`
- `packages/web/src/components/agents/AgentTracePanel.tsx`

**수정**
- [packages/worker/src/ai-gateway.ts](../packages/worker/src/ai-gateway.ts) — tools/toolCalls 정규화, OpenAI/Gemini 어댑터 양쪽 구현
- [packages/worker/src/queues.ts](../packages/worker/src/queues.ts) + [packages/worker/src/workers/index.ts](../packages/worker/src/workers/index.ts) + [packages/api/src/plugins/queue.ts](../packages/api/src/plugins/queue.ts) — INGESTION_AGENT queue/워커 등록
- [packages/api/src/lib/enqueue-ingestion.ts](../packages/api/src/lib/enqueue-ingestion.ts) — `workspaces.ingestion_mode` 읽어 분기
- [packages/shared/src/constants/index.ts](../packages/shared/src/constants/index.ts) — JOB_NAMES.INGESTION_AGENT, AGENT_LIMITS, INGESTION_MODES
- [packages/db/src/schema/users.ts](../packages/db/src/schema/users.ts) — workspaces.ingestion_mode 컬럼 (Drizzle)
- [packages/db/src/schema/ingestions.ts](../packages/db/src/schema/ingestions.ts) + `packages/db/src/schema/model-runs.ts` — agent_run_id FK
- [packages/web/src/pages/IngestionDetailPage.tsx](../packages/web/src/pages/IngestionDetailPage.tsx)
- [packages/web/src/pages/ReviewQueuePage.tsx](../packages/web/src/pages/ReviewQueuePage.tsx)
- [packages/web/src/components/layout/Sidebar.tsx](../packages/web/src/components/layout/Sidebar.tsx) — AI Settings nav
- [packages/api/src/lib/apply-decision.ts](../packages/api/src/lib/apply-decision.ts) — modelRunId 외 agentRunId도 받도록 (옵셔널)

**재사용** (변경 없이 그대로)
- [patch-generator.ts](../packages/worker/src/workers/patch-generator.ts) — update_page/append_to_page fallback 경로에서만 호출 (tier 1·2·3 patch는 LLM 재호출 없이 직접 revision 생성)
- `packages/db/src/schema/revisions.ts` revision_diffs — 신규 patch tier들이 lineDiff/blockOpsDiff 컬럼에 자연 매핑
- 기존 classifyDecisionStatus / CONFIDENCE 임계값 / baseRevisionId 충돌 검출 / audit_logs 기록 전부

---

## Implementation order

8 epic은 4 단계로 묶는다(의존 그래프 + parity gate). [`docs/TASKS.md`](TASKS.md) 의 AGENT-1..AGENT-8 ticket과 1:1 미러링.

### Sub-doc 정책 (just-in-time, hybrid)

- **무거운 단계 4개** (AGENT-1/3/4/5)는 진입 시점에 `docs/ingestion-agent-step-N-<scope>.md` sub-doc 신규 생성:
  - AGENT-1 → `docs/ingestion-agent-step-1-gateway.md`
  - AGENT-3 → `docs/ingestion-agent-step-3-tools-dispatcher.md`
  - AGENT-4 → `docs/ingestion-agent-step-4-loop-shadow.md`
  - AGENT-5 → `docs/ingestion-agent-step-5-mutate-tiers.md`
- 각 sub-doc은 (a) 인터페이스 결정 (b) 발견된 코드 제약 / 재사용 후보 (c) 테스트 fixture 위치 (d) 단계별 verification 만 담는다. 본 RFC 본문 복붙 금지.
- **가벼운 단계 4개** (AGENT-2/6/7/8)는 sub-doc 없이 PR description + 본 RFC 갱신 + TASKS.md 진행 상태로만 처리.
- 단계 머지 후 [`docs/TASKS.md`](TASKS.md) AGENT-N 항목에 `[DONE · YYYY-MM-DD]` 마킹 + 한 줄 요약, AGENT-1/3 머지 후 [`CLAUDE.md`](../CLAUDE.md) "Current Implementation Status" 표 갱신.

### Phase A — Foundation (직렬 의존)

0. **이 문서를 `docs/ingestion-agent-plan.md`로 보관** (PRD와 분리된 구현 RFC). PR description에서 본 문서를 이정표로 참조 — **완료**
1. **AGENT-1 · [DONE · 2026-04-29] AI gateway 확장** + OpenAI/Gemini conformance test. 다른 모든 작업의 prerequisite. **차단**: 없음 (시작점). sub-doc `step-1-gateway.md` 생성 및 gateway 정규화 구현 완료
2. **AGENT-2 · [DONE · 2026-04-29] `0015_agent_runs.sql` migration + Drizzle schema** + `workspaces.ingestion_mode` 컬럼. NULL FK라 backwards-compat. **차단**: 없음 (AGENT-1과 병렬 가능). sub-doc 없음. 완료: `agent_runs`, nullable `agent_run_id` FKs, `ingestion_mode` check/default, Drizzle schema, 공유 constants 반영
3. **AGENT-3 · [DONE · 2026-04-29] Read-only tool layer + dispatcher** (workspaceId closed-over, quotas, dedupe). 단독 실행 가능한 모듈로 격리 검증. **차단**: AGENT-1, AGENT-2. sub-doc `step-3-tools-dispatcher.md` 완료. 완료: 5개 read tool, shared schemas, dispatcher quota/dedupe/seen-id 추적, worker 단위 테스트

### Phase B — Shadow validation

4. **AGENT-4 · [DONE · 2026-04-29] Agent loop in shadow mode** — `agent_runs.plan_json`만 기록, ingestion_decisions는 안 건드림. budgeter + 모델 라우팅 포함. **차단**: AGENT-1, AGENT-2, AGENT-3. 완료: sub-doc `step-4-loop-shadow.md`, `budgeter.ts`, `loop.ts`, `ingestion-agent` worker, 별도 `ingestion-agent` queue, shadow enqueue 병행 실행, worker 단위 테스트
- **Parity gate** — 사내 워크스페이스 1주 운영. daily `agent_vs_classic_agreement_rate` (action 일치율 + target page 일치율) 관찰. 합의도 미달 시 prompt/tool 조정 후 재관찰. 통과 전엔 Phase C 진입 금지

### Phase C — Go-live (Parity gate 통과 후, 5/6/7 병렬 가능)

5. **AGENT-5 · [L] Mutate tool wrappers (3-tier patches)** — `replace_in_page` / `edit_page_blocks` / `edit_page_section`는 LLM 재호출 없이 직접 revision 생성, `update_page` / `append_to_page`만 patch-generator fallback. apply-decision wrapper, 동일 페이지 락, seenUUIDs/seenBlockIds 검사. **차단**: Parity gate. → sub-doc `step-5-mutate-tiers.md` 생성 후 진입
6. **AGENT-6 · [S] Workspace 토글 + `/settings/ai`** — 기본 'classic', 사내 워크스페이스부터 'shadow' → 'agent'. **차단**: AGENT-2 (컬럼 존재). 실효성은 AGENT-5 이후. sub-doc 없음
7. **AGENT-7 · [M] UI fan-out** — IngestionDetailPage decision[] 렌더, ReviewQueuePage sibling 배지, AgentTracePanel. **차단**: AGENT-2 (`agent_run_id` FK). 실효성은 AGENT-4 이후. sub-doc 없음

### Phase D — Cleanup

8. **AGENT-8 · [S] Cutover & retire classic** — 워크스페이스 단위 단계 전환, 토큰 비용 + parity 대시보드 모니터링, **'agent' 모드 2주 클린 운영** 후 classic route-classifier 제거. 기존 classic decision 행은 NULL FK로 보존. sub-doc 없음

가장 leveraged 결정: AGENT-1 gateway 정규화. 가장 위험한 누락: AGENT-4 shadow mode (parity gate 없으면 production 사고로 직행). 그 외는 회복 가능.

---

## Verification

**유닛/통합**
- [ ] AI gateway conformance test: 동일 fixture (system+user+tools) 입력 시 OpenAI vs Gemini 어댑터가 동일 normalized `toolCalls[]` 반환
- [ ] Tool dispatcher 위조 workspaceId 인자 무시 테스트 (cross-workspace leak)
- [ ] UUID hallucination 방어: 본 run에서 관측 안 된 pageId로 update_page 호출 시 recoverable error
- [ ] 동일 turn 내 동일 pageId 병렬 update 거부
- [ ] Per-tool quota 초과 시 dispatcher가 거부, agent loop는 종료 가능
- [ ] approveDecision 호출 시 audit_logs / model_runs / baseRevisionId 충돌 다운그레이드가 classic과 동일하게 동작
- [ ] **replace_in_page**: find가 0매치/N>1매치/공백차이 시 명확한 recoverable error, 정확 1매치 시 lineDiff에 정확히 1줄 변경만 기록
- [ ] **edit_page_blocks**: 본 run에서 관측 안 된 blockId 거부, replace/insert_after/insert_before/delete 4종 op 정상 동작, 결과 markdown round-trip (parse → ops → render → parse 동일)
- [ ] **edit_page_section**: heading anchor 정확 1매치 enforce, 섹션 경계가 다음 동일/상위 레벨 heading까지 정확히 인식
- [ ] **budgeter**: 누적 메시지가 모델 한계 초과 직전 가장 오래된 read를 summary로 압축, agent에 통지 system message 삽입, 후속 read_page 재호출이 캐시 히트 (mutate 후엔 무효화)
- [ ] **모델 라우팅**: 추정 입력 < 50k면 fast 모델, 이상이면 large-context 모델 선택 — `agent_runs.steps_json[0]`에 결정 사실 기록
- [ ] **Plan validator self-correct**: 70% 이상 동일한 update_page 제안을 edit_page_blocks로 분해 재요청

**E2E**
- [ ] `pnpm dev` 후 시드 워크스페이스에 `ingestion_mode='shadow'` 설정 → 기존 페이지 3개 있는 상태에서 관련 PDF 업로드 → classic이 새 페이지 1개 만들고, agent_runs.plan_json은 update 1 + append 1을 제안하는지 비교
- [ ] 같은 워크스페이스를 `ingestion_mode='agent'`로 승격 → 동일 PDF 업로드 → ingestion_decisions에 fan-out된 row가 생성되고 IngestionDetailPage가 다중 decision 카드 렌더
- [ ] AgentTracePanel이 thought / tool_call / tool_result 순서대로 표시
- [ ] 모드를 'classic'으로 되돌렸을 때 즉시 classic 경로로 복귀 (재배포 불필요)

**모니터링**
- [ ] Shadow week 동안 daily `agent_vs_classic_agreement_rate` 대시보드 (action 일치율, target page 일치율)
- [ ] `agent_runs` 토큰 P50/P95/P99 — P50이 30k 초과 시 알림
- [ ] Workspace daily token cap 작동 확인

---

## Out of scope (v1)

- 워크스페이스-전역 lint job (Karpathy의 stale/contradiction 점검) — v2
- Sibling decision bulk approve UI
- Agent의 triple-level 갱신 (현재 triple-extractor가 page 변경 후 자동 재실행되므로 불필요)
- pydantic-ai / Python 사이드카 (사용자 확정 NO)
- 3D 그래프 토글
