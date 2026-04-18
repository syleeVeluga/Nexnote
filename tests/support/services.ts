import "./load-test-env.ts";

import { migrate } from "drizzle-orm/postgres-js/migrator";
import Redis from "ioredis";
import { sql } from "drizzle-orm";
import {
  closeConnection,
  getConnection,
  getDb,
} from "../../packages/db/src/client.ts";
import { waitFor } from "./wait.ts";

export async function waitForDatabase(): Promise<void> {
  await waitFor(
    async () => {
      try {
        await getDb().execute(sql.raw("select 1"));
        return true;
      } catch {
        return false;
      }
    },
    { timeoutMs: 30_000, description: "Postgres readiness" },
  );
}

export async function waitForRedis(): Promise<void> {
  const client = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
    maxRetriesPerRequest: null,
  });

  try {
    await waitFor(
      async () => {
        try {
          await client.ping();
          return true;
        } catch {
          return false;
        }
      },
      { timeoutMs: 30_000, description: "Redis readiness" },
    );
  } finally {
    client.disconnect();
  }
}

export async function ensureExternalServices(): Promise<void> {
  await Promise.all([waitForDatabase(), waitForRedis()]);
}

export async function runMigrations(): Promise<void> {
  await migrate(getDb(), {
    migrationsFolder: "./packages/db/src/migrations",
  });
}

export async function resetDatabase(): Promise<void> {
  const connection = getConnection();
  const rows = await connection<{ tablename: string }[]>`
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename <> '__drizzle_migrations'
  `;

  if (rows.length === 0) {
    return;
  }

  const tableList = rows
    .map((row) => `"public"."${row.tablename}"`)
    .join(", ");

  await connection.unsafe(`truncate table ${tableList} restart identity cascade`);
}

export async function resetRedis(): Promise<void> {
  const client = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
    maxRetriesPerRequest: null,
  });

  try {
    await client.flushdb();
  } finally {
    client.disconnect();
  }
}

export async function prepareTestDatabase(): Promise<void> {
  await ensureExternalServices();
  await runMigrations();
}

export async function resetTestState(): Promise<void> {
  await Promise.all([resetDatabase(), resetRedis()]);
}

export async function closeTestConnections(): Promise<void> {
  await closeConnection();
}
