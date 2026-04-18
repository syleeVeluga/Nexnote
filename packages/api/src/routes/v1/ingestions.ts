import type { FastifyPluginAsync } from "fastify";
import { eq, and, desc, count, sql } from "drizzle-orm";
import { z } from "zod";
import {
  createIngestionSchema,
  uuidSchema,
  paginationSchema,
  INGESTION_STATUSES,
  ERROR_CODES,
} from "@nexnote/shared";
import { ingestions, ingestionDecisions, apiTokens } from "@nexnote/db";
import type { IngestionDecision } from "@nexnote/db";
import {
  getMemberRole,
  forbidden,
  insufficientRole,
  EDITOR_PLUS_ROLES,
  workspaceParamsSchema,
} from "../../lib/workspace-auth.js";
import {
  sendValidationError,
  sendRateLimitExceeded,
} from "../../lib/reply-helpers.js";
import { approveDecision, rejectDecision } from "../../lib/apply-decision.js";
import { consumeRateLimit, parsePositiveInt } from "../../lib/rate-limit.js";
import { enqueueIngestion } from "../../lib/enqueue-ingestion.js";
import { mapIngestionDto } from "../../lib/ingestion-dto.js";
import { registerImportRoutes } from "./ingestions-import.js";

const INGESTION_RATE_PER_MIN = parsePositiveInt(
  process.env["INGESTION_RATE_LIMIT_PER_MINUTE"],
  60,
);
const INGESTION_QUOTA_PER_DAY = parsePositiveInt(
  process.env["INGESTION_QUOTA_PER_DAY"],
  5000,
);
const INGESTION_BODY_LIMIT_BYTES = parsePositiveInt(
  process.env["INGESTION_BODY_LIMIT_BYTES"],
  10 * 1024 * 1024,
);

const ingestionParamsSchema = z.object({
  workspaceId: uuidSchema,
  ingestionId: uuidSchema,
});

const listIngestionsQuerySchema = paginationSchema.extend({
  status: z.enum(INGESTION_STATUSES).optional(),
});

const applyBodySchema = z.object({
  decisionId: uuidSchema,
  approved: z.boolean(),
});

function mapDecisionDto(row: IngestionDecision) {
  return {
    id: row.id,
    ingestionId: row.ingestionId,
    targetPageId: row.targetPageId,
    proposedRevisionId: row.proposedRevisionId,
    modelRunId: row.modelRunId,
    action: row.action,
    status: row.status,
    proposedPageTitle: row.proposedPageTitle,
    confidence: row.confidence,
    rationale: row.rationaleJson,
    createdAt: row.createdAt.toISOString(),
  };
}

const ingestionRoutes: FastifyPluginAsync = async (fastify) => {
  // POST / — Submit a new ingestion (JWT auth, returns 202)
  fastify.post(
    "/",
    {
      onRequest: [fastify.authenticate],
      bodyLimit: INGESTION_BODY_LIMIT_BYTES,
    },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      if (!params.success) return sendValidationError(reply, params.error.issues);

      const body = createIngestionSchema.safeParse(request.body);
      if (!body.success) return sendValidationError(reply, body.error.issues);

      const { workspaceId } = params.data;
      const userId = request.user.sub;

      const [role, [token]] = await Promise.all([
        getMemberRole(fastify.db, workspaceId, userId),
        fastify.db
          .select({ id: apiTokens.id })
          .from(apiTokens)
          .where(
            and(
              eq(apiTokens.workspaceId, workspaceId),
              eq(apiTokens.createdByUserId, userId),
              sql`${apiTokens.revokedAt} IS NULL`,
            ),
          )
          .limit(1),
      ]);

      if (!role) return forbidden(reply);
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      if (!token) {
        return reply.code(400).send({
          error: "No API token",
          code: ERROR_CODES.NO_API_TOKEN,
          details:
            "You need at least one active API token in this workspace to submit ingestions",
        });
      }

      const tokenRate = await consumeRateLimit(fastify.redis, {
        key: `ingest:token:${token.id}`,
        limit: INGESTION_RATE_PER_MIN,
        windowSec: 60,
      });
      if (!tokenRate.allowed) {
        return sendRateLimitExceeded(
          reply,
          tokenRate,
          ERROR_CODES.RATE_LIMIT_EXCEEDED,
          `Token is limited to ${INGESTION_RATE_PER_MIN} ingestions per minute. Retry after ${tokenRate.resetSec}s.`,
        );
      }

      const workspaceQuota = await consumeRateLimit(fastify.redis, {
        key: `ingest:workspace:${workspaceId}`,
        limit: INGESTION_QUOTA_PER_DAY,
        windowSec: 86400,
      });
      if (!workspaceQuota.allowed) {
        return sendRateLimitExceeded(
          reply,
          workspaceQuota,
          ERROR_CODES.INGESTION_QUOTA_EXCEEDED,
          `Workspace exceeded ${INGESTION_QUOTA_PER_DAY} ingestions for today. Resets in ${workspaceQuota.resetSec}s.`,
        );
      }

      const { ingestion: ingestionRow, replayed } = await enqueueIngestion(
        fastify,
        {
          workspaceId,
          userId,
          apiTokenId: token.id,
          sourceName: body.data.sourceName,
          externalRef: body.data.externalRef,
          idempotencyKey: body.data.idempotencyKey,
          contentType: body.data.contentType,
          titleHint: body.data.titleHint,
          rawPayload: body.data.rawPayload,
        },
      );

      return reply.code(replayed ? 200 : 202).send(mapIngestionDto(ingestionRow));
    },
  );

  await registerImportRoutes(fastify);

  // GET / — List ingestions (paginated, filterable)
  fastify.get(
    "/",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      if (!params.success) return sendValidationError(reply, params.error.issues);

      const query = listIngestionsQuerySchema.safeParse(request.query);
      if (!query.success) return sendValidationError(reply, query.error.issues);

      const { workspaceId } = params.data;
      const userId = request.user.sub;

      const role = await getMemberRole(fastify.db, workspaceId, userId);
      if (!role) return forbidden(reply);

      const { limit, offset, status } = query.data;

      const conditions = [eq(ingestions.workspaceId, workspaceId)];
      if (status) conditions.push(eq(ingestions.status, status));
      const where = and(...conditions);

      const [rows, [total]] = await Promise.all([
        fastify.db
          .select({
            id: ingestions.id,
            workspaceId: ingestions.workspaceId,
            apiTokenId: ingestions.apiTokenId,
            sourceName: ingestions.sourceName,
            externalRef: ingestions.externalRef,
            idempotencyKey: ingestions.idempotencyKey,
            contentType: ingestions.contentType,
            titleHint: ingestions.titleHint,
            status: ingestions.status,
            receivedAt: ingestions.receivedAt,
            processedAt: ingestions.processedAt,
          })
          .from(ingestions)
          .where(where)
          .orderBy(desc(ingestions.receivedAt))
          .limit(limit)
          .offset(offset),
        fastify.db
          .select({ count: count() })
          .from(ingestions)
          .where(where),
      ]);

      return reply.send({
        items: rows.map(mapIngestionDto),
        total: total.count,
        limit,
        offset,
      });
    },
  );

  // GET /:ingestionId — Get ingestion with decisions
  fastify.get(
    "/:ingestionId",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = ingestionParamsSchema.safeParse(request.params);
      if (!params.success) return sendValidationError(reply, params.error.issues);

      const { workspaceId, ingestionId } = params.data;
      const userId = request.user.sub;

      const role = await getMemberRole(fastify.db, workspaceId, userId);
      if (!role) return forbidden(reply);

      const [row] = await fastify.db
        .select()
        .from(ingestions)
        .where(
          and(
            eq(ingestions.id, ingestionId),
            eq(ingestions.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      if (!row) {
        return reply.code(404).send({
          error: "Not found",
          code: ERROR_CODES.NOT_FOUND,
          details: "Ingestion not found",
        });
      }

      const decisions = await fastify.db
        .select()
        .from(ingestionDecisions)
        .where(eq(ingestionDecisions.ingestionId, ingestionId))
        .orderBy(desc(ingestionDecisions.createdAt));

      return reply.send({
        ...mapIngestionDto(row),
        rawPayload: row.rawPayload,
        normalizedText: row.normalizedText,
        decisions: decisions.map(mapDecisionDto),
      });
    },
  );

  // POST /:ingestionId/apply — Manually apply or reject a decision
  fastify.post(
    "/:ingestionId/apply",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = ingestionParamsSchema.safeParse(request.params);
      if (!params.success) return sendValidationError(reply, params.error.issues);

      const body = applyBodySchema.safeParse(request.body);
      if (!body.success) return sendValidationError(reply, body.error.issues);

      const { workspaceId, ingestionId } = params.data;
      const { decisionId, approved } = body.data;
      const userId = request.user.sub;

      const role = await getMemberRole(fastify.db, workspaceId, userId);
      if (!role) return forbidden(reply);
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const [decision] = await fastify.db
        .select({
          id: ingestionDecisions.id,
          ingestionId: ingestionDecisions.ingestionId,
          targetPageId: ingestionDecisions.targetPageId,
          proposedRevisionId: ingestionDecisions.proposedRevisionId,
          modelRunId: ingestionDecisions.modelRunId,
          action: ingestionDecisions.action,
          status: ingestionDecisions.status,
          proposedPageTitle: ingestionDecisions.proposedPageTitle,
          confidence: ingestionDecisions.confidence,
          rationaleJson: ingestionDecisions.rationaleJson,
          createdAt: ingestionDecisions.createdAt,
        })
        .from(ingestionDecisions)
        .innerJoin(ingestions, eq(ingestions.id, ingestionDecisions.ingestionId))
        .where(
          and(
            eq(ingestionDecisions.id, decisionId),
            eq(ingestionDecisions.ingestionId, ingestionId),
            eq(ingestions.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      if (!decision) {
        return reply.code(404).send({
          error: "Not found",
          code: ERROR_CODES.NOT_FOUND,
          details: "Decision not found",
        });
      }

      const ctx = {
        db: fastify.db,
        extractionQueue: fastify.queues.extraction,
        workspaceId,
        decision,
        userId,
      };

      if (!approved) {
        return reply.send(await rejectDecision(ctx));
      }

      const result = await approveDecision(ctx);
      if ("code" in result) {
        return reply.code(result.statusCode).send({
          error: "Apply failed",
          code: result.code,
          details: result.details,
        });
      }
      return reply.send(result);
    },
  );
};

export default ingestionRoutes;
