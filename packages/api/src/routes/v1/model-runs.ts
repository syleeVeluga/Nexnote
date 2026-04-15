import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { eq, and, desc, count, sql } from "drizzle-orm";
import { modelRuns } from "@nexnote/db";
import { paginationSchema, AI_PROVIDERS, MODEL_RUN_MODES, MODEL_RUN_STATUSES } from "@nexnote/shared";
import { z } from "zod";
import {
  getMemberRole,
  forbidden,
  insufficientRole,
  ADMIN_PLUS_ROLES,
  workspaceParamsSchema,
} from "../../lib/workspace-auth.js";
import { sendValidationError } from "../../lib/reply-helpers.js";

const listQuerySchema = paginationSchema.extend({
  provider: z.enum(AI_PROVIDERS).optional(),
  mode: z.enum(MODEL_RUN_MODES).optional(),
  status: z.enum(MODEL_RUN_STATUSES).optional(),
});

function toModelRunDto(row: typeof modelRuns.$inferSelect) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    provider: row.provider,
    modelName: row.modelName,
    mode: row.mode,
    promptVersion: row.promptVersion,
    tokenInput: row.tokenInput,
    tokenOutput: row.tokenOutput,
    latencyMs: row.latencyMs,
    status: row.status,
    requestMetaJson: row.requestMetaJson,
    responseMetaJson: row.responseMetaJson,
    createdAt: row.createdAt.toISOString(),
  };
}

const modelRunRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRequest", fastify.authenticate);

  // GET /workspaces/:workspaceId/model-runs — List AI model runs (admin+)
  fastify.get(
    "/",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = workspaceParamsSchema.safeParse(request.params);
      if (!paramsResult.success)
        return sendValidationError(reply, paramsResult.error.issues);
      const { workspaceId } = paramsResult.data;

      const role = await getMemberRole(fastify.db, workspaceId, request.user.sub);
      if (!role) return forbidden(reply);
      if (!ADMIN_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const queryResult = listQuerySchema.safeParse(request.query);
      if (!queryResult.success)
        return sendValidationError(reply, queryResult.error.issues);
      const { limit, offset, provider, mode, status } = queryResult.data;

      const conditions = [eq(modelRuns.workspaceId, workspaceId)];
      if (provider) conditions.push(eq(modelRuns.provider, provider));
      if (mode) conditions.push(eq(modelRuns.mode, mode));
      if (status) conditions.push(eq(modelRuns.status, status));

      const where = and(...conditions);

      const [data, [totalRow]] = await Promise.all([
        fastify.db
          .select()
          .from(modelRuns)
          .where(where)
          .orderBy(desc(modelRuns.createdAt))
          .limit(limit)
          .offset(offset),
        fastify.db
          .select({ total: count() })
          .from(modelRuns)
          .where(where),
      ]);

      return {
        data: data.map(toModelRunDto),
        total: totalRow.total,
      };
    },
  );

  // GET /workspaces/:workspaceId/model-runs/stats — Aggregated stats
  fastify.get(
    "/stats",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = workspaceParamsSchema.safeParse(request.params);
      if (!paramsResult.success)
        return sendValidationError(reply, paramsResult.error.issues);
      const { workspaceId } = paramsResult.data;

      const role = await getMemberRole(fastify.db, workspaceId, request.user.sub);
      if (!role) return forbidden(reply);
      if (!ADMIN_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const [stats] = await fastify.db
        .select({
          totalRuns: count(),
          totalTokenInput: sql<number>`coalesce(sum(${modelRuns.tokenInput}), 0)::int`,
          totalTokenOutput: sql<number>`coalesce(sum(${modelRuns.tokenOutput}), 0)::int`,
          avgLatencyMs: sql<number>`coalesce(avg(${modelRuns.latencyMs}), 0)::int`,
        })
        .from(modelRuns)
        .where(eq(modelRuns.workspaceId, workspaceId));

      return { data: stats };
    },
  );
};

export default modelRunRoutes;
