import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  RollbackRevisionError,
  rollbackToRevision,
} from "./rollback-revision.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const pageId = "22222222-2222-4222-8222-222222222222";
const targetRevisionId = "33333333-3333-4333-8333-333333333333";
const headRevisionId = "44444444-4444-4444-8444-444444444444";
const newRevisionId = "55555555-5555-4555-8555-555555555555";

class FakeDb {
  readonly insertedValues: unknown[] = [];
  readonly updatedValues: unknown[] = [];
  private readonly selectQueue: unknown[][];
  private readonly returningIds: string[];

  constructor(input: { selectQueue: unknown[][]; returningIds?: string[] }) {
    this.selectQueue = input.selectQueue;
    this.returningIds = input.returningIds ?? [newRevisionId];
  }

  select(_fields?: unknown) {
    return {
      from: () => this.selectChain(),
    };
  }

  insert(_table: unknown) {
    return {
      values: (values: Record<string, unknown>) => {
        this.insertedValues.push(values);
        return {
          returning: async () => [
            {
              ...values,
              id: this.returningIds.shift() ?? "id",
              createdAt: new Date("2026-05-05T00:00:00Z"),
            },
          ],
        };
      },
    };
  }

  update(_table: unknown) {
    return {
      set: (values: unknown) => {
        this.updatedValues.push(values);
        return { where: async () => [] };
      },
    };
  }

  transaction<T>(fn: (tx: FakeDb) => Promise<T>) {
    return fn(this);
  }

  private selectChain() {
    const finish = async () => this.selectQueue.shift() ?? [];
    const chain = {
      leftJoin: () => this.selectChain(),
      where: () => this.selectChain(),
      limit: finish,
    };
    return chain;
  }
}

describe("rollbackToRevision", () => {
  it("creates a rollback revision, diff, page update, and audit row", async () => {
    const db = new FakeDb({
      selectQueue: [
        [
          {
            id: targetRevisionId,
            pageId,
            contentMd: "# Restored",
            contentJson: null,
          },
        ],
        [
          {
            id: pageId,
            currentRevisionId: headRevisionId,
            currentContentMd: "# Current",
            currentContentJson: null,
          },
        ],
      ],
    });

    const result = await rollbackToRevision({
      db: db as never,
      workspaceId,
      pageId,
      revisionId: targetRevisionId,
      actorUserId: null,
      actorType: "ai",
      source: "rollback",
      modelRunId: "66666666-6666-4666-8666-666666666666",
      sourceIngestionId: "77777777-7777-4777-8777-777777777777",
      ingestionDecisionId: "88888888-8888-4888-8888-888888888888",
      revisionNote: "restore previous content",
    });

    assert.equal(result.newRevisionId, newRevisionId);
    assert.equal(result.previousHeadRevisionId, headRevisionId);
    assert.equal(result.rollbackTargetRevisionId, targetRevisionId);

    const revision = db.insertedValues.find(
      (value) => (value as { source?: string }).source === "rollback",
    ) as {
      pageId: string;
      baseRevisionId: string;
      actorType: string;
      contentMd: string;
      sourceDecisionId: string;
    };
    assert.equal(revision.pageId, pageId);
    assert.equal(revision.baseRevisionId, headRevisionId);
    assert.equal(revision.actorType, "ai");
    assert.equal(revision.contentMd, "# Restored");
    assert.equal(
      revision.sourceDecisionId,
      "88888888-8888-4888-8888-888888888888",
    );

    assert.ok(
      db.insertedValues.some(
        (value) =>
          Object.prototype.hasOwnProperty.call(value as object, "diffMd") &&
          Object.prototype.hasOwnProperty.call(
            value as object,
            "changedBlocks",
          ),
      ),
    );
    assert.ok(
      db.updatedValues.some(
        (value) =>
          (value as { currentRevisionId?: string }).currentRevisionId ===
          newRevisionId,
      ),
    );
    assert.ok(
      db.insertedValues.some(
        (value) =>
          (value as { action?: string; afterJson?: { actorType?: string } })
            .action === "rollback" &&
          (value as { afterJson?: { actorType?: string } }).afterJson
            ?.actorType === "ai",
      ),
    );
  });

  it("rejects a revision that is not on the page", async () => {
    const db = new FakeDb({ selectQueue: [[]] });

    await assert.rejects(
      rollbackToRevision({
        db: db as never,
        workspaceId,
        pageId,
        revisionId: targetRevisionId,
        actorUserId: null,
        actorType: "ai",
        source: "rollback",
      }),
      (err) =>
        err instanceof RollbackRevisionError &&
        err.code === "revision_not_found",
    );
  });

  it("rejects pages outside the workspace", async () => {
    const db = new FakeDb({
      selectQueue: [
        [
          {
            id: targetRevisionId,
            pageId,
            contentMd: "# Restored",
            contentJson: null,
          },
        ],
        [],
      ],
    });

    await assert.rejects(
      rollbackToRevision({
        db: db as never,
        workspaceId,
        pageId,
        revisionId: targetRevisionId,
        actorUserId: null,
        actorType: "ai",
        source: "rollback",
      }),
      (err) =>
        err instanceof RollbackRevisionError && err.code === "page_not_found",
    );
  });
});
