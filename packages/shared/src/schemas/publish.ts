import { z } from "zod";
import { uuidSchema } from "./common.js";

export const publishPageSchema = z.object({
  revisionId: uuidSchema.optional(),
  includeDescendants: z.boolean().optional(),
  scope: z.enum(["self", "subtree"]).optional(),
});

export const publicDocParamsSchema = z.object({
  workspaceSlug: z.string().min(1),
  pagePath: z.string().min(1),
});

export type PublishPage = z.infer<typeof publishPageSchema>;
export type PublicDocParams = z.infer<typeof publicDocParamsSchema>;
