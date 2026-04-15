import type {
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import { eq, and, sql, desc, count, inArray, isNotNull, gte } from "drizzle-orm";
import { z } from "zod";
import {
  createPageSchema,
  updatePageSchema,
  paginationSchema,
  uuidSchema,
  createRevisionSchema,
  rollbackRevisionSchema,
  compareRevisionsQuerySchema,
  PAGE_STATUSES,
  computeDiff,
} from "@nexnote/shared";
import {
  pages,
  pageRevisions,
  pagePaths,
  auditLogs,
  revisionDiffs,
  entities,
  triples,
} from "@nexnote/db";
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

const listPagesQuerySchema = paginationSchema.extend({
  folderId: uuidSchema.optional(),
  status: z.enum(PAGE_STATUSES).optional(),
});

const createRevisionBodySchema = createRevisionSchema
  .pick({
    contentMd: true,
    contentJson: true,
    revisionNote: true,
  })
  .extend({ contentMd: z.string().min(1, "contentMd is required") });

const graphQuerySchema = z.object({
  depth: z.coerce.number().int().min(1).max(2).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  minConfidence: z.coerce.number().min(0).max(1).default(0),
});

// ---------------------------------------------------------------------------
// DTO mappers — never return raw DB rows
// ---------------------------------------------------------------------------

function mapPageDto(page: {
  id: string;
  workspaceId: string;
  folderId: string | null;
  title: string;
  slug: string;
  status: string;
  sortOrder: number;
  currentRevisionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: page.id,
    workspaceId: page.workspaceId,
    folderId: page.folderId,
    title: page.title,
    slug: page.slug,
    status: page.status,
    sortOrder: page.sortOrder,
    currentRevisionId: page.currentRevisionId,
    createdAt: page.createdAt.toISOString(),
    updatedAt: page.updatedAt.toISOString(),
  };
}

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
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle query builder doesn't expose a clean shared interface for db/tx
type AnyDb = any;

/** Verify a page belongs to a workspace. Returns the page row or null. */
async function findPageInWorkspace(
  db: AnyDb,
  workspaceId: string,
  pageId: string,
  columns: Record<string, unknown> = { id: pages.id },
) {
  const [row] = await db
    .select(columns)
    .from(pages)
    .where(and(eq(pages.id, pageId), eq(pages.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

function pageNotFound(reply: FastifyReply) {
  return reply.code(404).send({
    error: "Page not found",
    code: "PAGE_NOT_FOUND",
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

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const pageRoutes: FastifyPluginAsync = async (fastify) => {
  // All routes in this plugin require authentication
  fastify.addHook("onRequest", fastify.authenticate);

  // -----------------------------------------------------------------------
  // POST / — Create page
  // -----------------------------------------------------------------------
  fastify.post(
    "/",
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
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const bodyResult = createPageSchema.safeParse(request.body);
      if (!bodyResult.success) {
        return sendValidationError(reply, bodyResult.error.issues);
      }

      const { title, slug, folderId, contentMd, contentJson } =
        bodyResult.data;
      const userId = request.user.sub;

      try {
        const result = await fastify.db.transaction(async (tx) => {
          const [page] = await tx
            .insert(pages)
            .values({
              workspaceId,
              folderId,
              title,
              slug,
              status: "draft",
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
            .set({ currentRevisionId: revision.id })
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
            afterJson: { title, slug, folderId, status: "draft" },
          });

          return { page: updatedPage, revision };
        });

        return reply.code(201).send({
          page: mapPageDto(result.page),
          revision: mapRevisionDto(result.revision),
        });
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return reply.code(409).send({
            error: "A page with this slug already exists in the same folder",
            code: "SLUG_CONFLICT",
          });
        }
        throw err;
      }
    },
  );

  // -----------------------------------------------------------------------
  // GET / — List pages
  // -----------------------------------------------------------------------
  fastify.get(
    "/",
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

      const queryResult = listPagesQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        return sendValidationError(reply, queryResult.error.issues);
      }

      const { limit, offset, folderId, status } = queryResult.data;

      // Build where conditions
      const conditions = [eq(pages.workspaceId, workspaceId)];
      if (folderId) {
        conditions.push(eq(pages.folderId, folderId));
      }
      if (status) {
        conditions.push(eq(pages.status, status));
      }
      const whereClause = and(...conditions);

      const [data, [{ total }]] = await Promise.all([
        fastify.db
          .select({
            id: pages.id,
            workspaceId: pages.workspaceId,
            folderId: pages.folderId,
            title: pages.title,
            slug: pages.slug,
            status: pages.status,
            sortOrder: pages.sortOrder,
            currentRevisionId: pages.currentRevisionId,
            createdAt: pages.createdAt,
            updatedAt: pages.updatedAt,
          })
          .from(pages)
          .where(whereClause)
          .orderBy(pages.sortOrder, pages.createdAt)
          .limit(limit)
          .offset(offset),
        fastify.db
          .select({ total: count() })
          .from(pages)
          .where(whereClause),
      ]);

      return reply.code(200).send({
        data: data.map(mapPageDto),
        total,
      });
    },
  );

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
          page: {
            id: pages.id,
            workspaceId: pages.workspaceId,
            folderId: pages.folderId,
            title: pages.title,
            slug: pages.slug,
            status: pages.status,
            sortOrder: pages.sortOrder,
            currentRevisionId: pages.currentRevisionId,
            createdAt: pages.createdAt,
            updatedAt: pages.updatedAt,
          },
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
        .leftJoin(
          pageRevisions,
          eq(pages.currentRevisionId, pageRevisions.id),
        )
        .where(
          and(eq(pages.id, pageId), eq(pages.workspaceId, workspaceId)),
        )
        .limit(1);

      if (rows.length === 0) {
        return reply.code(404).send({
          error: "Page not found",
          code: "PAGE_NOT_FOUND",
        });
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
          code: "EMPTY_UPDATE",
        });
      }

      // Check page exists
      const [existing] = await fastify.db
        .select()
        .from(pages)
        .where(
          and(eq(pages.id, pageId), eq(pages.workspaceId, workspaceId)),
        )
        .limit(1);

      if (!existing) {
        return reply.code(404).send({
          error: "Page not found",
          code: "PAGE_NOT_FOUND",
        });
      }

      const userId = request.user.sub;
      const slugChanged =
        body.slug !== undefined && body.slug !== existing.slug;

      try {
        const result = await fastify.db.transaction(async (tx) => {
          const [updatedPage] = await tx
            .update(pages)
            .set({
              ...(body.title !== undefined && { title: body.title }),
              ...(body.slug !== undefined && { slug: body.slug }),
              ...(body.folderId !== undefined && {
                folderId: body.folderId,
              }),
              ...(body.status !== undefined && { status: body.status }),
              ...(body.sortOrder !== undefined && {
                sortOrder: body.sortOrder,
              }),
              updatedAt: sql`now()`,
            })
            .where(eq(pages.id, pageId))
            .returning();

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
              folderId: existing.folderId,
              status: existing.status,
              sortOrder: existing.sortOrder,
            },
            afterJson: body,
          });

          return updatedPage;
        });

        return reply.code(200).send({ page: mapPageDto(result) });
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return reply.code(409).send({
            error: "A page with this slug already exists in the same folder",
            code: "SLUG_CONFLICT",
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

      const page = await findPageInWorkspace(
        fastify.db,
        workspaceId,
        pageId,
        { id: pages.id, currentRevisionId: pages.currentRevisionId },
      );
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
            and(
              eq(pageRevisions.id, from),
              eq(pageRevisions.pageId, pageId),
            ),
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
            and(
              eq(pageRevisions.id, to),
              eq(pageRevisions.pageId, pageId),
            ),
          )
          .limit(1)
          .then((r) => r[0]),
      ]);

      if (!fromRevision || !toRevision) {
        return reply.code(404).send({
          error: "One or both revisions not found",
          code: "REVISION_NOT_FOUND",
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
          code: "REVISION_NOT_FOUND",
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
          code: "DIFF_NOT_FOUND",
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

      // Fetch the target revision to rollback to
      const [targetRevision] = await fastify.db
        .select({
          id: pageRevisions.id,
          contentMd: pageRevisions.contentMd,
          contentJson: pageRevisions.contentJson,
        })
        .from(pageRevisions)
        .where(
          and(
            eq(pageRevisions.id, revisionId),
            eq(pageRevisions.pageId, pageId),
          ),
        )
        .limit(1);

      if (!targetRevision) {
        return reply.code(404).send({
          error: "Revision not found",
          code: "REVISION_NOT_FOUND",
        });
      }

      let result;
      try {
        result = await fastify.db.transaction(async (tx) => {
        // Re-fetch page inside transaction to avoid race with concurrent saves
        const [page] = await tx
          .select({
            id: pages.id,
            currentRevisionId: pages.currentRevisionId,
          })
          .from(pages)
          .where(
            and(eq(pages.id, pageId), eq(pages.workspaceId, workspaceId)),
          )
          .limit(1);

        if (!page) {
          throw new Error("PAGE_NOT_FOUND");
        }

        const [newRevision] = await tx
          .insert(pageRevisions)
          .values({
            pageId,
            baseRevisionId: page.currentRevisionId,
            actorUserId: userId,
            actorType: "user",
            source: "rollback",
            contentMd: targetRevision.contentMd,
            contentJson: targetRevision.contentJson,
            revisionNote:
              revisionNote ?? `Rollback to revision ${revisionId}`,
          })
          .returning();

        if (page.currentRevisionId) {
          await insertRevisionDiff(
            tx,
            newRevision.id,
            page.currentRevisionId,
            targetRevision.contentMd,
            targetRevision.contentJson as Record<string, unknown> | null,
          );
        }

        await tx
          .update(pages)
          .set({
            currentRevisionId: newRevision.id,
            updatedAt: sql`now()`,
          })
          .where(eq(pages.id, pageId));

        await tx.insert(auditLogs).values({
          workspaceId,
          userId,
          entityType: "page_revision",
          entityId: newRevision.id,
          action: "rollback",
          afterJson: {
            pageId,
            baseRevisionId: page.currentRevisionId,
            rollbackTargetRevisionId: revisionId,
          },
        });

        return newRevision;
      });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === "PAGE_NOT_FOUND") {
          return pageNotFound(reply);
        }
        throw err;
      }

      return reply.code(201).send({
        revision: mapRevisionDto(result),
      });
    },
  );

  // -----------------------------------------------------------------------
  // DELETE /:pageId — Delete page
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

      // Verify page exists
      const [existing] = await fastify.db
        .select({ id: pages.id, title: pages.title })
        .from(pages)
        .where(
          and(eq(pages.id, pageId), eq(pages.workspaceId, workspaceId)),
        )
        .limit(1);

      if (!existing) {
        return reply.code(404).send({
          error: "Page not found",
          code: "PAGE_NOT_FOUND",
        });
      }

      await fastify.db.transaction(async (tx) => {
        await tx.insert(auditLogs).values({
          workspaceId,
          userId: request.user.sub,
          entityType: "page",
          entityId: pageId,
          action: "delete",
          beforeJson: { id: existing.id, title: existing.title },
        });

        // Clear the FK to page_revisions before cascading delete
        await tx
          .update(pages)
          .set({
            currentRevisionId: null,
            latestPublishedSnapshotId: null,
          })
          .where(eq(pages.id, pageId));

        await tx.delete(pages).where(eq(pages.id, pageId));
      });

      return reply.code(204).send();
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
      const { depth, limit, minConfidence } = queryResult.data;

      // Verify page belongs to workspace
      const page = await findPageInWorkspace(fastify.db, workspaceId, pageId);
      if (!page) return pageNotFound(reply);

      const db = fastify.db;

      // ------------------------------------------------------------------
      // Step 1: Find center entity IDs — entities appearing in active
      //         triples sourced from this page (as subject or entity-object)
      // ------------------------------------------------------------------
      const baseConditions = [
        eq(triples.sourcePageId, pageId),
        eq(triples.workspaceId, workspaceId),
        eq(triples.status, "active"),
        ...(minConfidence > 0
          ? [gte(triples.confidence, minConfidence)]
          : []),
      ];

      const centerTriplesRows = await db
        .select({
          subjectEntityId: triples.subjectEntityId,
          objectEntityId: triples.objectEntityId,
        })
        .from(triples)
        .where(and(...baseConditions));

      const centerEntityIds = new Set<string>();
      for (const row of centerTriplesRows) {
        centerEntityIds.add(row.subjectEntityId);
        if (row.objectEntityId) {
          centerEntityIds.add(row.objectEntityId);
        }
      }

      if (centerEntityIds.size === 0) {
        return reply.code(200).send({
          nodes: [],
          edges: [],
          meta: {
            pageId,
            depth,
            totalNodes: 0,
            totalEdges: 0,
            truncated: false,
          },
        });
      }

      // ------------------------------------------------------------------
      // Step 2: Expand by depth — collect neighbor entity IDs
      // ------------------------------------------------------------------
      // allEntityIds accumulates every entity we want in the graph
      const allEntityIds = new Set(centerEntityIds);
      // frontier holds the IDs we need to expand from in the current hop
      let frontier = new Set(centerEntityIds);

      for (let hop = 1; hop <= depth; hop++) {
        if (frontier.size === 0) break;

        const frontierArr = [...frontier];

        // Find triples where any frontier entity is subject or entity-object.
        // We only care about entity-object triples (objectEntityId IS NOT NULL)
        // because literal triples cannot produce graph edges.
        const neighborRows = await db
          .select({
            subjectEntityId: triples.subjectEntityId,
            objectEntityId: triples.objectEntityId,
          })
          .from(triples)
          .where(
            and(
              eq(triples.workspaceId, workspaceId),
              eq(triples.status, "active"),
              isNotNull(triples.objectEntityId),
              ...(minConfidence > 0
                ? [gte(triples.confidence, minConfidence)]
                : []),
              sql`(${inArray(triples.subjectEntityId, frontierArr)} OR ${inArray(triples.objectEntityId, frontierArr)})`,
            ),
          );

        const nextFrontier = new Set<string>();
        for (const row of neighborRows) {
          if (!allEntityIds.has(row.subjectEntityId)) {
            nextFrontier.add(row.subjectEntityId);
          }
          if (row.objectEntityId && !allEntityIds.has(row.objectEntityId)) {
            nextFrontier.add(row.objectEntityId);
          }
        }

        for (const id of nextFrontier) {
          allEntityIds.add(id);
        }
        frontier = nextFrontier;
      }

      // ------------------------------------------------------------------
      // Step 3: Apply node limit — keep center nodes first, then by
      //         connection count
      // ------------------------------------------------------------------
      let truncated = false;
      let finalEntityIds: string[];

      if (allEntityIds.size <= limit) {
        finalEntityIds = [...allEntityIds];
      } else {
        // We need to prioritise: center nodes first, then most-connected.
        // Count connections for non-center nodes.
        const nonCenterIds = [...allEntityIds].filter(
          (id) => !centerEntityIds.has(id),
        );

        // Count how many times each non-center entity appears as subject or
        // object in triples that involve any entity in our full set. We use
        // a lightweight approach: count occurrences in the neighbor rows we
        // already fetched would require storing them. Instead, run a quick
        // count query.
        const connectionCounts = new Map<string, number>();

        if (nonCenterIds.length > 0) {
          const countRows = await db
            .select({
              entityId: sql<string>`e.entity_id`,
              cnt: sql<number>`count(*)`,
            })
            .from(
              sql`(
                SELECT ${triples.subjectEntityId} AS entity_id FROM ${triples}
                WHERE ${triples.workspaceId} = ${workspaceId}
                  AND ${triples.status} = 'active'
                  AND ${inArray(triples.subjectEntityId, nonCenterIds)}
                  AND ${isNotNull(triples.objectEntityId)}
                  ${minConfidence > 0 ? sql`AND ${triples.confidence} >= ${minConfidence}` : sql``}
                UNION ALL
                SELECT ${triples.objectEntityId} AS entity_id FROM ${triples}
                WHERE ${triples.workspaceId} = ${workspaceId}
                  AND ${triples.status} = 'active'
                  AND ${inArray(triples.objectEntityId, nonCenterIds)}
                  ${minConfidence > 0 ? sql`AND ${triples.confidence} >= ${minConfidence}` : sql``}
              ) AS e`,
            )
            .groupBy(sql`e.entity_id`);

          for (const r of countRows) {
            connectionCounts.set(r.entityId, Number(r.cnt));
          }
        }

        // Sort non-center by connection count descending
        nonCenterIds.sort(
          (a, b) =>
            (connectionCounts.get(b) ?? 0) - (connectionCounts.get(a) ?? 0),
        );

        const centerArr = [...centerEntityIds];
        const remaining = limit - centerArr.length;
        finalEntityIds = [
          ...centerArr,
          ...nonCenterIds.slice(0, Math.max(0, remaining)),
        ];
        truncated = true;
      }

      // ------------------------------------------------------------------
      // Step 4: Fetch entity details
      // ------------------------------------------------------------------
      const entityRows = await db
        .select({
          id: entities.id,
          canonicalName: entities.canonicalName,
          entityType: entities.entityType,
        })
        .from(entities)
        .where(inArray(entities.id, finalEntityIds));

      // ------------------------------------------------------------------
      // Step 5: Count pages referencing each entity (via triples)
      // ------------------------------------------------------------------
      const pageCountRows = await db
        .select({
          entityId: sql<string>`entity_id`,
          pageCount: sql<number>`count(DISTINCT source_page_id)`,
        })
        .from(
          sql`(
            SELECT ${triples.subjectEntityId} AS entity_id, ${triples.sourcePageId} AS source_page_id
            FROM ${triples}
            WHERE ${triples.workspaceId} = ${workspaceId}
              AND ${triples.status} = 'active'
              AND ${inArray(triples.subjectEntityId, finalEntityIds)}
            UNION
            SELECT ${triples.objectEntityId} AS entity_id, ${triples.sourcePageId} AS source_page_id
            FROM ${triples}
            WHERE ${triples.workspaceId} = ${workspaceId}
              AND ${triples.status} = 'active'
              AND ${isNotNull(triples.objectEntityId)}
              AND ${inArray(triples.objectEntityId, finalEntityIds)}
          ) AS pc`,
        )
        .groupBy(sql`entity_id`);

      const pageCountMap = new Map<string, number>();
      for (const r of pageCountRows) {
        pageCountMap.set(r.entityId, Number(r.pageCount));
      }

      // ------------------------------------------------------------------
      // Step 6: Fetch edges — only entity-object triples where both
      //         endpoints are in the final node set
      // ------------------------------------------------------------------
      const finalIdSet = new Set(finalEntityIds);

      const edgeRows = await db
        .select({
          id: triples.id,
          subjectEntityId: triples.subjectEntityId,
          objectEntityId: triples.objectEntityId,
          predicate: triples.predicate,
          confidence: triples.confidence,
          sourcePageId: triples.sourcePageId,
        })
        .from(triples)
        .where(
          and(
            eq(triples.workspaceId, workspaceId),
            eq(triples.status, "active"),
            isNotNull(triples.objectEntityId),
            inArray(triples.subjectEntityId, finalEntityIds),
            inArray(triples.objectEntityId, finalEntityIds),
            ...(minConfidence > 0
              ? [gte(triples.confidence, minConfidence)]
              : []),
          ),
        );

      // Filter edges: both endpoints must be in finalIdSet (double-check
      // since inArray already ensures this, but the objectEntityId column
      // is nullable in the type system)
      const edges = edgeRows
        .filter(
          (e) =>
            e.objectEntityId !== null &&
            finalIdSet.has(e.subjectEntityId) &&
            finalIdSet.has(e.objectEntityId),
        )
        .map((e) => ({
          id: e.id,
          source: e.subjectEntityId,
          target: e.objectEntityId!,
          predicate: e.predicate,
          confidence: e.confidence,
          sourcePageId: e.sourcePageId,
        }));

      // ------------------------------------------------------------------
      // Step 7: Build nodes DTO
      // ------------------------------------------------------------------
      const nodes = entityRows.map((e) => ({
        id: e.id,
        label: e.canonicalName,
        type: e.entityType,
        isCenter: centerEntityIds.has(e.id),
        pageCount: pageCountMap.get(e.id) ?? 0,
      }));

      return reply.code(200).send({
        nodes,
        edges,
        meta: {
          pageId,
          depth,
          totalNodes: nodes.length,
          totalEdges: edges.length,
          truncated,
        },
      });
    },
  );
};

export default pageRoutes;
