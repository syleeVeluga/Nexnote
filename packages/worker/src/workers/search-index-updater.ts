import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { createRedisConnection } from "../connection.js";
import { QUEUE_NAMES } from "../queues.js";
import { createJobLogger } from "../logger.js";
import { getDb } from "@nexnote/db/client";
import { pages, pageRevisions } from "@nexnote/db";
import type {
  SearchIndexUpdaterJobData,
  SearchIndexUpdaterJobResult,
} from "@nexnote/shared";

/**
 * search-index-updater worker
 *
 * Materialises a PostgreSQL `tsvector` search column on `pages` so that
 * the search endpoint can do fast `@@` queries instead of computing
 * `to_tsvector` on every request.
 *
 * The column `pages.search_vector` (tsvector) is created by a migration.
 * If the column does not exist yet the worker skips gracefully so the
 * system remains functional while the migration is pending.
 */
export function createSearchIndexUpdaterWorker(): Worker {
  const db = getDb();

  const worker = new Worker<SearchIndexUpdaterJobData, SearchIndexUpdaterJobResult>(
    QUEUE_NAMES.SEARCH,
    async (job: Job<SearchIndexUpdaterJobData>) => {
      const { pageId, revisionId, workspaceId } = job.data;
      const log = createJobLogger("search-index-updater", job.id);

      log.info({ pageId, revisionId }, "Updating search index");

      // Fetch the revision content
      const [revision] = await db
        .select({ contentMd: pageRevisions.contentMd })
        .from(pageRevisions)
        .where(eq(pageRevisions.id, revisionId))
        .limit(1);

      if (!revision) {
        log.warn({ revisionId }, "Revision not found, skipping");
        return { pageId, indexed: false };
      }

      const [page] = await db
        .select({ title: pages.title })
        .from(pages)
        .where(eq(pages.id, pageId))
        .limit(1);

      if (!page) {
        log.warn({ pageId }, "Page not found, skipping");
        return { pageId, indexed: false };
      }

      // Build the tsvector from title + content_md and update the search_vector column.
      // The column is optional (may not exist in older migrations) — catch gracefully.
      try {
        await db.execute(sql`
          UPDATE pages
          SET search_vector = to_tsvector(
            'simple',
            coalesce(${page.title}, '') || ' ' || coalesce(${revision.contentMd}, '')
          )
          WHERE id = ${pageId}
            AND workspace_id = ${workspaceId}
        `);
        log.info({ pageId }, "Search vector updated");
        return { pageId, indexed: true };
      } catch (err) {
        // If the column doesn't exist yet (migration not run) log a warning and continue
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("search_vector") || msg.includes("column")) {
          log.warn({ pageId }, "search_vector column missing — skipping update");
          return { pageId, indexed: false };
        }
        throw err;
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
    },
  );

  worker.on("completed", (job, result) => {
    const log = createJobLogger("search-index-updater", job.id);
    log.info({ pageId: result.pageId, indexed: result.indexed }, "Job completed");
  });

  worker.on("failed", (job, err) => {
    const log = createJobLogger("search-index-updater", job?.id);
    log.error({ err }, "Job failed");
  });

  return worker;
}
