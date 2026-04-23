import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { testEnvPath } from "./paths.ts";

const globalKey = "__wekiflow_test_env_loaded__";

function trimEnvValue(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    delete process.env[name];
    return undefined;
  }

  process.env[name] = trimmed;
  return trimmed;
}

if (!(globalThis as Record<string, unknown>)[globalKey]) {
  if (existsSync(testEnvPath)) {
    const parsed = parseEnv(readFileSync(testEnvPath, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      process.env[key] = value;
    }
  }

  const nodeEnv = trimEnvValue("NODE_ENV") ?? "test";
  const aiTestMode = trimEnvValue("AI_TEST_MODE") ?? "mock";
  const apiHost = trimEnvValue("API_HOST") ?? "127.0.0.1";
  const apiPort = trimEnvValue("API_PORT") ?? "3001";
  const webPort = trimEnvValue("WEB_PORT") ?? "5173";
  const redisUrl = trimEnvValue("REDIS_URL") ?? "redis://127.0.0.1:6379/15";
  const e2eBaseUrl =
    trimEnvValue("E2E_BASE_URL") ?? `http://${apiHost}:${webPort}`;

  process.env.NODE_ENV = nodeEnv;
  process.env.AI_TEST_MODE = aiTestMode;
  process.env.API_HOST = apiHost;
  process.env.API_PORT = apiPort;
  process.env.WEB_PORT = webPort;
  process.env.REDIS_URL = redisUrl;
  process.env.E2E_BASE_URL = e2eBaseUrl;

  (globalThis as Record<string, unknown>)[globalKey] = true;
}
