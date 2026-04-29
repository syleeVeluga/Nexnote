import { z } from "zod";
import { uuidSchema } from "./common.js";
import { pageDtoSchema } from "./page.js";
import {
  DECISION_STATUSES,
  INGESTION_ACTIONS,
} from "../constants/index.js";

export const dashboardFolderSchema = z.object({
  id: uuidSchema,
  workspaceId: uuidSchema,
  parentFolderId: uuidSchema.nullable(),
  name: z.string(),
  slug: z.string(),
  sortOrder: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DashboardFolder = z.infer<typeof dashboardFolderSchema>;

export const dashboardDecisionListItemSchema = z.object({
  id: uuidSchema,
  ingestionId: uuidSchema,
  targetPageId: uuidSchema.nullable(),
  proposedRevisionId: uuidSchema.nullable(),
  modelRunId: uuidSchema,
  action: z.enum(INGESTION_ACTIONS),
  status: z.enum(DECISION_STATUSES),
  proposedPageTitle: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().nullable(),
  hasConflict: z.boolean().optional(),
  createdAt: z.string().datetime(),
  ingestion: z.object({
    sourceName: z.string(),
    titleHint: z.string().nullable(),
    receivedAt: z.string().datetime(),
  }),
  targetPage: z
    .object({
      id: uuidSchema,
      title: z.string(),
      slug: z.string().nullable(),
    })
    .nullable(),
});
export type DashboardDecisionListItem = z.infer<
  typeof dashboardDecisionListItemSchema
>;

export const dashboardDtoSchema = z.object({
  counts: z.object({
    pages: z.number().int().nonnegative(),
    folders: z.number().int().nonnegative(),
    pendingDecisions: z.number().int().nonnegative(),
    autoAppliedToday: z.number().int().nonnegative(),
    failedDecisions: z.number().int().nonnegative(),
  }),
  recentAutoApplied: z.array(dashboardDecisionListItemSchema),
  pendingPreview: z.array(dashboardDecisionListItemSchema),
  folders: z.array(
    z.object({
      folder: dashboardFolderSchema,
      pageCount: z.number().int().nonnegative(),
      pages: z.array(pageDtoSchema),
    }),
  ),
  rootPages: z.array(pageDtoSchema),
  recentAiPages: z.array(pageDtoSchema),
});
export type DashboardDto = z.infer<typeof dashboardDtoSchema>;
