import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  apiTokens,
  auditLogs,
  ingestions,
  type Ingestion,
} from "@nexnote/db";
import {
  DEFAULT_JOB_OPTIONS,
  JOB_NAMES,
  type RouteClassifierJobData,
} from "@nexnote/shared";
import { isUniqueViolation } from "./reply-helpers.js";

const BROWSER_IMPORT_TOKEN_NAME = "Browser Import (auto)";

// Provisions a hidden auto-token so browser-initiated ingestion rows can
// satisfy the api_token_id NOT NULL FK. The hash is random bytes that are
// never exposed — the row exists purely for referential integrity and as
// a rate-limit keying surface.
async function getOrCreateImportTokenId(
  fastify: FastifyInstance,
  workspaceId: string,
  userId: string,
): Promise<string> {
  const [existing] = await fastify.db
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.workspaceId, workspaceId),
        eq(apiTokens.createdByUserId, userId),
        sql`${apiTokens.revokedAt} IS NULL`,
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const tokenHash = randomBytes(32).toString("hex");
  const [created] = await fastify.db
    .insert(apiTokens)
    .values({
      workspaceId,
      createdByUserId: userId,
      name: BROWSER_IMPORT_TOKEN_NAME,
      tokenHash,
    })
    .returning({ id: apiTokens.id });
  return created.id;
}

export interface EnqueueIngestionInput {
  workspaceId: string;
  userId: string;
  /** When omitted, an auto-provisioned browser-import token is used. */
  apiTokenId?: string;
  sourceName: string;
  externalRef?: string | null;
  idempotencyKey: string;
  contentType: string;
  titleHint?: string | null;
  rawPayload: Record<string, unknown>;
}

export interface EnqueueIngestionResult {
  ingestion: Ingestion;
  replayed: boolean;
}

/**
 * Persists an ingestion row, writes an audit log entry, and enqueues the
 * route-classifier job. Idempotency-key collisions return the existing row
 * with `replayed: true`. Throws unique-violation passthrough otherwise.
 *
 * Rate-limit checks stay in the route layer because each entry path
 * (API-token vs browser vs webhook) wants its own bucket policy.
 */
export async function enqueueIngestion(
  fastify: FastifyInstance,
  input: EnqueueIngestionInput,
): Promise<EnqueueIngestionResult> {
  const apiTokenId =
    input.apiTokenId ??
    (await getOrCreateImportTokenId(fastify, input.workspaceId, input.userId));

  let row: Ingestion | undefined;
  try {
    [row] = await fastify.db
      .insert(ingestions)
      .values({
        workspaceId: input.workspaceId,
        apiTokenId,
        sourceName: input.sourceName,
        externalRef: input.externalRef ?? null,
        idempotencyKey: input.idempotencyKey,
        contentType: input.contentType,
        titleHint: input.titleHint ?? null,
        rawPayload: input.rawPayload,
        status: "pending",
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      const [existing] = await fastify.db
        .select()
        .from(ingestions)
        .where(
          and(
            eq(ingestions.workspaceId, input.workspaceId),
            eq(ingestions.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) {
        // Previously failed ingestions are retry-worthy: re-enqueue the
        // classifier and reset the status so the row doesn't stay stuck.
        // BullMQ dedupes by jobId, so concurrent replays are safe.
        if (existing.status === "failed") {
          const [reset] = await fastify.db
            .update(ingestions)
            .set({ status: "pending", processedAt: null })
            .where(eq(ingestions.id, existing.id))
            .returning();
          // BullMQ ignores add() when a job with the same id still exists
          // (even in the failed set), so remove any lingering copy first.
          const prior = await fastify.queues.ingestion.getJob(existing.id);
          if (prior) {
            await prior.remove().catch(() => undefined);
          }
          const retryJobData: RouteClassifierJobData = {
            ingestionId: existing.id,
            workspaceId: input.workspaceId,
          };
          await fastify.queues.ingestion.add(
            JOB_NAMES.ROUTE_CLASSIFIER,
            retryJobData,
            { jobId: existing.id, ...DEFAULT_JOB_OPTIONS },
          );
          return { ingestion: reset ?? existing, replayed: false };
        }
        return { ingestion: existing, replayed: true };
      }
    }
    throw err;
  }

  if (!row) {
    throw new Error("Failed to insert ingestion row");
  }

  await fastify.db.insert(auditLogs).values({
    workspaceId: input.workspaceId,
    userId: input.userId,
    entityType: "ingestion",
    entityId: row.id,
    action: "create",
    afterJson: {
      sourceName: input.sourceName,
      idempotencyKey: input.idempotencyKey,
    },
  });

  const jobData: RouteClassifierJobData = {
    ingestionId: row.id,
    workspaceId: input.workspaceId,
  };
  await fastify.queues.ingestion.add(JOB_NAMES.ROUTE_CLASSIFIER, jobData, {
    jobId: row.id,
    ...DEFAULT_JOB_OPTIONS,
  });

  return { ingestion: row, replayed: false };
}
