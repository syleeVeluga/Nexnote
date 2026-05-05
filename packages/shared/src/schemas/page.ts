import { z } from "zod";
import { slugSchema, uuidSchema } from "./common.js";
import { ACTOR_TYPES, PAGE_STATUSES } from "../constants/index.js";

export const reorderIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("asFirstChild") }),
  z.object({ kind: z.literal("asLastChild") }),
  z.object({ kind: z.literal("before"), anchorId: uuidSchema }),
  z.object({ kind: z.literal("after"), anchorId: uuidSchema }),
]);
export type ReorderIntent = z.infer<typeof reorderIntentSchema>;

export const createPageSchema = z.object({
  title: z.string().min(1).max(500),
  slug: slugSchema,
  parentPageId: uuidSchema.nullable().default(null),
  parentFolderId: uuidSchema.nullable().default(null),
  contentMd: z.string().default(""),
  contentJson: z.record(z.unknown()).optional(),
});

export const updatePageSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  slug: slugSchema.optional(),
  parentPageId: uuidSchema.nullable().optional(),
  parentFolderId: uuidSchema.nullable().optional(),
  status: z.enum(PAGE_STATUSES).optional(),
  sortOrder: z.number().int().optional(),
  reorderIntent: reorderIntentSchema.optional(),
  // When the parent changes, the worker re-extracts triples against the new
  // destination and reconciles entities by default. Pass false from a
  // "fresh extract" UI option to skip reconciliation on this move.
  useReconciliation: z.boolean().optional(),
});

export const createFolderSchema = z.object({
  name: z.string().min(1).max(200),
  slug: slugSchema,
  parentFolderId: uuidSchema.nullable().default(null),
  sortOrder: z.number().int().default(0),
});

export const updateFolderSchema = createFolderSchema
  .partial()
  .extend({ reorderIntent: reorderIntentSchema.optional() });

export const AI_EDIT_MODES = [
  "selection-rewrite",
  "section-expand",
  "summarize",
  "tone-formal",
  "tone-casual",
  "extract-action-items",
] as const;
export type AiEditMode = (typeof AI_EDIT_MODES)[number];

export const aiEditSchema = z.object({
  mode: z.enum(AI_EDIT_MODES),
  instruction: z.string().min(1).max(2000),
  selection: z
    .object({
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
      text: z.string(),
    })
    .optional(),
});
export type AiEdit = z.infer<typeof aiEditSchema>;

export const searchQuerySchema = z.object({
  q: z.string().min(1).max(300),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const graphQuerySchema = z.object({
  depth: z.coerce.number().int().min(1).max(2).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(60),
  minConfidence: z.coerce.number().min(0).max(1).default(0),
  locale: z.enum(["ko", "en"]).optional(),
});

export type CreatePage = z.infer<typeof createPageSchema>;
export type UpdatePage = z.infer<typeof updatePageSchema>;
export type CreateFolder = z.infer<typeof createFolderSchema>;
export type UpdateFolder = z.infer<typeof updateFolderSchema>;
export type GraphQuery = z.infer<typeof graphQuerySchema>;

export const pageSummaryMetaSchema = z.object({
  latestRevisionActorType: z.enum(ACTOR_TYPES).nullable(),
  latestRevisionSource: z.string().nullable(),
  latestRevisionCreatedAt: z.string().datetime().nullable(),
  latestRevisionSourceIngestionId: uuidSchema.nullable(),
  latestRevisionSourceDecisionId: uuidSchema.nullable(),
  publishedAt: z.string().datetime().nullable(),
  isLivePublished: z.boolean(),
});
export type PageSummaryMeta = z.infer<typeof pageSummaryMetaSchema>;

export const pageDtoSchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    parentPageId: uuidSchema.nullable(),
    parentFolderId: uuidSchema.nullable(),
    title: z.string(),
    slug: slugSchema,
    status: z.enum(PAGE_STATUSES),
    sortOrder: z.number().int(),
    currentRevisionId: uuidSchema.nullable(),
    lastAiUpdatedAt: z.string().datetime().nullable(),
    lastHumanEditedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .merge(pageSummaryMetaSchema);
export type PageDto = z.infer<typeof pageDtoSchema>;
