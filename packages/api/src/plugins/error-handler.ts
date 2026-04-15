import type { FastifyInstance, FastifyError } from "fastify";
import fp from "fastify-plugin";

async function errorHandlerImpl(fastify: FastifyInstance) {
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, "Internal server error");
    } else {
      request.log.warn({ err: error }, `Client error ${statusCode}`);
    }

    return reply.code(statusCode).send({
      error: error.message || "Internal Server Error",
      code: error.code ?? "INTERNAL_ERROR",
      statusCode,
      ...(process.env.NODE_ENV !== "production" && error.stack
        ? { stack: error.stack }
        : {}),
    });
  });

  fastify.setNotFoundHandler((request, reply) => {
    request.log.warn(`Route not found: ${request.method} ${request.url}`);
    return reply.code(404).send({
      error: "Route not found",
      code: "ROUTE_NOT_FOUND",
      statusCode: 404,
    });
  });
}

export const errorHandlerPlugin = fp(errorHandlerImpl, {
  name: "nexnote-error-handler",
});
