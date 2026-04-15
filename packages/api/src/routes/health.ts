import type { FastifyPluginAsync } from "fastify";
import { sql } from "drizzle-orm";
import type { Redis } from "ioredis";

interface CheckResult {
  status: "ok" | "error";
  latencyMs: number;
  error?: string;
}

async function checkDb(db: { execute: (q: ReturnType<typeof sql.raw>) => Promise<unknown> }): Promise<CheckResult> {
  const start = performance.now();
  try {
    await db.execute(sql.raw("SELECT 1"));
    return { status: "ok", latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    return {
      status: "error",
      latencyMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

async function checkRedis(client: Redis): Promise<CheckResult> {
  const start = performance.now();
  try {
    await client.ping();
    return { status: "ok", latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    return {
      status: "error",
      latencyMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/health", async () => {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  });

  fastify.get("/health/ready", async (_request, reply) => {
    const [db, redis] = await Promise.all([
      checkDb(fastify.db),
      checkRedis(fastify.redis),
    ]);

    const allOk = db.status === "ok" && redis.status === "ok";

    return reply.code(allOk ? 200 : 503).send({
      status: allOk ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      checks: { db, redis },
    });
  });
};

export default healthRoutes;
