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

export type CreateRevision = z.infer<typeof createRevisionSchema>;
