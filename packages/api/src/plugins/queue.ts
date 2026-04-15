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
      publish: Queue;
    };
  }
}

function createConnection(): Redis {
  const url = process.env["REDIS_URL"] ?? "redis://localhost:6379";
  return new Redis(url, { maxRetriesPerRequest: null });
}

async function queuePluginImpl(fastify: FastifyInstance) {
  const ingestionQueue = new Queue(QUEUE_NAMES.INGESTION, {
    connection: createConnection(),
  });
  const extractionQueue = new Queue(QUEUE_NAMES.EXTRACTION, {
    connection: createConnection(),
  });
  const publishQueue = new Queue(QUEUE_NAMES.PUBLISH, {
    connection: createConnection(),
  });

  fastify.decorate("queues", {
    ingestion: ingestionQueue,
    extraction: extractionQueue,
    publish: publishQueue,
  });

  fastify.addHook("onClose", async () => {
    await Promise.all([
      ingestionQueue.close(),
      extractionQueue.close(),
      publishQueue.close(),
    ]);
  });
}

export const queuePlugin = fp(queuePluginImpl, {
  name: "nexnote-queue",
});
