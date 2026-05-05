import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
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
          inArray(pages.slug, exactLookupKeys),
          inArray(pages.title, exactLookupKeys),
          inArray(pagePaths.path, exactLookupKeys),
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

async function backfillPageLinks(): Promise<void> {
  const db = getDb();
  let lastPageId: string | null = null;
  let processed = 0;
  let inserted = 0;
  let broken = 0;

  await db.delete(pageLinks).where(sql`
    NOT EXISTS (
      SELECT 1
      FROM "pages" p
      WHERE p."id" = "page_links"."source_page_id"
        AND p."deleted_at" IS NULL
        AND p."current_revision_id" = "page_links"."source_revision_id"
    )
  `);

  for (;;) {
    const conditions = [
      isNull(pages.deletedAt),
      isNotNull(pages.currentRevisionId),
    ];
    if (lastPageId) conditions.push(gt(pages.id, lastPageId));

    const rows = await db
      .select({
        pageId: pages.id,
        workspaceId: pages.workspaceId,
        revisionId: pages.currentRevisionId,
        contentMd: pageRevisions.contentMd,
      })
      .from(pages)
      .innerJoin(pageRevisions, eq(pageRevisions.id, pages.currentRevisionId))
      .where(and(...conditions))
      .orderBy(asc(pages.id))
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;

    for (const row of rows) {
      if (!row.revisionId) continue;
      const extracted = extractPageLinks(row.contentMd ?? "");
      const targetMap = await resolveTargetPages(
        db,
        row.workspaceId,
        extracted.map((link) => link.targetSlug),
      );

      await db
        .delete(pageLinks)
        .where(
          and(
            eq(pageLinks.workspaceId, row.workspaceId),
            eq(pageLinks.sourcePageId, row.pageId),
          ),
        );
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

    lastPageId = rows[rows.length - 1]?.pageId ?? lastPageId;
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
