import type { Job, Queue } from "bullmq";
import type { QueueKey } from "@wekiflow/shared";

export interface QueueRuntimeCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
  stalled: number;
}

export interface QueueRuntimeSummary {
  name: string;
  counts: QueueRuntimeCounts;
  stalledCountCapped: boolean;
  isPaused: boolean;
}

type CountedQueueState = Exclude<keyof QueueRuntimeCounts, "stalled">;

const COUNTED_QUEUE_STATES: CountedQueueState[] = [
  "waiting",
  "active",
  "completed",
  "failed",
  "delayed",
  "paused",
];

const STALLED_SAMPLE_CAP = 500;
const WORKSPACE_STATE_SCAN_CAP = 1_000;
const WORKSPACE_STATE_PAGE_SIZE = 100;

function emptyRuntimeCounts(): QueueRuntimeCounts {
  return {
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
    paused: 0,
    stalled: 0,
  };
}

export function queueFromFastify(
  fastify: { queues: Partial<Record<QueueKey, Queue>> },
  key: QueueKey,
): Queue | undefined {
  return fastify.queues[key];
}

export function jobDataWorkspaceId(job: Job): string | null {
  const data = job.data as { workspaceId?: unknown } | null;
  return data && typeof data.workspaceId === "string" ? data.workspaceId : null;
}

export function serializeJob(job: Job, viewerWorkspaceId: string) {
  const data = job.data as Record<string, unknown> | null;
  const read = (key: string): string | null =>
    data && typeof data[key] === "string" ? (data[key] as string) : null;

  const jobWorkspaceId = read("workspaceId");

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
    finishedOn: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    workspaceId: jobWorkspaceId,
    ingestionId: read("ingestionId"),
    pageId: read("pageId"),
    isCrossWorkspace:
      jobWorkspaceId !== null && jobWorkspaceId !== viewerWorkspaceId,
  };
}

// BullMQ's native "stalled" state only fires when a worker crashes mid-job.
// We also surface jobs that have been active longer than this threshold.
export const STALLED_AGE_MS = 2 * 60 * 1000;

export function isRuntimeStalled(job: Job, now: number): boolean {
  const started = job.processedOn ?? job.timestamp;
  return !!started && now - started > STALLED_AGE_MS;
}

export async function collectQueueSummary(
  queue: Queue,
): Promise<QueueRuntimeSummary> {
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
  let stalledCountCapped = false;
  const activeCount = counts.active ?? 0;
  if (activeCount > 0) {
    const now = Date.now();
    const pageSize = 100;
    const cap = Math.min(activeCount, STALLED_SAMPLE_CAP);
    stalledCountCapped = activeCount > STALLED_SAMPLE_CAP;

    for (let start = 0; start < cap; start += pageSize) {
      const end = Math.min(start + pageSize - 1, cap - 1);
      const activeJobs = await queue.getJobs(["active"], start, end);
      if (activeJobs.length === 0) break;
      stalledCount += activeJobs.filter((j) => isRuntimeStalled(j, now)).length;
      if (activeJobs.length < end - start + 1) break;
    }
  }

  return {
    name: queue.name,
    counts: {
      waiting: counts.waiting ?? 0,
      active: activeCount,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
      paused: counts.paused ?? 0,
      stalled: stalledCount,
    },
    stalledCountCapped,
    isPaused,
  };
}

export async function collectWorkspaceQueueSummary(
  queue: Queue,
  workspaceId: string,
): Promise<QueueRuntimeSummary> {
  const [globalCounts, isPaused] = await Promise.all([
    queue.getJobCounts(...COUNTED_QUEUE_STATES),
    queue.isPaused(),
  ]);
  const counts = emptyRuntimeCounts();
  const now = Date.now();
  let stalledCountCapped = false;

  await Promise.all(
    COUNTED_QUEUE_STATES.map(async (state) => {
      const globalStateCount = globalCounts[state] ?? 0;
      const scanLimit = Math.min(globalStateCount, WORKSPACE_STATE_SCAN_CAP);
      if (scanLimit === 0) return;
      if (state === "active" && globalStateCount > WORKSPACE_STATE_SCAN_CAP) {
        stalledCountCapped = true;
      }

      for (let start = 0; start < scanLimit; start += WORKSPACE_STATE_PAGE_SIZE) {
        const end = Math.min(
          start + WORKSPACE_STATE_PAGE_SIZE - 1,
          scanLimit - 1,
        );
        const jobs = await queue.getJobs([state], start, end);
        if (jobs.length === 0) break;

        for (const job of jobs) {
          if (jobDataWorkspaceId(job) !== workspaceId) continue;
          counts[state] += 1;
          if (state === "active" && isRuntimeStalled(job, now)) {
            counts.stalled += 1;
          }
        }

        if (jobs.length < end - start + 1) break;
      }
    }),
  );

  return {
    name: queue.name,
    counts,
    stalledCountCapped,
    isPaused,
  };
}

export function emptyQueueSummary(name: string): QueueRuntimeSummary {
  return {
    name,
    counts: emptyRuntimeCounts(),
    stalledCountCapped: false,
    isPaused: false,
  };
}
