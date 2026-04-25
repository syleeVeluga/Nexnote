import { pages } from "./schema/index.js";
import type { Database } from "./client.js";

// Race-safe page insert with automatic slug disambiguation.
// Tries {baseSlug}, {baseSlug}-2, -3, … re-catching the
// `pages_workspace_slug_active_uk` unique-violation until the insert succeeds.
// Used by route-classifier auto-create and apply-decision approve-create
// so two ingestions with the same titleHint don't deadlock the queue
// and don't race each other to the same slug.

const SLUG_ALLOC_MAX_ATTEMPTS = 20;
const PG_UNIQUE_VIOLATION = "23505";
const PAGES_SLUG_CONSTRAINT = "pages_workspace_slug_active_uk";

function isPageSlugCollision(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; constraint_name?: string; constraint?: string };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    (e.constraint_name === PAGES_SLUG_CONSTRAINT ||
      e.constraint === PAGES_SLUG_CONSTRAINT)
  );
}

export async function insertPageWithUniqueSlug(
  db: Database,
  params: {
    workspaceId: string;
    title: string;
    baseSlug: string;
    parentFolderId?: string | null;
    parentPageId?: string | null;
  },
): Promise<typeof pages.$inferSelect> {
  // Pages enforce a single-parent XOR (migration 0011): callers must not pass
  // both. We surface a clear error here rather than relying on the DB CHECK
  // failing mid-transaction.
  if (params.parentFolderId && params.parentPageId) {
    throw new Error(
      "insertPageWithUniqueSlug: cannot specify both parentFolderId and parentPageId",
    );
  }
  for (let i = 0; i < SLUG_ALLOC_MAX_ATTEMPTS; i++) {
    const slug = i === 0 ? params.baseSlug : `${params.baseSlug}-${i + 1}`;
    try {
      const [page] = await db
        .insert(pages)
        .values({
          workspaceId: params.workspaceId,
          title: params.title,
          slug,
          status: "draft",
          parentFolderId: params.parentFolderId ?? null,
          parentPageId: params.parentPageId ?? null,
        })
        .returning();
      return page;
    } catch (err) {
      if (!isPageSlugCollision(err)) throw err;
    }
  }
  throw new Error(
    `Could not allocate unique slug for "${params.baseSlug}" after ${SLUG_ALLOC_MAX_ATTEMPTS} attempts`,
  );
}
