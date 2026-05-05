import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@wekiflow/db/client";
import { pageLinks, pagePaths, pageRevisions, pages } from "@wekiflow/db";
import {
  extractPageLinks,
  pageLinkTargetLookupKeys,
  type PageLinkExtractorJobData,
  type PageLinkExtractorJobResult,
} from "@wekiflow/shared";
import { createRedisConnection } from "../connection.js";
import { QUEUE_NAMES } from "../queues.js";
import { createJobLogger } from "../logger.js";

type Db = ReturnType<typeof getDb>;

async function resolveTargetPages(
  db: Db,
  workspaceId: string,
  targets: string[],
): Promise<Map<string, string>> {
  const uniqueTargets = [...new Set(targets)].filter(Boolean);
  const exactLookupKeys = [
    ...new Set(
      uniqueTargets.flatMap((target) => [
        ...pageLinkTargetLookupKeys(target, { preserveCase: true }),
        ...pageLinkTargetLookupKeys(target),
      ]),
    ),
  ];
  const targetMap = new Map<string, string>();
  if (exactLookupKeys.length === 0) return targetMap;

  const rows = await db
    .select({
      id: pages.id,
      slug: pages.slug,
      title: pages.title,
      path: pagePaths.path,
    })
    .from(pages)
    .leftJoin(
      pagePaths,
      and(eq(pagePaths.pageId, pages.id), eq(pagePaths.isCurrent, true)),
    )
    .where(
      and(
        eq(pages.workspaceId, workspaceId),
        isNull(pages.deletedAt),
        or(
          inArray(pages.slug, exactLookupKeys),
          inArray(pages.title, exactLookupKeys),
          inArray(pagePaths.path, exactLookupKeys),
        )!,
      ),
    );

  const resolvedByKey = new Map<string, string>();
  for (const row of rows) {
    for (const key of [
      ...pageLinkTargetLookupKeys(row.slug),
      ...pageLinkTargetLookupKeys(row.title),
      ...(row.path ? pageLinkTargetLookupKeys(row.path) : []),
    ]) {
      if (!resolvedByKey.has(key)) resolvedByKey.set(key, row.id);
    }
  }

  let unresolvedTargets = uniqueTargets;
  for (const target of unresolvedTargets) {
    for (const key of pageLinkTargetLookupKeys(target)) {
      const pageId = resolvedByKey.get(key);
      if (pageId) {
        targetMap.set(target, pageId);
        break;
      }
    }
  }

  unresolvedTargets = uniqueTargets.filter((target) => !targetMap.has(target));
  if (unresolvedTargets.length > 0) {
    const titleLookupKeys = [
      ...new Set(
        unresolvedTargets.flatMap((target) => pageLinkTargetLookupKeys(target)),
      ),
    ];
    const titleRows = await db
      .select({
        id: pages.id,
        title: pages.title,
      })
      .from(pages)
      .where(
        and(
          eq(pages.workspaceId, workspaceId),
          isNull(pages.deletedAt),
          inArray(sql<string>`lower(${pages.title})`, titleLookupKeys),
        ),
      );

    const titleMap = new Map<string, string>();
    for (const row of titleRows) {
      for (const key of pageLinkTargetLookupKeys(row.title)) {
        if (!titleMap.has(key)) titleMap.set(key, row.id);
      }
    }
    for (const target of unresolvedTargets) {
      for (const key of pageLinkTargetLookupKeys(target)) {
        const pageId = titleMap.get(key);
        if (pageId) {
          targetMap.set(target, pageId);
          break;
        }
      }
    }
  }
  return targetMap;
}

export function createPageLinkExtractorWorker(): Worker {
  const db = getDb();

  const worker = new Worker<
    PageLinkExtractorJobData,
    PageLinkExtractorJobResult
  >(
    QUEUE_NAMES.LINKS,
    async (job: Job<PageLinkExtractorJobData>) => {
      const { pageId, revisionId, workspaceId } = job.data;
      const log = createJobLogger("page-link-extractor", job.id);

      log.info({ pageId, revisionId }, "Extracting page links");

      const [revision] = await db
        .select({
          contentMd: pageRevisions.contentMd,
          sourcePageId: pageRevisions.pageId,
          currentRevisionId: pages.currentRevisionId,
          workspaceId: pages.workspaceId,
          deletedAt: pages.deletedAt,
        })
        .from(pageRevisions)
        .innerJoin(pages, eq(pages.id, pageRevisions.pageId))
        .where(eq(pageRevisions.id, revisionId))
        .limit(1);

      if (
        !revision ||
        revision.sourcePageId !== pageId ||
        revision.workspaceId !== workspaceId
      ) {
        log.warn(
          { pageId, revisionId, workspaceId },
          "Revision not found, skipping",
        );
        return { pageId, revisionId, linksCreated: 0, brokenLinks: 0 };
      }
      if (revision.deletedAt) {
        await db
          .delete(pageLinks)
          .where(
            and(
              eq(pageLinks.workspaceId, workspaceId),
              eq(pageLinks.sourcePageId, pageId),
            ),
          );
        log.warn(
          { pageId, revisionId, workspaceId },
          "Page deleted, cleared links",
        );
        return { pageId, revisionId, linksCreated: 0, brokenLinks: 0 };
      }
      if (revision.currentRevisionId !== revisionId) {
        log.warn(
          { pageId, revisionId, currentRevisionId: revision.currentRevisionId },
          "Revision is no longer current, skipping",
        );
        return { pageId, revisionId, linksCreated: 0, brokenLinks: 0 };
      }

      await job.updateProgress(20);

      const extracted = extractPageLinks(revision.contentMd);
      const targetMap = await resolveTargetPages(
        db,
        workspaceId,
        extracted.map((link) => link.targetSlug),
      );

      await job.updateProgress(60);

      const result = await db.transaction(async (tx) => {
        await tx
          .delete(pageLinks)
          .where(
            and(
              eq(pageLinks.workspaceId, workspaceId),
              eq(pageLinks.sourcePageId, pageId),
            ),
          );

        if (extracted.length === 0) {
          return { linksCreated: 0, brokenLinks: 0 };
        }

        let brokenLinks = 0;
        const values = extracted.map((link) => {
          const targetPageId = targetMap.get(link.targetSlug) ?? null;
          if (!targetPageId) brokenLinks += 1;
          return {
            workspaceId,
            sourcePageId: pageId,
            sourceRevisionId: revisionId,
            targetPageId,
            targetSlug: link.targetSlug,
            linkText: link.linkText,
            linkType: link.linkType,
            positionInMd: link.positionInMd,
          };
        });

        await tx.insert(pageLinks).values(values).onConflictDoNothing();
        return { linksCreated: values.length, brokenLinks };
      });

      await job.updateProgress(100);

      log.info(
        { pageId, revisionId, ...result },
        "Page link extraction complete",
      );

      return { pageId, revisionId, ...result };
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
    },
  );

  worker.on("completed", (job, result) => {
    const log = createJobLogger("page-link-extractor", job.id);
    log.info(
      {
        pageId: result.pageId,
        revisionId: result.revisionId,
        linksCreated: result.linksCreated,
        brokenLinks: result.brokenLinks,
      },
      "Job completed",
    );
  });

  worker.on("failed", (job, err) => {
    const log = createJobLogger("page-link-extractor", job?.id);
    log.error({ err, pageId: job?.data?.pageId }, "Job failed");
  });

  return worker;
}
