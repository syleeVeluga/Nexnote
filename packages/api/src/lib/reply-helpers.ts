import type { FastifyReply } from "fastify";
import type { ZodIssue } from "zod";

export function sendValidationError(reply: FastifyReply, issues: ZodIssue[]) {
  return reply.code(400).send({
    error: "Validation failed",
    code: "VALIDATION_ERROR",
    details: issues,
  });
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}
