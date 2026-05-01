import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import { scheduledRuns } from "@wekiflow/db";
import type { Database } from "@wekiflow/db";
import {
  DEFAULT_JOB_OPTIONS,
  JOB_NAMES,
  type ScheduledAgentJobData,
} from "@wekiflow/shared";

export async function enqueueScheduledAgentRun(input: {
  db: Database;
  queue: Queue<ScheduledAgentJobData>;
  workspaceId: string;
  triggeredBy: ScheduledAgentJobData["triggeredBy"];
  taskId?: string | null;
  pageIds?: string[];
  includeDescendants?: boolean;
  instruction?: string | null;
  requestedByUserId?: string | null;
}): Promise<{ scheduledRunId: string; jobId: string | null }> {
  const [run] = await input.db
    .insert(scheduledRuns)
    .values({
      taskId: input.taskId ?? null,
      workspaceId: input.workspaceId,
      triggeredBy: input.triggeredBy,
      status: "running",
    })
    .returning({ id: scheduledRuns.id });

  const job = await input.queue.add(
    JOB_NAMES.SCHEDULED_AGENT,
    {
      scheduledRunId: run.id,
      workspaceId: input.workspaceId,
      taskId: input.taskId ?? null,
      triggeredBy: input.triggeredBy,
      pageIds: input.pageIds,
      includeDescendants: input.includeDescendants,
      instruction: input.instruction ?? null,
      requestedByUserId: input.requestedByUserId ?? null,
    },
    {
      ...DEFAULT_JOB_OPTIONS,
      jobId: `scheduled-agent:${run.id}:${randomUUID()}`,
    },
  );

  return { scheduledRunId: run.id, jobId: job.id ?? null };
}
