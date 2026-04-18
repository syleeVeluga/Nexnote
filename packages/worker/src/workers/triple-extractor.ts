import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { eq, and, inArray } from "drizzle-orm";
import { createRedisConnection } from "../connection.js";
import { QUEUE_NAMES } from "../queues.js";
import { getAIAdapter, getDefaultProvider } from "../ai-gateway.js";
import { createJobLogger } from "../logger.js";
import { getDb } from "@nexnote/db/client";
import {
  entities,
  triples,
  tripleMentions,
  modelRuns,
  pageRevisions,
} from "@nexnote/db";
import { tripleExtractionSchema, normalizeKey } from "@nexnote/shared";
import type {
  TripleExtractorJobData,
  TripleExtractorJobResult,
  AIRequest,
} from "@nexnote/shared";

const PROMPT_VERSION = "triple-extractor-v2";

export function createTripleExtractorWorker(): Worker {
  const db = getDb();

  const worker = new Worker<TripleExtractorJobData, TripleExtractorJobResult>(
    QUEUE_NAMES.EXTRACTION,
    async (job: Job<TripleExtractorJobData>) => {
      const { pageId, revisionId, workspaceId } = job.data;
      const log = createJobLogger("triple-extractor", job.id);

      log.info({ pageId, revisionId }, "Processing page");

      const [revision] = await db
        .select({ contentMd: pageRevisions.contentMd })
        .from(pageRevisions)
        .where(eq(pageRevisions.id, revisionId))
        .limit(1);

      if (!revision) {
        throw new Error(`Revision ${revisionId} not found`);
      }

      await job.updateProgress(10);

      const { provider, model } = getDefaultProvider();
      const adapter = getAIAdapter(provider);

      const aiRequest: AIRequest = {
        provider,
        model,
        mode: "triple_extraction",
        promptVersion: PROMPT_VERSION,
        messages: [
          {
            role: "system",
            content: `You are a knowledge extraction engine. Given Markdown document content, extract structured triples (subject-predicate-object relationships).

Rules:
- Extract factual relationships, not opinions or speculation
- Each triple should have a subject (entity name), predicate (relationship), and object (entity name OR literal value)
- Set objectType to "entity" if the object refers to a named entity, or "literal" if it's a value/description
- Assign confidence 0.0–1.0 based on how explicit the relationship is in the text
- Include spans showing where in the text each triple was found; keep each excerpt under 120 characters
- **Language fidelity (critical):** Preserve the original language of the source document verbatim for subjects, objects, and literal values. If the document is Korean, entity names (people, organizations, places, concepts) MUST stay in Korean — do NOT translate, romanize, or transliterate them to English (e.g., "이순신" stays "이순신", not "Lee Sun-sin"). The same rule applies to Japanese, Chinese, or any other non-English source. Only use English when the term appears in English in the source.
- Predicates SHOULD be short snake_case identifiers in English (e.g., works_at, located_in, born_in) since they are relationship types, not content — but if a predicate has no natural English equivalent, keep it in the source language.
- Normalize entity names by using the canonical surface form that appears in the text (e.g., unify "홍길동"/"길동" to the most complete form used in the document). Do NOT change scripts or languages.
- Extract at most 40 of the most important, clearly-stated triples. Prioritize high-signal facts over exhaustive coverage.

Respond with JSON:
{
  "triples": [
    {
      "subject": "Entity Name",
      "predicate": "relationship_type",
      "object": "Another Entity or literal value",
      "objectType": "entity" | "literal",
      "confidence": 0.9,
      "spans": [{ "start": 0, "end": 50, "excerpt": "text excerpt" }]
    }
  ]
}`,
          },
          {
            role: "user",
            content: `Extract triples from this document:
\`\`\`markdown
${revision.contentMd.slice(0, 6000)}
\`\`\``,
          },
        ],
        temperature: 0.1,
        maxTokens: 8192,
        responseFormat: "json",
      };

      const aiResponse = await adapter.chat(aiRequest);

      await job.updateProgress(50);

      let extracted;
      let parseFailed = false;
      try {
        const raw = JSON.parse(aiResponse.content);
        extracted = tripleExtractionSchema.parse(raw);
      } catch (err) {
        log.error({ err, revisionId }, "Failed to parse LLM response");
        parseFailed = true;
        extracted = { triples: [] };
      }

      const [modelRun] = await db
        .insert(modelRuns)
        .values({
          workspaceId,
          provider,
          modelName: model,
          mode: "triple_extraction",
          promptVersion: PROMPT_VERSION,
          tokenInput: aiResponse.tokenInput,
          tokenOutput: aiResponse.tokenOutput,
          latencyMs: aiResponse.latencyMs,
          status: parseFailed ? "failed" : "success",
          requestMetaJson: { pageId, revisionId },
          responseMetaJson: parseFailed
            ? { error: "parse_failed", raw: aiResponse.content.slice(0, 500) }
            : { tripleCount: extracted.triples.length },
        })
        .returning();

      await job.updateProgress(60);

      if (extracted.triples.length === 0) {
        await job.updateProgress(100);
        return { pageId, triplesCreated: 0 };
      }

      // Batch entity resolution: collect all unique entity names, then bulk upsert
      const entityNames = new Map<string, { name: string; type: string }>();
      for (const t of extracted.triples) {
        const subKey = normalizeKey(t.subject);
        if (!entityNames.has(subKey)) {
          entityNames.set(subKey, { name: t.subject, type: "concept" });
        }
        if (t.objectType === "entity") {
          const objKey = normalizeKey(t.object);
          if (!entityNames.has(objKey)) {
            entityNames.set(objKey, { name: t.object, type: "concept" });
          }
        }
      }

      // Bulk insert new entities (skip conflicts)
      const entityValues = [...entityNames.entries()].map(([key, val]) => ({
        workspaceId,
        canonicalName: val.name,
        normalizedKey: key,
        entityType: val.type,
      }));

      await db.insert(entities).values(entityValues).onConflictDoNothing();

      // Bulk fetch all entity ids
      const allKeys = [...entityNames.keys()];
      const existingEntities = await db
        .select({ id: entities.id, normalizedKey: entities.normalizedKey })
        .from(entities)
        .where(
          and(
            eq(entities.workspaceId, workspaceId),
            inArray(entities.normalizedKey, allKeys),
          ),
        );

      const entityIdMap = new Map<string, string>();
      for (const e of existingEntities) {
        entityIdMap.set(e.normalizedKey, e.id);
      }

      await job.updateProgress(80);

      // Build triple value rows, filtering out those with missing entity references
      const tripleValues: Array<{
        workspaceId: string;
        subjectEntityId: string;
        predicate: string;
        objectEntityId: string | null;
        objectLiteral: string | null;
        confidence: number;
        sourcePageId: string;
        sourceRevisionId: string;
        extractionModelRunId: string;
        status: string;
      }> = [];
      // Track which extracted triple index maps to which insert row
      const tripleSourceIndices: number[] = [];

      for (let i = 0; i < extracted.triples.length; i++) {
        const t = extracted.triples[i];
        const subjectEntityId = entityIdMap.get(normalizeKey(t.subject));
        if (!subjectEntityId) continue;

        let objectEntityId: string | null = null;
        let objectLiteral: string | null = null;

        if (t.objectType === "entity") {
          objectEntityId = entityIdMap.get(normalizeKey(t.object)) ?? null;
          if (!objectEntityId) continue;
        } else {
          objectLiteral = t.object;
        }

        tripleValues.push({
          workspaceId,
          subjectEntityId,
          predicate: t.predicate,
          objectEntityId,
          objectLiteral,
          confidence: t.confidence,
          sourcePageId: pageId,
          sourceRevisionId: revisionId,
          extractionModelRunId: modelRun.id,
          status: "active",
        });
        tripleSourceIndices.push(i);
      }

      let triplesCreated = 0;
      if (tripleValues.length > 0) {
        const insertedTriples = await db
          .insert(triples)
          .values(tripleValues)
          .returning({ id: triples.id });

        triplesCreated = insertedTriples.length;

        // Build mention rows from inserted triples
        const mentionRows: Array<{
          tripleId: string;
          pageId: string;
          revisionId: string;
          spanStart: number;
          spanEnd: number;
          excerpt: string | null;
        }> = [];

        for (let i = 0; i < insertedTriples.length; i++) {
          const sourceIdx = tripleSourceIndices[i];
          const t = extracted.triples[sourceIdx];
          for (const span of t.spans) {
            mentionRows.push({
              tripleId: insertedTriples[i].id,
              pageId,
              revisionId,
              spanStart: span.start,
              spanEnd: span.end,
              excerpt: span.excerpt,
            });
          }
        }

        if (mentionRows.length > 0) {
          await db.insert(tripleMentions).values(mentionRows);
        }
      }

      await job.updateProgress(100);

      log.info({ pageId, triplesCreated }, "Extraction complete");

      return { pageId, triplesCreated };
    },
    {
      connection: createRedisConnection(),
      concurrency: 3,
    },
  );

  worker.on("completed", (job, result) => {
    const log = createJobLogger("triple-extractor", job.id);
    log.info(
      { pageId: result.pageId, triplesCreated: result.triplesCreated },
      "Job completed",
    );
  });

  worker.on("failed", (job, err) => {
    const log = createJobLogger("triple-extractor", job?.id);
    log.error({ err }, "Job failed");
  });

  return worker;
}
