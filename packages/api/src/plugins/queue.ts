import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_NAMES } from "@nexnote/shared";

declare module "fastify" {
  interface FastifyInstance {
    queues: {
      ingestion: Queue;
      extraction: Queue;
    };
  }
}

async function queuePluginImpl(fastify: FastifyInstance) {
  const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";
  const redisOpts = { maxRetriesPerRequest: null };

  const ingestionQueue = new Queue(QUEUE_NAMES.INGESTION, {
    connection: new Redis(redisUrl, redisOpts),
  });
  const extractionQueue = new Queue(QUEUE_NAMES.EXTRACTION, {
    connection: new Redis(redisUrl, redisOpts),
  });

  fastify.decorate("queues", {
    ingestion: ingestionQueue,
    extraction: extractionQueue,
  });

  fastify.addHook("onClose", async () => {
    await Promise.all([ingestionQueue.close(), extractionQueue.close()]);
  });
}

export const queuePlugin = fp(queuePluginImpl, {
  name: "nexnote-queue",
});
