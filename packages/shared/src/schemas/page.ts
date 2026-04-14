import { z } from "zod";
import { slugSchema, uuidSchema } from "./common.js";
import { PAGE_STATUSES } from "../constants/index.js";

export const createPageSchema = z.object({
  title: z.string().min(1).max(500),
  slug: slugSchema,
  folderId: uuidSchema.nullable().default(null),
  contentMd: z.string().default(""),
  contentJson: z.record(z.unknown()).optional(),
});

export const updatePageSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  slug: slugSchema.optional(),
  folderId: uuidSchema.nullable().optional(),
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

export type CreatePage = z.infer<typeof createPageSchema>;
export type UpdatePage = z.infer<typeof updatePageSchema>;
export type CreateFolder = z.infer<typeof createFolderSchema>;
export type UpdateFolder = z.infer<typeof updateFolderSchema>;
