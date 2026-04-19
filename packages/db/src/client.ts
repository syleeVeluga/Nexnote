import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

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

export type Database = ReturnType<typeof createDb>;

let _db: Database | undefined;
let _connection: postgres.Sql | undefined;

function createDb() {
  return drizzle(getConnection(), { schema });
}

export function getConnection(): postgres.Sql {
  if (!_connection) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    _connection = postgres(url);
  }
  return _connection;
}

export function getDb(): Database {
  if (!_db) {
    _db = createDb();
  }
  return _db;
}

export async function closeConnection(): Promise<void> {
  if (_connection) {
    await _connection.end();
    _connection = undefined;
    _db = undefined;
  }
}
