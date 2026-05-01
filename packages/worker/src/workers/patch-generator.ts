import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { createRedisConnection } from "../connection.js";
import { getQueue, QUEUE_NAMES, JOB_NAMES } from "../queues.js";
import { getAIAdapter, getDefaultProvider } from "../ai-gateway.js";
import { getDb } from "@wekiflow/db/client";
import {
  ingestions,
  ingestionDecisions,
  modelRuns,
  pages,
  pageRevisions,
  revisionDiffs,
  auditLogs,
} from "@wekiflow/db";
import {
  computeDiff,
  extractIngestionText,
  DEFAULT_JOB_OPTIONS,
  estimateTokens,
  sliceWithinTokenBudget,
  allocateBudgets,
  getModelContextBudget,
  MODE_OUTPUT_RESERVE,
} from "@wekiflow/shared";
import type {
  PatchGeneratorJobData,
  PatchGeneratorJobResult,
  TripleExtractorJobData,
  AIRequest,
  AIBudgetMeta,
} from "@wekiflow/shared";
import { createJobLogger } from "../logger.js";

const PROMPT_VERSION = "patch-generator-v1";

type ConflictingRevision = {
  id: string;
  actorUserId: string | null;
  createdAt: Date;
  revisionNote: string | null;
};

/**
 * Check whether the target page has been modified by a human since the
 * classifier snapshotted `baseRevisionId`. Returns the most recent
 * human-authored revision if so, or null when the AI is still safe to
 * auto-apply.
 *
 * Drift from AI→AI (e.g., another ingestion patched the page in between)
 * is NOT treated as a conflict — the patch-generator re-merges against
 * current head regardless, so the AI output is never stale. The spec
 * specifically calls out "human session" as the race we need to guard.
 */
async function detectHumanConflict(
  db: ReturnType<typeof getDb>,
  targetPageId: string,
  baseRevisionId: string | null,
): Promise<ConflictingRevision | null> {
  let baseCreatedAt: Date | null = null;
  if (baseRevisionId) {
    const [baseRev] = await db
      .select({ createdAt: pageRevisions.createdAt })
      .from(pageRevisions)
      .where(eq(pageRevisions.id, baseRevisionId))
      .limit(1);
    // A classifier snapshot pointing at a revision that no longer exists
    // means the history was rewritten under us; treat that as drift too.
    if (!baseRev) {
      baseCreatedAt = new Date(0);
    } else {
      baseCreatedAt = baseRev.createdAt;
    }
  }

  const conditions = [
    eq(pageRevisions.pageId, targetPageId),
    eq(pageRevisions.actorType, "user"),
  ];
  if (baseCreatedAt) {
    conditions.push(gt(pageRevisions.createdAt, baseCreatedAt));
  }

  const [intruder] = await db
    .select({
      id: pageRevisions.id,
      actorUserId: pageRevisions.actorUserId,
      createdAt: pageRevisions.createdAt,
      revisionNote: pageRevisions.revisionNote,
    })
    .from(pageRevisions)
    .where(and(...conditions))
    .orderBy(desc(pageRevisions.createdAt))
    .limit(1);

  return intruder ?? null;
}

export function createPatchGeneratorWorker(): Worker {
  const db = getDb();

  const worker = new Worker<PatchGeneratorJobData, PatchGeneratorJobResult>(
    QUEUE_NAMES.PATCH,
    async (job: Job<PatchGeneratorJobData>) => {
      const {
        ingestionId,
        decisionId,
        workspaceId,
        targetPageId,
        action,
        baseRevisionId,
        contentOverrideMd,
        sectionHint,
        agentRunId,
        scheduledRunId,
      } = job.data;
      const log = createJobLogger("patch-generator", job.id);

      log.info({ ingestionId, action }, "Processing ingestion");

      // Fetch ingestion (only needed columns) and target page in parallel
      const [[ingestion], [page]] = await Promise.all([
        db
          .select({
            sourceName: ingestions.sourceName,
            normalizedText: ingestions.normalizedText,
            rawPayload: ingestions.rawPayload,
          })
          .from(ingestions)
          .where(eq(ingestions.id, ingestionId))
          .limit(1),
        db
          .select({
            id: pages.id,
            currentRevisionId: pages.currentRevisionId,
          })
          .from(pages)
          .where(eq(pages.id, targetPageId))
          .limit(1),
      ]);

      if (!ingestion) throw new Error(`Ingestion ${ingestionId} not found`);
      if (!page) throw new Error(`Target page ${targetPageId} not found`);

      await job.updateProgress(10);

      // Fetch current revision content
      let existingContent = "";
      if (page.currentRevisionId) {
        const [rev] = await db
          .select({ contentMd: pageRevisions.contentMd })
          .from(pageRevisions)
          .where(eq(pageRevisions.id, page.currentRevisionId))
          .limit(1);
        if (rev) existingContent = rev.contentMd;
      }

      const incomingText = contentOverrideMd ?? extractIngestionText(ingestion);

      await job.updateProgress(20);

      // For "append", concatenate; for "update", use LLM to merge
      let newContent: string;
      let modelRunId: string | null = null;
      if (contentOverrideMd) {
        const [decision] = await db
          .select({ modelRunId: ingestionDecisions.modelRunId })
          .from(ingestionDecisions)
          .where(eq(ingestionDecisions.id, decisionId))
          .limit(1);
        modelRunId = decision?.modelRunId ?? null;
      }

      if (action === "append") {
        newContent = `${existingContent}\n\n${incomingText}`;
      } else if (contentOverrideMd) {
        newContent = contentOverrideMd;
      } else {
        const { provider, model } = getDefaultProvider();
        const adapter = getAIAdapter(provider);

        const systemPrompt = `You are a document editor for a Markdown knowledge wiki.
You will receive an existing page's Markdown content and incoming new content that should update it.
Merge the incoming content into the existing document intelligently:
- Preserve the existing structure where it makes sense
- Integrate new information into relevant sections
- Remove outdated information that the new content replaces
- Maintain consistent Markdown formatting

Return ONLY the final merged Markdown content, nothing else.`;

        const budget = getModelContextBudget(provider, model);
        const systemTokens = estimateTokens(systemPrompt);
        const SCAFFOLD_TOKENS = 100;
        const rawAvailable =
          budget.inputTokenBudget -
          MODE_OUTPUT_RESERVE.patch_generation -
          systemTokens -
          SCAFFOLD_TOKENS;
        const available = Math.max(
          2_000,
          Math.floor(rawAvailable * budget.safetyMarginRatio),
        );

        // Incoming-priority: the ingestion payload is the source of truth for
        // this merge, so it gets a large floor first; existing content gets a
        // smaller floor for merge context and absorbs only what's left over.
        // weight:0 on existing ensures remainder flows to incoming (via slack
        // redistribution when incoming still has unmet need).
        const allocations = allocateBudgets(
          [
            {
              key: "incoming",
              text: incomingText,
              minTokens: 100_000,
              weight: 1,
            },
            {
              key: "existing",
              text: existingContent,
              minTokens: 10_000,
              weight: 0,
            },
          ],
          available,
          { preserveStructure: true },
        );

        const existingSlot = allocations.existing;
        const incomingSlot = allocations.incoming;

        const budgetMeta: AIBudgetMeta = {
          inputTokenBudget: available,
          estimatedInputTokens:
            systemTokens +
            SCAFFOLD_TOKENS +
            existingSlot.estimatedTokens +
            incomingSlot.estimatedTokens,
          inputCharLength:
            systemPrompt.length +
            existingSlot.text.length +
            incomingSlot.text.length,
          truncated: existingSlot.truncated || incomingSlot.truncated,
          strategy: "incoming_priority_structure_preserving",
          slotAllocations: {
            existing: {
              allocatedTokens: existingSlot.allocatedTokens,
              estimatedTokens: existingSlot.estimatedTokens,
              truncated: existingSlot.truncated,
            },
            incoming: {
              allocatedTokens: incomingSlot.allocatedTokens,
              estimatedTokens: incomingSlot.estimatedTokens,
              truncated: incomingSlot.truncated,
            },
          },
        };

        const aiRequest: AIRequest = {
          provider,
          model,
          mode: "patch_generation",
          promptVersion: PROMPT_VERSION,
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `## Existing page content:
\`\`\`markdown
${existingSlot.text}
\`\`\`

## Incoming content to merge:
\`\`\`markdown
${incomingSlot.text}
\`\`\`

Produce the merged Markdown:`,
            },
          ],
          temperature: 0.2,
          maxTokens: MODE_OUTPUT_RESERVE.patch_generation,
          budgetMeta,
        };

        const aiResponse = await adapter.chat(aiRequest);
        newContent = aiResponse.content;

        const [run] = await db
          .insert(modelRuns)
          .values({
            workspaceId,
            provider,
            modelName: model,
            mode: "patch_generation",
            promptVersion: PROMPT_VERSION,
            tokenInput: aiResponse.tokenInput,
            tokenOutput: aiResponse.tokenOutput,
            latencyMs: aiResponse.latencyMs,
            status: "success",
            agentRunId: agentRunId ?? null,
            requestMetaJson: {
              ingestionId,
              targetPageId,
              action,
              agentRunId: agentRunId ?? null,
              scheduledRunId: scheduledRunId ?? null,
              budget: budgetMeta,
            },
            responseMetaJson: { contentLength: newContent.length },
          })
          .returning();

        modelRunId = run.id;
      }

      await job.updateProgress(60);

      // Detect human edits that landed between classification and now. The
      // conflict check runs AFTER the merge so the reviewer still gets a
      // useful proposed revision — we just refuse to auto-apply it.
      const conflict = await detectHumanConflict(
        db,
        targetPageId,
        baseRevisionId,
      );

      const [revision] = await db
        .insert(pageRevisions)
        .values({
          pageId: targetPageId,
          baseRevisionId: page.currentRevisionId,
          modelRunId,
          actorType: "ai",
          source: scheduledRunId ? "scheduled" : "ingest_api",
          sourceIngestionId: ingestionId,
          sourceDecisionId: decisionId,
          contentMd: newContent,
          revisionNote: conflict
            ? `Conflict-deferred ${action} from ingestion ${ingestion.sourceName}`
            : `Auto-${action} from ingestion ${ingestion.sourceName}`,
        })
        .returning();

      const diff = computeDiff(existingContent, newContent, null, null);
      const now = new Date();

      if (conflict) {
        // Human edit intervened since the classifier snapshot. Write the
        // proposed revision + diff, downgrade the decision to `suggested`,
        // and do NOT promote to current. Triple extraction waits until the
        // reviewer approves via apply-decision.
        await Promise.all([
          db.insert(revisionDiffs).values({
            revisionId: revision.id,
            diffMd: diff.diffMd,
            diffOpsJson: diff.diffOpsJson,
            changedBlocks: diff.changedBlocks,
          }),
          db
            .update(ingestionDecisions)
            .set({
              proposedRevisionId: revision.id,
              status: "suggested",
              rationaleJson: sql`
                jsonb_set(
                  COALESCE(${ingestionDecisions.rationaleJson}, '{}'::jsonb),
                  '{conflict}',
                  ${JSON.stringify({
                    type: "conflict_with_human_edit",
                    humanRevisionId: conflict.id,
                    humanUserId: conflict.actorUserId,
                    humanEditedAt: conflict.createdAt.toISOString(),
                    humanRevisionNote: conflict.revisionNote,
                    baseRevisionId,
                  })}::jsonb
                )
              `,
            })
            .where(eq(ingestionDecisions.id, decisionId)),
          db
            .update(ingestions)
            .set({ status: "completed", processedAt: now })
            .where(eq(ingestions.id, ingestionId)),
          db.insert(auditLogs).values({
            workspaceId,
            modelRunId: modelRunId ?? undefined,
            entityType: "page",
            entityId: targetPageId,
            action,
            afterJson: {
              source: "patch_generator_conflict_downgrade",
              ingestionId,
              scheduledRunId: scheduledRunId ?? null,
              decisionId,
              revisionId: revision.id,
              conflict: {
                humanRevisionId: conflict.id,
                humanEditedAt: conflict.createdAt.toISOString(),
              },
              agentRunId: agentRunId ?? null,
              sectionHint: sectionHint ?? null,
            },
          }),
        ]);

        log.info(
          {
            decisionId,
            targetPageId,
            baseRevisionId,
            humanRevisionId: conflict.id,
          },
          "Downgraded auto-apply to suggested due to concurrent human edit",
        );

        await job.updateProgress(100);
        return {
          ingestionId,
          revisionId: revision.id,
          pageId: targetPageId,
        };
      }

      await Promise.all([
        db.insert(revisionDiffs).values({
          revisionId: revision.id,
          diffMd: diff.diffMd,
          diffOpsJson: diff.diffOpsJson,
          changedBlocks: diff.changedBlocks,
        }),
        db
          .update(pages)
          .set({
            currentRevisionId: revision.id,
            updatedAt: now,
            lastAiUpdatedAt: now,
          })
          .where(eq(pages.id, targetPageId)),
        db
          .update(ingestionDecisions)
          .set({ proposedRevisionId: revision.id, status: "auto_applied" })
          .where(eq(ingestionDecisions.id, decisionId)),
        db
          .update(ingestions)
          .set({ status: "completed", processedAt: now })
          .where(eq(ingestions.id, ingestionId)),
        db.insert(auditLogs).values({
          workspaceId,
          modelRunId: modelRunId ?? undefined,
          entityType: "page",
          entityId: targetPageId,
          action,
          afterJson: {
            source: "patch_generator_auto",
            ingestionId,
            scheduledRunId: scheduledRunId ?? null,
            decisionId,
            revisionId: revision.id,
            agentRunId: agentRunId ?? null,
            sectionHint: sectionHint ?? null,
          },
        }),
      ]);

      await job.updateProgress(90);

      // Enqueue triple extraction for the new revision
      const tripleData: TripleExtractorJobData = {
        pageId: targetPageId,
        revisionId: revision.id,
        workspaceId,
      };
      const extractionQueue = getQueue(QUEUE_NAMES.EXTRACTION);
      await extractionQueue.add(
        JOB_NAMES.TRIPLE_EXTRACTOR,
        tripleData,
        DEFAULT_JOB_OPTIONS,
      );
      const searchQueue = getQueue(QUEUE_NAMES.SEARCH);
      await searchQueue.add(
        JOB_NAMES.SEARCH_INDEX_UPDATER,
        {
          workspaceId,
          pageId: targetPageId,
          revisionId: revision.id,
        },
        DEFAULT_JOB_OPTIONS,
      );

      await job.updateProgress(100);

      return {
        ingestionId,
        revisionId: revision.id,
        pageId: targetPageId,
      };
    },
    {
      connection: createRedisConnection(),
      concurrency: 3,
    },
  );

  worker.on("completed", (job, result) => {
    const log = createJobLogger("patch-generator", job.id);
    log.info(
      { pageId: result.pageId, revisionId: result.revisionId },
      "Job completed",
    );
  });

  worker.on("failed", (job, err) => {
    const log = createJobLogger("patch-generator", job?.id);
    log.error({ err, ingestionId: job?.data?.ingestionId }, "Job failed");
    const updates: Promise<unknown>[] = [];
    if (job?.data?.ingestionId) {
      updates.push(
        db
          .update(ingestions)
          .set({ status: "failed", processedAt: new Date() })
          .where(eq(ingestions.id, job.data.ingestionId)),
      );
    }
    if (job?.data?.decisionId) {
      updates.push(
        db
          .update(ingestionDecisions)
          .set({ status: "failed" })
          .where(eq(ingestionDecisions.id, job.data.decisionId)),
      );
    }
    if (updates.length > 0) {
      Promise.all(updates).catch((e) =>
        log.error(
          {
            err: e,
            ingestionId: job?.data?.ingestionId,
            decisionId: job?.data?.decisionId,
          },
          "Failed to persist failure state",
        ),
      );
    }
  });

  return worker;
}
