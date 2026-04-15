import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { eq, and, desc, count, gte, lte } from "drizzle-orm";
import { auditLogs, users } from "@nexnote/db";
import { paginationSchema, uuidSchema } from "@nexnote/shared";
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
  entityType: z.string().optional(),
  entityId: uuidSchema.optional(),
  action: z.string().optional(),
  userId: uuidSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

function toAuditLogDto(
  row: typeof auditLogs.$inferSelect,
  user?: { id: string; email: string; name: string } | null,
) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    modelRunId: row.modelRunId,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    beforeJson: row.beforeJson,
    afterJson: row.afterJson,
    createdAt: row.createdAt.toISOString(),
    user: user ? { id: user.id, email: user.email, name: user.name } : null,
  };
}

const auditLogRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRequest", fastify.authenticate);

  // GET /workspaces/:workspaceId/audit-logs — List audit logs (admin+)
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
      const { limit, offset, entityType, entityId, action, userId, from, to } = queryResult.data;

      const conditions = [eq(auditLogs.workspaceId, workspaceId)];
      if (entityType) conditions.push(eq(auditLogs.entityType, entityType));
      if (entityId) conditions.push(eq(auditLogs.entityId, entityId));
      if (action) conditions.push(eq(auditLogs.action, action));
      if (userId) conditions.push(eq(auditLogs.userId, userId));
      if (from) conditions.push(gte(auditLogs.createdAt, from));
      if (to) conditions.push(lte(auditLogs.createdAt, to));

      const where = and(...conditions);

      const [data, [totalRow]] = await Promise.all([
        fastify.db
          .select({
            log: auditLogs,
            user: {
              id: users.id,
              email: users.email,
              name: users.name,
            },
          })
          .from(auditLogs)
          .leftJoin(users, eq(auditLogs.userId, users.id))
          .where(where)
          .orderBy(desc(auditLogs.createdAt))
          .limit(limit)
          .offset(offset),
        fastify.db
          .select({ total: count() })
          .from(auditLogs)
          .where(where),
      ]);

      return {
        data: data.map((row) => toAuditLogDto(row.log, row.user)),
        total: totalRow.total,
      };
    },
  );
};

export default auditLogRoutes;
