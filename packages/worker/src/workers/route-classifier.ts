import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { eq, and, sql, desc, inArray } from "drizzle-orm";
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
  entities,
  triples,
  auditLogs,
} from "@nexnote/db";
import {
  CONFIDENCE,
  DEFAULT_JOB_OPTIONS,
  routeDecisionSchema,
  extractIngestionText,
  normalizeKey,
  slugify,
} from "@nexnote/shared";
import type {
  RouteClassifierJobData,
  RouteClassifierJobResult,
  PatchGeneratorJobData,
  AIRequest,
} from "@nexnote/shared";

const PROMPT_VERSION = "route-classifier-v1";

async function findCandidatePages(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  titleHint: string | null,
  normalizedText: string | null,
): Promise<Array<{ id: string; title: string; slug: string; excerpt: string }>> {
  const candidates: Array<{
    id: string;
    title: string;
    slug: string;
    excerpt: string;
  }> = [];
  const existingIds = new Set<string>();

  // Title match with current revision excerpt
  if (titleHint) {
    const titleMatches = await db
      .select({
        id: pages.id,
        title: pages.title,
        slug: pages.slug,
        contentMd: pageRevisions.contentMd,
      })
      .from(pages)
      .leftJoin(
        pageRevisions,
        eq(pageRevisions.id, pages.currentRevisionId),
      )
      .where(
        and(
          eq(pages.workspaceId, workspaceId),
          sql`LOWER(${pages.title}) LIKE LOWER(${"%" + titleHint + "%"})`,
        ),
      )
      .limit(5);

    for (const row of titleMatches) {
      existingIds.add(row.id);
      candidates.push({
        id: row.id,
        title: row.title,
        slug: row.slug,
        excerpt: row.contentMd ? row.contentMd.slice(0, 500) : "",
      });
    }
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
            contentMd: pageRevisions.contentMd,
          })
          .from(pages)
          .innerJoin(pageRevisions, eq(pageRevisions.id, pages.currentRevisionId))
          .where(
            and(
              eq(pages.workspaceId, workspaceId),
              sql`TO_TSVECTOR('english', ${pageRevisions.contentMd}) @@ TO_TSQUERY('english', ${tsQuery})`,
            ),
          )
          .orderBy(
            sql`TS_RANK(TO_TSVECTOR('english', ${pageRevisions.contentMd}), TO_TSQUERY('english', ${tsQuery})) DESC`,
          )
          .limit(5);

        for (const row of ftsMatches) {
          if (existingIds.has(row.id)) continue;
          existingIds.add(row.id);
          candidates.push({
            id: row.id,
            title: row.title,
            slug: row.slug,
            excerpt: row.contentMd ? row.contentMd.slice(0, 500) : "",
          });
        }
      } catch (err) {
        console.warn("[route-classifier] FTS search failed, skipping:", err);
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
          contentMd: pageRevisions.contentMd,
        })
        .from(pages)
        .innerJoin(pageRevisions, eq(pageRevisions.id, pages.currentRevisionId))
        .where(
          and(
            eq(pages.workspaceId, workspaceId),
            sql`SIMILARITY(${pages.title}, ${textSnippet}) > 0.1`,
          ),
        )
        .orderBy(sql`SIMILARITY(${pages.title}, ${textSnippet}) DESC`)
        .limit(5);

      for (const row of trigramMatches) {
        if (existingIds.has(row.id)) continue;
        existingIds.add(row.id);
        candidates.push({
          id: row.id,
          title: row.title,
          slug: row.slug,
          excerpt: row.contentMd ? row.contentMd.slice(0, 500) : "",
        });
      }
    } catch (err) {
      console.warn("[route-classifier] Trigram search failed, skipping:", err);
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
            contentMd: pageRevisions.contentMd,
          })
          .from(pages)
          .innerJoin(pageRevisions, eq(pageRevisions.id, pages.currentRevisionId))
          .innerJoin(triples, eq(triples.sourcePageId, pages.id))
          .innerJoin(entities, eq(entities.id, triples.subjectEntityId))
          .where(
            and(
              eq(pages.workspaceId, workspaceId),
              inArray(entities.normalizedKey, words),
            ),
          )
          .groupBy(pages.id, pages.title, pages.slug, pageRevisions.contentMd)
          .orderBy(sql`COUNT(DISTINCT ${entities.id}) DESC`)
          .limit(5);

        for (const row of entityOverlapMatches) {
          if (existingIds.has(row.id)) continue;
          existingIds.add(row.id);
          candidates.push({
            id: row.id,
            title: row.title,
            slug: row.slug,
            excerpt: row.contentMd ? row.contentMd.slice(0, 500) : "",
          });
        }
      }
    } catch (err) {
      console.warn("[route-classifier] Entity overlap search failed, skipping:", err);
    }
  }

  return candidates.slice(0, 10);
}

function buildRoutePrompt(
  ingestion: {
    sourceName: string;
    titleHint: string | null;
    normalizedText: string | null;
    rawPayload: unknown;
    contentType: string;
  },
  candidates: Array<{
    id: string;
    title: string;
    slug: string;
    excerpt: string;
  }>,
): AIRequest["messages"] {
  const incomingContent = extractIngestionText(ingestion);

  const candidateList =
    candidates.length > 0
      ? candidates
          .map(
            (c, i) =>
              `[${i + 1}] id=${c.id}, title="${c.title}", excerpt="${c.excerpt.slice(0, 300)}"`,
          )
          .join("\n")
      : "(no existing pages found)";

  return [
    {
      role: "system",
      content: `You are a route-decision engine for a knowledge wiki.
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

Be conservative — prefer "needs_review" if confidence < 0.6.`,
    },
    {
      role: "user",
      content: `Source: ${ingestion.sourceName}
Title hint: ${ingestion.titleHint ?? "(none)"}
Content type: ${ingestion.contentType}
Incoming content (truncated):
---
${incomingContent.slice(0, 2000)}
---

Existing candidate pages:
${candidateList}`,
    },
  ];
}

export function createRouteClassifierWorker(): Worker {
  const db = getDb();

  const worker = new Worker<RouteClassifierJobData, RouteClassifierJobResult>(
    QUEUE_NAMES.INGESTION,
    async (job: Job<RouteClassifierJobData>) => {
      const { ingestionId, workspaceId } = job.data;
      console.log(
        `[route-classifier] Processing ingestion ${ingestionId}`,
      );

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

      const messages = buildRoutePrompt(
        { ...ingestion, normalizedText },
        candidates,
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
      };

      const aiResponse = await adapter.chat(aiRequest);

      await job.updateProgress(70);

      let parsed;
      let parseFailed = false;
      try {
        const raw = JSON.parse(aiResponse.content);
        parsed = routeDecisionSchema.parse(raw);
      } catch (err) {
        console.error(
          `[route-classifier] Failed to parse LLM response for ${ingestionId}:`,
          err,
        );
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
          requestMetaJson: { ingestionId, candidateCount: candidates.length },
          responseMetaJson: parseFailed
            ? { error: "parse_failed", raw: aiResponse.content.slice(0, 500) }
            : { action: parsed.action, confidence: parsed.confidence },
        })
        .returning();

      await job.updateProgress(80);

      const [decision] = await db
        .insert(ingestionDecisions)
        .values({
          ingestionId,
          targetPageId: parsed.targetPageId,
          modelRunId: modelRun.id,
          action: parsed.action,
          proposedPageTitle: parsed.proposedTitle ?? null,
          confidence: parsed.confidence,
          rationaleJson: { reason: parsed.reason },
        })
        .returning();

      // Auto-apply if confidence >= threshold
      if (
        parsed.confidence >= CONFIDENCE.AUTO_APPLY &&
        (parsed.action === "update" || parsed.action === "append") &&
        parsed.targetPageId
      ) {
        const patchData: PatchGeneratorJobData = {
          ingestionId,
          decisionId: decision.id,
          workspaceId,
          targetPageId: parsed.targetPageId,
          action: parsed.action,
        };
        const patchQueue = getQueue(QUEUE_NAMES.PATCH);
        await patchQueue.add(JOB_NAMES.PATCH_GENERATOR, patchData, DEFAULT_JOB_OPTIONS);
      } else if (
        parsed.confidence >= CONFIDENCE.AUTO_APPLY &&
        parsed.action === "create"
      ) {
        const title =
          parsed.proposedTitle ??
          ingestion.titleHint ??
          "Untitled (ingested)";
        const slug = slugify(title);
        const contentMd = extractIngestionText({ normalizedText, rawPayload: ingestion.rawPayload });

        const [page] = await db
          .insert(pages)
          .values({ workspaceId, title, slug, status: "draft" })
          .returning();

        const [revision] = await db
          .insert(pageRevisions)
          .values({
            pageId: page.id,
            actorType: "ai",
            source: "ingest_api",
            contentMd,
            revisionNote: `Auto-created from ingestion ${ingestion.sourceName}`,
          })
          .returning();

        await Promise.all([
          db
            .update(pages)
            .set({ currentRevisionId: revision.id })
            .where(eq(pages.id, page.id)),
          db
            .update(ingestionDecisions)
            .set({ targetPageId: page.id, proposedRevisionId: revision.id })
            .where(eq(ingestionDecisions.id, decision.id)),
          db
            .update(ingestions)
            .set({ status: "completed", processedAt: new Date() })
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
      } else {
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
    console.log(
      `[route-classifier] Job ${job.id} completed: action=${result.action}, confidence=${result.confidence}`,
    );
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[route-classifier] Job ${job?.id ?? "unknown"} failed:`,
      err.message,
    );
    if (job?.data?.ingestionId) {
      db.update(ingestions)
        .set({ status: "failed", processedAt: new Date() })
        .where(eq(ingestions.id, job.data.ingestionId))
        .catch((e) =>
          console.error(`[route-classifier] Failed to update ingestion status:`, e),
        );
    }
  });

  return worker;
}
