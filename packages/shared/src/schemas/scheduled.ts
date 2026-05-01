import { z } from "zod";
import { uuidSchema } from "./common.js";

export const scheduledTaskBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  cronExpression: z.string().trim().min(1).max(120),
  targetPageIds: z.array(uuidSchema).min(1).max(500),
  includeDescendants: z.boolean().optional().default(true),
  instruction: z.string().max(4000).nullable().optional(),
  enabled: z.boolean().optional().default(true),
});

export const updateScheduledTaskBodySchema = scheduledTaskBodySchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

export const scheduledTaskDtoSchema = z.object({
  id: uuidSchema,
  workspaceId: uuidSchema,
  name: z.string(),
  cronExpression: z.string(),
  targetPageIds: z.array(uuidSchema),
  includeDescendants: z.boolean(),
  instruction: z.string().nullable(),
  enabled: z.boolean(),
  bullRepeatKey: z.string().nullable(),
  createdBy: uuidSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  nextRunAt: z.string().nullable(),
});

export type ScheduledTaskBody = z.infer<typeof scheduledTaskBodySchema>;
export type UpdateScheduledTaskBody = z.infer<
  typeof updateScheduledTaskBodySchema
>;
export type ScheduledTaskDto = z.infer<typeof scheduledTaskDtoSchema>;
