import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  API_TOKEN_SCOPES,
  ERROR_CODES,
  paginationSchema,
  uuidSchema,
} from "@wekiflow/shared";
import { apiTokens, auditLogs, users } from "@wekiflow/db";
import {
  ADMIN_PLUS_ROLES,
  forbidden,
  getMemberRole,
  insufficientRole,
  workspaceParamsSchema,
} from "../../lib/workspace-auth.js";
import { sendValidationError } from "../../lib/reply-helpers.js";
import {
  createApiTokenValue,
  hashApiTokenSecret,
} from "../../lib/api-tokens.js";

const tokenParamsSchema = workspaceParamsSchema.extend({
  tokenId: uuidSchema,
});

function isHiddenSystemTokenName(name: string): boolean {
  return name.endsWith("(auto)") || name.endsWith("(system)");
}

const createTokenBodySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((name) => !isHiddenSystemTokenName(name), {
      message: "Token names ending with (auto) or (system) are reserved",
    }),
  sourceNameHint: z.string().trim().min(1).max(200).nullable().optional(),
  scopes: z
    .array(z.enum(API_TOKEN_SCOPES))
    .min(1)
    .default(["ingestions:write"]),
});

function mapToken(row: {
  id: string;
  name: string;
  sourceNameHint: string | null;
  scopes: string[];
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  createdByUserId: string;
  createdByUserName: string;
  createdByUserEmail: string;
}) {
  return {
    id: row.id,
    name: row.name,
    sourceNameHint: row.sourceNameHint,
    scopes: row.scopes,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    createdBy: {
      id: row.createdByUserId,
      name: row.createdByUserName,
      email: row.createdByUserEmail,
    },
  };
}

const apiTokenRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error.issues);

    const query = paginationSchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error.issues);

    const { workspaceId } = params.data;
    const role = await getMemberRole(fastify.db, workspaceId, request.user.sub);
    if (!role) return forbidden(reply);
    if (!ADMIN_PLUS_ROLES.includes(role)) return insufficientRole(reply);

    const rows = await fastify.db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        sourceNameHint: apiTokens.sourceNameHint,
        scopes: apiTokens.scopes,
        lastUsedAt: apiTokens.lastUsedAt,
        revokedAt: apiTokens.revokedAt,
        createdAt: apiTokens.createdAt,
        createdByUserId: apiTokens.createdByUserId,
        createdByUserName: users.name,
        createdByUserEmail: users.email,
      })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.createdByUserId))
      .where(eq(apiTokens.workspaceId, workspaceId))
      .orderBy(desc(apiTokens.createdAt));

    const visible = rows.filter((row) => !isHiddenSystemTokenName(row.name));
    const page = visible.slice(
      query.data.offset,
      query.data.offset + query.data.limit,
    );
    return reply.send({
      data: page.map((row) => mapToken(row)),
      total: visible.length,
      limit: query.data.limit,
      offset: query.data.offset,
    });
  });

  fastify.post("/", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error.issues);

    const body = createTokenBodySchema.safeParse(request.body ?? {});
    if (!body.success) return sendValidationError(reply, body.error.issues);

    const { workspaceId } = params.data;
    const userId = request.user.sub;
    const role = await getMemberRole(fastify.db, workspaceId, userId);
    if (!role) return forbidden(reply);
    if (!ADMIN_PLUS_ROLES.includes(role)) return insufficientRole(reply);

    const tokenId = randomUUID();
    const { token, secret } = createApiTokenValue(tokenId);
    const tokenHash = hashApiTokenSecret(secret);

    const [created] = await fastify.db
      .insert(apiTokens)
      .values({
        id: tokenId,
        workspaceId,
        createdByUserId: userId,
        name: body.data.name,
        sourceNameHint: body.data.sourceNameHint || null,
        scopes: body.data.scopes,
        tokenHash,
      })
      .returning();

    await fastify.db.insert(auditLogs).values({
      workspaceId,
      userId,
      entityType: "api_token",
      entityId: created.id,
      action: "create",
      afterJson: {
        name: created.name,
        scopes: created.scopes,
        sourceNameHint: created.sourceNameHint,
      },
    });

    const [creator] = await fastify.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return reply.code(201).send({
      token,
      data: mapToken({
        ...created,
        createdByUserName: creator?.name ?? "",
        createdByUserEmail: creator?.email ?? "",
      }),
    });
  });

  fastify.post("/:tokenId/revoke", async (request, reply) => {
    const params = tokenParamsSchema.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error.issues);

    const { workspaceId, tokenId } = params.data;
    const userId = request.user.sub;
    const role = await getMemberRole(fastify.db, workspaceId, userId);
    if (!role) return forbidden(reply);
    if (!ADMIN_PLUS_ROLES.includes(role)) return insufficientRole(reply);

    const [tokenRow] = await fastify.db
      .select()
      .from(apiTokens)
      .where(
        and(eq(apiTokens.id, tokenId), eq(apiTokens.workspaceId, workspaceId)),
      )
      .limit(1);

    if (!tokenRow || isHiddenSystemTokenName(tokenRow.name)) {
      return reply.code(404).send({
        error: "Not found",
        code: ERROR_CODES.API_TOKEN_NOT_FOUND,
        details: "API token not found",
      });
    }

    const revokedAt = tokenRow.revokedAt ?? new Date();
    const [updated] = await fastify.db
      .update(apiTokens)
      .set({ revokedAt })
      .where(
        and(eq(apiTokens.id, tokenId), eq(apiTokens.workspaceId, workspaceId)),
      )
      .returning();

    await fastify.db.insert(auditLogs).values({
      workspaceId,
      userId,
      entityType: "api_token",
      entityId: tokenId,
      action: "revoke",
      beforeJson: {
        name: tokenRow.name,
        scopes: tokenRow.scopes,
        revokedAt: tokenRow.revokedAt?.toISOString() ?? null,
      },
      afterJson: {
        revokedAt: updated.revokedAt?.toISOString() ?? null,
      },
    });

    return reply.send({
      id: updated.id,
      revokedAt: updated.revokedAt?.toISOString() ?? null,
    });
  });
};

export default apiTokenRoutes;
