import type { FastifyPluginAsync } from "fastify";
import type { Job, Queue } from "bullmq";
import { z } from "zod";
import {
  uuidSchema,
  ERROR_CODES,
  QUEUE_KEYS,
  type QueueKey,
} from "@nexnote/shared";
import {
  getMemberRole,
  forbidden,
  insufficientRole,
  ADMIN_PLUS_ROLES,
  workspaceParamsSchema,
} from "../../lib/workspace-auth.js";
import { sendValidationError } from "../../lib/reply-helpers.js";

const queueNameParamSchema = z.object({
  workspaceId: uuidSchema,
  queueName: z.enum(QUEUE_KEYS),
});

const jobParamSchema = z.object({
  workspaceId: uuidSchema,
  queueName: z.enum(QUEUE_KEYS),
  jobId: z.string().min(1).max(200),
});

function queueFromFastify(
  fastify: { queues: Record<QueueKey, Queue> },
  key: QueueKey,
): Queue {
  return fastify.queues[key];
}

function jobDataWorkspaceId(job: Job): string | null {
  const data = job.data as { workspaceId?: unknown } | null;
  return data && typeof data.workspaceId === "string" ? data.workspaceId : null;
}

function serializeJob(job: Job) {
  const data = job.data as Record<string, unknown> | null;
  const read = (key: string): string | null =>
    data && typeof data[key] === "string" ? (data[key] as string) : null;

  return {
    id: job.id ?? null,
    name: job.name,
    attemptsMade: job.attemptsMade ?? 0,
    maxAttempts: job.opts?.attempts ?? null,
    failedReason: job.failedReason ?? null,
    stackFirstLine: job.stacktrace?.[0]?.split("\n")[0] ?? null,
    timestamp: job.timestamp ? new Date(job.timestamp).toISOString() : null,
    processedOn: job.processedOn
      ? new Date(job.processedOn).toISOString()
      : null,
    finishedOn: job.finishedOn
      ? new Date(job.finishedOn).toISOString()
      : null,
    workspaceId: read("workspaceId"),
    ingestionId: read("ingestionId"),
    pageId: read("pageId"),
  };
}

// BullMQ's native "stalled" state only fires when a worker crashes mid-job.
// For operator visibility we surface any job that's been active longer than
// this threshold as suspect, independent of BullMQ's own stall detection.
const STALLED_AGE_MS = 2 * 60 * 1000;

function isStalled(job: Job, now: number): boolean {
  const started = job.processedOn ?? job.timestamp;
  return !!started && now - started > STALLED_AGE_MS;
}

async function collectQueueSummary(queue: Queue) {
  const [counts, isPaused] = await Promise.all([
    queue.getJobCounts(
      "waiting",
      "active",
      "completed",
      "failed",
      "delayed",
      "paused",
    ),
    queue.isPaused(),
  ]);

  let stalledCount = 0;
  if ((counts.active ?? 0) > 0) {
    const activeJobs = await queue.getJobs(["active"], 0, 49);
    const now = Date.now();
    stalledCount = activeJobs.filter((j) => isStalled(j, now)).length;
  }

  return {
    name: queue.name,
    counts: {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
      paused: counts.paused ?? 0,
      stalled: stalledCount,
    },
    isPaused,
  };
}

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

      const summaries = await Promise.all(
        QUEUE_KEYS.map((key) => collectQueueSummary(queueFromFastify(fastify, key))),
      );

      return reply.send({
        queues: QUEUE_KEYS.map((key, i) => ({
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
      const jobs = await queue.getFailed(0, 49);

      const items = jobs
        .map(serializeJob)
        .filter(
          (j) => j.workspaceId === null || j.workspaceId === workspaceId,
        );

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
      const jobs = await queue.getJobs(["active"], 0, 49);

      const now = Date.now();
      const items = jobs
        .filter((j) => isStalled(j, now))
        .map(serializeJob)
        .filter(
          (j) => j.workspaceId === null || j.workspaceId === workspaceId,
        );

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
