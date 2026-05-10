# Scheduled Agent — 동작 구조 및 프롬프트 명세

> **상태:** 2026-05-07 기준 코드베이스에 적용·동작 중인 Scheduled Agent의 전체 기술 명세.
> **범위:** 본 문서는 Scheduled Agent (origin = `"scheduled"`) 경로에 한정하며, Ingestion Agent / 사용자 직접 편집(User-directed wiki edit) 경로와 공유되는 코드도 함께 다룹니다.
> **참고 문서:** [`docs/architecture/USER_DIRECTED_AGENT_WORKFLOW.md`](architecture/USER_DIRECTED_AGENT_WORKFLOW.md), [`docs/architecture/SYSTEM_ARCHITECTURE.md`](architecture/SYSTEM_ARCHITECTURE.md).

---

## 1. 한눈에 보는 전체 동작 구조

```text
┌──────────────────────────┐                         ┌──────────────────────────┐
│ API: scheduled-tasks.ts  │  cron 등록(BullMQ)      │ BullMQ Job Scheduler     │
│ /reorganize-runs (수동)  │ ───────────────────────▶│ (scheduled-task:WS:TASK) │
└────────────┬─────────────┘                         └─────────────┬────────────┘
             │ enqueueScheduledAgentRun (manual / cron / api)      │
             ▼                                                      ▼
       ┌───────────────────────────────────────────────────────────────┐
       │ BullMQ Queue: scheduled-agent  (JobData = ScheduledAgentJobData)│
       └────────────────────────────┬──────────────────────────────────┘
                                    ▼
       ┌───────────────────────────────────────────────────────────────┐
       │ Worker harness: packages/worker/src/workers/scheduled-agent.ts│
       │  • workspace 정책 로딩 (scheduledEnabled, autoApply, 토큰 cap)│
       │  • scheduled_runs row 생성/업데이트 (running)                 │
       │  • internal apiToken + ingestion row 생성 (멱등)              │
       │  • agent_runs row 생성 (running)                              │
       │  • SSE/Redis 트레이스 publisher 준비                          │
       │  • buildScheduledAgentInput → seedPageIds + normalizedText    │
       │  • runIngestionAgentShadow({ origin: "scheduled", … })        │
       │  • 결과를 ingestions/scheduled_runs/agent_runs/audit_logs에 기록│
       └────────────────────────────┬──────────────────────────────────┘
                                    ▼
       ┌───────────────────────────────────────────────────────────────┐
       │ Agent loop: packages/worker/src/lib/agent/loop.ts             │
       │   1) Explore turn(s)  — read-only tool 호출 (search/read/…)   │
       │   2) Scheduled seed prefetch — selected pages → read_page     │
       │   3) Plan turn 0      — JSON plan 생성                        │
       │   4) Execute mutations (per-turn cap, 실패 시 repair turn)    │
       │   5) Replan turns     — 남은 작업이 있으면 재계획              │
       │   6) Partial review queue — 미실행 plan을 사람 검토로         │
       └───────────────────────────────────────────────────────────────┘
```

진입점, 페이로드 형태, 루프 단계의 구체 시그니처는 아래에서 다룹니다.

---

## 2. 트리거 경로

Scheduled Agent를 실제로 큐에 넣는 경로는 세 가지이며, 모두 동일한 BullMQ 큐(`QUEUE_NAMES.SCHEDULED_AGENT`)에 동일한 페이로드(`ScheduledAgentJobData`)로 도착합니다.

| 트리거 | 진입점 | `triggeredBy` |
|---|---|---|
| 수동 재구성 (REST) | [`packages/api/src/routes/v1/scheduled-agent.ts`](../packages/api/src/routes/v1/scheduled-agent.ts) — `POST /v1/workspaces/:workspaceId/reorganize-runs` | `"manual"` |
| Cron 정기 실행 | [`packages/api/src/lib/scheduled-agent-scheduler.ts`](../packages/api/src/lib/scheduled-agent-scheduler.ts) — `Queue.upsertJobScheduler(...)` | `"cron"` |
| API/내부 호출 | [`packages/api/src/lib/scheduled-agent-enqueue.ts`](../packages/api/src/lib/scheduled-agent-enqueue.ts) | `"manual" \| "cron" \| "api"` |

큐 등록 함수: `enqueueScheduledAgentRun(...)` ([`scheduled-agent-enqueue.ts`](../packages/api/src/lib/scheduled-agent-enqueue.ts)). `scheduled_runs` row를 먼저 만들고, 그 id를 jobData에 실어 BullMQ에 넣습니다.

수동 진입 시 본문 스키마 (`reorganizeBodySchema`):

```ts
{
  pageIds: uuid[]            // 1..500, 필수 — 선택된 source/target 페이지
  targetFolderId?: uuid|null // 새 페이지 생성 시 폴더(없으면 자동 추론)
  includeDescendants?: bool  // 기본 true — 자식 페이지까지 스코프에 포함
  instruction?: string|null  // 사용자 지시문 (max 4000자)
}
```

권한 게이트: `EDITOR_PLUS_ROLES`(editor/admin/owner) + `workspaces.scheduledEnabled = true`. 비활성 워크스페이스는 `403 SCHEDULED_AGENT_DISABLED`로 차단됩니다.

---

## 3. Job 페이로드 — `ScheduledAgentJobData`

[`packages/shared/src/types/jobs.ts:48`](../packages/shared/src/types/jobs.ts#L48)

```ts
export interface ScheduledAgentJobData {
  scheduledRunId?: string | null;
  workspaceId: string;
  taskId?: string | null;            // cron-등록 task의 id (manual은 null)
  triggeredBy: ScheduledRunTriggeredBy; // "cron" | "manual" | "api"
  pageIds?: string[];
  targetFolderId?: string | null;
  includeDescendants?: boolean;
  instruction?: string | null;
  requestedByUserId?: string | null;
}

export interface ScheduledAgentJobResult {
  scheduledRunId: string;
  agentRunId?: string | null;
  status: "completed" | "partial" | "failed";
  decisionCount: number;
  totalTokens: number;
}
```

---

## 4. Worker Harness

파일: [`packages/worker/src/workers/scheduled-agent.ts`](../packages/worker/src/workers/scheduled-agent.ts) (약 690줄, `createScheduledAgentWorker(): Worker`).

### 4.1 잡 처리 단계

1. **워크스페이스 정책 로딩**
   `workspaces`에서 `scheduledEnabled`, `scheduledAutoApply`, `allowDestructiveScheduledAgent`, `scheduledDailyTokenCap`, `scheduledPerRunPageLimit`, `agentInstructions`, `agentProvider`, `agentModelFast`, `agentModelLargeContext`, `agentFastThresholdTokens`, `agentDailyTokenCap` 컬럼을 읽어옵니다.

2. **`scheduled_tasks` 행 로딩** — `taskId`가 있으면 해당 행을 읽고 `enabled` 플래그를 검사. `cron` 트리거인데 task가 비활성이거나 워크스페이스 자체가 비활성이면 즉시 `scheduled_runs`를 `completed + skippedReason`으로 마감 후 종료합니다.

3. **`scheduled_runs` 행 준비** — 미리 만들어진 row가 있으면 `running`으로 갱신, 없으면 새로 insert.

4. **내부 API 토큰 보장** — `Scheduled Agent Internal`이라는 이름의 `apiTokens` 행을 검색/생성 (실제 토큰 해시는 `internal:scheduled-agent:v1` 더미값 — 외부 API 노출용이 아니라 ingestion FK 충족 목적).

5. **`buildScheduledAgentInput()`** 호출로 seed 페이지 확장 및 `normalizedText` 생성 (자세한 내용은 §5).

6. **`ingestions` 행 보장 (멱등)** — `idempotencyKey = "scheduled-run:${scheduledRunId}"`로 중복 방지. `sourceName: "scheduled-agent"`, `titleHint: "Scheduled wiki reorganize"`, `rawPayload`에 jobData 사본 보관.

7. **`agent_runs` 행 생성** — `status: "running"`, `ingestionId: null` (스케줄 런은 `scheduled_runs.agent_run_id`로 연결). `scheduled_runs.agent_run_id`도 즉시 갱신.

8. **트레이스 publisher 준비** — Redis pub/sub 채널 `agent-runs:trace:{agentRunId}`로 SSE 이벤트(`snapshot` → `step`* → `status`)를 흘립니다.

9. **`buildWorkspaceAgentEnv(workspace)`** — workspace 컬럼을 ProcessEnv처럼 변환. `AGENT_PROVIDER`, `AGENT_MODEL_FAST`, `AGENT_MODEL_LARGE_CONTEXT`, `AGENT_FAST_THRESHOLD_TOKENS`, `AGENT_WORKSPACE_DAILY_TOKEN_CAP`이 채워집니다 (워크스페이스 컬럼이 비어 있으면 process.env가 그대로 쓰입니다).

10. **`runIngestionAgentShadow(...)`** 호출 — 핵심 인자:
    ```ts
    {
      mode: "agent",                       // shadow가 아닌 실제 실행
      origin: "scheduled",                 // 프롬프트/규칙 분기 트리거
      seedPageIds: adapted.seedPageIds,
      instruction: runInput.instruction,
      scheduledRunId: scheduledRun.id,
      scheduledAutoApply: true,            // 항상 true (auto-apply 모드)
      allowDestructiveScheduledAgent,      // workspace 컬럼에서 옴
      workspaceAgentInstructions,          // workspace operator 지침
      workspaceTokenUsage: { usedToday, cap: scheduledCap },
      env, reserveWorkspaceTokens, onStep, recordModelRun,
      mutationQueues: { patchQueue, extractionQueue, searchQueue, linkQueue },
    }
    ```

11. **마감 처리** — `agent_runs`(상태/플랜/스텝/토큰), `ingestions`(`processed_at`), `scheduled_runs`(`decision_count`, `tokensIn/Out`, `diagnosticsJson`), `ingestion_decisions.scheduledRunId` 백필을 한 번에 갱신. 추가로 `audit_logs`에 `scheduled_agent_run_completed` 항목을 기록.

12. **에러 분기** — `AgentLoopTimeout` → `agent_runs.status = "timeout"`, `AgentWorkspaceTokenCapExceeded` → `aborted`, 그 외 → `failed`. 어떤 경우든 `scheduled_runs.status = "failed"` + `diagnosticsJson.error`.

### 4.2 동시성

```ts
SCHEDULED_AGENT_WORKER_CONCURRENCY  // env, 기본 1
```

워커 1대당 동시에 처리하는 잡 수를 결정합니다. (워크스페이스별 동시 실행 제어는 BullMQ 잡 ID에 `randomUUID`가 들어 있어 자체 직렬화는 하지 않으므로, 동일 워크스페이스 동시 실행을 제한하려면 별도 락이 필요.)

### 4.3 `recordModelRun`

각 모델 호출(`explore`, `plan`, `replan`, `mutation_repair`)마다 `model_runs`에 한 행씩 insert합니다. 컬럼: `provider`, `modelName`, `mode = "agent_plan"`, `promptVersion = "ingestion-agent-v1"`, 토큰/지연/`requestMetaJson`(번들 메타, jobId, scheduledRunId, taskId, toolCount, toolChoice, budgetMeta), `responseMetaJson`(finishReason, mutationCount, parseFailed 등).

### 4.4 워크스페이스 토큰 예약

`reserveWorkspaceAgentTokens`는 [`packages/worker/src/workers/ingestion-agent.ts`](../packages/worker/src/workers/ingestion-agent.ts)의 동일 헬퍼를 재사용합니다. Redis 기반 예약으로 estimated tokens를 미리 차감하고, 실제 사용량으로 release합니다. `AGENT_WORKSPACE_DAILY_TOKEN_CAP`(또는 워크스페이스 컬럼)을 초과하면 `AgentWorkspaceTokenCapExceeded`로 즉시 중단됩니다.

---

## 5. 입력 어댑터 — `buildScheduledAgentInput`

파일: [`packages/worker/src/lib/scheduled/input-adapter.ts`](../packages/worker/src/lib/scheduled/input-adapter.ts)

### 5.1 시그니처

```ts
interface ScheduledAgentInput {
  pageIds: string[];
  targetFolderId?: string | null;
  includeDescendants: boolean;
  instruction?: string | null;
  perRunPageLimit: number;          // workspaces.scheduledPerRunPageLimit
}

interface ScheduledAgentAdaptedInput {
  seedPageIds: string[];            // BFS로 확장된 (and dedup된) 페이지 id
  normalizedText: string;           // plan 모델의 user 메시지에 들어갈 마크다운
  truncated: boolean;               // perRunPageLimit에 걸려 잘렸는가
  targetFolderId?: string | null;
  targetFolderInferred?: boolean;   // 모든 선택 페이지가 한 폴더 안에 있을 때 자동 추론
}
```

### 5.2 페이지 수집 (`collectScheduledPageIds`)

* 시작 frontier = `pageIds` (dedup).
* `includeDescendants=true`인 경우 자식 페이지를 BFS로 펼치되, `perRunPageLimit`(워크스페이스 컬럼)을 초과하면 멈추고 `truncated=true`.
* `pages.deletedAt IS NULL` 활성 페이지만 포함.

### 5.3 `normalizedText` 포맷

Plan 모델이 받는 user 메시지의 첫 블록입니다. 핵심 규칙(현재 코드 그대로):

```text
# User-directed wiki edit request

The user selected these existing pages as source material, edit targets, or both.
Follow the user instruction as the primary task; do not reinterpret it as cleanup-only.
The agent may write new Markdown pages, edit existing pages, append notes, consolidate selected
material, move/rename pages, or merge duplicates when the instruction asks for it.
Preserve selected pages unless the user explicitly asks to delete, archive, or destructively merge them.
If the instruction says to copy, transcribe, move contents, 옮겨 적기, 그대로 두고 내용만 옮기기,
or 모두 옮기기 into a new page, treat that as an explicit create_page request that preserves the
selected pages' markdown content and order. Do not ask whether to summarize versus copy.
Call read_page before editing whenever exact current markdown or block IDs are needed.
{TARGET_FOLDER_LINE}

## Selected source/target pages
- {title} ({pageId}) slug={slug} currentRevisionId={revisionId|null}
- ...

[Scope was truncated to {N} pages.   ← truncated=true일 때만]

## User instruction
{instruction}                          ← instruction이 비어있지 않을 때만
```

`{TARGET_FOLDER_LINE}` 분기:
* 모든 선택 페이지가 동일 폴더 → "All selected pages share target folder \"{name}\" (...). Create any new pages requested by the user in this same folder."
* `targetFolderId` 명시 → "Create any new pages requested by the user inside target folder \"{name}\" (...)"
* 둘 다 아니면 → "No target folder was provided for new pages; only use create_page when the destination is unambiguous."

---

## 6. Agent Loop — 실행 단계

파일: [`packages/worker/src/lib/agent/loop.ts`](../packages/worker/src/lib/agent/loop.ts) (약 2280줄). 핵심 export는 `runIngestionAgentShadow(input): Promise<IngestionAgentShadowResult>`이며 Scheduled / Ingestion 두 경로가 같은 함수를 공유합니다. 분기는 `input.origin`으로 결정됩니다.

### 6.1 단계 요약

| 단계 | 시스템 프롬프트 | 모델 | 도구 |
|---|---|---|---|
| 1. Explore (반복) | `EXPLORE_SYSTEM_PROMPT` | 작은 입력 → fast / 큰 입력 → large_context | read 도구 9개 (`toolChoice="auto"`) |
| 2. Scheduled seed prefetch | (모델 호출 아님) | — | `read_page(format="markdown")` 일괄 호출 |
| 3. Plan turn 0 | `PLAN_SYSTEM_PROMPT` | 입력 추정에 따라 모델 재선택 (`responseFormat="json"`) | tool 없음 — JSON 플랜 |
| 4. Execute mutations | (모델 호출 아님) | — | mutate 도구 (per-turn 캡: `MAX_MUTATIONS_PER_TURN = 20`) |
| 5. Mutation repair (실패 시) | `MUTATION_REPAIR_SYSTEM_PROMPT` | plan 모델과 동일 | 1개 tool plan만 반환 |
| 6. Replan turn ≥1 | `REPLAN_SYSTEM_PROMPT` | plan 모델과 동일 | tool 없음 — JSON 플랜 |
| 7. Partial review queue | (Scheduled origin은 SKIP) | — | — |

### 6.2 모델 라우팅

`selectAgentModel({estimatedInputTokens, baseProvider, baseModel, env})` ([`budgeter.ts`](../packages/worker/src/lib/agent/budgeter.ts)):

* `AGENT_PROVIDER` env가 있으면 그 provider, 없으면 base.
* `estimatedInputTokens < AGENT_FAST_THRESHOLD_TOKENS (기본 50_000)` 그리고 `AGENT_MODEL_FAST` 설정됨 → fast 모델, `routing="fast"`.
* `>= 임계` 그리고 `AGENT_MODEL_LARGE_CONTEXT` 설정됨 → large_context 모델.
* 그 외 → base 모델, `routing="default"`.
* **강제 large 라우팅 (Scheduled 전용):** `isScheduledExplicitSourceCopyCreate(input)`이 true이면 plan 단계 추정 입력을 임계 이상으로 클램프하여 large_context 모델을 강제. 트리거 정규식:
  * 새 페이지 요청: `/새(?:로운)?\s*페이지|신규\s*페이지|페이지\s*생성|create\s+(?:a\s+)?new\s+page|new\s+page/i`
  * source-copy: `/옮겨\s*적|내용만…옮|모두…옮|전체…옮|그대로…(?:두고|유지|옮)|복사|copy|transcribe|verbatim/i`

### 6.3 실행 한도 — `AGENT_LIMITS`

[`packages/shared/src/constants/index.ts`](../packages/shared/src/constants/index.ts):

```ts
AGENT_LIMITS = {
  MAX_STEPS: 15,                          // explore 루프 최대 반복
  MAX_CALLS_PER_TURN: 5,                  // 한 턴에서의 도구 호출 수
  MAX_MUTATIONS: 20,
  MAX_MUTATIONS_PER_TURN: 20,
  MAX_TURNS: 5,                           // plan/replan 합산
  MAX_TOTAL_MUTATIONS: 100,
  TIMEOUT_MS: 180_000,                    // 전체 실행 데드라인 3분
  TURN_REMAINING_TIME_THRESHOLD_MS: 30_000, // 다음 턴 진입 마지노선
  INPUT_TOKEN_BUDGET: 800_000,
  OUTPUT_TOKEN_BUDGET: 60_000,
  WORKSPACE_DAILY_TOKEN_CAP: 5_000_000,
}
```

각각 `AGENT_*` env로 오버라이드 가능 ([`budgeter.ts:91`](../packages/worker/src/lib/agent/budgeter.ts#L91) 참조).

### 6.4 Scheduled-only 동작 차이

* `origin="scheduled"`이면 explore 단계 종료 직후 **선택 페이지 prefetch** (`prefetchScheduledSeedPages`)가 실행됩니다. 환경변수 `AGENT_SCHEDULED_SEED_READ_LIMIT` (기본 20)로 페이지 수 상한이 정해지며, 모델 호출 없이 dispatcher로 직접 `read_page(format="markdown")`을 호출하여 plan turn에 들어갈 컨텍스트 블록을 채웁니다.
* `origin="scheduled"`이면 partial-review fallback queue 작성이 **건너뜁니다** (`queuePartialRunForReview`가 origin scheduled일 때 즉시 0 반환). 미실행 plan은 그대로 turn 기록에 남고 사용자는 `agent_runs.steps_json`/`plan_json`으로 확인합니다.
* mutate 도구 측면에서는 `revisionSource = "scheduled"`로 기록되고, `activitySource`가 `ingestion_agent` → `scheduled_agent`로 치환됩니다.
* `mutationDecisionStatus` / `destructiveDecisionStatus`가 `scheduledAutoApplyStatus`로 분기 — `noop`/`needs_review`만 비-자동 처리, 그 외는 모두 `auto_applied`.

### 6.5 컨텍스트 패킹 / 컴팩션

* 첫 모델 메시지는 `packAgentExploreContext(...)`로 packing — 시스템 프롬프트 + ingestion 메타 + ingestionText를 토큰 한도 내로 슬라이스.
* 매 explore step 진입 시 `compactAgentMessages(...)` 호출 — 임계 토큰을 넘으면 무거운 `read_page`/`read_revision` 응답을 `[COMPACTED_TOOL_RESULT]` 표식으로 줄이고, 해당 캐시도 dispatcher에서 무효화합니다.
* Plan 단계는 `packPlanContextForTurn(...)` — explore 단계에서 모은 `toolContextBlocks` + 이전 턴의 outcome 요약을 함께 묶어 보냅니다.

---

## 7. Tool 카탈로그

도구는 두 묶음입니다. **Read 도구**는 dispatcher에서 deduplication 캐싱이 켜져 있고 quota가 적용됩니다. **Mutate 도구**는 `createMutateTools(input)`로 매 실행마다 새로 빌드되며, 일부는 워크스페이스/모드 조건에 따라 노출 여부가 달라집니다.

### 7.1 Read 도구 (9개)

정의: [`packages/worker/src/lib/agent/tools/read.ts`](../packages/worker/src/lib/agent/tools/read.ts) `createReadOnlyTools()` (1532줄).
스키마 export: [`packages/shared/src/schemas/agent.ts`](../packages/shared/src/schemas/agent.ts) `agentReadToolInputSchemas`.
모델에게 보낼 JSONSchema: [`loop.ts:396` `readToolDefinitions()`](../packages/worker/src/lib/agent/loop.ts#L396).

| Tool | 입력 스키마 | 설명 |
|---|---|---|
| `search_pages` | `{ query: string(1..500), limit: 1..20 = 10 }` | 제목·본문 FTS·trigram 유사도·entity overlap 결합 검색. |
| `read_page` | `{ pageId: uuid, format: "markdown"\|"summary"\|"blocks" = "markdown" }` | 풀 마크다운 / 결정적 요약 / 안정 블록 ID. 토큰 초과 시 자동으로 blocks fallback + system notice. |
| `list_folder` | `{ folderId: uuid \| null }` | 자식 폴더와 최상위 페이지 나열. `null`은 워크스페이스 루트. |
| `find_related_entities` | `{ text: string(1..5000), limit: 1..20 = 10 }` | 텍스트 매칭 entity + active triple로 연결된 페이지. |
| `list_recent_pages` | `{ limit: 1..20 = 10 }` | AI/사람/페이지 timestamp 기준 최근 페이지. |
| `read_page_metadata` | `{ pageId: uuid }` | 제목/부모/프론트매터/타임스탬프/자식 수/publish/open suggestion 카운트. read_page보다 가벼운 트리아주용. |
| `find_backlinks` | `{ pageId: uuid, limit: 1..100 = 30 }` | 인덱스 backlink + 마크다운 스캔 fallback. delete/merge 전 의존성 평가. |
| `read_revision_history` | `{ pageId: uuid, limit: 1..50 = 20 }` | 페이지의 최근 리비전 (newest first), actor·source·블록 변경 카운트 포함. |
| `read_revision` | `{ revisionId: uuid, includeContent: bool = true }` | 단일 리비전 본문+diff. 이번 런에서 관측한 페이지/이력에서 나온 revision만 허용. |

#### 7.1.1 Dispatcher 동작 — `createAgentDispatcher`

[`packages/worker/src/lib/agent/dispatcher.ts`](../packages/worker/src/lib/agent/dispatcher.ts).

* **Quota (per agent run)** — `DEFAULT_READ_TOOL_QUOTAS`:
  ```ts
  search_pages: 8, read_page: 20, list_folder: 20,
  find_related_entities: 8, list_recent_pages: 8,
  read_page_metadata: 30, find_backlinks: 5,
  read_revision_history: 10, read_revision: 30
  ```
* **Per-turn cap** — `MAX_CALLS_PER_TURN = 5` (단, plan 단계의 mutation execution dispatcher는 `maxCallsPerTurn: 1`로 강제).
* **Cache key** — `${name}:${stableJson(parsedArgs)}`. 캐시 히트 시 `deduped: true`로 모델에게 시스템 메시지로 알려 동일 호출 반복을 차단.
* **Validation** — 인자가 zod 스키마에 안 맞으면 `validation_failed` AgentToolError, 모델은 다음 턴에 자체 교정 시도.
* **State tracking** — 호출 결과의 `observedPageIds`/`observedRevisionIds`/`mutatedPageIds` 등을 `AgentRunState` Set/Map에 누적해 mutate 도구가 "관측된 페이지/리비전인지"를 검사할 때 사용합니다.

### 7.2 Mutate 도구 (12 + 2 destructive)

정의: [`packages/worker/src/lib/agent/tools/mutate.ts`](../packages/worker/src/lib/agent/tools/mutate.ts) `createMutateTools(input)` (2023줄~).
스키마: `agentMutateToolInputSchemas` ([`agent.ts:348`](../packages/shared/src/schemas/agent.ts#L348)).

| Tool | 인자 | 결과 |
|---|---|---|
| `replace_in_page` | `{ pageId, find, replace, occurrence?, confidence, reason }` | inline patch — 정확히 일치하는 텍스트 1회 치환. |
| `edit_page_blocks` | `{ pageId, ops: [{blockId, op: replace\|insert_after\|insert_before\|delete, content?}], confidence, reason }` | 안정 block id 단위 패치, 최대 50 ops. |
| `edit_page_section` | `{ pageId, sectionAnchor, op: replace\|append\|prepend\|delete, content?, confidence, reason }` | 헤딩 섹션 단위 패치. |
| `update_page` | `{ pageId, newContentMd, confidence, reason }` | patch-generator 큐로 풀 페이지 업데이트 fallback. |
| `append_to_page` | `{ pageId, contentMd, sectionHint?, confidence, reason }` | append fallback. |
| `create_page` | `{ title, contentMd, parentFolderId?, parentPageId?, confidence, reason }` | 새 페이지 생성 또는 review decision. parentFolderId/parentPageId는 상호배타. |
| `move_page` | `{ pageId, newParentPageId?\|newParentFolderId?, newSortOrder?, reorderIntent?, reorderAnchorPageId?, confidence, reason }` | 페이지 이동/재정렬. before/after intent는 anchor 페이지 필수. |
| `rename_page` | `{ pageId, newTitle?, newSlug?, confidence, reason }` | 새 리비전 만들지 않고 제목/슬러그 변경. |
| `create_folder` | `{ name, parentFolderId?, confidence, reason }` | 폴더 생성. |
| `rollback_to_revision` | `{ pageId, revisionId, confidence, reason }` | 자동 자기 교정용. 사람이 만든 최근 리비전은 건드리지 않도록 가드. |
| `noop` | `{ reason, confidence = 1 }` | 위키 변경 불요 기록. |
| `request_human_review` | `{ reason, suggestedAction?, suggestedPageIds: uuid[]≤20, confidence = 0 }` | 사람 검토 큐로 보냄. |

조건부 노출 (`destructiveToolsEnabled(input)` true일 때만):

| Tool | 인자 | 결과 |
|---|---|---|
| `delete_page` | `{ pageId, confidence, reason }` | Scheduled auto-apply는 서브트리 **purge** (영구 삭제). Autonomous ingestion auto-apply는 soft-delete. |
| `merge_pages` | `{ canonicalPageId, sourcePageIds: 1..10, mergedContentMd, confidence, reason }` | canonical 업데이트 후 source 서브트리 purge(scheduled) 또는 soft-delete(autonomous). |

`destructiveToolsEnabled` 분기:
```ts
(origin === "scheduled" && allowDestructiveScheduledAgent === true) ||
autonomyMode === "autonomous" ||
autonomyMode === "autonomous_shadow"
```

### 7.3 Mutate 결과의 결정(Decision) 상태

`mutationDecisionStatus(input, action, confidence)`:
* **Scheduled origin** — `scheduledAutoApplyStatus`: `noop`/`needs_review`는 그대로, 나머지는 `auto_applied`. (autoApply 모드가 항상 켜져 있음 — `scheduledAutoApply: true`로 호출.)
* **Ingestion + autonomous_shadow** — 변형이 있어도 `suggested`로 큐잉.
* **Ingestion + autonomous** — `classifyDecisionStatus`가 confidence/액션 조합으로 결정.
* **Ingestion + 일반 (assisted)** — 동일하게 confidence 기반.

`destructiveDecisionStatus`도 같은 분기를 따르되 scheduled origin에서는 `auto_applied`입니다 (재구성 잡은 사람 검토를 위한 trash-restore 충돌을 피하려고 즉시 purge).

### 7.4 Mutation 실행 흐름

[`loop.ts:executeMutations`](../packages/worker/src/lib/agent/loop.ts):

1. plan의 `proposedPlan` 항목을 순서대로 도구 호출로 변환 (`mutationToToolCall`).
2. dispatcher에 `maxCallsPerTurn: 1`로 한 건씩 보냄 → 결과를 `mutation_result` 트레이스 스텝에 기록.
3. 실패 시 `selfCorrection.hint`가 있으면 **mutation repair** 모델 호출 (1회). 성공하면 그 결과로 대체, 실패하면 fallback 결정 행을 `ingestion_decisions`에 직접 기록 (`recordAgentMutationFailure`).
4. 변경된 페이지 id 누적 → 다음 plan turn에서 dispatcher 캐시 무효화 (`invalidateReadCacheForPage`)에 사용.

---

## 8. 시스템 프롬프트 원본

> 모든 프롬프트는 `loop.ts` 상단에 인라인 상수로 정의되어 있으며, 워크스페이스 운영자 지침(`workspaces.agentInstructions`)과 Scheduled prefix가 `withWorkspaceInstructions(...)`로 합쳐집니다. 아래는 코드와 글자 단위로 동일한 원문입니다 (`PROMPT_VERSION = "ingestion-agent-v1"`).

### 8.1 `EXPLORE_SYSTEM_PROMPT`

```text
You are a read-only exploration agent for WekiFlow's Markdown knowledge wiki.
Investigate the incoming ingestion with the available read-only tools, then stop calling tools when you have enough context to plan possible wiki updates.
Never invent page IDs. Only refer to pages that tools returned. Do not propose or execute mutations during exploration.

Before proposing a new page, actively rule out duplication:
- Search by title hint, source-specific nouns, and canonical entity names.
- If search_pages returns weak or empty results, use list_recent_pages, list_folder, or find_related_entities before assuming create.
- When the same read tool arguments are repeated and the dispatcher returns a cached result, refine the query or continue planning instead of repeating the same call.

Pick the lightest read tool for the question:
- read_page_metadata when you only need title, parent path, frontmatter, or timestamps. Saves tokens vs full read_page.
- find_backlinks before proposing delete_page or merge_pages — evaluate dependencies first.
- read_revision_history + read_revision when self-correcting (e.g. before rollback_to_revision). Read history first so the revision is observed for this run.
```

### 8.2 `PLAN_SYSTEM_PROMPT`

```text
You are planning wiki mutations for WekiFlow, a Markdown knowledge manager.
Use the ingestion, selected source pages, user instruction, and read-only context to propose exact wiki changes.
This agent supports user-directed document work, not only autonomous maintenance: drafting new pages from provided material, editing existing notes, appending meeting minutes, consolidating policy pages, moving or renaming pages, and merging duplicates.
Prefer the narrowest safe mutate tool to creating duplicate pages. Keep confidence calibrated.
Honor workspace operator instructions about where knowledge belongs, source-specific routing, aliases, and forbidden create/update paths.
If context is insufficient to avoid a duplicate or unsafe rewrite, return request_human_review instead of create_page. Use noop only when no wiki change is needed; use request_human_review when the user asked for a change but you cannot execute it safely.

When you can make an exact edit, return a typed tool plan:
{
  "tool": "replace_in_page" | "edit_page_blocks" | "edit_page_section" | "update_page" | "append_to_page" | "create_page" | "move_page" | "rename_page" | "create_folder" | "delete_page" | "merge_pages" | "rollback_to_revision" | "noop" | "request_human_review",
  "args": { ...tool arguments... },
  "action": "create" | "update" | "append" | "delete" | "merge" | "noop" | "needs_review",
  "targetPageId": "uuid or null",
  "confidence": 0.0,
  "reason": "why"
}

Tool argument contracts:
- replace_in_page: { pageId, find, replace, occurrence?, confidence, reason }
- edit_page_blocks: { pageId, ops: [{ blockId, op: "replace"|"insert_after"|"insert_before"|"delete", content? }], confidence, reason }
- edit_page_section: { pageId, sectionAnchor, op: "replace"|"append"|"prepend"|"delete", content?, confidence, reason }
- update_page: { pageId, newContentMd, confidence, reason }
- append_to_page: { pageId, contentMd, sectionHint?, confidence, reason }
- create_page: { title, contentMd, parentFolderId?, parentPageId?, confidence, reason }
- move_page: { pageId, newParentPageId?, newParentFolderId?, newSortOrder?, reorderIntent?: "before"|"after"|"append"|"explicit", reorderAnchorPageId?, confidence, reason }
- rename_page: { pageId, newTitle?, newSlug?, confidence, reason }
- create_folder: { name, parentFolderId?, confidence, reason }
- delete_page: { pageId, confidence, reason } (Scheduled reorganize or autonomous workspace mode only; scheduled auto-apply purges the page subtree, autonomous ingestion auto-apply soft-deletes it)
- merge_pages: { canonicalPageId, sourcePageIds, mergedContentMd, confidence, reason } (Scheduled reorganize or autonomous workspace mode only; scheduled auto-apply purges source page subtrees, autonomous ingestion auto-apply soft-deletes them after updating the canonical page)
- rollback_to_revision: { pageId, revisionId, confidence, reason } (Use only to self-correct a recent autonomous mistake on an observed page; never roll back human-authored recent work)
- noop: { reason, confidence? }
- request_human_review: { reason, suggestedAction?, suggestedPageIds?, confidence? } where suggestedAction must be one of "create", "update", "append", "delete", "merge", "noop", "needs_review"; put free-form guidance in reason, not suggestedAction.

Use update_page only when a narrower tool cannot represent the change. Never invent page IDs or block IDs.
When restructuring is needed, prefer move_page/rename_page over recreating pages. Use create_folder before move_page when the target folder does not exist yet.
When the user explicitly asks for a new page, use create_page after ruling out an existing duplicate target; do not downgrade the request merely because an existing page could also hold the content.
When the user asks to write a document from selected source pages or provided data, synthesize the requested Markdown page from those sources instead of treating the task as cleanup.
When the user says to copy/transcribe/move contents ("옮겨 적기", "그대로 두고 내용만 옮기기", "모두 옮기기", "복사") into a new page, preserve the selected source pages' markdown content and order by default. Do not request human review merely to ask whether to summarize versus copy.
Preserve selected source pages unless the user explicitly asks to delete, archive, or destructively merge them. "Copy", "consolidate into a new page", "write a new document", and "move contents into a new page while keeping originals" should use create_page without deleting the sources.
Use delete_page and merge_pages only for scheduled wiki reorganization or autonomous workspace mode. If neither mode applies, request human review instead.
In autonomous workspace mode, delete_page and merge_pages may be used for high-confidence ingestion cleanup when the target pages were observed in this run. In autonomous_shadow mode, plan the same tool you would use autonomously, but it will be queued for human review.
Use rollback_to_revision only after the target page and rollback revision were observed and the rollback restores the page from a recent autonomous error. Prefer request_human_review if the target revision appears to be recent human-authored work.

Return only JSON with this exact shape:
{
  "summary": "short explanation",
  "proposedPlan": [
    {
      "action": "create" | "update" | "append" | "delete" | "merge" | "noop" | "needs_review",
      "targetPageId": "uuid or null",
      "confidence": 0.0,
      "reason": "why",
      "tool": "optional mutate tool name",
      "args": { "optional": "mutate tool args" },
      "proposedTitle": "required for create",
      "sectionHint": "optional",
      "contentSummary": "optional",
      "evidence": [{ "pageId": "uuid", "note": "short evidence" }]
    }
  ],
  "openQuestions": []
}
```

### 8.3 `REPLAN_SYSTEM_PROMPT` (turn ≥ 1)

```text
You are continuing a multi-turn wiki maintenance plan for WekiFlow.
You previously planned and executed mutations on this run. Below is the original ingestion, prior plan summaries, per-mutation outcomes, and pages you mutated.

Propose only the remaining plan items if more work is needed, or return an empty proposedPlan to finish the run.

Rules:
- Do not re-propose mutations that already succeeded.
- If a previous mutation failed, propose a corrected version or skip it if it is no longer safe.
- Use the same tool-call contract as the initial plan turn.
- Re-read mutated pages via read_page if you need to verify your own changes; caches are invalidated for those pages between turns.
- Empty proposedPlan means the run is done. Do not pad.

Return only JSON with this exact shape:
{
  "summary": "short explanation of what remains",
  "proposedPlan": [],
  "openQuestions": []
}
```

### 8.4 `MUTATION_REPAIR_SYSTEM_PROMPT`

```text
You repair one failed WekiFlow mutate tool call.
Use the tool error and self-correction hints to return a single corrected mutation.
Do not introduce unrelated page changes. If the error cannot be repaired safely, return request_human_review.

Return only JSON with this shape:
{
  "summary": "short repair explanation",
  "proposedPlan": [
    {
      "action": "update" | "append" | "create" | "delete" | "merge" | "noop" | "needs_review",
      "targetPageId": "uuid or null",
      "confidence": 0.0,
      "reason": "why this repaired mutation is safe",
      "tool": "replace_in_page" | "edit_page_blocks" | "edit_page_section" | "update_page" | "append_to_page" | "create_page" | "move_page" | "rename_page" | "create_folder" | "delete_page" | "merge_pages" | "rollback_to_revision" | "noop" | "request_human_review",
      "args": { "corrected": "tool arguments" },
      "evidence": []
    }
  ],
  "openQuestions": []
}
```

### 8.5 Scheduled Prompt Prefix (`scheduledPromptPrefix`)

`origin === "scheduled"`일 때만 explore/plan 시스템 프롬프트와 user 메시지 사이에 추가됩니다 (`withWorkspaceInstructions`로 시스템 프롬프트 뒤에 합쳐짐).

```text
Scheduled user-directed wiki edit mode:
- This is not an external fact ingestion. It is a user-requested wiki editing run over selected pages and instructions.
- Treat the user instruction as the primary task. Do not narrow it to cleanup/reorganization unless the user asked for that.
- Selected pages can be source material, edit targets, or both; infer their role from the user instruction.
- Supported tasks include drafting new docs from selected pages, rewriting notes, appending meeting minutes, consolidating policy pages, moving/renaming pages, creating folders/pages, and merging duplicates.
- Prefer replace_in_page, edit_page_blocks, or edit_page_section over full rewrites when the user asked to edit an existing page.
- Use create_page when the user explicitly asks for a new page, after ruling out an existing duplicate target.
- Otherwise, use create_page only as a last resort when the target knowledge cannot fit into existing selected pages.
- If the user asks to write a new document from selected pages, synthesize a complete Markdown page from those source pages.
- If the user asks to copy/transcribe/move selected page contents into a new page, keep selected pages in their listed order, preserve headings/tables as Markdown, and do not ask whether to summarize unless the user instruction itself is contradictory.
- Preserve selected source pages unless the user explicitly asks to delete, archive, or destructively merge them.
- Selected pages are prefetched before planning when the scope is small; if any needed source content is still missing, call read_page before concluding the context is insufficient.
{DESTRUCTIVE_LINE_DELETE}
{DESTRUCTIVE_LINE_MERGE}
- Scheduled mutations apply autonomously when they are safe and exact.
- If the user asked for a change but no safe autonomous change exists, use request_human_review so the work remains visible in the review queue.
- Use noop only when the request requires no wiki change.
- Seed page IDs selected by the user: {comma-separated seed ids}     ← seedPageIds 있을 때만
{EXPLICIT_SOURCE_COPY_LINE}                                          ← 정규식 매칭 시
                                                                    
User instruction:                                                    ← instruction 있을 때만
{instruction text}
```

* `allowDestructiveScheduledAgent === true` → `{DESTRUCTIVE_LINE_DELETE} = "- Use delete_page when a selected page is fully redundant with another existing page."`, `{DESTRUCTIVE_LINE_MERGE} = "- Use merge_pages to consolidate 2+ short pages into one canonical page; include full mergedContentMd."`
* false → 두 줄 모두 `"- Destructive tools are disabled for this workspace; do not plan delete_page."` / `"… do not plan merge_pages."`로 대체.
* `{EXPLICIT_SOURCE_COPY_LINE}` (`isScheduledExplicitSourceCopyCreate=true`):
  ```
  - This run is an explicit create_page + source-copy request. A request_human_review asking for summary/copy/section confirmation is not acceptable after selected pages have been read; create the requested page with the available source Markdown unless a real safety/tool constraint blocks execution.
  ```

### 8.6 Workspace Operator Instructions

`workspaces.agentInstructions` 컬럼에 자유 텍스트로 보관. `withWorkspaceInstructions(base, instructions)`가 시스템 프롬프트 뒤에 다음 블록을 덧붙입니다:

```text

Workspace operator instructions:
{trimmed instructions}

Treat these workspace instructions as routing and editing policy. If they conflict with tool safety, confidence gates, or provenance requirements, keep the safety requirement and request human review.
```

---

## 9. 데이터 구조 — Input / Output

### 9.1 `runIngestionAgentShadow` Input (Scheduled 호출 기준 핵심 필드)

[`loop.ts:222 RunIngestionAgentShadowInput`](../packages/worker/src/lib/agent/loop.ts#L222)

```ts
{
  db: AgentDb;                    // drizzle db client
  workspaceId: string;
  ingestion: {
    id: string;
    sourceName: "scheduled-agent";
    contentType: "text/markdown";
    titleHint: "Scheduled wiki reorganize";
    normalizedText: string;       // §5의 marker 텍스트
    rawPayload: { … };            // jobData 사본
    targetFolderId?: string|null;
    targetParentPageId?: string|null;
    useReconciliation?: boolean;
  };
  origin: "scheduled";
  mode: "agent";
  agentRunId: string;
  seedPageIds: string[];
  instruction?: string|null;
  scheduledRunId: string;
  scheduledAutoApply: true;
  allowDestructiveScheduledAgent?: boolean;
  workspaceAgentInstructions?: string|null;
  workspaceTokenUsage?: { usedToday: number; cap?: number };
  reserveWorkspaceTokens?: (req) => Promise<reservation|null>;
  checkAbortBeforeTurn?: (req) => Promise<{status, reason, details?}|null>;
  onStep?: (step) => void|Promise<void>;
  recordModelRun?: (record) => Promise<{id?:string}|void>;
  mutationQueues: { patchQueue, extractionQueue, searchQueue, linkQueue };
  env?: NodeJS.ProcessEnv;
}
```

### 9.2 `IngestionAgentShadowResult` (Output)

```ts
{
  status: "shadow" | "completed" | "partial" | "aborted",
  planJson: IngestionAgentPlan & {
    shadow: false,
    model: AgentModelSelection,
    budget: AIBudgetMeta,
    parseFailed?: true,
    turns?: TurnRecord[],
    execution?: { mode: "agent", succeeded: number, failed: number },
  },
  steps: AgentRunTraceStep[],
  decisionsCount: number,
  totalTokens: number,
  totalLatencyMs: number,
}
```

### 9.3 Plan Schema — `IngestionAgentPlan`

[`agent.ts:426`](../packages/shared/src/schemas/agent.ts#L426)

```ts
{
  summary: string(1..2000),
  proposedPlan: AgentPlanMutation[]   // ≤ MAX_TOTAL_MUTATIONS (100)
  openQuestions: string[]             // 각 1..1000자
}
```

`AgentPlanMutation`:

```ts
{
  tool?: AgentMutateToolName,
  args?: Record<string, unknown>,
  action?: "create"|"update"|"append"|"delete"|"merge"|"noop"|"needs_review",
  targetPageId: uuid|null,
  confidence: number(0..1),
  reason: string(1..2000),
  proposedTitle?: string(1..500),    // action=create 시 필수
  sectionHint?: string(1..500),
  contentSummary?: string(1..2000),
  evidence: { pageId?: uuid, note: string(1..1000) }[],   // ≤ 20
}
```

검증 규칙(superRefine):
* `tool`도 `action`도 없으면 거부.
* `update`/`append`는 `targetPageId` 필수.
* `create`는 `proposedTitle` 필수.
* `delete`는 `targetPageId` 필수.
* `merge` action은 반드시 `tool === "merge_pages"`.

### 9.4 Trace 이벤트 — `AgentRunTraceStep`

`agent_runs.steps_json`에 한 행당 누적되며, Redis 채널로도 동시 흐릅니다.

```ts
type AgentRunTraceStep = {
  step: number;          // 0..N
  type: "model_selection" | "ai_response" | "context_compaction" |
        "tool_result"    | "plan"        | "replan"             |
        "mutation_result"| "shadow_execute_skipped"             |
        "turn_aborted"   | "error";
  turnIndex?: number;
  payload: Record<string, unknown>;
  ts: string;            // ISO
}
```

`AgentRunTraceEvent` (SSE):
```ts
| { type: "snapshot"; agentRun: AgentRunDto }
| { type: "step"; step: AgentRunTraceStep }
| { type: "status"; agentRun: AgentRunDto }
| { type: "error"; message: string; code?: string }
```

채널: `agent-runs:trace:{agentRunId}` (`AGENT_TRACE_CHANNEL_PREFIX = "agent-runs:trace:"`).

### 9.5 `TurnRecord` & `TurnMutationOutcome`

```ts
TurnRecord = {
  turnIndex: number;
  plan: IngestionAgentPlan;          // 이번 턴에 실행된 plan slice
  skippedPlan?: AgentPlanMutation[]; // per-turn cap에 잘려서 다음으로 넘어간 항목
  execution: { succeeded: number; failed: number; attempted: number };
  outcomes?: TurnMutationOutcome[];
  mutatedPageIds: uuid[];
}

TurnMutationOutcome = {
  index: number;
  action?: IngestionAction;
  tool?: string;
  targetPageId: uuid|null;
  ok: boolean;
  status?: string;          // "auto_applied" | "suggested" | "needs_review" | "failed" | "noop"
  decisionId?: uuid;
  mutatedPageIds?: uuid[];
  repairAttempted?: boolean;
  repaired?: boolean;
  fallbackDecisionId?: uuid;
  error?: { code, message, recoverable };
}
```

---

## 10. 영속화 매핑

| 테이블 | 누가 쓰는가 | 핵심 컬럼 |
|---|---|---|
| `scheduled_runs` | harness | `status`, `decision_count`, `tokens_in/out`, `diagnostics_json`, `agent_run_id`, `started_at/completed_at` |
| `scheduled_tasks` | API + harness | cron expression, target_page_ids, include_descendants, instruction, enabled, bull_repeat_key |
| `ingestions` | harness | `idempotency_key = "scheduled-run:${scheduledRunId}"`, `source_name = "scheduled-agent"`, `target_folder_id`, `status` |
| `agent_runs` | harness + loop | `status`, `plan_json`, `steps_json`, `decisions_count`, `total_tokens`, `total_latency_ms` |
| `model_runs` | `recordModelRun` | per phase (explore/plan/replan/mutation_repair) — provider/model/tokens/latency/budget meta |
| `ingestion_decisions` | mutate 도구 | scheduled_run_id로 백필, `action`/`status`/`rationale_json`/`confidence` |
| `audit_logs` | mutate 도구 + harness | `scheduled_agent_run_completed`, mutate별 행위 로그 |
| `pages`, `page_revisions`, `page_paths`, `page_redirects` | mutate 도구 | 새 리비전 source = `"scheduled"` |

---

## 11. 환경변수 / 워크스페이스 정책

> 워크스페이스 컬럼이 우선 적용되고, 컬럼이 비어있을 때만 환경변수가 사용됩니다 (`buildWorkspaceAgentEnv`).

| 키 | 워크스페이스 컬럼 | 의미 | 기본값 |
|---|---|---|---|
| `AGENT_PROVIDER` | `workspaces.agent_provider` | `openai`\|`gemini`\|`anthropic` | `getDefaultProvider()` |
| `AGENT_MODEL_FAST` | `workspaces.agent_model_fast` | 작은 입력용 모델 | (provider default) |
| `AGENT_MODEL_LARGE_CONTEXT` | `workspaces.agent_model_large_context` | 큰 입력용 모델 | (provider default) |
| `AGENT_FAST_THRESHOLD_TOKENS` | `workspaces.agent_fast_threshold_tokens` | fast↔large 분기 임계 | 50_000 |
| `AGENT_WORKSPACE_DAILY_TOKEN_CAP` | `workspaces.scheduled_daily_token_cap` → `agent_daily_token_cap` | 워크스페이스 일일 토큰 cap | 5_000_000 |
| — | `workspaces.scheduled_per_run_page_limit` | seed BFS 페이지 상한 | (DB default) |
| — | `workspaces.scheduled_enabled` | scheduled 기능 on/off | false |
| — | `workspaces.scheduled_auto_apply` | (현재 코드에서는 항상 `true`로 호출됨) | — |
| — | `workspaces.allow_destructive_scheduled_agent` | delete/merge 노출 여부 | false |
| `AGENT_SCHEDULED_SEED_READ_LIMIT` | — | prefetch 단계 페이지 수 상한 | 20 |
| `AGENT_MAX_STEPS` | — | explore 루프 max iterations | 15 |
| `AGENT_MAX_CALLS_PER_TURN` | — | 한 턴 도구 호출 수 | 5 |
| `AGENT_MAX_MUTATIONS_PER_TURN` | — | 한 턴 mutation 실행 상한 | 20 |
| `AGENT_MAX_TURNS` | — | plan/replan 합산 최대 턴 | 5 |
| `AGENT_MAX_TOTAL_MUTATIONS` | — | 전체 실행 mutation 상한 | 100 |
| `AGENT_TIMEOUT_MS` | — | 전체 데드라인 (ms) | 180_000 |
| `AGENT_TURN_REMAINING_TIME_THRESHOLD_MS` | — | 다음 턴 진입 마지노선 | 30_000 |
| `AGENT_INPUT_TOKEN_BUDGET` | — | packing 시 입력 토큰 예산 | 800_000 |
| `AGENT_OUTPUT_TOKEN_BUDGET` | — | 출력 토큰 예산 | 60_000 |
| `SCHEDULED_AGENT_WORKER_CONCURRENCY` | — | BullMQ concurrency | 1 |

---

## 12. 스크립트 / 진입점 인덱스

스크립트성 파일은 **없음** — Scheduled Agent는 BullMQ 기반 longrunning worker이며, npm scripts(`packages/worker/package.json`)에서 다른 워커들과 함께 부팅됩니다.

코드 진입점 요약:

| 파일 | 역할 |
|---|---|
| [`packages/api/src/routes/v1/scheduled-agent.ts`](../packages/api/src/routes/v1/scheduled-agent.ts) | 수동 재구성 + scheduled-runs 목록 REST |
| [`packages/api/src/routes/v1/scheduled-tasks.ts`](../packages/api/src/routes/v1/scheduled-tasks.ts) | cron task CRUD (admin+) |
| [`packages/api/src/lib/scheduled-agent-enqueue.ts`](../packages/api/src/lib/scheduled-agent-enqueue.ts) | scheduled_runs 생성 + BullMQ enqueue |
| [`packages/api/src/lib/scheduled-agent-scheduler.ts`](../packages/api/src/lib/scheduled-agent-scheduler.ts) | BullMQ Job Scheduler 등록/제거 |
| [`packages/worker/src/workers/scheduled-agent.ts`](../packages/worker/src/workers/scheduled-agent.ts) | Worker harness |
| [`packages/worker/src/lib/scheduled/input-adapter.ts`](../packages/worker/src/lib/scheduled/input-adapter.ts) | seed BFS + normalizedText 빌드 |
| [`packages/worker/src/lib/agent/loop.ts`](../packages/worker/src/lib/agent/loop.ts) | Explore→Plan→Execute→Replan 루프 + 프롬프트 |
| [`packages/worker/src/lib/agent/dispatcher.ts`](../packages/worker/src/lib/agent/dispatcher.ts) | Tool 디스패처 (캐싱/쿼터/검증) |
| [`packages/worker/src/lib/agent/budgeter.ts`](../packages/worker/src/lib/agent/budgeter.ts) | 모델 선택, 토큰 패킹/컴팩션, 한도 |
| [`packages/worker/src/lib/agent/tools/read.ts`](../packages/worker/src/lib/agent/tools/read.ts) | 9개 read 도구 구현 |
| [`packages/worker/src/lib/agent/tools/mutate.ts`](../packages/worker/src/lib/agent/tools/mutate.ts) | 12+2개 mutate 도구 구현 |
| [`packages/worker/src/lib/agent/patch/`](../packages/worker/src/lib/agent/patch/) | inline/block/section patch 어플라이어 |
| [`packages/shared/src/schemas/agent.ts`](../packages/shared/src/schemas/agent.ts) | tool 입력/플랜/트레이스 zod 스키마 |
| [`packages/shared/src/types/jobs.ts`](../packages/shared/src/types/jobs.ts) | Job 페이로드 인터페이스 |
| [`packages/shared/src/constants/index.ts`](../packages/shared/src/constants/index.ts) | `AGENT_LIMITS`, 큐/잡 이름 |
