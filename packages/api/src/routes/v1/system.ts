import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { ingestions } from "@wekiflow/db";
import { systemPipelineDtoSchema } from "@wekiflow/shared";
import {
  ADMIN_PLUS_ROLES,
  forbidden,
  getMemberRole,
  insufficientRole,
  workspaceParamsSchema,
} from "../../lib/workspace-auth.js";
import { sendValidationError } from "../../lib/reply-helpers.js";
import {
  collectWorkspaceQueueSummary,
  emptyQueueSummary,
  queueFromFastify,
} from "../../lib/queue-summary.js";
import {
  buildPipelineSummary,
  PIPELINE_QUEUE_KEYS,
  type RecentIngestionRow,
} from "../../lib/pipeline-summary.js";

const RECENT_INGESTION_LIMIT = 5;

const systemRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/pipeline", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error.issues);

    const { workspaceId } = params.data;
    const role = await getMemberRole(fastify.db, workspaceId, request.user.sub);
    if (!role) return forbidden(reply);
    if (!ADMIN_PLUS_ROLES.includes(role)) return insufficientRole(reply);

    const [queueSummaries, [pendingCountRow], recentIngestions] =
      await Promise.all([
        Promise.all(
          PIPELINE_QUEUE_KEYS.map(async (key) => {
            const queue = queueFromFastify(fastify, key);
            const summary = queue
              ? await collectWorkspaceQueueSummary(queue, workspaceId)
              : emptyQueueSummary(key);
            return [key, summary] as const;
          }),
        ),
        fastify.db
          .select({ count: count() })
          .from(ingestions)
          .where(
            and(
              eq(ingestions.workspaceId, workspaceId),
              inArray(ingestions.status, ["pending", "processing"]),
            ),
          ),
        fastify.db
          .select({
            id: ingestions.id,
            sourceName: ingestions.sourceName,
            titleHint: ingestions.titleHint,
            status: ingestions.status,
            receivedAt: ingestions.receivedAt,
          })
          .from(ingestions)
          .where(
            and(
              eq(ingestions.workspaceId, workspaceId),
              inArray(ingestions.status, ["pending", "processing"]),
            ),
          )
          .orderBy(desc(ingestions.receivedAt))
          .limit(RECENT_INGESTION_LIMIT),
      ]);

    const dto = buildPipelineSummary({
      workspaceId,
      generatedAt: new Date(),
      queueSummaries: new Map(queueSummaries),
      pendingIngestionCount: pendingCountRow?.count ?? 0,
      recentIngestions: recentIngestions as RecentIngestionRow[],
    });

    return reply.send(systemPipelineDtoSchema.parse(dto));
  });
};

export default systemRoutes;
