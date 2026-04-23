import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { createRedisConnection } from "../connection.js";
import { QUEUE_NAMES } from "../queues.js";
import { createJobLogger } from "../logger.js";
import { getDb } from "@wekiflow/db/client";
import { pages, pageRevisions } from "@wekiflow/db";
import type {
  SearchIndexUpdaterJobData,
  SearchIndexUpdaterJobResult,
} from "@wekiflow/shared";

/**
 * search-index-updater worker
 *
 * Materialises a PostgreSQL tsvector search column on pages so that search
 * endpoints can do fast `@@` queries. Column + GIN index are created by
 * migration 0003_supervision_loop_foundations.
 */
export function createSearchIndexUpdaterWorker(): Worker {
  const db = getDb();

  const worker = new Worker<SearchIndexUpdaterJobData, SearchIndexUpdaterJobResult>(
    QUEUE_NAMES.SEARCH,
    async (job: Job<SearchIndexUpdaterJobData>) => {
      const { pageId, revisionId, workspaceId } = job.data;
      const log = createJobLogger("search-index-updater", job.id);

      log.info({ pageId, revisionId }, "Updating search index");

      // Fetch page title and revision content in a single query
      const [row] = await db
        .select({ title: pages.title, contentMd: pageRevisions.contentMd })
        .from(pages)
        .innerJoin(pageRevisions, eq(pageRevisions.id, revisionId))
        .where(eq(pages.id, pageId))
        .limit(1);

      if (!row) {
        log.warn({ pageId, revisionId }, "Page or revision not found, skipping");
        return { pageId, indexed: false };
      }

      // Build the tsvector from title + content_md and update the search_vector column.
      await db.execute(sql`
        UPDATE pages
        SET search_vector = to_tsvector(
          'simple',
          coalesce(${row.title}, '') || ' ' || coalesce(${row.contentMd}, '')
        )
        WHERE id = ${pageId}
          AND workspace_id = ${workspaceId}
      `);
      log.info({ pageId }, "Search vector updated");
      return { pageId, indexed: true };
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
