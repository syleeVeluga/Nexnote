import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_NAMES } from "@nexnote/shared";

declare module "fastify" {
  interface FastifyInstance {
    queues: {
      ingestion: Queue;
      patch: Queue;
      extraction: Queue;
      publish: Queue;
      search: Queue;
      reformat: Queue;
    };
    redis: Redis;
  }
}

function createConnection(): Redis {
  const url = process.env["REDIS_URL"] ?? "redis://localhost:6379";
  return new Redis(url, { maxRetriesPerRequest: null });
}

async function queuePluginImpl(fastify: FastifyInstance) {
  const sharedRedis = createConnection();

  const ingestionQueue = new Queue(QUEUE_NAMES.INGESTION, {
    connection: createConnection(),
  });
  const patchQueue = new Queue(QUEUE_NAMES.PATCH, {
    connection: createConnection(),
  });
  const extractionQueue = new Queue(QUEUE_NAMES.EXTRACTION, {
    connection: createConnection(),
  });
  const publishQueue = new Queue(QUEUE_NAMES.PUBLISH, {
    connection: createConnection(),
  });
  const searchQueue = new Queue(QUEUE_NAMES.SEARCH, {
    connection: createConnection(),
  });
  const reformatQueue = new Queue(QUEUE_NAMES.REFORMAT, {
    connection: createConnection(),
  });

  fastify.decorate("redis", sharedRedis);
  fastify.decorate("queues", {
    ingestion: ingestionQueue,
    patch: patchQueue,
    extraction: extractionQueue,
    publish: publishQueue,
    search: searchQueue,
    reformat: reformatQueue,
  });

  fastify.addHook("onClose", async () => {
    await Promise.all([
      ingestionQueue.close(),
      patchQueue.close(),
      extractionQueue.close(),
      publishQueue.close(),
      searchQueue.close(),
      reformatQueue.close(),
      sharedRedis.quit(),
    ]);
  });
}

export const queuePlugin = fp(queuePluginImpl, {
  name: "nexnote-queue",
});
