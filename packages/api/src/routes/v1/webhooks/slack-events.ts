/**
 * Slack Events API 웹훅 — HR 스레드 답변 → WekiFlow 지식 수집
 *
 * 동작 흐름:
 *   1. Slack이 이벤트를 POST /api/v1/webhooks/slack/events 로 전송
 *   2. HMAC-SHA256 서명 검증 (SLACK_SIGNING_SECRET 설정 시)
 *   3. URL 검증 챌린지는 동기 처리 후 즉시 반환
 *   4. message 이벤트 중 HR 채널의 스레드 답글(비봇)을 필터링
 *   5. Slack conversations.replies API로 원본 질문 텍스트 조회
 *   6. enqueueIngestion()으로 Q&A 텍스트를 WekiFlow 파이프라인에 투입 (202)
 *   7. HTTP 200을 즉시 반환하고 처리는 비동기로 수행 (Slack 3초 제한 대응)
 *
 * 필요 환경 변수:
 *   SLACK_SIGNING_SECRET       — Slack App > Basic Information > Signing Secret
 *   SLACK_BOT_TOKEN            — xoxb- 형태의 봇 토큰 (conversations.replies 호출용)
 *   SLACK_HR_CHANNEL_ID        — 미답변 질문이 전달되는 HR Slack 채널 ID
 *   SLACK_BOT_USER_ID          — 봇 메시지를 필터링하기 위한 봇 유저 ID
 *   SLACK_WEKIFLOW_WORKSPACE_ID — 수집 대상 WekiFlow 워크스페이스 UUID
 *   SLACK_WEKIFLOW_USER_ID      — 수집 작업 귀속 WekiFlow 유저 UUID
 */

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { enqueueIngestion } from "../../../lib/enqueue-ingestion.js";
import { verifySlackSignature } from "../../../lib/slack-verify.js";

// ── 환경 변수 ─────────────────────────────────────────────────────────────────

const SIGNING_SECRET = process.env["SLACK_SIGNING_SECRET"];
const BOT_TOKEN      = process.env["SLACK_BOT_TOKEN"] ?? "";
const HR_CHANNEL_ID  = process.env["SLACK_HR_CHANNEL_ID"] ?? "C0AUVER6M5X";
const BOT_USER_ID    = process.env["SLACK_BOT_USER_ID"]   ?? "U0AUG7B5CTC";
const WORKSPACE_ID   = process.env["SLACK_WEKIFLOW_WORKSPACE_ID"] ?? "";
const USER_ID        = process.env["SLACK_WEKIFLOW_USER_ID"]      ?? "";

// ── Zod 스키마 ────────────────────────────────────────────────────────────────

const slackUrlVerificationSchema = z.object({
  type:      z.literal("url_verification"),
  challenge: z.string(),
});

const slackMessageEventSchema = z.object({
  type:  z.literal("event_callback"),
  event: z.object({
    type:      z.string(),
    channel:   z.string().optional(),
    user:      z.string().optional(),
    text:      z.string().optional(),
    ts:        z.string(),
    thread_ts: z.string().optional(),
    bot_id:    z.string().optional(),
    subtype:   z.string().optional(),
  }),
});

// ── Fastify 타입 확장 (raw body 저장용) ────────────────────────────────────────

declare module "fastify" {
  interface FastifyRequest {
    /** 서명 검증을 위한 파싱 전 원본 요청 바디 */
    rawBody?: string;
  }
}

// ── Slack API 헬퍼 ────────────────────────────────────────────────────────────

/**
 * Slack conversations.replies API로 스레드 원본 메시지(봇이 보낸 질문)를 조회합니다.
 * 실패 시 빈 문자열을 반환하여 수집 자체를 막지 않습니다.
 */
async function fetchParentMessage(channel: string, threadTs: string): Promise<string> {
  if (!BOT_TOKEN) return "";
  try {
    const url = new URL("https://slack.com/api/conversations.replies");
    url.searchParams.set("channel", channel);
    url.searchParams.set("ts", threadTs);
    url.searchParams.set("limit", "1");

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${BOT_TOKEN}` },
    });
    if (!res.ok) return "";

    const json = (await res.json()) as { ok: boolean; messages?: Array<{ text?: string }> };
    return json.ok ? (json.messages?.[0]?.text ?? "") : "";
  } catch {
    return "";
  }
}

/**
 * 봇 메시지에서 질문 요약을 추출합니다.
 * 봇 메시지 형식: "[미답변 질문 접수] OOO (팀) - 질문요약"
 */
function extractQuestionSummary(parentText: string): string {
  const match = parentText.match(/- (.+)$/m);
  return match ? match[1].trim() : parentText.slice(0, 200);
}

/**
 * Q&A 텍스트를 WekiFlow 수집 파이프라인에 투입합니다.
 */
async function ingestHrReply(
  fastify: FastifyInstance,
  params: {
    channel:  string;
    threadTs: string;
    replyTs:  string;
    userId:   string;
    replyText: string;
  },
): Promise<void> {
  if (!WORKSPACE_ID || !USER_ID) {
    fastify.log.warn(
      "[slack-events] SLACK_WEKIFLOW_WORKSPACE_ID 또는 SLACK_WEKIFLOW_USER_ID가 설정되지 않아 수집을 건너뜁니다.",
    );
    return;
  }

  const parentText     = await fetchParentMessage(params.channel, params.threadTs);
  const questionSummary = extractQuestionSummary(parentText);

  const content = [
    "[HR 문서 보완]",
    "",
    `질문: ${questionSummary}`,
    "",
    `HR 담당자 답변: ${params.replyText}`,
  ].join("\n");

  // 동일 답글이 두 번 이상 전달돼도 중복 수집되지 않도록 멱등성 키를 부여합니다.
  const idempotencyKey = `slack:thread:${params.channel}:${params.threadTs}:reply:${
    createHash("sha256").update(params.replyTs).digest("hex").slice(0, 16)
  }`;

  const { ingestion, replayed } = await enqueueIngestion(fastify, {
    workspaceId:     WORKSPACE_ID,
    userId:          USER_ID,
    sourceName:      "Slack HR Reply",
    idempotencyKey,
    contentType:     "text/plain",
    titleHint:       `[HR 답변] ${questionSummary.slice(0, 100)}`,
    rawPayload: {
      content,
      extractorVersion: "slack-hr-reply",
      slackChannel:     params.channel,
      slackThreadTs:    params.threadTs,
      slackReplyTs:     params.replyTs,
      slackUserId:      params.userId,
      questionSummary,
    },
  });

  fastify.log.info(
    {
      ingestionId:     ingestion.id,
      replayed,
      slackChannel:    params.channel,
      slackThreadTs:   params.threadTs,
      questionSummary,
    },
    "[slack-events] 수집 완료",
  );
}

// ── 이벤트 처리 ───────────────────────────────────────────────────────────────

async function processSlackEvent(
  fastify: FastifyInstance,
  body: Record<string, unknown>,
): Promise<void> {
  const parsed = slackMessageEventSchema.safeParse(body);
  if (!parsed.success) return; // event_callback 이외 타입은 무시

  const { event } = parsed.data;

  const isHrThreadReply =
    event.type      === "message" &&
    event.channel   === HR_CHANNEL_ID &&
    event.thread_ts !== undefined &&
    event.ts        !== event.thread_ts && // 스레드 원본 메시지 제외
    !event.bot_id                        && // 봇 메시지 제외
    event.user      !== BOT_USER_ID      && // 봇 유저 ID 기반 추가 필터
    event.subtype   === undefined;          // message_changed, message_deleted 등 제외

  if (!isHrThreadReply) return;

  const replyText = (event.text ?? "").trim();
  if (!replyText) return;

  fastify.log.info(
    {
      channel:  event.channel,
      threadTs: event.thread_ts,
      user:     event.user,
      textLen:  replyText.length,
    },
    "[slack-events] HR 스레드 답변 감지 — 수집 시작",
  );

  await ingestHrReply(fastify, {
    channel:   event.channel!,
    threadTs:  event.thread_ts!,
    replyTs:   event.ts,
    userId:    event.user ?? "unknown",
    replyText,
  });
}

// ── Fastify 플러그인 ──────────────────────────────────────────────────────────

const slackWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  // 이 스코프에서만 JSON 파서를 재정의하여 서명 검증용 raw body를 캡처합니다.
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request: FastifyRequest, rawBody: string | Buffer, done) => {
      request.rawBody = rawBody as string;
      try {
        done(null, JSON.parse(rawBody as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  /**
   * POST /api/v1/webhooks/slack/events
   *
   * Slack Events API 수신 엔드포인트입니다.
   * - 인증 없음 (Slack HMAC 서명으로 요청 출처를 검증)
   * - Slack URL 검증 챌린지를 동기적으로 처리
   * - 이벤트 처리는 응답 반환 후 비동기로 수행 (Slack 3초 타임아웃 대응)
   */
  fastify.post("/events", async (request, reply) => {
    // ── 서명 검증 ──────────────────────────────────────────────────────────────
    if (SIGNING_SECRET) {
      const timestamp = request.headers["x-slack-request-timestamp"] as string | undefined;
      const signature = request.headers["x-slack-signature"]          as string | undefined;

      if (!timestamp || !signature || !request.rawBody) {
        return reply.code(400).send({
          error: "Missing Slack signature headers",
          code:  "SLACK_SIGNATURE_MISSING",
        });
      }

      if (!verifySlackSignature(SIGNING_SECRET, timestamp, request.rawBody, signature)) {
        request.log.warn({ timestamp }, "[slack-events] 서명 검증 실패");
        return reply.code(401).send({
          error: "Invalid Slack signature",
          code:  "SLACK_SIGNATURE_INVALID",
        });
      }
    } else {
      request.log.warn(
        "[slack-events] SLACK_SIGNING_SECRET 미설정 — 서명 검증 생략 (개발/데모 모드)",
      );
    }

    const body = request.body as Record<string, unknown>;

    // ── URL 검증 챌린지 (Slack App 등록 시 1회 발생) ───────────────────────────
    const urlVerification = slackUrlVerificationSchema.safeParse(body);
    if (urlVerification.success) {
      request.log.info("[slack-events] URL 검증 챌린지 응답");
      return reply.code(200).send({ challenge: urlVerification.data.challenge });
    }

    request.log.debug({ eventType: body["type"] }, "[slack-events] 이벤트 수신");

    // ── 즉시 200 반환 (Slack 3초 응답 제한 대응) ───────────────────────────────
    void reply.code(200).send({ ok: true });

    // ── 비동기 이벤트 처리 ─────────────────────────────────────────────────────
    setImmediate(() => {
      void processSlackEvent(fastify, body).catch((err: unknown) => {
        fastify.log.error({ err }, "[slack-events] 이벤트 처리 중 오류 발생");
      });
    });
  });
};

export default slackWebhookRoutes;
