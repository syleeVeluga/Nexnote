import type { FastifyPluginAsync } from "fastify";
import type { Queue } from "bullmq";
import {
  eq,
  and,
  or,
  desc,
  inArray,
  notInArray,
  sql,
  gte,
  isNull,
  isNotNull,
} from "drizzle-orm";
import { z } from "zod";
import {
  uuidSchema,
  paginationSchema,
  DECISION_STATUSES,
  INGESTION_ACTIONS,
  ERROR_CODES,
  computeDiff,
  JOB_NAMES,
  DEFAULT_JOB_OPTIONS,
} from "@wekiflow/shared";
import {
  ingestions,
  ingestionDecisions,
  pageRedirects,
  pages,
  pageRevisions,
  revisionDiffs,
  auditLogs,
} from "@wekiflow/db";
import type { Database, IngestionDecision } from "@wekiflow/db";
import {
  getMemberRole,
  forbidden,
  insufficientRole,
  EDITOR_PLUS_ROLES,
  workspaceParamsSchema,
} from "../../lib/workspace-auth.js";
import { sendValidationError } from "../../lib/reply-helpers.js";
import { approveDecision, rejectDecision } from "../../lib/apply-decision.js";
import {
  PageDeletionError,
  collectDescendantPageIds,
  softDeleteSubtree,
  restoreSubtree,
  restoreSubtreeInTransaction,
  sqlUuidList,
} from "../../lib/page-deletion.js";
import {
  mapDecisionListItem,
  type DecisionListRow,
} from "../../lib/decision-dto.js";

const decisionParamsSchema = z.object({
  workspaceId: uuidSchema,
  decisionId: uuidSchema,
});

const listQuerySchema = paginationSchema.extend({
  status: z
    .union([
      z.enum(DECISION_STATUSES),
      z
        .string()
        .transform((s) => s.split(",").map((t) => t.trim()))
        .pipe(z.array(z.enum(DECISION_STATUSES))),
    ])
    .optional(),
  origin: z.enum(["ingestion", "scheduled"]).optional(),
  // "recent" tab wants auto_applied from the last N days
  sinceDays: z.coerce.number().int().min(1).max(365).optional(),
});

const rejectBodySchema = z.object({
  reason: z.string().min(1).max(1000).optional(),
});

const proposedRevisionBodySchema = z.object({
  contentMd: z.string().min(1).max(500_000),
});

const RESOLVED_STATUSES: readonly string[] = [
  "approved",
  "rejected",
  "auto_applied",
  "undone",
  "noop",
];

const editBodySchema = z
  .object({
    action: z.enum(INGESTION_ACTIONS).optional(),
    targetPageId: uuidSchema.nullable().optional(),
    proposedPageTitle: z.string().min(1).max(500).nullable().optional(),
  })
  .refine(
    (data) =>
      data.action !== undefined ||
      data.targetPageId !== undefined ||
      data.proposedPageTitle !== undefined,
    { message: "At least one field must be provided" },
  );

const decisionRoutes: FastifyPluginAsync = async (fastify) => {
  // GET / — list decisions for the workspace (filterable by status + sinceDays)
  fastify.get(
    "/",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      if (!params.success)
        return sendValidationError(reply, params.error.issues);

      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) return sendValidationError(reply, query.error.issues);

      const { workspaceId } = params.data;
      const userId = request.user.sub;

      const role = await getMemberRole(fastify.db, workspaceId, userId);
      if (!role) return forbidden(reply);

      const { limit, offset, status, origin, sinceDays } = query.data;

      const conditions = [eq(ingestions.workspaceId, workspaceId)];
      if (status) {
        const statuses = Array.isArray(status) ? status : [status];
        conditions.push(
          statuses.length === 1
            ? eq(ingestionDecisions.status, statuses[0])
            : inArray(ingestionDecisions.status, statuses),
        );
      }
      if (sinceDays) {
        const since = new Date(Date.now() - sinceDays * 86400_000);
        conditions.push(gte(ingestionDecisions.createdAt, since));
      }
      if (origin === "scheduled") {
        conditions.push(isNotNull(ingestionDecisions.scheduledRunId));
      } else if (origin === "ingestion") {
        conditions.push(isNull(ingestionDecisions.scheduledRunId));
      }
      conditions.push(
        or(
          and(
            isNotNull(ingestionDecisions.targetPageId),
            isNull(pages.deletedAt),
          ),
          and(
            isNull(ingestionDecisions.targetPageId),
            notInArray(ingestionDecisions.status, ["auto_applied", "approved"]),
          ),
          and(
            inArray(ingestionDecisions.action, ["delete", "merge"]),
            inArray(ingestionDecisions.status, ["approved", "undone"]),
          ),
          eq(ingestionDecisions.status, "undone"),
        )!,
      );
      const where = and(...conditions);

      const [rows, [totalRow]] = await Promise.all([
        fastify.db
          .select({
            id: ingestionDecisions.id,
            ingestionId: ingestionDecisions.ingestionId,
            targetPageId: ingestionDecisions.targetPageId,
            proposedRevisionId: ingestionDecisions.proposedRevisionId,
            modelRunId: ingestionDecisions.modelRunId,
            scheduledRunId: ingestionDecisions.scheduledRunId,
            action: ingestionDecisions.action,
            status: ingestionDecisions.status,
            proposedPageTitle: ingestionDecisions.proposedPageTitle,
            confidence: ingestionDecisions.confidence,
            rationaleJson: ingestionDecisions.rationaleJson,
            createdAt: ingestionDecisions.createdAt,
            ingestionSourceName: ingestions.sourceName,
            ingestionTitleHint: ingestions.titleHint,
            ingestionReceivedAt: ingestions.receivedAt,
            targetPageTitle: pages.title,
            targetPageSlug: pages.slug,
          })
          .from(ingestionDecisions)
          .innerJoin(
            ingestions,
            eq(ingestions.id, ingestionDecisions.ingestionId),
          )
          .leftJoin(pages, eq(pages.id, ingestionDecisions.targetPageId))
          .where(where)
          .orderBy(desc(ingestionDecisions.createdAt))
          .limit(limit)
          .offset(offset),
        fastify.db
          .select({ count: sql<number>`count(*)::int` })
          .from(ingestionDecisions)
          .innerJoin(
            ingestions,
            eq(ingestions.id, ingestionDecisions.ingestionId),
          )
          .leftJoin(pages, eq(pages.id, ingestionDecisions.targetPageId))
          .where(where),
      ]);

      return reply.send({
        data: rows.map((r) => mapDecisionListItem(r as DecisionListRow)),
        total: totalRow.count,
        limit,
        offset,
      });
    },
  );

  // GET /counts — per-status counts for sidebar badges and tabs
  fastify.get(
    "/counts",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      if (!params.success)
        return sendValidationError(reply, params.error.issues);

      const { workspaceId } = params.data;
      const userId = request.user.sub;

      const role = await getMemberRole(fastify.db, workspaceId, userId);
      if (!role) return forbidden(reply);

      const rows = await fastify.db
        .select({
          status: ingestionDecisions.status,
          count: sql<number>`count(*)::int`,
        })
        .from(ingestionDecisions)
        .innerJoin(
          ingestions,
          eq(ingestions.id, ingestionDecisions.ingestionId),
        )
        .leftJoin(pages, eq(pages.id, ingestionDecisions.targetPageId))
        .where(
          and(
            eq(ingestions.workspaceId, workspaceId),
            or(
              and(
                isNotNull(ingestionDecisions.targetPageId),
                isNull(pages.deletedAt),
              ),
              and(
                isNull(ingestionDecisions.targetPageId),
                notInArray(ingestionDecisions.status, [
                  "auto_applied",
                  "approved",
                ]),
              ),
              and(
                inArray(ingestionDecisions.action, ["delete", "merge"]),
                inArray(ingestionDecisions.status, ["approved", "undone"]),
              ),
              eq(ingestionDecisions.status, "undone"),
            ),
          ),
        )
        .groupBy(ingestionDecisions.status);

      const counts: Record<string, number> = {};
      for (const s of DECISION_STATUSES) counts[s] = 0;
      for (const r of rows) counts[r.status] = r.count;

      // Pending = what a reviewer still needs to act on.
      counts.pending = counts.suggested + counts.needs_review + counts.failed;

      return reply.send({ counts });
    },
  );

  // GET /:decisionId — full detail (ingestion payload, proposed revision + diff)
  fastify.get(
    "/:decisionId",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = decisionParamsSchema.safeParse(request.params);
      if (!params.success)
        return sendValidationError(reply, params.error.issues);

      const { workspaceId, decisionId } = params.data;
      const userId = request.user.sub;

      const role = await getMemberRole(fastify.db, workspaceId, userId);
      if (!role) return forbidden(reply);

      const [row] = await fastify.db
        .select({
          id: ingestionDecisions.id,
          ingestionId: ingestionDecisions.ingestionId,
          targetPageId: ingestionDecisions.targetPageId,
          proposedRevisionId: ingestionDecisions.proposedRevisionId,
          modelRunId: ingestionDecisions.modelRunId,
          scheduledRunId: ingestionDecisions.scheduledRunId,
          action: ingestionDecisions.action,
          status: ingestionDecisions.status,
          proposedPageTitle: ingestionDecisions.proposedPageTitle,
          confidence: ingestionDecisions.confidence,
          rationaleJson: ingestionDecisions.rationaleJson,
          createdAt: ingestionDecisions.createdAt,
          ingestionSourceName: ingestions.sourceName,
          ingestionTitleHint: ingestions.titleHint,
          ingestionReceivedAt: ingestions.receivedAt,
          ingestionNormalizedText: ingestions.normalizedText,
          ingestionRawPayload: ingestions.rawPayload,
          ingestionContentType: ingestions.contentType,
          ingestionExternalRef: ingestions.externalRef,
          ingestionStorageKey: ingestions.storageKey,
          ingestionStorageBytes: ingestions.storageBytes,
          targetPageTitle: pages.title,
          targetPageSlug: pages.slug,
        })
        .from(ingestionDecisions)
        .innerJoin(
          ingestions,
          eq(ingestions.id, ingestionDecisions.ingestionId),
        )
        .leftJoin(pages, eq(pages.id, ingestionDecisions.targetPageId))
        .where(
          and(
            eq(ingestionDecisions.id, decisionId),
            eq(ingestions.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      if (!row) {
        return reply.code(404).send({
          error: "Not found",
          code: ERROR_CODES.NOT_FOUND,
          details: "Decision not found",
        });
      }

      let proposedDiffMd: string | null = null;
      let proposedChangedBlocks: number | null = null;
      let proposedContentMd: string | null = null;
      if (row.proposedRevisionId) {
        const [rev] = await fastify.db
          .select({
            contentMd: pageRevisions.contentMd,
            diffMd: revisionDiffs.diffMd,
            changedBlocks: revisionDiffs.changedBlocks,
          })
          .from(pageRevisions)
          .leftJoin(
            revisionDiffs,
            eq(revisionDiffs.revisionId, pageRevisions.id),
          )
          .where(eq(pageRevisions.id, row.proposedRevisionId))
          .limit(1);
        if (rev) {
          proposedContentMd = rev.contentMd;
          proposedDiffMd = rev.diffMd ?? null;
          proposedChangedBlocks = rev.changedBlocks ?? null;
        }
      }

      const rationale = row.rationaleJson as {
        reason?: string;
        candidates?: Array<{
          id: string;
          title: string;
          slug: string;
          matchSources?: string[];
        }>;
        baseRevisionId?: string | null;
        conflict?: {
          type: "conflict_with_human_edit";
          humanRevisionId: string;
          humanUserId: string | null;
          humanEditedAt: string;
          humanRevisionNote: string | null;
          baseRevisionId: string | null;
        };
      } | null;

      return reply.send({
        id: row.id,
        ingestionId: row.ingestionId,
        targetPageId: row.targetPageId,
        proposedRevisionId: row.proposedRevisionId,
        modelRunId: row.modelRunId,
        scheduledRunId: row.scheduledRunId,
        origin: row.scheduledRunId ? "scheduled" : "ingestion",
        action: row.action,
        status: row.status,
        proposedPageTitle: row.proposedPageTitle,
        confidence: row.confidence,
        reason: rationale?.reason ?? null,
        rationale: row.rationaleJson ?? null,
        candidates: rationale?.candidates ?? [],
        conflict: rationale?.conflict ?? null,
        createdAt: row.createdAt.toISOString(),
        ingestion: {
          id: row.ingestionId,
          sourceName: row.ingestionSourceName,
          titleHint: row.ingestionTitleHint,
          receivedAt: row.ingestionReceivedAt.toISOString(),
          normalizedText: row.ingestionNormalizedText,
          rawPayload: row.ingestionRawPayload,
          contentType: row.ingestionContentType,
          externalRef: row.ingestionExternalRef,
          hasOriginal: Boolean(row.ingestionStorageKey),
          originalSizeBytes: row.ingestionStorageBytes ?? null,
        },
        targetPage:
          row.targetPageId && row.targetPageTitle
            ? {
                id: row.targetPageId,
                title: row.targetPageTitle,
                slug: row.targetPageSlug,
              }
            : null,
        proposedRevision:
          row.proposedRevisionId && proposedContentMd !== null
            ? {
                id: row.proposedRevisionId,
                contentMd: proposedContentMd,
                diffMd: proposedDiffMd,
                changedBlocks: proposedChangedBlocks,
              }
            : null,
      });
    },
  );

  // POST /:decisionId/approve — run patch-generator-equivalent + write revision
  fastify.post(
    "/:decisionId/approve",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = decisionParamsSchema.safeParse(request.params);
      if (!params.success)
        return sendValidationError(reply, params.error.issues);

      const { workspaceId, decisionId } = params.data;
      const userId = request.user.sub;

      const role = await getMemberRole(fastify.db, workspaceId, userId);
      if (!role) return forbidden(reply);
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const decision = await loadDecision(fastify.db, workspaceId, decisionId);
      if (!decision) {
        return reply.code(404).send({
          error: "Not found",
          code: ERROR_CODES.NOT_FOUND,
          details: "Decision not found",
        });
      }

      if (RESOLVED_STATUSES.includes(decision.status)) {
        return reply.code(409).send({
          error: "Already resolved",
          code: "DECISION_ALREADY_RESOLVED",
          details: `Decision is ${decision.status}`,
        });
      }

      const result = await approveDecision({
        db: fastify.db,
        extractionQueue: fastify.queues.extraction,
        searchQueue: fastify.queues.search,
        linkQueue: fastify.queues.links,
        workspaceId,
        decision,
        userId,
      });

      if ("code" in result) {
        return reply.code(result.statusCode).send({
          error: "Approve failed",
          code: result.code,
          details: result.details,
        });
      }

      return reply.send(result);
    },
  );

  // POST /:decisionId/reject — mark rejected with optional reason
  fastify.post(
    "/:decisionId/reject",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = decisionParamsSchema.safeParse(request.params);
      if (!params.success)
        return sendValidationError(reply, params.error.issues);

      const body = rejectBodySchema.safeParse(request.body ?? {});
      if (!body.success) return sendValidationError(reply, body.error.issues);

      const { workspaceId, decisionId } = params.data;
      const userId = request.user.sub;

      const role = await getMemberRole(fastify.db, workspaceId, userId);
      if (!role) return forbidden(reply);
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const decision = await loadDecision(fastify.db, workspaceId, decisionId);
      if (!decision) {
        return reply.code(404).send({
          error: "Not found",
          code: ERROR_CODES.NOT_FOUND,
          details: "Decision not found",
        });
      }

      if (RESOLVED_STATUSES.includes(decision.status)) {
        return reply.code(409).send({
          error: "Already resolved",
          code: "DECISION_ALREADY_RESOLVED",
          details: `Decision is ${decision.status}`,
        });
      }

      const result = await rejectDecision({
        db: fastify.db,
        extractionQueue: fastify.queues.extraction,
        searchQueue: fastify.queues.search,
        linkQueue: fastify.queues.links,
        workspaceId,
        decision,
        userId,
        reason: body.data.reason ?? null,
      });

      return reply.send(result);
    },
  );

  // POST /:decisionId/undo - revert an auto-applied decision without overwriting history
  fastify.post(
    "/:decisionId/undo",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = decisionParamsSchema.safeParse(request.params);
      if (!params.success)
        return sendValidationError(reply, params.error.issues);

      const { workspaceId, decisionId } = params.data;
      const userId = request.user.sub;

      const role = await getMemberRole(fastify.db, workspaceId, userId);
      if (!role) return forbidden(reply);
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const decision = await loadDecision(fastify.db, workspaceId, decisionId);
      if (!decision) {
        return reply.code(404).send({
          error: "Not found",
          code: ERROR_CODES.NOT_FOUND,
          details: "Decision not found",
        });
      }

      const canUndoAutoApplied = decision.status === "auto_applied";
      const canUndoApprovedDestructive =
        decision.status === "approved" &&
        (decision.action === "delete" || decision.action === "merge");
      if (!canUndoAutoApplied && !canUndoApprovedDestructive) {
        return reply.code(409).send({
          error: "Undo unsupported",
          code: ERROR_CODES.DECISION_UNDO_UNSUPPORTED,
          details:
            "Only auto_applied decisions or approved delete/merge decisions can be undone.",
        });
      }

      if (
        decision.action !== "create" &&
        decision.action !== "update" &&
        decision.action !== "append" &&
        decision.action !== "delete" &&
        decision.action !== "merge"
      ) {
        return reply.code(409).send({
          error: "Undo unsupported",
          code: ERROR_CODES.DECISION_UNDO_UNSUPPORTED,
          details: `Decision action ${decision.action} has no page change to undo.`,
        });
      }

      if (decision.action === "delete") {
        if (!decision.targetPageId) {
          return reply.code(409).send({
            error: "Undo unsupported",
            code: ERROR_CODES.DECISION_UNDO_UNSUPPORTED,
            details: "Decision is missing the deleted page.",
          });
        }
        const response = await undoDeleteDecision({
          db: fastify.db,
          workspaceId,
          decision,
          userId,
        });
        if ("error" in response) {
          return reply.code(response.statusCode).send({
            error: response.error,
            code: response.code,
            details: response.details,
            ...(response.extra ?? {}),
          });
        }
        return reply.send(response);
      }

      if (!decision.targetPageId || !decision.proposedRevisionId) {
        return reply.code(409).send({
          error: "Undo unsupported",
          code: ERROR_CODES.DECISION_UNDO_UNSUPPORTED,
          details: "Decision is missing the applied page or revision.",
        });
      }

      if (decision.action === "merge") {
        const response = await undoMergeDecision({
          db: fastify.db,
          extractionQueue: fastify.queues.extraction,
          searchQueue: fastify.queues.search,
          linkQueue: fastify.queues.links,
          workspaceId,
          decision,
          userId,
        });
        if ("error" in response) {
          return reply.code(response.statusCode).send({
            error: response.error,
            code: response.code,
            details: response.details,
            ...(response.extra ?? {}),
          });
        }
        return reply.send(response);
      }

      if (decision.action === "create") {
        const response = await undoCreateDecision({
          db: fastify.db,
          workspaceId,
          decision,
          userId,
        });
        if ("error" in response) {
          return reply.code(response.statusCode).send({
            error: response.error,
            code: response.code,
            details: response.details,
            ...(response.extra ?? {}),
          });
        }
        return reply.send(response);
      }

      const response = await undoRevisionDecision({
        db: fastify.db,
        extractionQueue: fastify.queues.extraction,
        searchQueue: fastify.queues.search,
        linkQueue: fastify.queues.links,
        workspaceId,
        decision,
        userId,
      });
      if ("error" in response) {
        return reply.code(response.statusCode).send({
          error: response.error,
          code: response.code,
          details: response.details,
          ...(response.extra ?? {}),
        });
      }
      return reply.send(response);
    },
  );

  // PATCH /:decisionId — edit action/targetPageId/proposedPageTitle before approving
  fastify.patch(
    "/:decisionId/proposed-revision",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = decisionParamsSchema.safeParse(request.params);
      if (!params.success)
        return sendValidationError(reply, params.error.issues);

      const body = proposedRevisionBodySchema.safeParse(request.body ?? {});
      if (!body.success) return sendValidationError(reply, body.error.issues);

      const { workspaceId, decisionId } = params.data;
      const userId = request.user.sub;

      const role = await getMemberRole(fastify.db, workspaceId, userId);
      if (!role) return forbidden(reply);
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const decision = await loadDecision(fastify.db, workspaceId, decisionId);
      if (!decision) {
        return reply.code(404).send({
          error: "Not found",
          code: ERROR_CODES.NOT_FOUND,
          details: "Decision not found",
        });
      }
      if (RESOLVED_STATUSES.includes(decision.status)) {
        return reply.code(409).send({
          error: "Already resolved",
          code: "DECISION_ALREADY_RESOLVED",
          details: `Decision is ${decision.status} - edits not allowed`,
        });
      }
      if (
        decision.action !== "merge" ||
        !decision.targetPageId ||
        !decision.proposedRevisionId
      ) {
        return reply.code(400).send({
          error: "Unsupported proposed revision edit",
          code: "PROPOSED_REVISION_EDIT_UNSUPPORTED",
          details:
            "Only pending merge decisions with a proposed revision can be edited.",
        });
      }

      try {
        const result = await fastify.db.transaction(async (tx) => {
          const [revision] = await tx
            .select({
              id: pageRevisions.id,
              pageId: pageRevisions.pageId,
              baseRevisionId: pageRevisions.baseRevisionId,
              contentMd: pageRevisions.contentMd,
            })
            .from(pageRevisions)
            .where(eq(pageRevisions.id, decision.proposedRevisionId!))
            .limit(1);
          if (!revision || revision.pageId !== decision.targetPageId) {
            throw new DecisionUndoRouteError(ERROR_CODES.REVISION_NOT_FOUND);
          }

          let baseContent = "";
          if (revision.baseRevisionId) {
            const [baseRevision] = await tx
              .select({ contentMd: pageRevisions.contentMd })
              .from(pageRevisions)
              .where(eq(pageRevisions.id, revision.baseRevisionId))
              .limit(1);
            baseContent = baseRevision?.contentMd ?? "";
          }

          const diff = computeDiff(baseContent, body.data.contentMd, null, null);
          const [newRevision] = await tx
            .insert(pageRevisions)
            .values({
              pageId: decision.targetPageId,
              baseRevisionId: revision.baseRevisionId,
              actorUserId: userId,
              actorType: "user",
              source: "review",
              sourceIngestionId: decision.ingestionId,
              sourceDecisionId: decision.id,
              contentMd: body.data.contentMd,
              revisionNote: "Reviewer edited merge preview",
            })
            .returning({ id: pageRevisions.id });

          await Promise.all([
            tx.insert(revisionDiffs).values({
              revisionId: newRevision.id,
              diffMd: diff.diffMd,
              diffOpsJson: diff.diffOpsJson,
              changedBlocks: diff.changedBlocks,
            }),
            tx
              .update(ingestionDecisions)
              .set({ proposedRevisionId: newRevision.id })
              .where(eq(ingestionDecisions.id, decision.id)),
          ]);

          await tx.insert(auditLogs).values({
            workspaceId,
            userId,
            entityType: "ingestion_decision",
            entityId: decision.id,
            action: "edit_merge_preview",
            beforeJson: {
              proposedRevisionId: revision.id,
              previousLength: revision.contentMd.length,
            },
            afterJson: {
              proposedRevisionId: newRevision.id,
              nextLength: body.data.contentMd.length,
            },
          });

          return {
            id: newRevision.id,
            contentMd: body.data.contentMd,
            diffMd: diff.diffMd,
            changedBlocks: diff.changedBlocks,
          };
        });

        return reply.send({ proposedRevision: result });
      } catch (err) {
        if (
          err instanceof DecisionUndoRouteError &&
          err.code === ERROR_CODES.REVISION_NOT_FOUND
        ) {
          return reply.code(404).send({
            error: "Not found",
            code: ERROR_CODES.REVISION_NOT_FOUND,
            details: "Proposed revision not found.",
          });
        }
        throw err;
      }
    },
  );

  fastify.patch(
    "/:decisionId",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = decisionParamsSchema.safeParse(request.params);
      if (!params.success)
        return sendValidationError(reply, params.error.issues);

      const body = editBodySchema.safeParse(request.body ?? {});
      if (!body.success) return sendValidationError(reply, body.error.issues);

      const { workspaceId, decisionId } = params.data;
      const userId = request.user.sub;

      const role = await getMemberRole(fastify.db, workspaceId, userId);
      if (!role) return forbidden(reply);
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const decision = await loadDecision(fastify.db, workspaceId, decisionId);
      if (!decision) {
        return reply.code(404).send({
          error: "Not found",
          code: ERROR_CODES.NOT_FOUND,
          details: "Decision not found",
        });
      }

      if (RESOLVED_STATUSES.includes(decision.status)) {
        return reply.code(409).send({
          error: "Already resolved",
          code: "DECISION_ALREADY_RESOLVED",
          details: `Decision is ${decision.status} — edits not allowed`,
        });
      }

      if (decision.action === "delete" || decision.action === "merge") {
        return reply.code(400).send({
          error: "Unsupported action override",
          code: "DESTRUCTIVE_DECISION_OVERRIDE_UNSUPPORTED",
          details:
            "delete/merge decisions can only be approved or rejected, not edited.",
        });
      }

      // Guard: if switching action to update/append, a targetPageId must exist or be provided.
      const nextAction = body.data.action ?? decision.action;
      const nextTargetPageId =
        body.data.targetPageId !== undefined
          ? body.data.targetPageId
          : decision.targetPageId;
      if (
        body.data.action === "delete" ||
        body.data.action === "merge"
      ) {
        return reply.code(400).send({
          error: "Unsupported action override",
          code: "DESTRUCTIVE_DECISION_OVERRIDE_UNSUPPORTED",
          details:
            "delete/merge decisions can only be created by Scheduled Agent and cannot be manually changed.",
        });
      }
      if (
        (nextAction === "update" || nextAction === "append") &&
        !nextTargetPageId
      ) {
        return reply.code(400).send({
          error: "Missing target",
          code: ERROR_CODES.MISSING_TARGET_PAGE,
          details: "update/append requires a targetPageId",
        });
      }

      // Verify targetPageId belongs to workspace when provided. A trashed
      // page is treated as absent so reviewers can't route AI writes to a
      // deleted target.
      if (body.data.targetPageId) {
        const [pg] = await fastify.db
          .select({ id: pages.id })
          .from(pages)
          .where(
            and(
              eq(pages.id, body.data.targetPageId),
              eq(pages.workspaceId, workspaceId),
              isNull(pages.deletedAt),
            ),
          )
          .limit(1);
        if (!pg) {
          return reply.code(400).send({
            error: "Invalid target page",
            code: ERROR_CODES.PAGE_NOT_FOUND,
            details: "Target page not found in this workspace",
          });
        }
      }

      const updates: Partial<IngestionDecision> = {};
      if (body.data.action !== undefined) {
        updates.action = body.data.action;
        if (body.data.action !== decision.action) {
          updates.proposedRevisionId = null;
        }
      }
      if (body.data.targetPageId !== undefined) {
        updates.targetPageId = body.data.targetPageId;
        // Changing the target invalidates any AI-proposed revision.
        updates.proposedRevisionId = null;
      }
      if (body.data.proposedPageTitle !== undefined) {
        updates.proposedPageTitle = body.data.proposedPageTitle;
      }

      const [updated] = await fastify.db
        .update(ingestionDecisions)
        .set(updates)
        .where(eq(ingestionDecisions.id, decisionId))
        .returning();

      await fastify.db.insert(auditLogs).values({
        workspaceId,
        userId,
        entityType: "ingestion",
        entityId: decision.ingestionId,
        action: "edit_decision",
        beforeJson: {
          decisionId,
          action: decision.action,
          targetPageId: decision.targetPageId,
          proposedPageTitle: decision.proposedPageTitle,
        },
        afterJson: {
          action: updated.action,
          targetPageId: updated.targetPageId,
          proposedPageTitle: updated.proposedPageTitle,
        },
      });

      return reply.send({
        id: updated.id,
        action: updated.action,
        targetPageId: updated.targetPageId,
        proposedPageTitle: updated.proposedPageTitle,
        proposedRevisionId: updated.proposedRevisionId,
        status: updated.status,
      });
    },
  );
};

async function loadDecision(
  db: Database,
  workspaceId: string,
  decisionId: string,
): Promise<IngestionDecision | null> {
  const [row] = await db
    .select({
      id: ingestionDecisions.id,
      ingestionId: ingestionDecisions.ingestionId,
      targetPageId: ingestionDecisions.targetPageId,
      proposedRevisionId: ingestionDecisions.proposedRevisionId,
      modelRunId: ingestionDecisions.modelRunId,
      agentRunId: ingestionDecisions.agentRunId,
      scheduledRunId: ingestionDecisions.scheduledRunId,
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
        eq(ingestions.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return (row as IngestionDecision) ?? null;
}

type UndoDecisionResponse =
  | {
      status: "undone";
      action: "create";
      ingestionId: string;
      pageId: string;
      deletedPageIds: string[];
    }
  | {
      status: "undone";
      action: "update" | "append";
      ingestionId: string;
      pageId: string;
      revisionId: string;
    }
  | {
      status: "undone";
      action: "delete";
      ingestionId: string;
      pageId: string;
      restoredPageIds: string[];
    }
  | {
      status: "undone";
      action: "merge";
      ingestionId: string;
      pageId: string;
      revisionId: string;
      restoredPageIds: string[];
    };

type UndoDecisionErrorResponse = {
  error: string;
  code: string;
  details: string;
  statusCode: number;
  extra?: Record<string, unknown>;
};

class DecisionUndoRouteError extends Error {
  constructor(
    public code: string,
    public extra?: Record<string, unknown>,
  ) {
    super(code);
  }
}

async function undoCreateDecision(input: {
  db: Database;
  workspaceId: string;
  decision: IngestionDecision;
  userId: string;
}): Promise<UndoDecisionResponse | UndoDecisionErrorResponse> {
  const { db, workspaceId, decision, userId } = input;

  const [page] = await db
    .select({
      id: pages.id,
      currentRevisionId: pages.currentRevisionId,
      deletedAt: pages.deletedAt,
    })
    .from(pages)
    .where(
      and(
        eq(pages.id, decision.targetPageId!),
        eq(pages.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (!page) {
    return {
      error: "Not found",
      code: ERROR_CODES.PAGE_NOT_FOUND,
      details: "Target page not found",
      statusCode: 404,
    };
  }

  if (page.deletedAt) {
    await markDecisionUndone(db, workspaceId, decision, userId, {
      type: "create_already_deleted",
      pageId: page.id,
    });
    return {
      status: "undone",
      action: "create",
      ingestionId: decision.ingestionId,
      pageId: page.id,
      deletedPageIds: [],
    };
  }

  if (page.currentRevisionId !== decision.proposedRevisionId) {
    return {
      error: "Undo conflict",
      code: ERROR_CODES.DECISION_UNDO_CONFLICT,
      details:
        "The target page has been edited since this decision was applied.",
      statusCode: 409,
      extra: {
        currentRevisionId: page.currentRevisionId,
        appliedRevisionId: decision.proposedRevisionId,
      },
    };
  }

  const descendantIds = await collectDescendantPageIds(db, workspaceId, page.id);
  const activeDescendantIds = descendantIds.filter((id) => id !== page.id);
  if (activeDescendantIds.length > 0) {
    return {
      error: "Undo conflict",
      code: ERROR_CODES.DECISION_UNDO_CONFLICT,
      details:
        "The created page has active child pages. Move or delete them before undoing this create decision.",
      statusCode: 409,
      extra: { descendantPageIds: activeDescendantIds },
    };
  }

  try {
    const result = await softDeleteSubtree(db, {
      workspaceId,
      rootPageId: page.id,
      userId,
    });
    await markDecisionUndone(db, workspaceId, decision, userId, {
      type: "soft_delete_created_page",
      pageId: page.id,
      deletedPageIds: result.deletedPageIds,
    });
    return {
      status: "undone",
      action: "create",
      ingestionId: decision.ingestionId,
      pageId: page.id,
      deletedPageIds: result.deletedPageIds,
    };
  } catch (err) {
    if (err instanceof PageDeletionError) {
      if (err.code === ERROR_CODES.PAGE_NOT_FOUND) {
        return {
          error: "Not found",
          code: ERROR_CODES.PAGE_NOT_FOUND,
          details: "Target page not found",
          statusCode: 404,
        };
      }
      if (err.code === ERROR_CODES.PUBLISHED_BLOCK) {
        return {
          error:
            "Page has a live published snapshot. Unpublish it before undoing this create decision.",
          code: ERROR_CODES.PUBLISHED_BLOCK,
          details: "The created page is currently published.",
          statusCode: 409,
          extra: { publishConflict: err.details },
        };
      }
    }
    throw err;
  }
}

async function reindexRestoredPages(input: {
  db: Database;
  restoredPageIds: string[];
}): Promise<void> {
  if (input.restoredPageIds.length === 0) return;
  await input.db.execute(sql`
    UPDATE "pages" p
    SET "search_vector" = to_tsvector(
      'simple',
      coalesce(p."title", '') || ' ' || coalesce(r."content_md", '')
    )
    FROM "page_revisions" r
    WHERE p."id" IN (${sqlUuidList(input.restoredPageIds)})
      AND r."id" = p."current_revision_id"
  `);
}

async function undoDeleteDecision(input: {
  db: Database;
  workspaceId: string;
  decision: IngestionDecision;
  userId: string;
}): Promise<UndoDecisionResponse | UndoDecisionErrorResponse> {
  const { db, workspaceId, decision, userId } = input;

  try {
    const result = await restoreSubtree(db, {
      workspaceId,
      rootPageId: decision.targetPageId!,
      userId,
    });
    await reindexRestoredPages({ db, restoredPageIds: result.restoredPageIds });
    await markDecisionUndone(db, workspaceId, decision, userId, {
      type: "restore_deleted_page",
      pageId: decision.targetPageId,
      restoredPageIds: result.restoredPageIds,
    });
    return {
      status: "undone",
      action: "delete",
      ingestionId: decision.ingestionId,
      pageId: decision.targetPageId!,
      restoredPageIds: result.restoredPageIds,
    };
  } catch (err) {
    if (err instanceof PageDeletionError) {
      if (err.code === ERROR_CODES.PAGE_NOT_FOUND) {
        return {
          error: "Not found",
          code: ERROR_CODES.PAGE_NOT_FOUND,
          details: "Target page not found",
          statusCode: 404,
        };
      }
      if (err.code === ERROR_CODES.SLUG_CONFLICT) {
        return {
          error: "Undo conflict",
          code: ERROR_CODES.DECISION_UNDO_CONFLICT,
          details:
            "A restored page conflicts with an active slug or path. Rename the active page first.",
          statusCode: 409,
          extra: { restoreConflict: err.details },
        };
      }
    }
    throw err;
  }
}

async function undoRevisionDecision(input: {
  db: Database;
  extractionQueue: Queue;
  searchQueue: Queue;
  linkQueue: Queue;
  workspaceId: string;
  decision: IngestionDecision;
  userId: string;
}): Promise<UndoDecisionResponse | UndoDecisionErrorResponse> {
  const { db, extractionQueue, searchQueue, linkQueue, workspaceId, decision, userId } =
    input;

  try {
    const result = await db.transaction(async (tx) => {
      const [page] = await tx
        .select({
          id: pages.id,
          currentRevisionId: pages.currentRevisionId,
        })
        .from(pages)
        .where(
          and(
            eq(pages.id, decision.targetPageId!),
            eq(pages.workspaceId, workspaceId),
            isNull(pages.deletedAt),
          ),
        )
        .limit(1);

      if (!page) {
        throw new DecisionUndoRouteError(ERROR_CODES.PAGE_NOT_FOUND);
      }
      if (page.currentRevisionId !== decision.proposedRevisionId) {
        throw new DecisionUndoRouteError(ERROR_CODES.DECISION_UNDO_CONFLICT, {
          currentRevisionId: page.currentRevisionId,
          appliedRevisionId: decision.proposedRevisionId,
        });
      }

      const [appliedRevision] = await tx
        .select({
          id: pageRevisions.id,
          baseRevisionId: pageRevisions.baseRevisionId,
          contentMd: pageRevisions.contentMd,
        })
        .from(pageRevisions)
        .where(eq(pageRevisions.id, decision.proposedRevisionId!))
        .limit(1);

      const baseRevisionId =
        appliedRevision?.baseRevisionId ??
        readDecisionBaseRevisionId(decision.rationaleJson);
      if (!appliedRevision || !baseRevisionId) {
        throw new DecisionUndoRouteError(ERROR_CODES.DECISION_UNDO_UNSUPPORTED);
      }

      const [baseRevision] = await tx
        .select({
          id: pageRevisions.id,
          contentMd: pageRevisions.contentMd,
          contentJson: pageRevisions.contentJson,
        })
        .from(pageRevisions)
        .where(
          and(
            eq(pageRevisions.id, baseRevisionId),
            eq(pageRevisions.pageId, page.id),
          ),
        )
        .limit(1);
      if (!baseRevision) {
        throw new DecisionUndoRouteError(ERROR_CODES.DECISION_UNDO_UNSUPPORTED);
      }

      const [rollbackRevision] = await tx
        .insert(pageRevisions)
        .values({
          pageId: page.id,
          baseRevisionId: page.currentRevisionId,
          actorUserId: userId,
          actorType: "user",
          source: "rollback",
          sourceIngestionId: decision.ingestionId,
          sourceDecisionId: decision.id,
          contentMd: baseRevision.contentMd,
          contentJson: baseRevision.contentJson,
          revisionNote: `Undo auto-${decision.action} decision ${decision.id}`,
        })
        .returning();

      const diff = computeDiff(
        appliedRevision.contentMd,
        baseRevision.contentMd,
        null,
        null,
      );
      await tx.insert(revisionDiffs).values({
        revisionId: rollbackRevision.id,
        diffMd: diff.diffMd,
        diffOpsJson: diff.diffOpsJson,
        changedBlocks: diff.changedBlocks,
      });

      await tx
        .update(pages)
        .set({
          currentRevisionId: rollbackRevision.id,
          updatedAt: sql`now()`,
          lastHumanEditedAt: sql`now()`,
        })
        .where(eq(pages.id, page.id));

      await tx
        .update(ingestionDecisions)
        .set({
          status: "undone",
          rationaleJson: withUndoRationale(decision.rationaleJson, {
            type: "rollback_revision",
            pageId: page.id,
            appliedRevisionId: appliedRevision.id,
            rollbackRevisionId: rollbackRevision.id,
            restoredRevisionId: baseRevision.id,
            undoneByUserId: userId,
            undoneAt: new Date().toISOString(),
          }),
        })
        .where(eq(ingestionDecisions.id, decision.id));

      await tx.insert(auditLogs).values({
        workspaceId,
        userId,
        entityType: "page_revision",
        entityId: rollbackRevision.id,
        action: "undo_decision",
        beforeJson: {
          decisionId: decision.id,
          pageId: page.id,
          appliedRevisionId: appliedRevision.id,
        },
        afterJson: {
          rollbackRevisionId: rollbackRevision.id,
          restoredRevisionId: baseRevision.id,
        },
      });

      return {
        pageId: page.id,
        revisionId: rollbackRevision.id,
      };
    });

    await Promise.all([
      extractionQueue.add(
        JOB_NAMES.TRIPLE_EXTRACTOR,
        {
          pageId: result.pageId,
          revisionId: result.revisionId,
          workspaceId,
        },
        DEFAULT_JOB_OPTIONS,
      ),
      searchQueue.add(
        JOB_NAMES.SEARCH_INDEX_UPDATER,
        {
          pageId: result.pageId,
          revisionId: result.revisionId,
          workspaceId,
        },
        DEFAULT_JOB_OPTIONS,
      ),
      linkQueue.add(
        JOB_NAMES.PAGE_LINK_EXTRACTOR,
        {
          pageId: result.pageId,
          revisionId: result.revisionId,
          workspaceId,
        },
        DEFAULT_JOB_OPTIONS,
      ),
    ]);

    return {
      status: "undone",
      action: decision.action as "update" | "append",
      ingestionId: decision.ingestionId,
      pageId: result.pageId,
      revisionId: result.revisionId,
    };
  } catch (err) {
    if (err instanceof DecisionUndoRouteError) {
      if (err.code === ERROR_CODES.PAGE_NOT_FOUND) {
        return {
          error: "Not found",
          code: ERROR_CODES.PAGE_NOT_FOUND,
          details: "Target page not found",
          statusCode: 404,
        };
      }
      if (err.code === ERROR_CODES.DECISION_UNDO_CONFLICT) {
        return {
          error: "Undo conflict",
          code: ERROR_CODES.DECISION_UNDO_CONFLICT,
          details:
            "The target page has been edited since this decision was applied.",
          statusCode: 409,
          extra: err.extra,
        };
      }
      return {
        error: "Undo unsupported",
        code: ERROR_CODES.DECISION_UNDO_UNSUPPORTED,
        details: "The base revision needed to undo this decision is missing.",
        statusCode: 409,
      };
    }
    throw err;
  }
}

function readMergeMeta(value: unknown): {
  canonicalPageId: string;
  sourcePageIds: string[];
} | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const canonicalPageId = record.canonicalPageId;
  const sourcePageIds = record.sourcePageIds;
  if (typeof canonicalPageId !== "string" || !Array.isArray(sourcePageIds)) {
    return null;
  }
  const sources = sourcePageIds.filter(
    (id): id is string => typeof id === "string",
  );
  return sources.length > 0 ? { canonicalPageId, sourcePageIds: sources } : null;
}

async function undoMergeDecision(input: {
  db: Database;
  extractionQueue: Queue;
  searchQueue: Queue;
  linkQueue: Queue;
  workspaceId: string;
  decision: IngestionDecision;
  userId: string;
}): Promise<UndoDecisionResponse | UndoDecisionErrorResponse> {
  const { db, extractionQueue, searchQueue, linkQueue, workspaceId, decision, userId } =
    input;
  const meta = readMergeMeta(decision.rationaleJson);
  if (
    !meta ||
    meta.canonicalPageId !== decision.targetPageId ||
    !decision.proposedRevisionId
  ) {
    return {
      error: "Undo unsupported",
      code: ERROR_CODES.DECISION_UNDO_UNSUPPORTED,
      details: "Merge decision is missing canonical/source metadata.",
      statusCode: 409,
    };
  }

  const [page] = await db
    .select({
      id: pages.id,
      currentRevisionId: pages.currentRevisionId,
    })
    .from(pages)
    .where(
      and(
        eq(pages.id, decision.targetPageId!),
        eq(pages.workspaceId, workspaceId),
        isNull(pages.deletedAt),
      ),
    )
    .limit(1);
  if (!page) {
    return {
      error: "Not found",
      code: ERROR_CODES.PAGE_NOT_FOUND,
      details: "Canonical page not found",
      statusCode: 404,
    };
  }
  if (page.currentRevisionId !== decision.proposedRevisionId) {
    return {
      error: "Undo conflict",
      code: ERROR_CODES.DECISION_UNDO_CONFLICT,
      details:
        "The canonical page has been edited since this merge was approved.",
      statusCode: 409,
      extra: {
        currentRevisionId: page.currentRevisionId,
        appliedRevisionId: decision.proposedRevisionId,
      },
    };
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          id: pages.id,
          currentRevisionId: pages.currentRevisionId,
        })
        .from(pages)
        .where(
          and(
            eq(pages.id, decision.targetPageId!),
            eq(pages.workspaceId, workspaceId),
            isNull(pages.deletedAt),
          ),
        )
        .limit(1);
      if (!current) throw new DecisionUndoRouteError(ERROR_CODES.PAGE_NOT_FOUND);
      if (current.currentRevisionId !== decision.proposedRevisionId) {
        throw new DecisionUndoRouteError(ERROR_CODES.DECISION_UNDO_CONFLICT, {
          currentRevisionId: current.currentRevisionId,
          appliedRevisionId: decision.proposedRevisionId,
        });
      }

      const [appliedRevision] = await tx
        .select({
          id: pageRevisions.id,
          baseRevisionId: pageRevisions.baseRevisionId,
          contentMd: pageRevisions.contentMd,
        })
        .from(pageRevisions)
        .where(eq(pageRevisions.id, decision.proposedRevisionId!))
        .limit(1);
      if (!appliedRevision?.baseRevisionId) {
        throw new DecisionUndoRouteError(ERROR_CODES.DECISION_UNDO_UNSUPPORTED);
      }

      const [baseRevision] = await tx
        .select({
          id: pageRevisions.id,
          contentMd: pageRevisions.contentMd,
          contentJson: pageRevisions.contentJson,
        })
        .from(pageRevisions)
        .where(
          and(
            eq(pageRevisions.id, appliedRevision.baseRevisionId),
            eq(pageRevisions.pageId, decision.targetPageId!),
          ),
        )
        .limit(1);
      if (!baseRevision) {
        throw new DecisionUndoRouteError(ERROR_CODES.DECISION_UNDO_UNSUPPORTED);
      }

      let restoredPageIds: string[] = [];
      for (const sourcePageId of meta.sourcePageIds) {
        const restoreResult = await restoreSubtreeInTransaction(tx, {
          workspaceId,
          rootPageId: sourcePageId,
          userId,
        });
        restoredPageIds = [
          ...restoredPageIds,
          ...restoreResult.restoredPageIds,
        ];
      }
      restoredPageIds = [...new Set(restoredPageIds)];

      const [rollbackRevision] = await tx
        .insert(pageRevisions)
        .values({
          pageId: decision.targetPageId!,
          baseRevisionId: current.currentRevisionId,
          actorUserId: userId,
          actorType: "user",
          source: "rollback",
          sourceIngestionId: decision.ingestionId,
          sourceDecisionId: decision.id,
          contentMd: baseRevision.contentMd,
          contentJson: baseRevision.contentJson,
          revisionNote: `Undo merge decision ${decision.id}`,
        })
        .returning();

      const diff = computeDiff(
        appliedRevision.contentMd,
        baseRevision.contentMd,
        null,
        null,
      );
      await tx.insert(revisionDiffs).values({
        revisionId: rollbackRevision.id,
        diffMd: diff.diffMd,
        diffOpsJson: diff.diffOpsJson,
        changedBlocks: diff.changedBlocks,
      });

      await Promise.all([
        tx
          .update(pages)
          .set({
            currentRevisionId: rollbackRevision.id,
            updatedAt: sql`now()`,
            lastHumanEditedAt: sql`now()`,
          })
          .where(eq(pages.id, decision.targetPageId!)),
        tx
          .update(pageRedirects)
          .set({ disabledAt: sql`now()` })
          .where(eq(pageRedirects.createdByDecisionId, decision.id)),
        tx
          .update(ingestionDecisions)
          .set({
            status: "undone",
            rationaleJson: withUndoRationale(decision.rationaleJson, {
              type: "undo_merge",
              canonicalPageId: decision.targetPageId,
              sourcePageIds: meta.sourcePageIds,
              restoredPageIds,
              appliedRevisionId: appliedRevision.id,
              rollbackRevisionId: rollbackRevision.id,
              restoredRevisionId: baseRevision.id,
              undoneByUserId: userId,
              undoneAt: new Date().toISOString(),
            }),
          })
          .where(eq(ingestionDecisions.id, decision.id)),
        tx.insert(auditLogs).values({
          workspaceId,
          userId,
          entityType: "ingestion",
          entityId: decision.ingestionId,
          action: "undo_decision",
          beforeJson: {
            decisionId: decision.id,
            action: "merge",
            appliedRevisionId: appliedRevision.id,
          },
          afterJson: {
            rollbackRevisionId: rollbackRevision.id,
            restoredRevisionId: baseRevision.id,
            restoredPageIds,
          },
        }),
      ]);

      return {
        pageId: current.id,
        revisionId: rollbackRevision.id,
        restoredPageIds,
      };
    });

    await Promise.all([
      reindexRestoredPages({ db, restoredPageIds: result.restoredPageIds }),
      extractionQueue.add(
        JOB_NAMES.TRIPLE_EXTRACTOR,
        {
          pageId: result.pageId,
          revisionId: result.revisionId,
          workspaceId,
        },
        DEFAULT_JOB_OPTIONS,
      ),
      searchQueue.add(
        JOB_NAMES.SEARCH_INDEX_UPDATER,
        {
          pageId: result.pageId,
          revisionId: result.revisionId,
          workspaceId,
        },
        DEFAULT_JOB_OPTIONS,
      ),
      linkQueue.add(
        JOB_NAMES.PAGE_LINK_EXTRACTOR,
        {
          pageId: result.pageId,
          revisionId: result.revisionId,
          workspaceId,
        },
        DEFAULT_JOB_OPTIONS,
      ),
    ]);

    return {
      status: "undone",
      action: "merge",
      ingestionId: decision.ingestionId,
      pageId: result.pageId,
      revisionId: result.revisionId,
      restoredPageIds: result.restoredPageIds,
    };
  } catch (err) {
    if (err instanceof PageDeletionError) {
      if (err.code === ERROR_CODES.PAGE_NOT_FOUND) {
        return {
          error: "Not found",
          code: ERROR_CODES.PAGE_NOT_FOUND,
          details: "One or more merge source pages were not found.",
          statusCode: 404,
        };
      }
      if (err.code === ERROR_CODES.SLUG_CONFLICT) {
        return {
          error: "Undo conflict",
          code: ERROR_CODES.DECISION_UNDO_CONFLICT,
          details:
            "A restored source page conflicts with an active slug or path. Rename the active page first.",
          statusCode: 409,
          extra: { restoreConflict: err.details },
        };
      }
    }
    if (err instanceof DecisionUndoRouteError) {
      if (err.code === ERROR_CODES.PAGE_NOT_FOUND) {
        return {
          error: "Not found",
          code: ERROR_CODES.PAGE_NOT_FOUND,
          details: "Canonical page not found",
          statusCode: 404,
        };
      }
      if (err.code === ERROR_CODES.DECISION_UNDO_CONFLICT) {
        return {
          error: "Undo conflict",
          code: ERROR_CODES.DECISION_UNDO_CONFLICT,
          details:
            "The canonical page has been edited since this merge was approved.",
          statusCode: 409,
          extra: err.extra,
        };
      }
      return {
        error: "Undo unsupported",
        code: ERROR_CODES.DECISION_UNDO_UNSUPPORTED,
        details: "The base revision needed to undo this merge is missing.",
        statusCode: 409,
      };
    }
    throw err;
  }
}

async function markDecisionUndone(
  db: Database,
  workspaceId: string,
  decision: IngestionDecision,
  userId: string,
  undo: Record<string, unknown>,
): Promise<void> {
  const undoRecord = {
    ...undo,
    undoneByUserId: userId,
    undoneAt: new Date().toISOString(),
  };
  await Promise.all([
    db
      .update(ingestionDecisions)
      .set({
        status: "undone",
        rationaleJson: withUndoRationale(decision.rationaleJson, undoRecord),
      })
      .where(eq(ingestionDecisions.id, decision.id)),
    db.insert(auditLogs).values({
      workspaceId,
      userId,
      entityType: "ingestion",
      entityId: decision.ingestionId,
      action: "undo_decision",
      beforeJson: {
        decisionId: decision.id,
        action: decision.action,
        status: decision.status,
      },
      afterJson: undoRecord,
    }),
  ]);
}

function readDecisionBaseRevisionId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as { baseRevisionId?: unknown }).baseRevisionId;
  return typeof candidate === "string" ? candidate : null;
}

function withUndoRationale(
  value: unknown,
  undo: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {}),
    undo,
  };
}

export default decisionRoutes;
