import type { Worker } from "bullmq";
import {
  createRouteClassifierWorker,
  createPatchGeneratorWorker,
  createTripleExtractorWorker,
  createPublishRendererWorker,
} from "./workers/index.js";
import { closeAllQueues } from "./queues.js";

const workers: Worker[] = [];

function startWorkers(): void {
  console.log("[worker] Starting NexNote workers...");
  workers.push(createRouteClassifierWorker());
  workers.push(createPatchGeneratorWorker());
  workers.push(createTripleExtractorWorker());
  workers.push(createPublishRendererWorker());
  console.log(`[worker] ${workers.length} worker(s) running.`);
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] Received ${signal}, shutting down...`);
  await Promise.all(workers.map((w) => w.close()));
  await closeAllQueues();
  console.log("[worker] All workers stopped.");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

startWorkers();
