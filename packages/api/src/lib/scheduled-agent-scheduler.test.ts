import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Queue } from "bullmq";
import { JOB_NAMES, type ScheduledAgentJobData } from "@wekiflow/shared";
import {
  readScheduledTaskNextRunAt,
  registerScheduledTaskScheduler,
  removeScheduledTaskScheduler,
  scheduledTaskSchedulerId,
} from "./scheduled-agent-scheduler.js";

const workspaceId = "00000000-0000-0000-0000-000000000001";
const taskId = "00000000-0000-0000-0000-000000000002";

describe("scheduled agent scheduler helpers", () => {
  it("builds deterministic scheduler ids", () => {
    assert.equal(
      scheduledTaskSchedulerId(workspaceId, taskId),
      `scheduled-task:${workspaceId}:${taskId}`,
    );
  });

  it("registers a BullMQ scheduler with task-only job data", async () => {
    const captures: Array<{
      id: string;
      repeat: { pattern: string };
      template: {
        name?: string;
        data?: ScheduledAgentJobData;
      };
    }> = [];
    const queue = {
      upsertJobScheduler: async (
        id: string,
        repeat: { pattern: string },
        template: { name?: string; data?: ScheduledAgentJobData },
      ) => {
        captures.push({ id, repeat, template });
        return { timestamp: Date.UTC(2026, 0, 1, 1, 0, 0) };
      },
    } as unknown as Queue<ScheduledAgentJobData>;

    const result = await registerScheduledTaskScheduler({
      queue,
      task: {
        id: taskId,
        workspaceId,
        cronExpression: "0 * * * *",
        enabled: true,
      },
    });

    assert.equal(result.schedulerId, scheduledTaskSchedulerId(workspaceId, taskId));
    const registered = captures[0];
    assert.ok(registered);
    assert.equal(registered.id, scheduledTaskSchedulerId(workspaceId, taskId));
    assert.deepEqual(registered.repeat, { pattern: "0 * * * *" });
    assert.equal(registered.template.name, JOB_NAMES.SCHEDULED_AGENT);
    assert.deepEqual(registered.template.data, {
      workspaceId,
      taskId,
      triggeredBy: "cron",
    });
  });

  it("removes a scheduler by stored repeat key when present", async () => {
    let removedId: string | null = null;
    const queue = {
      removeJobScheduler: async (id: string) => {
        removedId = id;
        return true;
      },
    } as unknown as Queue<ScheduledAgentJobData>;

    const removed = await removeScheduledTaskScheduler({
      queue,
      workspaceId,
      taskId,
      bullRepeatKey: "custom-key",
    });

    assert.equal(removed, true);
    assert.equal(removedId, "custom-key");
  });

  it("reads next run time from BullMQ scheduler metadata", async () => {
    const next = Date.UTC(2026, 0, 1, 2, 0, 0);
    const queue = {
      getJobScheduler: async (id: string) => ({
        key: id,
        name: JOB_NAMES.SCHEDULED_AGENT,
        next,
      }),
    } as unknown as Queue<ScheduledAgentJobData>;

    const nextRunAt = await readScheduledTaskNextRunAt({
      queue,
      workspaceId,
      taskId,
    });

    assert.equal(nextRunAt, new Date(next).toISOString());
  });
});
