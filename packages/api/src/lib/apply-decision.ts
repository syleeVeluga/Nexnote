import { eq, and } from "drizzle-orm";
import {
  ingestions,
  ingestionDecisions,
  pages,
  pageRevisions,
  revisionDiffs,
  auditLogs,
} from "@nexnote/db";
import type { Database, IngestionDecision } from "@nexnote/db";
import type { Queue } from "bullmq";
import {
  extractIngestionText,
  computeDiff,
  slugify,
  JOB_NAMES,
  DEFAULT_JOB_OPTIONS,
  ERROR_CODES,
} from "@nexnote/shared";
import type { TripleExtractorJobData } from "@nexnote/shared";

export interface ApplyDecisionCtx {
  db: Database;
  extractionQueue: Queue;
  workspaceId: string;
  decision: IngestionDecision;
  userId: string;
}

export type ApplyDecisionResult =
  | {
      status: "applied";
      action: "create" | "update" | "append";
      ingestionId: string;
      pageId: string;
      revisionId: string;
    }
  | {
      status: "acknowledged";
      action: "noop" | "needs_review";
      ingestionId: string;
    };

export interface ApplyDecisionError {
  code: string;
  details: string;
  statusCode: number;
}

const SLUG_ALLOC_MAX_ATTEMPTS = 20;
const PG_UNIQUE_VIOLATION = "23505";
const PAGES_SLUG_CONSTRAINT = "pages_workspace_slug_uk";

function isPageSlugCollision(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; constraint_name?: string; constraint?: string };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    (e.constraint_name === PAGES_SLUG_CONSTRAINT ||
      e.constraint === PAGES_SLUG_CONSTRAINT)
  );
}

async function insertPageWithUniqueSlug(
  db: Database,
  params: { workspaceId: string; title: string; baseSlug: string },
): Promise<typeof pages.$inferSelect> {
  for (let i = 0; i < SLUG_ALLOC_MAX_ATTEMPTS; i++) {
    const slug = i === 0 ? params.baseSlug : `${params.baseSlug}-${i + 1}`;
    try {
      const [page] = await db
        .insert(pages)
        .values({
          workspaceId: params.workspaceId,
          title: params.title,
          slug,
          status: "draft",
        })
        .returning();
      return page;
    } catch (err) {
      if (!isPageSlugCollision(err)) throw err;
    }
  }
  throw new Error(
    `Could not allocate unique slug for "${params.baseSlug}" after ${SLUG_ALLOC_MAX_ATTEMPTS} attempts`,
  );
}

export async function approveDecision(
  ctx: ApplyDecisionCtx,
): Promise<ApplyDecisionResult | ApplyDecisionError> {
  const { db, extractionQueue, workspaceId, decision, userId } = ctx;
  const ingestionId = decision.ingestionId;

  const [ingestion] = await db
    .select({
      id: ingestions.id,
      sourceName: ingestions.sourceName,
      titleHint: ingestions.titleHint,
      normalizedText: ingestions.normalizedText,
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

  if (!ingestion) {
    return {
      code: ERROR_CODES.NOT_FOUND,
      details: "Ingestion not found",
      statusCode: 404,
    };
  }

  if (decision.action === "create") {
    const title =
      decision.proposedPageTitle ??
      ingestion.titleHint ??
      "Untitled (ingested)";
    const contentMd = extractIngestionText(ingestion);

    const page = await insertPageWithUniqueSlug(db, {
      workspaceId,
      title,
      baseSlug: slugify(title),
    });

    const [revision] = await db
      .insert(pageRevisions)
      .values({
        pageId: page.id,
        actorUserId: userId,
        actorType: "ai",
        source: "ingest_api",
        sourceIngestionId: ingestionId,
        sourceDecisionId: decision.id,
        contentMd,
        revisionNote: `Approved create from ingestion ${ingestion.sourceName}`,
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
      db
        .update(ingestionDecisions)
        .set({
          targetPageId: page.id,
          proposedRevisionId: revision.id,
          status: "approved",
        })
        .where(eq(ingestionDecisions.id, decision.id)),
      db
        .update(ingestions)
        .set({ status: "completed", processedAt: now })
        .where(eq(ingestions.id, ingestionId)),
      db.insert(auditLogs).values({
        workspaceId,
        userId,
        entityType: "page",
        entityId: page.id,
        action: "create",
        afterJson: {
          source: "decision_approve",
          ingestionId,
          decisionId: decision.id,
        },
      }),
    ]);

    const tripleData: TripleExtractorJobData = {
      pageId: page.id,
      revisionId: revision.id,
      workspaceId,
    };
    await extractionQueue.add(
      JOB_NAMES.TRIPLE_EXTRACTOR,
      tripleData,
      DEFAULT_JOB_OPTIONS,
    );

    return {
      status: "applied",
      action: "create",
      ingestionId,
      pageId: page.id,
      revisionId: revision.id,
    };
  }

  if (decision.action === "update" || decision.action === "append") {
    if (!decision.targetPageId) {
      return {
        code: ERROR_CODES.MISSING_TARGET_PAGE,
        details: "Decision requires a targetPageId for update/append",
        statusCode: 400,
      };
    }

    let revisionId: string;

    if (decision.proposedRevisionId) {
      // Patch-generator already produced a revision; promote it to current.
      revisionId = decision.proposedRevisionId;
      const now = new Date();
      await Promise.all([
        db
          .update(pages)
          .set({
            currentRevisionId: decision.proposedRevisionId,
            updatedAt: now,
            lastAiUpdatedAt: now,
          })
          .where(eq(pages.id, decision.targetPageId)),
        db
          .update(ingestionDecisions)
          .set({ status: "approved" })
          .where(eq(ingestionDecisions.id, decision.id)),
      ]);
    } else {
      // Synchronous fallback: build the revision inline (concat for append,
      // raw replace for update — no LLM call). This path exists so reviewers
      // can approve decisions whose patch-generator never ran.
      const [currentPage] = await db
        .select({ currentRevisionId: pages.currentRevisionId })
        .from(pages)
        .where(eq(pages.id, decision.targetPageId))
        .limit(1);

      let existingContent = "";
      if (currentPage?.currentRevisionId) {
        const [rev] = await db
          .select({ contentMd: pageRevisions.contentMd })
          .from(pageRevisions)
          .where(eq(pageRevisions.id, currentPage.currentRevisionId))
          .limit(1);
        if (rev) existingContent = rev.contentMd;
      }

      const incomingText = extractIngestionText(ingestion);
      const newContent =
        decision.action === "append"
          ? `${existingContent}\n\n${incomingText}`
          : incomingText;

      const [revision] = await db
        .insert(pageRevisions)
        .values({
          pageId: decision.targetPageId,
          baseRevisionId: currentPage?.currentRevisionId ?? null,
          actorUserId: userId,
          actorType: "ai",
          source: "ingest_api",
          sourceIngestionId: ingestionId,
          sourceDecisionId: decision.id,
          contentMd: newContent,
          revisionNote: `Approved ${decision.action} from ingestion ${ingestion.sourceName}`,
        })
        .returning();

      revisionId = revision.id;

      const diff = computeDiff(existingContent, newContent, null, null);
      await db.insert(revisionDiffs).values({
        revisionId: revision.id,
        diffMd: diff.diffMd,
        diffOpsJson: diff.diffOpsJson,
        changedBlocks: diff.changedBlocks,
      });

      const now = new Date();
      await Promise.all([
        db
          .update(pages)
          .set({
            currentRevisionId: revision.id,
            updatedAt: now,
            lastAiUpdatedAt: now,
          })
          .where(eq(pages.id, decision.targetPageId)),
        db
          .update(ingestionDecisions)
          .set({ proposedRevisionId: revision.id, status: "approved" })
          .where(eq(ingestionDecisions.id, decision.id)),
      ]);
    }

    const tripleData: TripleExtractorJobData = {
      pageId: decision.targetPageId,
      revisionId,
      workspaceId,
    };
    await extractionQueue.add(
      JOB_NAMES.TRIPLE_EXTRACTOR,
      tripleData,
      DEFAULT_JOB_OPTIONS,
    );

    await Promise.all([
      db
        .update(ingestions)
        .set({ status: "completed", processedAt: new Date() })
        .where(eq(ingestions.id, ingestionId)),
      db.insert(auditLogs).values({
        workspaceId,
        userId,
        entityType: "page",
        entityId: decision.targetPageId,
        action: decision.action,
        afterJson: {
          source: "decision_approve",
          ingestionId,
          decisionId: decision.id,
          revisionId,
        },
      }),
    ]);

    return {
      status: "applied",
      action: decision.action,
      ingestionId,
      pageId: decision.targetPageId,
      revisionId,
    };
  }

  // noop / needs_review — the reviewer acknowledged without creating content.
  const acknowledgedStatus =
    decision.action === "noop" ? "noop" : "rejected";
  await Promise.all([
    db
      .update(ingestionDecisions)
      .set({ status: acknowledgedStatus })
      .where(eq(ingestionDecisions.id, decision.id)),
    db
      .update(ingestions)
      .set({ status: "completed", processedAt: new Date() })
      .where(eq(ingestions.id, ingestionId)),
    db.insert(auditLogs).values({
      workspaceId,
      userId,
      entityType: "ingestion",
      entityId: ingestionId,
      action: "acknowledge",
      beforeJson: { decisionId: decision.id, decisionAction: decision.action },
    }),
  ]);

  return {
    status: "acknowledged",
    action: decision.action as "noop" | "needs_review",
    ingestionId,
  };
}

export async function rejectDecision(
  ctx: ApplyDecisionCtx & { reason?: string | null },
): Promise<{ status: "rejected"; ingestionId: string }> {
  const { db, workspaceId, decision, userId, reason } = ctx;
  const ingestionId = decision.ingestionId;

  await Promise.all([
    db
      .update(ingestionDecisions)
      .set({ status: "rejected" })
      .where(eq(ingestionDecisions.id, decision.id)),
    db
      .update(ingestions)
      .set({ status: "completed", processedAt: new Date() })
      .where(eq(ingestions.id, ingestionId)),
    db.insert(auditLogs).values({
      workspaceId,
      userId,
      entityType: "ingestion",
      entityId: ingestionId,
      action: "reject",
      beforeJson: { decisionId: decision.id, decisionAction: decision.action },
      afterJson: reason ? { reason } : null,
    }),
  ]);

  return { status: "rejected", ingestionId };
}
