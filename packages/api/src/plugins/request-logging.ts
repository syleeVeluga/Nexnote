import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

async function requestLoggingImpl(fastify: FastifyInstance) {
  fastify.addHook("onResponse", (request, reply, done) => {
    const duration = reply.elapsedTime;
    const level = reply.statusCode >= 500 ? "error" : reply.statusCode >= 400 ? "warn" : "info";

    request.log[level]({
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: Math.round(duration),
      userAgent: request.headers["user-agent"],
      userId: (request as { user?: { sub?: string } }).user?.sub ?? null,
    }, "request completed");

    done();
  });
}

export const requestLoggingPlugin = fp(requestLoggingImpl, {
  name: "wekiflow-request-logging",
});
