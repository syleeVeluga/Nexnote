/**
 * Re-enqueue triple extraction for pages.
 *
 * Usage:
 *   pnpm --filter @wekiflow/worker exec tsx scripts/reextract-triples.ts [flags]
 *
 * Flags:
 *   --workspace=<uuid>  Limit to a single workspace (default: all workspaces)
 *   --page=<uuid>       Limit to a single page (repeatable)
 *   --purge             Delete existing triples for targeted pages before enqueuing.
 *                       Triples have no dedup constraint, so without --purge the old
 *                       (e.g. English-transliterated) rows will coexist with new ones.
 *   --dry-run           List what would be enqueued/purged without mutating anything
 *
 * Environment:
 *   DATABASE_URL, REDIS_URL
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

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
import { pages, triples, tripleMentions } from "@wekiflow/db";
import {
  QUEUE_NAMES,
  JOB_NAMES,
  DEFAULT_JOB_OPTIONS,
} from "@wekiflow/shared";
import type { TripleExtractorJobData } from "@wekiflow/shared";
import { getQueue, closeAllQueues } from "../src/queues.js";

type Args = {
  workspaceId?: string;
  pageIds: string[];
  purge: boolean;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { pageIds: [], purge: false, dryRun: false };
  for (const arg of argv) {
    if (arg.startsWith("--workspace=")) out.workspaceId = arg.slice(12);
    else if (arg.startsWith("--page=")) out.pageIds.push(arg.slice(7));
    else if (arg === "--purge") out.purge = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      // eslint-disable-next-line no-console
      console.log(
        "Usage: reextract-triples.ts [--workspace=<id>] [--page=<id>] [--purge] [--dry-run]",
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

  const whereClauses = [isNotNull(pages.currentRevisionId)];
  if (args.workspaceId) whereClauses.push(eq(pages.workspaceId, args.workspaceId));
  if (args.pageIds.length > 0) whereClauses.push(inArray(pages.id, args.pageIds));

  const rows = await db
    .select({
      id: pages.id,
      workspaceId: pages.workspaceId,
      currentRevisionId: pages.currentRevisionId,
      title: pages.title,
    })
    .from(pages)
    .where(and(...whereClauses));

  // eslint-disable-next-line no-console
  console.log(
    `[reextract] Found ${rows.length} page(s) with a current revision.`,
  );
  if (args.dryRun) {
    for (const p of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `  - ${p.id} (ws=${p.workspaceId}) "${p.title}" rev=${p.currentRevisionId}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      `[reextract] DRY RUN — would ${args.purge ? "purge existing triples and " : ""}enqueue ${rows.length} triple-extractor job(s).`,
    );
    await closeConnection();
    return;
  }

  if (rows.length === 0) {
    // eslint-disable-next-line no-console
    console.log("[reextract] Nothing to do.");
    await closeConnection();
    return;
  }

  if (args.purge) {
    const pageIds = rows.map((r) => r.id);
    // eslint-disable-next-line no-console
    console.log(`[reextract] Purging triples for ${pageIds.length} page(s)...`);
    // Delete in batches of 500 to keep the IN list sane.
    const BATCH = 500;
    let purgedTriples = 0;
    let purgedMentions = 0;
    for (let i = 0; i < pageIds.length; i += BATCH) {
      const slice = pageIds.slice(i, i + BATCH);
      const delMentions = await db
        .delete(tripleMentions)
        .where(inArray(tripleMentions.pageId, slice))
        .returning({ id: tripleMentions.id });
      const delTriples = await db
        .delete(triples)
        .where(inArray(triples.sourcePageId, slice))
        .returning({ id: triples.id });
      purgedMentions += delMentions.length;
      purgedTriples += delTriples.length;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[reextract] Purged ${purgedTriples} triple(s) and ${purgedMentions} mention(s).`,
    );
  }

  const extractionQueue = getQueue(QUEUE_NAMES.EXTRACTION);
  let enqueued = 0;
  for (const p of rows) {
    if (!p.currentRevisionId) continue;
    const data: TripleExtractorJobData = {
      workspaceId: p.workspaceId,
      pageId: p.id,
      revisionId: p.currentRevisionId,
    };
    await extractionQueue.add(
      JOB_NAMES.TRIPLE_EXTRACTOR,
      data,
      DEFAULT_JOB_OPTIONS,
    );
    enqueued += 1;
  }

  // eslint-disable-next-line no-console
  console.log(`[reextract] Enqueued ${enqueued} triple-extractor job(s).`);

  await closeAllQueues();
  await closeConnection();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[reextract] Failed:", err);
  process.exit(1);
});
