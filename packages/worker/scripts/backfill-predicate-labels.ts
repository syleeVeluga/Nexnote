/**
 * Backfill cached predicate display labels for existing triples.
 *
 * Usage:
 *   pnpm --filter @wekiflow/worker exec tsx scripts/backfill-predicate-labels.ts [flags]
 *
 * Flags:
 *   --workspace=<uuid>  Limit to a single workspace
 *   --locale=<ko|en>    Target locale (default: ko)
 *   --overrides-only    Apply curated labels only; skip AI calls
 *   --dry-run           Print discovered predicates without calling AI
 *
 * Environment:
 *   DATABASE_URL and, unless using --overrides-only, one of OPENAI_API_KEY / GEMINI_API_KEY
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { eq } from "drizzle-orm";

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

import { getDb, closeConnection } from "@wekiflow/db/client";
import { triples } from "@wekiflow/db";
import { ensurePredicateDisplayLabels } from "../src/lib/predicate-label-cache.js";

type Args = {
  workspaceId?: string;
  locale: "ko" | "en";
  overridesOnly: boolean;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { locale: "ko", overridesOnly: false, dryRun: false };
  for (const arg of argv) {
    if (arg.startsWith("--workspace=")) out.workspaceId = arg.slice(12);
    else if (arg.startsWith("--locale=")) {
      const locale = arg.slice(9);
      if (locale === "ko" || locale === "en") {
        out.locale = locale;
      } else {
        // eslint-disable-next-line no-console
        console.error(`Unsupported locale: ${locale}`);
        process.exit(1);
      }
    } else if (arg === "--overrides-only") {
      out.overridesOnly = true;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    }
    else if (arg === "--help" || arg === "-h") {
      // eslint-disable-next-line no-console
      console.log(
        "Usage: backfill-predicate-labels.ts [--workspace=<id>] [--locale=<ko|en>] [--overrides-only] [--dry-run]",
      );
      process.exit(0);
    } else {
      // eslint-disable-next-line no-console
      console.error(`Unknown arg: ${arg}`);
      process.exit(1);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = getDb();

  const rows = args.workspaceId
    ? await db
        .select({
          workspaceId: triples.workspaceId,
          predicate: triples.predicate,
        })
        .from(triples)
        .where(eq(triples.workspaceId, args.workspaceId))
    : await db
        .select({
          workspaceId: triples.workspaceId,
          predicate: triples.predicate,
        })
        .from(triples);

  const predicatesByWorkspace = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = predicatesByWorkspace.get(row.workspaceId) ?? new Set<string>();
    set.add(row.predicate);
    predicatesByWorkspace.set(row.workspaceId, set);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[predicate-backfill] Found ${rows.length} triple row(s) across ${predicatesByWorkspace.size} workspace(s).`,
  );

  if (args.dryRun) {
    for (const [workspaceId, predicates] of predicatesByWorkspace) {
      // eslint-disable-next-line no-console
      console.log(
        `  - ws=${workspaceId}: ${predicates.size} predicate(s) -> ${[...predicates].sort().join(", ")}`,
      );
    }
    await closeConnection();
    return;
  }

  let processedWorkspaces = 0;
  for (const [workspaceId, predicates] of predicatesByWorkspace) {
    await ensurePredicateDisplayLabels({
      db,
      workspaceId,
      predicates: [...predicates],
      locale: args.locale,
      allowAI: !args.overridesOnly,
    });
    processedWorkspaces += 1;
    // eslint-disable-next-line no-console
    console.log(
      `[predicate-backfill] ws=${workspaceId} processed ${predicates.size} predicate(s).`,
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `[predicate-backfill] Completed ${processedWorkspaces} workspace(s) for locale=${args.locale}.`,
  );

  await closeConnection();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[predicate-backfill] Failed:", err);
  process.exit(1);
});
