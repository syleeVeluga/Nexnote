import type {
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import { eq, and, sql, desc, count } from "drizzle-orm";
import { z } from "zod";
import {
  createPageSchema,
  updatePageSchema,
  paginationSchema,
  uuidSchema,
  createRevisionSchema,
  PAGE_STATUSES,
} from "@nexnote/shared";
import {
  pages,
  pageRevisions,
  pagePaths,
  auditLogs,
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
  };
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

      // Verify the page exists in this workspace
      const [page] = await fastify.db
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
        return reply.code(404).send({
          error: "Page not found",
          code: "PAGE_NOT_FOUND",
        });
      }

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

      // Verify the page exists in this workspace
      const [page] = await fastify.db
        .select({ id: pages.id })
        .from(pages)
        .where(
          and(eq(pages.id, pageId), eq(pages.workspaceId, workspaceId)),
        )
        .limit(1);

      if (!page) {
        return reply.code(404).send({
          error: "Page not found",
          code: "PAGE_NOT_FOUND",
        });
      }

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
          })
          .from(pageRevisions)
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

      // Verify page belongs to workspace
      const [page] = await fastify.db
        .select({ id: pages.id })
        .from(pages)
        .where(
          and(eq(pages.id, pageId), eq(pages.workspaceId, workspaceId)),
        )
        .limit(1);

      if (!page) {
        return reply.code(404).send({
          error: "Page not found",
          code: "PAGE_NOT_FOUND",
        });
      }

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
};

export default pageRoutes;
