import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  approveDecision,
  findSourceSubtreeContainingPage,
  rejectDecision,
} from "./apply-decision.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const ingestionId = "22222222-2222-4222-8222-222222222222";
const decisionId = "33333333-3333-4333-8333-333333333333";
const scheduledRunId = "44444444-4444-4444-8444-444444444444";
const userId = "55555555-5555-4555-8555-555555555555";
const canonicalPageId = "66666666-6666-4666-8666-666666666666";
const sourcePageId = "77777777-7777-4777-8777-777777777777";
const proposedRevisionId = "88888888-8888-4888-8888-888888888888";

class FakeDb {
  readonly insertedValues: unknown[] = [];
  readonly updatedValues: unknown[] = [];
  private readonly selectQueue: unknown[][];
  private readonly executeQueue: unknown[];
  private readonly returningIds: string[];

  constructor(input: {
    selectQueue: unknown[][];
    executeQueue: unknown[];
    returningIds?: string[];
  }) {
    this.selectQueue = input.selectQueue;
    this.executeQueue = input.executeQueue;
    this.returningIds = input.returningIds ?? [];
  }

  select(_fields?: unknown) {
    return {
      from: () => this.queryChain(),
    };
  }

  insert(_table: unknown) {
    return {
      values: (values: unknown) => {
        this.insertedValues.push(values);
        const id = this.returningIds.shift();
        return {
          returning: async () => [
            typeof values === "object" && values !== null && id
              ? { ...values, id }
              : values,
          ],
          onConflictDoNothing: async () => undefined,
          then: (resolve: (value: unknown) => unknown) => resolve(values),
        };
      },
    };
  }

  update(_table: unknown) {
    return {
      set: (values: unknown) => {
        this.updatedValues.push(values);
        return {
          where: () => Promise.resolve([]),
        };
      },
    };
  }

  execute(_query: unknown) {
    return Promise.resolve(this.executeQueue.shift() ?? []);
  }

  transaction<T>(fn: (tx: FakeDb) => Promise<T>) {
    return fn(this);
  }

  private queryChain() {
    const finish = () => Promise.resolve(this.selectQueue.shift() ?? []);
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

class FakeQueue {
  readonly jobs: Array<{ name: string; data: unknown; options: unknown }> = [];

  add(name: string, data: unknown, options: unknown) {
    this.jobs.push({ name, data, options });
    return Promise.resolve({ id: `${name}-job` });
  }
}

function ingestionRow() {
  return [
    {
      id: ingestionId,
      sourceName: "scheduled-agent",
      titleHint: null,
      normalizedText: "payload",
      rawPayload: {},
      targetFolderId: null,
      targetParentPageId: null,
      useReconciliation: true,
    },
  ];
}

function deletedPageRoot(pageId: string, title = "Source") {
  return [{ id: pageId, title, deletedAt: null }];
}

function ctx(input: {
  db: FakeDb;
  extractionQueue?: FakeQueue;
  searchQueue?: FakeQueue;
  decision: Record<string, unknown>;
}) {
  return {
    db: input.db as never,
    extractionQueue: (input.extractionQueue ?? new FakeQueue()) as never,
    searchQueue: (input.searchQueue ?? new FakeQueue()) as never,
    workspaceId,
    userId,
    decision: {
      id: decisionId,
      ingestionId,
      modelRunId: null,
      scheduledRunId,
      status: "suggested",
      confidence: "0.99",
      targetPageId: null,
      proposedRevisionId: null,
      proposedPageTitle: null,
      rationaleJson: null,
      ...input.decision,
    } as never,
  };
}

describe("findSourceSubtreeContainingPage", () => {
  it("returns the source page whose subtree contains the protected page", () => {
    const result = findSourceSubtreeContainingPage({
      protectedPageId: "canonical",
      sourceSubtrees: [
        { sourcePageId: "source-a", descendantPageIds: ["source-a"] },
        {
          sourcePageId: "source-b",
          descendantPageIds: ["source-b", "canonical", "child"],
        },
      ],
    });

    assert.equal(result, "source-b");
  });

  it("returns null when the protected page is outside all source subtrees", () => {
    const result = findSourceSubtreeContainingPage({
      protectedPageId: "canonical",
      sourceSubtrees: [
        { sourcePageId: "source-a", descendantPageIds: ["source-a"] },
        { sourcePageId: "source-b", descendantPageIds: ["source-b", "child"] },
      ],
    });

    assert.equal(result, null);
  });
});

describe("approveDecision destructive decisions", () => {
  it("approves rollback_to_revision by restoring the target revision instead of ingestion text", async () => {
    const rollbackRevisionId = "99999999-9999-4999-8999-999999999999";
    const restoredRevisionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const extractionQueue = new FakeQueue();
    const searchQueue = new FakeQueue();
    const db = new FakeDb({
      selectQueue: [
        ingestionRow(),
        [
          {
            id: rollbackRevisionId,
            pageId: canonicalPageId,
            contentMd: "# Restored",
            contentJson: null,
          },
        ],
        [
          {
            id: canonicalPageId,
            currentRevisionId: proposedRevisionId,
            currentContentMd: "# Current",
            currentContentJson: null,
          },
        ],
      ],
      executeQueue: [],
      returningIds: [restoredRevisionId],
    });

    const result = await approveDecision(
      ctx({
        db,
        extractionQueue,
        searchQueue,
        decision: {
          action: "update",
          targetPageId: canonicalPageId,
          rationaleJson: {
            tool: "rollback_to_revision",
            rollbackTargetRevisionId: rollbackRevisionId,
          },
        },
      }),
    );

    assert.ok("status" in result);
    assert.equal(result.status, "applied");
    assert.equal(result.action, "update");
    assert.equal(result.revisionId, restoredRevisionId);
    assert.equal(extractionQueue.jobs.length, 1);
    assert.equal(searchQueue.jobs.length, 1);
    const revision = db.insertedValues.find(
      (value) => (value as { source?: string }).source === "rollback",
    ) as { contentMd: string; sourceDecisionId: string };
    assert.equal(revision.contentMd, "# Restored");
    assert.equal(revision.sourceDecisionId, decisionId);
    assert.ok(
      db.updatedValues.some(
        (value) =>
          (value as { proposedRevisionId?: string; status?: string })
            .proposedRevisionId === restoredRevisionId &&
          (value as { status?: string }).status === "approved",
      ),
    );
  });

  it("approves delete by soft-deleting the target subtree and marking the decision approved", async () => {
    const db = new FakeDb({
      selectQueue: [
        ingestionRow(),
        [{ id: sourcePageId }],
        [],
        deletedPageRoot(sourcePageId, "Duplicate"),
        [],
      ],
      executeQueue: [
        { rows: [{ id: sourcePageId }] },
        { rows: [{ id: sourcePageId }] },
        [],
        [],
      ],
    });

    const result = await approveDecision(
      ctx({
        db,
        decision: {
          action: "delete",
          targetPageId: sourcePageId,
        },
      }),
    );
    assert.ok("status" in result);
    assert.equal(result.status, "applied");
    assert.equal(result.action, "delete");

    assert.deepEqual(result.deletedPageIds, [sourcePageId]);
    assert.ok(
      db.updatedValues.some(
        (value) => (value as { status?: string }).status === "approved",
      ),
    );
    assert.ok(
      db.insertedValues.some(
        (value) => (value as { action?: string }).action === "approve_delete",
      ),
    );
  });

  it("approves merge by promoting the canonical revision, deleting sources, and enqueueing post-apply jobs", async () => {
    const extractionQueue = new FakeQueue();
    const searchQueue = new FakeQueue();
    const db = new FakeDb({
      selectQueue: [
        ingestionRow(),
        [{ id: proposedRevisionId, pageId: canonicalPageId }],
        [{ id: sourcePageId }],
        [],
        [{ fromPageId: sourcePageId, fromPath: "source" }],
        deletedPageRoot(sourcePageId, "Source"),
        [],
      ],
      executeQueue: [
        { rows: [{ id: sourcePageId }] },
        { rows: [{ id: sourcePageId }] },
        [],
        [],
      ],
    });

    const result = await approveDecision(
      ctx({
        db,
        extractionQueue,
        searchQueue,
        decision: {
          action: "merge",
          targetPageId: canonicalPageId,
          proposedRevisionId,
          rationaleJson: {
            canonicalPageId,
            sourcePageIds: [sourcePageId],
          },
        },
      }),
    );
    assert.ok("status" in result);
    assert.equal(result.status, "applied");
    assert.equal(result.action, "merge");

    assert.equal(result.pageId, canonicalPageId);
    assert.equal(result.revisionId, proposedRevisionId);
    assert.deepEqual(result.deletedPageIds, [sourcePageId]);
    assert.equal(extractionQueue.jobs.length, 1);
    assert.equal(searchQueue.jobs.length, 1);
    assert.ok(
      db.updatedValues.some(
        (value) =>
          (value as { currentRevisionId?: string }).currentRevisionId ===
          proposedRevisionId,
      ),
    );
    assert.ok(
      db.insertedValues.some(
        (value) => (value as { action?: string }).action === "approve_merge",
      ),
    );
    assert.ok(
      db.insertedValues.some((value) => {
        const row = Array.isArray(value) ? value[0] : value;
        return (
          (row as { fromPageId?: string; toPageId?: string }).fromPageId ===
            sourcePageId &&
          (row as { toPageId?: string }).toPageId === canonicalPageId
        );
      }),
    );
  });
});

describe("rejectDecision destructive decisions", () => {
  it("rejects merge without promoting the proposed revision or deleting source pages", async () => {
    const extractionQueue = new FakeQueue();
    const searchQueue = new FakeQueue();
    const db = new FakeDb({
      selectQueue: [],
      executeQueue: [],
    });

    const result = await rejectDecision(
      ctx({
        db,
        extractionQueue,
        searchQueue,
        decision: {
          action: "merge",
          targetPageId: canonicalPageId,
          proposedRevisionId,
          rationaleJson: {
            canonicalPageId,
            sourcePageIds: [sourcePageId],
          },
        },
      }),
    );

    assert.equal(result.status, "rejected");
    assert.equal(result.ingestionId, ingestionId);
    assert.equal(extractionQueue.jobs.length, 0);
    assert.equal(searchQueue.jobs.length, 0);
    assert.ok(
      db.updatedValues.some(
        (value) => (value as { status?: string }).status === "rejected",
      ),
    );
    assert.ok(
      db.updatedValues.every(
        (value) =>
          !("currentRevisionId" in (value as Record<string, unknown>)) &&
          !("deletedAt" in (value as Record<string, unknown>)) &&
          (value as { proposedRevisionId?: unknown }).proposedRevisionId !==
            null,
      ),
    );
    assert.ok(
      db.insertedValues.some(
        (value) => (value as { action?: string }).action === "reject",
      ),
    );
    assert.ok(
      db.insertedValues.every(
        (value) =>
          (value as { action?: string }).action !== "approve_merge" &&
          (value as { action?: string }).action !== "delete",
      ),
    );
  });
});
