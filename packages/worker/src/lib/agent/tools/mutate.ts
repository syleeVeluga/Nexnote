import type { Queue } from "bullmq";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import {
  auditLogs,
  collectDescendantPageIds,
  cleanupOrphanEntities,
  createFolderStructure,
  folders,
  ingestionDecisions,
  insertPageWithUniqueSlug,
  pagePaths,
  pageRedirects,
  pageRevisions,
  pages,
  PageDeletionError,
  PageStructureError,
  purgeDeletedSubtreeInTransaction,
  revisionDiffs,
  RollbackRevisionError,
  rollbackToRevision,
  softDeleteSubtreeInTransaction,
  updatePageStructure,
} from "@wekiflow/db";
import {
  agentMutateToolInputSchemas,
  classifyDecisionStatus,
  computeDiff,
  DEFAULT_JOB_OPTIONS,
  JOB_NAMES,
  slugify,
  type AgentMutateToolName,
  type AutonomyMode,
  type AppendToPageToolInput,
  type CreatePageToolInput,
  type CreateFolderToolInput,
  type DeletePageToolInput,
  type EditPageBlocksToolInput,
  type EditPageSectionToolInput,
  type IngestionAction,
  type MergePagesToolInput,
  type MovePageToolInput,
  type NoopToolInput,
  type PatchGeneratorJobData,
  type PageLinkExtractorJobData,
  type ReplaceInPageToolInput,
  type RenamePageToolInput,
  type RequestHumanReviewToolInput,
  type ReorderIntent,
  type RollbackToRevisionToolInput,
  type SearchIndexUpdaterJobData,
  type TripleExtractorJobData,
  type UpdatePageToolInput,
} from "@wekiflow/shared";
import { applyBlockPatch } from "../patch/block-patch.js";
import { applyReplaceInPagePatch } from "../patch/inline-patch.js";
import { applySectionPatch } from "../patch/section-patch.js";
import { deleteOriginals, storageEnabled } from "../../storage/s3.js";
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
  allowDestructiveScheduledAgent?: boolean;
  autonomyMode?: AutonomyMode;
  autonomyMaxDestructivePerRun?: number;
  consumeDestructiveDailyOperation?: () => Promise<void>;
  patchQueue?: QueueLike<PatchGeneratorJobData>;
  extractionQueue?: QueueLike<TripleExtractorJobData>;
  searchQueue?: QueueLike<SearchIndexUpdaterJobData>;
  linkQueue?: QueueLike<PageLinkExtractorJobData>;
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

function activitySource(input: CreateMutateToolsInput, source: string): string {
  return input.origin === "scheduled"
    ? source.replace("ingestion_agent", "scheduled_agent")
    : source;
}

async function deleteArchivedOriginals(
  storageKeys: string[],
  context: string,
): Promise<void> {
  const uniqueStorageKeys = [...new Set(storageKeys)];
  if (!storageEnabled || uniqueStorageKeys.length === 0) return;
  try {
    await deleteOriginals(uniqueStorageKeys);
  } catch (err) {
    console.warn(
      `[agent-mutate] Failed to delete ${uniqueStorageKeys.length} archived originals after ${context}`,
      err,
    );
  }
}

function scheduledAutoApplyStatus(
  action: IngestionAction,
  confidence: number,
): ReturnType<typeof classifyDecisionStatus> {
  void confidence;
  if (action === "noop") return "noop";
  if (action === "needs_review") return "noop";
  return "auto_applied";
}

function autonomyDecisionStatus(
  action: IngestionAction,
  confidence: number,
  autonomyMode: AutonomyMode | undefined,
): ReturnType<typeof classifyDecisionStatus> {
  if (autonomyMode === "autonomous_shadow") {
    if (action === "noop") return "noop";
    if (action === "needs_review") return "needs_review";
    return "suggested";
  }
  return classifyDecisionStatus(action, confidence, {
    autonomous: autonomyMode === "autonomous",
  });
}

function mutationDecisionStatus(
  input: CreateMutateToolsInput,
  action: "create" | "update" | "append",
  confidence: number,
): ReturnType<typeof classifyDecisionStatus> {
  if (input.origin === "scheduled") {
    return scheduledAutoApplyStatus(action, confidence);
  }
  return autonomyDecisionStatus(action, confidence, input.autonomyMode);
}

function destructiveDecisionStatus(
  input: CreateMutateToolsInput,
  action: "delete" | "merge",
  confidence: number,
): ReturnType<typeof classifyDecisionStatus> {
  if (input.origin === "scheduled") {
    // Scheduled Agent runs are autonomous: delete and merge must not create
    // approval work or trash-restore conflicts.
    return scheduledAutoApplyStatus(action, confidence);
  }
  return autonomyDecisionStatus(action, confidence, input.autonomyMode);
}

function destructiveToolsEnabled(input: CreateMutateToolsInput): boolean {
  return (
    (input.origin === "scheduled" && input.allowDestructiveScheduledAgent) ||
    input.autonomyMode === "autonomous" ||
    input.autonomyMode === "autonomous_shadow"
  );
}

function assertDestructiveToolAllowed(input: CreateMutateToolsInput): void {
  if (destructiveToolsEnabled(input)) return;
  throw new AgentToolError(
    "conflict",
    "Destructive tools are disabled for this agent run",
  );
}

async function consumeDestructiveOperation(
  input: CreateMutateToolsInput,
  ctx: AgentToolContext,
  status: ReturnType<typeof classifyDecisionStatus>,
): Promise<void> {
  const limit = input.autonomyMaxDestructivePerRun;
  if (limit != null && ctx.state.destructiveCount >= limit) {
    throw new AgentToolError(
      "destructive_limit_exceeded",
      `Destructive operation limit exceeded (${limit})`,
      {
        used: ctx.state.destructiveCount,
        limit,
      },
      {
        hint: `Already used ${ctx.state.destructiveCount} destructive operations this run; limit is ${limit}. Use request_human_review or noop for remaining destructive work.`,
      },
    );
  }
  ctx.state.destructiveCount += 1;
  if (status === "auto_applied") {
    try {
      await input.consumeDestructiveDailyOperation?.();
    } catch (err) {
      throw new AgentToolError(
        "destructive_limit_exceeded",
        err instanceof Error ? err.message : "Destructive daily limit exceeded",
        undefined,
        {
          hint: "Workspace daily destructive cap has been reached. Use request_human_review or noop for remaining destructive work.",
        },
      );
    }
  }
}

function assertObservedPage(ctx: AgentToolContext, pageId: string): void {
  if (
    !ctx.state.seenPageIds.has(pageId) &&
    !ctx.state.createdPageIds.has(pageId)
  ) {
    const observedPageIds = [...ctx.state.seenPageIds].slice(0, 100);
    throw new AgentToolError(
      "invalid_target_page",
      `Page ${pageId} was not observed earlier in this agent run`,
      { pageId, observedPageIds },
      {
        hint: "Mutate tools can only target page IDs returned by read/search tools in this run. Search or read the page first, then retry with an observed pageId.",
        candidates: observedPageIds,
      },
    );
  }
}

function assertObservedFolder(ctx: AgentToolContext, folderId: string): void {
  if (
    !ctx.state.seenFolderIds.has(folderId) &&
    !ctx.state.createdFolderIds.has(folderId)
  ) {
    const observedFolderIds = [...ctx.state.seenFolderIds].slice(0, 100);
    throw new AgentToolError(
      "invalid_target_page",
      `Folder ${folderId} was not observed earlier in this agent run`,
      { folderId, observedFolderIds },
      {
        hint: "Move targets must come from list_folder or a create_folder result in this run. List or create the folder first, then retry with an observed folderId.",
        candidates: observedFolderIds,
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

function structureError(err: unknown): never {
  if (err instanceof PageStructureError) {
    throw new AgentToolError(
      err.statusCode === 404 ? "not_found" : "conflict",
      err.message,
      { code: err.errorCode, detail: err.code },
    );
  }
  throw err;
}

function toReorderIntent(args: MovePageToolInput): ReorderIntent | undefined {
  switch (args.reorderIntent) {
    case "before":
    case "after":
      return {
        kind: args.reorderIntent,
        anchorId: args.reorderAnchorPageId!,
      };
    case "append":
      return { kind: "asLastChild" };
    case "explicit":
    case undefined:
      return undefined;
  }
}

function normalizeMoveParents(args: MovePageToolInput): {
  parentPageId?: string | null;
  parentFolderId?: string | null;
} {
  if (args.newParentPageId !== undefined) {
    return {
      parentPageId: args.newParentPageId,
      parentFolderId: null,
    };
  }
  if (args.newParentFolderId !== undefined) {
    return {
      parentPageId: null,
      parentFolderId: args.newParentFolderId,
    };
  }
  return {};
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
  await input.linkQueue?.add(
    JOB_NAMES.PAGE_LINK_EXTRACTOR,
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
      ? await detectHumanConflict(ctx.db, params.pageId, observedBaseRevisionId)
      : null;
  const overridesHumanConflict =
    Boolean(conflict) && input.autonomyMode === "autonomous";
  const decisionStatus =
    conflict &&
    !overridesHumanConflict &&
    !(input.origin === "scheduled" && input.scheduledAutoApply)
      ? "suggested"
      : status;
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
    const writes: Array<Promise<unknown>> = [
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
    ];
    if (overridesHumanConflict && conflict) {
      writes.push(
        ctx.db.insert(auditLogs).values({
          workspaceId: ctx.workspaceId,
          modelRunId: input.modelRunId,
          entityType: "page",
          entityId: params.pageId,
          action: "autonomous_overrode_human_conflict",
          afterJson: {
            source: activitySource(input, "ingestion_agent_autonomous"),
            ingestionId: input.ingestion.id,
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
          hint: "Use one of the observed block IDs from read_page(format='blocks'), or call read_page again in blocks format before retrying.",
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
      sectionHint: "sectionHint" in args ? (args.sectionHint ?? null) : null,
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
        sectionHint: "sectionHint" in args ? (args.sectionHint ?? null) : null,
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

async function movePage(
  input: CreateMutateToolsInput,
  ctx: AgentToolContext,
  args: MovePageToolInput,
): Promise<AgentToolResult> {
  assertCanMutatePage(ctx, args.pageId);
  if (args.newParentPageId) assertObservedPage(ctx, args.newParentPageId);
  if (args.newParentFolderId) assertObservedFolder(ctx, args.newParentFolderId);
  if (args.reorderAnchorPageId && args.reorderAnchorPageId !== args.pageId) {
    assertObservedPage(ctx, args.reorderAnchorPageId);
  }

  const status = mutationDecisionStatus(input, "update", args.confidence);
  const [current] = await ctx.db
    .select({
      id: pages.id,
      parentPageId: pages.parentPageId,
      parentFolderId: pages.parentFolderId,
      sortOrder: pages.sortOrder,
      currentRevisionId: pages.currentRevisionId,
    })
    .from(pages)
    .where(
      and(
        eq(pages.id, args.pageId),
        eq(pages.workspaceId, ctx.workspaceId),
        isNull(pages.deletedAt),
      ),
    )
    .limit(1);
  if (!current) {
    throw new AgentToolError("not_found", `Page ${args.pageId} not found`, {
      pageId: args.pageId,
    });
  }

  const rationale = {
    from: {
      parentPageId: current.parentPageId,
      parentFolderId: current.parentFolderId,
      sortOrder: current.sortOrder,
    },
    to: {
      newParentPageId: args.newParentPageId,
      newParentFolderId: args.newParentFolderId,
      newSortOrder: args.newSortOrder,
      reorderIntent: args.reorderIntent,
      reorderAnchorPageId: args.reorderAnchorPageId,
    },
  };

  if (status !== "auto_applied") {
    const decision = await createDecision(ctx, input, {
      action: "update",
      status,
      confidence: args.confidence,
      reason: args.reason,
      tool: "move_page",
      targetPageId: args.pageId,
      rationale,
    });
    return {
      data: {
        decisionId: decision.id,
        pageId: args.pageId,
        status,
        action: "update",
      },
    };
  }

  let result: Awaited<ReturnType<typeof updatePageStructure>>;
  try {
    const parentPatch = normalizeMoveParents(args);
    result = await updatePageStructure({
      db: ctx.db,
      workspaceId: ctx.workspaceId,
      pageId: args.pageId,
      actorUserId: null,
      modelRunId: input.modelRunId,
      ...parentPatch,
      sortOrder: args.newSortOrder,
      reorderIntent: toReorderIntent(args),
      auditAction: "agent.move_page",
      auditAfterJson: {
        source: activitySource(input, "ingestion_agent_auto"),
        ingestionId: input.ingestion.id,
        scheduledRunId: input.scheduledRunId ?? null,
        agentRunId: input.agentRunId,
        tool: "move_page",
        reason: args.reason,
        ...rationale,
      },
    });
  } catch (err) {
    structureError(err);
  }

  const decision = await createDecision(ctx, input, {
    action: "update",
    status,
    confidence: args.confidence,
    reason: args.reason,
    tool: "move_page",
    targetPageId: args.pageId,
    rationale,
  });

  if (result.parentChanged && result.before.currentRevisionId) {
    await input.extractionQueue?.add(
      JOB_NAMES.TRIPLE_EXTRACTOR,
      {
        workspaceId: ctx.workspaceId,
        pageId: args.pageId,
        revisionId: result.before.currentRevisionId,
        useReconciliation: input.ingestion.useReconciliation ?? true,
      },
      {
        jobId: `move:${args.pageId}:${Date.now()}`,
        ...DEFAULT_JOB_OPTIONS,
      },
    );
    await ctx.db.insert(auditLogs).values({
      workspaceId: ctx.workspaceId,
      modelRunId: input.modelRunId,
      entityType: "page",
      entityId: args.pageId,
      action: "reextract_enqueued",
      afterJson: {
        reason: "parent_changed",
        tool: "move_page",
        ingestionId: input.ingestion.id,
        scheduledRunId: input.scheduledRunId ?? null,
        decisionId: decision.id,
        previousParentPageId: result.before.parentPageId,
        previousParentFolderId: result.before.parentFolderId,
      },
    });
  }

  return {
    data: {
      decisionId: decision.id,
      pageId: args.pageId,
      status,
      action: "update",
      parentChanged: result.parentChanged,
    },
    mutatedPageIds: [args.pageId],
  };
}

async function renamePage(
  input: CreateMutateToolsInput,
  ctx: AgentToolContext,
  args: RenamePageToolInput,
): Promise<AgentToolResult> {
  assertCanMutatePage(ctx, args.pageId);
  const status = mutationDecisionStatus(input, "update", args.confidence);
  const [current] = await ctx.db
    .select({ title: pages.title, slug: pages.slug })
    .from(pages)
    .where(
      and(
        eq(pages.id, args.pageId),
        eq(pages.workspaceId, ctx.workspaceId),
        isNull(pages.deletedAt),
      ),
    )
    .limit(1);
  if (!current) {
    throw new AgentToolError("not_found", `Page ${args.pageId} not found`, {
      pageId: args.pageId,
    });
  }

  const rationale = {
    from: { title: current.title, slug: current.slug },
    to: { newTitle: args.newTitle, newSlug: args.newSlug },
  };

  if (status !== "auto_applied") {
    const decision = await createDecision(ctx, input, {
      action: "update",
      status,
      confidence: args.confidence,
      reason: args.reason,
      tool: "rename_page",
      targetPageId: args.pageId,
      rationale,
    });
    return {
      data: {
        decisionId: decision.id,
        pageId: args.pageId,
        status,
        action: "update",
      },
    };
  }

  let result: Awaited<ReturnType<typeof updatePageStructure>>;
  try {
    result = await updatePageStructure({
      db: ctx.db,
      workspaceId: ctx.workspaceId,
      pageId: args.pageId,
      actorUserId: null,
      modelRunId: input.modelRunId,
      title: args.newTitle,
      slug: args.newSlug,
      auditAction: "agent.rename_page",
      auditAfterJson: {
        source: activitySource(input, "ingestion_agent_auto"),
        ingestionId: input.ingestion.id,
        scheduledRunId: input.scheduledRunId ?? null,
        agentRunId: input.agentRunId,
        tool: "rename_page",
        reason: args.reason,
        ...rationale,
      },
    });
  } catch (err) {
    structureError(err);
  }

  const decision = await createDecision(ctx, input, {
    action: "update",
    status,
    confidence: args.confidence,
    reason: args.reason,
    tool: "rename_page",
    targetPageId: args.pageId,
    rationale,
  });

  return {
    data: {
      decisionId: decision.id,
      pageId: args.pageId,
      status,
      action: "update",
      slugChanged: result.slugChanged,
    },
    mutatedPageIds: [args.pageId],
  };
}

async function createFolder(
  input: CreateMutateToolsInput,
  ctx: AgentToolContext,
  args: CreateFolderToolInput,
): Promise<AgentToolResult> {
  if (args.parentFolderId) assertObservedFolder(ctx, args.parentFolderId);
  const status = mutationDecisionStatus(input, "create", args.confidence);

  if (status !== "auto_applied") {
    const decision = await createDecision(ctx, input, {
      action: "create",
      status,
      confidence: args.confidence,
      reason: args.reason,
      tool: "create_folder",
      rationale: {
        name: args.name,
        parentFolderId: args.parentFolderId ?? null,
      },
    });
    return {
      data: {
        decisionId: decision.id,
        status,
        action: "create",
        proposedName: args.name,
      },
    };
  }

  let folder: Awaited<ReturnType<typeof createFolderStructure>>;
  try {
    folder = await createFolderStructure({
      db: ctx.db,
      workspaceId: ctx.workspaceId,
      actorUserId: null,
      modelRunId: input.modelRunId,
      name: args.name,
      parentFolderId: args.parentFolderId ?? null,
      allocateUniqueSlug: true,
      auditAction: "agent.create_folder",
      auditAfterJson: {
        source: activitySource(input, "ingestion_agent_auto"),
        ingestionId: input.ingestion.id,
        scheduledRunId: input.scheduledRunId ?? null,
        agentRunId: input.agentRunId,
        tool: "create_folder",
        reason: args.reason,
        name: args.name,
        parentFolderId: args.parentFolderId ?? null,
      },
    });
  } catch (err) {
    structureError(err);
  }

  const decision = await createDecision(ctx, input, {
    action: "create",
    status,
    confidence: args.confidence,
    reason: args.reason,
    tool: "create_folder",
    rationale: {
      folderId: folder.id,
      name: args.name,
      parentFolderId: args.parentFolderId ?? null,
      slug: folder.slug,
    },
  });

  return {
    data: {
      decisionId: decision.id,
      folderId: folder.id,
      status,
      action: "create",
      name: folder.name,
      slug: folder.slug,
    },
    observedFolderIds: [folder.id],
    createdFolderIds: [folder.id],
  };
}

async function deletePage(
  input: CreateMutateToolsInput,
  ctx: AgentToolContext,
  args: DeletePageToolInput,
): Promise<AgentToolResult> {
  assertDestructiveToolAllowed(input);
  assertCanMutatePage(ctx, args.pageId);

  const page = await getCurrentPage(ctx.db, ctx.workspaceId, args.pageId);
  const observedBaseRevisionId = observedRevisionIdForPage(ctx, page);
  const conflict = await detectHumanConflict(
    ctx.db,
    args.pageId,
    observedBaseRevisionId,
  );
  const status = destructiveDecisionStatus(input, "delete", args.confidence);
  const baseRationale: Record<string, unknown> = {
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
  };
  await consumeDestructiveOperation(input, ctx, status);
  const decision = await createDecision(ctx, input, {
    action: "delete",
    status,
    confidence: args.confidence,
    reason: args.reason,
    tool: "delete_page",
    targetPageId: args.pageId,
    rationale: baseRationale,
  });

  let appliedStatus = status;
  let deletedPageIds: string[] | undefined;
  let purgeStorageKeys: string[] = [];
  if (status === "auto_applied") {
    try {
      const result = await ctx.db.transaction(async (tx) => {
        const deletionInput = {
          workspaceId: ctx.workspaceId,
          rootPageId: args.pageId,
          modelRunId: input.modelRunId,
          auditExtra: {
            source: activitySource(input, "ingestion_agent_delete"),
            ingestionId: input.ingestion.id,
            scheduledRunId: input.scheduledRunId ?? null,
            decisionId: decision.id,
          },
        };
        if (input.origin === "scheduled") {
          const purged = await purgeDeletedSubtreeInTransaction(
            tx,
            deletionInput,
          );
          return {
            deletedPageIds: purged.purgedPageIds,
            purgedPageIds: purged.purgedPageIds,
            storageKeys: purged.storageKeys,
          };
        }
        const softDeleted = await softDeleteSubtreeInTransaction(
          tx,
          deletionInput,
        );
        return {
          deletedPageIds: softDeleted.deletedPageIds,
          purgedPageIds: null,
          storageKeys: [],
        };
      });
      deletedPageIds = result.deletedPageIds;
      purgeStorageKeys = result.storageKeys;
      await ctx.db.insert(auditLogs).values({
        workspaceId: ctx.workspaceId,
        modelRunId: input.modelRunId,
        entityType: "ingestion_decision",
        entityId: decision.id,
        action: "auto_apply_delete",
        afterJson: {
          source: activitySource(input, "ingestion_agent_delete"),
          ingestionId: input.ingestion.id,
          scheduledRunId: input.scheduledRunId ?? null,
          decisionId: decision.id,
          pageId: args.pageId,
          deletedPageIds: result.deletedPageIds,
          ...(result.purgedPageIds
            ? { purgedPageIds: result.purgedPageIds }
            : {}),
        },
      });
      await deleteArchivedOriginals(purgeStorageKeys, "delete_page");
    } catch (err) {
      if (!(err instanceof PageDeletionError)) throw err;
      appliedStatus = "failed";
      await ctx.db
        .update(ingestionDecisions)
        .set({
          status: "failed",
          rationaleJson: {
            reason: args.reason,
            tool: "delete_page",
            agentRunId: input.agentRunId,
            scheduledRunId: input.scheduledRunId ?? null,
            origin: input.origin ?? "ingestion",
            ...baseRationale,
            autoApplyFailure: {
              code: err.code,
              details: err.details,
            },
          },
        })
        .where(eq(ingestionDecisions.id, decision.id));
    }
  }

  return {
    data: {
      decisionId: decision.id,
      pageId: args.pageId,
      status: appliedStatus,
      action: "delete",
      tool: "delete_page",
      ...(deletedPageIds ? { deletedPageIds } : {}),
    },
    mutatedPageIds: [args.pageId],
  };
}

async function mergePages(
  input: CreateMutateToolsInput,
  ctx: AgentToolContext,
  args: MergePagesToolInput,
): Promise<AgentToolResult> {
  assertDestructiveToolAllowed(input);
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
  // Preflight before persisting the decision/revision: a source page cannot be
  // an ancestor of the canonical, because purging that source would remove the
  // canonical page too.
  const sourceSubtreeIds = await Promise.all(
    args.sourcePageIds.map((pageId) =>
      collectDescendantPageIds(ctx.db, ctx.workspaceId, pageId).then((ids) => ({
        sourcePageId: pageId,
        descendantPageIds: ids,
      })),
    ),
  );
  const protectedSubtree = sourceSubtreeIds.find((s) =>
    s.descendantPageIds.includes(args.canonicalPageId),
  );
  if (protectedSubtree) {
    throw new PageDeletionError("PAGE_PARENT_CONFLICT", {
      sourcePageId: protectedSubtree.sourcePageId,
      canonicalPageId: args.canonicalPageId,
    });
  }

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

  const status = destructiveDecisionStatus(input, "merge", args.confidence);
  const baseRationale: Record<string, unknown> = {
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
  };
  await consumeDestructiveOperation(input, ctx, status);
  const decision = await createDecision(ctx, input, {
    action: "merge",
    status,
    confidence: args.confidence,
    reason: args.reason,
    tool: "merge_pages",
    targetPageId: args.canonicalPageId,
    rationale: baseRationale,
  });

  const [revision] = await ctx.db
    .insert(pageRevisions)
    .values({
      pageId: args.canonicalPageId,
      baseRevisionId: canonical.currentRevisionId,
      modelRunId: input.modelRunId,
      actorType: "ai",
      source: revisionSource(input),
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

  let appliedStatus = status;
  let deletedPageIds: string[] | undefined;
  if (status === "auto_applied") {
    try {
      const applyResult = await ctx.db.transaction(async (tx) => {
        // Capture redirect paths before delete/purge disables source page_paths rows.
        const redirectRows = await tx
          .select({ pageId: pagePaths.pageId, path: pagePaths.path })
          .from(pagePaths)
          .where(
            and(
              eq(pagePaths.workspaceId, ctx.workspaceId),
              inArray(pagePaths.pageId, args.sourcePageIds),
              eq(pagePaths.isCurrent, true),
            ),
          );

        const collected: string[] = [];
        const storageKeys: string[] = [];
        const purgedPageIds: string[] = [];
        for (const sourcePageId of args.sourcePageIds) {
          const deletionInput = {
            workspaceId: ctx.workspaceId,
            rootPageId: sourcePageId,
            modelRunId: input.modelRunId,
            auditExtra: {
              source: activitySource(input, "ingestion_agent_merge"),
              ingestionId: input.ingestion.id,
              scheduledRunId: input.scheduledRunId ?? null,
              decisionId: decision.id,
              mergeCanonicalPageId: args.canonicalPageId,
            },
          };
          if (input.origin === "scheduled") {
            const result = await purgeDeletedSubtreeInTransaction(tx, {
              ...deletionInput,
              cleanupOrphanEntities: false,
            });
            collected.push(...result.purgedPageIds);
            purgedPageIds.push(...result.purgedPageIds);
            storageKeys.push(...result.storageKeys);
          } else {
            const result = await softDeleteSubtreeInTransaction(
              tx,
              deletionInput,
            );
            collected.push(...result.deletedPageIds);
          }
        }
        if (input.origin === "scheduled") {
          await cleanupOrphanEntities(tx, ctx.workspaceId);
        }

        const now = new Date();
        const redirectValues = redirectRows
          .filter((row) => row.pageId !== args.canonicalPageId)
          .map((row) => ({
            workspaceId: ctx.workspaceId,
            fromPageId: null,
            toPageId: args.canonicalPageId,
            fromPath: row.path,
            createdByDecisionId: decision.id,
          }));

        await Promise.all([
          tx
            .update(pages)
            .set({
              currentRevisionId: revision.id,
              updatedAt: now,
              lastAiUpdatedAt: now,
            })
            .where(eq(pages.id, args.canonicalPageId)),
          redirectValues.length > 0
            ? tx
                .insert(pageRedirects)
                .values(redirectValues)
                .onConflictDoNothing()
            : Promise.resolve(),
          tx.insert(auditLogs).values({
            workspaceId: ctx.workspaceId,
            modelRunId: input.modelRunId,
            entityType: "ingestion_decision",
            entityId: decision.id,
            action: "auto_apply_merge",
            afterJson: {
              source: activitySource(input, "ingestion_agent_merge"),
              ingestionId: input.ingestion.id,
              scheduledRunId: input.scheduledRunId ?? null,
              decisionId: decision.id,
              canonicalPageId: args.canonicalPageId,
              sourcePageIds: args.sourcePageIds,
              deletedPageIds: collected,
              ...(purgedPageIds.length ? { purgedPageIds } : {}),
              revisionId: revision.id,
            },
          }),
        ]);

        return { deletedPageIds: collected, storageKeys };
      });
      deletedPageIds = applyResult.deletedPageIds;

      await enqueuePostApply(ctx, input, args.canonicalPageId, revision.id);
      await deleteArchivedOriginals(applyResult.storageKeys, "merge_pages");
    } catch (err) {
      if (!(err instanceof PageDeletionError)) throw err;
      appliedStatus = "failed";
      await ctx.db
        .update(ingestionDecisions)
        .set({
          status: "failed",
          rationaleJson: {
            reason: args.reason,
            tool: "merge_pages",
            agentRunId: input.agentRunId,
            scheduledRunId: input.scheduledRunId ?? null,
            origin: input.origin ?? "ingestion",
            ...baseRationale,
            autoApplyFailure: {
              code: err.code,
              details: err.details,
            },
          },
        })
        .where(eq(ingestionDecisions.id, decision.id));
    }
  }

  return {
    data: {
      decisionId: decision.id,
      revisionId: revision.id,
      pageId: args.canonicalPageId,
      sourcePageIds: args.sourcePageIds,
      status: appliedStatus,
      action: "merge",
      tool: "merge_pages",
      ...(deletedPageIds ? { deletedPageIds } : {}),
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
  if (input.origin === "scheduled") {
    const decision = await createDecision(ctx, input, {
      action: "noop",
      status: "noop",
      confidence: args.confidence,
      reason: args.reason,
      tool: "request_human_review",
      rationale: {
        scheduledAutonomy: true,
        convertedFrom: "needs_review",
        suggestedAction: args.suggestedAction ?? null,
        suggestedPageIds: args.suggestedPageIds,
      },
    });
    return {
      data: {
        decisionId: decision.id,
        status: "noop",
        action: "noop",
      },
    };
  }

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

async function rollbackToRevisionTool(
  input: CreateMutateToolsInput,
  ctx: AgentToolContext,
  args: RollbackToRevisionToolInput,
): Promise<AgentToolResult> {
  assertCanMutatePage(ctx, args.pageId);
  const page = await getCurrentPage(ctx.db, ctx.workspaceId, args.pageId);
  const observedBaseRevisionId = observedRevisionIdForPage(ctx, page);

  const [targetRevision] = await ctx.db
    .select({
      id: pageRevisions.id,
      actorType: pageRevisions.actorType,
    })
    .from(pageRevisions)
    .where(
      and(
        eq(pageRevisions.id, args.revisionId),
        eq(pageRevisions.pageId, args.pageId),
      ),
    )
    .limit(1);

  if (!targetRevision) {
    throw new AgentToolError(
      "not_found",
      `Revision ${args.revisionId} not found for page ${args.pageId}`,
      { pageId: args.pageId, revisionId: args.revisionId },
      {
        hint: "Read the page and revision history before selecting a rollback target.",
      },
    );
  }

  const [currentRevision] = page.currentRevisionId
    ? await ctx.db
        .select({
          baseRevisionId: pageRevisions.baseRevisionId,
        })
        .from(pageRevisions)
        .where(eq(pageRevisions.id, page.currentRevisionId))
        .limit(1)
    : [];
  const humanRecentRevisionWarning =
    targetRevision.actorType === "user" &&
    currentRevision?.baseRevisionId === targetRevision.id;

  const status = mutationDecisionStatus(input, "update", args.confidence);
  const conflict =
    status === "auto_applied"
      ? await detectHumanConflict(ctx.db, args.pageId, observedBaseRevisionId)
      : null;
  const overridesHumanConflict =
    Boolean(conflict) && input.autonomyMode === "autonomous";
  const decisionStatus =
    conflict &&
    !overridesHumanConflict &&
    !(input.origin === "scheduled" && input.scheduledAutoApply)
      ? "suggested"
      : status;
  const conflictRationale = conflict
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
    : {};

  const decision = await createDecision(ctx, input, {
    action: "update",
    status: decisionStatus,
    confidence: args.confidence,
    reason: args.reason,
    tool: "rollback_to_revision",
    targetPageId: args.pageId,
    rationale: {
      baseRevisionId: page.currentRevisionId,
      observedBaseRevisionId,
      rollbackTargetRevisionId: args.revisionId,
      ...conflictRationale,
      ...(humanRecentRevisionWarning
        ? { humanRecentRevisionWarning: true }
        : {}),
    },
  });

  if (decisionStatus !== "auto_applied") {
    return {
      data: {
        decisionId: decision.id,
        pageId: args.pageId,
        status: decisionStatus,
        action: "update",
        tool: "rollback_to_revision",
        rollbackTargetRevisionId: args.revisionId,
      },
      mutatedPageIds: [args.pageId],
    };
  }

  let rollbackResult;
  try {
    rollbackResult = await rollbackToRevision({
      db: ctx.db,
      workspaceId: ctx.workspaceId,
      pageId: args.pageId,
      revisionId: args.revisionId,
      actorUserId: null,
      actorType: "ai",
      source: "rollback",
      revisionNote: args.reason.slice(0, 500),
      agentRunId: input.agentRunId,
      modelRunId: input.modelRunId,
      sourceIngestionId: input.ingestion.id,
      ingestionDecisionId: decision.id,
    });
  } catch (err) {
    if (err instanceof RollbackRevisionError) {
      throw new AgentToolError("not_found", err.message, {
        code: err.code,
        pageId: args.pageId,
        revisionId: args.revisionId,
      });
    }
    throw err;
  }

  await ctx.db
    .update(ingestionDecisions)
    .set({ proposedRevisionId: rollbackResult.newRevisionId })
    .where(eq(ingestionDecisions.id, decision.id));

  if (overridesHumanConflict && conflict) {
    await ctx.db.insert(auditLogs).values({
      workspaceId: ctx.workspaceId,
      modelRunId: input.modelRunId,
      entityType: "page",
      entityId: args.pageId,
      action: "autonomous_overrode_human_conflict",
      afterJson: {
        source: activitySource(input, "ingestion_agent_autonomous"),
        ingestionId: input.ingestion.id,
        decisionId: decision.id,
        revisionId: rollbackResult.newRevisionId,
        tool: "rollback_to_revision",
        conflict: {
          humanRevisionId: conflict.id,
          humanEditedAt: conflict.createdAt.toISOString(),
        },
      },
    });
  }

  await enqueuePostApply(ctx, input, args.pageId, rollbackResult.newRevisionId);

  return {
    data: {
      decisionId: decision.id,
      revisionId: rollbackResult.newRevisionId,
      pageId: args.pageId,
      status: decisionStatus,
      action: "update",
      tool: "rollback_to_revision",
      rollbackTargetRevisionId: args.revisionId,
      previousHeadRevisionId: rollbackResult.previousHeadRevisionId,
    },
    mutatedPageIds: [args.pageId],
    observedPageRevisions: [
      { pageId: args.pageId, revisionId: rollbackResult.newRevisionId },
    ],
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
        enqueuePatchFallback(
          input,
          ctx,
          args as AppendToPageToolInput,
          "append",
        ),
    },
    create_page: {
      name: "create_page",
      description: "Create a new page or create a review decision for it.",
      schema: agentMutateToolInputSchemas.create_page,
      execute: (ctx, args) =>
        createPage(input, ctx, args as CreatePageToolInput),
    },
    move_page: {
      name: "move_page",
      description:
        "Move an observed page to a new parent folder/page or reorder it within siblings.",
      schema: agentMutateToolInputSchemas.move_page,
      execute: (ctx, args) => movePage(input, ctx, args as MovePageToolInput),
    },
    rename_page: {
      name: "rename_page",
      description:
        "Change an observed page title and/or slug without creating a new revision.",
      schema: agentMutateToolInputSchemas.rename_page,
      execute: (ctx, args) =>
        renamePage(input, ctx, args as RenamePageToolInput),
    },
    create_folder: {
      name: "create_folder",
      description:
        "Create a new folder under an observed parent folder or the workspace root.",
      schema: agentMutateToolInputSchemas.create_folder,
      execute: (ctx, args) =>
        createFolder(input, ctx, args as CreateFolderToolInput),
    },
    rollback_to_revision: {
      name: "rollback_to_revision",
      description:
        "Rollback an observed page to one of its prior revisions when self-correcting a recent autonomous mistake.",
      schema: agentMutateToolInputSchemas.rollback_to_revision,
      execute: (ctx, args) =>
        rollbackToRevisionTool(input, ctx, args as RollbackToRevisionToolInput),
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

  if (destructiveToolsEnabled(input)) {
    tools.delete_page = {
      name: "delete_page",
      description:
        "Auto-apply deletion of an observed redundant page and permanently remove its subtree.",
      schema: agentMutateToolInputSchemas.delete_page,
      execute: (ctx, args) =>
        deletePage(input, ctx, args as DeletePageToolInput),
    };
    tools.merge_pages = {
      name: "merge_pages",
      description:
        "Auto-apply merging observed source pages into a canonical page and permanently remove source subtrees.",
      schema: agentMutateToolInputSchemas.merge_pages,
      execute: (ctx, args) =>
        mergePages(input, ctx, args as MergePagesToolInput),
    };
  }

  return tools;
}
