import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { createRedisConnection } from "../connection.js";
import { QUEUE_NAMES } from "@nexnote/shared";

export function createRouteClassifierWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.INGESTION,
    async (job: Job) => {
      console.log(`[route-classifier] Processing job ${job.id}`);
      return { status: "not_implemented" };
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(
      `[route-classifier] Job ${job?.id ?? "unknown"} failed:`,
      err.message,
    );
  });

  return worker;
}
