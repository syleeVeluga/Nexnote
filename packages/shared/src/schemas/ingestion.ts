import { z } from "zod";
import { uuidSchema } from "./common.js";
import { INGESTION_ACTIONS } from "../constants/index.js";

export const createIngestionSchema = z.object({
  sourceName: z.string().min(1).max(200),
  externalRef: z.string().max(500).optional(),
  idempotencyKey: z.string().min(1).max(200),
  contentType: z.string().max(100).default("text/plain"),
  titleHint: z.string().max(500).optional(),
  rawPayload: z.record(z.unknown()),
});

export const importUrlBodySchema = z.object({
  url: z.string().url().max(2048),
  mode: z.enum(["readable", "firecrawl"]).default("readable"),
  titleHint: z.string().max(500).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  forceRefresh: z.boolean().optional(),
});

export const importTextBodySchema = z.object({
  content: z.string().min(1).max(1_000_000),
  sourceName: z.string().min(1).max(200).default("manual-paste"),
  contentType: z.string().max(100).default("text/markdown"),
  titleHint: z.string().max(500).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const importFileFieldsSchema = z.object({
  titleHint: z.string().max(500).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const routeDecisionSchema = z.object({
  action: z.enum(INGESTION_ACTIONS),
  targetPageId: uuidSchema.nullable().default(null),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  proposedTitle: z.string().optional(),
});

export const patchProposalSchema = z.object({
  targetPageId: uuidSchema,
  baseRevisionId: uuidSchema,
  editType: z.enum(["replace", "append", "prepend", "patch"]),
  ops: z.array(z.record(z.unknown())),
  summary: z.string(),
});

export const tripleExtractionSchema = z.object({
  triples: z.array(
    z.object({
      subject: z.string(),
      predicate: z.string(),
      object: z.string(),
      objectType: z.enum(["entity", "literal"]),
      confidence: z.number().min(0).max(1),
      spans: z.array(
        z.object({
          start: z.number().int(),
          end: z.number().int(),
          excerpt: z.string(),
        }),
      ),
    }),
  ),
});

export type CreateIngestion = z.infer<typeof createIngestionSchema>;
export type ImportUrlBody = z.infer<typeof importUrlBodySchema>;
export type ImportTextBody = z.infer<typeof importTextBodySchema>;
export type ImportFileFields = z.infer<typeof importFileFieldsSchema>;
export type RouteDecision = z.infer<typeof routeDecisionSchema>;
export type PatchProposal = z.infer<typeof patchProposalSchema>;
export type TripleExtraction = z.infer<typeof tripleExtractionSchema>;
