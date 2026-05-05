import {
  JOB_NAMES,
  QUEUE_NAMES,
  type QueueKey,
  type SystemPipelineDto,
  type SystemPipelineQueueCounts,
  type SystemPipelineRecentIngestion,
  type SystemPipelineStage,
  type SystemPipelineStatus,
} from "@wekiflow/shared";
import type { QueueRuntimeSummary } from "./queue-summary.js";

export interface RecentIngestionRow {
  id: string;
  sourceName: string;
  titleHint: string | null;
  status: SystemPipelineRecentIngestion["status"];
  receivedAt: Date;
}

interface PipelineStageDefinition {
  key: SystemPipelineStage["key"];
  label: string;
  description: string;
  queueKeys: QueueKey[];
  jobNames: string[];
}

export const PIPELINE_QUEUE_KEYS: QueueKey[] = [
  QUEUE_NAMES.INGESTION,
  QUEUE_NAMES.PATCH,
  QUEUE_NAMES.REFORMAT,
  QUEUE_NAMES.PUBLISH,
  QUEUE_NAMES.SEARCH,
  QUEUE_NAMES.LINKS,
  QUEUE_NAMES.EXTRACTION,
];

const STAGE_DEFINITIONS: PipelineStageDefinition[] = [
  {
    key: "receive",
    label: "Receive",
    description: "Raw external signals are persisted and queued.",
    queueKeys: [QUEUE_NAMES.INGESTION],
    jobNames: [JOB_NAMES.ROUTE_CLASSIFIER],
  },
  {
    key: "classify",
    label: "Classify",
    description: "Route decisions select create, update, append, or review.",
    queueKeys: [QUEUE_NAMES.INGESTION],
    jobNames: [JOB_NAMES.ROUTE_CLASSIFIER],
  },
  {
    key: "integrate",
    label: "Integrate",
    description: "Patch generation merges selected signals into drafts.",
    queueKeys: [QUEUE_NAMES.PATCH],
    jobNames: [JOB_NAMES.PATCH_GENERATOR],
  },
  {
    key: "reformat",
    label: "Reformat",
    description: "Approved cleanup jobs normalize Markdown structure.",
    queueKeys: [QUEUE_NAMES.REFORMAT],
    jobNames: [JOB_NAMES.CONTENT_REFORMATTER],
  },
  {
    key: "apply",
    label: "Apply",
    description: "Published snapshots are rendered for readers.",
    queueKeys: [QUEUE_NAMES.PUBLISH],
    jobNames: [JOB_NAMES.PUBLISH_RENDERER],
  },
  {
    key: "index",
    label: "Index",
    description: "Search indexes are refreshed after content changes.",
    queueKeys: [QUEUE_NAMES.SEARCH],
    jobNames: [JOB_NAMES.SEARCH_INDEX_UPDATER],
  },
  {
    key: "connect",
    label: "Connect",
    description: "Triples, backlinks, and entity links are extracted for the graph.",
    queueKeys: [QUEUE_NAMES.EXTRACTION, QUEUE_NAMES.LINKS],
    jobNames: [JOB_NAMES.TRIPLE_EXTRACTOR, JOB_NAMES.PAGE_LINK_EXTRACTOR],
  },
];

export function emptyCounts(): SystemPipelineQueueCounts {
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

export function aggregateCounts(
  queueKeys: QueueKey[],
  queueSummaries: Map<QueueKey, QueueRuntimeSummary>,
): SystemPipelineQueueCounts {
  const counts = emptyCounts();
  for (const key of queueKeys) {
    const queueCounts = queueSummaries.get(key)?.counts;
    if (!queueCounts) continue;
    counts.waiting += queueCounts.waiting;
    counts.active += queueCounts.active;
    counts.completed += queueCounts.completed;
    counts.failed += queueCounts.failed;
    counts.delayed += queueCounts.delayed;
    counts.paused += queueCounts.paused;
    counts.stalled += queueCounts.stalled;
  }
  return counts;
}

export function statusFromCounts(
  counts: SystemPipelineQueueCounts,
  isPaused: boolean,
): SystemPipelineStatus {
  if (counts.failed > 0 || counts.stalled > 0) return "degraded";
  if (isPaused || counts.paused > 0) return "paused";
  if (counts.active > 0 || counts.waiting > 0 || counts.delayed > 0) {
    return "busy";
  }
  return "healthy";
}

function overallStatus(stages: SystemPipelineStage[]): SystemPipelineStatus {
  if (stages.some((stage) => stage.status === "degraded")) return "degraded";
  if (stages.some((stage) => stage.status === "paused")) return "paused";
  if (stages.some((stage) => stage.status === "busy")) return "busy";
  return "healthy";
}

export function buildPipelineSummary(input: {
  workspaceId: string;
  generatedAt: Date;
  queueSummaries: Map<QueueKey, QueueRuntimeSummary>;
  pendingIngestionCount: number;
  recentIngestions: RecentIngestionRow[];
}): SystemPipelineDto {
  const stages = STAGE_DEFINITIONS.map((definition) => {
    const counts = aggregateCounts(definition.queueKeys, input.queueSummaries);
    const isPaused = definition.queueKeys.some(
      (key) => input.queueSummaries.get(key)?.isPaused ?? false,
    );
    const stalledCountCapped = definition.queueKeys.some(
      (key) => input.queueSummaries.get(key)?.stalledCountCapped ?? false,
    );

    return {
      ...definition,
      counts,
      status: statusFromCounts(counts, isPaused),
      isPaused,
      stalledCountCapped,
      recentIngestions:
        definition.key === "receive"
          ? input.recentIngestions.map((row) => ({
              id: row.id,
              sourceName: row.sourceName,
              titleHint: row.titleHint,
              status: row.status,
              receivedAt: row.receivedAt.toISOString(),
            }))
          : [],
    };
  });

  const totals = aggregateCounts(PIPELINE_QUEUE_KEYS, input.queueSummaries);

  return {
    workspaceId: input.workspaceId,
    generatedAt: input.generatedAt.toISOString(),
    overallStatus: overallStatus(stages),
    pendingIngestionCount: input.pendingIngestionCount,
    totals,
    stages,
  };
}
