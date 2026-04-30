import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;

const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/migrations",
);

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function configureMigrationSession(sql: SqlClient): Promise<void> {
  const lockTimeoutMs = readPositiveIntegerEnv(
    "MIGRATION_LOCK_TIMEOUT_MS",
    10_000,
  );
  const statementTimeoutMs = readPositiveIntegerEnv(
    "MIGRATION_STATEMENT_TIMEOUT_MS",
    300_000,
  );

  await sql`select set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, false)`;
  await sql`select set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, false)`;
  console.log(
    `Migration timeouts configured: lock=${lockTimeoutMs}ms statement=${statementTimeoutMs}ms.`,
  );
}

export async function runMigrations(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
    await configureMigrationSession(sql);
    await migrate(drizzle(sql), { migrationsFolder });
    console.log("Migrations complete.");
  } finally {
    await sql.end();
  }
}

// standalone entrypoint: node packages/db/dist/migrate.js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runMigrations().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
