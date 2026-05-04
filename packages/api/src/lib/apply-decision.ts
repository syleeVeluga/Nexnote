import { eq, and, inArray } from "drizzle-orm";
import {
  ingestions,
  ingestionDecisions,
  pages,
  pageRedirects,
  pagePaths,
  pageRevisions,
  revisionDiffs,
  auditLogs,
  insertPageWithUniqueSlug,
  publishedSnapshots,
  rollbackToRevision,
  RollbackRevisionError,
} from "@wekiflow/db";
import type { Database, IngestionDecision } from "@wekiflow/db";
import type { Queue } from "bullmq";
import {
  extractIngestionText,
  computeDiff,
  slugify,
  JOB_NAMES,
  DEFAULT_JOB_OPTIONS,
  ERROR_CODES,
  IMPORT_SOURCE_NAMES,
} from "@wekiflow/shared";
import type { TripleExtractorJobData } from "@wekiflow/shared";
import {
  collectDescendantPageIds,
  PageDeletionError,
  softDeleteSubtree,
} from "./page-deletion.js";

export interface ApplyDecisionCtx {
  db: Database;
  extractionQueue: Queue;
  searchQueue: Queue;
  workspaceId: string;
  decision: IngestionDecision;
  userId: string;
}

export type ApplyDecisionResult =
  | {
      status: "applied";
      action: "create" | "update" | "append" | "delete" | "merge";
      ingestionId: string;
      pageId: string;
      revisionId?: string;
      deletedPageIds?: string[];
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

function decisionOrigin(
  decision: IngestionDecision,
): "ingest_api" | "scheduled" {
  return decision.scheduledRunId ? "scheduled" : "ingest_api";
}

function readProposedContent(decision: IngestionDecision): string | null {
  const rationale = decision.rationaleJson as {
    proposedContentMd?: unknown;
  } | null;
  return typeof rationale?.proposedContentMd === "string"
    ? rationale.proposedContentMd
    : null;
}

function readMergeMeta(decision: IngestionDecision): {
  canonicalPageId: string;
  sourcePageIds: string[];
} | null {
  const rationale = decision.rationaleJson as {
    canonicalPageId?: unknown;
    sourcePageIds?: unknown;
  } | null;
  if (
    typeof rationale?.canonicalPageId !== "string" ||
    !Array.isArray(rationale.sourcePageIds)
  ) {
    return null;
  }
  const sourcePageIds = rationale.sourcePageIds.filter(
    (id): id is string => typeof id === "string",
  );
  if (sourcePageIds.length === 0) return null;
  return { canonicalPageId: rationale.canonicalPageId, sourcePageIds };
}

function readRollbackTargetRevisionId(
  decision: IngestionDecision,
): string | null {
  const rationale = decision.rationaleJson as {
    tool?: unknown;
    rollbackTargetRevisionId?: unknown;
    targetRevisionId?: unknown;
  } | null;
  if (rationale?.tool !== "rollback_to_revision") return null;
  if (typeof rationale.rollbackTargetRevisionId === "string") {
    return rationale.rollbackTargetRevisionId;
  }
  return typeof rationale.targetRevisionId === "string"
    ? rationale.targetRevisionId
    : null;
}

function pageDeletionError(err: PageDeletionError): ApplyDecisionError {
  if (err.code === ERROR_CODES.PAGE_NOT_FOUND) {
    return {
      code: ERROR_CODES.PAGE_NOT_FOUND,
      details: "Target page not found",
      statusCode: 404,
    };
  }
  if (err.code === ERROR_CODES.PUBLISHED_BLOCK) {
    return {
      code: ERROR_CODES.PUBLISHED_BLOCK,
      details:
        "A page in the affected subtree has a live published snapshot. Unpublish it before approving.",
      statusCode: 409,
    };
  }
  return {
    code: err.code,
    details: "Page deletion failed",
    statusCode: 409,
  };
}

export function findSourceSubtreeContainingPage(input: {
  protectedPageId: string;
  sourceSubtrees: Array<{ sourcePageId: string; descendantPageIds: string[] }>;
}): string | null {
  for (const subtree of input.sourceSubtrees) {
    if (subtree.descendantPageIds.includes(input.protectedPageId)) {
      return subtree.sourcePageId;
    }
  }
  return null;
}

async function preflightSoftDeleteTargets(input: {
  db: Database;
  workspaceId: string;
  rootPageIds: string[];
  protectedPageId?: string | null;
}): Promise<ApplyDecisionError | null> {
  const rootPageIds = [...new Set(input.rootPageIds)];
  if (rootPageIds.length === 0) return null;

  const roots = await input.db
    .select({ id: pages.id })
    .from(pages)
    .where(
      and(
        inArray(pages.id, rootPageIds),
        eq(pages.workspaceId, input.workspaceId),
      ),
    );
  if (roots.length !== rootPageIds.length) {
    return {
      code: ERROR_CODES.PAGE_NOT_FOUND,
      details: "One or more source pages were not found",
      statusCode: 404,
    };
  }

  const sourceSubtrees = await Promise.all(
    rootPageIds.map(async (pageId) => ({
      sourcePageId: pageId,
      descendantPageIds: await collectDescendantPageIds(
        input.db,
        input.workspaceId,
        pageId,
      ),
    })),
  );
  const protectedSource = input.protectedPageId
    ? findSourceSubtreeContainingPage({
        protectedPageId: input.protectedPageId,
        sourceSubtrees,
      })
    : null;
  if (protectedSource) {
    return {
      code: ERROR_CODES.PAGE_PARENT_CONFLICT,
      details: "Merge source page cannot be an ancestor of the canonical page.",
      statusCode: 400,
    };
  }

  const descendantIds = [
    ...new Set(sourceSubtrees.flatMap((subtree) => subtree.descendantPageIds)),
  ];
  if (descendantIds.length === 0) return null;

  const liveRows = await input.db
    .select({ pageId: publishedSnapshots.pageId })
    .from(publishedSnapshots)
    .where(
      and(
        inArray(publishedSnapshots.pageId, descendantIds),
        eq(publishedSnapshots.isLive, true),
      ),
    );
  if (liveRows.length > 0) {
    return {
      code: ERROR_CODES.PUBLISHED_BLOCK,
      details:
        "A page in the affected subtree has a live published snapshot. Unpublish it before approving.",
      statusCode: 409,
    };
  }

  return null;
}

async function loadCurrentRedirectPaths(input: {
  db: Database;
  workspaceId: string;
  sourcePageIds: string[];
}): Promise<Array<{ fromPageId: string; fromPath: string }>> {
  if (input.sourcePageIds.length === 0) return [];
  const rows = await input.db
    .select({ fromPageId: pagePaths.pageId, fromPath: pagePaths.path })
    .from(pagePaths)
    .where(
      and(
        eq(pagePaths.workspaceId, input.workspaceId),
        inArray(pagePaths.pageId, input.sourcePageIds),
        eq(pagePaths.isCurrent, true),
      ),
    );
  return rows;
}

async function createMergeRedirects(input: {
  db: Database;
  workspaceId: string;
  canonicalPageId: string;
  decisionId: string;
  redirects: Array<{ fromPageId: string; fromPath: string }>;
}): Promise<void> {
  const values = input.redirects
    .filter((row) => row.fromPageId !== input.canonicalPageId)
    .map((row) => ({
      workspaceId: input.workspaceId,
      fromPageId: row.fromPageId,
      toPageId: input.canonicalPageId,
      fromPath: row.fromPath,
      createdByDecisionId: input.decisionId,
    }));
  if (values.length === 0) return;
  await input.db.insert(pageRedirects).values(values).onConflictDoNothing();
}

export async function approveDecision(
  ctx: ApplyDecisionCtx,
): Promise<ApplyDecisionResult | ApplyDecisionError> {
  const { db, extractionQueue, searchQueue, workspaceId, decision, userId } =
    ctx;
  const ingestionId = decision.ingestionId;

  const [ingestion] = await db
    .select({
      id: ingestions.id,
      sourceName: ingestions.sourceName,
      titleHint: ingestions.titleHint,
      normalizedText: ingestions.normalizedText,
      rawPayload: ingestions.rawPayload,
      targetFolderId: ingestions.targetFolderId,
      targetParentPageId: ingestions.targetParentPageId,
      useReconciliation: ingestions.useReconciliation,
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

  // Synthesis ingestions cannot be approved — the lane is hidden and stale
  // decisions from the DB must be rejected instead.
  if (ingestion.sourceName === IMPORT_SOURCE_NAMES.SYNTHESIS_REQUEST) {
    return {
      code: "SYNTHESIS_DISABLED",
      details:
        "Synthesis-request decisions can no longer be approved; reject instead.",
      statusCode: 400,
    };
  }

  if (decision.action === "create") {
    const title =
      decision.proposedPageTitle ??
      ingestion.titleHint ??
      "Untitled (ingested)";
    const contentMd =
      readProposedContent(decision) ?? extractIngestionText(ingestion);

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
        actorUserId: userId,
        actorType: "ai",
        modelRunId: decision.modelRunId,
        source: decisionOrigin(decision),
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
      db.insert(pagePaths).values({
        workspaceId,
        pageId: page.id,
        path: page.slug,
        isCurrent: true,
      }),
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
          scheduledRunId: decision.scheduledRunId ?? null,
          decisionId: decision.id,
        },
      }),
    ]);

    const tripleData: TripleExtractorJobData = {
      pageId: page.id,
      revisionId: revision.id,
      workspaceId,
      useReconciliation: ingestion.useReconciliation,
    };
    await extractionQueue.add(
      JOB_NAMES.TRIPLE_EXTRACTOR,
      tripleData,
      DEFAULT_JOB_OPTIONS,
    );
    await searchQueue.add(
      JOB_NAMES.SEARCH_INDEX_UPDATER,
      {
        pageId: page.id,
        revisionId: revision.id,
        workspaceId,
      },
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
    const rollbackTargetRevisionId =
      decision.action === "update"
        ? readRollbackTargetRevisionId(decision)
        : null;

    if (rollbackTargetRevisionId) {
      let rollbackResult;
      try {
        rollbackResult = await rollbackToRevision({
          db,
          workspaceId,
          pageId: decision.targetPageId,
          revisionId: rollbackTargetRevisionId,
          actorUserId: userId,
          actorType: "ai",
          source: "rollback",
          revisionNote: `Approved rollback from ingestion ${ingestion.sourceName}`,
          modelRunId: decision.modelRunId,
          sourceIngestionId: ingestionId,
          ingestionDecisionId: decision.id,
        });
      } catch (err) {
        if (err instanceof RollbackRevisionError) {
          return {
            code:
              err.code === "revision_not_found"
                ? ERROR_CODES.REVISION_NOT_FOUND
                : ERROR_CODES.PAGE_NOT_FOUND,
            details: err.message,
            statusCode: err.code === "revision_not_found" ? 400 : 404,
          };
        }
        throw err;
      }

      revisionId = rollbackResult.newRevisionId;
      await db
        .update(ingestionDecisions)
        .set({ proposedRevisionId: revisionId, status: "approved" })
        .where(eq(ingestionDecisions.id, decision.id));
    } else if (decision.proposedRevisionId) {
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
          modelRunId: decision.modelRunId,
          source: decisionOrigin(decision),
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
    await searchQueue.add(
      JOB_NAMES.SEARCH_INDEX_UPDATER,
      {
        pageId: decision.targetPageId,
        revisionId,
        workspaceId,
      },
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
          scheduledRunId: decision.scheduledRunId ?? null,
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

  if (decision.action === "delete") {
    if (!decision.targetPageId) {
      return {
        code: ERROR_CODES.MISSING_TARGET_PAGE,
        details: "Decision requires a targetPageId for delete",
        statusCode: 400,
      };
    }
    const preflight = await preflightSoftDeleteTargets({
      db,
      workspaceId,
      rootPageIds: [decision.targetPageId],
    });
    if (preflight) return preflight;

    let deletedPageIds: string[];
    try {
      const result = await softDeleteSubtree(db, {
        workspaceId,
        rootPageId: decision.targetPageId,
        userId,
      });
      deletedPageIds = result.deletedPageIds;
    } catch (err) {
      if (err instanceof PageDeletionError) return pageDeletionError(err);
      throw err;
    }

    await Promise.all([
      db
        .update(ingestionDecisions)
        .set({ status: "approved" })
        .where(eq(ingestionDecisions.id, decision.id)),
      db
        .update(ingestions)
        .set({ status: "completed", processedAt: new Date() })
        .where(eq(ingestions.id, ingestionId)),
      db.insert(auditLogs).values({
        workspaceId,
        userId,
        entityType: "ingestion_decision",
        entityId: decision.id,
        action: "approve_delete",
        afterJson: {
          source: "decision_approve",
          ingestionId,
          scheduledRunId: decision.scheduledRunId ?? null,
          decisionId: decision.id,
          pageId: decision.targetPageId,
          deletedPageIds,
        },
      }),
    ]);

    return {
      status: "applied",
      action: "delete",
      ingestionId,
      pageId: decision.targetPageId,
      deletedPageIds,
    };
  }

  if (decision.action === "merge") {
    const meta = readMergeMeta(decision);
    if (!meta || !decision.targetPageId || !decision.proposedRevisionId) {
      return {
        code: ERROR_CODES.EMPTY_UPDATE,
        details:
          "Merge decision requires targetPageId, proposedRevisionId, and sourcePageIds metadata",
        statusCode: 400,
      };
    }
    if (meta.canonicalPageId !== decision.targetPageId) {
      return {
        code: ERROR_CODES.PAGE_PARENT_CONFLICT,
        details: "Merge canonical page does not match decision target",
        statusCode: 400,
      };
    }

    const [revision] = await db
      .select({
        id: pageRevisions.id,
        pageId: pageRevisions.pageId,
        actorType: pageRevisions.actorType,
      })
      .from(pageRevisions)
      .where(eq(pageRevisions.id, decision.proposedRevisionId))
      .limit(1);
    if (!revision || revision.pageId !== decision.targetPageId) {
      return {
        code: ERROR_CODES.REVISION_NOT_FOUND,
        details: "Merge proposed revision not found for canonical page",
        statusCode: 400,
      };
    }
    const preflight = await preflightSoftDeleteTargets({
      db,
      workspaceId,
      rootPageIds: meta.sourcePageIds,
      protectedPageId: decision.targetPageId,
    });
    if (preflight) return preflight;
    const redirectPaths = await loadCurrentRedirectPaths({
      db,
      workspaceId,
      sourcePageIds: meta.sourcePageIds,
    });

    const deletedPageIds: string[] = [];
    try {
      for (const sourcePageId of meta.sourcePageIds) {
        const result = await softDeleteSubtree(db, {
          workspaceId,
          rootPageId: sourcePageId,
          userId,
        });
        deletedPageIds.push(...result.deletedPageIds);
      }
    } catch (err) {
      if (err instanceof PageDeletionError) return pageDeletionError(err);
      throw err;
    }

    const now = new Date();
    const tripleData: TripleExtractorJobData = {
      pageId: decision.targetPageId,
      revisionId: decision.proposedRevisionId,
      workspaceId,
      useReconciliation: ingestion.useReconciliation,
    };
    await Promise.all([
      extractionQueue.add(
        JOB_NAMES.TRIPLE_EXTRACTOR,
        tripleData,
        DEFAULT_JOB_OPTIONS,
      ),
      searchQueue.add(
        JOB_NAMES.SEARCH_INDEX_UPDATER,
        {
          pageId: decision.targetPageId,
          revisionId: decision.proposedRevisionId,
          workspaceId,
        },
        DEFAULT_JOB_OPTIONS,
      ),
      db
        .update(pages)
        .set({
          currentRevisionId: decision.proposedRevisionId,
          updatedAt: now,
          ...(revision.actorType === "user"
            ? { lastHumanEditedAt: now }
            : { lastAiUpdatedAt: now }),
        })
        .where(eq(pages.id, decision.targetPageId)),
      db
        .update(ingestionDecisions)
        .set({ status: "approved" })
        .where(eq(ingestionDecisions.id, decision.id)),
      db
        .update(ingestions)
        .set({ status: "completed", processedAt: new Date() })
        .where(eq(ingestions.id, ingestionId)),
      db.insert(auditLogs).values({
        workspaceId,
        userId,
        entityType: "ingestion_decision",
        entityId: decision.id,
        action: "approve_merge",
        afterJson: {
          source: "decision_approve",
          ingestionId,
          scheduledRunId: decision.scheduledRunId ?? null,
          decisionId: decision.id,
          canonicalPageId: decision.targetPageId,
          sourcePageIds: meta.sourcePageIds,
          deletedPageIds,
          revisionId: decision.proposedRevisionId,
        },
      }),
      createMergeRedirects({
        db,
        workspaceId,
        canonicalPageId: decision.targetPageId,
        decisionId: decision.id,
        redirects: redirectPaths,
      }),
    ]);

    return {
      status: "applied",
      action: "merge",
      ingestionId,
      pageId: decision.targetPageId,
      revisionId: decision.proposedRevisionId,
      deletedPageIds,
    };
  }

  // noop / needs_review — the reviewer acknowledged without creating content.
  const acknowledgedStatus = decision.action === "noop" ? "noop" : "rejected";
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
