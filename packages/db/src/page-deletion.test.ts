import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { purgeDeletedSubtreeInTransaction } from "./page-deletion.js";
import { pages, publishedSnapshots } from "./schema/index.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const rootPageId = "22222222-2222-4222-8222-222222222222";

class FakeTx {
  readonly operations: string[] = [];
  private readonly selectQueue: unknown[][];
  private readonly executeQueue: unknown[];

  constructor(input: { selectQueue: unknown[][]; executeQueue: unknown[] }) {
    this.selectQueue = input.selectQueue;
    this.executeQueue = input.executeQueue;
  }

  select(_fields?: unknown) {
    return { from: (table: unknown) => this.selectChain(table) };
  }

  selectDistinct(_fields?: unknown) {
    return {
      from: (table: unknown) => this.selectChain(table, "selectDistinct"),
    };
  }

  update(_table: unknown) {
    this.operations.push("update");
    return {
      set: () => ({ where: async () => [] }),
    };
  }

  insert(_table: unknown) {
    this.operations.push("insert");
    return {
      values: async () => [],
    };
  }

  delete(_table: unknown) {
    this.operations.push("delete");
    return {
      where: async () => [],
    };
  }

  async execute(_query: unknown) {
    const queryText = flattenSqlText(_query);
    if (queryText.includes("WITH RECURSIVE descendants")) {
      this.operations.push("execute:collect-descendants");
    } else if (
      queryText.includes('FROM "pages"') &&
      queryText.includes("FOR UPDATE")
    ) {
      this.operations.push("execute:lock-subtree");
    } else if (queryText.includes('DELETE FROM "entities"')) {
      this.operations.push("execute:cleanup-orphans");
    } else {
      this.operations.push("execute");
    }
    return this.executeQueue.shift() ?? [];
  }

  private selectChain(table?: unknown, kind = "select") {
    if (table === pages) {
      this.operations.push(`${kind}:pages`);
    } else if (table === publishedSnapshots) {
      this.operations.push(`${kind}:publishedSnapshots`);
    } else {
      this.operations.push(kind);
    }
    const finish = async () => this.selectQueue.shift() ?? [];
    const chain = {
      innerJoin: () => chain,
      where: () => chain,
      limit: finish,
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => finish().then(resolve, reject),
    };
    return chain;
  }
}

function flattenSqlText(query: unknown): string {
  if (!query || typeof query !== "object") return "";
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && typeof chunk === "object") {
        const value = (chunk as { value?: unknown }).value;
        if (Array.isArray(value)) return value.join("");
        return flattenSqlText(chunk);
      }
      return "";
    })
    .join("");
}

describe("purgeDeletedSubtreeInTransaction", () => {
  it("locks the subtree before checking live published snapshots", async () => {
    const tx = new FakeTx({
      selectQueue: [[{ id: rootPageId, title: "Root" }], [], []],
      executeQueue: [[{ id: rootPageId }], [], []],
    });

    await purgeDeletedSubtreeInTransaction(tx as never, {
      workspaceId,
      rootPageId,
    });

    assert.ok(
      tx.operations.indexOf("execute:lock-subtree") <
        tx.operations.indexOf("select:publishedSnapshots"),
    );
  });

  it("returns archived original keys and cleans orphan entities after deleting pages", async () => {
    const tx = new FakeTx({
      selectQueue: [
        [{ id: rootPageId, title: "Root" }],
        [],
        [
          { storageKey: "originals/a.pdf" },
          { storageKey: null },
          { storageKey: "originals/b.docx" },
        ],
      ],
      executeQueue: [[{ id: rootPageId }], [], []],
    });

    const result = await purgeDeletedSubtreeInTransaction(tx as never, {
      workspaceId,
      rootPageId,
    });

    assert.deepEqual(result.storageKeys, [
      "originals/a.pdf",
      "originals/b.docx",
    ]);
    assert.equal(result.purgedPageIds.length, 1);
    assert.ok(
      tx.operations.indexOf("delete") <
        tx.operations.indexOf("execute:cleanup-orphans"),
    );
  });

  it("allows callers to defer orphan entity cleanup across multiple purges", async () => {
    const tx = new FakeTx({
      selectQueue: [[{ id: rootPageId, title: "Root" }], [], []],
      executeQueue: [[{ id: rootPageId }], [], []],
    });

    await purgeDeletedSubtreeInTransaction(tx as never, {
      workspaceId,
      rootPageId,
      cleanupOrphanEntities: false,
    });

    assert.equal(tx.operations.includes("execute:cleanup-orphans"), false);
  });
});
