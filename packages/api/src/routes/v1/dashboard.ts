import type { FastifyPluginAsync } from "fastify";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  folders,
  ingestions,
  ingestionDecisions,
  pages,
  pageRevisions,
  publishedSnapshots,
} from "@wekiflow/db";
import { DECISION_STATUSES } from "@wekiflow/shared";
import {
  forbidden,
  getMemberRole,
  workspaceParamsSchema,
} from "../../lib/workspace-auth.js";
import { sendValidationError } from "../../lib/reply-helpers.js";
import {
  mapDecisionListItem,
  type DecisionListRow,
} from "../../lib/decision-dto.js";
import { mapPageDto, pageSummarySelect } from "../../lib/page-dto.js";

const DASHBOARD_DECISION_LIMIT = 6;
const DASHBOARD_FOLDER_LIMIT = 200;
const DASHBOARD_PAGE_LIMIT = 500;

function toFolderDto(row: typeof folders.$inferSelect) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    parentFolderId: row.parentFolderId,
    name: row.name,
    slug: row.slug,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function visibleDecisionClause() {
  return or(
    and(
      isNotNull(ingestionDecisions.targetPageId),
      isNull(pages.deletedAt),
    ),
    and(
      isNull(ingestionDecisions.targetPageId),
      notInArray(ingestionDecisions.status, ["auto_applied", "approved"]),
    ),
  )!;
}

function startOfRollingDay(): Date {
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

const dashboardRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error.issues);

    const { workspaceId } = params.data;
    const role = await getMemberRole(fastify.db, workspaceId, request.user.sub);
    if (!role) return forbidden(reply);

    const decisionVisibility = visibleDecisionClause();
    const decisionBaseWhere = and(
      eq(ingestions.workspaceId, workspaceId),
      decisionVisibility,
    );
    const rollingDayStart = startOfRollingDay();

    const [
      [pageCountRow],
      [folderCountRow],
      decisionCountRows,
      [autoAppliedTodayRow],
      pendingRows,
      recentAutoRows,
      folderRows,
      pageRows,
      folderPageCountRows,
    ] = await Promise.all([
      fastify.db
        .select({ count: count() })
        .from(pages)
        .where(and(eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt))),
      fastify.db
        .select({ count: count() })
        .from(folders)
        .where(eq(folders.workspaceId, workspaceId)),
      fastify.db
        .select({
          status: ingestionDecisions.status,
          count: sql<number>`count(*)::int`,
        })
        .from(ingestionDecisions)
        .innerJoin(ingestions, eq(ingestions.id, ingestionDecisions.ingestionId))
        .leftJoin(pages, eq(pages.id, ingestionDecisions.targetPageId))
        .where(decisionBaseWhere)
        .groupBy(ingestionDecisions.status),
      fastify.db
        .select({ count: sql<number>`count(*)::int` })
        .from(ingestionDecisions)
        .innerJoin(ingestions, eq(ingestions.id, ingestionDecisions.ingestionId))
        .leftJoin(pages, eq(pages.id, ingestionDecisions.targetPageId))
        .where(
          and(
            decisionBaseWhere,
            eq(ingestionDecisions.status, "auto_applied"),
            gte(ingestionDecisions.createdAt, rollingDayStart),
          ),
        ),
      fastify.db
        .select({
          id: ingestionDecisions.id,
          ingestionId: ingestionDecisions.ingestionId,
          targetPageId: ingestionDecisions.targetPageId,
          proposedRevisionId: ingestionDecisions.proposedRevisionId,
          modelRunId: ingestionDecisions.modelRunId,
          scheduledRunId: ingestionDecisions.scheduledRunId,
          action: ingestionDecisions.action,
          status: ingestionDecisions.status,
          proposedPageTitle: ingestionDecisions.proposedPageTitle,
          confidence: ingestionDecisions.confidence,
          rationaleJson: ingestionDecisions.rationaleJson,
          createdAt: ingestionDecisions.createdAt,
          ingestionSourceName: ingestions.sourceName,
          ingestionTitleHint: ingestions.titleHint,
          ingestionReceivedAt: ingestions.receivedAt,
          targetPageTitle: pages.title,
          targetPageSlug: pages.slug,
        })
        .from(ingestionDecisions)
        .innerJoin(ingestions, eq(ingestions.id, ingestionDecisions.ingestionId))
        .leftJoin(pages, eq(pages.id, ingestionDecisions.targetPageId))
        .where(
          and(
            decisionBaseWhere,
            inArray(ingestionDecisions.status, ["suggested", "needs_review"]),
          ),
        )
        .orderBy(desc(ingestionDecisions.createdAt))
        .limit(DASHBOARD_DECISION_LIMIT),
      fastify.db
        .select({
          id: ingestionDecisions.id,
          ingestionId: ingestionDecisions.ingestionId,
          targetPageId: ingestionDecisions.targetPageId,
          proposedRevisionId: ingestionDecisions.proposedRevisionId,
          modelRunId: ingestionDecisions.modelRunId,
          scheduledRunId: ingestionDecisions.scheduledRunId,
          action: ingestionDecisions.action,
          status: ingestionDecisions.status,
          proposedPageTitle: ingestionDecisions.proposedPageTitle,
          confidence: ingestionDecisions.confidence,
          rationaleJson: ingestionDecisions.rationaleJson,
          createdAt: ingestionDecisions.createdAt,
          ingestionSourceName: ingestions.sourceName,
          ingestionTitleHint: ingestions.titleHint,
          ingestionReceivedAt: ingestions.receivedAt,
          targetPageTitle: pages.title,
          targetPageSlug: pages.slug,
        })
        .from(ingestionDecisions)
        .innerJoin(ingestions, eq(ingestions.id, ingestionDecisions.ingestionId))
        .leftJoin(pages, eq(pages.id, ingestionDecisions.targetPageId))
        .where(
          and(
            decisionBaseWhere,
            eq(ingestionDecisions.status, "auto_applied"),
            gte(ingestionDecisions.createdAt, rollingDayStart),
          ),
        )
        .orderBy(desc(ingestionDecisions.createdAt))
        .limit(DASHBOARD_DECISION_LIMIT),
      fastify.db
        .select()
        .from(folders)
        .where(eq(folders.workspaceId, workspaceId))
        .orderBy(folders.sortOrder, folders.name)
        .limit(DASHBOARD_FOLDER_LIMIT),
      fastify.db
        .select(pageSummarySelect)
        .from(pages)
        .leftJoin(
          pageRevisions,
          eq(pages.currentRevisionId, pageRevisions.id),
        )
        .leftJoin(
          publishedSnapshots,
          and(
            eq(publishedSnapshots.pageId, pages.id),
            eq(publishedSnapshots.isLive, true),
          ),
        )
        .where(and(eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt)))
        .orderBy(desc(pages.updatedAt))
        .limit(DASHBOARD_PAGE_LIMIT),
      fastify.db
        .select({
          parentFolderId: pages.parentFolderId,
          count: sql<number>`count(*)::int`,
        })
        .from(pages)
        .where(
          and(
            eq(pages.workspaceId, workspaceId),
            isNull(pages.deletedAt),
            isNotNull(pages.parentFolderId),
          ),
        )
        .groupBy(pages.parentFolderId),
    ]);

    const decisionCounts = new Map<string, number>(
      DECISION_STATUSES.map((status) => [status, 0]),
    );
    for (const row of decisionCountRows) {
      decisionCounts.set(row.status, row.count);
    }

    const pageDtos = pageRows.map(mapPageDto);
    const folderPageCounts = new Map(
      folderPageCountRows
        .filter((row) => row.parentFolderId !== null)
        .map((row) => [row.parentFolderId!, row.count]),
    );

    const pagesByFolder = new Map<string, typeof pageDtos>();
    for (const page of pageDtos) {
      if (!page.parentFolderId) continue;
      const existing = pagesByFolder.get(page.parentFolderId) ?? [];
      existing.push(page);
      pagesByFolder.set(page.parentFolderId, existing);
    }

    const foldersDto = folderRows.map((folder) => ({
      folder: toFolderDto(folder),
      pageCount: folderPageCounts.get(folder.id) ?? 0,
      pages: (pagesByFolder.get(folder.id) ?? []).slice(0, 8),
    }));

    const rootPages = pageDtos
      .filter((page) => !page.parentFolderId && !page.parentPageId)
      .slice(0, 8);
    const recentAiPages = pageDtos
      .filter((page) => page.latestRevisionActorType === "ai")
      .sort((a, b) =>
        (b.latestRevisionCreatedAt ?? b.updatedAt).localeCompare(
          a.latestRevisionCreatedAt ?? a.updatedAt,
        ),
      )
      .slice(0, 8);

    return reply.send({
      counts: {
        pages: pageCountRow?.count ?? 0,
        folders: folderCountRow?.count ?? 0,
        pendingDecisions:
          (decisionCounts.get("suggested") ?? 0) +
          (decisionCounts.get("needs_review") ?? 0),
        autoAppliedToday: autoAppliedTodayRow?.count ?? 0,
        failedDecisions: decisionCounts.get("failed") ?? 0,
      },
      recentAutoApplied: recentAutoRows.map((row) =>
        mapDecisionListItem(row as DecisionListRow),
      ),
      pendingPreview: pendingRows.map((row) =>
        mapDecisionListItem(row as DecisionListRow),
      ),
      folders: foldersDto,
      rootPages,
      recentAiPages,
    });
  });
};

export default dashboardRoutes;
