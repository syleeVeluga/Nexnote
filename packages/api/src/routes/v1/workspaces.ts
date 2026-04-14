import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { eq, and, count } from "drizzle-orm";
import { workspaces, workspaceMembers, users } from "@nexnote/db";
import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  addWorkspaceMemberSchema,
  paginationSchema,
  uuidSchema,
  WORKSPACE_ROLES,
} from "@nexnote/shared";
import {
  sendValidationError,
  isUniqueViolation,
} from "../../lib/reply-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function requireMembership(
  fastify: FastifyInstance,
  workspaceId: string,
  userId: string,
  requiredRoles?: string[],
) {
  const [member] = await fastify.db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1);

  if (!member) {
    throw fastify.httpErrors.forbidden("Not a workspace member");
  }

  if (requiredRoles && !requiredRoles.includes(member.role)) {
    throw fastify.httpErrors.forbidden(
      `Requires one of roles: ${requiredRoles.join(", ")}`,
    );
  }

  return member;
}

// ---------------------------------------------------------------------------
// Response mappers — never expose raw DB rows directly
// ---------------------------------------------------------------------------

function toWorkspaceDto(row: typeof workspaces.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    defaultAiPolicy: row.defaultAiPolicy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMemberDto(
  member: typeof workspaceMembers.$inferSelect,
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
  },
) {
  return {
    workspaceId: member.workspaceId,
    userId: member.userId,
    role: member.role,
    createdAt: member.createdAt.toISOString(),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const workspaceRoutes: FastifyPluginAsync = async (fastify) => {
  // -----------------------------------------------------------------------
  // POST /workspaces — Create workspace
  // -----------------------------------------------------------------------
  fastify.post(
    "/",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const parsed = createWorkspaceSchema.safeParse(request.body);
      if (!parsed.success)
        return sendValidationError(reply, parsed.error.issues);
      const body = parsed.data;
      const userId = request.user.sub;

      try {
        const workspace = await fastify.db.transaction(async (tx) => {
          const [ws] = await tx
            .insert(workspaces)
            .values({
              name: body.name,
              slug: body.slug,
              defaultAiPolicy: body.defaultAiPolicy ?? null,
            })
            .returning();

          await tx.insert(workspaceMembers).values({
            workspaceId: ws.id,
            userId,
            role: "owner",
          });

          return ws;
        });

        return reply.code(201).send(toWorkspaceDto(workspace));
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          throw fastify.httpErrors.conflict(
            "A workspace with this slug already exists",
          );
        }
        throw err;
      }
    },
  );

  // -----------------------------------------------------------------------
  // GET /workspaces — List workspaces for current user
  // -----------------------------------------------------------------------
  fastify.get(
    "/",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const parsed = paginationSchema.safeParse(request.query);
      if (!parsed.success)
        return sendValidationError(reply, parsed.error.issues);
      const { limit, offset } = parsed.data;
      const userId = request.user.sub;

      const [data, [totalRow]] = await Promise.all([
        fastify.db
          .select({
            id: workspaces.id,
            name: workspaces.name,
            slug: workspaces.slug,
            defaultAiPolicy: workspaces.defaultAiPolicy,
            createdAt: workspaces.createdAt,
            updatedAt: workspaces.updatedAt,
            role: workspaceMembers.role,
          })
          .from(workspaceMembers)
          .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
          .where(eq(workspaceMembers.userId, userId))
          .limit(limit)
          .offset(offset),
        fastify.db
          .select({ total: count() })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.userId, userId)),
      ]);

      return {
        data: data.map((row) => ({
          ...toWorkspaceDto(row),
          role: row.role,
        })),
        total: totalRow.total,
      };
    },
  );

  // -----------------------------------------------------------------------
  // GET /workspaces/:workspaceId — Get single workspace
  // -----------------------------------------------------------------------
  fastify.get(
    "/:workspaceId",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const idResult = uuidSchema.safeParse(workspaceId);
      if (!idResult.success)
        return sendValidationError(reply, idResult.error.issues);

      const userId = request.user.sub;
      const member = await requireMembership(fastify, workspaceId, userId);

      const [workspace] = await fastify.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);

      if (!workspace) {
        throw fastify.httpErrors.notFound("Workspace not found");
      }

      return {
        ...toWorkspaceDto(workspace),
        role: member.role,
      };
    },
  );

  // -----------------------------------------------------------------------
  // PATCH /workspaces/:workspaceId — Update workspace
  // -----------------------------------------------------------------------
  fastify.patch(
    "/:workspaceId",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const idResult = uuidSchema.safeParse(workspaceId);
      if (!idResult.success)
        return sendValidationError(reply, idResult.error.issues);

      const bodyResult = updateWorkspaceSchema.safeParse(request.body);
      if (!bodyResult.success)
        return sendValidationError(reply, bodyResult.error.issues);
      const body = bodyResult.data;
      const userId = request.user.sub;

      await requireMembership(fastify, workspaceId, userId, [
        "owner",
        "admin",
      ]);

      try {
        const [updated] = await fastify.db
          .update(workspaces)
          .set({
            ...body,
            updatedAt: new Date(),
          })
          .where(eq(workspaces.id, workspaceId))
          .returning();

        if (!updated) {
          throw fastify.httpErrors.notFound("Workspace not found");
        }

        return toWorkspaceDto(updated);
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          throw fastify.httpErrors.conflict(
            "A workspace with this slug already exists",
          );
        }
        throw err;
      }
    },
  );

  // -----------------------------------------------------------------------
  // POST /workspaces/:workspaceId/members — Add member
  // -----------------------------------------------------------------------
  fastify.post(
    "/:workspaceId/members",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const idResult = uuidSchema.safeParse(workspaceId);
      if (!idResult.success)
        return sendValidationError(reply, idResult.error.issues);

      const bodyResult = addWorkspaceMemberSchema.safeParse(request.body);
      if (!bodyResult.success)
        return sendValidationError(reply, bodyResult.error.issues);
      const body = bodyResult.data;
      const userId = request.user.sub;

      await requireMembership(fastify, workspaceId, userId, [
        "owner",
        "admin",
      ]);

      try {
        const [member] = await fastify.db
          .insert(workspaceMembers)
          .values({
            workspaceId,
            userId: body.userId,
            role: body.role,
          })
          .returning();

        const [user] = await fastify.db
          .select({
            id: users.id,
            email: users.email,
            name: users.name,
            avatarUrl: users.avatarUrl,
          })
          .from(users)
          .where(eq(users.id, body.userId))
          .limit(1);

        return reply.code(201).send(toMemberDto(member, user));
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          throw fastify.httpErrors.conflict(
            "User is already a member of this workspace",
          );
        }
        throw err;
      }
    },
  );

  // -----------------------------------------------------------------------
  // GET /workspaces/:workspaceId/members — List members
  // -----------------------------------------------------------------------
  fastify.get(
    "/:workspaceId/members",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const idResult = uuidSchema.safeParse(workspaceId);
      if (!idResult.success)
        return sendValidationError(reply, idResult.error.issues);

      const userId = request.user.sub;
      const paginationResult = paginationSchema.safeParse(request.query);
      if (!paginationResult.success)
        return sendValidationError(reply, paginationResult.error.issues);
      const { limit, offset } = paginationResult.data;

      await requireMembership(fastify, workspaceId, userId);

      const [data, [totalRow]] = await Promise.all([
        fastify.db
          .select({
            workspaceId: workspaceMembers.workspaceId,
            userId: workspaceMembers.userId,
            role: workspaceMembers.role,
            createdAt: workspaceMembers.createdAt,
            user: {
              id: users.id,
              email: users.email,
              name: users.name,
              avatarUrl: users.avatarUrl,
            },
          })
          .from(workspaceMembers)
          .innerJoin(users, eq(workspaceMembers.userId, users.id))
          .where(eq(workspaceMembers.workspaceId, workspaceId))
          .limit(limit)
          .offset(offset),
        fastify.db
          .select({ total: count() })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.workspaceId, workspaceId)),
      ]);

      return {
        data: data.map((row) => ({
          workspaceId: row.workspaceId,
          userId: row.userId,
          role: row.role,
          createdAt: row.createdAt.toISOString(),
          user: {
            id: row.user.id,
            email: row.user.email,
            name: row.user.name,
            avatarUrl: row.user.avatarUrl,
          },
        })),
        total: totalRow.total,
      };
    },
  );
};

export default workspaceRoutes;
