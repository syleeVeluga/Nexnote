import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { collectFolderDescendantPageIds } from "./folder-pages.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "99999999-9999-4999-8999-999999999999";
const rootFolderId = "22222222-2222-4222-8222-222222222222";

class FakeDb {
  queryText = "";

  constructor(private readonly result: unknown) {}

  async execute(query: unknown) {
    this.queryText = renderSqlWithValues(query);
    return this.result;
  }
}

// Renders the drizzle SQL template with embedded parameter values inlined,
// so test assertions can check both the SQL shape and the bound values.
function renderSqlWithValues(query: unknown): string {
  if (query === null || query === undefined) return String(query);
  if (typeof query === "string") return query;
  if (typeof query !== "object") return String(query);
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    return chunks.map(renderSqlWithValues).join("");
  }
  const value = (query as { value?: unknown }).value;
  if (Array.isArray(value)) return value.join("");
  if (value !== undefined) return String(value);
  return "";
}

describe("collectFolderDescendantPageIds", () => {
  it("returns descendants of folder A: P1 (direct), P2 (in subfolder B), P3 (parent_page_id=P2)", async () => {
    // Fixture from folder-graph-plan.md §검증/단위 테스트:
    //   A → B → P2 → P3
    //   A → P1 (parent_folder_id=A)
    // The recursive CTE itself can't be exercised against a Fake DB, so we
    // assert the contract: caller maps execute() rows verbatim, in order.
    const db = new FakeDb([
      { id: "page-1" },
      { id: "page-2" },
      { id: "page-3" },
    ]);

    const ids = await collectFolderDescendantPageIds(
      db as never,
      workspaceId,
      rootFolderId,
    );

    assert.deepEqual(ids, ["page-1", "page-2", "page-3"]);
  });

  it("emits a two-stage recursive CTE that walks folder_tree then folder_pages", async () => {
    const db = new FakeDb([]);

    await collectFolderDescendantPageIds(db as never, workspaceId, rootFolderId);

    assert.match(db.queryText, /WITH RECURSIVE folder_tree AS/);
    assert.match(db.queryText, /folder_pages AS/);
    assert.match(
      db.queryText,
      /p\."parent_folder_id" IN \(SELECT "id" FROM folder_tree\)/,
      "direct-folder branch must scope to the folder_tree CTE",
    );
    assert.match(
      db.queryText,
      /INNER JOIN folder_pages fp ON p\."parent_page_id" = fp\."id"/,
      "page-descendant branch must walk parent_page_id",
    );
    assert.match(db.queryText, /SELECT DISTINCT "id" FROM folder_pages/);
  });

  it("constrains every recursive level to the requested workspace (cross-workspace folders never leak)", async () => {
    const db = new FakeDb([]);

    await collectFolderDescendantPageIds(db as never, workspaceId, rootFolderId);

    // Both folders CTE branches AND both folder_pages branches must filter on
    // workspace_id, otherwise a cross-workspace boundary breach is possible.
    const folderWsMatches = db.queryText.match(/f\."workspace_id"\s*=/g) ?? [];
    assert.ok(
      folderWsMatches.length >= 2,
      `folders.workspace_id constraint should appear at the seed and recursive step (found ${folderWsMatches.length})`,
    );
    const pageWsMatches = db.queryText.match(/p\."workspace_id"\s*=/g) ?? [];
    assert.ok(
      pageWsMatches.length >= 2,
      `pages.workspace_id constraint should appear in both folder_pages branches (found ${pageWsMatches.length})`,
    );

    // The workspace identifier must be threaded into the query so a
    // sibling workspace's folder ID can never be resolved through this call.
    assert.ok(
      db.queryText.includes(workspaceId),
      "workspaceId must be embedded as a bound value in the query",
    );
    assert.ok(
      db.queryText.includes(rootFolderId),
      "rootFolderId must be embedded as a bound value in the query",
    );
    // And, importantly, an unrelated workspace ID must never appear.
    assert.ok(
      !db.queryText.includes(otherWorkspaceId),
      "no other workspace identifier should ever be embedded in the query",
    );
  });

  it("hides soft-deleted pages by default and includes them only when opted in", async () => {
    const dbDefault = new FakeDb([]);
    await collectFolderDescendantPageIds(
      dbDefault as never,
      workspaceId,
      rootFolderId,
    );
    assert.match(
      dbDefault.queryText,
      /p\."deleted_at" IS NULL OR false/,
      "the default call must keep includeDeleted=false in the OR clause",
    );

    const dbIncluded = new FakeDb([]);
    await collectFolderDescendantPageIds(
      dbIncluded as never,
      workspaceId,
      rootFolderId,
      { includeDeleted: true },
    );
    assert.match(
      dbIncluded.queryText,
      /p\."deleted_at" IS NULL OR true/,
      "includeDeleted: true must flow into the OR clause",
    );
  });

  it("maps postgres-js style execute results ({ rows: [...] })", async () => {
    const db = new FakeDb({ rows: [{ id: "page-1" }, { id: "page-2" }] });

    const ids = await collectFolderDescendantPageIds(
      db as never,
      workspaceId,
      rootFolderId,
      { includeDeleted: true },
    );

    assert.deepEqual(ids, ["page-1", "page-2"]);
  });

  it("returns an empty array when the folder has no descendant pages", async () => {
    const db = new FakeDb([]);

    const ids = await collectFolderDescendantPageIds(
      db as never,
      workspaceId,
      rootFolderId,
    );

    assert.deepEqual(ids, []);
  });
});
