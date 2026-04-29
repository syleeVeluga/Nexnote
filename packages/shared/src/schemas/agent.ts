import { z } from "zod";
import { uuidSchema } from "./common.js";

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
