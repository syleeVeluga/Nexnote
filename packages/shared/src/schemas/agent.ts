import { z } from "zod";
import { uuidSchema } from "./common.js";
import {
  AGENT_LIMITS,
  AGENT_RUN_STATUSES,
  INGESTION_ACTIONS,
} from "../constants/index.js";

export const AGENT_READ_TOOL_NAMES = [
  "search_pages",
  "read_page",
  "list_folder",
  "find_related_entities",
  "list_recent_pages",
] as const;
export type AgentReadToolName = (typeof AGENT_READ_TOOL_NAMES)[number];

export const AGENT_MUTATE_TOOL_NAMES = [
  "replace_in_page",
  "edit_page_blocks",
  "edit_page_section",
  "update_page",
  "append_to_page",
  "create_page",
  "noop",
  "request_human_review",
] as const;
export type AgentMutateToolName = (typeof AGENT_MUTATE_TOOL_NAMES)[number];

export const readPageFormatSchema = z.enum(["markdown", "summary", "blocks"]);
export type ReadPageFormat = z.infer<typeof readPageFormatSchema>;

export const searchPagesToolInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});
export type SearchPagesToolInput = z.infer<typeof searchPagesToolInputSchema>;

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

const confidenceSchema = z.coerce.number().min(0).max(1);
const mutationReasonSchema = z.string().trim().min(1).max(2_000);

export const replaceInPageToolInputSchema = z.object({
  pageId: uuidSchema,
  find: z.string().min(1).max(20_000),
  replace: z.string().max(20_000),
  occurrence: z.coerce.number().int().min(1).optional(),
  confidence: confidenceSchema,
  reason: mutationReasonSchema,
});
export type ReplaceInPageToolInput = z.infer<
  typeof replaceInPageToolInputSchema
>;

export const editPageBlockOpSchema = z
  .object({
    blockId: z.string().trim().min(1).max(200),
    op: z.enum(["replace", "insert_after", "insert_before", "delete"]),
    content: z.string().max(50_000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.op !== "delete" && !value.content?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content"],
        message: "content is required for replace/insert block ops",
      });
    }
  });
export type EditPageBlockOp = z.infer<typeof editPageBlockOpSchema>;

export const editPageBlocksToolInputSchema = z.object({
  pageId: uuidSchema,
  ops: z.array(editPageBlockOpSchema).min(1).max(50),
  confidence: confidenceSchema,
  reason: mutationReasonSchema,
});
export type EditPageBlocksToolInput = z.infer<
  typeof editPageBlocksToolInputSchema
>;

export const editPageSectionToolInputSchema = z
  .object({
    pageId: uuidSchema,
    sectionAnchor: z.string().trim().min(1).max(500),
    op: z.enum(["replace", "append", "prepend", "delete"]),
    content: z.string().max(100_000).optional(),
    confidence: confidenceSchema,
    reason: mutationReasonSchema,
  })
  .superRefine((value, ctx) => {
    if (value.op !== "delete" && !value.content?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content"],
        message: "content is required for replace/append/prepend section ops",
      });
    }
  });
export type EditPageSectionToolInput = z.infer<
  typeof editPageSectionToolInputSchema
>;

export const updatePageToolInputSchema = z.object({
  pageId: uuidSchema,
  newContentMd: z.string().min(1).max(500_000),
  confidence: confidenceSchema,
  reason: mutationReasonSchema,
});
export type UpdatePageToolInput = z.infer<typeof updatePageToolInputSchema>;

export const appendToPageToolInputSchema = z.object({
  pageId: uuidSchema,
  contentMd: z.string().min(1).max(250_000),
  sectionHint: z.string().trim().min(1).max(500).optional(),
  confidence: confidenceSchema,
  reason: mutationReasonSchema,
});
export type AppendToPageToolInput = z.infer<typeof appendToPageToolInputSchema>;

export const createPageToolInputSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    contentMd: z.string().min(1).max(500_000),
    parentFolderId: uuidSchema.nullish(),
    parentPageId: uuidSchema.nullish(),
    confidence: confidenceSchema,
    reason: mutationReasonSchema,
  })
  .refine((value) => !(value.parentFolderId && value.parentPageId), {
    message: "parentFolderId and parentPageId are mutually exclusive",
    path: ["parentPageId"],
  });
export type CreatePageToolInput = z.infer<typeof createPageToolInputSchema>;

export const noopToolInputSchema = z.object({
  reason: mutationReasonSchema,
  confidence: confidenceSchema.default(1),
});
export type NoopToolInput = z.infer<typeof noopToolInputSchema>;

export const requestHumanReviewToolInputSchema = z.object({
  reason: mutationReasonSchema,
  suggestedAction: z.enum(INGESTION_ACTIONS).optional(),
  suggestedPageIds: z.array(uuidSchema).max(20).default([]),
  confidence: confidenceSchema.default(0),
});
export type RequestHumanReviewToolInput = z.infer<
  typeof requestHumanReviewToolInputSchema
>;

export const agentMutateToolInputSchemas = {
  replace_in_page: replaceInPageToolInputSchema,
  edit_page_blocks: editPageBlocksToolInputSchema,
  edit_page_section: editPageSectionToolInputSchema,
  update_page: updatePageToolInputSchema,
  append_to_page: appendToPageToolInputSchema,
  create_page: createPageToolInputSchema,
  noop: noopToolInputSchema,
  request_human_review: requestHumanReviewToolInputSchema,
} as const;

export const agentPlanEvidenceSchema = z.object({
  pageId: uuidSchema.optional(),
  note: z.string().trim().min(1).max(1_000),
});
export type AgentPlanEvidence = z.infer<typeof agentPlanEvidenceSchema>;

export const agentPlanMutationSchema = z
  .object({
    tool: z.enum(AGENT_MUTATE_TOOL_NAMES).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    action: z.enum(INGESTION_ACTIONS).optional(),
    targetPageId: uuidSchema.nullable().default(null),
    confidence: z.number().min(0).max(1),
    reason: z.string().trim().min(1).max(2_000),
    proposedTitle: z.string().trim().min(1).max(500).optional(),
    sectionHint: z.string().trim().min(1).max(500).optional(),
    contentSummary: z.string().trim().min(1).max(2_000).optional(),
    evidence: z.array(agentPlanEvidenceSchema).max(20).default([]),
  })
  .superRefine((value, ctx) => {
    if (!value.tool && !value.action) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["action"],
        message: "action is required when tool is omitted",
      });
    }
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

export const agentRunTraceStepSchema = z.object({
  step: z.number().int().min(0),
  type: z.enum([
    "model_selection",
    "ai_response",
    "context_compaction",
    "tool_result",
    "plan",
    "mutation_result",
    "shadow_execute_skipped",
    "error",
  ]),
  payload: z.record(z.string(), z.unknown()),
  ts: z.string(),
});
export type AgentRunTraceStep = z.infer<typeof agentRunTraceStepSchema>;

export const agentRunDtoSchema = z.object({
  id: uuidSchema,
  ingestionId: uuidSchema,
  workspaceId: uuidSchema,
  status: z.enum(AGENT_RUN_STATUSES),
  plan: z.unknown().nullable(),
  steps: z.array(agentRunTraceStepSchema),
  decisionsCount: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  totalLatencyMs: z.number().int().min(0),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
});
export type AgentRunDto = z.infer<typeof agentRunDtoSchema>;

export const agentRunTraceEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), agentRun: agentRunDtoSchema }),
  z.object({ type: z.literal("step"), step: agentRunTraceStepSchema }),
  z.object({ type: z.literal("status"), agentRun: agentRunDtoSchema }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    code: z.string().optional(),
  }),
]);
export type AgentRunTraceEvent = z.infer<typeof agentRunTraceEventSchema>;
