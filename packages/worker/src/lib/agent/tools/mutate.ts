import type { Queue } from "bullmq";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import {
  auditLogs,
  folders,
  ingestionDecisions,
  insertPageWithUniqueSlug,
  pagePaths,
  pageRevisions,
  pages,
  revisionDiffs,
} from "@wekiflow/db";
import {
  agentMutateToolInputSchemas,
  classifyDecisionStatus,
  computeDiff,
  DEFAULT_JOB_OPTIONS,
  JOB_NAMES,
  slugify,
  type AgentMutateToolName,
  type AppendToPageToolInput,
  type CreatePageToolInput,
  type DeletePageToolInput,
  type EditPageBlocksToolInput,
  type EditPageSectionToolInput,
  type IngestionAction,
  type MergePagesToolInput,
  type NoopToolInput,
  type PatchGeneratorJobData,
  type ReplaceInPageToolInput,
  type RequestHumanReviewToolInput,
  type SearchIndexUpdaterJobData,
  type TripleExtractorJobData,
  type UpdatePageToolInput,
} from "@wekiflow/shared";
import { applyBlockPatch } from "../patch/block-patch.js";
import { applyReplaceInPagePatch } from "../patch/inline-patch.js";
import { applySectionPatch } from "../patch/section-patch.js";
import {
  AgentToolError,
  type AgentDb,
  type AgentToolContext,
  type AgentToolDefinition,
  type AgentToolResult,
} from "../types.js";

type QueueLike<Data = unknown> = Pick<Queue<Data>, "add">;

export interface AgentMutationIngestion {
  id: string;
  sourceName: string;
  targetFolderId?: string | null;
  targetParentPageId?: string | null;
  useReconciliation?: boolean;
}

export interface CreateMutateToolsInput {
  ingestion: AgentMutationIngestion;
  agentRunId: string;
  modelRunId: string;
  origin?: "ingestion" | "scheduled";
  scheduledRunId?: string | null;
  scheduledAutoApply?: boolean;
  patchQueue?: QueueLike<PatchGeneratorJobData>;
  extractionQueue?: QueueLike<TripleExtractorJobData>;
  searchQueue?: QueueLike<SearchIndexUpdaterJobData>;
}

interface CurrentPage {
  id: string;
  title: string;
  currentRevisionId: string | null;
  contentMd: string;
}

interface DecisionRecord {
  id: string;
}

interface ConflictingRevision {
  id: string;
  actorUserId: string | null;
  createdAt: Date;
  revisionNote: string | null;
}

function revisionSource(
  input: CreateMutateToolsInput,
): "ingest_api" | "scheduled" {
  return input.origin === "scheduled" ? "scheduled" : "ingest_api";
}

function activitySource(
  input: CreateMutateToolsInput,
  source: string,
): string {
  return input.origin === "scheduled"
    ? source.replace("ingestion_agent", "scheduled_agent")
    : source;
}

function mutationDecisionStatus(
  input: CreateMutateToolsInput,
  action: "create" | "update" | "append",
  confidence: number,
): ReturnType<typeof classifyDecisionStatus> {
  if (input.origin === "scheduled" && !input.scheduledAutoApply) {
    return "suggested";
  }
  return classifyDecisionStatus(action, confidence);
}

function destructiveDecisionStatus(): "suggested" {
  return "suggested";
}

function assertObservedPage(ctx: AgentToolContext, pageId: string): void {
  if (!ctx.state.seenPageIds.has(pageId) && !ctx.state.createdPageIds.has(pageId)) {
    const observedPageIds = [...ctx.state.seenPageIds].slice(0, 100);
    throw new AgentToolError(
      "invalid_target_page",
      `Page ${pageId} was not observed earlier in this agent run`,
      { pageId, observedPageIds },
      {
        hint:
          "Mutate tools can only target page IDs returned by read/search tools in this run. Search or read the page first, then retry with an observed pageId.",
        candidates: observedPageIds,
      },
    );
  }
}

function assertPageNotMutated(ctx: AgentToolContext, pageId: string): void {
  if (ctx.state.mutatedPageIds.has(pageId)) {
    throw new AgentToolError(
      "duplicate_mutation",
      `Page ${pageId} already has a mutation in this agent run`,
      { pageId },
    );
  }
}

function assertCanMutatePage(ctx: AgentToolContext, pageId: string): void {
  assertObservedPage(ctx, pageId);
  assertPageNotMutated(ctx, pageId);
}

function observedRevisionIdForPage(
  ctx: AgentToolContext,
  page: CurrentPage,
): string | null {
  if (ctx.state.observedPageRevisionIds.has(page.id)) {
    return ctx.state.observedPageRevisionIds.get(page.id) ?? null;
  }
  return page.currentRevisionId;
}

async function detectHumanConflict(
  db: AgentDb,
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
    baseCreatedAt = baseRev?.createdAt ?? new Date(0);
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

async function getCurrentPage(
  db: AgentDb,
  workspaceId: string,
  pageId: string,
): Promise<CurrentPage> {
  const [row] = await db
    .select({
      id: pages.id,
      title: pages.title,
      currentRevisionId: pages.currentRevisionId,
      contentMd: pageRevisions.contentMd,
    })
    .from(pages)
    .leftJoin(pageRevisions, eq(pageRevisions.id, pages.currentRevisionId))
    .where(
      and(
        eq(pages.workspaceId, workspaceId),
        eq(pages.id, pageId),
        isNull(pages.deletedAt),
      ),
    )
    .limit(1);

  if (!row) {
    throw new AgentToolError("not_found", `Page ${pageId} not found`, {
      pageId,
    });
  }

  return {
    id: row.id,
    title: row.title,
    currentRevisionId: row.currentRevisionId,
    contentMd: row.contentMd ?? "",
  };
}

async function createDecision(
  ctx: AgentToolContext,
  input: CreateMutateToolsInput,
  values: {
    action: IngestionAction;
    status: ReturnType<typeof classifyDecisionStatus>;
    confidence: number;
    reason: string;
    tool: AgentMutateToolName;
    targetPageId?: string | null;
    proposedPageTitle?: string | null;
    rationale?: Record<string, unknown>;
  },
): Promise<DecisionRecord> {
  const [decision] = await ctx.db
    .insert(ingestionDecisions)
    .values({
      ingestionId: input.ingestion.id,
      targetPageId: values.targetPageId ?? null,
      modelRunId: input.modelRunId,
      agentRunId: input.agentRunId,
      scheduledRunId: input.scheduledRunId ?? null,
      action: values.action,
      status: values.status,
      proposedPageTitle: values.proposedPageTitle ?? null,
      confidence: values.confidence,
      rationaleJson: {
        reason: values.reason,
        tool: values.tool,
        agentRunId: input.agentRunId,
        scheduledRunId: input.scheduledRunId ?? null,
        origin: input.origin ?? "ingestion",
        ...(values.rationale ?? {}),
      },
    })
    .returning({ id: ingestionDecisions.id });

  return decision;
}

async function enqueuePostApply(
  ctx: AgentToolContext,
  input: CreateMutateToolsInput,
  pageId: string,
  revisionId: string,
): Promise<void> {
  await input.extractionQueue?.add(
    JOB_NAMES.TRIPLE_EXTRACTOR,
    {
      pageId,
      revisionId,
      workspaceId: ctx.workspaceId,
      useReconciliation: input.ingestion.useReconciliation,
    },
    DEFAULT_JOB_OPTIONS,
  );
  await input.searchQueue?.add(
    JOB_NAMES.SEARCH_INDEX_UPDATER,
    {
      pageId,
      revisionId,
      workspaceId: ctx.workspaceId,
    },
    DEFAULT_JOB_OPTIONS,
  );
}

async function persistDirectPatch(
  ctx: AgentToolContext,
  input: CreateMutateToolsInput,
  params: {
    tool: AgentMutateToolName;
    pageId: string;
    confidence: number;
    reason: string;
    newContentMd: string;
    revisionNote: string;
    diffChangedBlocks?: number;
    patchMeta?: Record<string, unknown>;
  },
): Promise<AgentToolResult> {
  const page = await getCurrentPage(ctx.db, ctx.workspaceId, params.pageId);
  const observedBaseRevisionId = observedRevisionIdForPage(ctx, page);
  if (page.contentMd === params.newContentMd) {
    throw new AgentToolError(
      "patch_mismatch",
      `${params.tool} produced no markdown changes`,
      { pageId: params.pageId },
    );
  }

  const status = mutationDecisionStatus(input, "update", params.confidence);
  const conflict =
    status === "auto_applied"
      ? await detectHumanConflict(
          ctx.db,
          params.pageId,
          observedBaseRevisionId,
        )
      : null;
  const decisionStatus = conflict ? "suggested" : status;
  const decision = await createDecision(ctx, input, {
    action: "update",
    status: decisionStatus,
    confidence: params.confidence,
    reason: params.reason,
    tool: params.tool,
    targetPageId: params.pageId,
    rationale: {
      baseRevisionId: page.currentRevisionId,
      observedBaseRevisionId,
      patch: params.patchMeta ?? {},
      ...(conflict
        ? {
            conflict: {
              type: "conflict_with_human_edit",
              humanRevisionId: conflict.id,
              humanUserId: conflict.actorUserId,
              humanEditedAt: conflict.createdAt.toISOString(),
              humanRevisionNote: conflict.revisionNote,
              baseRevisionId: observedBaseRevisionId,
            },
          }
        : {}),
    },
  });

  const [revision] = await ctx.db
    .insert(pageRevisions)
    .values({
      pageId: params.pageId,
      baseRevisionId: page.currentRevisionId,
      modelRunId: input.modelRunId,
      actorType: "ai",
      source: revisionSource(input),
      sourceIngestionId: input.ingestion.id,
      sourceDecisionId: decision.id,
      contentMd: params.newContentMd,
      revisionNote: params.revisionNote,
    })
    .returning({ id: pageRevisions.id });

  const diff = computeDiff(page.contentMd, params.newContentMd, null, null);
  await ctx.db.insert(revisionDiffs).values({
    revisionId: revision.id,
    diffMd: diff.diffMd,
    diffOpsJson: diff.diffOpsJson,
    changedBlocks: params.diffChangedBlocks ?? diff.changedBlocks,
  });

  if (decisionStatus === "auto_applied") {
    const now = new Date();
    await Promise.all([
      ctx.db
        .update(pages)
        .set({
          currentRevisionId: revision.id,
          updatedAt: now,
          lastAiUpdatedAt: now,
        })
        .where(eq(pages.id, params.pageId)),
      ctx.db
        .update(ingestionDecisions)
        .set({ proposedRevisionId: revision.id })
        .where(eq(ingestionDecisions.id, decision.id)),
      ctx.db.insert(auditLogs).values({
        workspaceId: ctx.workspaceId,
        modelRunId: input.modelRunId,
        entityType: "page",
        entityId: params.pageId,
        action: "update",
        afterJson: {
          source: activitySource(input, "ingestion_agent_direct_patch"),
          ingestionId: input.ingestion.id,
          scheduledRunId: input.scheduledRunId ?? null,
          decisionId: decision.id,
          revisionId: revision.id,
          tool: params.tool,
        },
      }),
    ]);
    await enqueuePostApply(ctx, input, params.pageId, revision.id);
  } else {
    const writes: Array<Promise<unknown>> = [
      ctx.db
        .update(ingestionDecisions)
        .set({ proposedRevisionId: revision.id })
        .where(eq(ingestionDecisions.id, decision.id)),
    ];
    if (conflict) {
      writes.push(
        ctx.db.insert(auditLogs).values({
          workspaceId: ctx.workspaceId,
          modelRunId: input.modelRunId,
          entityType: "page",
          entityId: params.pageId,
          action: "update",
          afterJson: {
            source: activitySource(
              input,
              "ingestion_agent_direct_patch_conflict_downgrade",
            ),
            ingestionId: input.ingestion.id,
            scheduledRunId: input.scheduledRunId ?? null,
            decisionId: decision.id,
            revisionId: revision.id,
            tool: params.tool,
            conflict: {
              humanRevisionId: conflict.id,
              humanEditedAt: conflict.createdAt.toISOString(),
            },
          },
        }),
      );
    }
    await Promise.all(writes);
  }

  return {
    data: {
      decisionId: decision.id,
      revisionId: revision.id,
      pageId: params.pageId,
      status: decisionStatus,
      action: "update",
      tool: params.tool,
    },
    mutatedPageIds: [params.pageId],
    observedPageRevisions: [{ pageId: params.pageId, revisionId: revision.id }],
  };
}

async function replaceInPage(
  input: CreateMutateToolsInput,
  ctx: AgentToolContext,
  args: ReplaceInPageToolInput,
): Promise<AgentToolResult> {
  assertCanMutatePage(ctx, args.pageId);
  const page = await getCurrentPage(ctx.db, ctx.workspaceId, args.pageId);
  const patch = applyReplaceInPagePatch(page.contentMd, args);
  return persistDirectPatch(ctx, input, {
    tool: "replace_in_page",
    pageId: args.pageId,
    confidence: args.confidence,
    reason: args.reason,
    newContentMd: patch.contentMd,
    revisionNote: `Agent replace_in_page from ingestion ${input.ingestion.sourceName}`,
    patchMeta: {
      matchCount: patch.matchCount,
      occurrence: patch.occurrence,
      findExcerpt: args.find.slice(0, 500),
    },
  });
}

async function editPageBlocks(
  input: CreateMutateToolsInput,
  ctx: AgentToolContext,
  args: EditPageBlocksToolInput,
): Promise<AgentToolResult> {
  assertCanMutatePage(ctx, args.pageId);
  for (const op of args.ops) {
    if (!ctx.state.seenBlockIds.has(op.blockId)) {
      const observedBlockIds = [...ctx.state.seenBlockIds].slice(0, 200);
      throw new AgentToolError(
        "invalid_block_id",
        `Block ${op.blockId} was not observed earlier in this agent run`,
        { blockId: op.blockId, observedBlockIds },
        {
          hint:
            "Use one of the observed block IDs from read_page(format='blocks'), or call read_page again in blocks format before retrying.",
          candidates: observedBlockIds,
        },
      );
    }
  }

  const page = await getCurrentPage(ctx.db, ctx.workspaceId, args.pageId);
  const patch = applyBlockPatch(page.contentMd, args.ops);
  return persistDirectPatch(ctx, input, {
    tool: "edit_page_blocks",
    pageId: args.pageId,
    confidence: args.confidence,
    reason: args.reason,
    newContentMd: patch.contentMd,
    revisionNote: `Agent edit_page_blocks from ingestion ${input.ingestion.sourceName}`,
    diffChangedBlocks: patch.changedBlocks,
    patchMeta: {
      ops: args.ops.map((op) => ({ blockId: op.blockId, op: op.op })),
    },
  });
}

async function editPageSection(
  input: CreateMutateToolsInput,
  ctx: AgentToolContext,
  args: EditPageSectionToolInput,
): Promise<AgentToolResult> {
  assertCanMutatePage(ctx, args.pageId);
  const page = await getCurrentPage(ctx.db, ctx.workspaceId, args.pageId);
  const patch = applySectionPatch(page.contentMd, args);
  return persistDirectPatch(ctx, input, {
    tool: "edit_page_section",
    pageId: args.pageId,
    confidence: args.confidence,
    reason: args.reason,
    newContentMd: patch.contentMd,
    revisionNote: `Agent edit_page_section from ingestion ${input.ingestion.sourceName}`,
    patchMeta: {
      sectionAnchor: args.sectionAnchor,
      op: args.op,
      headingText: patch.headingText,
      headingLevel: patch.headingLevel,
    },
  });
}

async function enqueuePatchFallback(
  input: CreateMutateToolsInput,
  ctx: AgentToolContext,
  args: UpdatePageToolInput | AppendToPageToolInput,
  action: "update" | "append",
): Promise<AgentToolResult> {
  assertCanMutatePage(ctx, args.pageId);
  const page = await getCurrentPage(ctx.db, ctx.workspaceId, args.pageId);
  const status = mutationDecisionStatus(input, action, args.confidence);
  const contentOverrideMd =
    action === "update"
      ? (args as UpdatePageToolInput).newContentMd
      : (args as AppendToPageToolInput).contentMd;
  const proposedContentMd =
    action === "update"
      ? contentOverrideMd
      : `${page.contentMd}\n\n${contentOverrideMd}`;
  if (status !== "auto_applied" && page.contentMd === proposedContentMd) {
    throw new AgentToolError(
      "patch_mismatch",
      `${action}_page produced no markdown changes`,
      { pageId: args.pageId },
    );
  }
  const decision = await createDecision(ctx, input, {
    action,
    status,
    confidence: args.confidence,
    reason: args.reason,
    tool: action === "update" ? "update_page" : "append_to_page",
    targetPageId: args.pageId,
    rationale: {
      baseRevisionId: page.currentRevisionId,
      sectionHint: "sectionHint" in args ? args.sectionHint ?? null : null,
    },
  });

  let enqueued = false;
  if (status === "auto_applied") {
    if (!input.patchQueue) {
      throw new AgentToolError(
        "execution_failed",
        "patch queue is unavailable for update_page/append_to_page",
      );
    }
    await input.patchQueue.add(
      JOB_NAMES.PATCH_GENERATOR,
      {
        ingestionId: input.ingestion.id,
        decisionId: decision.id,
        workspaceId: ctx.workspaceId,
        targetPageId: args.pageId,
        action,
        baseRevisionId: page.currentRevisionId,
        agentRunId: input.agentRunId,
        scheduledRunId: input.scheduledRunId ?? null,
        contentOverrideMd,
        sectionHint: "sectionHint" in args ? args.sectionHint ?? null : null,
      },
      DEFAULT_JOB_OPTIONS,
    );
    enqueued = true;
  } else {
    const [revision] = await ctx.db
      .insert(pageRevisions)
      .values({
        pageId: args.pageId,
        baseRevisionId: page.currentRevisionId,
        modelRunId: input.modelRunId,
        actorType: "ai",
        source: revisionSource(input),
        sourceIngestionId: input.ingestion.id,
        sourceDecisionId: decision.id,
        contentMd: proposedContentMd,
        revisionNote: `Agent proposed ${action}_page from ingestion ${input.ingestion.sourceName}`,
      })
      .returning({ id: pageRevisions.id });

    const diff = computeDiff(page.contentMd, proposedContentMd, null, null);
    await Promise.all([
      ctx.db.insert(revisionDiffs).values({
        revisionId: revision.id,
        diffMd: diff.diffMd,
        diffOpsJson: diff.diffOpsJson,
        changedBlocks: diff.changedBlocks,
      }),
      ctx.db
        .update(ingestionDecisions)
        .set({ proposedRevisionId: revision.id })
        .where(eq(ingestionDecisions.id, decision.id)),
    ]);
  }

  return {
    data: {
      decisionId: decision.id,
      pageId: args.pageId,
      status,
      action,
      patchQueued: enqueued,
    },
    mutatedPageIds: [args.pageId],
  };
}

async function createPage(
  input: CreateMutateToolsInput,
  ctx: AgentToolContext,
  args: CreatePageToolInput,
): Promise<AgentToolResult> {
  const status = mutationDecisionStatus(input, "create", args.confidence);

  if (status !== "auto_applied") {
    const decision = await createDecision(ctx, input, {
      action: "create",
      status,
      confidence: args.confidence,
      reason: args.reason,
      tool: "create_page",
      proposedPageTitle: args.title,
      rationale: {
        proposedContentMd: args.contentMd,
      },
    });
    return {
      data: {
        decisionId: decision.id,
        status,
        action: "create",
        proposedTitle: args.title,
      },
    };
  }

  const parentFolderId =
    args.parentFolderId ?? input.ingestion.targetFolderId ?? null;
  const parentPageId =
    args.parentPageId ?? input.ingestion.targetParentPageId ?? null;
  if (parentFolderId && parentPageId) {
    throw new AgentToolError(
      "conflict",
      "create_page cannot use both parentFolderId and parentPageId",
    );
  }
  if (parentFolderId) {
    const [folder] = await ctx.db
      .select({ id: folders.id })
      .from(folders)
      .where(
        and(
          eq(folders.workspaceId, ctx.workspaceId),
          eq(folders.id, parentFolderId),
        ),
      )
      .limit(1);
    if (!folder) {
      throw new AgentToolError(
        "invalid_target_page",
        `Folder ${parentFolderId} was not found in this workspace`,
        { parentFolderId },
      );
    }
  }
  if (parentPageId) {
    if (parentPageId !== input.ingestion.targetParentPageId) {
      assertObservedPage(ctx, parentPageId);
    }
    await getCurrentPage(ctx.db, ctx.workspaceId, parentPageId);
  }

  const page = await insertPageWithUniqueSlug(ctx.db, {
    workspaceId: ctx.workspaceId,
    title: args.title,
    baseSlug: slugify(args.title),
    parentFolderId,
    parentPageId,
  });

  const decision = await createDecision(ctx, input, {
    action: "create",
    status,
    confidence: args.confidence,
    reason: args.reason,
    tool: "create_page",
    targetPageId: page.id,
    proposedPageTitle: args.title,
  });

  const [revision] = await ctx.db
    .insert(pageRevisions)
    .values({
      pageId: page.id,
      modelRunId: input.modelRunId,
      actorType: "ai",
      source: revisionSource(input),
      sourceIngestionId: input.ingestion.id,
      sourceDecisionId: decision.id,
      contentMd: args.contentMd,
      revisionNote: `Agent create_page from ingestion ${input.ingestion.sourceName}`,
    })
    .returning({ id: pageRevisions.id });

  const now = new Date();
  await Promise.all([
    ctx.db
      .update(pages)
      .set({ currentRevisionId: revision.id, lastAiUpdatedAt: now })
      .where(eq(pages.id, page.id)),
    ctx.db.insert(pagePaths).values({
      workspaceId: ctx.workspaceId,
      pageId: page.id,
      path: page.slug,
      isCurrent: true,
    }),
    ctx.db
      .update(ingestionDecisions)
      .set({ proposedRevisionId: revision.id })
      .where(eq(ingestionDecisions.id, decision.id)),
    ctx.db.insert(auditLogs).values({
      workspaceId: ctx.workspaceId,
      modelRunId: input.modelRunId,
      entityType: "page",
      entityId: page.id,
      action: "create",
      afterJson: {
        source: activitySource(input, "ingestion_agent_auto"),
        ingestionId: input.ingestion.id,
        scheduledRunId: input.scheduledRunId ?? null,
        decisionId: decision.id,
        revisionId: revision.id,
        tool: "create_page",
      },
    }),
  ]);

  await enqueuePostApply(ctx, input, page.id, revision.id);

  return {
    data: {
      decisionId: decision.id,
      revisionId: revision.id,
      pageId: page.id,
      status,
      action: "create",
    },
    createdPageIds: [page.id],
    mutatedPageIds: [page.id],
  };
}

async function deletePage(
  input: CreateMutateToolsInput,
  ctx: AgentToolContext,
  args: DeletePageToolInput,
): Promise<AgentToolResult> {
  if (input.origin !== "scheduled") {
    throw new AgentToolError(
      "conflict",
      "delete_page is only available for scheduled agent runs",
    );
  }
  assertCanMutatePage(ctx, args.pageId);

  const page = await getCurrentPage(ctx.db, ctx.workspaceId, args.pageId);
  const observedBaseRevisionId = observedRevisionIdForPage(ctx, page);
  const conflict = await detectHumanConflict(
    ctx.db,
    args.pageId,
    observedBaseRevisionId,
  );
  const decision = await createDecision(ctx, input, {
    action: "delete",
    status: destructiveDecisionStatus(),
    confidence: args.confidence,
    reason: args.reason,
    tool: "delete_page",
    targetPageId: args.pageId,
    rationale: {
      kind: "delete",
      baseRevisionId: page.currentRevisionId,
      observedBaseRevisionId,
      pageTitle: page.title,
      ...(conflict
        ? {
            conflict: {
              type: "conflict_with_human_edit",
              humanRevisionId: conflict.id,
              humanUserId: conflict.actorUserId,
              humanEditedAt: conflict.createdAt.toISOString(),
              humanRevisionNote: conflict.revisionNote,
              baseRevisionId: observedBaseRevisionId,
            },
          }
        : {}),
    },
  });

  return {
    data: {
      decisionId: decision.id,
      pageId: args.pageId,
      status: "suggested",
      action: "delete",
      tool: "delete_page",
    },
    mutatedPageIds: [args.pageId],
  };
}

async function mergePages(
  input: CreateMutateToolsInput,
  ctx: AgentToolContext,
  args: MergePagesToolInput,
): Promise<AgentToolResult> {
  if (input.origin !== "scheduled") {
    throw new AgentToolError(
      "conflict",
      "merge_pages is only available for scheduled agent runs",
    );
  }
  assertCanMutatePage(ctx, args.canonicalPageId);
  for (const sourcePageId of args.sourcePageIds) {
    assertCanMutatePage(ctx, sourcePageId);
  }

  const canonical = await getCurrentPage(
    ctx.db,
    ctx.workspaceId,
    args.canonicalPageId,
  );
  const sourcePages = await Promise.all(
    args.sourcePageIds.map((pageId) =>
      getCurrentPage(ctx.db, ctx.workspaceId, pageId),
    ),
  );
  const observedBaseRevisionId = observedRevisionIdForPage(ctx, canonical);
  const conflictRows = await Promise.all([
    detectHumanConflict(ctx.db, canonical.id, observedBaseRevisionId).then(
      (conflict) => ({ page: canonical, conflict, role: "canonical" as const }),
    ),
    ...sourcePages.map((page) =>
      detectHumanConflict(
        ctx.db,
        page.id,
        observedRevisionIdForPage(ctx, page),
      ).then((conflict) => ({ page, conflict, role: "source" as const })),
    ),
  ]);
  const conflicts = conflictRows
    .filter((row) => row.conflict)
    .map((row) => ({
      type: "conflict_with_human_edit",
      role: row.role,
      pageId: row.page.id,
      pageTitle: row.page.title,
      humanRevisionId: row.conflict!.id,
      humanUserId: row.conflict!.actorUserId,
      humanEditedAt: row.conflict!.createdAt.toISOString(),
      humanRevisionNote: row.conflict!.revisionNote,
      baseRevisionId: observedRevisionIdForPage(ctx, row.page),
    }));

  const decision = await createDecision(ctx, input, {
    action: "merge",
    status: destructiveDecisionStatus(),
    confidence: args.confidence,
    reason: args.reason,
    tool: "merge_pages",
    targetPageId: args.canonicalPageId,
    rationale: {
      kind: "merge",
      canonicalPageId: args.canonicalPageId,
      sourcePageIds: args.sourcePageIds,
      baseRevisionId: canonical.currentRevisionId,
      observedBaseRevisionId,
      canonicalPage: { id: canonical.id, title: canonical.title },
      sourcePages: sourcePages.map((page) => ({
        id: page.id,
        title: page.title,
      })),
      ...(conflicts.length ? { conflicts, conflict: conflicts[0] } : {}),
    },
  });

  const [revision] = await ctx.db
    .insert(pageRevisions)
    .values({
      pageId: args.canonicalPageId,
      baseRevisionId: canonical.currentRevisionId,
      modelRunId: input.modelRunId,
      actorType: "ai",
      source: "scheduled",
      sourceIngestionId: input.ingestion.id,
      sourceDecisionId: decision.id,
      contentMd: args.mergedContentMd,
      revisionNote: `Agent merge_pages from ingestion ${input.ingestion.sourceName}`,
    })
    .returning({ id: pageRevisions.id });

  const diff = computeDiff(
    canonical.contentMd,
    args.mergedContentMd,
    null,
    null,
  );
  await Promise.all([
    ctx.db.insert(revisionDiffs).values({
      revisionId: revision.id,
      diffMd: diff.diffMd,
      diffOpsJson: diff.diffOpsJson,
      changedBlocks: diff.changedBlocks,
    }),
    ctx.db
      .update(ingestionDecisions)
      .set({ proposedRevisionId: revision.id })
      .where(eq(ingestionDecisions.id, decision.id)),
  ]);

  return {
    data: {
      decisionId: decision.id,
      revisionId: revision.id,
      pageId: args.canonicalPageId,
      sourcePageIds: args.sourcePageIds,
      status: "suggested",
      action: "merge",
      tool: "merge_pages",
    },
    mutatedPageIds: [args.canonicalPageId, ...args.sourcePageIds],
    observedPageRevisions: [
      { pageId: args.canonicalPageId, revisionId: revision.id },
    ],
  };
}

async function noop(
  input: CreateMutateToolsInput,
  ctx: AgentToolContext,
  args: NoopToolInput,
): Promise<AgentToolResult> {
  const decision = await createDecision(ctx, input, {
    action: "noop",
    status: "noop",
    confidence: args.confidence,
    reason: args.reason,
    tool: "noop",
  });
  return {
    data: { decisionId: decision.id, status: "noop", action: "noop" },
  };
}

async function requestHumanReview(
  input: CreateMutateToolsInput,
  ctx: AgentToolContext,
  args: RequestHumanReviewToolInput,
): Promise<AgentToolResult> {
  const decision = await createDecision(ctx, input, {
    action: "needs_review",
    status: "needs_review",
    confidence: args.confidence,
    reason: args.reason,
    tool: "request_human_review",
    rationale: {
      suggestedAction: args.suggestedAction ?? null,
      suggestedPageIds: args.suggestedPageIds,
    },
  });
  return {
    data: {
      decisionId: decision.id,
      status: "needs_review",
      action: "needs_review",
    },
  };
}

export async function recordAgentMutationFailure(
  ctx: AgentToolContext,
  input: CreateMutateToolsInput,
  failure: {
    tool: string;
    message: string;
    details?: unknown;
  },
): Promise<string> {
  const [decision] = await ctx.db
    .insert(ingestionDecisions)
    .values({
      ingestionId: input.ingestion.id,
      modelRunId: input.modelRunId,
      agentRunId: input.agentRunId,
      scheduledRunId: input.scheduledRunId ?? null,
      action: "needs_review",
      status: "failed",
      confidence: 0,
      rationaleJson: {
        reason: `Agent mutation failed: ${failure.message}`,
        tool: failure.tool,
        agentRunId: input.agentRunId,
        scheduledRunId: input.scheduledRunId ?? null,
        origin: input.origin ?? "ingestion",
        details: failure.details ?? null,
      },
    })
    .returning({ id: ingestionDecisions.id });
  return decision.id;
}

export function createMutateTools(
  input: CreateMutateToolsInput,
): Record<string, AgentToolDefinition> {
  const tools: Record<string, AgentToolDefinition> = {
    replace_in_page: {
      name: "replace_in_page",
      description: "Replace an exact text occurrence inside an observed page.",
      schema: agentMutateToolInputSchemas.replace_in_page,
      execute: (ctx, args) =>
        replaceInPage(input, ctx, args as ReplaceInPageToolInput),
    },
    edit_page_blocks: {
      name: "edit_page_blocks",
      description: "Apply markdown block operations using observed block ids.",
      schema: agentMutateToolInputSchemas.edit_page_blocks,
      execute: (ctx, args) =>
        editPageBlocks(input, ctx, args as EditPageBlocksToolInput),
    },
    edit_page_section: {
      name: "edit_page_section",
      description: "Replace, append, prepend, or delete a heading section.",
      schema: agentMutateToolInputSchemas.edit_page_section,
      execute: (ctx, args) =>
        editPageSection(input, ctx, args as EditPageSectionToolInput),
    },
    update_page: {
      name: "update_page",
      description: "Queue a full-page update fallback through patch-generator.",
      schema: agentMutateToolInputSchemas.update_page,
      execute: (ctx, args) =>
        enqueuePatchFallback(input, ctx, args as UpdatePageToolInput, "update"),
    },
    append_to_page: {
      name: "append_to_page",
      description: "Queue an append fallback through patch-generator.",
      schema: agentMutateToolInputSchemas.append_to_page,
      execute: (ctx, args) =>
        enqueuePatchFallback(input, ctx, args as AppendToPageToolInput, "append"),
    },
    create_page: {
      name: "create_page",
      description: "Create a new page or create a review decision for it.",
      schema: agentMutateToolInputSchemas.create_page,
      execute: (ctx, args) => createPage(input, ctx, args as CreatePageToolInput),
    },
    noop: {
      name: "noop",
      description: "Record that the ingestion requires no wiki change.",
      schema: agentMutateToolInputSchemas.noop,
      execute: (ctx, args) => noop(input, ctx, args as NoopToolInput),
    },
    request_human_review: {
      name: "request_human_review",
      description: "Record a human-visible review decision.",
      schema: agentMutateToolInputSchemas.request_human_review,
      execute: (ctx, args) =>
        requestHumanReview(input, ctx, args as RequestHumanReviewToolInput),
    },
  };

  if (input.origin === "scheduled") {
    tools.delete_page = {
      name: "delete_page",
      description:
        "Create a human-reviewable suggestion to delete an observed redundant page.",
      schema: agentMutateToolInputSchemas.delete_page,
      execute: (ctx, args) =>
        deletePage(input, ctx, args as DeletePageToolInput),
    };
    tools.merge_pages = {
      name: "merge_pages",
      description:
        "Create a human-reviewable suggestion to merge observed source pages into a canonical page.",
      schema: agentMutateToolInputSchemas.merge_pages,
      execute: (ctx, args) =>
        mergePages(input, ctx, args as MergePagesToolInput),
    };
  }

  return tools;
}
