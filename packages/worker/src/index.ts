import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import type { Worker } from "bullmq";
import {
  createRouteClassifierWorker,
  createPatchGeneratorWorker,
  createTripleExtractorWorker,
  createPublishRendererWorker,
  createSearchIndexUpdaterWorker,
  createContentReformatterWorker,
  createSynthesisGeneratorWorker,
} from "./workers/index.js";
import { closeAllQueues } from "./queues.js";
import { logger } from "./logger.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(currentDir, "../../../.env");

function loadEnvFileWithoutOverrides(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }

  const parsed = parseEnv(readFileSync(filePath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    process.env[key] ??= value;
  }
}

if (existsSync(envFile)) {
  loadEnvFileWithoutOverrides(envFile);
}

const workers: Worker[] = [];

function startWorkers(): void {
  logger.info("Starting WekiFlow workers...");
  workers.push(createRouteClassifierWorker());
  workers.push(createPatchGeneratorWorker());
  workers.push(createTripleExtractorWorker());
  workers.push(createPublishRendererWorker());
  workers.push(createSearchIndexUpdaterWorker());
  workers.push(createContentReformatterWorker());
  if (process.env["ENABLE_SYNTHESIS_WORKER"] === "true") {
    workers.push(createSynthesisGeneratorWorker());
    logger.info("Synthesis worker enabled via ENABLE_SYNTHESIS_WORKER");
  }
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
