import "./load-test-env.ts";

import type { FastifyInstance } from "fastify";
import type { Worker } from "bullmq";
import { buildApp } from "../../packages/api/src/app.ts";
import {
  createPatchGeneratorWorker,
  createPublishRendererWorker,
  createRouteClassifierWorker,
  createSearchIndexUpdaterWorker,
  createTripleExtractorWorker,
} from "../../packages/worker/src/workers/index.ts";
import { closeAllQueues } from "../../packages/worker/src/queues.ts";
import { closeConnection } from "../../packages/db/src/client.ts";

export interface IntegrationStack {
  app: FastifyInstance;
  workers: Worker[];
  stop: () => Promise<void>;
}

export async function startIntegrationStack(): Promise<IntegrationStack> {
  const app = await buildApp();
  const workers = [
    createRouteClassifierWorker(),
    createPatchGeneratorWorker(),
    createTripleExtractorWorker(),
    createPublishRendererWorker(),
    createSearchIndexUpdaterWorker(),
  ];

  return {
    app,
    workers,
    async stop() {
      await Promise.allSettled(workers.map((worker) => worker.close()));
      await app.close();
      await closeAllQueues();
      await closeConnection();
    },
  };
}
