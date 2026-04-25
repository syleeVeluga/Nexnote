import { z } from "zod";
import { slugSchema, uuidSchema } from "./common.js";
import { WORKSPACE_ROLES } from "../constants/index.js";

export const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(200),
  slug: slugSchema,
  defaultAiPolicy: z.string().optional(),
  useReconciliationDefault: z.boolean().optional(),
});

export const updateWorkspaceSchema = createWorkspaceSchema.partial();

export const addWorkspaceMemberSchema = z.object({
  userId: uuidSchema,
  role: z.enum(WORKSPACE_ROLES),
});

export type CreateWorkspace = z.infer<typeof createWorkspaceSchema>;
export type UpdateWorkspace = z.infer<typeof updateWorkspaceSchema>;
export type AddWorkspaceMember = z.infer<typeof addWorkspaceMemberSchema>;
