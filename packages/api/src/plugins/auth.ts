import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import fjwt from "@fastify/jwt";
import { eq } from "drizzle-orm";
import { apiTokens } from "@wekiflow/db";
import type { ApiTokenScope } from "@wekiflow/shared";
import { parseApiTokenValue, verifyApiTokenSecret } from "../lib/api-tokens.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; email: string };
    user: { sub: string; email: string };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
    authenticateJwtOrApiToken: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }

  interface FastifyRequest {
    apiToken?: {
      id: string;
      workspaceId: string;
      createdByUserId: string;
      scopes: ApiTokenScope[];
    };
  }
}

async function authPluginImpl(fastify: FastifyInstance) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET environment variable is required");
  }

  await fastify.register(fjwt, {
    secret,
    sign: { expiresIn: "7d" },
  });

  fastify.decorate(
    "authenticate",
    async function (request: FastifyRequest, reply: FastifyReply) {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({
          error: "Unauthorized",
          code: "UNAUTHORIZED",
          details: "Invalid or expired token",
        });
      }
    },
  );

  fastify.decorate(
    "authenticateJwtOrApiToken",
    async function (request: FastifyRequest, reply: FastifyReply) {
      const header = request.headers.authorization;
      const bearer =
        typeof header === "string" && header.startsWith("Bearer ")
          ? header.slice("Bearer ".length).trim()
          : null;
      const parsed = bearer ? parseApiTokenValue(bearer) : null;

      if (parsed) {
        const [row] = await fastify.db
          .select({
            id: apiTokens.id,
            workspaceId: apiTokens.workspaceId,
            createdByUserId: apiTokens.createdByUserId,
            tokenHash: apiTokens.tokenHash,
            scopes: apiTokens.scopes,
            revokedAt: apiTokens.revokedAt,
          })
          .from(apiTokens)
          .where(eq(apiTokens.id, parsed.tokenId))
          .limit(1);

        if (
          row &&
          !row.revokedAt &&
          verifyApiTokenSecret(parsed.secret, row.tokenHash)
        ) {
          await fastify.db
            .update(apiTokens)
            .set({ lastUsedAt: new Date() })
            .where(eq(apiTokens.id, row.id));

          request.apiToken = {
            id: row.id,
            workspaceId: row.workspaceId,
            createdByUserId: row.createdByUserId,
            scopes: row.scopes as ApiTokenScope[],
          };
          request.user = {
            sub: row.createdByUserId,
            email: "",
          };
          return;
        }
      }

      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({
          error: "Unauthorized",
          code: "UNAUTHORIZED",
          details: "Invalid or expired token",
        });
      }
    },
  );
}

export const authPlugin = fp(authPluginImpl, {
  name: "wekiflow-auth",
  dependencies: ["wekiflow-db"],
});
