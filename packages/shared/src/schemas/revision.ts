import { z } from "zod";
import { uuidSchema } from "./common.js";
import { ACTOR_TYPES, REVISION_SOURCES } from "../constants/index.js";

export const createRevisionSchema = z.object({
  pageId: uuidSchema,
  baseRevisionId: uuidSchema.nullable().default(null),
  actorType: z.enum(ACTOR_TYPES),
  actorUserId: uuidSchema.nullable().default(null),
  modelRunId: uuidSchema.nullable().default(null),
  source: z.enum(REVISION_SOURCES),
  contentMd: z.string(),
  contentJson: z.record(z.unknown()).optional(),
  revisionNote: z.string().max(500).optional(),
});

export const rollbackRevisionSchema = z.object({
  revisionNote: z.string().max(500).optional(),
});

export const compareRevisionsQuerySchema = z.object({
  from: uuidSchema,
  to: uuidSchema,
});

export const revisionDiffSchema = z.object({
  revisionId: uuidSchema,
  diffMd: z.string().nullable(),
  diffOpsJson: z.array(z.unknown()).nullable(),
  changedBlocks: z.number().int().nullable(),
});

export type CreateRevision = z.infer<typeof createRevisionSchema>;
export type RollbackRevision = z.infer<typeof rollbackRevisionSchema>;
export type CompareRevisionsQuery = z.infer<typeof compareRevisionsQuerySchema>;
export type RevisionDiffDto = z.infer<typeof revisionDiffSchema>;
