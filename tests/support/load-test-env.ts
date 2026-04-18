import { existsSync } from "node:fs";
import { testEnvPath } from "./paths.ts";

const globalKey = "__nexnote_test_env_loaded__";

if (!(globalThis as Record<string, unknown>)[globalKey]) {
  if (existsSync(testEnvPath)) {
    process.loadEnvFile(testEnvPath);
  }

  process.env.NODE_ENV ??= "test";
  process.env.AI_TEST_MODE ??= "mock";
  process.env.API_HOST ??= "127.0.0.1";
  process.env.API_PORT ??= "3001";
  process.env.WEB_PORT ??= "5173";
  process.env.E2E_BASE_URL ??= `http://${process.env.API_HOST}:${process.env.WEB_PORT}`;

  (globalThis as Record<string, unknown>)[globalKey] = true;
}
