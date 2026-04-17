import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { uniqueSlugInWorkspace } from "./slug.js";
import type { Database } from "./client.js";

// Mocks the drizzle select-from-where chain. `rowsForCall` returns the rows the
// helper should see on the Nth invocation (call index starts at 0). This lets
// a single test simulate "first ingestion sees no rows, second ingestion sees
// the first page's slug already present" for the collision scenario.
function makeFakeDb(
  rowsForCall: (callIndex: number) => Array<{ slug: string }>,
): { db: Database; getCallCount: () => number } {
  let calls = 0;
  const fake = {
    select: () => ({
      from: () => ({
        where: async () => {
          const rows = rowsForCall(calls);
          calls++;
          return rows;
        },
      }),
    }),
  };
  return {
    db: fake as unknown as Database,
    getCallCount: () => calls,
  };
}

describe("uniqueSlugInWorkspace", () => {
  const workspaceId = "00000000-0000-0000-0000-000000000001";

  it("returns the base slug when no collision exists", async () => {
    const { db } = makeFakeDb(() => []);
    const slug = await uniqueSlugInWorkspace(db, workspaceId, "my-title");
    assert.equal(slug, "my-title");
  });

  it("appends -2 when the base slug is taken", async () => {
    const { db } = makeFakeDb(() => [{ slug: "my-title" }]);
    const slug = await uniqueSlugInWorkspace(db, workspaceId, "my-title");
    assert.equal(slug, "my-title-2");
  });

  it("keeps incrementing past -2 when suffixes are taken", async () => {
    const { db } = makeFakeDb(() => [
      { slug: "my-title" },
      { slug: "my-title-2" },
      { slug: "my-title-3" },
    ]);
    const slug = await uniqueSlugInWorkspace(db, workspaceId, "my-title");
    assert.equal(slug, "my-title-4");
  });

  it("skips over gaps — -3 is valid when -2 is free", async () => {
    // Not strictly expected (we allocate sequentially) but the helper should
    // still find the lowest available suffix.
    const { db } = makeFakeDb(() => [
      { slug: "my-title" },
      { slug: "my-title-3" },
    ]);
    const slug = await uniqueSlugInWorkspace(db, workspaceId, "my-title");
    assert.equal(slug, "my-title-2");
  });

  it("does not match slugs with different prefixes", async () => {
    // The `like` filter is baseSlug% — in real Postgres `my-title-extra`
    // would be returned too, but the helper only rejects exact-set members.
    const { db } = makeFakeDb(() => [{ slug: "my-title-extra" }]);
    const slug = await uniqueSlugInWorkspace(db, workspaceId, "my-title");
    assert.equal(slug, "my-title");
  });

  // This is the route-classifier scenario: two ingestions with the same
  // titleHint both hit confidence >= 0.85, both try to auto-create. The
  // second call must observe the first page's slug and produce a distinct
  // one, instead of blowing up on pages_workspace_slug_uk.
  it("gives distinct slugs to two back-to-back auto-creates with the same title", async () => {
    const inserted: string[] = [];
    const fake = {
      select: () => ({
        from: () => ({
          where: async () => inserted.map((slug) => ({ slug })),
        }),
      }),
    };
    const db = fake as unknown as Database;

    const base = "project-alpha";
    const first = await uniqueSlugInWorkspace(db, workspaceId, base);
    inserted.push(first);
    const second = await uniqueSlugInWorkspace(db, workspaceId, base);
    inserted.push(second);

    assert.equal(first, "project-alpha");
    assert.equal(second, "project-alpha-2");
    assert.notEqual(first, second);
  });
});
