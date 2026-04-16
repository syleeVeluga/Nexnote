import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

const currentDir = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(currentDir, "../../.env");

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./src/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
