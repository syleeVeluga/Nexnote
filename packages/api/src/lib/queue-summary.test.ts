import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Job, Queue } from "bullmq";
import {
  collectWorkspaceQueueSummary,
  STALLED_AGE_MS,
} from "./queue-summary.js";

type CountedQueueState =
  | "waiting"
  | "active"
  | "completed"
  | "failed"
  | "delayed"
  | "paused";

function job(
  workspaceId: string | null,
  overrides: Partial<Job> = {},
): Job {
  return {
    data: workspaceId ? { workspaceId } : {},
    timestamp: Date.now(),
    ...overrides,
  } as Job;
}

function queue(
  jobsByState: Partial<Record<CountedQueueState, Job[]>>,
  paused = false,
): Queue {
  return {
    name: "ingestion",
    isPaused: async () => paused,
    getJobCounts: async (...states: CountedQueueState[]) =>
      Object.fromEntries(
        states.map((state) => [state, jobsByState[state]?.length ?? 0]),
      ),
    getJobs: async (states: CountedQueueState[], start: number, end: number) =>
      states.flatMap((state) => jobsByState[state] ?? []).slice(start, end + 1),
  } as unknown as Queue;
}

describe("collectWorkspaceQueueSummary", () => {
  it("counts only jobs that belong to the requested workspace", async () => {
    const workspaceId = "00000000-0000-0000-0000-000000000001";
    const otherWorkspaceId = "00000000-0000-0000-0000-000000000002";
    const stalledAt = Date.now() - STALLED_AGE_MS - 1_000;

    const summary = await collectWorkspaceQueueSummary(
      queue(
        {
          waiting: [job(otherWorkspaceId)],
          active: [
            job(workspaceId, { processedOn: stalledAt }),
            job(otherWorkspaceId, { processedOn: stalledAt }),
          ],
          failed: [job(workspaceId), job(otherWorkspaceId), job(null)],
          delayed: [job(workspaceId)],
          completed: [job(otherWorkspaceId)],
        },
        true,
      ),
      workspaceId,
    );

    assert.equal(summary.counts.waiting, 0);
    assert.equal(summary.counts.active, 1);
    assert.equal(summary.counts.stalled, 1);
    assert.equal(summary.counts.failed, 1);
    assert.equal(summary.counts.delayed, 1);
    assert.equal(summary.counts.completed, 0);
    assert.equal(summary.isPaused, true);
  });
});
