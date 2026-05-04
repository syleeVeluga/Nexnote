import { and, eq, isNull, sql } from "drizzle-orm";
import { computeDiff } from "@wekiflow/shared";
import {
  auditLogs,
  pages,
  pageRevisions,
  revisionDiffs,
} from "./schema/index.js";

// Drizzle does not expose a compact common type for database and transaction
// objects that still preserves the fluent query API.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export type RollbackActorType = "user" | "ai" | "system";

export interface RollbackToRevisionInput {
  db: AnyDb;
  workspaceId: string;
  pageId: string;
  revisionId: string;
  actorUserId: string | null;
  actorType: RollbackActorType;
  source: "rollback";
  revisionNote?: string | null;
  agentRunId?: string | null;
  modelRunId?: string | null;
  sourceIngestionId?: string | null;
  ingestionDecisionId?: string | null;
}

export interface RollbackToRevisionResult {
  newRevisionId: string;
  pageId: string;
  rollbackTargetRevisionId: string;
  previousHeadRevisionId: string | null;
  revision: typeof pageRevisions.$inferSelect;
}

export class RollbackRevisionError extends Error {
  constructor(
    public readonly code: "page_not_found" | "revision_not_found",
    message: string,
  ) {
    super(message);
    this.name = "RollbackRevisionError";
  }
}

async function withMaybeTransaction<T>(
  db: AnyDb,
  fn: (tx: AnyDb) => Promise<T>,
): Promise<T> {
  if (typeof db.transaction === "function") {
    return db.transaction(fn);
  }
  return fn(db);
}

export async function rollbackToRevision(
  input: RollbackToRevisionInput,
): Promise<RollbackToRevisionResult> {
  return withMaybeTransaction(input.db, async (tx) => {
    const [targetRevision] = await tx
      .select({
        id: pageRevisions.id,
        pageId: pageRevisions.pageId,
        contentMd: pageRevisions.contentMd,
        contentJson: pageRevisions.contentJson,
      })
      .from(pageRevisions)
      .where(
        and(
          eq(pageRevisions.id, input.revisionId),
          eq(pageRevisions.pageId, input.pageId),
        ),
      )
      .limit(1);

    if (!targetRevision) {
      throw new RollbackRevisionError(
        "revision_not_found",
        "Revision not found",
      );
    }

    const [page] = await tx
      .select({
        id: pages.id,
        currentRevisionId: pages.currentRevisionId,
        currentContentMd: pageRevisions.contentMd,
        currentContentJson: pageRevisions.contentJson,
      })
      .from(pages)
      .leftJoin(pageRevisions, eq(pageRevisions.id, pages.currentRevisionId))
      .where(
        and(
          eq(pages.id, input.pageId),
          eq(pages.workspaceId, input.workspaceId),
          isNull(pages.deletedAt),
        ),
      )
      .limit(1);

    if (!page) {
      throw new RollbackRevisionError("page_not_found", "Page not found");
    }

    const [newRevision] = await tx
      .insert(pageRevisions)
      .values({
        pageId: input.pageId,
        baseRevisionId: page.currentRevisionId,
        actorUserId: input.actorUserId,
        actorType: input.actorType,
        modelRunId: input.modelRunId ?? null,
        source: input.source,
        sourceIngestionId: input.sourceIngestionId ?? null,
        sourceDecisionId: input.ingestionDecisionId ?? null,
        contentMd: targetRevision.contentMd,
        contentJson: targetRevision.contentJson,
        revisionNote:
          input.revisionNote ?? `Rollback to revision ${input.revisionId}`,
      })
      .returning();

    if (page.currentRevisionId) {
      const diff = computeDiff(
        page.currentContentMd ?? "",
        targetRevision.contentMd,
        (page.currentContentJson as Record<string, unknown> | null) ?? null,
        (targetRevision.contentJson as Record<string, unknown> | null) ?? null,
      );
      await tx.insert(revisionDiffs).values({
        revisionId: newRevision.id,
        diffMd: diff.diffMd,
        diffOpsJson: diff.diffOpsJson,
        changedBlocks: diff.changedBlocks,
      });
    }

    const pagePatch =
      input.actorType === "user"
        ? {
            currentRevisionId: newRevision.id,
            updatedAt: sql`now()`,
            lastHumanEditedAt: sql`now()`,
          }
        : input.actorType === "ai"
          ? {
              currentRevisionId: newRevision.id,
              updatedAt: sql`now()`,
              lastAiUpdatedAt: sql`now()`,
            }
          : {
              currentRevisionId: newRevision.id,
              updatedAt: sql`now()`,
            };

    await tx.update(pages).set(pagePatch).where(eq(pages.id, input.pageId));

    await tx.insert(auditLogs).values({
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
      modelRunId: input.modelRunId ?? null,
      entityType: "page_revision",
      entityId: newRevision.id,
      action: "rollback",
      afterJson: {
        pageId: input.pageId,
        baseRevisionId: page.currentRevisionId,
        rollbackTargetRevisionId: input.revisionId,
        sourceIngestionId: input.sourceIngestionId ?? null,
        sourceDecisionId: input.ingestionDecisionId ?? null,
        agentRunId: input.agentRunId ?? null,
        actorType: input.actorType,
      },
    });

    return {
      newRevisionId: newRevision.id,
      pageId: input.pageId,
      rollbackTargetRevisionId: input.revisionId,
      previousHeadRevisionId: page.currentRevisionId,
      revision: newRevision,
    };
  });
}
