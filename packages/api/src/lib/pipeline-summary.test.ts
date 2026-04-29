import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  QUEUE_NAMES,
  type QueueKey,
  type SystemPipelineQueueCounts,
} from "@wekiflow/shared";
import {
  buildPipelineSummary,
  emptyCounts,
  statusFromCounts,
} from "./pipeline-summary.js";
import type { QueueRuntimeSummary } from "./queue-summary.js";

function counts(
  overrides: Partial<SystemPipelineQueueCounts> = {},
): SystemPipelineQueueCounts {
  return { ...emptyCounts(), ...overrides };
}

function queueSummary(
  key: QueueKey,
  overrides: Partial<QueueRuntimeSummary> = {},
): QueueRuntimeSummary {
  return {
    name: key,
    counts: emptyCounts(),
    isPaused: false,
    stalledCountCapped: false,
    ...overrides,
  };
}

describe("statusFromCounts", () => {
  it("marks active or waiting stages as busy", () => {
    assert.equal(statusFromCounts(counts({ waiting: 1 }), false), "busy");
    assert.equal(statusFromCounts(counts({ active: 1 }), false), "busy");
  });

  it("prioritizes degraded state over pause and busy state", () => {
    assert.equal(
      statusFromCounts(counts({ failed: 1, waiting: 3 }), true),
      "degraded",
    );
    assert.equal(statusFromCounts(counts({ stalled: 1 }), false), "degraded");
  });

  it("marks paused queues separately from healthy queues", () => {
    assert.equal(statusFromCounts(counts(), true), "paused");
    assert.equal(statusFromCounts(counts(), false), "healthy");
  });
});

describe("buildPipelineSummary", () => {
  it("maps queue counts into product pipeline stages", () => {
    const queueSummaries = new Map<QueueKey, QueueRuntimeSummary>([
      [
        QUEUE_NAMES.INGESTION,
        queueSummary(QUEUE_NAMES.INGESTION, {
          counts: counts({ waiting: 2, active: 1 }),
        }),
      ],
      [
        QUEUE_NAMES.PATCH,
        queueSummary(QUEUE_NAMES.PATCH, {
          counts: counts({ failed: 1 }),
        }),
      ],
    ]);

    const dto = buildPipelineSummary({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      generatedAt: new Date("2026-04-29T00:00:00.000Z"),
      queueSummaries,
      pendingIngestionCount: 7,
      recentIngestions: [
        {
          id: "00000000-0000-0000-0000-000000000002",
          sourceName: "manual-paste",
          titleHint: "Pricing",
          status: "pending",
          receivedAt: new Date("2026-04-29T00:00:01.000Z"),
        },
      ],
    });

    assert.equal(dto.overallStatus, "degraded");
    assert.equal(dto.pendingIngestionCount, 7);
    assert.equal(dto.totals.waiting, 2);
    assert.equal(dto.totals.failed, 1);
    assert.equal(dto.stages.find((s) => s.key === "classify")?.status, "busy");
    assert.equal(
      dto.stages.find((s) => s.key === "integrate")?.status,
      "degraded",
    );
    assert.equal(
      dto.stages.find((s) => s.key === "receive")?.recentIngestions.length,
      1,
    );
  });
});
