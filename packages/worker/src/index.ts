import type { Worker } from "bullmq";
import {
  createRouteClassifierWorker,
  createPatchGeneratorWorker,
  createTripleExtractorWorker,
  createPublishRendererWorker,
} from "./workers/index.js";
import { closeAllQueues } from "./queues.js";
import { logger } from "./logger.js";

const workers: Worker[] = [];

function startWorkers(): void {
  logger.info("Starting NexNote workers...");
  workers.push(createRouteClassifierWorker());
  workers.push(createPatchGeneratorWorker());
  workers.push(createTripleExtractorWorker());
  workers.push(createPublishRendererWorker());
  logger.info({ count: workers.length }, "Workers running");
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutting down...");
  await Promise.all(workers.map((w) => w.close()));
  await closeAllQueues();
  logger.info("All workers stopped");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

startWorkers();
