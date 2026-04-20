import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { insertPageWithUniqueSlug } from "./slug.js";
import type { Database } from "./client.js";

// Mocks drizzle's insert(...).values(...).returning() chain, capturing the
// slug passed on each attempt. `takenSlugs` simulates the
// `pages_workspace_slug_active_uk` unique constraint: if the caller tries
// to insert a slug already in the set, the call throws a pg unique-violation
// error (code 23505, constraint_name set) — mirroring what postgres raises.
function makeFakeDb(takenSlugs: Iterable<string>): {
  db: Database;
  attemptedSlugs: string[];
} {
  const taken = new Set(takenSlugs);
  const attemptedSlugs: string[] = [];
  const fake = {
    insert: () => ({
      values: (row: { workspaceId: string; title: string; slug: string; status: string }) => ({
        returning: async () => {
          attemptedSlugs.push(row.slug);
          if (taken.has(row.slug)) {
            const err = new Error(
              'duplicate key value violates unique constraint "pages_workspace_slug_active_uk"',
            ) as Error & { code: string; constraint_name: string };
            err.code = "23505";
            err.constraint_name = "pages_workspace_slug_active_uk";
            throw err;
          }
          taken.add(row.slug);
          return [
            {
              id: `page-${attemptedSlugs.length}`,
              workspaceId: row.workspaceId,
              title: row.title,
              slug: row.slug,
              status: row.status,
            },
          ];
        },
      }),
    }),
  };
  return { db: fake as unknown as Database, attemptedSlugs };
}

describe("insertPageWithUniqueSlug", () => {
  const workspaceId = "00000000-0000-0000-0000-000000000001";

  it("inserts with the base slug when none taken", async () => {
    const { db, attemptedSlugs } = makeFakeDb([]);
    const page = await insertPageWithUniqueSlug(db, {
      workspaceId,
      title: "My Title",
      baseSlug: "my-title",
    });
    assert.equal(page.slug, "my-title");
    assert.deepEqual(attemptedSlugs, ["my-title"]);
  });

  it("retries with -2 after a unique-violation on the base slug", async () => {
    const { db, attemptedSlugs } = makeFakeDb(["my-title"]);
    const page = await insertPageWithUniqueSlug(db, {
      workspaceId,
      title: "My Title",
      baseSlug: "my-title",
    });
    assert.equal(page.slug, "my-title-2");
    assert.deepEqual(attemptedSlugs, ["my-title", "my-title-2"]);
  });

  it("keeps retrying past -2 as long as suffixes collide", async () => {
    const { db, attemptedSlugs } = makeFakeDb([
      "my-title",
      "my-title-2",
      "my-title-3",
    ]);
    const page = await insertPageWithUniqueSlug(db, {
      workspaceId,
      title: "My Title",
      baseSlug: "my-title",
    });
    assert.equal(page.slug, "my-title-4");
    assert.deepEqual(attemptedSlugs, [
      "my-title",
      "my-title-2",
      "my-title-3",
      "my-title-4",
    ]);
  });

  it("rethrows errors that are not slug-constraint violations", async () => {
    const fake = {
      insert: () => ({
        values: () => ({
          returning: async () => {
            const err = new Error("connection reset") as Error & { code: string };
            err.code = "ECONNRESET";
            throw err;
          },
        }),
      }),
    };
    await assert.rejects(
      () =>
        insertPageWithUniqueSlug(fake as unknown as Database, {
          workspaceId,
          title: "My Title",
          baseSlug: "my-title",
        }),
      /connection reset/,
    );
  });

  // This is the route-classifier scenario: two ingestions with the same
  // titleHint both hit confidence >= 0.85, both try to auto-create. Each
  // call must resolve to a distinct slug — the second one seeing the first
  // page's slug in the constraint and falling through to `-2`.
  it("gives distinct slugs to two back-to-back auto-creates with the same title", async () => {
    const { db } = makeFakeDb([]);
    const first = await insertPageWithUniqueSlug(db, {
      workspaceId,
      title: "Project Alpha",
      baseSlug: "project-alpha",
    });
    const second = await insertPageWithUniqueSlug(db, {
      workspaceId,
      title: "Project Alpha",
      baseSlug: "project-alpha",
    });
    assert.equal(first.slug, "project-alpha");
    assert.equal(second.slug, "project-alpha-2");
    assert.notEqual(first.slug, second.slug);
  });

  it("gives up after SLUG_ALLOC_MAX_ATTEMPTS (20) collisions", async () => {
    const taken = new Set<string>(["pathological"]);
    for (let i = 2; i <= 20; i++) taken.add(`pathological-${i}`);
    const { db } = makeFakeDb(taken);
    await assert.rejects(
      () =>
        insertPageWithUniqueSlug(db, {
          workspaceId,
          title: "Pathological",
          baseSlug: "pathological",
        }),
      /Could not allocate unique slug/,
    );
  });
});
