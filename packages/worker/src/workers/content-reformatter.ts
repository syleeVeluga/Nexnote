import { randomBytes } from "node:crypto";
import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createRedisConnection } from "../connection.js";
import { getAIAdapter, getDefaultProvider } from "../ai-gateway.js";
import { getDb } from "@nexnote/db/client";
import {
  apiTokens,
  ingestions,
  ingestionDecisions,
  modelRuns,
  pages,
  pageRevisions,
  revisionDiffs,
  auditLogs,
} from "@nexnote/db";
import {
  computeDiff,
  DEFAULT_JOB_OPTIONS,
  estimateTokens,
  allocateBudgets,
  getModelContextBudget,
  MODE_OUTPUT_RESERVE,
  QUEUE_NAMES,
  IMPORT_SOURCE_NAMES,
} from "@nexnote/shared";
import type {
  ContentReformatterJobData,
  ContentReformatterJobResult,
  AIRequest,
  AIBudgetMeta,
} from "@nexnote/shared";
import { createJobLogger } from "../logger.js";

const PROMPT_VERSION = "content-reformat-v1";
const REFORMAT_TOKEN_NAME = "Content Reformat (system)";

const REFORMAT_SYSTEM_PROMPT = `You are a document restructurer for a Markdown knowledge wiki.
You MUST NOT omit, summarize, or infer any data point. Every fact in the original must appear in the output.

PASS 1 — IDENTIFY & EXTRACT
Determine the document type (choose one): data_list | legal_document | report | specification | other
List every discrete data point as JSON: { "type": "...", "dataPoints": ["...", "..."], "count": N }
Store type and count N internally.

PASS 2 — PLAN STRUCTURE
Choose structure based on document type:
- data_list: group by one dimension — by_status / by_priority / by_type / by_category / by_phase / flat_list
- legal_document: preserve original article/clause numbering as H2 (제1조, Article 1, etc.); each clause becomes a section
- report / specification: use existing section titles as H2, subsections as H3
- other: choose the most logical hierarchy found in the content itself

PASS 3 — REWRITE
Produce final Markdown:
- H2 (##) for each major section
- H3 (###) for subsections where appropriate
- Bullet list (- ) for enumerated items within a section
- For legal_document: keep clause numbers, party names, dates, and amounts verbatim; do not merge or split clauses
- Preserve ALL original values, identifiers, numbers, and technical/legal terms exactly
- End with: <!-- items: N -->

Return ONLY the final Markdown from PASS 3. Do not include the JSON from passes 1 or 2.
If optional instructions are provided, treat them as styling hints only — never cause data omission.`;


async function getOrCreateReformatTokenId(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  userId: string,
): Promise<string> {
  const [existing] = await db
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.workspaceId, workspaceId),
        eq(apiTokens.createdByUserId, userId),
        eq(apiTokens.name, REFORMAT_TOKEN_NAME),
        sql`${apiTokens.revokedAt} IS NULL`,
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const tokenHash = randomBytes(32).toString("hex");
  const [created] = await db
    .insert(apiTokens)
    .values({ workspaceId, createdByUserId: userId, name: REFORMAT_TOKEN_NAME, tokenHash })
    .returning({ id: apiTokens.id });
  return created.id;
}

function getReformatProvider(): { provider: "openai" | "gemini"; model: string } {
  if (process.env["AI_TEST_MODE"] === "mock") {
    return { provider: "openai", model: "mock-e2e" };
  }
  if (process.env["OPENAI_API_KEY"]) {
    return {
      provider: "openai",
      model: process.env["REFORMAT_OPENAI_MODEL"] ?? "gpt-5.4-mini",
    };
  }
  if (process.env["GEMINI_API_KEY"]) {
    return {
      provider: "gemini",
      model: process.env["REFORMAT_GEMINI_MODEL"] ?? "gemini-3.1-flash-lite",
    };
  }
  // Fall back to default provider
  return getDefaultProvider();
}

export function createContentReformatterWorker(): Worker {
  const db = getDb();

  const worker = new Worker<ContentReformatterJobData, ContentReformatterJobResult>(
    QUEUE_NAMES.REFORMAT,
    async (job: Job<ContentReformatterJobData>) => {
      const { pageId, workspaceId, requestedByUserId, instructions } = job.data;
      const log = createJobLogger("content-reformatter", job.id);

      log.info({ pageId }, "Processing reformat request");

      // 1. Pre-flight dedup: check for existing pending reformat decision
      const [pendingDecision] = await db
        .select({ id: ingestionDecisions.id })
        .from(ingestionDecisions)
        .innerJoin(ingestions, eq(ingestions.id, ingestionDecisions.ingestionId))
        .where(
          and(
            eq(ingestionDecisions.targetPageId, pageId),
            eq(ingestions.sourceName, IMPORT_SOURCE_NAMES.REFORMAT_REQUEST),
            inArray(ingestionDecisions.status, ["suggested", "needs_review"]),
          ),
        )
        .limit(1);

      if (pendingDecision) {
        log.info({ decisionId: pendingDecision.id }, "Reformat already pending");
        return { status: "already_pending", decisionId: pendingDecision.id };
      }

      // 2. Fetch current page revision
      const [page] = await db
        .select({ currentRevisionId: pages.currentRevisionId })
        .from(pages)
        .where(and(eq(pages.id, pageId), eq(pages.workspaceId, workspaceId)))
        .limit(1);

      if (!page) throw new Error(`Page ${pageId} not found`);
      if (!page.currentRevisionId) {
        return { status: "skipped", reason: "no_content" };
      }

      const [rev] = await db
        .select({ contentMd: pageRevisions.contentMd })
        .from(pageRevisions)
        .where(eq(pageRevisions.id, page.currentRevisionId))
        .limit(1);

      if (!rev) throw new Error(`Revision ${page.currentRevisionId} not found`);
      await job.updateProgress(10);

      // 3. Guard: skip only truly trivial content (< 200 chars).
      // Line-count checks are unreliable — PDFs/DOCX often extract as a single
      // long line with all whitespace stripped. Character length is the only
      // robust signal for "nothing to reformat".
      if (rev.contentMd.trim().length < 200) {
        return { status: "skipped", reason: "too_short" };
      }
      await job.updateProgress(30);

      // 5. Run reformat AI call
      const { provider, model } = getReformatProvider();
      const adapter = getAIAdapter(provider);

      const userMessage = instructions
        ? `Optional styling instructions: ${instructions}\n\n---\n\n${rev.contentMd}`
        : rev.contentMd;

      const budget = getModelContextBudget(provider, model);
      const systemTokens = estimateTokens(REFORMAT_SYSTEM_PROMPT);
      const SCAFFOLD_TOKENS = 150;
      const rawAvailable =
        budget.inputTokenBudget -
        MODE_OUTPUT_RESERVE.content_reformat -
        systemTokens -
        SCAFFOLD_TOKENS;
      const available = Math.max(4_000, Math.floor(rawAvailable * budget.safetyMarginRatio));

      const allocations = allocateBudgets(
        [{ key: "content", text: userMessage, minTokens: 60_000, weight: 1 }],
        available,
        { preserveStructure: true },
      );
      const contentSlot = allocations.content;

      const budgetMeta: AIBudgetMeta = {
        inputTokenBudget: available,
        estimatedInputTokens: systemTokens + SCAFFOLD_TOKENS + contentSlot.estimatedTokens,
        inputCharLength: REFORMAT_SYSTEM_PROMPT.length + contentSlot.text.length,
        truncated: contentSlot.truncated,
        strategy: "single_slot_structure_preserving",
        slotAllocations: {
          content: {
            allocatedTokens: contentSlot.allocatedTokens,
            estimatedTokens: contentSlot.estimatedTokens,
            truncated: contentSlot.truncated,
          },
        },
      };

      const aiRequest: AIRequest = {
        provider,
        model,
        mode: "content_reformat",
        promptVersion: PROMPT_VERSION,
        messages: [
          { role: "system", content: REFORMAT_SYSTEM_PROMPT },
          { role: "user", content: contentSlot.text },
        ],
        temperature: 0.2,
        maxTokens: MODE_OUTPUT_RESERVE.content_reformat,
        budgetMeta,
      };

      const aiResponse = await adapter.chat(aiRequest);
      const reformattedMd = aiResponse.content;
      // Compute diff now (pure fn) so it doesn't block later DB waves
      const diff = computeDiff(rev.contentMd, reformattedMd, null, null);
      await job.updateProgress(65);

      // Wave 1: modelRun insert + apiToken provisioning are independent
      const [modelRun, apiTokenId] = await Promise.all([
        db
          .insert(modelRuns)
          .values({
            workspaceId,
            provider,
            modelName: model,
            mode: "content_reformat",
            promptVersion: PROMPT_VERSION,
            tokenInput: aiResponse.tokenInput,
            tokenOutput: aiResponse.tokenOutput,
            latencyMs: aiResponse.latencyMs,
            status: "success",
            requestMetaJson: { pageId, budget: budgetMeta },
            responseMetaJson: { contentLength: reformattedMd.length },
          })
          .returning()
          .then((rows) => rows[0]),
        getOrCreateReformatTokenId(db, workspaceId, requestedByUserId),
      ]);

      await job.updateProgress(70);

      // Wave 2: syntheticIngestion (needs apiTokenId) + proposedRevision (needs modelRun.id) are independent of each other
      const idempotencyKey = `reformat:${pageId}:${page.currentRevisionId}`;
      const [syntheticIngestion, proposedRevision] = await Promise.all([
        db
          .insert(ingestions)
          .values({
            workspaceId,
            apiTokenId,
            sourceName: IMPORT_SOURCE_NAMES.REFORMAT_REQUEST,
            idempotencyKey,
            contentType: "text/markdown",
            titleHint: null,
            rawPayload: { pageId, requestedByUserId, instructions: instructions ?? null },
            normalizedText: rev.contentMd,
            status: "completed",
            processedAt: new Date(),
          })
          .returning()
          .then((rows) => rows[0]),
        db
          .insert(pageRevisions)
          .values({
            pageId,
            baseRevisionId: page.currentRevisionId,
            modelRunId: modelRun.id,
            actorType: "ai",
            source: "ingest_api",
            contentMd: reformattedMd,
            revisionNote: "AI reformat — pending review",
          })
          .returning()
          .then((rows) => rows[0]),
      ]);

      await job.updateProgress(80);

      // Wave 3: decision needs both IDs from wave 2
      const [decision] = await db
        .insert(ingestionDecisions)
        .values({
          ingestionId: syntheticIngestion.id,
          targetPageId: pageId,
          proposedRevisionId: proposedRevision.id,
          modelRunId: modelRun.id,
          action: "update",
          // Fixed at 0.75: above SUGGESTION_MIN (0.6), below AUTO_APPLY (0.85)
          // User explicitly requested, so always lands in review queue — never auto-applied.
          confidence: 0.75,
          status: "suggested",
          rationaleJson: { reason: "User-requested content reformat — review before applying" },
        })
        .returning();

      // Wave 4: revisionDiff + sourceDecisionId backfill + audit log are all independent
      await Promise.all([
        db.insert(revisionDiffs).values({
          revisionId: proposedRevision.id,
          diffMd: diff.diffMd,
          diffOpsJson: diff.diffOpsJson,
          changedBlocks: diff.changedBlocks,
        }),
        db
          .update(pageRevisions)
          .set({ sourceDecisionId: decision.id, sourceIngestionId: syntheticIngestion.id })
          .where(eq(pageRevisions.id, proposedRevision.id)),
        db.insert(auditLogs).values({
          workspaceId,
          userId: requestedByUserId,
          modelRunId: modelRun.id,
          entityType: "page",
          entityId: pageId,
          action: "reformat",
          afterJson: {
            ingestionId: syntheticIngestion.id,
            decisionId: decision.id,
            proposedRevisionId: proposedRevision.id,
          },
        }),
      ]);

      await job.updateProgress(100);

      log.info({ decisionId: decision.id, proposedRevisionId: proposedRevision.id }, "Reformat queued for review");

      return { status: "queued", decisionId: decision.id };
    },
    {
      connection: createRedisConnection(),
      concurrency: 2,
    },
  );

  worker.on("completed", (job, result) => {
    const log = createJobLogger("content-reformatter", job.id);
    log.info({ pageId: job.data.pageId, status: result.status }, "Job completed");
  });

  worker.on("failed", (job, err) => {
    const log = createJobLogger("content-reformatter", job?.id);
    log.error({ err, pageId: job?.data?.pageId }, "Job failed");
  });

  return worker;
}
