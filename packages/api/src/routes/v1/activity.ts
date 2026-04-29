import type { FastifyPluginAsync } from "fastify";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  modelRuns,
  users,
  pages,
  ingestions,
  folders,
  pageRevisions,
  revisionDiffs,
  ingestionDecisions,
} from "@wekiflow/db";
import { paginationSchema, uuidSchema } from "@wekiflow/shared";
import {
  getMemberRole,
  forbidden,
  workspaceParamsSchema,
} from "../../lib/workspace-auth.js";
import { sendValidationError } from "../../lib/reply-helpers.js";
import {
  deriveActivitySummary,
  readNumber,
} from "../../lib/activity-summary.js";

const ACTOR_TYPES = ["ai", "user", "system"] as const;
const ENTITY_TYPES = [
  "page",
  "ingestion",
  "folder",
  "workspace",
  "decision",
  "page_revision",
] as const;

const listQuerySchema = paginationSchema.extend({
  actorType: z.enum(ACTOR_TYPES).optional(),
  entityType: z.enum(ENTITY_TYPES).optional(),
  action: z.string().min(1).max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

interface AfterJson {
  ingestionId?: string;
  decisionId?: string;
  revisionId?: string;
  source?: string;
  summary?: string;
  revisionNote?: string;
  changedBlocks?: number;
  confidence?: number;
  [key: string]: unknown;
}

function deriveActorType(
  userId: string | null,
  modelRunId: string | null,
): "ai" | "user" | "system" {
  if (modelRunId) return "ai";
  if (userId) return "user";
  return "system";
}

const activityRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRequest", fastify.authenticate);

  // GET /workspaces/:workspaceId/activity — Workspace activity feed.
  // All workspace members can read. Entries cover page/ingestion/folder/
  // workspace/decision actions; actor is derived from userId + modelRunId.
  fastify.get("/", async (request, reply) => {
    const paramsResult = workspaceParamsSchema.safeParse(request.params);
    if (!paramsResult.success)
      return sendValidationError(reply, paramsResult.error.issues);
    const { workspaceId } = paramsResult.data;

    const role = await getMemberRole(fastify.db, workspaceId, request.user.sub);
    if (!role) return forbidden(reply);

    const queryResult = listQuerySchema.safeParse(request.query);
    if (!queryResult.success)
      return sendValidationError(reply, queryResult.error.issues);
    const { limit, offset, actorType, entityType, action, from, to } =
      queryResult.data;

    const conditions = [eq(auditLogs.workspaceId, workspaceId)];
    if (entityType) conditions.push(eq(auditLogs.entityType, entityType));
    if (action) conditions.push(eq(auditLogs.action, action));
    if (from) conditions.push(gte(auditLogs.createdAt, from));
    if (to) conditions.push(lte(auditLogs.createdAt, to));
    if (actorType === "ai") {
      conditions.push(isNotNull(auditLogs.modelRunId));
    } else if (actorType === "user") {
      conditions.push(isNotNull(auditLogs.userId));
      conditions.push(isNull(auditLogs.modelRunId));
    } else if (actorType === "system") {
      conditions.push(isNull(auditLogs.userId));
      conditions.push(isNull(auditLogs.modelRunId));
    }

    const where = and(...conditions);

    const [rows, [totalRow]] = await Promise.all([
      fastify.db
        .select({
          id: auditLogs.id,
          userId: auditLogs.userId,
          modelRunId: auditLogs.modelRunId,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          action: auditLogs.action,
          afterJson: auditLogs.afterJson,
          beforeJson: auditLogs.beforeJson,
          createdAt: auditLogs.createdAt,
          userName: users.name,
          userEmail: users.email,
          aiProvider: modelRuns.provider,
          aiModelName: modelRuns.modelName,
        })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.userId))
        .leftJoin(modelRuns, eq(modelRuns.id, auditLogs.modelRunId))
        .where(where)
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit)
        .offset(offset),
      fastify.db
        .select({ total: sql<number>`count(*)::int` })
        .from(auditLogs)
        .where(where),
    ]);

    // Batch-load referenced entities so the UI can render labels without N+1.
    const pageIdSet = new Set<string>();
    const ingestionIdSet = new Set<string>();
    const folderIdSet = new Set<string>();
    const revisionIdSet = new Set<string>();
    const decisionIdSet = new Set<string>();

    for (const row of rows) {
      if (row.entityType === "page") pageIdSet.add(row.entityId);
      else if (row.entityType === "ingestion") ingestionIdSet.add(row.entityId);
      else if (row.entityType === "folder") folderIdSet.add(row.entityId);
      else if (row.entityType === "page_revision") {
        revisionIdSet.add(row.entityId);
      }

      const after = row.afterJson as AfterJson | null;
      const before = row.beforeJson as AfterJson | null;
      if (after?.ingestionId) ingestionIdSet.add(after.ingestionId);
      if (before?.ingestionId) ingestionIdSet.add(before.ingestionId);
      if (after?.revisionId) revisionIdSet.add(after.revisionId);
      if (before?.revisionId) revisionIdSet.add(before.revisionId);
      if (after?.decisionId) decisionIdSet.add(after.decisionId);
      if (before?.decisionId) decisionIdSet.add(before.decisionId);
    }

    const [pageRows, ingestionRows, folderRows, revisionRows, decisionRows] =
      await Promise.all([
        pageIdSet.size > 0
          ? fastify.db
              .select({
                id: pages.id,
                title: pages.title,
                slug: pages.slug,
                deletedAt: pages.deletedAt,
              })
              .from(pages)
              .where(inArray(pages.id, Array.from(pageIdSet)))
          : Promise.resolve(
              [] as Array<{
                id: string;
                title: string;
                slug: string;
                deletedAt: Date | null;
              }>,
            ),
        ingestionIdSet.size > 0
          ? fastify.db
              .select({
                id: ingestions.id,
                sourceName: ingestions.sourceName,
                titleHint: ingestions.titleHint,
              })
              .from(ingestions)
              .where(inArray(ingestions.id, Array.from(ingestionIdSet)))
          : Promise.resolve(
              [] as Array<{
                id: string;
                sourceName: string;
                titleHint: string | null;
              }>,
            ),
        folderIdSet.size > 0
          ? fastify.db
              .select({
                id: folders.id,
                name: folders.name,
                slug: folders.slug,
              })
              .from(folders)
              .where(inArray(folders.id, Array.from(folderIdSet)))
          : Promise.resolve(
              [] as Array<{ id: string; name: string; slug: string }>,
            ),
        revisionIdSet.size > 0
          ? fastify.db
              .select({
                id: pageRevisions.id,
                pageId: pageRevisions.pageId,
                revisionNote: pageRevisions.revisionNote,
                changedBlocks: revisionDiffs.changedBlocks,
                pageTitle: pages.title,
                pageSlug: pages.slug,
                pageDeletedAt: pages.deletedAt,
              })
              .from(pageRevisions)
              .leftJoin(
                revisionDiffs,
                eq(revisionDiffs.revisionId, pageRevisions.id),
              )
              .leftJoin(pages, eq(pages.id, pageRevisions.pageId))
              .where(inArray(pageRevisions.id, Array.from(revisionIdSet)))
          : Promise.resolve(
              [] as Array<{
                id: string;
                pageId: string;
                revisionNote: string | null;
                changedBlocks: number | null;
                pageTitle: string | null;
                pageSlug: string | null;
                pageDeletedAt: Date | null;
              }>,
            ),
        decisionIdSet.size > 0
          ? fastify.db
              .select({
                id: ingestionDecisions.id,
                ingestionId: ingestionDecisions.ingestionId,
                confidence: ingestionDecisions.confidence,
                sourceName: ingestions.sourceName,
              })
              .from(ingestionDecisions)
              .innerJoin(
                ingestions,
                eq(ingestions.id, ingestionDecisions.ingestionId),
              )
              .where(
                and(
                  inArray(ingestionDecisions.id, Array.from(decisionIdSet)),
                  eq(ingestions.workspaceId, workspaceId),
                ),
              )
          : Promise.resolve(
              [] as Array<{
                id: string;
                ingestionId: string;
                confidence: number;
                sourceName: string;
              }>,
            ),
      ]);

    const pageMap = new Map(pageRows.map((p) => [p.id, p]));
    const ingestionMap = new Map(ingestionRows.map((i) => [i.id, i]));
    const folderMap = new Map(folderRows.map((f) => [f.id, f]));
    const revisionMap = new Map(revisionRows.map((r) => [r.id, r]));
    const decisionMap = new Map(decisionRows.map((d) => [d.id, d]));

    const data = rows.map((row) => {
      const after = (row.afterJson as AfterJson | null) ?? null;
      const before = (row.beforeJson as AfterJson | null) ?? null;

      let entity: {
        type: string;
        id: string;
        label: string | null;
        slug: string | null;
        deleted: boolean;
      } | null = null;

      if (row.entityType === "page") {
        const p = pageMap.get(row.entityId);
        entity = {
          type: "page",
          id: row.entityId,
          label: p?.title ?? null,
          slug: p?.slug ?? null,
          deleted: Boolean(p?.deletedAt),
        };
      } else if (row.entityType === "ingestion") {
        const ing = ingestionMap.get(row.entityId);
        entity = {
          type: "ingestion",
          id: row.entityId,
          label: ing?.titleHint ?? ing?.sourceName ?? null,
          slug: null,
          deleted: false,
        };
      } else if (row.entityType === "folder") {
        const f = folderMap.get(row.entityId);
        entity = {
          type: "folder",
          id: row.entityId,
          label: f?.name ?? null,
          slug: f?.slug ?? null,
          deleted: false,
        };
      } else if (row.entityType === "page_revision") {
        const revision = revisionMap.get(row.entityId);
        entity = {
          type: "page_revision",
          id: row.entityId,
          label: revision?.pageTitle ?? revision?.revisionNote ?? null,
          slug: revision?.pageSlug ?? null,
          deleted: Boolean(revision?.pageDeletedAt),
        };
      } else {
        entity = {
          type: row.entityType,
          id: row.entityId,
          label: null,
          slug: null,
          deleted: false,
        };
      }

      const contextDecisionId = after?.decisionId ?? before?.decisionId ?? null;
      const contextDecision = contextDecisionId
        ? decisionMap.get(contextDecisionId) ?? null
        : null;
      const contextIngestionId =
        after?.ingestionId ??
        before?.ingestionId ??
        contextDecision?.ingestionId ??
        (row.entityType === "ingestion" ? row.entityId : null);
      const contextIngestion = contextIngestionId
        ? ingestionMap.get(contextIngestionId) ?? null
        : null;
      const contextRevisionId =
        after?.revisionId ??
        before?.revisionId ??
        (row.entityType === "page_revision" ? row.entityId : null);
      const contextRevision = contextRevisionId
        ? revisionMap.get(contextRevisionId) ?? null
        : null;
      const changedBlocks =
        contextRevision?.changedBlocks ??
        readNumber(after?.changedBlocks) ??
        readNumber(before?.changedBlocks);
      const decisionConfidence =
        contextDecision?.confidence ??
        readNumber(after?.confidence) ??
        readNumber(before?.confidence);
      const sourceName =
        contextIngestion?.sourceName ?? contextDecision?.sourceName ?? null;
      const contextIngestionDto = contextIngestion
        ? {
            id: contextIngestion.id,
            sourceName: contextIngestion.sourceName,
          }
        : contextDecision
          ? {
              id: contextDecision.ingestionId,
              sourceName: contextDecision.sourceName,
            }
          : null;

      return {
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        actor: {
          type: deriveActorType(row.userId, row.modelRunId),
          user:
            row.userId && row.userName
              ? { id: row.userId, name: row.userName, email: row.userEmail }
              : null,
          aiModel: row.modelRunId
            ? { provider: row.aiProvider, modelName: row.aiModelName }
            : null,
        },
        entity,
        context: {
          source: after?.source ?? before?.source ?? null,
          ingestion: contextIngestionDto,
          decisionId: contextDecisionId,
          revisionId: contextRevisionId,
        },
        summary: deriveActivitySummary({
          action: row.action,
          entityType: row.entityType,
          afterJson: after,
          beforeJson: before,
          revisionNote: contextRevision?.revisionNote ?? null,
          changedBlocks,
        }),
        changedBlocks,
        decisionConfidence,
        sourceName,
      };
    });

    return { data, total: totalRow.total, limit, offset };
  });
};

export default activityRoutes;
