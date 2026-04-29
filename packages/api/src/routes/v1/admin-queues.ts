import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { uuidSchema, ERROR_CODES, QUEUE_KEYS } from "@wekiflow/shared";
import {
  getMemberRole,
  forbidden,
  insufficientRole,
  ADMIN_PLUS_ROLES,
  workspaceParamsSchema,
} from "../../lib/workspace-auth.js";
import { sendValidationError } from "../../lib/reply-helpers.js";
import {
  collectQueueSummary,
  isRuntimeStalled,
  jobDataWorkspaceId,
  queueFromFastify,
  serializeJob,
} from "../../lib/queue-summary.js";

const queueNameParamSchema = z.object({
  workspaceId: uuidSchema,
  queueName: z.enum(QUEUE_KEYS),
});

const jobParamSchema = z.object({
  workspaceId: uuidSchema,
  queueName: z.enum(QUEUE_KEYS),
  jobId: z.string().min(1).max(200),
});

const adminQueueRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      if (!params.success) return sendValidationError(reply, params.error.issues);

      const { workspaceId } = params.data;
      const userId = request.user.sub;

      const role = await getMemberRole(fastify.db, workspaceId, userId);
      if (!role) return forbidden(reply);
      if (!ADMIN_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      // Skip queues that aren't currently registered (e.g. synthesis when
      // ENABLE_SYNTHESIS_WORKER is off) so the admin panel only reports
      // queues that actually exist in this deployment.
      const activeKeys = QUEUE_KEYS.filter(
        (key) => queueFromFastify(fastify, key) !== undefined,
      );
      const summaries = await Promise.all(
        activeKeys.map((key) =>
          collectQueueSummary(queueFromFastify(fastify, key)!),
        ),
      );

      return reply.send({
        queues: activeKeys.map((key, i) => ({
          key,
          ...summaries[i],
        })),
      });
    },
  );

  fastify.get(
    "/:queueName/failed",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = queueNameParamSchema.safeParse(request.params);
      if (!params.success) return sendValidationError(reply, params.error.issues);

      const { workspaceId, queueName } = params.data;
      const userId = request.user.sub;

      const role = await getMemberRole(fastify.db, workspaceId, userId);
      if (!role) return forbidden(reply);
      if (!ADMIN_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const queue = queueFromFastify(fastify, queueName);
      if (!queue) {
        return reply.code(404).send({
          error: "Queue not registered",
          code: ERROR_CODES.NOT_FOUND,
        });
      }
      const jobs = await queue.getFailed(0, 49);

      const items = jobs.map((job) => serializeJob(job, workspaceId));

      return reply.send({ queue: queueName, items });
    },
  );

  fastify.get(
    "/:queueName/stalled",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = queueNameParamSchema.safeParse(request.params);
      if (!params.success) return sendValidationError(reply, params.error.issues);

      const { workspaceId, queueName } = params.data;
      const userId = request.user.sub;

      const role = await getMemberRole(fastify.db, workspaceId, userId);
      if (!role) return forbidden(reply);
      if (!ADMIN_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const queue = queueFromFastify(fastify, queueName);
      if (!queue) {
        return reply.code(404).send({
          error: "Queue not registered",
          code: ERROR_CODES.NOT_FOUND,
        });
      }
      const jobs = await queue.getJobs(["active"], 0, 49);

      const now = Date.now();
      const items = jobs
        .filter((j) => isRuntimeStalled(j, now))
        .map((job) => serializeJob(job, workspaceId));

      return reply.send({ queue: queueName, items });
    },
  );

  fastify.post(
    "/:queueName/jobs/:jobId/retry",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = jobParamSchema.safeParse(request.params);
      if (!params.success) return sendValidationError(reply, params.error.issues);

      const { workspaceId, queueName, jobId } = params.data;
      const userId = request.user.sub;

      const role = await getMemberRole(fastify.db, workspaceId, userId);
      if (!role) return forbidden(reply);
      if (!ADMIN_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const queue = queueFromFastify(fastify, queueName);
      if (!queue) {
        return reply.code(404).send({
          error: "Queue not registered",
          code: ERROR_CODES.NOT_FOUND,
        });
      }
      const job = await queue.getJob(jobId);
      if (!job) {
        return reply.code(404).send({
          error: "Not found",
          code: ERROR_CODES.NOT_FOUND,
          details: "Job not found",
        });
      }

      const jobWorkspaceId = jobDataWorkspaceId(job);
      if (jobWorkspaceId && jobWorkspaceId !== workspaceId) {
        return forbidden(reply);
      }

      await job.retry();
      return reply.send({ status: "retried", jobId });
    },
  );

  fastify.post(
    "/:queueName/jobs/:jobId/remove",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = jobParamSchema.safeParse(request.params);
      if (!params.success) return sendValidationError(reply, params.error.issues);

      const { workspaceId, queueName, jobId } = params.data;
      const userId = request.user.sub;

      const role = await getMemberRole(fastify.db, workspaceId, userId);
      if (!role) return forbidden(reply);
      if (!ADMIN_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const queue = queueFromFastify(fastify, queueName);
      if (!queue) {
        return reply.code(404).send({
          error: "Queue not registered",
          code: ERROR_CODES.NOT_FOUND,
        });
      }
      const job = await queue.getJob(jobId);
      if (!job) {
        return reply.code(404).send({
          error: "Not found",
          code: ERROR_CODES.NOT_FOUND,
          details: "Job not found",
        });
      }

      const jobWorkspaceId = jobDataWorkspaceId(job);
      if (jobWorkspaceId && jobWorkspaceId !== workspaceId) {
        return forbidden(reply);
      }

      await job.remove();
      return reply.send({ status: "removed", jobId });
    },
  );
};

export default adminQueueRoutes;
