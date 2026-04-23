import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/migrations"
);

export async function runMigrations(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
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
