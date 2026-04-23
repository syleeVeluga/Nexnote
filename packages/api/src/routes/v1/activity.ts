import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  modelRuns,
  users,
  pages,
  ingestions,
  folders,
} from "@wekiflow/db";
import { paginationSchema, uuidSchema } from "@wekiflow/shared";
import {
  getMemberRole,
  forbidden,
  workspaceParamsSchema,
} from "../../lib/workspace-auth.js";
import { sendValidationError } from "../../lib/reply-helpers.js";

const ACTOR_TYPES = ["ai", "user", "system"] as const;
const ENTITY_TYPES = [
  "page",
  "ingestion",
  "folder",
  "workspace",
  "decision",
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

    for (const row of rows) {
      if (row.entityType === "page") pageIdSet.add(row.entityId);
      else if (row.entityType === "ingestion") ingestionIdSet.add(row.entityId);
      else if (row.entityType === "folder") folderIdSet.add(row.entityId);

      const after = row.afterJson as AfterJson | null;
      if (after?.ingestionId) ingestionIdSet.add(after.ingestionId);
    }

    const [pageRows, ingestionRows, folderRows] = await Promise.all([
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
        : Promise.resolve([] as Array<{ id: string; title: string; slug: string; deletedAt: Date | null }>),
      ingestionIdSet.size > 0
        ? fastify.db
            .select({
              id: ingestions.id,
              sourceName: ingestions.sourceName,
              titleHint: ingestions.titleHint,
            })
            .from(ingestions)
            .where(inArray(ingestions.id, Array.from(ingestionIdSet)))
        : Promise.resolve([] as Array<{ id: string; sourceName: string; titleHint: string | null }>),
      folderIdSet.size > 0
        ? fastify.db
            .select({ id: folders.id, name: folders.name, slug: folders.slug })
            .from(folders)
            .where(inArray(folders.id, Array.from(folderIdSet)))
        : Promise.resolve([] as Array<{ id: string; name: string; slug: string }>),
    ]);

    const pageMap = new Map(pageRows.map((p) => [p.id, p]));
    const ingestionMap = new Map(ingestionRows.map((i) => [i.id, i]));
    const folderMap = new Map(folderRows.map((f) => [f.id, f]));

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
      } else {
        entity = {
          type: row.entityType,
          id: row.entityId,
          label: null,
          slug: null,
          deleted: false,
        };
      }

      const contextIngestionId = after?.ingestionId ?? null;
      const contextIngestion = contextIngestionId
        ? ingestionMap.get(contextIngestionId) ?? null
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
          ingestion: contextIngestion
            ? {
                id: contextIngestion.id,
                sourceName: contextIngestion.sourceName,
              }
            : null,
          decisionId: after?.decisionId ?? before?.decisionId ?? null,
          revisionId: after?.revisionId ?? null,
        },
      };
    });

    return { data, total: totalRow.total, limit, offset };
  });
};

export default activityRoutes;
