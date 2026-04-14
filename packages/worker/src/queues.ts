import { Queue } from "bullmq";
import { createRedisConnection } from "./connection.js";

export { QUEUE_NAMES, JOB_NAMES } from "@nexnote/shared";

const queues: Queue[] = [];

export function getQueue(name: string): Queue {
  const q = new Queue(name, { connection: createRedisConnection() });
  queues.push(q);
  return q;
}

export async function closeAllQueues(): Promise<void> {
  await Promise.all(queues.map((q) => q.close()));
  queues.length = 0;
}
