import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { purgeDeletedSubtreeInTransaction } from "./page-deletion.js";

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
    this.operations.push("select");
    return { from: () => this.selectChain() };
  }

  selectDistinct(_fields?: unknown) {
    this.operations.push("selectDistinct");
    return { from: () => this.selectChain() };
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
    this.operations.push("execute");
    return this.executeQueue.shift() ?? [];
  }

  private selectChain() {
    const finish = async () => this.selectQueue.shift() ?? [];
    const chain = {
      innerJoin: () => this.selectChain(),
      where: () => this.selectChain(),
      limit: finish,
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => finish().then(resolve, reject),
    };
    return chain;
  }
}

describe("purgeDeletedSubtreeInTransaction", () => {
  it("locks the subtree before checking live published snapshots", async () => {
    const tx = new FakeTx({
      selectQueue: [
        [{ id: rootPageId, title: "Root" }],
        [],
        [],
      ],
      executeQueue: [[{ id: rootPageId }], [], []],
    });

    await purgeDeletedSubtreeInTransaction(tx as never, {
      workspaceId,
      rootPageId,
    });

    assert.deepEqual(tx.operations.slice(0, 4), [
      "select",
      "execute",
      "execute",
      "select",
    ]);
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
    assert.deepEqual(tx.operations.slice(-2), ["delete", "execute"]);
  });
});
