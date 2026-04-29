import { z } from "zod";
import { uuidSchema } from "./common.js";
import { AGENT_LIMITS, INGESTION_ACTIONS } from "../constants/index.js";

export const AGENT_READ_TOOL_NAMES = [
  "search_pages",
  "read_page",
  "list_folder",
  "find_related_entities",
  "list_recent_pages",
] as const;
export type AgentReadToolName = (typeof AGENT_READ_TOOL_NAMES)[number];

export const readPageFormatSchema = z.enum(["markdown", "summary", "blocks"]);
export type ReadPageFormat = z.infer<typeof readPageFormatSchema>;

export const searchPagesToolInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});
export type SearchPagesToolInput = z.infer<
  typeof searchPagesToolInputSchema
>;

export const readPageToolInputSchema = z.object({
  pageId: uuidSchema,
  format: readPageFormatSchema.default("markdown"),
});
export type ReadPageToolInput = z.infer<typeof readPageToolInputSchema>;

export const listFolderToolInputSchema = z.object({
  folderId: uuidSchema.nullish(),
});
export type ListFolderToolInput = z.infer<typeof listFolderToolInputSchema>;

export const findRelatedEntitiesToolInputSchema = z.object({
  text: z.string().trim().min(1).max(5_000),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});
export type FindRelatedEntitiesToolInput = z.infer<
  typeof findRelatedEntitiesToolInputSchema
>;

export const listRecentPagesToolInputSchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(10),
});
export type ListRecentPagesToolInput = z.infer<
  typeof listRecentPagesToolInputSchema
>;

export const agentReadToolInputSchemas = {
  search_pages: searchPagesToolInputSchema,
  read_page: readPageToolInputSchema,
  list_folder: listFolderToolInputSchema,
  find_related_entities: findRelatedEntitiesToolInputSchema,
  list_recent_pages: listRecentPagesToolInputSchema,
} as const;

export const agentPlanEvidenceSchema = z.object({
  pageId: uuidSchema.optional(),
  note: z.string().trim().min(1).max(1_000),
});
export type AgentPlanEvidence = z.infer<typeof agentPlanEvidenceSchema>;

export const agentPlanMutationSchema = z
  .object({
    action: z.enum(INGESTION_ACTIONS),
    targetPageId: uuidSchema.nullable().default(null),
    confidence: z.number().min(0).max(1),
    reason: z.string().trim().min(1).max(2_000),
    proposedTitle: z.string().trim().min(1).max(500).optional(),
    sectionHint: z.string().trim().min(1).max(500).optional(),
    contentSummary: z.string().trim().min(1).max(2_000).optional(),
    evidence: z.array(agentPlanEvidenceSchema).max(20).default([]),
  })
  .superRefine((value, ctx) => {
    if (
      (value.action === "update" || value.action === "append") &&
      !value.targetPageId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetPageId"],
        message: "targetPageId is required for update/append mutations",
      });
    }
    if (value.action === "create" && !value.proposedTitle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposedTitle"],
        message: "proposedTitle is required for create mutations",
      });
    }
  });
export type AgentPlanMutation = z.infer<typeof agentPlanMutationSchema>;

export const ingestionAgentPlanSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  proposedPlan: z
    .array(agentPlanMutationSchema)
    .max(AGENT_LIMITS.MAX_MUTATIONS),
  openQuestions: z.array(z.string().trim().min(1).max(1_000)).default([]),
});
export type IngestionAgentPlan = z.infer<typeof ingestionAgentPlanSchema>;
