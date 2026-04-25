import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { eq, and, sql, desc, inArray, isNull } from "drizzle-orm";
import { createRedisConnection } from "../connection.js";
import { createJobLogger } from "../logger.js";
import { getQueue, QUEUE_NAMES, JOB_NAMES } from "../queues.js";
import { getAIAdapter, getDefaultProvider } from "../ai-gateway.js";
import { getDb } from "@wekiflow/db/client";
import {
  ingestions,
  ingestionDecisions,
  modelRuns,
  pages,
  pagePaths,
  pageRevisions,
  entities,
  triples,
  auditLogs,
  insertPageWithUniqueSlug,
} from "@wekiflow/db";
import {
  DEFAULT_JOB_OPTIONS,
  classifyDecisionStatus,
  routeDecisionSchema,
  extractIngestionText,
  normalizeKey,
  slugify,
  estimateTokens,
  sliceWithinTokenBudget,
  allocateBudgets,
  getModelContextBudget,
  MODE_OUTPUT_RESERVE,
} from "@wekiflow/shared";
import type {
  RouteClassifierJobData,
  RouteClassifierJobResult,
  PatchGeneratorJobData,
  TripleExtractorJobData,
  AIRequest,
  AIBudgetMeta,
  AIProvider,
} from "@wekiflow/shared";

const PROMPT_VERSION = "route-classifier-v1";
const moduleLog = createJobLogger("route-classifier");

type CandidateMatchSource = "title" | "fts" | "trigram" | "entity";

interface CandidatePage {
  id: string;
  title: string;
  slug: string;
  contentMd: string;
  matchSources: CandidateMatchSource[];
}

// Server-side cap on fetched candidate markdown. Well above any realistic
// per-candidate token budget (≈12.5k tokens of mixed text) but small enough
// to bound DB bandwidth + worker memory across ~10 candidates × N concurrency.
const CANDIDATE_CONTENT_CHAR_CAP = 50_000;
const candidateContentSql = sql<string>`SUBSTRING(${pageRevisions.contentMd}, 1, ${CANDIDATE_CONTENT_CHAR_CAP})`;

async function findCandidatePages(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  titleHint: string | null,
  normalizedText: string | null,
): Promise<CandidatePage[]> {
  // Ordered list preserves insertion order (= search priority). The map lets a
  // page discovered by multiple search strategies accumulate match sources.
  const candidates: CandidatePage[] = [];
  const byId = new Map<string, CandidatePage>();
  const addMatch = (
    row: { id: string; title: string; slug: string; contentMd: string | null },
    source: CandidateMatchSource,
  ) => {
    const existing = byId.get(row.id);
    if (existing) {
      if (!existing.matchSources.includes(source)) {
        existing.matchSources.push(source);
      }
      return;
    }
    const candidate: CandidatePage = {
      id: row.id,
      title: row.title,
      slug: row.slug,
      contentMd: row.contentMd ?? "",
      matchSources: [source],
    };
    byId.set(row.id, candidate);
    candidates.push(candidate);
  };

  // Title match with current revision excerpt
  if (titleHint) {
    const titleMatches = await db
      .select({
        id: pages.id,
        title: pages.title,
        slug: pages.slug,
        contentMd: candidateContentSql,
      })
      .from(pages)
      .leftJoin(pageRevisions, eq(pageRevisions.id, pages.currentRevisionId))
      .where(
        and(
          eq(pages.workspaceId, workspaceId),
          isNull(pages.deletedAt),
          sql`LOWER(${pages.title}) LIKE LOWER(${"%" + titleHint + "%"})`,
        ),
      )
      .limit(5);

    for (const row of titleMatches) addMatch(row, "title");
  }

  // Full-text search on revision content
  if (normalizedText && candidates.length < 5) {
    const tsQuery = normalizedText
      .slice(0, 200)
      .replace(/[^\w\s]/g, " ")
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 6)
      .join(" & ");

    if (tsQuery) {
      try {
        const ftsMatches = await db
          .select({
            id: pages.id,
            title: pages.title,
            slug: pages.slug,
            contentMd: candidateContentSql,
          })
          .from(pages)
          .innerJoin(
            pageRevisions,
            eq(pageRevisions.id, pages.currentRevisionId),
          )
          .where(
            and(
              eq(pages.workspaceId, workspaceId),
              isNull(pages.deletedAt),
              sql`TO_TSVECTOR('english', ${pageRevisions.contentMd}) @@ TO_TSQUERY('english', ${tsQuery})`,
            ),
          )
          .orderBy(
            sql`TS_RANK(TO_TSVECTOR('english', ${pageRevisions.contentMd}), TO_TSQUERY('english', ${tsQuery})) DESC`,
          )
          .limit(5);

        for (const row of ftsMatches) addMatch(row, "fts");
      } catch (err) {
        moduleLog.warn({ err }, "FTS search failed, skipping");
      }
    }
  }

  // Trigram search (pg_trgm) if we still need more candidates
  if (normalizedText && candidates.length < 5) {
    const textSnippet = normalizedText.slice(0, 200);
    try {
      const trigramMatches = await db
        .select({
          id: pages.id,
          title: pages.title,
          slug: pages.slug,
          contentMd: candidateContentSql,
        })
        .from(pages)
        .innerJoin(pageRevisions, eq(pageRevisions.id, pages.currentRevisionId))
        .where(
          and(
            eq(pages.workspaceId, workspaceId),
            isNull(pages.deletedAt),
            sql`SIMILARITY(${pages.title}, ${textSnippet}) > 0.1`,
          ),
        )
        .orderBy(sql`SIMILARITY(${pages.title}, ${textSnippet}) DESC`)
        .limit(5);

      for (const row of trigramMatches) addMatch(row, "trigram");
    } catch (err) {
      moduleLog.warn({ err }, "Trigram search failed, skipping");
    }
  }

  // Entity overlap search: find pages that share entities mentioned in the incoming text
  if (normalizedText && candidates.length < 5) {
    try {
      const words = normalizedText
        .slice(0, 500)
        .replace(/[^\w\s]/g, " ")
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .map((w) => normalizeKey(w))
        .filter(Boolean)
        .slice(0, 10);

      if (words.length > 0) {
        const entityOverlapMatches = await db
          .select({
            id: pages.id,
            title: pages.title,
            slug: pages.slug,
            contentMd: candidateContentSql,
          })
          .from(pages)
          .innerJoin(
            pageRevisions,
            eq(pageRevisions.id, pages.currentRevisionId),
          )
          .innerJoin(triples, eq(triples.sourcePageId, pages.id))
          .innerJoin(entities, eq(entities.id, triples.subjectEntityId))
          .where(
            and(
              eq(pages.workspaceId, workspaceId),
              isNull(pages.deletedAt),
              inArray(entities.normalizedKey, words),
            ),
          )
          .groupBy(pages.id, pages.title, pages.slug, pageRevisions.contentMd)
          .orderBy(sql`COUNT(DISTINCT ${entities.id}) DESC`)
          .limit(5);

        for (const row of entityOverlapMatches) addMatch(row, "entity");
      }
    } catch (err) {
      moduleLog.warn({ err }, "Entity overlap search failed, skipping");
    }
  }

  return candidates.slice(0, 10);
}

const ROUTE_SYSTEM_PROMPT = `You are a route-decision engine for a knowledge wiki.
Given an incoming document and a list of existing candidate pages, decide what to do.

Possible actions:
- "create": The incoming content is new and should create a new page
- "update": The incoming content should replace an existing page's content
- "append": The incoming content should be appended to an existing page
- "noop": The incoming content is not relevant or already exists
- "needs_review": You are not confident enough to make a decision

Respond with JSON matching this schema:
{
  "action": "create" | "update" | "append" | "noop" | "needs_review",
  "targetPageId": "<uuid or null>",
  "confidence": <0.0-1.0>,
  "reason": "<explanation>",
  "proposedTitle": "<suggested title if action=create>"
}

Be conservative — prefer "needs_review" if confidence < 0.6.`;

function buildRoutePrompt(
  ingestion: {
    sourceName: string;
    titleHint: string | null;
    normalizedText: string | null;
    rawPayload: unknown;
    contentType: string;
  },
  candidates: CandidatePage[],
  provider: AIProvider,
  model: string,
): { messages: AIRequest["messages"]; budgetMeta: AIBudgetMeta } {
  const incomingContent = extractIngestionText(ingestion);

  const budget = getModelContextBudget(provider, model);
  const systemTokens = estimateTokens(ROUTE_SYSTEM_PROMPT);
  // Coarse fixed overhead for the user-message scaffolding (labels, separators).
  const SCAFFOLD_TOKENS = 200;
  const rawAvailable =
    budget.inputTokenBudget -
    MODE_OUTPUT_RESERVE.route_decision -
    systemTokens -
    SCAFFOLD_TOKENS;
  const available = Math.max(
    1_000,
    Math.floor(rawAvailable * budget.safetyMarginRatio),
  );

  // Incoming-first: the ingestion payload drives the decision, candidates are
  // just identification hints. Send only the top 3 (by search ordering) into
  // the prompt with small floors; incoming gets a large floor + most of the
  // slack. The rest of findCandidatePages's results stay DB-side for recall.
  const PROMPT_CANDIDATE_LIMIT = 3;
  const promptCandidates = candidates.slice(0, PROMPT_CANDIDATE_LIMIT);
  const candidateSlots = promptCandidates.map((c, i) => ({
    key: `candidate_${i}`,
    text: c.contentMd,
    minTokens: 100,
    weight: 1,
  }));
  const slots = [
    { key: "incoming", text: incomingContent, minTokens: 80_000, weight: 10 },
    ...candidateSlots,
  ];
  const allocations = allocateBudgets(slots, available, {
    preserveStructure: true,
  });

  const incomingSliced = allocations.incoming;
  const candidateList =
    promptCandidates.length > 0
      ? promptCandidates
          .map((c, i) => {
            const excerpt = allocations[`candidate_${i}`].text;
            return `[${i + 1}] id=${c.id}, title="${c.title}", excerpt="${excerpt}"`;
          })
          .join("\n")
      : "(no existing pages found)";

  const messages: AIRequest["messages"] = [
    { role: "system", content: ROUTE_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Source: ${ingestion.sourceName}
Title hint: ${ingestion.titleHint ?? "(none)"}
Content type: ${ingestion.contentType}
Incoming content:
---
${incomingSliced.text}
---

Existing candidate pages:
${candidateList}`,
    },
  ];

  const slotAllocations: AIBudgetMeta["slotAllocations"] = {};
  let anyTruncated = false;
  let estimatedInputTokens = systemTokens + SCAFFOLD_TOKENS;
  let inputCharLength = ROUTE_SYSTEM_PROMPT.length;
  for (const [key, alloc] of Object.entries(allocations)) {
    slotAllocations[key] = {
      allocatedTokens: alloc.allocatedTokens,
      estimatedTokens: alloc.estimatedTokens,
      truncated: alloc.truncated,
    };
    if (alloc.truncated) anyTruncated = true;
    estimatedInputTokens += alloc.estimatedTokens;
    inputCharLength += alloc.text.length;
  }

  const budgetMeta: AIBudgetMeta = {
    inputTokenBudget: available,
    estimatedInputTokens,
    inputCharLength,
    truncated: anyTruncated,
    strategy: "incoming_priority_structure_preserving",
    slotAllocations,
  };

  return { messages, budgetMeta };
}

export function createRouteClassifierWorker(): Worker {
  const db = getDb();

  const worker = new Worker<RouteClassifierJobData, RouteClassifierJobResult>(
    QUEUE_NAMES.INGESTION,
    async (job: Job<RouteClassifierJobData>) => {
      const { ingestionId, workspaceId } = job.data;
      const log = createJobLogger("route-classifier", job.id);
      log.info({ ingestionId }, "Processing ingestion");

      const [ingestion] = await db
        .select()
        .from(ingestions)
        .where(eq(ingestions.id, ingestionId))
        .limit(1);

      if (!ingestion) {
        throw new Error(`Ingestion ${ingestionId} not found`);
      }

      await db
        .update(ingestions)
        .set({ status: "processing" })
        .where(eq(ingestions.id, ingestionId));

      await job.updateProgress(10);

      // Normalize text if not already done
      let normalizedText = ingestion.normalizedText;
      if (!normalizedText) {
        normalizedText = extractIngestionText(ingestion);
        await db
          .update(ingestions)
          .set({ normalizedText })
          .where(eq(ingestions.id, ingestionId));
      }

      await job.updateProgress(20);

      const candidates = await findCandidatePages(
        db,
        workspaceId,
        ingestion.titleHint,
        normalizedText,
      );

      await job.updateProgress(40);

      const { provider, model } = getDefaultProvider();
      const adapter = getAIAdapter(provider);

      const { messages, budgetMeta } = buildRoutePrompt(
        { ...ingestion, normalizedText },
        candidates,
        provider,
        model,
      );

      const aiRequest: AIRequest = {
        provider,
        model,
        mode: "route_decision",
        promptVersion: PROMPT_VERSION,
        messages,
        temperature: 0.1,
        maxTokens: 1024,
        responseFormat: "json",
        budgetMeta,
      };

      const aiResponse = await adapter.chat(aiRequest);

      await job.updateProgress(70);

      let parsed;
      let parseFailed = false;
      try {
        const raw = JSON.parse(aiResponse.content);
        parsed = routeDecisionSchema.parse(raw);
      } catch (err) {
        log.error({ err, ingestionId }, "Failed to parse LLM response");
        parseFailed = true;
        parsed = {
          action: "needs_review" as const,
          targetPageId: null,
          confidence: 0,
          reason: `LLM response parsing failed: ${aiResponse.content.slice(0, 200)}`,
          proposedTitle: undefined,
        };
      }

      const [modelRun] = await db
        .insert(modelRuns)
        .values({
          workspaceId,
          provider,
          modelName: model,
          mode: "route_decision",
          promptVersion: PROMPT_VERSION,
          tokenInput: aiResponse.tokenInput,
          tokenOutput: aiResponse.tokenOutput,
          latencyMs: aiResponse.latencyMs,
          status: parseFailed ? "failed" : "success",
          requestMetaJson: {
            ingestionId,
            candidateCount: candidates.length,
            budget: budgetMeta,
          },
          responseMetaJson: parseFailed
            ? { error: "parse_failed", raw: aiResponse.content.slice(0, 500) }
            : { action: parsed.action, confidence: parsed.confidence },
        })
        .returning();

      await job.updateProgress(80);

      const initialStatus = classifyDecisionStatus(
        parsed.action,
        parsed.confidence,
      );

      // Snapshot the candidates the classifier considered so the review UI
      // can show reviewers what the AI was choosing between. Strip contentMd
      // (kept only for LLM context) to keep the JSONB row compact.
      const candidateSnapshot = candidates.map((c) => ({
        id: c.id,
        title: c.title,
        slug: c.slug,
        matchSources: c.matchSources,
      }));

      const [decision] = await db
        .insert(ingestionDecisions)
        .values({
          ingestionId,
          targetPageId: parsed.targetPageId,
          modelRunId: modelRun.id,
          action: parsed.action,
          status: initialStatus,
          proposedPageTitle: parsed.proposedTitle ?? null,
          confidence: parsed.confidence,
          rationaleJson: {
            reason: parsed.reason,
            candidates: candidateSnapshot,
          },
        })
        .returning();

      if (
        initialStatus === "auto_applied" &&
        (parsed.action === "update" || parsed.action === "append") &&
        parsed.targetPageId
      ) {
        // Snapshot the page's current revision as the patch-generator's
        // baseline. If a human saves a new revision between now and when
        // the patch job runs, the worker detects the drift and downgrades
        // the decision instead of silently overwriting the human's edit.
        const [targetPage] = await db
          .select({ currentRevisionId: pages.currentRevisionId })
          .from(pages)
          .where(eq(pages.id, parsed.targetPageId))
          .limit(1);
        const baseRevisionId = targetPage?.currentRevisionId ?? null;

        await db
          .update(ingestionDecisions)
          .set({
            rationaleJson: {
              reason: parsed.reason,
              candidates: candidateSnapshot,
              baseRevisionId,
            },
          })
          .where(eq(ingestionDecisions.id, decision.id));

        const patchData: PatchGeneratorJobData = {
          ingestionId,
          decisionId: decision.id,
          workspaceId,
          targetPageId: parsed.targetPageId,
          action: parsed.action,
          baseRevisionId,
        };
        const patchQueue = getQueue(QUEUE_NAMES.PATCH);
        await patchQueue.add(
          JOB_NAMES.PATCH_GENERATOR,
          patchData,
          DEFAULT_JOB_OPTIONS,
        );
      } else if (
        initialStatus === "auto_applied" &&
        parsed.action === "create"
      ) {
        const title =
          parsed.proposedTitle ?? ingestion.titleHint ?? "Untitled (ingested)";
        const contentMd = extractIngestionText({
          normalizedText,
          rawPayload: ingestion.rawPayload,
        });

        const page = await insertPageWithUniqueSlug(db, {
          workspaceId,
          title,
          baseSlug: slugify(title),
          parentFolderId: ingestion.targetFolderId ?? null,
          parentPageId: ingestion.targetParentPageId ?? null,
        });

        const [revision] = await db
          .insert(pageRevisions)
          .values({
            pageId: page.id,
            actorType: "ai",
            source: "ingest_api",
            sourceIngestionId: ingestionId,
            sourceDecisionId: decision.id,
            contentMd,
            revisionNote: `Auto-created from ingestion ${ingestion.sourceName}`,
          })
          .returning();

        const now = new Date();
        await Promise.all([
          db
            .update(pages)
            .set({
              currentRevisionId: revision.id,
              lastAiUpdatedAt: now,
            })
            .where(eq(pages.id, page.id)),
          db.insert(pagePaths).values({
            workspaceId,
            pageId: page.id,
            path: page.slug,
            isCurrent: true,
          }),
          db
            .update(ingestionDecisions)
            .set({ targetPageId: page.id, proposedRevisionId: revision.id })
            .where(eq(ingestionDecisions.id, decision.id)),
          db
            .update(ingestions)
            .set({ status: "completed", processedAt: now })
            .where(eq(ingestions.id, ingestionId)),
          db.insert(auditLogs).values({
            workspaceId,
            modelRunId: modelRun.id,
            entityType: "page",
            entityId: page.id,
            action: "create",
            afterJson: {
              source: "route_classifier_auto",
              ingestionId,
              decisionId: decision.id,
              confidence: parsed.confidence,
            },
          }),
        ]);

        const extractionData: TripleExtractorJobData = {
          workspaceId,
          pageId: page.id,
          revisionId: revision.id,
          useReconciliation: ingestion.useReconciliation,
        };
        const extractionQueue = getQueue(QUEUE_NAMES.EXTRACTION);
        await extractionQueue.add(
          JOB_NAMES.TRIPLE_EXTRACTOR,
          extractionData,
          DEFAULT_JOB_OPTIONS,
        );
        const searchQueue = getQueue(QUEUE_NAMES.SEARCH);
        await searchQueue.add(
          JOB_NAMES.SEARCH_INDEX_UPDATER,
          {
            workspaceId,
            pageId: page.id,
            revisionId: revision.id,
          },
          DEFAULT_JOB_OPTIONS,
        );
      } else {
        // Suggested / needs_review / noop: the classifier's job is done.
        // Mark the ingestion complete so it drops off the active queue; the
        // decision row now carries the human-review state via its own status.
        await db
          .update(ingestions)
          .set({ status: "completed", processedAt: new Date() })
          .where(eq(ingestions.id, ingestionId));
      }

      await job.updateProgress(100);

      return {
        ingestionId,
        decisionId: decision.id,
        action: parsed.action,
        confidence: parsed.confidence,
      };
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
    },
  );

  worker.on("completed", (job, result) => {
    const log = createJobLogger("route-classifier", job.id);
    log.info(
      { action: result.action, confidence: result.confidence },
      "Route classification completed",
    );
  });

  worker.on("failed", (job, err) => {
    const log = createJobLogger("route-classifier", job?.id);
    log.error({ err }, "Job failed");
    if (!job?.data?.ingestionId) return;

    const ingestionId = job.data.ingestionId;
    const workspaceId = job.data.workspaceId;
    const attemptsMade = job.attemptsMade ?? 0;
    const maxAttempts = job.opts?.attempts ?? 1;
    const isFinalAttempt = attemptsMade >= maxAttempts;

    (async () => {
      await db
        .update(ingestions)
        .set({ status: "failed", processedAt: new Date() })
        .where(eq(ingestions.id, ingestionId));

      // On the final attempt, surface the failure in the review queue by
      // writing a decision row with status='failed'. Without this, a crashed
      // classifier drops the ingestion out of every human-visible tab.
      if (!isFinalAttempt) return;

      const [existing] = await db
        .select({ id: ingestionDecisions.id })
        .from(ingestionDecisions)
        .where(eq(ingestionDecisions.ingestionId, ingestionId))
        .limit(1);
      if (existing) return;

      const errMessage = err instanceof Error ? err.message : String(err);
      const { provider, model } = getDefaultProvider();

      const [modelRun] = await db
        .insert(modelRuns)
        .values({
          workspaceId,
          provider,
          modelName: model,
          mode: "route_decision",
          promptVersion: PROMPT_VERSION,
          tokenInput: 0,
          tokenOutput: 0,
          latencyMs: 0,
          status: "failed",
          requestMetaJson: { ingestionId, attempts: attemptsMade },
          responseMetaJson: { error: errMessage.slice(0, 1000) },
        })
        .returning();

      await db.insert(ingestionDecisions).values({
        ingestionId,
        modelRunId: modelRun.id,
        action: "needs_review",
        status: "failed",
        confidence: 0,
        rationaleJson: {
          reason: `Classifier crashed after ${attemptsMade} attempt(s): ${errMessage.slice(0, 500)}`,
        },
      });
    })().catch((e) =>
      log.error({ err: e, ingestionId }, "Failed to record classifier failure"),
    );
  });

  return worker;
}
