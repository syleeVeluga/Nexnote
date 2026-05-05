import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { folders, scheduledRuns, workspaces } from "@wekiflow/db";
import { ERROR_CODES, QUEUE_NAMES, uuidSchema } from "@wekiflow/shared";
import {
  EDITOR_PLUS_ROLES,
  forbidden,
  getMemberRole,
  insufficientRole,
  workspaceParamsSchema,
} from "../../lib/workspace-auth.js";
import { sendValidationError } from "../../lib/reply-helpers.js";
import { enqueueScheduledAgentRun } from "../../lib/scheduled-agent-enqueue.js";

const reorganizeBodySchema = z.object({
  pageIds: z.array(uuidSchema).min(1).max(500),
  targetFolderId: uuidSchema.nullable().optional(),
  includeDescendants: z.boolean().optional().default(true),
  instruction: z.string().max(4000).nullable().optional(),
});

const listRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

const scheduledAgentRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/reorganize-runs",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      if (!params.success)
        return sendValidationError(reply, params.error.issues);

      const body = reorganizeBodySchema.safeParse(request.body);
      if (!body.success) return sendValidationError(reply, body.error.issues);

      const { workspaceId } = params.data;
      const userId = request.user.sub;
      const role = await getMemberRole(fastify.db, workspaceId, userId);
      if (!role) return forbidden(reply);
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const [workspace] = await fastify.db
        .select({ scheduledEnabled: workspaces.scheduledEnabled })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      if (!workspace?.scheduledEnabled) {
        return reply.code(403).send({
          error: "Scheduled agent is disabled for this workspace",
          code: ERROR_CODES.SCHEDULED_AGENT_DISABLED,
        });
      }
      if (body.data.targetFolderId) {
        const [folder] = await fastify.db
          .select({ id: folders.id })
          .from(folders)
          .where(
            and(
              eq(folders.id, body.data.targetFolderId),
              eq(folders.workspaceId, workspaceId),
            ),
          )
          .limit(1);
        if (!folder) {
          return reply.code(404).send({ error: "Target folder not found" });
        }
      }

      const result = await enqueueScheduledAgentRun({
        db: fastify.db,
        queue: fastify.queues[QUEUE_NAMES.SCHEDULED_AGENT],
        workspaceId,
        triggeredBy: "manual",
        pageIds: body.data.pageIds,
        targetFolderId: body.data.targetFolderId ?? null,
        includeDescendants: body.data.includeDescendants,
        instruction: body.data.instruction ?? null,
        requestedByUserId: userId,
      });

      return reply.code(202).send({
        status: "queued",
        scheduledRunId: result.scheduledRunId,
        jobId: result.jobId,
      });
    },
  );

  fastify.get(
    "/scheduled-runs",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      if (!params.success)
        return sendValidationError(reply, params.error.issues);

      const query = listRunsQuerySchema.safeParse(request.query);
      if (!query.success) return sendValidationError(reply, query.error.issues);

      const { workspaceId } = params.data;
      const userId = request.user.sub;
      const role = await getMemberRole(fastify.db, workspaceId, userId);
      if (!role) return forbidden(reply);

      const rows = await fastify.db
        .select()
        .from(scheduledRuns)
        .where(eq(scheduledRuns.workspaceId, workspaceId))
        .orderBy(desc(scheduledRuns.startedAt))
        .limit(query.data.limit);

      return reply.send({
        data: rows.map((row) => ({
          id: row.id,
          taskId: row.taskId,
          workspaceId: row.workspaceId,
          agentRunId: row.agentRunId,
          triggeredBy: row.triggeredBy,
          status: row.status,
          decisionCount: row.decisionCount,
          tokensIn: row.tokensIn,
          tokensOut: row.tokensOut,
          costUsd: String(row.costUsd),
          diagnostics: row.diagnosticsJson ?? null,
          startedAt: row.startedAt.toISOString(),
          completedAt: row.completedAt?.toISOString() ?? null,
        })),
      });
    },
  );
};

export default scheduledAgentRoutes;
