# Agent Parity Gate — UI 편집 가능한 워크스페이스별 임계치

> **상태**: 구현 (2026-04-30) · 마이그레이션 0018 머지 후 활성
> **유형**: 구현 RFC

## Context

Agent 모드 승격 게이트는 4개 임계치(관찰 일수 / 비교 건수 / Action 합의율 / Target 합의율)를 평가한다 ([packages/api/src/lib/agent-parity-gate.ts](../packages/api/src/lib/agent-parity-gate.ts)). 직전까지 이 값은 환경변수로만 조정 가능했다:

- 변경마다 `.env` 편집 + API 서버 재시작 필요 → 운영자/실험자 부담
- 모든 워크스페이스가 동일 임계치 → "production은 엄격 / 사내 테스트는 느슨" 같은 워크스페이스별 정책 불가
- env 차이 추적이 어렵고 audit 트레일이 부재

목표: **워크스페이스별 override를 UI에서 직접 편집**. NULL 시 env 값 fallback (backwards-compat). UX는 한국어로 사용자에게 익숙한 표현.

이 RFC는 기존 `agentDailyTokenCap` / `agentFastThresholdTokens` 워크스페이스 컬럼 패턴(0017)을 그대로 따라가며, 새로운 architectural risk를 도입하지 않는다.

## Scope

- 워크스페이스 테이블에 4개 nullable 컬럼 추가 (마이그레이션 0018)
- gate criteria reader가 워크스페이스 row → env 순서로 fallback
- `PATCH /workspaces/:id` Zod schema 확장
- AI Settings 페이지에 collapsible "승격 기준 (실험용)" 패널 추가
- 한국어 라벨 + "실험·테스트 워크스페이스에서만 사용" 경고 + 기본값 되돌리기 버튼
- audit_logs는 `workspace.update` 행에 자동 포함되므로 별도 저장 안 함

비대상: 시스템 전역 일괄 편집 UI, 변경 이력 시각화, 슬랙 알림.

## Architecture

### 1. DB — 4개 nullable 컬럼

[packages/db/src/schema/users.ts](../packages/db/src/schema/users.ts) `workspaces`:

```ts
agentParityMinObservedDays: integer("agent_parity_min_observed_days"),
agentParityMinComparableCount: integer("agent_parity_min_comparable_count"),
agentParityMinActionAgreementRate: numeric(
  "agent_parity_min_action_agreement_rate", { precision: 4, scale: 3 },
),
agentParityMinTargetPageAgreementRate: numeric(
  "agent_parity_min_target_page_agreement_rate", { precision: 4, scale: 3 },
),
```

CHECK 4개:
- `min_observed_days` BETWEEN 1 AND 30
- `min_comparable_count` BETWEEN 1 AND 1000
- `min_*_agreement_rate` BETWEEN 0 AND 1

Migration: [packages/db/src/migrations/0018_agent_parity_gate_overrides.sql](../packages/db/src/migrations/0018_agent_parity_gate_overrides.sql) + journal 갱신.

### 2. Reader fallback

[packages/api/src/lib/agent-parity-gate.ts](../packages/api/src/lib/agent-parity-gate.ts) 신규 export:

```ts
export async function readAgentParityGateCriteriaForWorkspace(
  db: Database, workspaceId: string, env = process.env,
): Promise<AgentParityGateCriteria> {
  const base = readAgentParityGateCriteria(env);
  const [row] = await db.select({...}).from(workspaces)
    .where(eq(workspaces.id, workspaceId)).limit(1);
  return applyAgentParityGateOverrides(base, row ?? null);
}
```

`applyAgentParityGateOverrides` 는 필드별 NULL 체크 + numeric 컬럼이 string으로 오는 점을 처리 + rate 값 [0,1] clamp.

호출처 2곳:
- [readAgentParityGateStatus](../packages/api/src/lib/agent-parity-gate.ts) — PATCH 게이트 검증
- [agent-runs.ts diagnostics](../packages/api/src/routes/v1/agent-runs.ts) — UI 진단 응답

### 3. PATCH — Zod + Drizzle numeric 변환

[packages/shared/src/schemas/workspace.ts](../packages/shared/src/schemas/workspace.ts) `updateWorkspaceSchema.extend(...)` 에 4 필드 (number 타입, range 검증).

[packages/api/src/routes/v1/workspaces.ts](../packages/api/src/routes/v1/workspaces.ts) PATCH 핸들러:
- numeric 컬럼은 Drizzle pg가 string을 요구하므로 `value.toFixed(3)` 으로 변환
- DTO + GET list select에 4 컬럼 포함

### 4. UI — Collapsible 패널

[packages/web/src/pages/AISettingsPage.tsx](../packages/web/src/pages/AISettingsPage.tsx) "Daily token cap" 패널 다음에 새 panel 1개. 기본 접힘.

| 내부 필드 | UI 라벨 | 입력 | 비고 |
|---|---|---|---|
| `agentParityMinObservedDays` | **관찰 기간** | number, suffix "일" | 기본 7 / 1~30 |
| `agentParityMinComparableCount` | **최소 비교 건수** | number, suffix "건" | 기본 20 / 1~1000 |
| `agentParityMinActionAgreementRate` | **결정 종류 일치율** | percent (0~100), suffix "%" | 기본 90% / 내부 0~1 변환 |
| `agentParityMinTargetPageAgreementRate` | **대상 페이지 일치율** | percent (0~100), suffix "%" | 기본 85% / 내부 0~1 변환 |

각 input 아래:
- 설명 한 줄 (왜 이 값을 조정하는지 사용자 언어로)
- "현재 적용: **X** (시스템 기본값 / 이 워크스페이스 override)" microcopy

상단에 경고 배너:
> ⚠ 이 값을 낮추면 충분히 검증되지 않은 AI 결정이 워크스페이스에 자동 반영될 수 있습니다. 실험·테스트 워크스페이스에서만 사용하세요. 비워두면 시스템 기본값(7일 / 20건 / 90% / 85%)이 적용됩니다.

하단 액션:
- "기본값으로 되돌리기" 버튼 → 4개 input을 빈 문자열로 (저장 시 NULL → env fallback)

저장은 페이지 상단 기존 Save 버튼 재사용. Helper 추가:
- `parseOptionalIntegerInRange(value, label, min, max)` — Days/Count
- `parseOptionalPercent(value, label)` — 0~100 입력 → 0~1 변환
- `rateInputFromValue(0..1)` — 표시할 때 0~100으로

## Critical files

**신규**
- [packages/db/src/migrations/0018_agent_parity_gate_overrides.sql](../packages/db/src/migrations/0018_agent_parity_gate_overrides.sql)

**수정**
- [packages/db/src/schema/users.ts](../packages/db/src/schema/users.ts) — 4 컬럼 + check
- [packages/db/src/migrations/meta/_journal.json](../packages/db/src/migrations/meta/_journal.json) — idx 18 entry
- [packages/shared/src/schemas/workspace.ts](../packages/shared/src/schemas/workspace.ts) — Zod 4 필드
- [packages/api/src/lib/agent-parity-gate.ts](../packages/api/src/lib/agent-parity-gate.ts) — reader override + apply helper
- [packages/api/src/lib/agent-parity-gate.test.ts](../packages/api/src/lib/agent-parity-gate.test.ts) — apply override 테스트
- [packages/api/src/routes/v1/workspaces.ts](../packages/api/src/routes/v1/workspaces.ts) — DTO + select + PATCH numeric 변환
- [packages/api/src/routes/v1/agent-runs.ts](../packages/api/src/routes/v1/agent-runs.ts) — workspace-aware criteria
- [packages/web/src/lib/api-client.ts](../packages/web/src/lib/api-client.ts) — Workspace type + update body
- [packages/web/src/pages/AISettingsPage.tsx](../packages/web/src/pages/AISettingsPage.tsx) — state + helpers + collapsible panel
- [packages/web/src/styles/system.css](../packages/web/src/styles/system.css) — collapsible/warning/effective styles

## Verification

**유닛 (체크: 머지 직전 실행)**
- [x] `applyAgentParityGateOverrides` — NULL fallback per-field
- [x] numeric string 입력(`"0.500"`) 정상 파싱
- [x] [0,1] clamp
- [x] non-finite (NaN, "not-a-number") 무시
- [x] api 패키지 119 tests pass
- [x] api / db / shared / web 빌드 성공

**E2E (수동)**
1. `pnpm --filter db migrate` — 0018 적용
2. `pnpm dev`
3. 워크스페이스 owner 로그인 → `/settings/ai`
4. "승격 기준 (실험용)" 패널 펼침 → 4 input에 `1 / 1 / 0 / 0` 입력 → Save
5. Shadow 모드로 전환 → ingestion 1건 처리
6. Parity dashboard refresh → gate.status === "passed", `gate.criteria` 가 입력값 반영
7. Agent 버튼 활성 → 선택 → Save 성공
8. "기본값으로 되돌리기" → 4 input 비워짐 → Save → diagnostics가 다시 7/20/0.9/0.85 표시

**회귀**
- env 만 설정하고 워크스페이스 컬럼 NULL → 기존과 동일 (backwards-compat)
- `.env` 의 4 임계치 변수는 시스템 default 백업 경로로 유지

## Out of scope

- Audit log 별도 시각화 — `workspace.update` 행 `afterJson` 에 이미 포함
- 시스템 전역(모든 워크스페이스) 일괄 편집 UI — env 경로 유지
- 임계치 변경 시 슬랙 알림

## Future work

- 시스템 전역 default를 super-admin UI에서 편집 (admin-only 페이지 / 별도 RFC)
- 임계치 변경 이력 그래프 (현재는 `audit_logs` raw row 만)
- A/B 임계치 (워크스페이스 A는 엄격, 워크스페이스 B는 실험적) 비교 대시보드
