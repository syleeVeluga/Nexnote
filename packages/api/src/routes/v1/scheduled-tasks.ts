import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  ERROR_CODES,
  paginationSchema,
  scheduledTaskBodySchema,
  updateScheduledTaskBodySchema,
  uuidSchema,
} from "@wekiflow/shared";
import {
  auditLogs,
  pages,
  scheduledTasks,
  workspaces,
  type ScheduledTask,
} from "@wekiflow/db";
import {
  ADMIN_PLUS_ROLES,
  forbidden,
  getMemberRole,
  insufficientRole,
  workspaceParamsSchema,
} from "../../lib/workspace-auth.js";
import { sendValidationError } from "../../lib/reply-helpers.js";
import {
  readScheduledTaskNextRunAt,
  registerScheduledTaskScheduler,
  removeScheduledTaskScheduler,
} from "../../lib/scheduled-agent-scheduler.js";
import { validateScheduledCronExpression } from "../../lib/scheduled-cron.js";

const taskParamsSchema = workspaceParamsSchema.extend({
  taskId: uuidSchema,
});

const listQuerySchema = paginationSchema;

function schedulerUnavailable(reply: FastifyReply, details: unknown) {
  return reply.code(503).send({
    error: "Scheduled task scheduler unavailable",
    code: "SCHEDULED_TASK_SCHEDULER_UNAVAILABLE",
    details: details instanceof Error ? details.message : String(details),
  });
}

async function requireAdmin(
  fastify: Parameters<FastifyPluginAsync>[0],
  workspaceId: string,
  userId: string,
  reply: FastifyReply,
): Promise<boolean> {
  const role = await getMemberRole(fastify.db, workspaceId, userId);
  if (!role) {
    forbidden(reply);
    return false;
  }
  if (!ADMIN_PLUS_ROLES.includes(role)) {
    insufficientRole(reply);
    return false;
  }
  return true;
}

async function assertScheduledEnabled(
  fastify: Parameters<FastifyPluginAsync>[0],
  workspaceId: string,
  reply: FastifyReply,
): Promise<boolean> {
  const [workspace] = await fastify.db
    .select({ scheduledEnabled: workspaces.scheduledEnabled })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!workspace?.scheduledEnabled) {
    reply.code(403).send({
      error: "Scheduled agent is disabled for this workspace",
      code: ERROR_CODES.SCHEDULED_AGENT_DISABLED,
    });
    return false;
  }
  return true;
}

async function validateActiveTargetPages(input: {
  db: Parameters<FastifyPluginAsync>[0]["db"];
  workspaceId: string;
  pageIds: string[];
  reply: FastifyReply;
}): Promise<string[] | null> {
  const uniquePageIds = [...new Set(input.pageIds)];
  const rows = await input.db
    .select({ id: pages.id })
    .from(pages)
    .where(
      and(
        eq(pages.workspaceId, input.workspaceId),
        inArray(pages.id, uniquePageIds),
        isNull(pages.deletedAt),
      ),
    );
  if (rows.length !== uniquePageIds.length) {
    input.reply.code(400).send({
      error: "One or more target pages were not found",
      code: ERROR_CODES.PAGE_NOT_FOUND,
      details: {
        requested: uniquePageIds,
        found: rows.map((row) => row.id),
      },
    });
    return null;
  }
  return uniquePageIds;
}

function validateCronOrReply(cronExpression: string, reply: FastifyReply) {
  const validation = validateScheduledCronExpression(cronExpression);
  if (!validation.ok) {
    reply.code(400).send({
      error: "Invalid cron expression",
      code: "INVALID_CRON_EXPRESSION",
      details: validation.reason,
    });
    return false;
  }
  return true;
}

async function toScheduledTaskDto(
  fastify: Parameters<FastifyPluginAsync>[0],
  row: ScheduledTask,
) {
  const nextRunAt = row.enabled
    ? await readScheduledTaskNextRunAt({
        queue: fastify.queues["scheduled-agent-queue"],
        workspaceId: row.workspaceId,
        taskId: row.id,
        bullRepeatKey: row.bullRepeatKey,
      })
    : null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    cronExpression: row.cronExpression,
    targetPageIds: row.targetPageIds,
    includeDescendants: row.includeDescendants,
    instruction: row.instruction,
    enabled: row.enabled,
    bullRepeatKey: row.bullRepeatKey,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    nextRunAt,
  };
}

const scheduledTaskRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error.issues);
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error.issues);

    const { workspaceId } = params.data;
    if (!(await requireAdmin(fastify, workspaceId, request.user.sub, reply))) {
      return;
    }

    const where = eq(scheduledTasks.workspaceId, workspaceId);
    const [rows, [totalRow]] = await Promise.all([
      fastify.db
        .select()
        .from(scheduledTasks)
        .where(where)
        .orderBy(desc(scheduledTasks.updatedAt))
        .limit(query.data.limit)
        .offset(query.data.offset),
      fastify.db
        .select({ total: count() })
        .from(scheduledTasks)
        .where(where),
    ]);
    return reply.send({
      data: await Promise.all(
        rows.map((row) => toScheduledTaskDto(fastify, row)),
      ),
      total: totalRow.total,
      limit: query.data.limit,
      offset: query.data.offset,
    });
  });

  fastify.post("/", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error.issues);
    const body = scheduledTaskBodySchema.safeParse(request.body ?? {});
    if (!body.success) return sendValidationError(reply, body.error.issues);

    const { workspaceId } = params.data;
    const userId = request.user.sub;
    if (!(await requireAdmin(fastify, workspaceId, userId, reply))) return;
    if (!validateCronOrReply(body.data.cronExpression, reply)) return;
    if (
      body.data.enabled &&
      !(await assertScheduledEnabled(fastify, workspaceId, reply))
    ) {
      return;
    }
    const targetPageIds = await validateActiveTargetPages({
      db: fastify.db,
      workspaceId,
      pageIds: body.data.targetPageIds,
      reply,
    });
    if (!targetPageIds) return;

    const taskId = randomUUID();
    let registration: Awaited<
      ReturnType<typeof registerScheduledTaskScheduler>
    > | null = null;
    if (body.data.enabled) {
      try {
        registration = await registerScheduledTaskScheduler({
          queue: fastify.queues["scheduled-agent-queue"],
          task: {
            id: taskId,
            workspaceId,
            cronExpression: body.data.cronExpression,
            enabled: true,
          },
        });
      } catch (err) {
        return schedulerUnavailable(reply, err);
      }
    }

    let current: ScheduledTask;
    try {
      current = await fastify.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(scheduledTasks)
          .values({
            id: taskId,
            workspaceId,
            name: body.data.name,
            cronExpression: body.data.cronExpression,
            targetPageIds,
            includeDescendants: body.data.includeDescendants,
            instruction: body.data.instruction?.trim() || null,
            enabled: body.data.enabled,
            createdBy: userId,
            bullRepeatKey: registration?.schedulerId ?? null,
          })
          .returning();

        await tx.insert(auditLogs).values({
          workspaceId,
          userId,
          entityType: "scheduled_task",
          entityId: created.id,
          action: "create",
          afterJson: {
            name: created.name,
            cronExpression: created.cronExpression,
            enabled: created.enabled,
            targetPageIds: created.targetPageIds,
          },
        });

        return created;
      });
    } catch (err) {
      if (registration) {
        await removeScheduledTaskScheduler({
          queue: fastify.queues["scheduled-agent-queue"],
          workspaceId,
          taskId,
          bullRepeatKey: registration.schedulerId,
        }).catch(() => undefined);
      }
      throw err;
    }

    return reply.code(201).send({
      data: await toScheduledTaskDto(fastify, current),
    });
  });

  fastify.get("/:taskId", async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error.issues);
    const { workspaceId, taskId } = params.data;
    if (!(await requireAdmin(fastify, workspaceId, request.user.sub, reply))) {
      return;
    }
    const [task] = await fastify.db
      .select()
      .from(scheduledTasks)
      .where(
        and(
          eq(scheduledTasks.id, taskId),
          eq(scheduledTasks.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!task) {
      return reply.code(404).send({
        error: "Not found",
        code: ERROR_CODES.NOT_FOUND,
        details: "Scheduled task not found",
      });
    }
    return reply.send({ data: await toScheduledTaskDto(fastify, task) });
  });

  fastify.patch("/:taskId", async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error.issues);
    const body = updateScheduledTaskBodySchema.safeParse(request.body ?? {});
    if (!body.success) return sendValidationError(reply, body.error.issues);

    const { workspaceId, taskId } = params.data;
    const userId = request.user.sub;
    if (!(await requireAdmin(fastify, workspaceId, userId, reply))) return;

    const [existing] = await fastify.db
      .select()
      .from(scheduledTasks)
      .where(
        and(
          eq(scheduledTasks.id, taskId),
          eq(scheduledTasks.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!existing) {
      return reply.code(404).send({
        error: "Not found",
        code: ERROR_CODES.NOT_FOUND,
        details: "Scheduled task not found",
      });
    }

    const cronExpression = body.data.cronExpression ?? existing.cronExpression;
    if (!validateCronOrReply(cronExpression, reply)) return;
    const enabled = body.data.enabled ?? existing.enabled;
    if (enabled && !(await assertScheduledEnabled(fastify, workspaceId, reply))) {
      return;
    }
    const targetPageIds = body.data.targetPageIds
      ? await validateActiveTargetPages({
          db: fastify.db,
          workspaceId,
          pageIds: body.data.targetPageIds,
          reply,
        })
      : existing.targetPageIds;
    if (!targetPageIds) return;

    let registration: Awaited<
      ReturnType<typeof registerScheduledTaskScheduler>
    > | null = null;
    let removedScheduler = false;
    if (enabled) {
      try {
        registration = await registerScheduledTaskScheduler({
          queue: fastify.queues["scheduled-agent-queue"],
          task: {
            ...existing,
            cronExpression,
            enabled: true,
          },
        });
      } catch (err) {
        return schedulerUnavailable(reply, err);
      }
    } else if (existing.enabled || existing.bullRepeatKey) {
      try {
        await removeScheduledTaskScheduler({
          queue: fastify.queues["scheduled-agent-queue"],
          workspaceId,
          taskId,
          bullRepeatKey: existing.bullRepeatKey,
        });
        removedScheduler = true;
      } catch (err) {
        return schedulerUnavailable(reply, err);
      }
    }

    let current: ScheduledTask;
    try {
      current = await fastify.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(scheduledTasks)
          .set({
            ...(body.data.name !== undefined ? { name: body.data.name } : {}),
            cronExpression,
            targetPageIds,
            includeDescendants:
              body.data.includeDescendants ?? existing.includeDescendants,
            instruction:
              body.data.instruction === undefined
                ? existing.instruction
                : body.data.instruction?.trim() || null,
            enabled,
            bullRepeatKey: enabled ? registration?.schedulerId : null,
            updatedAt: new Date(),
          })
          .where(eq(scheduledTasks.id, taskId))
          .returning();

        await tx.insert(auditLogs).values({
          workspaceId,
          userId,
          entityType: "scheduled_task",
          entityId: taskId,
          action: "update",
          beforeJson: {
            name: existing.name,
            cronExpression: existing.cronExpression,
            enabled: existing.enabled,
            targetPageIds: existing.targetPageIds,
          },
          afterJson: {
            name: updated.name,
            cronExpression: updated.cronExpression,
            enabled: updated.enabled,
            targetPageIds: updated.targetPageIds,
          },
        });

        return updated;
      });
    } catch (err) {
      if (registration) {
        if (existing.enabled) {
          await registerScheduledTaskScheduler({
            queue: fastify.queues["scheduled-agent-queue"],
            task: existing,
          }).catch(() => undefined);
        } else {
          await removeScheduledTaskScheduler({
            queue: fastify.queues["scheduled-agent-queue"],
            workspaceId,
            taskId,
            bullRepeatKey: registration.schedulerId,
          }).catch(() => undefined);
        }
      } else if (removedScheduler && existing.enabled) {
        await registerScheduledTaskScheduler({
          queue: fastify.queues["scheduled-agent-queue"],
          task: existing,
        }).catch(() => undefined);
      }
      throw err;
    }

    return reply.send({ data: await toScheduledTaskDto(fastify, current) });
  });

  fastify.delete("/:taskId", async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error.issues);
    const { workspaceId, taskId } = params.data;
    const userId = request.user.sub;
    if (!(await requireAdmin(fastify, workspaceId, userId, reply))) return;

    const [existing] = await fastify.db
      .select()
      .from(scheduledTasks)
      .where(
        and(
          eq(scheduledTasks.id, taskId),
          eq(scheduledTasks.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!existing) {
      return reply.code(404).send({
        error: "Not found",
        code: ERROR_CODES.NOT_FOUND,
        details: "Scheduled task not found",
      });
    }

    if (existing.enabled || existing.bullRepeatKey) {
      try {
        await removeScheduledTaskScheduler({
          queue: fastify.queues["scheduled-agent-queue"],
          workspaceId,
          taskId,
          bullRepeatKey: existing.bullRepeatKey,
        });
      } catch (err) {
        return schedulerUnavailable(reply, err);
      }
    }

    try {
      await fastify.db.transaction(async (tx) => {
        await tx.delete(scheduledTasks).where(eq(scheduledTasks.id, taskId));
        await tx.insert(auditLogs).values({
          workspaceId,
          userId,
          entityType: "scheduled_task",
          entityId: taskId,
          action: "delete",
          beforeJson: {
            name: existing.name,
            cronExpression: existing.cronExpression,
            enabled: existing.enabled,
            targetPageIds: existing.targetPageIds,
          },
        });
      });
    } catch (err) {
      if (existing.enabled) {
        await registerScheduledTaskScheduler({
          queue: fastify.queues["scheduled-agent-queue"],
          task: existing,
        }).catch(() => undefined);
      }
      throw err;
    }

    return reply.code(204).send();
  });
};

export default scheduledTaskRoutes;
