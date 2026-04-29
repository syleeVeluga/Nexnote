import { createHmac, timingSafeEqual } from "node:crypto";

/** Slack이 요청에 서명을 붙인 시점과 현재 시각의 허용 오차 (초). 재전송 공격 방지. */
const MAX_AGE_SECONDS = 300; // 5분

/**
 * Slack Events API 요청의 HMAC-SHA256 서명을 검증합니다.
 *
 * Slack은 모든 이벤트 요청에 `X-Slack-Request-Timestamp` 와
 * `X-Slack-Signature` 헤더를 포함합니다. 서명은
 * `v0:{timestamp}:{rawBody}` 문자열을 Signing Secret으로
 * HMAC-SHA256 해싱한 값입니다.
 *
 * @param signingSecret Slack App > Basic Information > Signing Secret
 * @param timestamp     `X-Slack-Request-Timestamp` 헤더 값 (Unix 초)
 * @param rawBody       파싱 전 원본 요청 바디 문자열
 * @param signature     `X-Slack-Signature` 헤더 값 (형식: `v0=<hex>`)
 * @returns 서명이 유효하면 `true`, 아니면 `false`
 */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  const ts = parseInt(timestamp, 10);
  if (
    Number.isNaN(ts) ||
    Math.abs(Math.floor(Date.now() / 1000) - ts) > MAX_AGE_SECONDS
  ) {
    return false;
  }

  const basestring = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(basestring).digest("hex")}`;

  try {
    return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(signature, "utf8"));
  } catch {
    return false;
  }
}
