import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { eq, and, inArray } from "drizzle-orm";
import { createRedisConnection } from "../connection.js";
import { QUEUE_NAMES } from "../queues.js";
import { getAIAdapter, getDefaultProvider } from "../ai-gateway.js";
import { createJobLogger } from "../logger.js";
import { ensurePredicateDisplayLabels } from "../lib/predicate-label-cache.js";
import { getDb } from "@nexnote/db/client";
import {
  entities,
  triples,
  tripleMentions,
  modelRuns,
  pageRevisions,
} from "@nexnote/db";
import {
  tripleExtractionSchema,
  normalizeKey,
  estimateTokens,
  sliceWithinTokenBudget,
  getModelContextBudget,
  MODE_OUTPUT_RESERVE,
} from "@nexnote/shared";
import type {
  TripleExtractorJobData,
  TripleExtractorJobResult,
  AIRequest,
  AIBudgetMeta,
  TripleExtraction,
} from "@nexnote/shared";

const PROMPT_VERSION = "triple-extractor-v3";

type ExtractedTriple = TripleExtraction["triples"][number];
type ExtractedSpan = ExtractedTriple["spans"][number];

export type PreparedTriple = {
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
  spans: ExtractedSpan[];
};

function buildTripleKey(triple: Omit<PreparedTriple, "spans" | "confidence">) {
  return [
    triple.workspaceId,
    triple.sourcePageId,
    triple.subjectEntityId,
    triple.predicate,
    triple.objectEntityId ?? `literal:${triple.objectLiteral ?? ""}`,
  ].join("|");
}

function buildSpanKey(span: ExtractedSpan) {
  return [span.start, span.end, span.excerpt ?? ""].join("|");
}

function mergeSpans(
  existing: ExtractedSpan[],
  incoming: ExtractedSpan[],
): ExtractedSpan[] {
  const merged = [...existing];
  const seen = new Set(existing.map(buildSpanKey));

  for (const span of incoming) {
    const key = buildSpanKey(span);
    if (seen.has(key)) {
      continue;
    }
    merged.push(span);
    seen.add(key);
  }

  return merged;
}

export function prepareTriplesForInsert({
  extractedTriples,
  entityIdMap,
  workspaceId,
  pageId,
  revisionId,
  modelRunId,
}: {
  extractedTriples: ExtractedTriple[];
  entityIdMap: Map<string, string>;
  workspaceId: string;
  pageId: string;
  revisionId: string;
  modelRunId: string;
}): PreparedTriple[] {
  const preparedByKey = new Map<string, PreparedTriple>();

  for (const triple of extractedTriples) {
    const subjectEntityId = entityIdMap.get(normalizeKey(triple.subject));
    if (!subjectEntityId) {
      continue;
    }

    let objectEntityId: string | null = null;
    let objectLiteral: string | null = null;

    if (triple.objectType === "entity") {
      objectEntityId = entityIdMap.get(normalizeKey(triple.object)) ?? null;
      if (!objectEntityId) {
        continue;
      }
    } else {
      objectLiteral = triple.object;
    }

    const baseTriple = {
      workspaceId,
      subjectEntityId,
      predicate: triple.predicate,
      objectEntityId,
      objectLiteral,
      sourcePageId: pageId,
      sourceRevisionId: revisionId,
      extractionModelRunId: modelRunId,
      status: "active",
    };
    const tripleKey = buildTripleKey(baseTriple);
    const existing = preparedByKey.get(tripleKey);

    if (existing) {
      existing.confidence = Math.max(existing.confidence, triple.confidence);
      existing.spans = mergeSpans(existing.spans, triple.spans);
      continue;
    }

    preparedByKey.set(tripleKey, {
      ...baseTriple,
      confidence: triple.confidence,
      spans: mergeSpans([], triple.spans),
    });
  }

  return [...preparedByKey.values()];
}

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

      const systemPrompt = `You are a grounded triple extraction engine. From the Markdown document provided in the user message, extract only explicit, text-supported subject-predicate-object facts.

## Relation rules
- Extract only directly and clearly stated relationships. Do not infer causality, intent, or background knowledge not present in the text.
- If a single sentence contains an n-ary fact, decompose it into separate binary triples only when each binary relation is directly supported by the text.
- Do not output duplicate or near-duplicate triples.

## Entity rules
- Use the most complete surface form that appears in the document (e.g., unify "홍길동"/"길동" to the fullest form used).
- Preserve the original script and language for subjects and objects. Do NOT translate, romanize, or transliterate (e.g., "이순신" stays "이순신", not "Lee Sun-sin"). Same for Japanese, Chinese, and other non-English sources.
- Use explicit nouns, not pronouns. If a sentence uses a pronoun ("he", "그", "그녀", "the company"), resolve it to the explicit named entity as the subject/object.

## Predicate rules
- Predicates MUST be short, repeatable snake_case relation labels in English, because they represent relationship types, not content.
- Reuse the same predicate for semantically identical relations across the document (do not invent synonyms like \`located_in\` vs \`based_in\` vs \`headquartered_in\` — pick one).
- Prefer stable labels when applicable: \`is_a\`, \`part_of\`, \`located_in\`, \`works_at\`, \`founded_by\`, \`founded_in\`, \`born_in\`, \`announced_on\`, \`has_amount\`, \`has_date\`.
- If you cannot assign a stable predicate without guessing, SKIP that triple.

## objectType rules
- \`entity\` — named entities, organizations, places, products, events, documents, or concepts explicitly referred to as entities.
- \`literal\` — dates, numbers, measurements, statuses, titles, and short descriptive values.

## Evidence rules (critical)
- Every triple MUST be supported by at least one exact span from the document provided in the user message.
- \`start\` and \`end\` are 0-based character offsets into that exact Markdown content. \`end\` is exclusive.
- \`excerpt\` MUST be the exact substring \`content.slice(start, end)\`. You may trim the excerpt only to stay under 120 characters; if you trim, adjust \`start\`/\`end\` accordingly so \`content.slice(start, end) === excerpt\`.
- If you cannot determine exact offsets, SKIP that triple. Do not invent offsets.

## Coverage rules
- Scan the entire document, not only the beginning. For long documents, balance high-signal facts across early, middle, and late sections.
- Extract at most 40 triples total. Prioritize high-signal, clearly-stated facts over exhaustive coverage.

## Confidence
- Assign 0.0–1.0 based on how explicit and unambiguous the relationship is in the text.

## Output rules
- Return valid JSON only, matching the schema below exactly. No markdown fences. No commentary.

Schema:
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
}

## Examples

Example 1 — Korean source:
Input content (exact): "이순신은 조선 수군의 장군이었다. 그는 1545년에 태어났다."
Expected output:
{
  "triples": [
    {
      "subject": "이순신",
      "predicate": "is_a",
      "object": "장군",
      "objectType": "entity",
      "confidence": 0.95,
      "spans": [{ "start": 0, "end": 18, "excerpt": "이순신은 조선 수군의 장군이었다." }]
    },
    {
      "subject": "이순신",
      "predicate": "born_in",
      "object": "1545년",
      "objectType": "literal",
      "confidence": 0.95,
      "spans": [{ "start": 19, "end": 34, "excerpt": "그는 1545년에 태어났다." }]
    }
  ]
}
(Note: "그는" is resolved to the explicit subject "이순신" per entity rules, while the span still shows the supporting text.)

Example 2 — English source:
Input content (exact): "Acme Corp was founded in 2010 by Jane Lee. The company is based in Seoul."
Expected output:
{
  "triples": [
    {
      "subject": "Acme Corp",
      "predicate": "founded_by",
      "object": "Jane Lee",
      "objectType": "entity",
      "confidence": 0.95,
      "spans": [{ "start": 0, "end": 42, "excerpt": "Acme Corp was founded in 2010 by Jane Lee." }]
    },
    {
      "subject": "Acme Corp",
      "predicate": "founded_in",
      "object": "2010",
      "objectType": "literal",
      "confidence": 0.95,
      "spans": [{ "start": 0, "end": 42, "excerpt": "Acme Corp was founded in 2010 by Jane Lee." }]
    },
    {
      "subject": "Acme Corp",
      "predicate": "located_in",
      "object": "Seoul",
      "objectType": "entity",
      "confidence": 0.9,
      "spans": [{ "start": 43, "end": 73, "excerpt": "The company is based in Seoul." }]
    }
  ]
}
(Note: "The company" is resolved to "Acme Corp" per entity rules.)`;

      const budget = getModelContextBudget(provider, model);
      const systemTokens = estimateTokens(systemPrompt);
      const SCAFFOLD_TOKENS = 60;
      const rawAvailable =
        budget.inputTokenBudget -
        MODE_OUTPUT_RESERVE.triple_extraction -
        systemTokens -
        SCAFFOLD_TOKENS;
      const available = Math.max(
        2_000,
        Math.floor(rawAvailable * budget.safetyMarginRatio),
      );

      const contentSlice = sliceWithinTokenBudget(
        revision.contentMd,
        available,
        { preserveStructure: true },
      );

      const budgetMeta: AIBudgetMeta = {
        inputTokenBudget: available,
        estimatedInputTokens:
          systemTokens + SCAFFOLD_TOKENS + contentSlice.estimatedTokens,
        inputCharLength: systemPrompt.length + contentSlice.text.length,
        truncated: contentSlice.truncated,
        strategy: "single_slot_structure_preserving",
        slotAllocations: {
          content: {
            allocatedTokens: available,
            estimatedTokens: contentSlice.estimatedTokens,
            truncated: contentSlice.truncated,
          },
        },
      };

      const aiRequest: AIRequest = {
        provider,
        model,
        mode: "triple_extraction",
        promptVersion: PROMPT_VERSION,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Extract triples from this document:
\`\`\`markdown
${contentSlice.text}
\`\`\``,
          },
        ],
        temperature: 0.1,
        maxTokens: MODE_OUTPUT_RESERVE.triple_extraction,
        responseFormat: "json",
        budgetMeta,
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
          requestMetaJson: { pageId, revisionId, budget: budgetMeta },
          responseMetaJson: parseFailed
            ? { error: "parse_failed", raw: aiResponse.content.slice(0, 500) }
            : { tripleCount: extracted.triples.length },
        })
        .returning();

      await job.updateProgress(60);

      const triplesCreated = await db.transaction(async (tx) => {
        await tx
          .update(triples)
          .set({ status: "superseded" })
          .where(
            and(
              eq(triples.workspaceId, workspaceId),
              eq(triples.sourcePageId, pageId),
              eq(triples.status, "active"),
            ),
          );

        if (extracted.triples.length === 0) {
          return 0;
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

        await tx.insert(entities).values(entityValues).onConflictDoNothing();

        // Bulk fetch all entity ids
        const allKeys = [...entityNames.keys()];
        const existingEntities = await tx
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

        const preparedTriples = prepareTriplesForInsert({
          extractedTriples: extracted.triples,
          entityIdMap,
          workspaceId,
          pageId,
          revisionId,
          modelRunId: modelRun.id,
        });

        const tripleValues = preparedTriples.map(({ spans, ...triple }) => triple);

        if (tripleValues.length === 0) {
          return 0;
        }

        const insertedTriples = await tx
          .insert(triples)
          .values(tripleValues)
          .returning({ id: triples.id });

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
          for (const span of preparedTriples[i].spans) {
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
          await tx.insert(tripleMentions).values(mentionRows);
        }

        return insertedTriples.length;
      });

      await job.updateProgress(80);

      const uniquePredicates = [
        ...new Set(extracted.triples.map((triple) => triple.predicate)),
      ];

      try {
        await ensurePredicateDisplayLabels({
          db,
          workspaceId,
          predicates: uniquePredicates,
          locale: "ko",
        });
      } catch (err) {
        log.warn({ err, pageId }, "Predicate label backfill failed");
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
