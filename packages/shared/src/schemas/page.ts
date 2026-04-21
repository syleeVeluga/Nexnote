import { z } from "zod";
import { slugSchema, uuidSchema } from "./common.js";
import { PAGE_STATUSES } from "../constants/index.js";

export const createPageSchema = z.object({
  title: z.string().min(1).max(500),
  slug: slugSchema,
  parentPageId: uuidSchema.nullable().default(null),
  contentMd: z.string().default(""),
  contentJson: z.record(z.unknown()).optional(),
});

export const updatePageSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  slug: slugSchema.optional(),
  parentPageId: uuidSchema.nullable().optional(),
  status: z.enum(PAGE_STATUSES).optional(),
  sortOrder: z.number().int().optional(),
});

export const createFolderSchema = z.object({
  name: z.string().min(1).max(200),
  slug: slugSchema,
  parentFolderId: uuidSchema.nullable().default(null),
  sortOrder: z.number().int().default(0),
});

export const updateFolderSchema = createFolderSchema.partial();

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
  limit: z.coerce.number().int().min(1).max(250).default(60),
  minConfidence: z.coerce.number().min(0).max(1).default(0),
});

export type CreatePage = z.infer<typeof createPageSchema>;
export type UpdatePage = z.infer<typeof updatePageSchema>;
export type CreateFolder = z.infer<typeof createFolderSchema>;
export type UpdateFolder = z.infer<typeof updateFolderSchema>;
export type GraphQuery = z.infer<typeof graphQuerySchema>;
