import { z } from "zod";
import { slugSchema, uuidSchema } from "./common.js";
import {
  AGENT_MODEL_PRESETS,
  AI_PROVIDERS,
  INGESTION_MODES,
  WORKSPACE_ROLES,
} from "../constants/index.js";

const optionalAgentModelSchema = z
  .enum(AGENT_MODEL_PRESETS)
  .nullable()
  .optional();

export const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(200),
  slug: slugSchema,
  defaultAiPolicy: z.string().optional(),
  agentInstructions: z.string().max(20_000).nullable().optional(),
  useReconciliationDefault: z.boolean().optional(),
});

export const updateWorkspaceSchema = createWorkspaceSchema
  .extend({
    ingestionMode: z.enum(INGESTION_MODES).optional(),
    agentProvider: z.enum(AI_PROVIDERS).nullable().optional(),
    agentModelFast: optionalAgentModelSchema,
    agentModelLargeContext: optionalAgentModelSchema,
    agentFastThresholdTokens: z
      .number()
      .int()
      .min(1_000)
      .max(1_000_000)
      .nullable()
      .optional(),
    agentDailyTokenCap: z
      .number()
      .int()
      .min(10_000)
      .max(500_000_000)
      .nullable()
      .optional(),
    agentParityMinObservedDays: z
      .number()
      .int()
      .min(1)
      .max(30)
      .nullable()
      .optional(),
    agentParityMinComparableCount: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .nullable()
      .optional(),
    agentParityMinActionAgreementRate: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .optional(),
    agentParityMinTargetPageAgreementRate: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .optional(),
  })
  .partial();

export const addWorkspaceMemberSchema = z.object({
  userId: uuidSchema,
  role: z.enum(WORKSPACE_ROLES),
});

export type CreateWorkspace = z.infer<typeof createWorkspaceSchema>;
export type UpdateWorkspace = z.infer<typeof updateWorkspaceSchema>;
export type AddWorkspaceMember = z.infer<typeof addWorkspaceMemberSchema>;
