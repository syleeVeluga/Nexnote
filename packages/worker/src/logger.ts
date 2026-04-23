import { pino } from "pino";

export const logger = pino({
  name: "wekiflow-worker",
  level: process.env["LOG_LEVEL"] ?? "info",
});

export function createJobLogger(workerName: string, jobId?: string) {
  return logger.child({ worker: workerName, ...(jobId ? { jobId } : {}) });
}
