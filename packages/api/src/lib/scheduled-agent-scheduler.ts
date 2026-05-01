import type { Queue } from "bullmq";
import { eq, and } from "drizzle-orm";
import { scheduledTasks, type Database, type ScheduledTask } from "@wekiflow/db";
import {
  DEFAULT_JOB_OPTIONS,
  JOB_NAMES,
  type ScheduledAgentJobData,
} from "@wekiflow/shared";

export function scheduledTaskSchedulerId(
  workspaceId: string,
  taskId: string,
): string {
  return `scheduled-task:${workspaceId}:${taskId}`;
}

export async function registerScheduledTaskScheduler(input: {
  queue: Queue<ScheduledAgentJobData>;
  task: Pick<
    ScheduledTask,
    "id" | "workspaceId" | "cronExpression" | "enabled"
  >;
}): Promise<{ schedulerId: string; nextRunAt: string | null }> {
  const schedulerId = scheduledTaskSchedulerId(
    input.task.workspaceId,
    input.task.id,
  );
  const job = await input.queue.upsertJobScheduler(
    schedulerId,
    { pattern: input.task.cronExpression },
    {
      name: JOB_NAMES.SCHEDULED_AGENT,
      data: {
        workspaceId: input.task.workspaceId,
        taskId: input.task.id,
        triggeredBy: "cron",
      },
      opts: DEFAULT_JOB_OPTIONS,
    },
  );
  return {
    schedulerId,
    nextRunAt:
      typeof job.timestamp === "number"
        ? new Date(job.timestamp).toISOString()
        : null,
  };
}

export async function removeScheduledTaskScheduler(input: {
  queue: Queue<ScheduledAgentJobData>;
  workspaceId: string;
  taskId: string;
  bullRepeatKey?: string | null;
}): Promise<boolean> {
  return input.queue.removeJobScheduler(
    input.bullRepeatKey ??
      scheduledTaskSchedulerId(input.workspaceId, input.taskId),
  );
}

export async function readScheduledTaskNextRunAt(input: {
  queue: Queue<ScheduledAgentJobData>;
  workspaceId: string;
  taskId: string;
  bullRepeatKey?: string | null;
}): Promise<string | null> {
  try {
    const scheduler = await input.queue.getJobScheduler(
      input.bullRepeatKey ??
        scheduledTaskSchedulerId(input.workspaceId, input.taskId),
    );
    return scheduler?.next ? new Date(scheduler.next).toISOString() : null;
  } catch {
    return null;
  }
}

export async function syncWorkspaceScheduledTaskSchedulers(input: {
  db: Database;
  queue: Queue<ScheduledAgentJobData>;
  workspaceId: string;
  scheduledEnabled: boolean;
}): Promise<void> {
  const tasks = await input.db
    .select()
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.workspaceId, input.workspaceId),
        eq(scheduledTasks.enabled, true),
      ),
    );

  for (const task of tasks) {
    if (input.scheduledEnabled) {
      const registration = await registerScheduledTaskScheduler({
        queue: input.queue,
        task,
      });
      await input.db
        .update(scheduledTasks)
        .set({ bullRepeatKey: registration.schedulerId, updatedAt: new Date() })
        .where(eq(scheduledTasks.id, task.id));
    } else {
      await removeScheduledTaskScheduler({
        queue: input.queue,
        workspaceId: input.workspaceId,
        taskId: task.id,
        bullRepeatKey: task.bullRepeatKey,
      });
      await input.db
        .update(scheduledTasks)
        .set({ bullRepeatKey: null, updatedAt: new Date() })
        .where(eq(scheduledTasks.id, task.id));
    }
  }
}
