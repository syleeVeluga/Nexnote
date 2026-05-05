import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createFolderStructure, updatePageStructure } from "./page-structure.js";
import { folders, pages } from "./schema/index.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const pageId = "22222222-2222-4222-8222-222222222222";
const folderId = "33333333-3333-4333-8333-333333333333";

interface FakeOptions {
  selectQueue?: unknown[][];
  returningQueue?: unknown[][];
}

class FakeTx {
  readonly inserts: Array<{ table: unknown; values: unknown }> = [];
  readonly updates: Array<{ table: unknown; set: unknown }> = [];
  readonly executeQueries: unknown[] = [];
  executeCount = 0;
  private readonly selectQueue: unknown[][];
  private readonly returningQueue: unknown[][];

  constructor(options: FakeOptions = {}) {
    this.selectQueue = options.selectQueue ?? [];
    this.returningQueue = options.returningQueue ?? [];
  }

  select(_fields?: unknown) {
    return { from: () => this.selectChain() };
  }

  selectDistinct(_fields?: unknown) {
    return { from: () => this.selectChain() };
  }

  insert(table: unknown) {
    return {
      values: (values: unknown) => {
        this.inserts.push({ table, values });
        const next = this.returningQueue.shift() ?? [{ id: "generated-id" }];
        return {
          returning: async () => next,
          onConflictDoNothing: async () => [],
        };
      },
    };
  }

  update(table: unknown) {
    return {
      set: (values: unknown) => {
        this.updates.push({ table, set: values });
        return { where: async () => [] };
      },
    };
  }

  delete(_table: unknown) {
    return { where: async () => [] };
  }

  async execute(_query: unknown) {
    this.executeQueries.push(_query);
    this.executeCount += 1;
    return [] as unknown[];
  }

  transaction<T>(fn: (tx: FakeTx) => Promise<T>) {
    return fn(this);
  }

  private selectChain() {
    const finish = async () => this.selectQueue.shift() ?? [];
    const chain = {
      leftJoin: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: finish,
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => finish().then(resolve, reject),
    };
    return chain;
  }
}

function sqlChunkText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return "?";
      if (chunk && typeof chunk === "object" && "value" in chunk) {
        const value = (chunk as { value?: unknown }).value;
        return Array.isArray(value) ? value.join("") : String(value ?? "");
      }
      return "";
    })
    .join("");
}

describe("updatePageStructure", () => {
  it("honors caller-supplied sortOrder when changing parent without reorderIntent", async () => {
    const existing = {
      id: pageId,
      workspaceId,
      title: "Page",
      slug: "page",
      status: "draft",
      parentPageId: null,
      parentFolderId: null,
      sortOrder: 0,
      currentRevisionId: null,
    };
    const targetFolder = {
      id: folderId,
      workspaceId,
      parentFolderId: null,
    };

    const tx = new FakeTx({
      selectQueue: [
        [existing],
        [targetFolder],
        [{ ...existing, parentFolderId: folderId, sortOrder: 7 }],
      ],
    });

    await updatePageStructure({
      db: tx as never,
      workspaceId,
      pageId,
      parentFolderId: folderId,
      sortOrder: 7,
      auditAction: "test.move",
    });

    const parentMove = tx.updates.find(
      (u) =>
        u.table === pages &&
        typeof u.set === "object" &&
        u.set !== null &&
        "parentFolderId" in (u.set as Record<string, unknown>) &&
        (u.set as { parentFolderId?: string | null }).parentFolderId ===
          folderId,
    );
    assert.ok(parentMove, "expected an update setting the new parent folder");
    assert.equal(
      (parentMove!.set as { sortOrder: number }).sortOrder,
      7,
      "expected the caller-supplied newSortOrder to be honored",
    );
  });
});

describe("createFolderStructure", () => {
  it("allocates the slug inside the transaction and acquires an advisory lock", async () => {
    const tx = new FakeTx({
      selectQueue: [
        // ensureFolderSlugAvailable -> no conflict
        [],
        // nextFolderSortOrder -> no siblings
        [],
      ],
      returningQueue: [
        [
          {
            id: "folder-1",
            workspaceId,
            parentFolderId: null,
            name: "Research",
            slug: "research",
            sortOrder: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      ],
    });

    const folder = await createFolderStructure({
      db: tx as never,
      workspaceId,
      name: "Research",
      slug: "research",
    });

    assert.equal(folder.slug, "research");
    assert.equal(
      tx.executeCount,
      1,
      "expected exactly one execute call (the advisory lock)",
    );
    const lockSql = sqlChunkText(tx.executeQueries[0]);
    assert.match(lockSql, /pg_advisory_xact_lock/);
    assert.doesNotMatch(
      lockSql,
      /::bigint/,
      "two-argument pg_advisory_xact_lock must receive int4 keys, not bigint",
    );
    assert.ok(
      tx.inserts.some((i) => i.table === folders),
      "expected the folder insert to run inside the tx",
    );
  });
});
