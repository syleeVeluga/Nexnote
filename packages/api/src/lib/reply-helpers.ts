import type { FastifyReply } from "fastify";
import type { ZodIssue } from "zod";
import type { RateLimitResult } from "./rate-limit.js";

export function sendValidationError(reply: FastifyReply, issues: ZodIssue[]) {
  return reply.code(400).send({
    error: "Validation failed",
    code: "VALIDATION_ERROR",
    details: issues,
  });
}

export function sendRateLimitExceeded(
  reply: FastifyReply,
  result: RateLimitResult,
  code: string,
  message: string,
) {
  const resetAtUnixSec = Math.floor(Date.now() / 1000) + result.resetSec;
  return reply
    .code(429)
    .header("Retry-After", String(result.resetSec))
    .header("X-RateLimit-Limit", String(result.limit))
    .header("X-RateLimit-Remaining", String(result.remaining))
    .header("X-RateLimit-Reset", String(resetAtUnixSec))
    .send({ error: "Too Many Requests", code, details: message });
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}
