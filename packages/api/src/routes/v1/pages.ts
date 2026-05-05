import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import {
  eq,
  and,
  sql,
  desc,
  count,
  inArray,
} from "drizzle-orm";
import { z } from "zod";
import {
  createPageSchema,
  updatePageSchema,
  paginationSchema,
  treePaginationSchema,
  uuidSchema,
  createRevisionSchema,
  rollbackRevisionSchema,
  compareRevisionsQuerySchema,
  graphQuerySchema,
  publishPageSchema,
  aiEditSchema,
  searchQuerySchema,
  PAGE_STATUSES,
  JOB_NAMES,
  QUEUE_NAMES,
  DEFAULT_JOB_OPTIONS,
  ERROR_CODES,
  IMPORT_SOURCE_NAMES,
  computeDiff,
} from "@wekiflow/shared";
import type {
  PublishRendererJobData,
  PageLinkExtractorJobData,
  TripleExtractorJobData,
  SearchIndexUpdaterJobData,
  ContentReformatterJobData,
} from "@wekiflow/shared";
import {
  pages,
  pageRevisions,
  pagePaths,
  auditLogs,
  revisionDiffs,
  publishedSnapshots,
  workspaces,
  ingestions,
  ingestionDecisions,
} from "@wekiflow/db";
import {
  getMemberRole,
  forbidden,
  insufficientRole,
  EDITOR_PLUS_ROLES,
  ADMIN_PLUS_ROLES,
  workspaceParamsSchema,
} from "../../lib/workspace-auth.js";
import {
  sendValidationError,
  isUniqueViolation,
} from "../../lib/reply-helpers.js";
import {
  getNextPageSortOrder,
  loadPageHierarchyRow,
  validateParentPageAssignment,
  validatePageParentExclusive,
} from "../../lib/page-hierarchy.js";
import {
  loadFolderHierarchyRow,
  validateFolderExistsInWorkspace,
} from "../../lib/folder-hierarchy.js";
import {
  reorderPage,
  ReorderFailedError,
  type PageParent,
} from "../../lib/reorder.js";
import {
  collectDescendantPageIds,
  softDeleteSubtree,
  restoreSubtree,
  purgeSubtree,
  PageDeletionError,
  notDeleted,
  sqlUuidList,
} from "../../lib/page-deletion.js";
import { buildEntityGraph } from "../../lib/graph-builder.js";
import { mapPageDto, pageSummarySelect } from "../../lib/page-dto.js";
import {
  RollbackRevisionError,
  rollbackToRevision,
} from "../../lib/rollback-revision.js";

// ---------------------------------------------------------------------------
// Param & query schemas
// ---------------------------------------------------------------------------

const pageParamsSchema = z.object({
  workspaceId: uuidSchema,
  pageId: uuidSchema,
});

const revisionParamsSchema = z.object({
  workspaceId: uuidSchema,
  pageId: uuidSchema,
  revisionId: uuidSchema,
});

const listPagesQuerySchema = treePaginationSchema.extend({
  parentPageId: uuidSchema.optional(),
  parentFolderId: uuidSchema.optional(),
  status: z.enum(PAGE_STATUSES).optional(),
});

const createRevisionBodySchema = createRevisionSchema
  .pick({
    contentMd: true,
    contentJson: true,
    revisionNote: true,
  })
  .extend({ contentMd: z.string().min(1, "contentMd is required") });

// ---------------------------------------------------------------------------
// DTO mappers — never return raw DB rows
// ---------------------------------------------------------------------------

function mapRevisionDto(revision: {
  id: string;
  pageId: string;
  baseRevisionId: string | null;
  actorUserId: string | null;
  modelRunId: string | null;
  actorType: string;
  source: string;
  contentMd: string;
  contentJson: unknown;
  revisionNote: string | null;
  createdAt: Date;
}) {
  return {
    id: revision.id,
    pageId: revision.pageId,
    baseRevisionId: revision.baseRevisionId,
    actorUserId: revision.actorUserId,
    modelRunId: revision.modelRunId,
    actorType: revision.actorType,
    source: revision.source,
    contentMd: revision.contentMd,
    contentJson: revision.contentJson,
    revisionNote: revision.revisionNote,
    createdAt: revision.createdAt.toISOString(),
  };
}

function mapRevisionSummaryDto(revision: {
  id: string;
  pageId: string;
  baseRevisionId: string | null;
  actorUserId: string | null;
  actorType: string;
  source: string;
  revisionNote: string | null;
  createdAt: Date;
  changedBlocks?: number | null;
  sourceIngestionId?: string | null;
  sourceDecisionId?: string | null;
}) {
  return {
    id: revision.id,
    pageId: revision.pageId,
    baseRevisionId: revision.baseRevisionId,
    actorUserId: revision.actorUserId,
    actorType: revision.actorType,
    source: revision.source,
    revisionNote: revision.revisionNote,
    createdAt: revision.createdAt.toISOString(),
    changedBlocks: revision.changedBlocks ?? null,
    sourceIngestionId: revision.sourceIngestionId ?? null,
    sourceDecisionId: revision.sourceDecisionId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle query builder doesn't expose a clean shared interface for db/tx
type AnyDb = any;

/** Verify a page belongs to a workspace. Returns the page row or null.
 * Soft-deleted pages are treated as non-existent from every read path —
 * callers that need a trashed row (e.g. restore) must query directly. */
async function findPageInWorkspace(
  db: AnyDb,
  workspaceId: string,
  pageId: string,
  columns: Record<string, unknown> = { id: pages.id },
) {
  const [row] = await db
    .select(columns)
    .from(pages)
    .where(
      and(
        eq(pages.id, pageId),
        eq(pages.workspaceId, workspaceId),
        notDeleted(),
      ),
    )
    .limit(1);
  return row ?? null;
}

function pageNotFound(reply: FastifyReply) {
  return reply.code(404).send({
    error: "Page not found",
    code: ERROR_CODES.PAGE_NOT_FOUND,
  });
}

/** Fetch base revision content, compute diff, and insert into revisionDiffs. */
async function insertRevisionDiff(
  tx: AnyDb,
  newRevisionId: string,
  baseRevisionId: string,
  newContentMd: string,
  newContentJson: Record<string, unknown> | null,
) {
  const [baseRevision] = await tx
    .select({
      contentMd: pageRevisions.contentMd,
      contentJson: pageRevisions.contentJson,
    })
    .from(pageRevisions)
    .where(eq(pageRevisions.id, baseRevisionId))
    .limit(1);

  if (baseRevision) {
    const diff = computeDiff(
      baseRevision.contentMd,
      newContentMd,
      baseRevision.contentJson as Record<string, unknown> | null,
      newContentJson,
    );
    await tx.insert(revisionDiffs).values({
      revisionId: newRevisionId,
      diffMd: diff.diffMd,
      diffOpsJson: diff.diffOpsJson,
      changedBlocks: diff.changedBlocks,
    });
  }
}

const PUBLISH_SUBTREE_MAX_PAGES = 100;

type PublishScope = "self" | "subtree";

interface PublishIssue {
  pageId: string;
  title: string | null;
  reason: string;
}

interface PublishSnapshotSummary {
  id: string;
  pageId: string;
  versionNo: number;
  publicPath: string;
  title: string;
  isLive: boolean;
  publishedAt: string;
}

interface PublishTargetRow {
  id: string;
  title: string;
  slug: string;
  currentRevisionId: string | null;
  workspaceSlug: string;
}

type PublishTargetResult =
  | {
      status: "published";
      snapshot: PublishSnapshotSummary;
      revisionId: string;
    }
  | { status: "skipped"; issue: PublishIssue }
  | { status: "failed"; issue: PublishIssue };

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function mapPublishSnapshot(snapshot: {
  id: string;
  pageId: string;
  versionNo: number;
  publicPath: string;
  title: string;
  isLive: boolean;
  publishedAt: Date | string;
}): PublishSnapshotSummary {
  return {
    id: snapshot.id,
    pageId: snapshot.pageId,
    versionNo: snapshot.versionNo,
    publicPath: snapshot.publicPath,
    title: snapshot.title,
    isLive: snapshot.isLive,
    publishedAt: toIso(snapshot.publishedAt),
  };
}

async function publishTargetPage(input: {
  db: AnyDb;
  workspaceId: string;
  userId: string;
  page: PublishTargetRow;
  revisionId?: string;
}): Promise<PublishTargetResult> {
  const { db, workspaceId, userId, page } = input;
  const revisionId = input.revisionId ?? page.currentRevisionId;

  if (!revisionId) {
    return {
      status: "skipped",
      issue: { pageId: page.id, title: page.title, reason: "no_revision" },
    };
  }

  const [revision] = await db
    .select({
      id: pageRevisions.id,
      contentMd: pageRevisions.contentMd,
      pageId: pageRevisions.pageId,
    })
    .from(pageRevisions)
    .where(
      and(eq(pageRevisions.id, revisionId), eq(pageRevisions.pageId, page.id)),
    )
    .limit(1);

  if (!revision) {
    return {
      status: "failed",
      issue: {
        pageId: page.id,
        title: page.title,
        reason: "revision_not_found",
      },
    };
  }

  const publicPath = `/docs/${page.workspaceSlug}/${page.slug}`;

  try {
    const snapshot = await db.transaction(async (tx: AnyDb) => {
      const [maxVersion] = await tx
        .select({
          max: sql<number>`coalesce(max(${publishedSnapshots.versionNo}), 0)`,
        })
        .from(publishedSnapshots)
        .where(eq(publishedSnapshots.pageId, page.id));

      const nextVersion = Number(maxVersion.max) + 1;

      await tx
        .update(publishedSnapshots)
        .set({ isLive: false })
        .where(
          and(
            eq(publishedSnapshots.pageId, page.id),
            eq(publishedSnapshots.isLive, true),
          ),
        );

      const [created] = await tx
        .insert(publishedSnapshots)
        .values({
          workspaceId,
          pageId: page.id,
          sourceRevisionId: revisionId,
          publishedByUserId: userId,
          versionNo: nextVersion,
          publicPath,
          title: page.title,
          snapshotMd: revision.contentMd,
          snapshotHtml: "",
          isLive: true,
        })
        .returning();

      await tx.insert(auditLogs).values({
        workspaceId,
        userId,
        entityType: "published_snapshot",
        entityId: created.id,
        action: "publish",
        afterJson: {
          pageId: page.id,
          revisionId,
          versionNo: nextVersion,
          publicPath,
        },
      });

      return created;
    });

    return {
      status: "published",
      snapshot: mapPublishSnapshot(snapshot),
      revisionId,
    };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return {
        status: "failed",
        issue: {
          pageId: page.id,
          title: page.title,
          reason: "publish_conflict",
        },
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const pageRoutes: FastifyPluginAsync = async (fastify) => {
  // All routes in this plugin require authentication
  fastify.addHook("onRequest", fastify.authenticate);

  // -----------------------------------------------------------------------
  // POST / — Create page
  // -----------------------------------------------------------------------
  fastify.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const paramsResult = workspaceParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return sendValidationError(reply, paramsResult.error.issues);
    }
    const { workspaceId } = paramsResult.data;

    const role = await getMemberRole(fastify.db, workspaceId, request.user.sub);
    if (!role) return forbidden(reply);
    if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

    const bodyResult = createPageSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return sendValidationError(reply, bodyResult.error.issues);
    }

    const {
      title,
      slug,
      parentPageId,
      parentFolderId,
      contentMd,
      contentJson,
    } = bodyResult.data;
    const userId = request.user.sub;

    const exclusiveError = validatePageParentExclusive({
      parentPageId,
      parentFolderId,
    });
    if (exclusiveError) {
      return reply.code(exclusiveError.statusCode).send(exclusiveError.body);
    }

    const parentValidation = await validateParentPageAssignment(
      (candidatePageId) => loadPageHierarchyRow(fastify.db, candidatePageId),
      { workspaceId, parentPageId },
    );
    if (parentValidation) {
      return reply
        .code(parentValidation.statusCode)
        .send(parentValidation.body);
    }

    if (parentFolderId) {
      const folderError = await validateFolderExistsInWorkspace(
        (id) => loadFolderHierarchyRow(fastify.db, id),
        workspaceId,
        parentFolderId,
      );
      if (folderError) {
        return reply.code(folderError.statusCode).send(folderError.body);
      }
    }

    try {
      const result = await fastify.db.transaction(async (tx) => {
        const sortOrder = await getNextPageSortOrder(tx, workspaceId, {
          parentPageId: parentPageId ?? null,
          parentFolderId: parentFolderId ?? null,
        });

        const [page] = await tx
          .insert(pages)
          .values({
            workspaceId,
            parentPageId,
            parentFolderId,
            title,
            slug,
            status: "draft",
            sortOrder,
          })
          .returning();

        const [revision] = await tx
          .insert(pageRevisions)
          .values({
            pageId: page.id,
            baseRevisionId: null,
            actorUserId: userId,
            actorType: "user",
            source: "editor",
            contentMd,
            contentJson: contentJson ?? null,
          })
          .returning();

        const [updatedPage] = await tx
          .update(pages)
          .set({
            currentRevisionId: revision.id,
            lastHumanEditedAt: sql`now()`,
          })
          .where(eq(pages.id, page.id))
          .returning();

        await tx.insert(pagePaths).values({
          workspaceId,
          pageId: page.id,
          path: slug,
          isCurrent: true,
        });

        await tx.insert(auditLogs).values({
          workspaceId,
          userId,
          entityType: "page",
          entityId: page.id,
          action: "create",
          afterJson: {
            title,
            slug,
            parentPageId,
            parentFolderId,
            status: "draft",
          },
        });

        return { page: updatedPage, revision };
      });

      const tripleData: TripleExtractorJobData = {
        pageId: result.page.id,
        revisionId: result.revision.id,
        workspaceId,
      };
      await fastify.queues.extraction.add(
        JOB_NAMES.TRIPLE_EXTRACTOR,
        tripleData,
        DEFAULT_JOB_OPTIONS,
      );

      const searchData: SearchIndexUpdaterJobData = {
        pageId: result.page.id,
        revisionId: result.revision.id,
        workspaceId,
      };
      await fastify.queues.search.add(
        JOB_NAMES.SEARCH_INDEX_UPDATER,
        searchData,
        DEFAULT_JOB_OPTIONS,
      );

      const linkData: PageLinkExtractorJobData = {
        pageId: result.page.id,
        revisionId: result.revision.id,
        workspaceId,
      };
      await fastify.queues.links.add(
        JOB_NAMES.PAGE_LINK_EXTRACTOR,
        linkData,
        DEFAULT_JOB_OPTIONS,
      );

      return reply.code(201).send({
        page: mapPageDto({
          ...result.page,
          latestRevisionActorType: result.revision.actorType,
          latestRevisionSource: result.revision.source,
          latestRevisionCreatedAt: result.revision.createdAt,
          latestRevisionSourceIngestionId: result.revision.sourceIngestionId,
          latestRevisionSourceDecisionId: result.revision.sourceDecisionId,
        }),
        revision: mapRevisionDto(result.revision),
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send({
          error: "A page with this slug already exists in this workspace",
          code: ERROR_CODES.SLUG_CONFLICT,
        });
      }
      throw err;
    }
  });

  // -----------------------------------------------------------------------
  // GET / — List pages
  // -----------------------------------------------------------------------
  fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const paramsResult = workspaceParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return sendValidationError(reply, paramsResult.error.issues);
    }
    const { workspaceId } = paramsResult.data;

    const role = await getMemberRole(fastify.db, workspaceId, request.user.sub);
    if (!role) return forbidden(reply);

    const queryResult = listPagesQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return sendValidationError(reply, queryResult.error.issues);
    }

    const { limit, offset, parentPageId, parentFolderId, status } =
      queryResult.data;

    // Build where conditions — active pages only; trash is a separate route
    const conditions = [eq(pages.workspaceId, workspaceId), notDeleted()];
    if (parentPageId) {
      conditions.push(eq(pages.parentPageId, parentPageId));
    }
    if (parentFolderId) {
      conditions.push(eq(pages.parentFolderId, parentFolderId));
    }
    if (status) {
      conditions.push(eq(pages.status, status));
    }
    const whereClause = and(...conditions);

    const [data, [{ total }]] = await Promise.all([
      fastify.db
        .select(pageSummarySelect)
        .from(pages)
        .leftJoin(pageRevisions, eq(pages.currentRevisionId, pageRevisions.id))
        .leftJoin(
          publishedSnapshots,
          and(
            eq(publishedSnapshots.pageId, pages.id),
            eq(publishedSnapshots.isLive, true),
          ),
        )
        .where(whereClause)
        .orderBy(pages.sortOrder, pages.createdAt)
        .limit(limit)
        .offset(offset),
      fastify.db.select({ total: count() }).from(pages).where(whereClause),
    ]);

    return reply.code(200).send({
      data: data.map(mapPageDto),
      total,
    });
  });

  // -----------------------------------------------------------------------
  // GET /:pageId — Get page with current revision
  // -----------------------------------------------------------------------
  fastify.get(
    "/:pageId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = pageParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, pageId } = paramsResult.data;

      const role = await getMemberRole(
        fastify.db,
        workspaceId,
        request.user.sub,
      );
      if (!role) return forbidden(reply);

      const rows = await fastify.db
        .select({
          page: pageSummarySelect,
          revision: {
            id: pageRevisions.id,
            pageId: pageRevisions.pageId,
            baseRevisionId: pageRevisions.baseRevisionId,
            actorUserId: pageRevisions.actorUserId,
            modelRunId: pageRevisions.modelRunId,
            actorType: pageRevisions.actorType,
            source: pageRevisions.source,
            contentMd: pageRevisions.contentMd,
            contentJson: pageRevisions.contentJson,
            revisionNote: pageRevisions.revisionNote,
            createdAt: pageRevisions.createdAt,
          },
        })
        .from(pages)
        .leftJoin(pageRevisions, eq(pages.currentRevisionId, pageRevisions.id))
        .leftJoin(
          publishedSnapshots,
          and(
            eq(publishedSnapshots.pageId, pages.id),
            eq(publishedSnapshots.isLive, true),
          ),
        )
        .where(
          and(
            eq(pages.id, pageId),
            eq(pages.workspaceId, workspaceId),
            notDeleted(),
          ),
        )
        .limit(1);

      if (rows.length === 0) {
        return pageNotFound(reply);
      }

      const { page, revision } = rows[0];

      return reply.code(200).send({
        page: mapPageDto(page),
        currentRevision: revision ? mapRevisionDto(revision) : null,
      });
    },
  );

  // -----------------------------------------------------------------------
  // PATCH /:pageId — Update page metadata
  // -----------------------------------------------------------------------
  fastify.patch(
    "/:pageId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = pageParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, pageId } = paramsResult.data;

      const role = await getMemberRole(
        fastify.db,
        workspaceId,
        request.user.sub,
      );
      if (!role) return forbidden(reply);
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const bodyResult = updatePageSchema.safeParse(request.body);
      if (!bodyResult.success) {
        return sendValidationError(reply, bodyResult.error.issues);
      }

      const body = bodyResult.data;
      if (Object.keys(body).length === 0) {
        return reply.code(400).send({
          error: "No fields to update",
          code: ERROR_CODES.EMPTY_UPDATE,
        });
      }

      // Check page exists (and is not in the trash — PATCH on a deleted
      // page would bypass the soft-delete guarantees)
      const [existing] = await fastify.db
        .select()
        .from(pages)
        .where(
          and(
            eq(pages.id, pageId),
            eq(pages.workspaceId, workspaceId),
            notDeleted(),
          ),
        )
        .limit(1);

      if (!existing) {
        return pageNotFound(reply);
      }

      const userId = request.user.sub;
      const slugChanged =
        body.slug !== undefined && body.slug !== existing.slug;

      // Resolve target parent if either parent field was sent. The DB enforces
      // XOR via a CHECK — validate eagerly so callers get a readable 400.
      const nextParentPageId =
        body.parentPageId !== undefined
          ? body.parentPageId
          : existing.parentPageId;
      const nextParentFolderId =
        body.parentFolderId !== undefined
          ? body.parentFolderId
          : existing.parentFolderId;
      const parentFieldTouched =
        body.parentPageId !== undefined || body.parentFolderId !== undefined;
      const parentChanged =
        parentFieldTouched &&
        (nextParentPageId !== existing.parentPageId ||
          nextParentFolderId !== existing.parentFolderId);

      const exclusiveError = validatePageParentExclusive({
        parentPageId: nextParentPageId,
        parentFolderId: nextParentFolderId,
      });
      if (exclusiveError) {
        return reply.code(exclusiveError.statusCode).send(exclusiveError.body);
      }

      if (body.parentPageId !== undefined) {
        const parentValidation = await validateParentPageAssignment(
          (candidatePageId) =>
            loadPageHierarchyRow(fastify.db, candidatePageId),
          {
            workspaceId,
            pageId,
            parentPageId: nextParentPageId,
          },
        );
        if (parentValidation) {
          return reply
            .code(parentValidation.statusCode)
            .send(parentValidation.body);
        }
      }

      if (body.parentFolderId !== undefined && nextParentFolderId) {
        const folderError = await validateFolderExistsInWorkspace(
          (id) => loadFolderHierarchyRow(fastify.db, id),
          workspaceId,
          nextParentFolderId,
        );
        if (folderError) {
          return reply.code(folderError.statusCode).send(folderError.body);
        }
      }

      try {
        const result = await fastify.db.transaction(async (tx) => {
          // First, apply non-parent, non-reorder metadata (title/slug/status).
          // Parent + sortOrder are handled either by reorderPage() below or by
          // a simple "append to end" fallback when only parent changed.
          const metadataPatch: Record<string, unknown> = {
            updatedAt: sql`now()`,
          };
          if (body.title !== undefined) metadataPatch.title = body.title;
          if (body.slug !== undefined) metadataPatch.slug = body.slug;
          if (body.status !== undefined) metadataPatch.status = body.status;

          if (Object.keys(metadataPatch).length > 1) {
            await tx
              .update(pages)
              .set(metadataPatch)
              .where(eq(pages.id, pageId));
          }

          if (body.reorderIntent) {
            const parent: PageParent = nextParentFolderId
              ? { kind: "folder", folderId: nextParentFolderId }
              : nextParentPageId
                ? { kind: "page", pageId: nextParentPageId }
                : { kind: "root" };
            const reorderError = await reorderPage(tx, {
              workspaceId,
              movingId: pageId,
              parent,
              intent: body.reorderIntent,
            });
            if (reorderError) throw new ReorderFailedError(reorderError);
          } else if (parentChanged) {
            // Parent changed but no explicit reorder — append to end of new
            // parent, same behaviour as before parentFolderId existed.
            const nextSortOrder = await getNextPageSortOrder(tx, workspaceId, {
              parentPageId: nextParentPageId,
              parentFolderId: nextParentFolderId,
            });
            await tx
              .update(pages)
              .set({
                parentPageId: nextParentPageId,
                parentFolderId: nextParentFolderId,
                sortOrder: nextSortOrder,
                updatedAt: sql`now()`,
              })
              .where(eq(pages.id, pageId));
          } else if (body.sortOrder !== undefined) {
            await tx
              .update(pages)
              .set({ sortOrder: body.sortOrder, updatedAt: sql`now()` })
              .where(eq(pages.id, pageId));
          }

          if (slugChanged) {
            await tx
              .update(pagePaths)
              .set({ isCurrent: false })
              .where(
                and(
                  eq(pagePaths.pageId, pageId),
                  eq(pagePaths.isCurrent, true),
                ),
              );

            await tx.insert(pagePaths).values({
              workspaceId,
              pageId,
              path: body.slug!,
              isCurrent: true,
            });
          }

          await tx.insert(auditLogs).values({
            workspaceId,
            userId,
            entityType: "page",
            entityId: pageId,
            action: "update",
            beforeJson: {
              title: existing.title,
              slug: existing.slug,
              parentPageId: existing.parentPageId,
              parentFolderId: existing.parentFolderId,
              status: existing.status,
              sortOrder: existing.sortOrder,
            },
            afterJson: body,
          });

          const [updatedPage] = await tx
            .select()
            .from(pages)
            .where(eq(pages.id, pageId))
            .limit(1);
          return updatedPage;
        });

        if (!result) {
          return reply.code(404).send({
            error: "Page not found",
            code: ERROR_CODES.PAGE_NOT_FOUND,
          });
        }

        // Move-time re-extraction. The page now lives under a different
        // parent — the worker re-derives the destination at run time and
        // reconciles fresh entities against the new vocabulary. We pass a
        // unique jobId per move so back-to-back moves don't collapse into
        // one BullMQ entry; the supersede logic in triple-extractor's tx
        // serializes overlapping runs safely.
        if (parentChanged && existing.currentRevisionId) {
          const useReconciliation = body.useReconciliation ?? true;
          await fastify.queues.extraction.add(
            JOB_NAMES.TRIPLE_EXTRACTOR,
            {
              workspaceId,
              pageId,
              revisionId: existing.currentRevisionId,
              useReconciliation,
            },
            {
              jobId: `move:${pageId}:${Date.now()}`,
              ...DEFAULT_JOB_OPTIONS,
            },
          );
          await fastify.db.insert(auditLogs).values({
            workspaceId,
            userId,
            entityType: "page",
            entityId: pageId,
            action: "reextract_enqueued",
            afterJson: {
              reason: "parent_changed",
              useReconciliation,
              previousParentPageId: existing.parentPageId,
              previousParentFolderId: existing.parentFolderId,
            },
          });
        }

        const [summaryPage] = await fastify.db
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
          .where(eq(pages.id, result.id))
          .limit(1);

        return reply
          .code(200)
          .send({ page: mapPageDto(summaryPage ?? result) });
      } catch (err: unknown) {
        if (err instanceof ReorderFailedError) {
          return reply.code(err.detail.statusCode).send(err.detail.body);
        }
        if (isUniqueViolation(err)) {
          return reply.code(409).send({
            error: "A page with this slug already exists in this workspace",
            code: ERROR_CODES.SLUG_CONFLICT,
          });
        }
        throw err;
      }
    },
  );

  // -----------------------------------------------------------------------
  // POST /:pageId/revisions — Create new revision (save content)
  // -----------------------------------------------------------------------
  fastify.post(
    "/:pageId/revisions",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = pageParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, pageId } = paramsResult.data;

      const role = await getMemberRole(
        fastify.db,
        workspaceId,
        request.user.sub,
      );
      if (!role) return forbidden(reply);
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const bodyResult = createRevisionBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        return sendValidationError(reply, bodyResult.error.issues);
      }

      const { contentMd, contentJson, revisionNote } = bodyResult.data;
      const userId = request.user.sub;

      const page = await findPageInWorkspace(fastify.db, workspaceId, pageId, {
        id: pages.id,
        currentRevisionId: pages.currentRevisionId,
      });
      if (!page) return pageNotFound(reply);

      const result = await fastify.db.transaction(async (tx) => {
        const [revision] = await tx
          .insert(pageRevisions)
          .values({
            pageId,
            baseRevisionId: page.currentRevisionId,
            actorUserId: userId,
            actorType: "user",
            source: "editor",
            contentMd,
            contentJson: contentJson ?? null,
            revisionNote: revisionNote ?? null,
          })
          .returning();

        if (page.currentRevisionId) {
          await insertRevisionDiff(
            tx,
            revision.id,
            page.currentRevisionId,
            contentMd,
            contentJson ?? null,
          );
        }

        await tx
          .update(pages)
          .set({
            currentRevisionId: revision.id,
            updatedAt: sql`now()`,
            lastHumanEditedAt: sql`now()`,
          })
          .where(eq(pages.id, pageId));

        await tx.insert(auditLogs).values({
          workspaceId,
          userId,
          entityType: "page_revision",
          entityId: revision.id,
          action: "create",
          afterJson: {
            pageId,
            baseRevisionId: page.currentRevisionId,
            revisionNote: revisionNote ?? null,
          },
        });

        return revision;
      });

      const tripleData: TripleExtractorJobData = {
        pageId,
        revisionId: result.id,
        workspaceId,
      };
      await fastify.queues.extraction.add(
        JOB_NAMES.TRIPLE_EXTRACTOR,
        tripleData,
        DEFAULT_JOB_OPTIONS,
      );

      const searchData: SearchIndexUpdaterJobData = {
        pageId,
        revisionId: result.id,
        workspaceId,
      };
      await fastify.queues.search.add(
        JOB_NAMES.SEARCH_INDEX_UPDATER,
        searchData,
        DEFAULT_JOB_OPTIONS,
      );

      await fastify.queues.links.add(
        JOB_NAMES.PAGE_LINK_EXTRACTOR,
        {
          pageId,
          revisionId: result.id,
          workspaceId,
        },
        DEFAULT_JOB_OPTIONS,
      );

      return reply.code(201).send({
        revision: mapRevisionDto(result),
      });
    },
  );

  // -----------------------------------------------------------------------
  // GET /:pageId/revisions — List revisions
  // -----------------------------------------------------------------------
  fastify.get(
    "/:pageId/revisions",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = pageParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, pageId } = paramsResult.data;

      const role = await getMemberRole(
        fastify.db,
        workspaceId,
        request.user.sub,
      );
      if (!role) return forbidden(reply);

      const queryResult = paginationSchema.safeParse(request.query);
      if (!queryResult.success) {
        return sendValidationError(reply, queryResult.error.issues);
      }

      const { limit, offset } = queryResult.data;

      const page = await findPageInWorkspace(fastify.db, workspaceId, pageId);
      if (!page) return pageNotFound(reply);

      const [data, [{ total }]] = await Promise.all([
        fastify.db
          .select({
            id: pageRevisions.id,
            pageId: pageRevisions.pageId,
            baseRevisionId: pageRevisions.baseRevisionId,
            actorUserId: pageRevisions.actorUserId,
            actorType: pageRevisions.actorType,
            source: pageRevisions.source,
            revisionNote: pageRevisions.revisionNote,
            createdAt: pageRevisions.createdAt,
            changedBlocks: revisionDiffs.changedBlocks,
            sourceIngestionId: pageRevisions.sourceIngestionId,
            sourceDecisionId: pageRevisions.sourceDecisionId,
          })
          .from(pageRevisions)
          .leftJoin(
            revisionDiffs,
            eq(pageRevisions.id, revisionDiffs.revisionId),
          )
          .where(eq(pageRevisions.pageId, pageId))
          .orderBy(desc(pageRevisions.createdAt))
          .limit(limit)
          .offset(offset),
        fastify.db
          .select({ total: count() })
          .from(pageRevisions)
          .where(eq(pageRevisions.pageId, pageId)),
      ]);

      return reply.code(200).send({
        data: data.map(mapRevisionSummaryDto),
        total,
      });
    },
  );

  // -----------------------------------------------------------------------
  // GET /:pageId/revisions/compare — Compare two revisions on-the-fly
  // -----------------------------------------------------------------------
  // Must be registered BEFORE /:revisionId to avoid "compare" matching as a UUID
  fastify.get(
    "/:pageId/revisions/compare",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = pageParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, pageId } = paramsResult.data;

      const role = await getMemberRole(
        fastify.db,
        workspaceId,
        request.user.sub,
      );
      if (!role) return forbidden(reply);

      const queryResult = compareRevisionsQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        return sendValidationError(reply, queryResult.error.issues);
      }
      const { from, to } = queryResult.data;

      const page = await findPageInWorkspace(fastify.db, workspaceId, pageId);
      if (!page) return pageNotFound(reply);

      // Fetch both revisions
      const [fromRevision, toRevision] = await Promise.all([
        fastify.db
          .select({
            id: pageRevisions.id,
            contentMd: pageRevisions.contentMd,
            contentJson: pageRevisions.contentJson,
          })
          .from(pageRevisions)
          .where(
            and(eq(pageRevisions.id, from), eq(pageRevisions.pageId, pageId)),
          )
          .limit(1)
          .then((r) => r[0]),
        fastify.db
          .select({
            id: pageRevisions.id,
            contentMd: pageRevisions.contentMd,
            contentJson: pageRevisions.contentJson,
          })
          .from(pageRevisions)
          .where(
            and(eq(pageRevisions.id, to), eq(pageRevisions.pageId, pageId)),
          )
          .limit(1)
          .then((r) => r[0]),
      ]);

      if (!fromRevision || !toRevision) {
        return reply.code(404).send({
          error: "One or both revisions not found",
          code: ERROR_CODES.REVISION_NOT_FOUND,
        });
      }

      const diff = computeDiff(
        fromRevision.contentMd,
        toRevision.contentMd,
        fromRevision.contentJson as Record<string, unknown> | null,
        toRevision.contentJson as Record<string, unknown> | null,
      );

      return reply.code(200).send({
        from,
        to,
        diffMd: diff.diffMd,
        diffOpsJson: diff.diffOpsJson,
        changedBlocks: diff.changedBlocks,
      });
    },
  );

  // -----------------------------------------------------------------------
  // GET /:pageId/revisions/:revisionId — Get single revision
  // -----------------------------------------------------------------------
  fastify.get(
    "/:pageId/revisions/:revisionId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = revisionParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, pageId, revisionId } = paramsResult.data;

      const role = await getMemberRole(
        fastify.db,
        workspaceId,
        request.user.sub,
      );
      if (!role) return forbidden(reply);

      const page = await findPageInWorkspace(fastify.db, workspaceId, pageId);
      if (!page) return pageNotFound(reply);

      const [revision] = await fastify.db
        .select()
        .from(pageRevisions)
        .where(
          and(
            eq(pageRevisions.id, revisionId),
            eq(pageRevisions.pageId, pageId),
          ),
        )
        .limit(1);

      if (!revision) {
        return reply.code(404).send({
          error: "Revision not found",
          code: ERROR_CODES.REVISION_NOT_FOUND,
        });
      }

      return reply.code(200).send({
        revision: mapRevisionDto(revision),
      });
    },
  );

  // -----------------------------------------------------------------------
  // GET /:pageId/revisions/:revisionId/diff — Get stored diff
  // -----------------------------------------------------------------------
  fastify.get(
    "/:pageId/revisions/:revisionId/diff",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = revisionParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, pageId, revisionId } = paramsResult.data;

      const role = await getMemberRole(
        fastify.db,
        workspaceId,
        request.user.sub,
      );
      if (!role) return forbidden(reply);

      const page = await findPageInWorkspace(fastify.db, workspaceId, pageId);
      if (!page) return pageNotFound(reply);

      // Verify revision belongs to page and fetch diff
      const rows = await fastify.db
        .select({
          revisionId: revisionDiffs.revisionId,
          diffMd: revisionDiffs.diffMd,
          diffOpsJson: revisionDiffs.diffOpsJson,
          changedBlocks: revisionDiffs.changedBlocks,
        })
        .from(revisionDiffs)
        .innerJoin(
          pageRevisions,
          eq(revisionDiffs.revisionId, pageRevisions.id),
        )
        .where(
          and(
            eq(revisionDiffs.revisionId, revisionId),
            eq(pageRevisions.pageId, pageId),
          ),
        )
        .limit(1);

      if (rows.length === 0) {
        return reply.code(404).send({
          error: "Diff not found (may be the initial revision)",
          code: ERROR_CODES.DIFF_NOT_FOUND,
        });
      }

      return reply.code(200).send({ diff: rows[0] });
    },
  );

  // -----------------------------------------------------------------------
  // POST /:pageId/revisions/:revisionId/rollback — Rollback to a revision
  // -----------------------------------------------------------------------
  fastify.post(
    "/:pageId/revisions/:revisionId/rollback",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = revisionParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, pageId, revisionId } = paramsResult.data;

      const role = await getMemberRole(
        fastify.db,
        workspaceId,
        request.user.sub,
      );
      if (!role) return forbidden(reply);
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const bodyResult = rollbackRevisionSchema.safeParse(request.body ?? {});
      if (!bodyResult.success) {
        return sendValidationError(reply, bodyResult.error.issues);
      }
      const { revisionNote } = bodyResult.data;
      const userId = request.user.sub;

      let result;
      try {
        result = await rollbackToRevision({
          db: fastify.db,
          workspaceId,
          pageId,
          revisionId,
          actorUserId: userId,
          actorType: "user",
          source: "rollback",
          revisionNote,
        });
      } catch (err: unknown) {
        if (
          err instanceof RollbackRevisionError &&
          err.code === "revision_not_found"
        ) {
          return reply.code(404).send({
            error: "Revision not found",
            code: ERROR_CODES.REVISION_NOT_FOUND,
          });
        }
        if (
          err instanceof RollbackRevisionError &&
          err.code === "page_not_found"
        ) {
          return pageNotFound(reply);
        }
        throw err;
      }

      const tripleData: TripleExtractorJobData = {
        pageId,
        revisionId: result.newRevisionId,
        workspaceId,
      };
      await fastify.queues.extraction.add(
        JOB_NAMES.TRIPLE_EXTRACTOR,
        tripleData,
        DEFAULT_JOB_OPTIONS,
      );

      const searchData: SearchIndexUpdaterJobData = {
        pageId,
        revisionId: result.newRevisionId,
        workspaceId,
      };
      await fastify.queues.search.add(
        JOB_NAMES.SEARCH_INDEX_UPDATER,
        searchData,
        DEFAULT_JOB_OPTIONS,
      );

      await fastify.queues.links.add(
        JOB_NAMES.PAGE_LINK_EXTRACTOR,
        {
          pageId,
          revisionId: result.newRevisionId,
          workspaceId,
        },
        DEFAULT_JOB_OPTIONS,
      );

      return reply.code(201).send({
        revision: mapRevisionDto(result.revision),
      });
    },
  );

  // -----------------------------------------------------------------------
  // DELETE /:pageId — Soft-delete (send page + subtree to the trash).
  // The subtree is moved atomically, triples transition to status
  // 'page_deleted', and the page's live publish snapshot must be revoked
  // first (409 PUBLISHED_BLOCK signals the UI to surface "unpublish then
  // delete"). Permanent removal happens via /purge or the trash-purger
  // worker after the retention window.
  // -----------------------------------------------------------------------
  fastify.delete(
    "/:pageId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = pageParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, pageId } = paramsResult.data;

      const role = await getMemberRole(
        fastify.db,
        workspaceId,
        request.user.sub,
      );
      if (!role) return forbidden(reply);
      if (!ADMIN_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      try {
        const result = await softDeleteSubtree(fastify.db, {
          workspaceId,
          rootPageId: pageId,
          userId: request.user.sub,
        });
        return reply.code(200).send({
          deletedPageIds: result.deletedPageIds,
          deletedCount: result.deletedPageIds.length,
          rootTitle: result.rootTitle,
        });
      } catch (err) {
        if (err instanceof PageDeletionError) {
          if (err.code === ERROR_CODES.PAGE_NOT_FOUND)
            return pageNotFound(reply);
          if (err.code === ERROR_CODES.PUBLISHED_BLOCK) {
            return reply.code(409).send({
              error:
                "Page has a live published snapshot. Unpublish it before deleting.",
              code: ERROR_CODES.PUBLISHED_BLOCK,
              details: err.details,
            });
          }
        }
        throw err;
      }
    },
  );

  // -----------------------------------------------------------------------
  // POST /:pageId/unpublish — Revoke the live snapshot for a page.
  // Preserves the historical snapshot rows (required by the immutability
  // invariant); only flips is_live = false so the public URL stops
  // resolving. Needed as a pre-step before deleting a published page.
  // -----------------------------------------------------------------------
  fastify.post(
    "/:pageId/unpublish",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = pageParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, pageId } = paramsResult.data;

      const role = await getMemberRole(
        fastify.db,
        workspaceId,
        request.user.sub,
      );
      if (!role) return forbidden(reply);
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const page = await findPageInWorkspace(fastify.db, workspaceId, pageId);
      if (!page) return pageNotFound(reply);

      const result = await fastify.db.transaction(async (tx) => {
        const liveRows = await tx
          .update(publishedSnapshots)
          .set({ isLive: false })
          .where(
            and(
              eq(publishedSnapshots.pageId, pageId),
              eq(publishedSnapshots.isLive, true),
            ),
          )
          .returning({ id: publishedSnapshots.id });

        await tx
          .update(pages)
          .set({
            latestPublishedSnapshotId: null,
            status: sql`CASE WHEN ${pages.status} = 'archived' THEN 'archived' ELSE 'draft' END`,
            updatedAt: sql`now()`,
          })
          .where(eq(pages.id, pageId));

        await tx.insert(auditLogs).values({
          workspaceId,
          userId: request.user.sub,
          entityType: "page",
          entityId: pageId,
          action: "unpublish",
          beforeJson: {
            unpublishedSnapshotIds: liveRows.map((r) => r.id),
          },
        });

        return { unpublishedCount: liveRows.length };
      });

      return reply.code(200).send(result);
    },
  );

  // -----------------------------------------------------------------------
  // GET /trash — List soft-deleted pages for the workspace.
  // Returns the trashed root pages with descendant counts so the UI can
  // warn how many children come back on restore.
  // -----------------------------------------------------------------------
  fastify.get(
    "/trash",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = workspaceParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId } = paramsResult.data;

      const role = await getMemberRole(
        fastify.db,
        workspaceId,
        request.user.sub,
      );
      if (!role) return forbidden(reply);

      const rows = await fastify.db.execute(sql`
        WITH RECURSIVE trashed AS (
          SELECT p."id", p."title", p."slug", p."parent_page_id",
                 p."deleted_at", p."deleted_by_user_id"
          FROM "pages" p
          WHERE p."workspace_id" = ${workspaceId}
            AND p."deleted_at" IS NOT NULL
            AND (
              p."parent_page_id" IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM "pages" parent
                WHERE parent."id" = p."parent_page_id"
                  AND parent."deleted_at" IS NOT NULL
              )
            )
        ),
        subtree AS (
          SELECT t."id" AS root_id, t."id" AS node_id
          FROM trashed t
          UNION ALL
          SELECT s."root_id", p."id"
          FROM subtree s
          INNER JOIN "pages" p ON p."parent_page_id" = s."node_id"
          WHERE p."workspace_id" = ${workspaceId}
            AND p."deleted_at" IS NOT NULL
        )
        SELECT t."id", t."title", t."slug", t."deleted_at" AS "deletedAt",
               t."deleted_by_user_id" AS "deletedByUserId",
               u."name" AS "deletedByUserName",
               (SELECT COUNT(*) FROM subtree s WHERE s."root_id" = t."id") - 1
                 AS "descendantCount"
        FROM trashed t
        LEFT JOIN "users" u ON u."id" = t."deleted_by_user_id"
        ORDER BY t."deleted_at" DESC
      `);

      const arr =
        (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ??
        (rows as unknown as Array<Record<string, unknown>>);
      const data = (Array.isArray(arr) ? arr : []).map((row) => ({
        id: row.id as string,
        title: row.title as string,
        slug: row.slug as string,
        deletedAt: row.deletedAt
          ? new Date(row.deletedAt as string).toISOString()
          : null,
        deletedByUserId: (row.deletedByUserId as string | null) ?? null,
        deletedByUserName: (row.deletedByUserName as string | null) ?? null,
        descendantCount: Number(row.descendantCount ?? 0),
      }));

      return reply.code(200).send({ data, total: data.length });
    },
  );

  // -----------------------------------------------------------------------
  // POST /:pageId/restore — Lift a page (and its trashed descendants)
  // back out of the trash. Detaches from a parent that's still trashed.
  // -----------------------------------------------------------------------
  fastify.post(
    "/:pageId/restore",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = pageParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, pageId } = paramsResult.data;

      const role = await getMemberRole(
        fastify.db,
        workspaceId,
        request.user.sub,
      );
      if (!role) return forbidden(reply);
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      try {
        const result = await restoreSubtree(fastify.db, {
          workspaceId,
          rootPageId: pageId,
          userId: request.user.sub,
        });

        // Re-index restored pages so FTS sees them again. Rebuild inline
        // rather than enqueuing — the search-index-updater job requires a
        // specific revisionId, and we already know the current revision
        // per page is the right one.
        if (result.restoredPageIds.length > 0) {
          await fastify.db.execute(sql`
            UPDATE "pages" p
            SET "search_vector" = to_tsvector(
              'simple',
              coalesce(p."title", '') || ' ' || coalesce(r."content_md", '')
            )
            FROM "page_revisions" r
            WHERE p."id" IN (${sqlUuidList(result.restoredPageIds)})
              AND r."id" = p."current_revision_id"
          `);
        }

        return reply.code(200).send({
          restoredPageIds: result.restoredPageIds,
          restoredCount: result.restoredPageIds.length,
          rootTitle: result.rootTitle,
        });
      } catch (err) {
        if (err instanceof PageDeletionError) {
          if (err.code === ERROR_CODES.PAGE_NOT_FOUND)
            return pageNotFound(reply);
          if (err.code === ERROR_CODES.SLUG_CONFLICT) {
            return reply.code(409).send({
              error:
                "Another page already uses this slug or path. Rename it first.",
              code: ERROR_CODES.SLUG_CONFLICT,
              details: err.details,
            });
          }
        }
        throw err;
      }
    },
  );

  // -----------------------------------------------------------------------
  // DELETE /:pageId/purge — Permanently delete a trashed page and its
  // soft-deleted descendants. Orphan entities are cleaned up after the
  // subtree is gone. Admins only.
  // -----------------------------------------------------------------------
  fastify.delete(
    "/:pageId/purge",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = pageParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, pageId } = paramsResult.data;

      const role = await getMemberRole(
        fastify.db,
        workspaceId,
        request.user.sub,
      );
      if (!role) return forbidden(reply);
      if (!ADMIN_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      try {
        const result = await purgeSubtree(fastify.db, {
          workspaceId,
          rootPageId: pageId,
          userId: request.user.sub,
        });
        return reply.code(200).send({
          purgedPageIds: result.purgedPageIds,
          purgedCount: result.purgedPageIds.length,
        });
      } catch (err) {
        if (err instanceof PageDeletionError) {
          if (err.code === ERROR_CODES.PAGE_NOT_FOUND)
            return pageNotFound(reply);
          if (err.code === ERROR_CODES.PAGE_NOT_TRASHED) {
            return reply.code(400).send({
              error: "Page is not in the trash. Soft-delete it before purging.",
              code: err.code,
            });
          }
        }
        throw err;
      }
    },
  );

  // -----------------------------------------------------------------------
  // POST /:pageId/publish — Publish a page revision as an immutable snapshot
  // -----------------------------------------------------------------------
  fastify.post(
    "/:pageId/publish",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = pageParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, pageId } = paramsResult.data;

      const role = await getMemberRole(
        fastify.db,
        workspaceId,
        request.user.sub,
      );
      if (!role) return forbidden(reply);
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const bodyResult = publishPageSchema.safeParse(request.body ?? {});
      if (!bodyResult.success) {
        return sendValidationError(reply, bodyResult.error.issues);
      }

      const scope: PublishScope =
        bodyResult.data.scope === "subtree" ||
        bodyResult.data.includeDescendants === true
          ? "subtree"
          : "self";

      const [pageRow] = await fastify.db
        .select({
          id: pages.id,
          title: pages.title,
          slug: pages.slug,
          currentRevisionId: pages.currentRevisionId,
          workspaceSlug: workspaces.slug,
        })
        .from(pages)
        .innerJoin(workspaces, eq(pages.workspaceId, workspaces.id))
        .where(
          and(
            eq(pages.id, pageId),
            eq(pages.workspaceId, workspaceId),
            notDeleted(),
          ),
        )
        .limit(1);

      if (!pageRow) return pageNotFound(reply);

      const revisionId =
        bodyResult.data.revisionId ?? pageRow.currentRevisionId;
      if (!revisionId) {
        return reply.code(400).send({
          error: "No revision to publish — page has no content",
          code: ERROR_CODES.NO_REVISION,
        });
      }

      const [rootRevision] = await fastify.db
        .select({ id: pageRevisions.id })
        .from(pageRevisions)
        .where(
          and(
            eq(pageRevisions.id, revisionId),
            eq(pageRevisions.pageId, pageId),
          ),
        )
        .limit(1);

      if (!rootRevision) {
        return reply.code(404).send({
          error: "Revision not found",
          code: ERROR_CODES.REVISION_NOT_FOUND,
        });
      }

      const userId = request.user.sub;

      if (scope === "self") {
        const result = await publishTargetPage({
          db: fastify.db,
          workspaceId,
          userId,
          page: pageRow,
          revisionId,
        });

        if (result.status === "skipped") {
          return reply.code(400).send({
            error: "No revision to publish — page has no content",
            code: ERROR_CODES.NO_REVISION,
          });
        }

        if (result.status === "failed") {
          if (result.issue.reason === "publish_conflict") {
            return reply.code(409).send({
              error: "A live snapshot already exists (concurrent publish)",
              code: ERROR_CODES.PUBLISH_CONFLICT,
            });
          }
          return reply.code(404).send({
            error: "Revision not found",
            code: ERROR_CODES.REVISION_NOT_FOUND,
          });
        }

        await fastify.queues.publish.add(
          JOB_NAMES.PUBLISH_RENDERER,
          {
            snapshotId: result.snapshot.id,
            pageId,
            revisionId: result.revisionId,
            workspaceId,
          } satisfies PublishRendererJobData,
          DEFAULT_JOB_OPTIONS,
        );

        return reply.code(202).send({
          snapshot: result.snapshot,
          snapshots: [result.snapshot],
          scope,
          total: 1,
          publishedCount: 1,
          skippedCount: 0,
          failedCount: 0,
          skipped: [],
          failed: [],
        });
      }

      // collectDescendantPageIds intentionally returns the root page first;
      // subtree publishing means "this page plus active descendants".
      const subtreeIds = await collectDescendantPageIds(
        fastify.db,
        workspaceId,
        pageId,
      );

      if (subtreeIds.length > PUBLISH_SUBTREE_MAX_PAGES) {
        return reply.code(422).send({
          error: `Cannot publish more than ${PUBLISH_SUBTREE_MAX_PAGES} pages at once`,
          code: ERROR_CODES.PUBLISH_SCOPE_TOO_LARGE,
          details: {
            limit: PUBLISH_SUBTREE_MAX_PAGES,
            requestedCount: subtreeIds.length,
          },
        });
      }

      const subtreeRows = await fastify.db
        .select({
          id: pages.id,
          title: pages.title,
          slug: pages.slug,
          currentRevisionId: pages.currentRevisionId,
          workspaceSlug: workspaces.slug,
        })
        .from(pages)
        .innerJoin(workspaces, eq(pages.workspaceId, workspaces.id))
        .where(
          and(
            eq(pages.workspaceId, workspaceId),
            inArray(pages.id, subtreeIds),
            notDeleted(),
          ),
        );
      const rowsById = new Map(subtreeRows.map((row) => [row.id, row]));
      const targets = subtreeIds
        .map((id) => rowsById.get(id))
        .filter((row): row is PublishTargetRow => Boolean(row));

      const snapshots: PublishSnapshotSummary[] = [];
      const skipped: PublishIssue[] = [];
      const failed: PublishIssue[] = [];
      const publishedJobs: Array<{
        snapshot: PublishSnapshotSummary;
        revisionId: string;
      }> = [];

      for (const target of targets) {
        const result = await publishTargetPage({
          db: fastify.db,
          workspaceId,
          userId,
          page: target,
          revisionId: target.id === pageId ? revisionId : undefined,
        });

        if (result.status === "published") {
          snapshots.push(result.snapshot);
          publishedJobs.push({
            snapshot: result.snapshot,
            revisionId: result.revisionId,
          });
        } else if (result.status === "skipped") {
          skipped.push(result.issue);
        } else {
          failed.push(result.issue);
        }
      }

      for (const item of publishedJobs) {
        await fastify.queues.publish.add(
          JOB_NAMES.PUBLISH_RENDERER,
          {
            snapshotId: item.snapshot.id,
            pageId: item.snapshot.pageId,
            revisionId: item.revisionId,
            workspaceId,
          } satisfies PublishRendererJobData,
          DEFAULT_JOB_OPTIONS,
        );
      }

      return reply.code(202).send({
        snapshot: snapshots[0] ?? null,
        snapshots,
        scope,
        total: targets.length,
        publishedCount: snapshots.length,
        skippedCount: skipped.length,
        failedCount: failed.length,
        skipped,
        failed,
      });
    },
  );

  // -----------------------------------------------------------------------
  // GET /:pageId/graph — Knowledge graph for a page
  // -----------------------------------------------------------------------
  fastify.get(
    "/:pageId/graph",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = pageParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, pageId } = paramsResult.data;

      const role = await getMemberRole(
        fastify.db,
        workspaceId,
        request.user.sub,
      );
      if (!role) return forbidden(reply);

      const queryResult = graphQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        return sendValidationError(reply, queryResult.error.issues);
      }
      const { depth, limit, minConfidence, locale } = queryResult.data;

      // Verify page belongs to workspace
      const page = await findPageInWorkspace(fastify.db, workspaceId, pageId);
      if (!page) return pageNotFound(reply);

      const graph = await buildEntityGraph(fastify.db, {
        workspaceId,
        seedPageIds: [pageId],
        depth: depth as 1 | 2,
        limit,
        minConfidence,
        locale,
        restrictToSeedScope: false,
      });

      return reply.code(200).send({
        nodes: graph.nodes,
        edges: graph.edges,
        meta: {
          scope: "page",
          pageId,
          depth,
          totalNodes: graph.nodes.length,
          totalEdges: graph.edges.length,
          truncated: graph.truncated,
        },
      });
    },
  );

  // -----------------------------------------------------------------------
  // POST /:pageId/ai-edit — AI-assisted streaming edit (SSE)
  // -----------------------------------------------------------------------
  fastify.post(
    "/:pageId/ai-edit",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = pageParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, pageId } = paramsResult.data;

      const role = await getMemberRole(
        fastify.db,
        workspaceId,
        request.user.sub,
      );
      if (!role) return forbidden(reply);
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const bodyResult = aiEditSchema.safeParse(request.body);
      if (!bodyResult.success) {
        return sendValidationError(reply, bodyResult.error.issues);
      }
      const { mode, instruction, selection } = bodyResult.data;

      const [pageRow] = await fastify.db
        .select({ id: pages.id, currentRevisionId: pages.currentRevisionId })
        .from(pages)
        .where(
          and(
            eq(pages.id, pageId),
            eq(pages.workspaceId, workspaceId),
            notDeleted(),
          ),
        )
        .limit(1);

      if (!pageRow) return pageNotFound(reply);
      if (!pageRow.currentRevisionId) {
        return reply.code(400).send({
          error: "No revision to edit — page has no content",
          code: ERROR_CODES.NO_REVISION,
        });
      }

      const [revision] = await fastify.db
        .select({ contentMd: pageRevisions.contentMd })
        .from(pageRevisions)
        .where(eq(pageRevisions.id, pageRow.currentRevisionId))
        .limit(1);

      if (!revision) return pageNotFound(reply);

      const contextMd = selection?.text ?? revision.contentMd;

      // Build the prompt
      const modeInstructions: Record<string, string> = {
        "selection-rewrite":
          "Rewrite the provided text based on the instruction. Return only the rewritten content, no commentary.",
        "section-expand":
          "Expand the provided text with more detail. Return only the expanded content.",
        summarize:
          "Summarize the provided text concisely. Return only the summary.",
        "tone-formal":
          "Rewrite the provided text in a formal, professional tone. Return only the rewritten text.",
        "tone-casual":
          "Rewrite the provided text in a casual, friendly tone. Return only the rewritten text.",
        "extract-action-items":
          "Extract all action items from the provided text as a markdown task list. Return only the task list.",
      };

      const systemPrompt =
        modeInstructions[mode] ?? "Edit the text based on the instruction.";

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const sendEvent = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        const adapter = (
          fastify as unknown as {
            aiAdapter?: {
              streamChat?: (req: unknown) => AsyncIterable<string>;
            };
          }
        ).aiAdapter;
        if (!adapter?.streamChat) {
          // Fallback: non-streaming single-shot response via the queue's AI gateway
          sendEvent("error", {
            message: "Streaming not available — submit via ingest API",
          });
          reply.raw.end();
          return;
        }

        sendEvent("start", {
          mode,
          pageId,
          baseRevisionId: pageRow.currentRevisionId,
        });

        let accumulated = "";
        for await (const chunk of adapter.streamChat({
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `Instruction: ${instruction}\n\nText:\n${contextMd.slice(0, 8000)}`,
            },
          ],
        })) {
          accumulated += chunk;
          sendEvent("chunk", { text: chunk });
        }

        sendEvent("done", {
          result: accumulated,
          baseRevisionId: pageRow.currentRevisionId,
        });
      } catch (err) {
        fastify.log.error(err, "ai-edit stream error");
        sendEvent("error", { message: "AI edit failed" });
      } finally {
        reply.raw.end();
      }
    },
  );

  // -----------------------------------------------------------------------
  // POST /:pageId/reformat — AI-driven content restructure (queued, reviewed)
  // -----------------------------------------------------------------------
  fastify.post(
    "/:pageId/reformat",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = pageParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, pageId } = paramsResult.data;

      const role = await getMemberRole(
        fastify.db,
        workspaceId,
        request.user.sub,
      );
      if (!role) return forbidden(reply);
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const bodyResult = z
        .object({ instructions: z.string().max(500).optional() })
        .safeParse(request.body ?? {});
      if (!bodyResult.success) {
        return sendValidationError(reply, bodyResult.error.issues);
      }

      const [page] = await fastify.db
        .select({ id: pages.id, currentRevisionId: pages.currentRevisionId })
        .from(pages)
        .where(and(eq(pages.id, pageId), eq(pages.workspaceId, workspaceId)))
        .limit(1);

      if (!page) {
        return reply
          .code(404)
          .send({ error: "Page not found", code: ERROR_CODES.PAGE_NOT_FOUND });
      }
      if (!page.currentRevisionId) {
        return reply
          .code(400)
          .send({
            error: "Page has no content to reformat",
            code: ERROR_CODES.NO_REVISION,
          });
      }

      // Pre-flight dedup: return existing pending decision without enqueuing a duplicate job
      const [pendingDecision] = await fastify.db
        .select({ id: ingestionDecisions.id })
        .from(ingestionDecisions)
        .innerJoin(
          ingestions,
          eq(ingestions.id, ingestionDecisions.ingestionId),
        )
        .where(
          and(
            eq(ingestionDecisions.targetPageId, pageId),
            eq(ingestions.sourceName, IMPORT_SOURCE_NAMES.REFORMAT_REQUEST),
            inArray(ingestionDecisions.status, ["suggested", "needs_review"]),
          ),
        )
        .limit(1);

      if (pendingDecision) {
        return reply.code(202).send({
          jobId: null,
          status: "already_pending",
          decisionId: pendingDecision.id,
        });
      }

      const jobData: ContentReformatterJobData = {
        pageId,
        workspaceId,
        requestedByUserId: request.user.sub,
        instructions: bodyResult.data.instructions ?? null,
      };
      const job = await fastify.queues.reformat.add(
        JOB_NAMES.CONTENT_REFORMATTER,
        jobData,
        DEFAULT_JOB_OPTIONS,
      );

      return reply.code(202).send({ jobId: job.id, status: "queued" });
    },
  );

  // -----------------------------------------------------------------------
  // GET /search — Full-text search across pages in a workspace
  // -----------------------------------------------------------------------
  fastify.get(
    "/search",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = workspaceParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId } = paramsResult.data;

      const role = await getMemberRole(
        fastify.db,
        workspaceId,
        request.user.sub,
      );
      if (!role) return forbidden(reply);

      const queryResult = searchQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        return sendValidationError(reply, queryResult.error.issues);
      }
      const { q, limit, offset } = queryResult.data;

      // PostgreSQL full-text + trigram search across page title and latest revision content
      const rows = await fastify.db.execute(sql`
        SELECT
          p.id,
          p.workspace_id    AS "workspaceId",
          p.parent_page_id  AS "parentPageId",
          p.parent_folder_id AS "parentFolderId",
          p.title,
          p.slug,
          p.status,
          p.sort_order      AS "sortOrder",
          p.current_revision_id AS "currentRevisionId",
          p.last_ai_updated_at   AS "lastAiUpdatedAt",
          p.last_human_edited_at AS "lastHumanEditedAt",
          p.created_at      AS "createdAt",
          p.updated_at      AS "updatedAt",
          r.actor_type AS "latestRevisionActorType",
          r.source AS "latestRevisionSource",
          r.created_at AS "latestRevisionCreatedAt",
          r.source_ingestion_id AS "latestRevisionSourceIngestionId",
          r.source_decision_id AS "latestRevisionSourceDecisionId",
          ps.published_at AS "publishedAt",
          COALESCE(ps.is_live, false) AS "isLivePublished",
          ts_rank(
            to_tsvector('simple', coalesce(p.title, '') || ' ' || coalesce(r.content_md, '')),
            plainto_tsquery('simple', ${q})
          ) AS rank
        FROM pages p
        LEFT JOIN page_revisions r ON r.id = p.current_revision_id
        LEFT JOIN published_snapshots ps ON ps.page_id = p.id AND ps.is_live = true
        WHERE
          p.workspace_id = ${workspaceId}
          AND p.status != 'archived'
          AND p.deleted_at IS NULL
          AND (
            to_tsvector('simple', coalesce(p.title, '') || ' ' || coalesce(r.content_md, ''))
              @@ plainto_tsquery('simple', ${q})
            OR p.title ILIKE ${"%" + q + "%"}
          )
        ORDER BY rank DESC, p.updated_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `);

      const data = (
        rows as unknown as Array<{
          id: string;
          workspaceId: string;
          parentPageId: string | null;
          parentFolderId: string | null;
          title: string;
          slug: string;
          status: string;
          sortOrder: number;
          currentRevisionId: string | null;
          lastAiUpdatedAt: Date | null;
          lastHumanEditedAt: Date | null;
          createdAt: Date;
          updatedAt: Date;
          latestRevisionActorType: string | null;
          latestRevisionSource: string | null;
          latestRevisionCreatedAt: Date | null;
          latestRevisionSourceIngestionId: string | null;
          latestRevisionSourceDecisionId: string | null;
          publishedAt: Date | null;
          isLivePublished: boolean | null;
        }>
      ).map((row) => mapPageDto(row));

      return reply.code(200).send({ data, total: data.length, q });
    },
  );
};

export default pageRoutes;
