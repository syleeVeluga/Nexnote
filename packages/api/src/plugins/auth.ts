import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import fjwt from "@fastify/jwt";

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
}

export const authPlugin = fp(authPluginImpl, {
  name: "nexnote-auth",
  dependencies: ["nexnote-db"],
});
