// Only boots when ENABLE_SYNTHESIS_WORKER=true.
// Retained for chunking, map/reduce evidence aggregation, evidence-pack
// generation, and coverage calculation — future long-document ingest/patch
// reuse.
import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createRedisConnection } from "../connection.js";
import { createJobLogger } from "../logger.js";
import { getAIAdapter, getDefaultProvider } from "../ai-gateway.js";
import { QUEUE_NAMES } from "../queues.js";
import { getDb } from "@wekiflow/db/client";
import {
  auditLogs,
  buildRevisionChunks,
  entities,
  getOrBuildRevisionChunks,
  ingestionDecisions,
  ingestions,
  modelRuns,
  pageRevisions,
  pages,
  triples,
} from "@wekiflow/db";
import type { BuiltRevisionChunk, CachedRevisionChunk } from "@wekiflow/db";
import {
  allocateBudgets,
  estimateTokens,
  extractDeterministicFacts,
  IMPORT_SOURCE_NAMES,
  MODE_OUTPUT_RESERVE,
  getModelContextBudget,
} from "@wekiflow/shared";
import type { DeterministicFacts } from "@wekiflow/shared";
import type {
  AIBudgetMeta,
  AIRequest,
  SynthesisGeneratorJobData,
  SynthesisGeneratorJobResult,
} from "@wekiflow/shared";

const PROMPT_VERSION = "synthesis-generator-v1";
const MAP_PROMPT_VERSION = "synthesis-map-v1";
const MAX_SOURCE_LEAF_CHUNKS = 12;
const MAX_PAGE_LEAF_CHUNKS = 12;
const MAX_TRIPLES = 30;
// Hard cap on map-stage summaries to keep worst-case LLM spend bounded for a
// single synthesis. Leaves beyond this are dropped (truncated=true).
const MAX_MAP_SUMMARIES = 48;
const MAP_CONCURRENCY = 3;
const MAP_SUMMARY_CHARS = 600;

type SynthesisPayload = {
  prompt?: unknown;
  sourceText?: unknown;
  targetPageId?: unknown;
  seedPageIds?: unknown;
  seedEntityIds?: unknown;
};

function asPayload(value: unknown): SynthesisPayload {
  return typeof value === "object" && value !== null ? (value as SynthesisPayload) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function keywordScore(prompt: string, text: string): number {
  const terms = prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 3)
    .slice(0, 30);
  if (terms.length === 0) return 0;
  const haystack = text.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

type ScoreableChunk = Pick<
  BuiltRevisionChunk | CachedRevisionChunk,
  "chunkKind" | "chunkIndex" | "contentMd" | "contentHash" | "digestText" | "headingPath"
>;

type EvidenceChunk = Pick<
  ScoreableChunk,
  "headingPath" | "digestText" | "contentMd" | "contentHash"
>;

function selectTopLeafChunks<T extends ScoreableChunk>(
  prompt: string,
  chunks: T[],
  limit: number,
): T[] {
  return chunks
    .filter((chunk) => chunk.chunkKind === "leaf")
    .map((chunk) => ({ chunk, score: keywordScore(prompt, chunk.contentMd) }))
    .sort((a, b) => b.score - a.score || a.chunk.chunkIndex - b.chunk.chunkIndex)
    .slice(0, limit)
    .map(({ chunk }) => chunk);
}

function selectChunkEvidence(
  prompt: string,
  sourceText: string,
  limit: number,
): EvidenceChunk[] {
  if (!sourceText.trim()) return [];
  return selectTopLeafChunks(prompt, buildRevisionChunks(sourceText), limit).map(
    (chunk) => ({
      headingPath: chunk.headingPath,
      digestText: chunk.digestText,
      contentMd: chunk.contentMd,
      contentHash: chunk.contentHash,
    }),
  );
}

type MapSummary = {
  ref: string;
  headingPath: string[];
  contentHash: string;
  summary: string;
};

type StructuredFact = {
  origin: "source" | "page";
  pageId: string | null;
  pageTitle: string | null;
  facts: DeterministicFacts;
};

function formatStructuredFacts(blocks: StructuredFact[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    const originLabel =
      block.origin === "source"
        ? "SOURCE"
        : `PAGE ${block.pageTitle ?? ""} (${block.pageId ?? ""})`;
    const pieces: string[] = [];
    if (block.facts.title) pieces.push(`title=${block.facts.title}`);
    if (block.facts.aliases.length > 0)
      pieces.push(`aliases=${block.facts.aliases.join(", ")}`);
    if (block.facts.tags.length > 0)
      pieces.push(`tags=${block.facts.tags.join(", ")}`);
    if (block.facts.wikilinks.length > 0) {
      pieces.push(
        `wikilinks=${block.facts.wikilinks
          .map((w) => (w.display ? `${w.target} (${w.display})` : w.target))
          .join("; ")}`,
      );
    }
    if (block.facts.externalLinks.length > 0) {
      pieces.push(
        `links=${block.facts.externalLinks
          .slice(0, 12)
          .map((l) => `${l.text} → ${l.url}`)
          .join("; ")}`,
      );
    }
    if (pieces.length === 0) continue;
    lines.push(`${originLabel}\n  ${pieces.join("\n  ")}`);
  }
  return lines.join("\n\n");
}

function formatEvidence(evidence: {
  sourceChunks: ReturnType<typeof selectChunkEvidence>;
  sourceSummaries: MapSummary[];
  structuredFacts: StructuredFact[];
  pageChunks: Array<{
    pageId: string;
    pageTitle: string;
    revisionId: string;
    headingPath: string[];
    digestText: string;
    contentMd: string;
    contentHash: string;
  }>;
  graphTriples: Array<{
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
    pageId: string;
  }>;
}): string {
  const source = evidence.sourceChunks
    .map(
      (chunk, index) => `SOURCE_CHUNK ${index + 1}
heading=${chunk.headingPath.join(" > ") || "Document"}
hash=${chunk.contentHash}
digest=${chunk.digestText}
excerpt:
${chunk.contentMd}`,
    )
    .join("\n\n");

  const summaries = evidence.sourceSummaries
    .map(
      (item) => `${item.ref}
heading=${item.headingPath.join(" > ") || "Document"}
hash=${item.contentHash}
summary:
${item.summary}`,
    )
    .join("\n\n");

  const pagesText = evidence.pageChunks
    .map(
      (chunk, index) => `PAGE_CHUNK ${index + 1}
page=${chunk.pageTitle} (${chunk.pageId})
revision=${chunk.revisionId}
heading=${chunk.headingPath.join(" > ") || "Document"}
hash=${chunk.contentHash}
digest=${chunk.digestText}
excerpt:
${chunk.contentMd}`,
    )
    .join("\n\n");

  const graph = evidence.graphTriples
    .map(
      (triple) =>
        `- ${triple.subject} ${triple.predicate} ${triple.object} (confidence ${Math.round(
          triple.confidence * 100,
        )}%, page ${triple.pageId})`,
    )
    .join("\n");

  const structured = formatStructuredFacts(evidence.structuredFacts);

  return [
    structured ? `## Structured facts (deterministic)\n${structured}` : "",
    source ? `## Source chunks\n${source}` : "",
    summaries
      ? `## Source chunk digests (map-reduce summaries)\n${summaries}`
      : "",
    pagesText ? `## Workspace page chunks\n${pagesText}` : "",
    graph ? `## Graph facts\n${graph}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Runs async tasks with a fixed concurrency limit. Preserves input order in
 * the output. No external dependency — the whole worker pool is trivial.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(concurrency, items.length))
    .fill(0)
    .map(async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await task(items[index], index);
      }
    });
  await Promise.all(workers);
  return results;
}

export function createSynthesisGeneratorWorker(): Worker {
  const db = getDb();

  const worker = new Worker<SynthesisGeneratorJobData, SynthesisGeneratorJobResult>(
    QUEUE_NAMES.SYNTHESIS,
    async (job: Job<SynthesisGeneratorJobData>) => {
      const { ingestionId, workspaceId, requestedByUserId } = job.data;
      const log = createJobLogger("synthesis-generator", job.id);
      log.info({ ingestionId }, "Generating synthesis proposal");

      const [existingDecision] = await db
        .select({ id: ingestionDecisions.id })
        .from(ingestionDecisions)
        .where(eq(ingestionDecisions.ingestionId, ingestionId))
        .limit(1);
      if (existingDecision) {
        return {
          status: "queued",
          ingestionId,
          decisionId: existingDecision.id,
        };
      }

      const [ingestion] = await db
        .select({
          id: ingestions.id,
          sourceName: ingestions.sourceName,
          titleHint: ingestions.titleHint,
          rawPayload: ingestions.rawPayload,
        })
        .from(ingestions)
        .where(
          and(
            eq(ingestions.id, ingestionId),
            eq(ingestions.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      if (!ingestion) throw new Error(`Ingestion ${ingestionId} not found`);

      await db
        .update(ingestions)
        .set({ status: "processing" })
        .where(eq(ingestions.id, ingestionId));
      await job.updateProgress(10);

      const payload = asPayload(ingestion.rawPayload);
      const prompt =
        typeof payload.prompt === "string" ? payload.prompt : ingestion.titleHint ?? "";
      const sourceText = typeof payload.sourceText === "string" ? payload.sourceText : "";
      const targetPageId =
        typeof payload.targetPageId === "string" ? payload.targetPageId : null;
      const seedPageIds = asStringArray(payload.seedPageIds);

      const sourceFacts = sourceText.trim()
        ? extractDeterministicFacts(sourceText)
        : null;
      const sourceBody = sourceFacts?.strippedMarkdown ?? sourceText;
      const sourceLeafChunks = sourceBody.trim()
        ? buildRevisionChunks(sourceBody).filter(
            (chunk) => chunk.chunkKind === "leaf",
          )
        : [];
      const selectedSourceLeaves = selectTopLeafChunks(
        prompt,
        sourceLeafChunks,
        MAX_SOURCE_LEAF_CHUNKS,
      );
      const sourceChunks: EvidenceChunk[] = selectedSourceLeaves.map(
        (chunk) => ({
          headingPath: chunk.headingPath,
          digestText: chunk.digestText,
          contentMd: chunk.contentMd,
          contentHash: chunk.contentHash,
        }),
      );

      // Map-reduce fallback for long source documents: every leaf that didn't
      // make the top-K gets a short summary LLM call so no chunk is silently
      // dropped. The final synthesis call then sees full excerpts for the
      // top-K plus summaries for the rest.
      const selectedHashes = new Set(sourceChunks.map((c) => c.contentHash));
      const overflowLeaves = sourceLeafChunks.filter(
        (chunk) => !selectedHashes.has(chunk.contentHash),
      );
      const mapTargets = overflowLeaves.slice(0, MAX_MAP_SUMMARIES);
      const mapOverflowDropped = overflowLeaves.length - mapTargets.length;

      const pageWhere =
        seedPageIds.length > 0
          ? and(
              eq(pages.workspaceId, workspaceId),
              inArray(pages.id, seedPageIds),
              sql`${pages.currentRevisionId} IS NOT NULL`,
            )
          : and(
              eq(pages.workspaceId, workspaceId),
              sql`${pages.currentRevisionId} IS NOT NULL`,
              sql`${pages.deletedAt} IS NULL`,
            );

      const pageRows = await db
        .select({
          pageId: pages.id,
          title: pages.title,
          revisionId: pageRevisions.id,
          contentMd: pageRevisions.contentMd,
        })
        .from(pages)
        .innerJoin(pageRevisions, eq(pageRevisions.id, pages.currentRevisionId))
        .where(pageWhere)
        .orderBy(desc(pages.updatedAt))
        .limit(seedPageIds.length > 0 ? seedPageIds.length : 8);

      // Cache-first chunk lookup per page — hits revision_chunks when the
      // extractor or a prior synthesis already persisted them, and only
      // re-parses on the first touch for a brand-new revision.
      const pageChunkGroups = await Promise.all(
        pageRows.map(async (row) => {
          const cached = await getOrBuildRevisionChunks(db, {
            workspaceId,
            pageId: row.pageId,
            revisionId: row.revisionId,
            contentMd: row.contentMd,
          });
          return selectTopLeafChunks(prompt, cached, 4).map((chunk) => ({
            headingPath: chunk.headingPath,
            digestText: chunk.digestText,
            contentMd: chunk.contentMd,
            contentHash: chunk.contentHash,
            pageId: row.pageId,
            pageTitle: row.title,
            revisionId: row.revisionId,
          }));
        }),
      );

      const pageChunks = pageChunkGroups
        .flat()
        .map((chunk) => ({ chunk, score: keywordScore(prompt, chunk.contentMd) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_PAGE_LEAF_CHUNKS)
        .map(({ chunk }) => chunk);

      const graphTriples =
        pageRows.length > 0
          ? await db
              .select({
                subject: entities.canonicalName,
                predicate: triples.predicate,
                objectLiteral: triples.objectLiteral,
                confidence: triples.confidence,
                pageId: triples.sourcePageId,
              })
              .from(triples)
              .innerJoin(entities, eq(entities.id, triples.subjectEntityId))
              .where(
                and(
                  eq(triples.workspaceId, workspaceId),
                  inArray(
                    triples.sourcePageId,
                    pageRows.map((row) => row.pageId),
                  ),
                  eq(triples.status, "active"),
                ),
              )
              .orderBy(desc(triples.confidence))
              .limit(MAX_TRIPLES)
          : [];

      await job.updateProgress(30);

      const { provider, model } = getDefaultProvider();
      const adapter = getAIAdapter(provider);

      const mapSystemPrompt = `You summarize a single Markdown chunk for a downstream synthesis writer.
Return 1-3 sentences that capture what this chunk contributes to the user's prompt.
Use the original language of the chunk. Quote short spans only when the exact wording matters.
Stay under 120 words. Return plain text (no Markdown headings).`;

      const mapModelRunIds: string[] = [];
      const mapSummaries: MapSummary[] = [];

      if (mapTargets.length > 0) {
        log.info(
          { count: mapTargets.length, dropped: mapOverflowDropped },
          "Running map stage for overflow source chunks",
        );
        const summaries = await runWithConcurrency(
          mapTargets,
          MAP_CONCURRENCY,
          async (chunk) => {
            const mapRequest: AIRequest = {
              provider,
              model,
              mode: "synthesis_map",
              promptVersion: MAP_PROMPT_VERSION,
              messages: [
                { role: "system", content: mapSystemPrompt },
                {
                  role: "user",
                  content: `Synthesis prompt:
${prompt}

Chunk heading: ${chunk.headingPath.join(" > ") || "Document"}
Chunk content:
${chunk.contentMd}`,
                },
              ],
              temperature: 0.1,
              maxTokens: MODE_OUTPUT_RESERVE.synthesis_map,
            };
            try {
              const response = await adapter.chat(mapRequest);
              const [run] = await db
                .insert(modelRuns)
                .values({
                  workspaceId,
                  provider,
                  modelName: model,
                  mode: "synthesis_map",
                  promptVersion: MAP_PROMPT_VERSION,
                  tokenInput: response.tokenInput,
                  tokenOutput: response.tokenOutput,
                  latencyMs: response.latencyMs,
                  status: "success",
                  requestMetaJson: {
                    ingestionId,
                    contentHash: chunk.contentHash,
                    headingPath: chunk.headingPath,
                  },
                  responseMetaJson: {
                    summaryLength: response.content.length,
                  },
                })
                .returning({ id: modelRuns.id });
              mapModelRunIds.push(run.id);
              return response.content.trim().slice(0, MAP_SUMMARY_CHARS);
            } catch (err) {
              log.warn(
                { err, contentHash: chunk.contentHash },
                "Map summarizer failed for chunk",
              );
              return chunk.digestText;
            }
          },
        );
        mapTargets.forEach((chunk, index) => {
          mapSummaries.push({
            ref: `SD${index + 1}`,
            headingPath: chunk.headingPath,
            contentHash: chunk.contentHash,
            summary: summaries[index],
          });
        });
      }

      await job.updateProgress(55);

      const structuredFacts: StructuredFact[] = [];
      if (sourceFacts) {
        structuredFacts.push({
          origin: "source",
          pageId: null,
          pageTitle: null,
          facts: sourceFacts,
        });
      }
      for (const row of pageRows) {
        const facts = extractDeterministicFacts(row.contentMd);
        if (
          facts.title ||
          facts.aliases.length ||
          facts.tags.length ||
          facts.externalLinks.length ||
          facts.wikilinks.length
        ) {
          structuredFacts.push({
            origin: "page",
            pageId: row.pageId,
            pageTitle: row.title,
            facts,
          });
        }
      }

      const evidenceText = formatEvidence({
        sourceChunks,
        sourceSummaries: mapSummaries,
        structuredFacts,
        pageChunks,
        graphTriples: graphTriples.map((triple) => ({
          subject: triple.subject,
          predicate: triple.predicate,
          object: triple.objectLiteral ?? "(entity object)",
          confidence: triple.confidence,
          pageId: triple.pageId,
        })),
      });
      const systemPrompt = `You are a grounded synthesis writer for a supervised Markdown knowledge wiki.
Write a new Markdown document from the provided evidence only.
Do not invent facts. If evidence is insufficient, write a short "Open questions" section.
Evidence comes in five tiers:
- Structured facts (deterministic): pre-extracted titles, tags, aliases, and links. Trust these for naming and cross-refs.
- Full source excerpts [S1..]: verbatim source text.
- Source chunk digests [SD1..]: short summaries of long-source chunks that could not be included in full. Use for orientation only; do not quote verbatim.
- Workspace page excerpts [P1..]: relevant parts of existing wiki pages.
- Graph facts [G1..]: triple facts extracted from the workspace.
Prefer citations from [S*] and [P*] when quoting. Use [SD*] only for orientation.
Use concise headings and cite evidence inline with markers like [S1], [SD2], [P3], or [G4] when possible.
Return only Markdown.`;

      const budget = getModelContextBudget(provider, model);
      const systemTokens = estimateTokens(systemPrompt);
      const scaffoldTokens = 300;
      const rawAvailable =
        budget.inputTokenBudget -
        MODE_OUTPUT_RESERVE.synthesis_generation -
        systemTokens -
        scaffoldTokens;
      const available = Math.max(
        4_000,
        Math.floor(rawAvailable * budget.safetyMarginRatio),
      );
      const allocations = allocateBudgets(
        [
          { key: "prompt", text: prompt, minTokens: 1_000, weight: 0 },
          { key: "evidence", text: evidenceText, minTokens: 20_000, weight: 1 },
        ],
        available,
        { preserveStructure: true },
      );
      const promptSlot = allocations.prompt;
      const evidenceSlot = allocations.evidence;

      const budgetMeta: AIBudgetMeta = {
        inputTokenBudget: available,
        estimatedInputTokens:
          systemTokens +
          scaffoldTokens +
          promptSlot.estimatedTokens +
          evidenceSlot.estimatedTokens,
        inputCharLength:
          systemPrompt.length + promptSlot.text.length + evidenceSlot.text.length,
        // If the map stage hit its cap (dropped > 0), the source is truly
        // beyond what we can represent — surface that as truncated even if
        // the final slot fit. Slot-level truncation still propagates.
        truncated:
          promptSlot.truncated ||
          evidenceSlot.truncated ||
          mapOverflowDropped > 0,
        strategy: mapTargets.length > 0
          ? "map_reduce_structure_preserving"
          : "evidence_pack_structure_preserving",
        slotAllocations: {
          prompt: {
            allocatedTokens: promptSlot.allocatedTokens,
            estimatedTokens: promptSlot.estimatedTokens,
            truncated: promptSlot.truncated,
          },
          evidence: {
            allocatedTokens: evidenceSlot.allocatedTokens,
            estimatedTokens: evidenceSlot.estimatedTokens,
            truncated: evidenceSlot.truncated,
          },
        },
      };

      const aiRequest: AIRequest = {
        provider,
        model,
        mode: "synthesis_generation",
        promptVersion: PROMPT_VERSION,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Synthesis request:
${promptSlot.text}

Evidence pack:
${evidenceSlot.text}`,
          },
        ],
        temperature: 0.2,
        maxTokens: MODE_OUTPUT_RESERVE.synthesis_generation,
        budgetMeta,
      };

      const aiResponse = await adapter.chat(aiRequest);
      const generatedMarkdown = aiResponse.content.trim();

      const [modelRun] = await db
        .insert(modelRuns)
        .values({
          workspaceId,
          provider,
          modelName: model,
          mode: "synthesis_generation",
          promptVersion: PROMPT_VERSION,
          tokenInput: aiResponse.tokenInput,
          tokenOutput: aiResponse.tokenOutput,
          latencyMs: aiResponse.latencyMs,
          status: "success",
          requestMetaJson: {
            ingestionId,
            targetPageId,
            seedPageIds,
            budget: budgetMeta,
            evidenceCounts: {
              sourceChunks: sourceChunks.length,
              sourceSummaries: mapSummaries.length,
              sourceLeavesTotal: sourceLeafChunks.length,
              sourceLeavesDropped: mapOverflowDropped,
              pageChunks: pageChunks.length,
              triples: graphTriples.length,
            },
            mapModelRunIds,
          },
          responseMetaJson: { contentLength: generatedMarkdown.length },
        })
        .returning();

      await job.updateProgress(75);

      const title =
        ingestion.titleHint ??
        generatedMarkdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ??
        "AI synthesis";
      const now = new Date();
      const [decision] = await db.transaction(async (tx) => {
        await tx
          .update(ingestions)
          .set({
            normalizedText: generatedMarkdown,
            status: "completed",
            processedAt: now,
          })
          .where(eq(ingestions.id, ingestionId));

        const [createdDecision] = await tx
          .insert(ingestionDecisions)
          .values({
            ingestionId,
            targetPageId,
            modelRunId: modelRun.id,
            action: targetPageId ? "update" : "create",
            status: "suggested",
            proposedPageTitle: targetPageId ? null : title,
            confidence: 0.75,
            rationaleJson: {
              reason: mapTargets.length > 0
                ? "AI synthesis proposal generated via map-reduce over long source"
                : "AI synthesis proposal generated from bounded evidence pack",
              synthesis: {
                prompt,
                targetPageId,
                budgetTruncated: budgetMeta.truncated,
                strategy: budgetMeta.strategy,
                mapReduce: {
                  sourceLeavesTotal: sourceLeafChunks.length,
                  sourceLeavesFull: sourceChunks.length,
                  sourceLeavesSummarized: mapSummaries.length,
                  sourceLeavesDropped: mapOverflowDropped,
                },
                evidence: {
                  sourceChunks: sourceChunks.map((chunk, index) => ({
                    ref: `S${index + 1}`,
                    headingPath: chunk.headingPath,
                    digest: chunk.digestText,
                    contentHash: chunk.contentHash,
                  })),
                  sourceSummaries: mapSummaries.map((item) => ({
                    ref: item.ref,
                    headingPath: item.headingPath,
                    summary: item.summary,
                    contentHash: item.contentHash,
                  })),
                  pageChunks: pageChunks.map((chunk, index) => ({
                    ref: `P${index + 1}`,
                    pageId: chunk.pageId,
                    pageTitle: chunk.pageTitle,
                    revisionId: chunk.revisionId,
                    headingPath: chunk.headingPath,
                    digest: chunk.digestText,
                    contentHash: chunk.contentHash,
                  })),
                  triples: graphTriples.map((triple, index) => ({
                    ref: `G${index + 1}`,
                    subject: triple.subject,
                    predicate: triple.predicate,
                    object: triple.objectLiteral ?? "(entity object)",
                    confidence: triple.confidence,
                    pageId: triple.pageId,
                  })),
                },
              },
            },
          })
          .returning();

        await tx.insert(auditLogs).values({
          workspaceId,
          userId: requestedByUserId,
          modelRunId: modelRun.id,
          entityType: "ingestion",
          entityId: ingestionId,
          action: "synthesis_generate",
          afterJson: {
            decisionId: createdDecision.id,
            targetPageId,
            budgetTruncated: budgetMeta.truncated,
          },
        });

        return [createdDecision];
      });

      await job.updateProgress(100);
      log.info({ decisionId: decision.id }, "Synthesis proposal queued");
      return { status: "queued", ingestionId, decisionId: decision.id };
    },
    {
      connection: createRedisConnection(),
      concurrency: 2,
    },
  );

  worker.on("completed", (job, result) => {
    const log = createJobLogger("synthesis-generator", job.id);
    log.info({ ingestionId: result.ingestionId, decisionId: result.decisionId }, "Job completed");
  });

  worker.on("failed", (job, err) => {
    const log = createJobLogger("synthesis-generator", job?.id);
    log.error({ err, ingestionId: job?.data?.ingestionId }, "Job failed");
    if (!job?.data?.ingestionId) return;
    db.update(ingestions)
      .set({ status: "failed", processedAt: new Date() })
      .where(eq(ingestions.id, job.data.ingestionId))
      .catch((updateErr) =>
        log.error({ err: updateErr }, "Failed to persist synthesis failure"),
      );
  });

  return worker;
}
