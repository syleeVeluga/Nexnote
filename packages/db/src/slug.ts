import { and, eq, like } from "drizzle-orm";
import { pages } from "./schema/index.js";
import type { Database } from "./client.js";

// Returns a slug guaranteed unique within the workspace. Callers pass
// the already-slugified base (e.g. `slugify(title)`); this helper
// queries existing `{baseSlug}%` rows and appends `-2`, `-3`, … as
// needed. Prevents `pages_workspace_slug_uk` collisions on auto-create
// (route-classifier) and approve-create (apply-decision).
export async function uniqueSlugInWorkspace(
  db: Database,
  workspaceId: string,
  baseSlug: string,
): Promise<string> {
  const rows = await db
    .select({ slug: pages.slug })
    .from(pages)
    .where(
      and(
        eq(pages.workspaceId, workspaceId),
        like(pages.slug, `${baseSlug}%`),
      ),
    );
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(baseSlug)) return baseSlug;
  for (let i = 2; i < 10000; i++) {
    const candidate = `${baseSlug}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${baseSlug}-${Date.now()}`;
}
