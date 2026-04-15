import { Queue } from "bullmq";
import { createRedisConnection } from "./connection.js";

export { QUEUE_NAMES, JOB_NAMES } from "@nexnote/shared";

const queueCache = new Map<string, Queue>();

export function getQueue(name: string): Queue {
  let q = queueCache.get(name);
  if (!q) {
    q = new Queue(name, { connection: createRedisConnection() });
    queueCache.set(name, q);
  }
  return q;
}

export async function closeAllQueues(): Promise<void> {
  await Promise.all([...queueCache.values()].map((q) => q.close()));
  queueCache.clear();
}
