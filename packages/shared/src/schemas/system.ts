import { z } from "zod";
import { INGESTION_STATUSES, QUEUE_KEYS } from "../constants/index.js";
import { uuidSchema } from "./common.js";

export const SYSTEM_PIPELINE_STAGE_KEYS = [
  "receive",
  "classify",
  "integrate",
  "reformat",
  "apply",
  "index",
  "connect",
] as const;

export const SYSTEM_PIPELINE_STATUSES = [
  "healthy",
  "busy",
  "paused",
  "degraded",
] as const;

export const systemPipelineStatusSchema = z.enum(SYSTEM_PIPELINE_STATUSES);
export type SystemPipelineStatus = z.infer<typeof systemPipelineStatusSchema>;

export const systemPipelineQueueCountsSchema = z.object({
  waiting: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  delayed: z.number().int().nonnegative(),
  paused: z.number().int().nonnegative(),
  stalled: z.number().int().nonnegative(),
});
export type SystemPipelineQueueCounts = z.infer<
  typeof systemPipelineQueueCountsSchema
>;

export const systemPipelineRecentIngestionSchema = z.object({
  id: uuidSchema,
  sourceName: z.string(),
  titleHint: z.string().nullable(),
  status: z.enum(INGESTION_STATUSES),
  receivedAt: z.string().datetime(),
});
export type SystemPipelineRecentIngestion = z.infer<
  typeof systemPipelineRecentIngestionSchema
>;

export const systemPipelineStageSchema = z.object({
  key: z.enum(SYSTEM_PIPELINE_STAGE_KEYS),
  label: z.string(),
  description: z.string(),
  queueKeys: z.array(z.enum(QUEUE_KEYS)),
  jobNames: z.array(z.string()),
  counts: systemPipelineQueueCountsSchema,
  status: systemPipelineStatusSchema,
  isPaused: z.boolean(),
  stalledCountCapped: z.boolean(),
  recentIngestions: z.array(systemPipelineRecentIngestionSchema),
});
export type SystemPipelineStage = z.infer<typeof systemPipelineStageSchema>;

export const systemPipelineDtoSchema = z.object({
  workspaceId: uuidSchema,
  generatedAt: z.string().datetime(),
  overallStatus: systemPipelineStatusSchema,
  pendingIngestionCount: z.number().int().nonnegative(),
  totals: systemPipelineQueueCountsSchema,
  stages: z.array(systemPipelineStageSchema),
});
export type SystemPipelineDto = z.infer<typeof systemPipelineDtoSchema>;
