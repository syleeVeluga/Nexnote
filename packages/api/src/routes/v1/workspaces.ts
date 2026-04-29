import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
} from "fastify";
import { eq, and, count } from "drizzle-orm";
import { workspaces, workspaceMembers, users, auditLogs } from "@wekiflow/db";
import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  addWorkspaceMemberSchema,
  paginationSchema,
  uuidSchema,
  WORKSPACE_ROLES,
  ERROR_CODES,
  getAgentModelProvider,
} from "@wekiflow/shared";
import {
  sendValidationError,
  isUniqueViolation,
} from "../../lib/reply-helpers.js";
import { readAgentParityGateStatus } from "../../lib/agent-parity-gate.js";

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
    agentInstructions: row.agentInstructions,
    agentProvider: row.agentProvider,
    agentModelFast: row.agentModelFast,
    agentModelLargeContext: row.agentModelLargeContext,
    agentFastThresholdTokens: row.agentFastThresholdTokens,
    agentDailyTokenCap: row.agentDailyTokenCap,
    useReconciliationDefault: row.useReconciliationDefault,
    ingestionMode: row.ingestionMode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function valueAfterPatch<T>(
  patch: object,
  current: object,
  key: string,
): T {
  const patchRecord = patch as Record<string, unknown>;
  const currentRecord = current as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(patch, key)
    ? (patchRecord[key] as T)
    : (currentRecord[key] as T);
}

function validateAgentSettingsPatch(
  fastify: FastifyInstance,
  currentWorkspace: typeof workspaces.$inferSelect,
  patch: Partial<typeof workspaces.$inferInsert>,
) {
  const merged = {
    agentProvider: valueAfterPatch<string | null>(
      patch,
      currentWorkspace,
      "agentProvider",
    ),
    agentModelFast: valueAfterPatch<string | null>(
      patch,
      currentWorkspace,
      "agentModelFast",
    ),
    agentModelLargeContext: valueAfterPatch<string | null>(
      patch,
      currentWorkspace,
      "agentModelLargeContext",
    ),
  };

  if (
    !merged.agentProvider &&
    (merged.agentModelFast || merged.agentModelLargeContext)
  ) {
    throw fastify.httpErrors.badRequest(
      "agentProvider is required when agent model overrides are set",
    );
  }

  for (const [key, model] of [
    ["agentModelFast", merged.agentModelFast],
    ["agentModelLargeContext", merged.agentModelLargeContext],
  ] as const) {
    if (!model) continue;
    const provider = getAgentModelProvider(model);
    if (provider !== merged.agentProvider) {
      throw fastify.httpErrors.badRequest(
        `${key} must belong to the configured agentProvider`,
      );
    }
  }
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
              agentInstructions: body.agentInstructions?.trim() || null,
              useReconciliationDefault: body.useReconciliationDefault ?? true,
            })
            .returning();

          await tx.insert(workspaceMembers).values({
            workspaceId: ws.id,
            userId,
            role: "owner",
          });

          await tx.insert(auditLogs).values({
            workspaceId: ws.id,
            userId,
            entityType: "workspace",
            entityId: ws.id,
            action: "workspace.create",
            afterJson: { name: ws.name, slug: ws.slug },
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
            agentInstructions: workspaces.agentInstructions,
            agentProvider: workspaces.agentProvider,
            agentModelFast: workspaces.agentModelFast,
            agentModelLargeContext: workspaces.agentModelLargeContext,
            agentFastThresholdTokens: workspaces.agentFastThresholdTokens,
            agentDailyTokenCap: workspaces.agentDailyTokenCap,
            useReconciliationDefault: workspaces.useReconciliationDefault,
            ingestionMode: workspaces.ingestionMode,
            createdAt: workspaces.createdAt,
            updatedAt: workspaces.updatedAt,
            role: workspaceMembers.role,
          })
          .from(workspaceMembers)
          .innerJoin(
            workspaces,
            eq(workspaceMembers.workspaceId, workspaces.id),
          )
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
      const workspacePatch = {
        ...body,
        ...("agentInstructions" in body
          ? { agentInstructions: body.agentInstructions?.trim() || null }
          : {}),
      };

      await requireMembership(fastify, workspaceId, userId, ["owner", "admin"]);

      const [currentWorkspace] = await fastify.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);

      if (!currentWorkspace) {
        throw fastify.httpErrors.notFound("Workspace not found");
      }

      if (
        body.ingestionMode === "agent" &&
        currentWorkspace.ingestionMode !== "agent"
      ) {
        const gate = await readAgentParityGateStatus(fastify.db, workspaceId);
        if (!gate.canPromote) {
          return reply.code(409).send({
            error: "Agent mode is blocked until shadow parity passes",
            code: ERROR_CODES.AGENT_PARITY_GATE_NOT_PASSED,
            gate,
          });
        }
      }

      validateAgentSettingsPatch(fastify, currentWorkspace, workspacePatch);

      try {
        const updated = await fastify.db.transaction(async (tx) => {
          const [row] = await tx
            .update(workspaces)
            .set({
              ...workspacePatch,
              updatedAt: new Date(),
            })
            .where(eq(workspaces.id, workspaceId))
            .returning();

          if (!row) return null;

          await tx.insert(auditLogs).values({
            workspaceId,
            userId,
            entityType: "workspace",
            entityId: workspaceId,
            action: "workspace.update",
            afterJson: workspacePatch,
          });

          return row;
        });

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

      await requireMembership(fastify, workspaceId, userId, ["owner", "admin"]);

      try {
        const { member, user } = await fastify.db.transaction(async (tx) => {
          const [m] = await tx
            .insert(workspaceMembers)
            .values({
              workspaceId,
              userId: body.userId,
              role: body.role,
            })
            .returning();

          const [u] = await tx
            .select({
              id: users.id,
              email: users.email,
              name: users.name,
              avatarUrl: users.avatarUrl,
            })
            .from(users)
            .where(eq(users.id, body.userId))
            .limit(1);

          await tx.insert(auditLogs).values({
            workspaceId,
            userId,
            entityType: "workspace_member",
            entityId: workspaceId,
            action: "member.add",
            afterJson: { targetUserId: body.userId, role: body.role },
          });

          return { member: m, user: u };
        });

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
