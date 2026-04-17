import type { FastifyPluginAsync } from "fastify";
import { eq, and, desc, count, sql } from "drizzle-orm";
import { z } from "zod";
import {
  createIngestionSchema,
  uuidSchema,
  paginationSchema,
  extractIngestionText,
  computeDiff,
  slugify,
  INGESTION_STATUSES,
  JOB_NAMES,
  DEFAULT_JOB_OPTIONS,
  ERROR_CODES,
} from "@nexnote/shared";
import type { RouteClassifierJobData, TripleExtractorJobData } from "@nexnote/shared";
import {
  ingestions,
  ingestionDecisions,
  apiTokens,
  pages,
  pageRevisions,
  revisionDiffs,
  auditLogs,
} from "@nexnote/db";
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
  isUniqueViolation,
} from "../../lib/reply-helpers.js";

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

function mapIngestionDto(row: {
  id: string;
  workspaceId: string;
  apiTokenId: string;
  sourceName: string;
  externalRef: string | null;
  idempotencyKey: string;
  contentType: string;
  titleHint: string | null;
  status: string;
  receivedAt: Date;
  processedAt: Date | null;
}) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    apiTokenId: row.apiTokenId,
    sourceName: row.sourceName,
    externalRef: row.externalRef,
    idempotencyKey: row.idempotencyKey,
    contentType: row.contentType,
    titleHint: row.titleHint,
    status: row.status,
    receivedAt: row.receivedAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
  };
}

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
    { onRequest: [fastify.authenticate] },
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

      let ingestionRow;
      try {
        [ingestionRow] = await fastify.db
          .insert(ingestions)
          .values({
            workspaceId,
            apiTokenId: token.id,
            sourceName: body.data.sourceName,
            externalRef: body.data.externalRef ?? null,
            idempotencyKey: body.data.idempotencyKey,
            contentType: body.data.contentType,
            titleHint: body.data.titleHint ?? null,
            rawPayload: body.data.rawPayload,
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
                eq(ingestions.workspaceId, workspaceId),
                eq(ingestions.idempotencyKey, body.data.idempotencyKey),
              ),
            )
            .limit(1);
          if (existing) {
            return reply.code(200).send(mapIngestionDto(existing));
          }
        }
        throw err;
      }

      await fastify.db.insert(auditLogs).values({
        workspaceId,
        userId,
        entityType: "ingestion",
        entityId: ingestionRow.id,
        action: "create",
        afterJson: {
          sourceName: body.data.sourceName,
          idempotencyKey: body.data.idempotencyKey,
        },
      });

      const jobData: RouteClassifierJobData = {
        ingestionId: ingestionRow.id,
        workspaceId,
      };
      await fastify.queues.ingestion.add(
        JOB_NAMES.ROUTE_CLASSIFIER,
        jobData,
        { jobId: ingestionRow.id, ...DEFAULT_JOB_OPTIONS },
      );

      return reply.code(202).send(mapIngestionDto(ingestionRow));
    },
  );

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

      // Fetch ingestion + decision in parallel
      const [[ingestion], [decision]] = await Promise.all([
        fastify.db
          .select({
            id: ingestions.id,
            sourceName: ingestions.sourceName,
            titleHint: ingestions.titleHint,
            normalizedText: ingestions.normalizedText,
            rawPayload: ingestions.rawPayload,
          })
          .from(ingestions)
          .where(
            and(
              eq(ingestions.id, ingestionId),
              eq(ingestions.workspaceId, workspaceId),
            ),
          )
          .limit(1),
        fastify.db
          .select()
          .from(ingestionDecisions)
          .where(
            and(
              eq(ingestionDecisions.id, decisionId),
              eq(ingestionDecisions.ingestionId, ingestionId),
            ),
          )
          .limit(1),
      ]);

      if (!ingestion) {
        return reply.code(404).send({
          error: "Not found",
          code: ERROR_CODES.NOT_FOUND,
          details: "Ingestion not found",
        });
      }
      if (!decision) {
        return reply.code(404).send({
          error: "Not found",
          code: ERROR_CODES.NOT_FOUND,
          details: "Decision not found",
        });
      }

      if (!approved) {
        await Promise.all([
          fastify.db
            .update(ingestionDecisions)
            .set({ status: "rejected" })
            .where(eq(ingestionDecisions.id, decisionId)),
          fastify.db
            .update(ingestions)
            .set({ status: "completed", processedAt: new Date() })
            .where(eq(ingestions.id, ingestionId)),
          fastify.db.insert(auditLogs).values({
            workspaceId,
            userId,
            entityType: "ingestion",
            entityId: ingestionId,
            action: "reject",
            beforeJson: { decisionId, decisionAction: decision.action },
          }),
        ]);

        return reply.send({ status: "rejected", ingestionId });
      }

      if (decision.action === "create") {
        const title =
          decision.proposedPageTitle ??
          ingestion.titleHint ??
          "Untitled (ingested)";
        const slug = slugify(title);
        const contentMd = extractIngestionText(ingestion);

        const [page] = await fastify.db
          .insert(pages)
          .values({ workspaceId, title, slug, status: "draft" })
          .returning();

        const [revision] = await fastify.db
          .insert(pageRevisions)
          .values({
            pageId: page.id,
            actorType: "system",
            source: "ingest_api",
            sourceIngestionId: ingestionId,
            sourceDecisionId: decisionId,
            contentMd,
            revisionNote: `Auto-created from ingestion ${ingestion.sourceName}`,
          })
          .returning();

        await Promise.all([
          fastify.db
            .update(pages)
            .set({ currentRevisionId: revision.id })
            .where(eq(pages.id, page.id)),
          fastify.db
            .update(ingestionDecisions)
            .set({
              targetPageId: page.id,
              proposedRevisionId: revision.id,
              status: "approved",
            })
            .where(eq(ingestionDecisions.id, decisionId)),
          fastify.db
            .update(ingestions)
            .set({ status: "completed", processedAt: new Date() })
            .where(eq(ingestions.id, ingestionId)),
          fastify.db.insert(auditLogs).values({
            workspaceId,
            userId,
            entityType: "page",
            entityId: page.id,
            action: "create",
            afterJson: { source: "ingestion_apply", ingestionId, decisionId },
          }),
        ]);

        // Enqueue triple extraction for the new page
        const createTripleData: TripleExtractorJobData = {
          pageId: page.id,
          revisionId: revision.id,
          workspaceId,
        };
        await fastify.queues.extraction.add(
          JOB_NAMES.TRIPLE_EXTRACTOR,
          createTripleData,
          DEFAULT_JOB_OPTIONS,
        );

        return reply.send({
          status: "applied",
          action: "create",
          ingestionId,
          pageId: page.id,
          revisionId: revision.id,
        });
      }

      if (decision.action === "update" || decision.action === "append") {
        if (!decision.targetPageId) {
          return reply.code(400).send({
            error: "Missing target",
            code: ERROR_CODES.MISSING_TARGET_PAGE,
            details: "Decision requires a targetPageId for update/append",
          });
        }

        let revisionId: string;

        if (decision.proposedRevisionId) {
          revisionId = decision.proposedRevisionId;
          await Promise.all([
            fastify.db
              .update(pages)
              .set({
                currentRevisionId: decision.proposedRevisionId,
                updatedAt: new Date(),
              })
              .where(eq(pages.id, decision.targetPageId)),
            fastify.db
              .update(ingestionDecisions)
              .set({ status: "approved" })
              .where(eq(ingestionDecisions.id, decisionId)),
          ]);
        } else {
          const [currentPage] = await fastify.db
            .select({ currentRevisionId: pages.currentRevisionId })
            .from(pages)
            .where(eq(pages.id, decision.targetPageId))
            .limit(1);

          let existingContent = "";
          if (currentPage?.currentRevisionId) {
            const [rev] = await fastify.db
              .select({ contentMd: pageRevisions.contentMd })
              .from(pageRevisions)
              .where(eq(pageRevisions.id, currentPage.currentRevisionId))
              .limit(1);
            if (rev) existingContent = rev.contentMd;
          }

          const incomingText = extractIngestionText(ingestion);

          const newContent =
            decision.action === "append"
              ? `${existingContent}\n\n${incomingText}`
              : incomingText;

          const [revision] = await fastify.db
            .insert(pageRevisions)
            .values({
              pageId: decision.targetPageId,
              baseRevisionId: currentPage?.currentRevisionId ?? null,
              actorType: "system",
              source: "ingest_api",
              sourceIngestionId: ingestionId,
              sourceDecisionId: decisionId,
              contentMd: newContent,
              revisionNote: `Applied ${decision.action} from ingestion ${ingestion.sourceName}`,
            })
            .returning();

          revisionId = revision.id;

          // Compute and store revision diff
          const diff = computeDiff(existingContent, newContent, null, null);
          await fastify.db.insert(revisionDiffs).values({
            revisionId: revision.id,
            diffMd: diff.diffMd,
            diffOpsJson: diff.diffOpsJson,
            changedBlocks: diff.changedBlocks,
          });

          await Promise.all([
            fastify.db
              .update(pages)
              .set({ currentRevisionId: revision.id, updatedAt: new Date() })
              .where(eq(pages.id, decision.targetPageId)),
            fastify.db
              .update(ingestionDecisions)
              .set({ proposedRevisionId: revision.id, status: "approved" })
              .where(eq(ingestionDecisions.id, decisionId)),
          ]);
        }

        // Enqueue triple extraction for the new/applied revision
        const tripleData: TripleExtractorJobData = {
          pageId: decision.targetPageId,
          revisionId,
          workspaceId,
        };
        await fastify.queues.extraction.add(
          JOB_NAMES.TRIPLE_EXTRACTOR,
          tripleData,
          DEFAULT_JOB_OPTIONS,
        );

        await Promise.all([
          fastify.db
            .update(ingestions)
            .set({ status: "completed", processedAt: new Date() })
            .where(eq(ingestions.id, ingestionId)),
          fastify.db.insert(auditLogs).values({
            workspaceId,
            userId,
            entityType: "page",
            entityId: decision.targetPageId,
            action: decision.action,
            afterJson: { source: "ingestion_apply", ingestionId, decisionId, revisionId },
          }),
        ]);

        return reply.send({
          status: "applied",
          action: decision.action,
          ingestionId,
          pageId: decision.targetPageId,
          revisionId,
        });
      }

      // noop or needs_review acknowledged by the human — close out the decision
      // with a status matching the AI's action so the review queue stops showing it.
      const acknowledgedStatus =
        decision.action === "noop" ? "noop" : "rejected";
      await Promise.all([
        fastify.db
          .update(ingestionDecisions)
          .set({ status: acknowledgedStatus })
          .where(eq(ingestionDecisions.id, decisionId)),
        fastify.db
          .update(ingestions)
          .set({ status: "completed", processedAt: new Date() })
          .where(eq(ingestions.id, ingestionId)),
        fastify.db.insert(auditLogs).values({
          workspaceId,
          userId,
          entityType: "ingestion",
          entityId: ingestionId,
          action: "acknowledge",
          beforeJson: { decisionId, decisionAction: decision.action },
        }),
      ]);

      return reply.send({
        status: "acknowledged",
        action: decision.action,
        ingestionId,
      });
    },
  );
};

export default ingestionRoutes;
