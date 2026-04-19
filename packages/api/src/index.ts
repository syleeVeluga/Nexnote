import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { buildApp } from "./app.js";

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

const API_PORT = Number(process.env.API_PORT ?? 3001);
const API_HOST = process.env.API_HOST ?? "0.0.0.0";

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: API_PORT, host: API_HOST });
    app.log.info(`NexNote API listening on ${API_HOST}:${API_PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
