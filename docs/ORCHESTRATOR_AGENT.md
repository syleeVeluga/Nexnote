# Orchestrator Agent — 자율 문서화 시스템 설계

> **상태:** 2026-05-09 작성. v0.2 — Writer / DiffAnalyzer 분리 + 정책 개정 처리 추가.
> **범위:** 지속적으로 유입되는 외부 문서·데이터·메시지를 위키로 흡수·정리·관리하는 Orchestrator 중심 멀티 에이전트 시스템. 기존 [`docs/SCHEDULED_AGENT.md`](SCHEDULED_AGENT.md)의 Scheduled Agent를 sub-agent 중 하나(Editor)로 흡수.
> **참고 문서:** [`docs/SCHEDULED_AGENT.md`](SCHEDULED_AGENT.md), [`docs/architecture/USER_DIRECTED_AGENT_WORKFLOW.md`](architecture/USER_DIRECTED_AGENT_WORKFLOW.md), [`docs/architecture/SYSTEM_ARCHITECTURE.md`](architecture/SYSTEM_ARCHITECTURE.md).
> **선행 검토:** OpenSwarm/Agency Swarm 분석 결과 — 통신 primitive 패턴(`SendMessage` / `Handoff`)만 차용, 코드 의존성은 받지 않음. 큐·상태·정책 엔진은 기존 BullMQ + drizzle + Postgres 스택으로 자체 구현.

---

## 0. 설계 원칙

1. **이벤트-소싱 우선** — 모든 외부 입력은 mutation 전에 `raw_events`에 immutable로 적재. 위키 mutation은 raw_events 위에서 파생되는 결정의 산물.
2. **Orchestrator는 plan-only** — read·mutate 도구를 직접 들지 않는다. sub-agent를 호출하는 task DAG만 산출. Agency Swarm의 *"Orchestrator never answers directly — pure coordination"* 원칙을 명시적으로 차용.
3. **통신 primitive 두 종류** — 1대1 요청/응답은 `SendMessage`, 권한 이양은 `Handoff`. 이 둘을 명시적으로 분리해 plan 스키마에서 구분 (§2).
4. **자율성은 단계가 아니라 행렬** — workspace baseline tier × topic override × sensitivity cap × 액션별 confidence gate가 곱해져 결정.
5. **모든 mutation은 reversibility window 안에서 자동 롤백 가능** — Quality agent가 post-condition을 검사해 일정 시간 안에 되돌릴 수 있게.
6. **사람 검토는 batched** — 비슷한 결정을 묶어서 review queue에 올림. 단건 알람은 사람이 못 따라잡음.
7. **기존 스택 재사용** — BullMQ + drizzle/postgres + 기존 agent loop·dispatcher·tool catalog. 신규 프레임워크 의존성 도입 금지.

---

## 1. 한눈에 보는 전체 토폴로지

```text
External sources ──▶  Source Adapters  ──▶  raw_events
(Slack, Gmail, Linear,                      (idempotency_key,
 GDrive, GitHub, RSS,                        topic_key,
 webhook, file drop)                         occurred_at,
                                             sensitivity)
                              │
                              ▼
                       ┌──────────────┐
                       │ triage:queue │
                       └──────────────┘
                              │
                       ┌──────────────┐
                       │ Triage Agent │  classify · dedup · sensitivity · entity tag
                       └──────┬───────┘
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   drop (audit)        orchestrator:queue      review:queue
                              │
                       ┌──────────────────────────┐
                       │      Orchestrator        │
                       │  long-running workflow    │
                       │  (per workspace × topic) │
                       │   - SendMessage tasks    │
                       │   - Handoff transfers    │
                       └──────┬───────────────────┘
   ┌──────────┬──────────┬────┴─────┬─────────┬─────────┬─────────┐
   ▼          ▼          ▼          ▼         ▼         ▼         ▼
 Resolver  DiffAnalyzer Synthesis  Writer   Editor   Curator   Quality
  (RO)       (RO)        (RO)      (RW:    (RW:     (RO/RW)   (RO +
                                    create) edit)              rollback)
   │          │           │          │        │         │         │
   └──────────┴───────────┴──────────┴────────┴─────────┴─────────┘
                              │
                              ▼
            pages · revisions · revision_sets · entities · links · audit_logs
```

`Orchestrator`만 BullMQ 잡 ID에 `${workspaceId}:${topicKey}` 키를 박아 직렬화한다. 다른 sub-agent는 stateless하므로 자유 병렬.

---

## 2. 통신 Primitive — `SendMessage` vs `Handoff`

Agency Swarm의 통신 모델에서 가장 가져올 가치가 있는 부분이 이 분리다. 단, **개념·계약만 차용**하고 우리 스택에서 BullMQ + Redis pub/sub로 자체 구현한다.

### 2.1 `SendMessage` — 요청/응답

```ts
type SendMessage<T extends SubAgentName> = {
  kind: "send_message";
  to: T;
  taskId: string;             // DAG node id
  input: SubAgentInput[T];
  expects: "json" | "stream"; // sub-agent 결과 형식
  timeoutMs: number;
  parent: { runId: string; orchestratorTurn: number };
};
```

* 호출자(Orchestrator)는 sub-agent의 구조화된 결과를 **awaited**한다. 결과는 `orchestrator_tasks.output_json`에 저장되고 다음 task가 `$<taskId>.output`으로 참조 가능.
* 구현: BullMQ 잡으로 enqueue + Redis 키 `orch:reply:${runId}:${taskId}`에 결과 publish. Orchestrator는 해당 키를 BLPOP 또는 SUBSCRIBE로 대기.
* sub-agent는 호출자의 컨텍스트를 모름 — input/output 계약만 본다. 멱등성·재시도 안전.
* **기본 패턴.** Orchestrator의 task DAG 노드 대부분이 SendMessage.

### 2.2 `Handoff` — 권한 이양

```ts
type Handoff<T extends AgentName> = {
  kind: "handoff";
  to: T;
  reason: HandoffReason;
  carryContext: {
    runId: string;
    topicKey: string;
    triggeringEventIds: string[];
    accumulatedPlan?: TaskOutcomeSnapshot[];
    note: string;              // 왜 넘기는지 (≤ 500자)
  };
};

type HandoffReason =
  | "sensitivity_escalation"   // confidential 이상 — Review로 이양
  | "structural_refactor"      // 단일 topic 범위를 넘음 — Curator로 이양
  | "deadline_exceeded"        // turn/시간 캡 초과 — Review로 이양
  | "policy_block";            // tier가 L0/L1로 강제 — Review로 이양
```

* 호출자는 응답을 기다리지 않는다. 자기 run을 `status: "handed_off"`로 마감하고, 대상 에이전트가 새 run을 받아 이어서 처리.
* 새 run의 `parent_run_id` = 원 run의 id. trace는 부모-자식 관계로 연결.
* **언제 쓰는가:** Orchestrator가 *"이 topic은 더 이상 내가 안전하게 처리할 수 없다"* 고 판단할 때. Plan 단계에서 fallback 분기로 등장.
* **누가 받을 수 있는가:** Review Agent(사람 검토 escalate), Curator Agent(구조 리팩터링), 다른 워크스페이스의 Orchestrator(테넌트 분리 위반 감지 시). Editor는 Handoff 수신 불가 — Editor는 항상 SendMessage로만 호출.

### 2.3 두 primitive의 사용 규칙 (Orchestrator 시스템 프롬프트에 박는다)

| 상황 | 도구 |
| --- | --- |
| 한 topic 안의 일반적 처리 단계 (resolve → analyze → synthesize → write/edit → verify) | `SendMessage` |
| Sub-agent 결과를 기반으로 다음 단계 입력을 만드는 경우 | `SendMessage` (응답 필요) |
| 새 페이지 생성 (`create` target) | `SendMessage(Writer)` |
| 기존 페이지 수정 (`update` target) | `SendMessage(Editor)` |
| 기존 canonical 페이지가 있고 새 입력이 들어옴 — 변경점 식별 | `SendMessage(DiffAnalyzer)` |
| confidence < floor → 사람 검토로 escalate | `Handoff(Review)` |
| sensitivity == confidential/secret → 자동 처리 차단 | `Handoff(Review)` |
| 단일 topic 범위를 넘는 구조 변경 필요 | `Handoff(Curator)` |
| 같은 topic에서 한도(MAX_TURNS, dailyMutationCap) 초과 | `Handoff(Review)` |
| Quality fail + reversibility window 만료 | `Handoff(Review)` |
| ChangeSet에 substantive 항목 존재 + changeTypeGates에 의해 review 필수 | `Handoff(Review)` |

---

## 3. 에이전트 카탈로그

| 에이전트 | 역할 | 도구 권한 | 수신 가능 primitive |
| --- | --- | --- | --- |
| **Triage** | raw_event 분류 — relevant? sensitive? duplicate? entity 태깅. | read-only (외부 메타) | (큐 직접 소비, primitive 미사용) |
| **Orchestrator** | topic 단위 in-flight 상태 추적. task DAG 산출·실행. mutation 도구 없음. | 도구 없음. SendMessage/Handoff 발행만. | (큐 직접 소비) |
| **Resolver** | "이 topic이 어느 canonical 페이지에 속하는가" — search/backlink/entity 종합. 신규 vs 기존 vs split 결정. | read-only (기존 9개 read 도구) | `SendMessage` |
| **DiffAnalyzer** | 기존 canonical 페이지 vs 새 입력의 구조화된 ChangeSet 산출. 변경 단위·타입(substantive/editorial/structural/additive/removal)·effective date 추출. | read-only (`read_page`, `read_revision`) | `SendMessage` |
| **Synthesis** | raw_events·observations·ChangeSet를 outline + targets(create/update intent)으로 변환. **본문은 만들지 않음.** structureHint: chronological_dialogue, decision_log, spec, summary_brief, data_table. | read-only | `SendMessage` |
| **Writer** | 신규 페이지 본문 drafting + `create_page`. structureHint별 시스템 프롬프트 분기. large_context 모델 강제. citation 보존. | `create_page`, `create_folder`, (방금 만든 페이지 한정) `move_page`/`rename_page`, `noop`, `request_human_review` | `SendMessage` |
| **Editor** | 기존 페이지의 외과적 수정만. patch 정확도와 안전 가드가 핵심. 기존 [`runIngestionAgentShadow`](../packages/worker/src/lib/agent/loop.ts)를 `origin: "orchestrator-task"` 분기로 재활용. | `replace_in_page`, `edit_page_blocks`, `edit_page_section`, `update_page`, `append_to_page`, `delete_page`, `merge_pages`, `rollback_to_revision`, `move_page`, `rename_page` | `SendMessage` |
| **Curator** | 주기적 청소 — staleness·dead backlink·중복·빈 폴더·drift된 frontmatter·"6개월 갱신 없음" 감지. 단일 topic 범위를 넘는 구조 변경. cron 트리거. | read-only로 시작 → plan을 자기 Orchestrator run으로 발행 | `SendMessage`, `Handoff` |
| **Quality** | post-mutation 검사 — 의미 보존(LLM-as-judge), citation 유지, 링크 유효성, markdown lint, 정책 위반. fail 시 reversibility window 안이면 자동 rollback. | read + `rollback_to_revision` | `SendMessage` |
| **Review** | 유사 결정 묶음 → 사람 검토 batch 생성. 페이지 owner 알림 발송. 검토 결과를 다시 Orchestrator에 피드백. | UI/notification | `SendMessage`, `Handoff` |

### 3.1 Mutation tool partition

기존 [`createMutateTools`](../packages/worker/src/lib/agent/tools/mutate.ts)는 Writer/Editor용으로 partition된다. 호출 시 `audience: "writer" | "editor"` 인자로 노출 도구가 결정. `move_page` / `rename_page`는 양쪽 모두 노출되지만 Writer는 *"방금 만든 페이지에 한정"* prompt 가드를 추가로 받는다.

기존 Scheduled Agent는 **Editor 에이전트로 흡수**된다. Cron으로 Editor를 직접 부르는 경로는 호환성을 위해 한동안 유지하되, 신규 작업은 Orchestrator를 거쳐 SendMessage(Writer 또는 Editor) 형태로 위임.

---

## 4. 큐 토폴로지 (BullMQ)

기존 `scheduled-agent`, `ingestion-agent` 옆에 다음을 추가:

```ts
QUEUE_NAMES = {
  // 기존
  SCHEDULED_AGENT: "scheduled-agent",
  INGESTION_AGENT: "ingestion-agent",

  // 신규
  RAW_EVENT_INTAKE:    "raw-event-intake",     // adapters → triage 입구
  TRIAGE:              "triage-agent",
  ORCHESTRATOR:        "orchestrator",          // workspace×topic 키 직렬화
  SUB_AGENT_RESOLVER:      "sub-agent.resolver",
  SUB_AGENT_DIFF_ANALYZER: "sub-agent.diff_analyzer",
  SUB_AGENT_SYNTHESIS:     "sub-agent.synthesis",
  SUB_AGENT_WRITER:        "sub-agent.writer",
  SUB_AGENT_EDITOR:        "sub-agent.editor",     // = ingestion-agent 큐 alias
  SUB_AGENT_QUALITY:       "sub-agent.quality",
  CURATOR:             "curator-agent",         // cron 트리거
  REVIEW_BATCH:        "review-batch",
}
```

### 4.1 직렬화 / 동시성

* **Orchestrator 큐만** 잡 ID = `orch:${workspaceId}:${topicKey}`. BullMQ가 동일 ID 잡의 중복 enqueue를 거부 → 같은 topic 동시 실행 금지.
* 다른 sub-agent 큐는 잡 ID에 `randomUUID` 사용 — stateless하므로 자유 병렬.
* `SCHEDULED_AGENT_WORKER_CONCURRENCY` 패턴 그대로 각 sub-agent 워커별 `*_WORKER_CONCURRENCY` env 도입.

### 4.2 SendMessage 구현

1. Orchestrator가 `SendMessage` plan node를 발견 → 대상 큐에 잡 enqueue. 잡 데이터에 `replyChannel: "orch:reply:${runId}:${taskId}"` 포함.
2. Sub-agent worker가 작업 완료 후 Redis `PUBLISH ${replyChannel} <result-json>`.
3. Orchestrator는 해당 채널을 SUBSCRIBE 한 채로 await. timeout 시 task를 `failed`로 마감하고 replan turn에서 fallback 결정.

### 4.3 Handoff 구현

1. Orchestrator가 `Handoff` plan node를 발견 → 자기 run을 `status: "handed_off"`, `handoff_target_run_id` placeholder로 마감.
2. 대상 에이전트 큐에 새 잡 enqueue. 잡 데이터에 `parentRunId`, `carryContext` 포함.
3. 대상 에이전트가 새 run을 시작하고 그 id를 원 run의 `handoff_target_run_id`에 백필.
4. Reply 없음. Orchestrator는 즉시 종료.

---

## 5. Source Adapter 계층

각 외부 소스마다 얇은 워커. 책임은 두 가지 — (a) 외부 → 정규화된 `raw_events` 행 변환, (b) `idempotency_key` 보장.

```ts
interface RawEvent {
  id: uuid;
  workspaceId: uuid;
  source: "slack" | "gmail" | "linear" | "gdrive" | "webhook" | "rss" | "file_drop";
  externalId: string;             // 슬랙 ts, 이메일 message-id 등
  idempotencyKey: string;         // `${source}:${externalId}` — UNIQUE
  authorHint?: { handle: string; displayName: string; externalUserId: string };
  occurredAt: Date;               // 외부에서의 발생 시각
  threadKey?: string;             // 슬랙 thread_ts, gmail threadId
  contentType: "text/markdown" | "text/plain" | "html" | "json";
  payload: jsonb;                 // 원본 (pruned)
  attachments?: { uri: string; mime: string; sha256: string }[];
  sensitivityHint?: "public" | "internal" | "confidential" | "secret";
  language?: string;              // BCP-47 ("ko", "en", "ko-KR" 등). DiffAnalyzer가 이종 언어 비교 시 활용
  receivedAt: Date;
  triagedAt?: Date;
  triageVerdictId?: uuid;
  consumedByRunId?: uuid;
}
```

`threadKey`가 슬랙 두 사람 대화 정리의 핵심 — 같은 thread_ts를 가진 이벤트들이 자연스럽게 묶인다.

`raw_events`는 immutable. mutation이 잘못되어도 raw_events에서 다시 굴릴 수 있어야 한다 (replay 보장).

---

## 6. Triage Agent

Fast 모델로만 돌아가고, 결과는 한 행에 200~500 토큰짜리 verdict. Orchestrator를 부르기 전 cheap classifier 역할.

```ts
interface TriageVerdict {
  rawEventId: uuid;
  decision: "ingest" | "drop" | "defer" | "needs_review";
  topicKey: string;            // workspace 안에서 안정 hash — Orchestrator 직렬화 키
  entities: { type: string; name: string; externalId?: string }[];
  duplicateOf?: uuid;
  sensitivity: "public" | "internal" | "confidential" | "secret";
  urgency: "realtime" | "batched_15min" | "batched_hourly" | "batched_daily";
  reasoning: string;           // ≤ 500자
}
```

### 6.1 `topicKey` 산출 규칙

source별 결정적 함수. 같은 topic의 이벤트들이 모두 같은 키를 갖도록.

| Source | topicKey 형식 |
| --- | --- |
| slack | `slack:${channelId}:${threadKey ?? rootMessageTs}` |
| gmail | `gmail:${threadId}` |
| linear | `linear:${issueId}` |
| gdrive | `gdrive:${fileId}` (revision 누적) |
| webhook | adapter가 명시 |
| file_drop | `file:${sha256}` (단일 이벤트) |

### 6.2 Debounce 윈도우

`urgency: "batched_15min"`이면 즉시 Orchestrator에 안 들어가고, **같은 topicKey 안에 15분 새 이벤트가 안 오면 그제서야** enqueue. 사용자가 5분 동안 메시지 8번 보낼 때 Orchestrator가 8번 도는 걸 막는 핵심.

구현: Redis ZSET `triage:debounce:${topicKey}` + 15분 후 만료되는 delayed job.

### 6.3 자동 차단

* `sensitivity = secret` → 자동 drop + 운영자 alert. 페이지로 만들어지지 않는다.
* `decision = drop` → audit_logs에만 기록.

---

## 7. Orchestrator

`origin: "orchestrator-task"` 신규 분기를 [`packages/worker/src/lib/agent/loop.ts`](../packages/worker/src/lib/agent/loop.ts)에 추가하지만, **Orchestrator 자체는 mutation 도구를 들지 않으므로 loop의 plan/execute 단계 중 plan만 사용**한다.

### 7.1 Job 페이로드

```ts
interface OrchestratorJobData {
  workspaceId: uuid;
  topicKey: string;
  triggeringEventIds: uuid[];   // debounce 창에 누적된 raw_events
  triggeredBy: "event" | "review_followup" | "curator" | "manual";
  policySnapshot: WorkspacePolicy;  // 잡 시작 시점에 정책 동결
  parentRunId?: uuid;            // Handoff로 들어온 경우
}
```

### 7.2 처리 단계

1. **State load** — 이 topicKey에 대해 `topic_state` 조회. 최근 처리 이벤트, 매핑된 canonical 페이지, 마지막 mutation 시각, cooldown 상태, agent_memory(scope=topicKey)를 읽어옴.
2. **Plan turn** — Orchestrator 모델이 task DAG (JSON) 산출. Tool은 없음. `responseFormat: "json"`. (§7.4)
3. **DAG 실행** — `dependsOn` 위상정렬 + 가능한 곳은 병렬. 각 노드는 SendMessage 또는 Handoff. SendMessage 노드는 await + 결과를 다음 노드 입력에 주입. Handoff 노드는 발행 후 즉시 run 종료.
4. **Replan turn** — sub-agent가 confidence를 낮추거나 실패 시 Orchestrator가 plan을 갱신해서 잔여 task 다시 발행. plan/replan 합쳐 `ORCHESTRATOR_MAX_TURNS` (기본 3).
5. **Commit** — 모든 task 종료 후 `orchestrator_runs`/`orchestrator_tasks` 마감. `raw_events.consumed_by_run_id` 백필. Quality fail이 reversibility window 안이면 즉시 rollback task 추가.

### 7.3 한도 — `ORCHESTRATOR_LIMITS`

```ts
ORCHESTRATOR_LIMITS = {
  MAX_TURNS: 3,                       // plan/replan 합산
  MAX_TASKS_PER_TURN: 12,             // DAG 노드 상한
  MAX_PARALLEL_SUBAGENT_CALLS: 4,
  TIMEOUT_MS: 600_000,                // 10분 (Editor 호출까지 모두 포함)
  TURN_REMAINING_TIME_THRESHOLD_MS: 60_000,
  PLAN_INPUT_TOKEN_BUDGET: 60_000,    // Orchestrator는 가벼운 plan-only — 작게 유지
  PLAN_OUTPUT_TOKEN_BUDGET: 8_000,
}
```

각각 `ORCHESTRATOR_*` env로 오버라이드.

### 7.4 Plan 출력 스키마

#### 7.4.1 신규 페이지 케이스 (canonical 부재)

```json
{
  "summary": "<=500자 요약",
  "tasks": [
    {
      "kind": "send_message", "id": "t1", "to": "resolver",
      "input": { "topicKey": "...", "candidateTitles": ["..."], "entities": [...] },
      "expects": "json", "timeoutMs": 60000, "dependsOn": []
    },
    {
      "kind": "send_message", "id": "t2", "to": "synthesis",
      "input": {
        "rawEventIds": ["..."],
        "structureHint": "chronological_dialogue",
        "resolverResultRef": "$t1.output"
      },
      "dependsOn": ["t1"]
    },
    {
      "kind": "send_message", "id": "t3", "to": "writer",
      "input": {
        "targetRef": "$t2.output.targets[0]",
        "autonomyTier": "L2",
        "preserveCitations": true
      },
      "dependsOn": ["t2"]
    },
    {
      "kind": "send_message", "id": "t4", "to": "quality",
      "input": {
        "agentRunIdRef": "$t3.output.agentRunId",
        "checks": ["structural_completeness", "citation_preserved", "speaker_attribution"]
      },
      "dependsOn": ["t3"]
    }
  ],
  "handoffs": [],
  "fallback": {
    "if": "$t1.output.confidence < 0.6",
    "do": { "kind": "handoff", "to": "review", "reason": "policy_block", "note": "low resolver confidence" }
  },
  "openQuestions": []
}
```

#### 7.4.2 정책 개정 케이스 (canonical 존재 + diff)

```json
{
  "summary": "2026 Q2 출장 규정 개정 적용. 5.2 일일출장비 50→70만, 7장 부칙 신설. 시행일 2026-04-01.",
  "tasks": [
    { "kind": "send_message", "id": "t1", "to": "resolver",
      "input": { "topicKey": "policy:travel-policy" } },
    { "kind": "send_message", "id": "t2", "to": "diff_analyzer",
      "input": {
        "canonicalPageIdRef": "$t1.output.canonicalPageId",
        "newContentRef": "$rawEvents[0].payload",
        "expectChangeTypes": ["substantive", "additive"]
      },
      "dependsOn": ["t1"] },
    { "kind": "send_message", "id": "t3", "to": "synthesis",
      "input": {
        "mode": "changelog",
        "changeSetRef": "$t2.output.changeSet",
        "structureHint": "decision_log"
      },
      "dependsOn": ["t2"] },
    { "kind": "send_message", "id": "t4", "to": "writer",
      "input": {
        "targetRef": "$t3.output.targets.changelog",
        "parentPageIdRef": "$t1.output.canonicalPageId"
      },
      "dependsOn": ["t3"] },
    { "kind": "send_message", "id": "t5", "to": "editor",
      "input": {
        "targetsRef": "$t3.output.targets.updates",
        "revisionSetLabel": "2026 Q2 출장 규정 개정"
      },
      "scheduledFor": "$t2.output.changeSet.effectiveDate",
      "dependsOn": ["t3"] },
    { "kind": "send_message", "id": "t6", "to": "quality",
      "input": {
        "agentRunIdRefs": ["$t4.output.agentRunId", "$t5.output.agentRunId"],
        "checks": ["semantic_preservation", "backlink_impact", "citation_preserved"]
      },
      "dependsOn": ["t4", "t5"] }
  ],
  "handoffs": [],
  "fallback": {
    "if": "$t2.output.changeSet.changes[*].changeType contains 'substantive' && $t2.output.confidence < 0.95",
    "do": { "kind": "handoff", "to": "review", "reason": "policy_block",
            "note": "substantive policy change requires human review" }
  },
  "openQuestions": []
}
```

`scheduledFor`는 BullMQ delayed job으로 변환된다. 시행일 자정에 Editor task가 실행되며, 그 사이에는 `revision_sets.status = "scheduled"`. Writer가 만든 changelog 페이지(`t4`)는 즉시 생성되어 *"3일 후 시행 예정"* 상태로 표시.

### 7.5 Orchestrator 시스템 프롬프트 (스케치)

```text
You are the Orchestrator for WekiFlow's autonomous documentation system.
You do NOT call read or mutate tools directly. You ONLY produce a task DAG that
delegates work to specialized sub-agents using SendMessage or Handoff.

Communication primitives (use exactly one per node):
- SendMessage(to, input, expects): request/response. The sub-agent returns a
  structured result that downstream tasks can reference via $<taskId>.output.
- Handoff(to, reason, carryContext): permanent transfer of this run. Your run
  ends; the target agent takes over. Use only for escalation, not delegation.

Sub-agents available:
- resolver:      locate or define the canonical page(s) this topic belongs to.
- diff_analyzer: when an existing canonical page exists AND raw_events bring
                 a revised version, produce a structured ChangeSet
                 (substantive | editorial | structural | additive | removal)
                 and extract effective_date if present.
- synthesis:     produce outline + targets from raw_events (and optionally
                 ChangeSet). structureHint: "chronological_dialogue" |
                 "decision_log" | "spec" | "summary_brief" | "data_table".
                 mode: "compose" (default) | "changelog" (diff narrative).
                 Synthesis NEVER writes final markdown bodies.
- writer:        draft new-page markdown bodies and call create_page. Use for
                 every target.kind === "create".
- editor:        surgical patches on existing pages. Use for every
                 target.kind === "update". Editor is callable ONLY via
                 SendMessage, never via Handoff.
- curator:       structural refactors that span multiple topics.
- quality:       post-condition checks. ALWAYS terminate runs that produced
                 mutations with a quality task; never trust writer/editor
                 output without verification.
- review:        human review escalation. Reachable via SendMessage (queue a
                 batch) or Handoff (give up the run entirely).

Decomposition rules:
- One topic per orchestrator run. Never plan across topics — Handoff(curator)
  if the work spans topics.
- Prefer append/update over create when an active canonical page exists in
  topic_state.
- If canonical exists AND new content is substantively different, insert a
  diff_analyzer task between resolver and synthesis.
- Route create targets to writer, update targets to editor. Both can run in
  the same run if synthesis emits both.
- If raw_events span >24h, hint synthesis to thread by occurredAt.
- If sensitivity is "confidential", clamp autonomyTier to at most L1 (suggest
  only); if "secret", Handoff(review) immediately.
- If ChangeSet contains any change with type "substantive" or "removal",
  consult policy.changeTypeGates; if floor not met, Handoff(review).
- If ChangeSet has effective_date in the future, set scheduledFor on the
  editor task to that date.
- Always include a quality task downstream of any writer or editor task.
- If resolver returns confidence < policySnapshot.confidenceFloor, do NOT
  proceed to writer/editor; Handoff(review).
- Editor is never a Handoff target.

Return ONLY JSON of shape:
{
  "summary": "<=500 chars",
  "tasks":   [TaskSpec, ...],   // SendMessage nodes
  "handoffs":[HandoffSpec, ...], // Handoff nodes (usually 0 or 1)
  "fallback":{ "if": "<expression>", "do": HandoffSpec | null } | null,
  "openQuestions": []
}
```

### 7.6 Replan 시스템 프롬프트

```text
You are continuing a multi-turn orchestration run for WekiFlow.

Below are the original plan, the per-task outcomes, and any new sub-agent
results since your last turn. Propose only the remaining DAG nodes if more
work is needed, or return empty arrays to finish the run.

Rules:
- Do not re-issue tasks that already succeeded.
- If a task failed, replace it with a corrected version, escalate via
  Handoff(review), or skip it.
- Use the same SendMessage / Handoff contract as the initial plan turn.
- Empty tasks + empty handoffs = run complete.

Return only JSON with:
{ "summary": "...", "tasks": [], "handoffs": [], "openQuestions": [] }
```

---

## 8. 자율성 행렬

기존 `scheduled_auto_apply`, `allow_destructive_scheduled_agent` boolean 두 개로는 표현 부족. 신규 컬럼 `workspaces.orchestrator_policy` (jsonb):

```ts
type WorkspacePolicy = {
  baselineTier: "L0" | "L1" | "L2" | "L3" | "L4";
  // L0: observe only — raw_events만 적재, mutation 금지
  // L1: suggest only — 모든 결정은 review queue
  // L2: auto-apply non-destructive (replace/edit/append/create) at conf ≥ θ_safe
  // L3: + destructive (delete/merge) at conf ≥ θ_destruct
  // L4: + structure (move/rename/folder) at conf ≥ θ_struct

  confidenceFloors: {
    default: number;     // 기본 0.7
    destructive: number; // 기본 0.85
    structure: number;   // 기본 0.8
  };

  topicOverrides: Array<{
    matchRegex: string;      // topicKey에 매칭
    tier: WorkspacePolicy["baselineTier"];
  }>;

  sensitivityCaps: {
    public: WorkspacePolicy["baselineTier"];        // 기본 L4
    internal: WorkspacePolicy["baselineTier"];      // 기본 L3
    confidential: WorkspacePolicy["baselineTier"];  // 기본 L1
    secret: WorkspacePolicy["baselineTier"];        // 기본 L0
  };

  reversibilityWindowMs: number;   // 기본 600_000 (10분)
  topicCooldownMs: number;         // 기본 60_000 (같은 topic 1분 간격)
  dailyTokenCap: number;           // 기본 5_000_000
  perTopicDailyMutationCap: number;// 기본 30

  // 변경 타입별 게이트 — 사내 규정·정책 페이지 같은 살아있는 문서에 필수
  changeTypeGates: {
    substantive: { tier: Tier; confidenceFloor: number };  // 기본 L1, 0.95
    additive:    { tier: Tier; confidenceFloor: number };  // 기본 L2, 0.85
    removal:     { tier: Tier; confidenceFloor: number };  // 기본 L1, 0.95
    structural:  { tier: Tier; confidenceFloor: number };  // 기본 L2, 0.80
    editorial:   { tier: Tier; confidenceFloor: number };  // 기본 L2, 0.70
  };

  // Source authority — 같은 topic에 다른 출처에서 모순 입력이 들어올 때 우선순위
  sourceAuthority: Array<{ source: string; weight: number }>;
  // 예: [{source: "gdrive:legal-shared/", weight: 100},
  //      {source: "slack:C-LEGAL", weight: 80},
  //      {source: "slack:*", weight: 30}]
};
```

### 적용 알고리즘

```ts
function effectiveTier(
  policy: WorkspacePolicy,
  topicKey: string,
  sensitivity: Sensitivity,
  changeTypes?: ChangeType[],   // ChangeSet이 있을 때만
): Tier {
  const baseline = policy.baselineTier;
  const override = policy.topicOverrides.find(o => new RegExp(o.matchRegex).test(topicKey))?.tier;
  const cap = policy.sensitivityCaps[sensitivity];
  const gateMin = (changeTypes ?? [])
    .map(t => policy.changeTypeGates[t].tier)
    .reduce((a, b) => minTier(a, b), "L4");
  return minTier(baseline, override ?? "L4", cap, gateMin);
}
```

Tier가 결정되면 Orchestrator가 plan 단계에서 sub-agent input의 `autonomyTier`로 전달. Writer/Editor는 자기 run에서 이 tier × confidence × action_type을 곱해 mutation을 auto_apply / suggested / needs_review로 분기.

---

## 9. 새 데이터 모델

기존 테이블([`SCHEDULED_AGENT.md` §10](SCHEDULED_AGENT.md#10-영속화-매핑))에 더해 다음을 추가.

| 테이블 | 핵심 컬럼 | 역할 |
| --- | --- | --- |
| `raw_events` | id, workspace_id, source, idempotency_key (UNIQUE), topic_key, occurred_at, payload, sensitivity_hint, language?, triage_verdict_id, consumed_by_run_id | 외부 입력 immutable log |
| `triage_verdicts` | id, raw_event_id, decision, topic_key, sensitivity, urgency, entities_json, reasoning, model_run_id, created_at | Triage 결과 |
| `orchestrator_runs` | id, workspace_id, topic_key, triggering_event_ids, parent_run_id, handoff_target_run_id, plan_json, status, decisions_count, total_tokens, total_cost_usd, started_at, completed_at | 한 번의 Orchestrator 실행 (per-run 비용 rollup 포함) |
| `orchestrator_tasks` | id, run_id, task_id, kind ("send_message"\|"handoff"), to_agent, input_json, output_json, status, depends_on (uuid[]), latency_ms, model_run_id, scheduled_for? | DAG 내 개별 노드 (deferred 실행 지원) |
| `topic_state` | (workspace_id, topic_key) PK, canonical_page_id?, last_mutation_at, last_run_id, cooldown_until, summary_blob | topic별 현재 상태 (cache) |
| `quality_verdicts` | id, agent_run_id, checks_json, verdict ("pass"\|"warn"\|"fail"), rollback_initiated, rollback_run_id?, created_at | post-condition 결과 |
| `review_batches` | id, workspace_id, topic_groups_json, items_json, assignee?, status, opened_at, resolved_at | 검토 묶음 |
| `agent_memory` | (workspace_id, scope, key) PK, scope ("global"\|topic_key), value_json, version, updated_at | Orchestrator의 장기 메모 |
| `revision_sets` | id, workspace_id, label, effective_date?, source_event_id, change_set_json, status ("scheduled"\|"applied"\|"rolled_back"\|"superseded"), supersedes_id?, created_at, applied_at? | 한 묶음의 변경 추적 (분기 개정 등) |
| `page_owners` | (page_id, user_id) PK, role ("owner"\|"approver"\|"watcher"), notify_on (string[]) | 페이지별 사람 owner — substantive 변경 알림 필수 |
| `page_provenance` | id, page_id, page_revision_id, raw_event_id, span_blocks (text[]), created_at | 페이지의 어느 부분이 어느 raw_event에서 왔는지 매핑 (citation 보존) |

기존 `page_revisions`에 `revision_set_id` (nullable FK), `source` 컬럼에 `"orchestrator-writer" | "orchestrator-editor"` 값 추가.

### 9.1 `agent_memory` 가 자율성의 핵심

사람이 한 번 검토 단계에서 *"이 채널 대화는 회의록 형식으로 정리해 줘"* 라고 피드백하면, 이게 `agent_memory(scope=topic_key, key="format_preference")`에 저장되고 **다음 Orchestrator 런부터 자동 반영**된다. Plan 단계에서 `topic_state` 로딩 시 함께 읽혀 시스템 프롬프트의 *"workspace operator instructions"* 자리에 합쳐짐.

### 9.2 `parent_run_id` / `handoff_target_run_id` 의 의미

* `parent_run_id`: Handoff로 들어온 run임을 표시. trace UI에서 부모-자식 관계로 시각화.
* `handoff_target_run_id`: 이 run이 다른 run으로 권한을 넘겼음을 표시.
* 두 컬럼이 합쳐져 다중 에이전트 간 trace 그래프를 형성.

### 9.3 `revision_sets` 의미와 충돌 처리

* 한 묶음의 변경(예: *"2026 Q2 출장 규정 개정"*)을 단일 단위로 추적. 한 set에 속한 `page_revisions`는 모두 같은 `revision_set_id`를 갖는다.
* `effective_date` 가 미래면 `status = "scheduled"`. BullMQ delayed job이 그날 자정에 Editor task를 실행. UI는 *"3일 후 시행 예정"* 으로 표시.
* **충돌 처리 (concurrent revision_set):** Q2 set이 `scheduled` 상태인데 Q3 개정안이 들어오면 — Orchestrator가 `revision_sets` 테이블에서 같은 워크스페이스의 동일 페이지에 대한 미적용 set을 검색. 발견 시 Q3 set의 `supersedes_id = Q2.id`로 마크하고 Q2를 `superseded`로 종료 (BullMQ delayed job 취소). Q2의 changelog 페이지는 *"Q3 개정안에 의해 대체됨"* 메모 추가.
* **롤백 처리:** 이미 `applied`된 set을 롤백하려면 `revision_sets.status = "rolled_back"` + 포함된 모든 `page_revision_ids`에 대해 `rollback_to_revision`을 set 단위로 일괄 발행. 단, 그 위에 사람이 만든 revision이 있으면 자동 롤백 차단 (기존 `rollback_to_revision` 가드 그대로 적용) → review_batch로 escalate.

### 9.4 `page_provenance` — citation 보존

위키 페이지의 모든 본문 블록은 `page_provenance` 테이블을 통해 어느 `raw_event`에서 나왔는지 추적된다. Writer가 `create_page` 호출 시 자기 출력의 block id 단위로 source mapping을 함께 기록. Editor의 patch도 마찬가지 — 새로 들어가는 블록은 provenance를 남기고, 삭제되는 블록의 provenance는 archive 처리.

이 테이블은 (a) audit *"이 정책 조항 어디서 왔지?"* (b) Quality의 `citation_preserved` 검증 (c) 운영자가 source 권위에 따라 충돌 해결할 때의 근거 자료가 된다.

### 9.5 `page_owners` — 알림 모델

Sensitive 페이지 (정책·약관·매뉴얼 등) 는 사람 owner를 가진다.
owner role:

* `"owner"` — 모든 substantive 변경에 대해 사전 승인 필수 (review_batch에 자동 assignee로 등록)
* `"approver"` — 변경 후 알림 + 7일 내 이의 제기 가능
* `"watcher"` — 알림만

Review Agent가 batch를 생성할 때 영향 받는 페이지의 `page_owners`를 조회해 알림 fanout을 결정.

---

## 10. 시나리오 매핑

### 10.1 슬랙 두 사람 대화 (신규 페이지 생성)

이전에 Scheduled Agent로는 못 풀었던 케이스.

#### 시나리오

A가 09:00, B가 15:00에 슬랙 #project 채널에서 같은 thread에 메시지를 보냄. 17:00에 추가 메시지 없음 → 17:15에 debounce closure.

#### 흐름

1. **Adapter** — Slack adapter가 메시지 도착마다 raw_events 행 추가.
   * `topicKey = slack:C123:1715200000.123456` (root ts)
   * `occurredAt = 메시지 ts`, `authorHint = {handle, displayName}`
   * `threadKey = thread_ts`
2. **Triage** — 각 행을 `topicKey`로 묶어 `urgency = batched_15min`으로 verdict. 동일 topic의 이벤트가 15분 새 추가되면 debounce 타이머 갱신.
3. **Debounce closure (17:15)** — Orchestrator 큐에 잡 1개 enqueue, jobId = `orch:${ws}:slack:C123:1715200000.123456`. BullMQ가 동시 실행 차단.
4. **Orchestrator state load** — `topic_state(canonical_page_id=null)` → 신규 페이지 분기.
5. **Orchestrator plan** — DAG (§7.4.1 케이스):
   * `t1: SendMessage(resolver, {topicKey, entities, candidateTitles})` — "어디에 만들지" 추론
   * `t2: SendMessage(synthesis, {rawEventIds, structureHint:"chronological_dialogue", speakers:[A,B], resolverResultRef:$t1})` — outline + targets 산출
   * `t3: SendMessage(writer, {targetRef:$t2.targets[0], autonomyTier:"L2", preserveCitations:true})` — 본문 drafting + `create_page` 실행, `page_provenance` 동시 적재
   * `t4: SendMessage(quality, {agentRunIdRef:$t3, checks:["structural_completeness","speaker_attribution","citation_preserved"]})` — 화자 누락·시간 순서·인용 보존 검증
   * `fallback: if $t1.confidence<0.6 → Handoff(review)`
6. **Writer 실행** — 기존 loop 코드가 `audience: "writer"` 모드로 돌면서 `create_page` mutation. `page_revisions.source = "orchestrator-writer"`.
7. **Quality fail 케이스** — 화자 누락 감지 → reversibility window(10분) 안이라 자동 `rollback_to_revision` 발행 + `review_batch` 생성.
8. **다음 메시지 1시간 후** — 같은 thread에 새 메시지 도착 → Triage → debounce → Orchestrator 재실행 → Resolver가 `topic_state.canonical_page_id`에서 기존 페이지 발견 → Synthesis가 mode `"compose"`로 *"기존 페이지의 마지막 timestamp 이후 메시지만"* outline + `targets:[{kind:"update", intent:"append"}]` 산출 → Editor가 `append_to_page`.
9. **agent_memory 학습** — 사용자가 review에서 *"화자 핸들 대신 displayName으로 표시해 줘"* 피드백 → `agent_memory(scope="slack:C123:...", key="speaker_format", value="displayName")` 저장 → 이후 같은 thread의 모든 처리에 자동 반영.

#### 이전 설계 대비 풀린 문제

| 이전 약점 | 해결 메커니즘 |
| --- | --- |
| 시간 정렬 보장 안 됨 | raw_events.occurredAt + Synthesis structureHint |
| 화자 보존 어려움 | authorHint 정규화 + Quality speaker_attribution check |
| 점진적 갱신 어려움 | topic_state.canonical_page_id + Resolver의 기존 페이지 탐지 |
| 5분에 8번 도는 churn | Triage debounce 윈도우 |
| 사람 피드백 학습 안 됨 | agent_memory + 검토 결과 백필 |
| 같은 topic 동시 실행 race | Orchestrator 큐 jobId 직렬화 |

---

### 10.2 분기 단위 정책 개정 (기존 페이지 부분 수정)

사내 규정·약관·매뉴얼처럼 **이미 canonical 페이지가 있고, 분기/월마다 일부만 바뀌는 살아있는 문서** 처리.

#### 시나리오

운영팀(법무팀 공유 GDrive)에 "2026 Q2 출장 규정.docx" 업로드. 변경: ① 5.2 일일출장비 50→70만원 ② 7장 부칙 신설. 시행일 2026-04-01.

#### 흐름

1. **Adapter** — GDrive adapter가 파일 변경 감지 → raw_event 적재.
   * `source = "gdrive:legal-shared/"`, `topicKey = policy:travel-policy` (사전 등록 mapping rule)
   * `sensitivity_hint = "internal"`, `payload = 추출된 마크다운 + 메타데이터`
2. **Triage** — `urgency = batched_hourly` (정책은 즉시성 < 정확성). `entities = ["출장비", "부칙"]`.
3. **Debounce closure** — 1시간 무변경 → Orchestrator enqueue.
4. **Orchestrator state load** — `topic_state.canonical_page_id` 발견. `page_owners`에서 `["legal-team", "ops-head"]` 조회. `agent_memory(scope=topicKey)`에서 *"changelog 페이지는 부모 페이지 자식으로"* 같은 학습된 정책 로드.
5. **Orchestrator plan** — DAG (§7.4.2 케이스, `effectiveDate` 기반 deferred):
   * `t1: Resolver` → canonical 페이지 발견
   * `t2: DiffAnalyzer({canonicalPageIdRef, newContentRef, expectChangeTypes:["substantive","additive"]})` → ChangeSet:

     ```json
     [{sec:"5.2", type:"substantive", before:"50만원", after:"70만원", confidence:0.97},
      {sec:"7", type:"additive", added:"...", confidence:0.93}]
     effectiveDate: "2026-04-01"
     ```

   * `t3: Synthesis(mode:"changelog", changeSetRef:$t2)` → targets:

     - `{kind:"create", title:"2026 Q2 출장 규정 변경사항", parentPageId:$t1, structureHint:"decision_log"}`
     - `{kind:"update", pageId:$t1, sectionAnchor:"5.2", op:"replace", ...}`
     - `{kind:"update", pageId:$t1, sectionAnchor:"7", op:"append", ...}`
  
   * `t4: Writer($t3.targets.changelog)` — changelog 페이지 즉시 생성 (시행일 표시), `revision_set_id` 부여
   * `t5: Editor($t3.targets.updates, scheduledFor:"2026-04-01T00:00:00Z")` — **deferred**, BullMQ delayed job. `revision_sets.status = "scheduled"`
   * `t6: Quality(agentRunIdRefs:[$t4,$t5], checks:["semantic_preservation","backlink_impact","citation_preserved"])`
   * `fallback: if $t2.changeSet.changes contains "substantive" && $t2.confidence < 0.95 → Handoff(review)` — changeTypeGates에 의해 substantive는 0.95 floor
6. **Owner 알림** — Review Agent가 `page_owners` 조회 후 legal-team/ops-head에 알림 발송. revision_set이 `scheduled` 상태인 동안 검토 가능. 7일 내 이의 없으면 자동 시행 (Phase 3 옵션).
7. **시행일 자정 (2026-04-01 00:00)** — BullMQ delayed job 실행 → Editor가 `edit_page_section` 두 건 적용 → `revision_sets.status = "applied"` → Quality(`t6`)가 backlink_impact 검사: "출장 신청서 양식" 페이지가 50만 한도 언급 발견 → `verdict = "warn"` + review_batch 추가.
8. **충돌 처리 — 만약 Q2가 아직 scheduled 상태인데 Q3 안이 들어오면** — Orchestrator의 새 run이 `revision_sets`에서 같은 페이지의 미적용 set을 탐지 → Q3 set의 `supersedes_id = Q2.id`, Q2를 `superseded`로 마감 (delayed job 취소) → Q2 changelog 페이지에 *"Q3 개정안에 의해 대체됨"* 안내 자동 추가.
9. **롤백 — 시행 후 문제 발견** — 운영자가 review_batch에서 *"Q2 롤백"* 요청 → Editor가 set 단위로 `rollback_to_revision` 일괄 발행 → 단, 그 사이 사람이 추가한 revision이 있으면 자동 차단 → Handoff(review).

#### 핵심 보장

| 요구사항 | 메커니즘 |
| --- | --- |
| "어디가 어떻게 바뀌었는지" 자동 식별 | DiffAnalyzer ChangeSet |
| 변경 타입별 자율성 차등 | `changeTypeGates` |
| 한 묶음 변경 추적 가능 | `revision_sets` + `page_revisions.revision_set_id` |
| 시행일 처리 | `scheduledFor` + BullMQ delayed job |
| 사람 owner 사전 승인 | `page_owners` + Review Agent fanout |
| 변경 사이 충돌 해결 | `supersedes_id` + delayed job 취소 |
| 변경 출처 추적 | `page_provenance` (어느 raw_event에서 왔는지) |
| 백링크 영향 평가 | Quality의 `backlink_impact` check |
| Set 단위 롤백 | `rollback_to_revision` 일괄 + 사람 revision 가드 |

---

## 11. 가드레일 정리

| 항목 | 메커니즘 |
| --- | --- |
| 무한 루프 방지 | `ORCHESTRATOR_LIMITS.MAX_TURNS`, `topicCooldownMs`, `perTopicDailyMutationCap` |
| 토큰 폭주 | 워크스페이스 일일 cap (기존) + Orchestrator 자체 cap + sub-agent별 cap (계층 예약) |
| 동시성 | Orchestrator 큐의 jobId가 `${ws}:${topicKey}` → 같은 topic 동시 1개만 |
| 잘못된 mutation | Quality auto-rollback (reversibility window 안에서) |
| Prompt injection | raw_events.payload는 Triage·Synthesis가 모델 입력으로 줄 때 *"treated as untrusted user content"* 마커로 wrap. 도구 호출 지시는 Orchestrator·Editor만 발행 가능 |
| 민감 정보 유출 | sensitivity cap에 의해 secret/confidential은 자동 처리 차단 |
| 정책 변경 race | `policySnapshot`을 잡 시작 시 동결 |
| Handoff 남용 | Plan 검증 단계에서 `handoffs.length ≤ 1` 강제. Editor는 Handoff 수신 불가 |
| 사람 피드백 학습 | review 결과가 `agent_memory`에 영구 반영 |
| 정책 페이지 무단 변경 | `changeTypeGates`로 substantive/removal은 자동 review. `page_owners` fanout |
| Citation 유실 | `page_provenance` 적재 + Quality의 `citation_preserved` check |
| 시행 전 적용 | `scheduledFor` + BullMQ delayed job + `revision_sets.status = "scheduled"` |
| 미적용 변경 위에 새 변경 들어옴 | `revision_sets.supersedes_id` + delayed job 취소 |
| 다른 출처 모순 입력 | `sourceAuthority` 가중치로 우선순위 결정 |

---

## 12. 점진적 도입 경로

처음부터 위 10개 에이전트를 다 만드는 건 비현실적. 권장 순서:

### Phase 1 — Minimum Viable Orchestrator (4~6주)

* Source Adapter 1개 (슬랙)
* `raw_events` + `triage_verdicts` + `orchestrator_runs`/`tasks` 테이블
* Triage = rule-based (LLM 없이 source별 결정 함수). `topicKey`, `sensitivity`는 정규식·휴리스틱으로 산출
* Orchestrator (LLM, plan-only)
* Writer + Editor 분리 출범 (둘 다 기존 loop를 `audience` 모드로 재활용)
* Quality = rule-based: link 유효성, frontmatter, markdown lint
* 자율성 baseline = **L1** (모든 mutation은 review queue로). 자동 적용 없음.
* SendMessage primitive만 구현. Handoff는 Phase 2.
* DiffAnalyzer / `revision_sets` / `page_owners` / `page_provenance`는 Phase 2에서 — Phase 1은 신규 페이지 생성 위주.

### Phase 2 — 정책 개정 처리 + 자율성 + 학습 루프 (8~10주)

* **DiffAnalyzer + `revision_sets` + `page_owners` + `page_provenance`** — 사내 규정 use case 활성화
* `changeTypeGates` + `sourceAuthority` 정책 적용
* `agent_memory` + 검토 피드백 백필
* Curator 추가 (cron 기반 staleness 감지)
* Quality LLM-as-judge 추가 (semantic_preservation, citation_preserved)
* Handoff primitive 구현
* baseline L2 활성화 (non-destructive 자동 적용 + reversibility window)
* GDrive adapter (정책 문서 출처)

### Phase 3 — 멀티 소스 + L3/L4

* Gmail / Linear / GitHub adapter
* Composio 검토 (직접 어댑터 vs. 위탁)
* Review batching UI + owner notification fanout
* baseline L3/L4 (destructive / structural)
* multi-tenant 정책 엔진 SaaS-grade로 강화
* Backfill / replay 진입점

---

## 13. 기존 코드와의 매핑 요약

| 기존 | 신규 | 변경 종류 |
| --- | --- | --- |
| `runIngestionAgentShadow(origin: "scheduled" \| "ingestion")` | `+ "orchestrator-task"` 분기. 호출 시 `audience: "writer" \| "editor"` 인자 추가 | origin enum + 도구 분할 |
| `scheduled_runs`, `agent_runs`, `ingestion_decisions` | 그대로 + §9의 신규 테이블 | additive |
| `page_revisions` | `+ revision_set_id` (nullable FK), `source` enum에 `"orchestrator-writer" \| "orchestrator-editor"` 추가 | additive |
| `scheduledPromptPrefix` | 별도 `orchestratorPromptPrefix`, sub-agent별 prefix (writer/editor/diff_analyzer 각자) | 신규 |
| `MAX_TURNS=5`, `TIMEOUT_MS=180_000` | Orchestrator는 별도 `ORCHESTRATOR_LIMITS` (10분 데드라인) | 신규 limits |
| `createMutateTools` | `audience` 파라미터로 Writer/Editor용 partition. 신규 호출 시 둘 중 하나의 카탈로그만 노출 | 시그니처 확장 |
| `createReadOnlyTools` | 그대로 (Resolver/DiffAnalyzer/Quality에서 재사용) | 변경 없음 |
| `dispatcher` 캐싱·쿼터 | 그대로. sub-agent 단위로 quota 격리 | 추가 설정만 |
| `partial review queue skip (scheduled)` | Orchestrator는 review_batch로 명시 escalate | semantics 명확화 |
| `enqueueScheduledAgentRun` | 호환성 유지. 내부적으로 Orchestrator 큐로도 라우팅 가능 옵션 | additive |
| FTS·embedding 인덱스 | mutation 후 인덱스 갱신은 기존 reindex 워커 트리거 그대로 사용. revision_set 단위 reindex 옵션 추가 | 추가 트리거만 |

---

## 14. 채택·거부 결정 기록

### 채택

* **Agency Swarm의 `SendMessage` / `Handoff` 분리** — 통신 의도(요청 vs 이양)를 plan JSON에서 명시적으로 구분. 운영·디버깅 편의 큼. 코드 의존성은 받지 않고 BullMQ + Redis로 자체 구현.
* **"Orchestrator never answers directly" 원칙** — 시스템 프롬프트에 박아 직접 mutation 시도를 차단.
* **Specialist 분해 단위 = output type** (Synthesis 안의 structureHint) — OpenSwarm이 `slides_agent`, `docs_agent`로 나눈 것을 우리는 한 Synthesis 안의 hint로 흡수.
* **Writer / Editor 분리 (v0.2)** — 신규 페이지 작성과 외과적 수정은 인지 부하·모델 라우팅·도구 권한이 모두 달라 한 prompt에서 처리 시 모순 발생. Writer는 large_context 강제 + create 전용, Editor는 patch 정확도 + update 전용으로 분리.
* **DiffAnalyzer 신설 (v0.2)** — 기존 canonical 페이지가 있는 상태에서 새 입력 처리 시 변경 단위 식별을 별도 read-only sub-agent로 분리. Synthesis와 책임 결이 다름 (composition vs. comparison).
* **`revision_sets` + `changeTypeGates` (v0.2)** — 분기/월 단위 정책 개정처럼 한 묶음 변경을 단일 단위로 추적 + 변경 타입별 자율성 차등. 사내 규정 use case의 기본 요구.

### 거부

* **OpenSwarm을 통째로 쓰는 것** — domain mismatch (interactive deliverable 생성기 vs. 지속 유입 위키 mutation), persistence 모델 부재, 멀티 테넌시 부재. 별도 분석 노트 참조.
* **LangGraph / CrewAI / AutoGen 도입** — 우리 BullMQ + drizzle 스택과 큐·상태 관리 책임이 겹쳐 이중 인프라 부담. 필요 시 plan 단계 LLM 호출 안에 임베드 가능하지만 시스템 차원 의존성으로는 받지 않음.
* **Composio 즉시 도입** — Phase 3에서 비용·secret 관리·rate limit 검토 후 결정. Phase 1~2는 슬랙 어댑터 직접 구현.
* **DiffAnalyzer를 Synthesis 안의 mode로 흡수** — prompt 복잡도가 너무 커지고 책임이 흐려짐. 별도 sub-agent로 분리.
* **Writer가 본문 작성을 LLM 없이 Synthesis가 만든 마크다운을 그대로 쓰는 단순 applier가 되는 안** — Synthesis가 두 가지 일(outline + 본문)을 다 하면 Writer 존재 가치 없음. 대신 Synthesis는 outline + targets까지만, Writer가 본문 generation을 책임지는 분리가 더 깨끗함.

---

## 15. 진입점 인덱스 (구현 시)

| 파일 (예정) | 역할 |
| --- | --- |
| `packages/api/src/routes/v1/orchestrator.ts` | 수동 트리거 + run 조회 REST |
| `packages/api/src/routes/v1/revision-sets.ts` | revision_set CRUD + 롤백/취소 (admin+) |
| `packages/api/src/routes/v1/page-owners.ts` | 페이지 owner 등록/알림 설정 |
| `packages/api/src/lib/orchestrator-enqueue.ts` | orchestrator_runs 생성 + BullMQ enqueue |
| `packages/worker/src/workers/orchestrator.ts` | Orchestrator harness |
| `packages/worker/src/workers/triage-agent.ts` | Triage worker |
| `packages/worker/src/workers/sub-agent/{resolver,diff_analyzer,synthesis,writer,editor,quality}.ts` | Sub-agent workers |
| `packages/worker/src/workers/curator-agent.ts` | Cron-based curator |
| `packages/worker/src/workers/review-batch.ts` | Review queue 빌더 + owner fanout |
| `packages/worker/src/lib/orchestrator/{plan,dispatch,sendMessage,handoff}.ts` | Orchestrator 내부 로직 |
| `packages/worker/src/lib/orchestrator/revisionSet.ts` | revision_set 관리 (생성/시행/충돌 해결/롤백) |
| `packages/worker/src/lib/source-adapters/{slack,gmail,gdrive,linear,...}.ts` | Source Adapter 계층 |
| `packages/shared/src/types/orchestrator.ts` | 페이로드/스키마 |
| `packages/shared/src/schemas/orchestrator.ts` | zod 스키마 (plan/task/handoff/changeSet) |
| `packages/shared/src/schemas/changeSet.ts` | DiffAnalyzer 출력 zod 스키마 |
| `packages/shared/src/constants/index.ts` | `ORCHESTRATOR_LIMITS`, 큐 이름 추가 |

---

## 16. 열린 질문

* Phase 2에서 `agent_memory`의 versioning/충돌 정책 — 같은 key에 대한 동시 검토 피드백을 어떻게 머지할지.
* Curator가 Handoff로 받은 run을 다시 자기 Orchestrator로 부를 수 있는가 — 순환 차단 정책 필요.
* Editor의 기존 `scheduled_auto_apply` 항상 true 가정과 Orchestrator의 tier 전달 사이의 호환성 — Phase 1에서 어느 쪽이 진실인지 결정.
* Source Adapter가 실패했을 때 `raw_events`에 부분 행을 만들 것인가 vs. 아예 안 만들 것인가 — observability vs. 완결성 trade-off.
* SSE/Redis trace 채널을 sub-agent 단위로 분리할 것인가 vs. parent run 채널에 모두 흘릴 것인가.
* DiffAnalyzer가 ChangeSet을 만들 때 안정 block id 매핑까지 시도할 것인가 vs. section anchor만 줄 것인가 — 정확도 vs. 토큰 비용.
* Writer가 본문 작성 시 Synthesis가 준 outline을 얼마나 엄격히 따라야 하는가 — outline drift 허용 범위.
* `revision_sets`의 `superseded` 마감 시 changelog 페이지 자동 갱신 vs. 수동 — 운영 팀 의견 필요.
* `page_provenance`의 보존 기간 — raw_event가 보존 정책에 의해 삭제될 때 provenance도 같이 archive할지.
* `page_owners`의 부재 시 fallback — 정책 페이지인데 owner가 등록 안 됐다면 워크스페이스 admin 전체에 알림? 아니면 처리 차단?
* 멀티언어 (한/영 혼용) raw_event 처리 — DiffAnalyzer가 언어 다른 두 버전(한국어 정책 v1 + 영어 v2)을 비교해야 할 때.
* Backfill / replay 메커니즘 — 로직 변경 후 과거 raw_events를 재처리하는 admin 진입점이 필요한가.
* Per-run 비용 rollup (`orchestrator_runs.total_cost_usd`)을 위한 token→USD 환산 — 워크스페이스별 가격표 vs. 글로벌 가격표.
