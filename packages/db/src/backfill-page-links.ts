import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { extractPageLinks, pageLinkTargetLookupKeys } from "@wekiflow/shared";
import { closeConnection, getDb } from "./client.js";
import { pageLinks, pagePaths, pageRevisions, pages } from "./schema/index.js";

const BATCH_SIZE = Number.parseInt(
  process.env["PAGE_LINK_BACKFILL_BATCH_SIZE"] ?? "100",
  10,
);

type Db = ReturnType<typeof getDb>;

async function resolveTargetPages(
  db: Db,
  workspaceId: string,
  targets: string[],
): Promise<Map<string, string>> {
  const uniqueTargets = [...new Set(targets)].filter(Boolean);
  const lookupKeys = [
    ...new Set(uniqueTargets.flatMap((target) => pageLinkTargetLookupKeys(target))),
  ];
  const targetMap = new Map<string, string>();
  if (lookupKeys.length === 0) return targetMap;

  const slugRows = await db
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
          inArray(sql<string>`lower(${pages.slug})`, lookupKeys),
          inArray(sql<string>`lower(${pages.title})`, lookupKeys),
          inArray(sql<string>`lower(${pagePaths.path})`, lookupKeys),
        )!,
      ),
    );

  const resolvedByKey = new Map<string, string>();
  for (const row of slugRows) {
    for (const key of [
      ...pageLinkTargetLookupKeys(row.slug),
      ...pageLinkTargetLookupKeys(row.title),
      ...(row.path ? pageLinkTargetLookupKeys(row.path) : []),
    ]) {
      if (!resolvedByKey.has(key)) resolvedByKey.set(key, row.id);
    }
  }

  for (const target of uniqueTargets) {
    for (const key of pageLinkTargetLookupKeys(target)) {
      const pageId = resolvedByKey.get(key);
      if (pageId) {
        targetMap.set(target, pageId);
        break;
      }
    }
  }
  return targetMap;
}

async function backfillPageLinks(): Promise<void> {
  const db = getDb();
  let offset = 0;
  let processed = 0;
  let inserted = 0;
  let broken = 0;

  for (;;) {
    const rows = await db
      .select({
        pageId: pages.id,
        workspaceId: pages.workspaceId,
        revisionId: pages.currentRevisionId,
        contentMd: pageRevisions.contentMd,
      })
      .from(pages)
      .innerJoin(pageRevisions, eq(pageRevisions.id, pages.currentRevisionId))
      .where(and(isNull(pages.deletedAt), isNotNull(pages.currentRevisionId)))
      .limit(BATCH_SIZE)
      .offset(offset);

    if (rows.length === 0) break;

    for (const row of rows) {
      if (!row.revisionId) continue;
      const extracted = extractPageLinks(row.contentMd ?? "");
      const targetMap = await resolveTargetPages(
        db,
        row.workspaceId,
        extracted.map((link) => link.targetSlug),
      );

      await db.delete(pageLinks).where(eq(pageLinks.sourceRevisionId, row.revisionId));
      if (extracted.length > 0) {
        const values = extracted.map((link) => {
          const targetPageId = targetMap.get(link.targetSlug) ?? null;
          if (!targetPageId) broken += 1;
          return {
            workspaceId: row.workspaceId,
            sourcePageId: row.pageId,
            sourceRevisionId: row.revisionId!,
            targetPageId,
            targetSlug: link.targetSlug,
            linkText: link.linkText,
            linkType: link.linkType,
            positionInMd: link.positionInMd,
          };
        });
        await db.insert(pageLinks).values(values).onConflictDoNothing();
        inserted += values.length;
      }
      processed += 1;
    }

    offset += rows.length;
  }

  console.log(
    `Backfilled page links: processed=${processed}, inserted=${inserted}, broken=${broken}`,
  );
}

backfillPageLinks()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeConnection();
  });
