# Slack Events API 웹훅 — HR 스레드 답변 자동 수집

WekiFlow의 Slack 웹훅 기능은 HR 담당자가 Slack에서 미답변 질문에 답변을 달면, 해당 Q&A를 WekiFlow 지식 수집 파이프라인(Ingestion)으로 자동 투입합니다. 이를 통해 AI가 인식하지 못했던 지식 공백(사각지대)이 HR 담당자의 답변으로 즉시 위키에 반영됩니다.

---

## 동작 흐름

```
[AI 에이전트]
  └─ 답변 불가 질문 감지
       └─ Slack HR 채널에 "미답변 질문 접수" 메시지 전송

[HR 담당자]
  └─ Slack 메시지에 스레드 답변 작성

[Slack Events API]
  └─ POST /api/v1/webhooks/slack/events

[WekiFlow 웹훅 핸들러]
  ├─ HMAC-SHA256 서명 검증
  ├─ HR 채널 스레드 답변 여부 필터링
  ├─ conversations.replies API로 원본 질문 조회
  └─ enqueueIngestion() → 분류(route-classifier) → 위키 자동 반영
```

---

## 엔드포인트

```
POST /api/v1/webhooks/slack/events
Content-Type: application/json
```

인증 없음 (Slack HMAC-SHA256 서명으로 요청 출처를 검증합니다).

### 요청 — URL 검증 챌린지 (최초 등록 시 1회)

```json
{
  "type": "url_verification",
  "challenge": "abc123..."
}
```

응답 `200 OK`:

```json
{ "challenge": "abc123..." }
```

### 요청 — 메시지 이벤트

```json
{
  "type": "event_callback",
  "event": {
    "type": "message",
    "channel": "C0AUVER6M5X",
    "user": "U01ABC123",
    "text": "재택근무는 주 2회 가능합니다. 금요일과 월요일 중 선택할 수 있어요.",
    "ts": "1776845466.426159",
    "thread_ts": "1776845350.559919"
  }
}
```

응답 `200 OK`:

```json
{ "ok": true }
```

> **중요**: 실제 수집 처리는 `200` 반환 **이후** 비동기로 실행됩니다 (Slack 3초 응답 제한 대응).

---

## 환경 변수

| 변수명 | 필수 | 설명 |
|--------|------|------|
| `SLACK_SIGNING_SECRET` | 권장 | Slack App > Basic Information > Signing Secret. 미설정 시 서명 검증을 생략하고 경고를 기록합니다 (개발/데모 전용). |
| `SLACK_BOT_TOKEN` | 권장 | `xoxb-` 형태의 봇 토큰. `conversations.replies` 호출로 원본 질문을 조회하는 데 사용합니다. 미설정 시 원본 질문 없이 답변만 수집합니다. |
| `SLACK_HR_CHANNEL_ID` | 필수 | 미답변 질문이 전달되는 Slack 채널 ID (예: `C0AUVER6M5X`). |
| `SLACK_BOT_USER_ID` | 필수 | 봇 자신의 Slack 유저 ID (예: `U0AUG7B5CTC`). 봇이 스스로 보낸 답글을 수집하지 않도록 필터링합니다. |
| `SLACK_WEKIFLOW_WORKSPACE_ID` | 필수 | 수집 대상 WekiFlow 워크스페이스 UUID. `GET /api/v1/workspaces`로 확인합니다. |
| `SLACK_WEKIFLOW_USER_ID` | 필수 | 수집 작업을 귀속할 WekiFlow 유저 UUID. `POST /api/v1/auth/login` 응답의 `user.id` 값입니다. |

---

## Slack 앱 설정 단계

### 1. Bot Token Scopes 추가

[api.slack.com/apps](https://api.slack.com/apps) → 앱 선택 → **OAuth & Permissions** → **Bot Token Scopes**:

| 스코프 | 용도 |
|--------|------|
| `channels:history` | HR 채널 메시지 이벤트 수신 및 스레드 조회 |
| `channels:read` | 채널 정보 조회 |

스코프 추가 후 **Reinstall to Workspace** 클릭 (토큰 값은 유지됩니다).

### 2. Event Subscriptions 설정

**Event Subscriptions** → **Enable Events** → **Request URL**:

```
https://{your-wekiflow-domain}/api/v1/webhooks/slack/events
```

URL 입력 후 Slack이 `url_verification` 챌린지를 전송합니다. 서버가 정상 응답하면 ✓ Verified 표시가 나타납니다.

**Subscribe to bot events** → `message.channels` 추가 → **Save Changes**.

### 3. 환경 변수 설정 후 서버 재시작

```bash
# .env 파일 예시
SLACK_SIGNING_SECRET=your-signing-secret-from-slack-app
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_HR_CHANNEL_ID=C0AUVER6M5X
SLACK_BOT_USER_ID=U0AUG7B5CTC
SLACK_WEKIFLOW_WORKSPACE_ID=0084be3b-1860-4d38-a050-117d3ae4dc22
SLACK_WEKIFLOW_USER_ID=9ea1740b-9a88-4d79-a6b3-ae6a3f77214c
```

---

## 수집(Ingestion) 구조

Slack HR 답변은 다음 형식의 텍스트로 수집됩니다:

```
[HR 문서 보완]

질문: {봇 메시지에서 추출한 질문 요약}

HR 담당자 답변: {스레드 답변 텍스트}
```

**idempotency key** 형식: `slack:thread:{channel}:{thread_ts}:reply:{sha256(reply_ts)[:16]}`

동일 답변이 Slack에서 중복 전달되어도 WekiFlow에는 한 번만 수집됩니다.

수집 후 WekiFlow의 `route-classifier` 파이프라인이 적절한 위키 페이지를 찾아 자동으로 반영하거나 검토 큐에 등록합니다.

---

## 필터링 조건

다음 조건을 **모두** 만족하는 Slack 메시지만 수집합니다:

| 조건 | 설명 |
|------|------|
| `event.channel === SLACK_HR_CHANNEL_ID` | HR 전용 채널의 메시지만 처리 |
| `event.thread_ts !== undefined` | 스레드 답글 (원본 메시지 제외) |
| `event.ts !== event.thread_ts` | 스레드 최초 메시지가 아닌 답글 |
| `event.bot_id === undefined` | 봇 메시지 제외 |
| `event.user !== SLACK_BOT_USER_ID` | 봇 유저 ID 기반 추가 필터 |
| `event.subtype === undefined` | 메시지 수정/삭제 이벤트 제외 |

---

## 관련 소스 파일

| 파일 | 설명 |
|------|------|
| `packages/api/src/routes/v1/webhooks/slack-events.ts` | 라우트 핸들러, 이벤트 처리 로직 |
| `packages/api/src/lib/slack-verify.ts` | Slack HMAC-SHA256 서명 검증 유틸리티 |
| `packages/api/src/lib/enqueue-ingestion.ts` | WekiFlow 수집 파이프라인 진입점 |
| `packages/api/src/routes/index.ts` | 라우트 등록 (`/webhooks/slack` 접두사) |
| `.env.example` | 환경 변수 예시 |
