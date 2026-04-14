import { Redis } from "ioredis";

const DEFAULT_REDIS_URL = "redis://localhost:6379";

export function createRedisConnection(): Redis {
  const url = process.env["REDIS_URL"] ?? DEFAULT_REDIS_URL;
  return new Redis(url, {
    maxRetriesPerRequest: null,
  });
}
