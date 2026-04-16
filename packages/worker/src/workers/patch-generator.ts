import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { createRedisConnection } from "../connection.js";
import { getQueue, QUEUE_NAMES, JOB_NAMES } from "../queues.js";
import { getAIAdapter, getDefaultProvider } from "../ai-gateway.js";
import { getDb } from "@nexnote/db/client";
import {
  ingestions,
  ingestionDecisions,
  modelRuns,
  pages,
  pageRevisions,
  revisionDiffs,
  auditLogs,
} from "@nexnote/db";
import { computeDiff, extractIngestionText, DEFAULT_JOB_OPTIONS } from "@nexnote/shared";
import type {
  PatchGeneratorJobData,
  PatchGeneratorJobResult,
  TripleExtractorJobData,
  AIRequest,
} from "@nexnote/shared";
import { createJobLogger } from "../logger.js";

const PROMPT_VERSION = "patch-generator-v1";

export function createPatchGeneratorWorker(): Worker {
  const db = getDb();

  const worker = new Worker<PatchGeneratorJobData, PatchGeneratorJobResult>(
    QUEUE_NAMES.PATCH,
    async (job: Job<PatchGeneratorJobData>) => {
      const { ingestionId, decisionId, workspaceId, targetPageId, action } =
        job.data;
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

      const incomingText = extractIngestionText(ingestion);

      await job.updateProgress(20);

      // For "append", concatenate; for "update", use LLM to merge
      let newContent: string;
      let modelRunId: string | null = null;

      if (action === "append") {
        newContent = `${existingContent}\n\n${incomingText}`;
      } else {
        const { provider, model } = getDefaultProvider();
        const adapter = getAIAdapter(provider);

        const aiRequest: AIRequest = {
          provider,
          model,
          mode: "patch_generation",
          promptVersion: PROMPT_VERSION,
          messages: [
            {
              role: "system",
              content: `You are a document editor for a Markdown knowledge wiki.
You will receive an existing page's Markdown content and incoming new content that should update it.
Merge the incoming content into the existing document intelligently:
- Preserve the existing structure where it makes sense
- Integrate new information into relevant sections
- Remove outdated information that the new content replaces
- Maintain consistent Markdown formatting

Return ONLY the final merged Markdown content, nothing else.`,
            },
            {
              role: "user",
              content: `## Existing page content:
\`\`\`markdown
${existingContent.slice(0, 8000)}
\`\`\`

## Incoming content to merge:
\`\`\`markdown
${incomingText.slice(0, 4000)}
\`\`\`

Produce the merged Markdown:`,
            },
          ],
          temperature: 0.2,
          maxTokens: 4096,
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
            requestMetaJson: { ingestionId, targetPageId, action },
            responseMetaJson: { contentLength: newContent.length },
          })
          .returning();

        modelRunId = run.id;
      }

      await job.updateProgress(60);

      // Create new revision
      const [revision] = await db
        .insert(pageRevisions)
        .values({
          pageId: targetPageId,
          baseRevisionId: page.currentRevisionId,
          modelRunId,
          actorType: "ai",
          source: "ingest_api",
          contentMd: newContent,
          revisionNote: `Auto-${action} from ingestion ${ingestion.sourceName}`,
        })
        .returning();

      // Compute diff + store it, then update page/decision/ingestion in parallel
      const diff = computeDiff(existingContent, newContent, null, null);

      await Promise.all([
        db.insert(revisionDiffs).values({
          revisionId: revision.id,
          diffMd: diff.diffMd,
          diffOpsJson: diff.diffOpsJson,
          changedBlocks: diff.changedBlocks,
        }),
        db
          .update(pages)
          .set({ currentRevisionId: revision.id, updatedAt: new Date() })
          .where(eq(pages.id, targetPageId)),
        db
          .update(ingestionDecisions)
          .set({ proposedRevisionId: revision.id })
          .where(eq(ingestionDecisions.id, decisionId)),
        db
          .update(ingestions)
          .set({ status: "completed", processedAt: new Date() })
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
            decisionId,
            revisionId: revision.id,
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
      await extractionQueue.add(JOB_NAMES.TRIPLE_EXTRACTOR, tripleData, DEFAULT_JOB_OPTIONS);

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
    log.info({ pageId: result.pageId, revisionId: result.revisionId }, "Job completed");
  });

  worker.on("failed", (job, err) => {
    const log = createJobLogger("patch-generator", job?.id);
    log.error({ err, ingestionId: job?.data?.ingestionId }, "Job failed");
    if (job?.data?.ingestionId) {
      db.update(ingestions)
        .set({ status: "failed", processedAt: new Date() })
        .where(eq(ingestions.id, job.data.ingestionId))
        .catch((e) =>
          log.error({ err: e, ingestionId: job.data.ingestionId }, "Failed to update ingestion status"),
        );
    }
  });

  return worker;
}
