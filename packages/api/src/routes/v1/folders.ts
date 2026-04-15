import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { eq, and, isNull, count } from "drizzle-orm";
import { folders, auditLogs } from "@nexnote/db";
import {
  createFolderSchema,
  updateFolderSchema,
  paginationSchema,
  uuidSchema,
  ERROR_CODES,
} from "@nexnote/shared";
import { z } from "zod";
import {
  getMemberRole,
  forbidden,
  insufficientRole,
  EDITOR_PLUS_ROLES,
  ADMIN_PLUS_ROLES,
  workspaceParamsSchema,
} from "../../lib/workspace-auth.js";
import { sendValidationError, isUniqueViolation } from "../../lib/reply-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const folderParamsSchema = workspaceParamsSchema.extend({
  folderId: uuidSchema,
});

const listQuerySchema = paginationSchema.extend({
  parentFolderId: uuidSchema.nullable().optional(),
});

const reorderBodySchema = z.object({
  sortOrder: z.number().int(),
});

// ---------------------------------------------------------------------------
// Folder DTO mapper — never return raw DB rows
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const folderRoutes: FastifyPluginAsync = async (fastify) => {
  // All routes in this plugin require authentication
  fastify.addHook("onRequest", fastify.authenticate);

  // -----------------------------------------------------------------------
  // POST / — Create folder
  // -----------------------------------------------------------------------
  fastify.post(
    "/",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = workspaceParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId } = paramsResult.data;

      const role = await getMemberRole(fastify.db, workspaceId, request.user.sub);
      if (!role) return forbidden(reply);
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const bodyResult = createFolderSchema.safeParse(request.body);
      if (!bodyResult.success) {
        return sendValidationError(reply, bodyResult.error.issues);
      }

      const { name, slug, parentFolderId, sortOrder } = bodyResult.data;

      try {
        const folder = await fastify.db.transaction(async (tx) => {
          const [row] = await tx
            .insert(folders)
            .values({
              workspaceId,
              parentFolderId,
              name,
              slug,
              sortOrder,
            })
            .returning();

          await tx.insert(auditLogs).values({
            workspaceId,
            userId: request.user.sub,
            entityType: "folder",
            entityId: row.id,
            action: "folder.create",
            afterJson: { name, slug, parentFolderId },
          });

          return row;
        });

        return reply.code(201).send({ data: toFolderDto(folder) });
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return reply.code(409).send({
            error: "A folder with this slug already exists in the same parent",
            code: ERROR_CODES.SLUG_CONFLICT,
          });
        }
        throw err;
      }
    },
  );

  // -----------------------------------------------------------------------
  // GET / — List folders in workspace
  // -----------------------------------------------------------------------
  fastify.get(
    "/",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = workspaceParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId } = paramsResult.data;

      const role = await getMemberRole(fastify.db, workspaceId, request.user.sub);
      if (!role) return forbidden(reply);

      const queryResult = listQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        return sendValidationError(reply, queryResult.error.issues);
      }

      const { limit, offset, parentFolderId } = queryResult.data;

      // Build the where clause
      const conditions = [eq(folders.workspaceId, workspaceId)];

      if (parentFolderId !== undefined) {
        if (parentFolderId === null) {
          conditions.push(isNull(folders.parentFolderId));
        } else {
          conditions.push(eq(folders.parentFolderId, parentFolderId));
        }
      }

      const where = and(...conditions);

      const [data, [{ total }]] = await Promise.all([
        fastify.db
          .select()
          .from(folders)
          .where(where)
          .orderBy(folders.sortOrder)
          .limit(limit)
          .offset(offset),
        fastify.db
          .select({ total: count() })
          .from(folders)
          .where(where),
      ]);

      return reply.code(200).send({
        data: data.map(toFolderDto),
        total,
      });
    },
  );

  // -----------------------------------------------------------------------
  // GET /:folderId — Get single folder
  // -----------------------------------------------------------------------
  fastify.get(
    "/:folderId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = folderParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, folderId } = paramsResult.data;

      const role = await getMemberRole(fastify.db, workspaceId, request.user.sub);
      if (!role) return forbidden(reply);

      const [folder] = await fastify.db
        .select()
        .from(folders)
        .where(
          and(eq(folders.id, folderId), eq(folders.workspaceId, workspaceId)),
        )
        .limit(1);

      if (!folder) {
        return reply.code(404).send({
          error: "Folder not found",
          code: ERROR_CODES.FOLDER_NOT_FOUND,
        });
      }

      return reply.code(200).send({ data: toFolderDto(folder) });
    },
  );

  // -----------------------------------------------------------------------
  // PATCH /:folderId — Update folder
  // -----------------------------------------------------------------------
  fastify.patch(
    "/:folderId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = folderParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, folderId } = paramsResult.data;

      const role = await getMemberRole(fastify.db, workspaceId, request.user.sub);
      if (!role) return forbidden(reply);
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const bodyResult = updateFolderSchema.safeParse(request.body);
      if (!bodyResult.success) {
        return sendValidationError(reply, bodyResult.error.issues);
      }

      const updates = bodyResult.data;
      if (Object.keys(updates).length === 0) {
        return reply.code(400).send({
          error: "No fields to update",
          code: ERROR_CODES.EMPTY_UPDATE,
        });
      }

      try {
        const folder = await fastify.db.transaction(async (tx) => {
          const [row] = await tx
            .update(folders)
            .set({ ...updates, updatedAt: new Date() })
            .where(
              and(eq(folders.id, folderId), eq(folders.workspaceId, workspaceId)),
            )
            .returning();

          if (!row) return null;

          await tx.insert(auditLogs).values({
            workspaceId,
            userId: request.user.sub,
            entityType: "folder",
            entityId: folderId,
            action: "folder.update",
            afterJson: updates,
          });

          return row;
        });

        if (!folder) {
          return reply.code(404).send({
            error: "Folder not found",
            code: ERROR_CODES.FOLDER_NOT_FOUND,
          });
        }

        return reply.code(200).send({ data: toFolderDto(folder) });
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return reply.code(409).send({
            error: "A folder with this slug already exists in the same parent",
            code: ERROR_CODES.SLUG_CONFLICT,
          });
        }
        throw err;
      }
    },
  );

  // -----------------------------------------------------------------------
  // DELETE /:folderId — Delete folder
  // -----------------------------------------------------------------------
  fastify.delete(
    "/:folderId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = folderParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, folderId } = paramsResult.data;

      const role = await getMemberRole(fastify.db, workspaceId, request.user.sub);
      if (!role) return forbidden(reply);
      if (!ADMIN_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const deleted = await fastify.db.transaction(async (tx) => {
        const rows = await tx
          .delete(folders)
          .where(
            and(eq(folders.id, folderId), eq(folders.workspaceId, workspaceId)),
          )
          .returning({ id: folders.id });

        if (rows.length === 0) return false;

        await tx.insert(auditLogs).values({
          workspaceId,
          userId: request.user.sub,
          entityType: "folder",
          entityId: folderId,
          action: "folder.delete",
        });

        return true;
      });

      if (!deleted) {
        return reply.code(404).send({
          error: "Folder not found",
          code: ERROR_CODES.FOLDER_NOT_FOUND,
        });
      }

      return reply.code(204).send();
    },
  );

  // -----------------------------------------------------------------------
  // PATCH /:folderId/reorder — Reorder folder
  // -----------------------------------------------------------------------
  fastify.patch(
    "/:folderId/reorder",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = folderParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, folderId } = paramsResult.data;

      const role = await getMemberRole(fastify.db, workspaceId, request.user.sub);
      if (!role) return forbidden(reply);
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const bodyResult = reorderBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        return sendValidationError(reply, bodyResult.error.issues);
      }

      const { sortOrder } = bodyResult.data;

      const [folder] = await fastify.db
        .update(folders)
        .set({ sortOrder, updatedAt: new Date() })
        .where(
          and(eq(folders.id, folderId), eq(folders.workspaceId, workspaceId)),
        )
        .returning();

      if (!folder) {
        return reply.code(404).send({
          error: "Folder not found",
          code: ERROR_CODES.FOLDER_NOT_FOUND,
        });
      }

      return reply.code(200).send({ data: toFolderDto(folder) });
    },
  );
};

export default folderRoutes;
