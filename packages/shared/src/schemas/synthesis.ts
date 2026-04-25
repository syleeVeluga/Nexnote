import { z } from "zod";
import { uuidSchema } from "./common.js";

export const createSynthesisSchema = z.object({
  prompt: z.string().min(1).max(20_000),
  sourceText: z.string().max(1_000_000).optional(),
  titleHint: z.string().min(1).max(500).optional(),
  targetPageId: uuidSchema.optional(),
  seedPageIds: z.array(uuidSchema).max(20).optional(),
  seedEntityIds: z.array(uuidSchema).max(50).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export type CreateSynthesis = z.infer<typeof createSynthesisSchema>;
