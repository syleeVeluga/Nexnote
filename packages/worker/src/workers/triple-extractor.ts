// chunk-aware triple extraction
import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { eq, and, inArray, notInArray, isNotNull } from "drizzle-orm";
import { createRedisConnection } from "../connection.js";
import { QUEUE_NAMES } from "../queues.js";
import { getAIAdapter, getDefaultProvider } from "../ai-gateway.js";
import { createJobLogger } from "../logger.js";
import { ensurePredicateDisplayLabels } from "../lib/predicate-label-cache.js";
import { getDb } from "@wekiflow/db/client";
import {
  entities,
  triples,
  tripleMentions,
  modelRuns,
  pageRevisions,
  pages,
  revisionChunks,
  getOrBuildRevisionChunks,
} from "@wekiflow/db";
import {
  reconcileEntitiesBulk,
  persistAliasInserts,
  buildDestinationFromPage,
} from "../lib/reconcile-entities.js";
import type { DeterministicFacts } from "@wekiflow/shared";
import {
  tripleExtractionSchema,
  normalizeKey,
  estimateTokens,
  extractDeterministicFacts,
  buildFocusedInput,
  partitionLeafChunksByHash,
  remapFocusedSpan,
  sliceWithinTokenBudget,
  getModelContextBudget,
  MODE_OUTPUT_RESERVE,
} from "@wekiflow/shared";
import type {
  TripleExtractorJobData,
  TripleExtractorJobResult,
  AIRequest,
  AIResponse,
  AIBudgetMeta,
  TripleExtraction,
  TripleEntityType,
} from "@wekiflow/shared";

const PROMPT_VERSION = "triple-extractor-v4";

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

export type DeterministicSeed = {
  subjectKey: string;
  subjectName: string;
  predicate: string;
  objectLiteral: string;
};

/**
 * Produces literal-object triples for facts a deterministic parser found in
 * the page (frontmatter, explicit links, wikilinks). All seeds share the
 * page's title entity as subject — the subject represents "this page" in the
 * knowledge graph, so tags/aliases/links attach directly to it.
 */
export function buildDeterministicSeeds(
  facts: DeterministicFacts,
  pageTitle: string,
): DeterministicSeed[] {
  const subjectName = pageTitle.trim();
  if (!subjectName) return [];
  const subjectKey = normalizeKey(subjectName);
  const seeds: DeterministicSeed[] = [];
  const seen = new Set<string>();
  const push = (predicate: string, object: string) => {
    const key = `${predicate}|${object}`;
    if (seen.has(key)) return;
    seen.add(key);
    seeds.push({
      subjectKey,
      subjectName,
      predicate,
      objectLiteral: object,
    });
  };
  for (const alias of facts.aliases) if (alias) push("has_alias", alias);
  for (const tag of facts.tags) if (tag) push("has_tag", tag);
  for (const link of facts.externalLinks)
    if (link.url) push("mentions_url", link.url);
  for (const wiki of facts.wikilinks)
    if (wiki.target) push("links_to", wiki.target);
  return seeds;
}

type EntityNameCandidate = { name: string; type: TripleEntityType };

function addEntityNameCandidate(
  entityNames: Map<string, EntityNameCandidate>,
  key: string,
  name: string,
  type: TripleEntityType | undefined,
) {
  const nextType = type ?? "concept";
  const existing = entityNames.get(key);
  if (!existing) {
    entityNames.set(key, { name, type: nextType });
    return;
  }

  if (existing.type === "concept" && nextType !== "concept") {
    entityNames.set(key, { name: existing.name, type: nextType });
  }
}

export function collectEntityNamesForExtraction({
  extractedTriples,
  deterministicSeeds,
}: {
  extractedTriples: ExtractedTriple[];
  deterministicSeeds: DeterministicSeed[];
}): Map<string, EntityNameCandidate> {
  const entityNames = new Map<string, EntityNameCandidate>();
  for (const t of extractedTriples) {
    addEntityNameCandidate(
      entityNames,
      normalizeKey(t.subject),
      t.subject,
      t.subjectType,
    );
    if (t.objectType === "entity") {
      addEntityNameCandidate(
        entityNames,
        normalizeKey(t.object),
        t.object,
        t.objectEntityType,
      );
    }
  }
  for (const seed of deterministicSeeds) {
    addEntityNameCandidate(
      entityNames,
      seed.subjectKey,
      seed.subjectName,
      "concept",
    );
  }
  return entityNames;
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
      // Default to true so existing/manual enqueues (legacy ingestion path,
      // /scripts/reextract-triples.ts) keep their post-extraction reconcile
      // behavior. Callers that explicitly want fresh extraction (UI "Move
      // (fresh extract)" or import toggle) must pass false.
      const useReconciliation = job.data.useReconciliation ?? true;
      const log = createJobLogger("triple-extractor", job.id);

      log.info({ pageId, revisionId, useReconciliation }, "Processing page");

      const [revision] = await db
        .select({
          contentMd: pageRevisions.contentMd,
          pageTitle: pages.title,
          baseRevisionId: pageRevisions.baseRevisionId,
          parentFolderId: pages.parentFolderId,
          parentPageId: pages.parentPageId,
        })
        .from(pageRevisions)
        .innerJoin(pages, eq(pages.id, pageRevisions.pageId))
        .where(eq(pageRevisions.id, revisionId))
        .limit(1);

      if (!revision) {
        throw new Error(`Revision ${revisionId} not found`);
      }

      // Re-derive the destination at run time. The page may have moved
      // between job enqueue and dequeue (BullMQ retries, or move events
      // racing with import) — using current parent_*_id keeps reconciliation
      // anchored to where the page lives now, not where it was enqueued.
      const destination = buildDestinationFromPage(revision);

      await job.updateProgress(10);

      const chunkRefs = await getOrBuildRevisionChunks(db, {
        workspaceId,
        pageId,
        revisionId,
        contentMd: revision.contentMd,
      });

      const leafChunks = chunkRefs.filter((chunk) => chunk.chunkKind === "leaf");
      const findChunkIdForSpan = (span: {
        start: number;
        end: number;
      }): string | null => {
        const match = leafChunks.find(
          (chunk) => span.start >= chunk.charStart && span.end <= chunk.charEnd,
        );
        return match?.id ?? null;
      };

      // Chunk-aware strategy: if the previous revision's leaves are cached,
      // partition the new leaves into unchanged vs changed. Unchanged leaves'
      // LLM triples can be carried over (saving another LLM call for them),
      // and the LLM only has to re-scan the changed leaves. We read
      // revision_chunks directly here so a missed cache on the prior
      // revision simply yields [] (no spurious rebuild with empty content).
      const prevLeafChunks = revision.baseRevisionId
        ? await db
            .select({
              id: revisionChunks.id,
              chunkIndex: revisionChunks.chunkIndex,
              charStart: revisionChunks.charStart,
              charEnd: revisionChunks.charEnd,
              contentHash: revisionChunks.contentHash,
            })
            .from(revisionChunks)
            .where(
              and(
                eq(revisionChunks.revisionId, revision.baseRevisionId),
                eq(revisionChunks.chunkKind, "leaf"),
              ),
            )
        : [];

      const chunkPartition = partitionLeafChunksByHash(
        prevLeafChunks,
        leafChunks,
      );
      const unchangedPrevChunkIds = new Set(
        chunkPartition.unchanged.map((entry) => entry.prev.id),
      );
      const hasReusableChunks =
        prevLeafChunks.length > 0 && chunkPartition.unchanged.length > 0;

      // Compute reusable triples up-front — we need this to pick the right
      // strategy. Without it, a page whose prior extraction left no active
      // triples (e.g. a failed earlier run, or a concurrent revision race)
      // would take the "skip" path, do nothing, and leave the page with
      // zero triples forever.
      let reusableTripleIds: string[] = [];
      if (unchangedPrevChunkIds.size > 0) {
        const tripleMentionRows = await db
          .select({
            tripleId: triples.id,
            mentionChunkId: tripleMentions.revisionChunkId,
          })
          .from(triples)
          .leftJoin(tripleMentions, eq(tripleMentions.tripleId, triples.id))
          .where(
            and(
              eq(triples.workspaceId, workspaceId),
              eq(triples.sourcePageId, pageId),
              eq(triples.status, "active"),
              isNotNull(triples.extractionModelRunId),
            ),
          );

        const byTriple = new Map<string, Array<string | null>>();
        for (const row of tripleMentionRows) {
          const arr = byTriple.get(row.tripleId) ?? [];
          arr.push(row.mentionChunkId);
          byTriple.set(row.tripleId, arr);
        }
        for (const [tripleId, chunkIds] of byTriple) {
          const nonNull = chunkIds.filter(
            (id): id is string => id !== null,
          );
          if (nonNull.length === 0) continue;
          if (nonNull.length !== chunkIds.length) continue;
          const allPreserved = nonNull.every((id) =>
            unchangedPrevChunkIds.has(id),
          );
          if (allPreserved) reusableTripleIds.push(tripleId);
        }
      }

      // "skip" is only valid when every leaf matched AND we actually have
      // triples to keep alive; otherwise the page would end up wiped.
      // "chunk_delta" needs reusable chunks (not necessarily reusable
      // triples — the model may just rescan changed content).
      const everythingUnchanged =
        hasReusableChunks && chunkPartition.changed.length === 0;
      const llmInputStrategy: "full" | "chunk_delta" | "skip" =
        everythingUnchanged && reusableTripleIds.length > 0
          ? "skip"
          : hasReusableChunks && chunkPartition.changed.length > 0
            ? "chunk_delta"
            : "full";

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
- Prefer stable labels when applicable: \`is_a\`, \`part_of\`, \`located_in\`, \`works_at\`, \`founded_by\`, \`founded_in\`, \`born_in\`, \`announced_on\`, \`has_amount\`, \`has_date\`, \`produces\`.
- If you cannot assign a stable predicate without guessing, SKIP that triple.

## objectType rules
- \`entity\` — named entities, organizations, places, products, events, documents, or concepts explicitly referred to as entities.
- \`literal\` — dates, numbers, measurements, statuses, titles, and short descriptive values.

## Entity type rules
- \`subjectType\` and \`objectEntityType\` MUST use one of: \`person\`, \`organization\`, \`location\`, \`product\`, \`document\`, \`system\`, \`event\`, \`concept\`, \`development\`, \`research\`, \`marketing\`, \`policy\`, \`design\`, \`operations\`, \`legal\`, \`sales\`.
- \`person\`: individual humans (이순신, Jane Lee).
- \`organization\`: companies, teams, agencies, military units, committees (Acme Corp, 조선 수군).
- \`location\`: physical or geopolitical places (Seoul, 한산도).
- \`product\`: named products, models, or commercial offerings (gpt-5.4, iPhone).
- \`document\`: named documents or document-like artifacts (PRD, RFC, 회의록).
- \`system\`: software systems, databases, services, protocols, or infrastructure components (Postgres, BullMQ).
- \`event\`: named meetings, conferences, incidents, launches, or campaigns (KubeCon 2026, weekly planning meeting).
- \`development\`: software development efforts — features, sprints, codebases, engineering initiatives, refactors (auth-rewrite, Q3 platform migration).
- \`research\`: research efforts, studies, experiments, investigations, exploratory work (user interview round 3, latency study).
- \`marketing\`: marketing campaigns, brand programs, growth initiatives, content efforts (Q4 launch campaign, SEO push).
- \`policy\`: organizational policies, rules, guidelines, compliance standards, governance items (PTO policy, GDPR data-retention rule).
- \`design\`: design systems, visual identities, UX initiatives, design artifacts (design system v2, mobile redesign).
- \`operations\`: operational programs, processes, runbooks, on-call/SRE practices (incident-response runbook, weekly deploy process).
- \`legal\`: contracts, agreements, legal cases, legal entities-as-instruments (NDA, EULA, ToS-2026).
- \`sales\`: sales programs, deals, accounts as commercial relationships, sales motions (enterprise pilot, Q2 pipeline).
- \`concept\`: abstract topics, roles, categories, fields, or anything that does not clearly fit the above.
- If ambiguous, use \`concept\`. Omit \`objectEntityType\` when \`objectType\` is \`literal\`.

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
      "subjectType": "person" | "organization" | "location" | "product" | "document" | "system" | "event" | "concept" | "development" | "research" | "marketing" | "policy" | "design" | "operations" | "legal" | "sales",
      "predicate": "relationship_type",
      "object": "Another Entity or literal value",
      "objectType": "entity" | "literal",
      "objectEntityType": "person" | "organization" | "location" | "product" | "document" | "system" | "event" | "concept" | "development" | "research" | "marketing" | "policy" | "design" | "operations" | "legal" | "sales",
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
      "subjectType": "person",
      "predicate": "is_a",
      "object": "장군",
      "objectType": "entity",
      "objectEntityType": "concept",
      "confidence": 0.95,
      "spans": [{ "start": 0, "end": 18, "excerpt": "이순신은 조선 수군의 장군이었다." }]
    },
    {
      "subject": "이순신",
      "subjectType": "person",
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
      "subjectType": "organization",
      "predicate": "founded_by",
      "object": "Jane Lee",
      "objectType": "entity",
      "objectEntityType": "person",
      "confidence": 0.95,
      "spans": [{ "start": 0, "end": 42, "excerpt": "Acme Corp was founded in 2010 by Jane Lee." }]
    },
    {
      "subject": "Acme Corp",
      "subjectType": "organization",
      "predicate": "founded_in",
      "object": "2010",
      "objectType": "literal",
      "confidence": 0.95,
      "spans": [{ "start": 0, "end": 42, "excerpt": "Acme Corp was founded in 2010 by Jane Lee." }]
    },
    {
      "subject": "Acme Corp",
      "subjectType": "organization",
      "predicate": "located_in",
      "object": "Seoul",
      "objectType": "entity",
      "objectEntityType": "location",
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

      // Strip frontmatter before the LLM sees it. Tags/aliases are already
      // structured and will be surfaced separately — spending tokens on the
      // YAML block only adds noise. For the "full" strategy, spans returned
      // by the model are into the stripped text; shift them back so mention
      // offsets index the original contentMd. The "chunk_delta" path uses
      // `remapFocusedSpan` instead, which already outputs original coords.
      const deterministicFacts = extractDeterministicFacts(revision.contentMd);

      // Shape a minimal focused input from just the changed leaves when we
      // have prior-revision coverage, otherwise fall back to the stripped
      // full document.
      const focused =
        llmInputStrategy === "chunk_delta"
          ? buildFocusedInput(chunkPartition.changed)
          : null;

      const rawInputForLlm = focused
        ? focused.inputText
        : deterministicFacts.strippedMarkdown;
      const fullDocOffsetShift = focused
        ? 0
        : revision.contentMd.length - deterministicFacts.strippedMarkdown.length;

      // Skip path: no LLM call, keep reusable triples alive, refresh deterministic.
      // contentSlice / budgetMeta are only meaningful when we actually call the
      // model, so defer the slice (string work on large markdown) and the
      // metadata struct behind the same guard as the LLM call.
      let aiResponse: AIResponse | null = null;
      let budgetMeta: AIBudgetMeta | null = null;
      if (llmInputStrategy !== "skip") {
        const contentSlice = sliceWithinTokenBudget(rawInputForLlm, available, {
          preserveStructure: true,
        });

        budgetMeta = {
          inputTokenBudget: available,
          estimatedInputTokens:
            systemTokens + SCAFFOLD_TOKENS + contentSlice.estimatedTokens,
          inputCharLength: systemPrompt.length + contentSlice.text.length,
          truncated: contentSlice.truncated,
          strategy: focused
            ? "chunk_delta_focused"
            : "single_slot_structure_preserving",
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

        aiResponse = await adapter.chat(aiRequest);
      }

      await job.updateProgress(50);

      let extracted: TripleExtraction = { triples: [] };
      let parseFailed = false;
      let outputTruncated = false;
      if (aiResponse) {
        const finishReason = aiResponse.finishReason?.toLowerCase() ?? null;
        outputTruncated =
          finishReason === "length" ||
          finishReason === "max_tokens" ||
          aiResponse.tokenOutput >= MODE_OUTPUT_RESERVE.triple_extraction;

        if (outputTruncated) {
          log.error(
            {
              revisionId,
              finishReason: aiResponse.finishReason,
              tokenOutput: aiResponse.tokenOutput,
              maxTokens: MODE_OUTPUT_RESERVE.triple_extraction,
            },
            "Triple extraction response hit the output limit",
          );
          parseFailed = true;
        } else {
          try {
            const raw = JSON.parse(aiResponse.content);
            extracted = tripleExtractionSchema.parse(raw);
          } catch (err) {
            log.error(
              { err, revisionId, finishReason: aiResponse.finishReason },
              "Failed to parse LLM response",
            );
            parseFailed = true;
          }
        }
      }

      const modelRun = aiResponse
        ? (
            await db
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
                requestMetaJson: {
                  pageId,
                  revisionId,
                  budget: budgetMeta,
                  strategy: llmInputStrategy,
                  maxOutputTokens: MODE_OUTPUT_RESERVE.triple_extraction,
                  changedChunks: chunkPartition.changed.length,
                  unchangedChunks: chunkPartition.unchanged.length,
                },
                responseMetaJson: parseFailed
                  ? {
                      error: outputTruncated
                        ? "output_truncated"
                        : "parse_failed",
                      finishReason: aiResponse.finishReason ?? null,
                      tokenOutput: aiResponse.tokenOutput,
                      maxOutputTokens: MODE_OUTPUT_RESERVE.triple_extraction,
                      contentLength: aiResponse.content.length,
                      rawStart: aiResponse.content.slice(0, 500),
                      rawEnd: aiResponse.content.slice(-500),
                    }
                  : {
                      tripleCount: extracted.triples.length,
                      finishReason: aiResponse.finishReason ?? null,
                    },
              })
              .returning()
          )[0]
        : null;

      await job.updateProgress(60);

      const deterministicSeeds = buildDeterministicSeeds(
        deterministicFacts,
        revision.pageTitle,
      );

      if (parseFailed) {
        throw new Error(
          outputTruncated
            ? `Triple extraction response hit the output limit for revision ${revisionId}`
            : `Triple extraction response could not be parsed for revision ${revisionId}`,
        );
      }

      const triplesCreated = await db.transaction(async (tx) => {
        const supersedeCondition = reusableTripleIds.length > 0
          ? and(
              eq(triples.workspaceId, workspaceId),
              eq(triples.sourcePageId, pageId),
              eq(triples.status, "active"),
              notInArray(triples.id, reusableTripleIds),
            )
          : and(
              eq(triples.workspaceId, workspaceId),
              eq(triples.sourcePageId, pageId),
              eq(triples.status, "active"),
            );

        await tx
          .update(triples)
          .set({ status: "superseded" })
          .where(supersedeCondition);

        if (extracted.triples.length === 0 && deterministicSeeds.length === 0) {
          return {
            llm: 0,
            deterministic: 0,
            reused: reusableTripleIds.length,
          };
        }

        // Batch entity resolution: collect all unique entity names from the
        // LLM extraction AND the deterministic seeds (the page's own title
        // entity anchors every seed), then bulk upsert.
        const entityNames = collectEntityNamesForExtraction({
          extractedTriples: extracted.triples,
          deterministicSeeds,
        });

        // The LLM never sees the destination vocabulary — reconciliation
        // happens AFTER extraction so it can't bias the model.
        const enableReconciliation =
          useReconciliation &&
          (destination.folderId !== undefined ||
            destination.parentPageId !== undefined);

        const reconcile = enableReconciliation
          ? await reconcileEntitiesBulk(tx, workspaceId, {
              entityNames,
              destination,
              modelRunId: modelRun?.id ?? null,
              sourcePageId: pageId,
            })
          : { reuseMap: new Map<string, string>(), aliasInserts: [], vocabularySize: 0 };

        const entityValues = [...entityNames.entries()]
          .filter(([key]) => !reconcile.reuseMap.has(key))
          .map(([key, val]) => ({
            workspaceId,
            canonicalName: val.name,
            normalizedKey: key,
            entityType: val.type,
          }));

        if (entityValues.length > 0) {
          await tx.insert(entities).values(entityValues).onConflictDoNothing();
        }

        const newKeys = entityValues.map((v) => v.normalizedKey);
        const existingEntities = newKeys.length > 0
          ? await tx
              .select({ id: entities.id, normalizedKey: entities.normalizedKey })
              .from(entities)
              .where(
                and(
                  eq(entities.workspaceId, workspaceId),
                  inArray(entities.normalizedKey, newKeys),
                ),
              )
          : [];

        const entityIdMap = new Map<string, string>(reconcile.reuseMap);
        for (const e of existingEntities) {
          entityIdMap.set(e.normalizedKey, e.id);
        }
        if (reconcile.aliasInserts.length > 0) {
          await persistAliasInserts(tx, reconcile.aliasInserts);
        }
        if (enableReconciliation) {
          log.info(
            {
              vocabularySize: reconcile.vocabularySize,
              reused: reconcile.reuseMap.size,
              aliasesInserted: reconcile.aliasInserts.length,
            },
            "Reconciliation summary",
          );
        }

        // LLM triples. Span remap depends on input strategy: "chunk_delta"
        // uses the focused-input index; "full" uses a flat shift for the
        // stripped frontmatter. A span that fails to remap (e.g. straddles
        // a chunk boundary in focused mode, or lands outside the sliced
        // content) is dropped — we never store coordinates we can't verify.
        const remapSpan = (
          span: ExtractedSpan,
        ): { start: number; end: number } | null => {
          if (focused) {
            return remapFocusedSpan(focused.index, {
              start: span.start,
              end: span.end,
            });
          }
          return {
            start: span.start + fullDocOffsetShift,
            end: span.end + fullDocOffsetShift,
          };
        };

        const preparedTriples = modelRun
          ? prepareTriplesForInsert({
              extractedTriples: extracted.triples,
              entityIdMap,
              workspaceId,
              pageId,
              revisionId,
              modelRunId: modelRun.id,
            })
          : [];
        const llmTripleValues = preparedTriples.map(
          ({ spans, ...triple }) => triple,
        );

        let llmInsertedCount = 0;
        if (llmTripleValues.length > 0) {
          const insertedTriples = await tx
            .insert(triples)
            .values(llmTripleValues)
            .returning({ id: triples.id });
          llmInsertedCount = insertedTriples.length;

          // Build mention rows from inserted LLM triples
          const mentionRows: Array<{
            tripleId: string;
            pageId: string;
            revisionId: string;
            revisionChunkId: string | null;
            spanStart: number;
            spanEnd: number;
            excerpt: string | null;
          }> = [];

          for (let i = 0; i < insertedTriples.length; i++) {
            for (const span of preparedTriples[i].spans) {
              const remapped = remapSpan(span);
              if (!remapped) continue;
              mentionRows.push({
                tripleId: insertedTriples[i].id,
                pageId,
                revisionId,
                revisionChunkId: findChunkIdForSpan(remapped),
                spanStart: remapped.start,
                spanEnd: remapped.end,
                excerpt: span.excerpt,
              });
            }
          }

          if (mentionRows.length > 0) {
            await tx.insert(tripleMentions).values(mentionRows);
          }
        }

        // Deterministic triples: always literal-object, confidence=1.0, no
        // modelRunId (NULL is the discriminator for "came from the pure
        // parser, not an LLM"). No mentions: the evidence is structural
        // (frontmatter or link syntax), not a prose span.
        let deterministicInsertedCount = 0;
        if (deterministicSeeds.length > 0) {
          const deterministicValues = deterministicSeeds
            .map((seed) => {
              const subjectEntityId = entityIdMap.get(seed.subjectKey);
              if (!subjectEntityId) return null;
              return {
                workspaceId,
                subjectEntityId,
                predicate: seed.predicate,
                objectEntityId: null,
                objectLiteral: seed.objectLiteral,
                confidence: 1,
                sourcePageId: pageId,
                sourceRevisionId: revisionId,
                extractionModelRunId: null,
                status: "active",
              };
            })
            .filter(
              (v): v is NonNullable<typeof v> => v !== null,
            );

          if (deterministicValues.length > 0) {
            const inserted = await tx
              .insert(triples)
              .values(deterministicValues)
              .returning({ id: triples.id });
            deterministicInsertedCount = inserted.length;
          }
        }

        return {
          llm: llmInsertedCount,
          deterministic: deterministicInsertedCount,
          reused: reusableTripleIds.length,
        };
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

      const total =
        triplesCreated.llm +
        triplesCreated.deterministic +
        triplesCreated.reused;
      log.info(
        {
          pageId,
          triplesCreated: total,
          llmCreated: triplesCreated.llm,
          deterministicCreated: triplesCreated.deterministic,
          llmReused: triplesCreated.reused,
          llmInputStrategy,
          changedChunks: chunkPartition.changed.length,
          unchangedChunks: chunkPartition.unchanged.length,
        },
        "Extraction complete",
      );

      return {
        pageId,
        triplesCreated: total,
        llmCreated: triplesCreated.llm,
        deterministicCreated: triplesCreated.deterministic,
        llmReused: triplesCreated.reused,
        llmInputStrategy,
      };
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
