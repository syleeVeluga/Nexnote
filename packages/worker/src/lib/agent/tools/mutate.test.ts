import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createAgentRunState, AgentToolError } from "../types.js";
import { createMutateTools, type CreateMutateToolsInput } from "./mutate.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const ingestionId = "22222222-2222-4222-8222-222222222222";
const agentRunId = "33333333-3333-4333-8333-333333333333";
const modelRunId = "44444444-4444-4444-8444-444444444444";
const scheduledRunId = "55555555-5555-4555-8555-555555555555";
const canonicalPageId = "66666666-6666-4666-8666-666666666666";
const sourcePageId = "77777777-7777-4777-8777-777777777777";
const baseRevisionId = "88888888-8888-4888-8888-888888888888";
const sourceRevisionId = "99999999-9999-4999-8999-999999999999";

class FakeDb {
  readonly insertedValues: unknown[] = [];
  readonly updatedValues: unknown[] = [];
  readonly deletedTables: unknown[] = [];
  private readonly selectQueue: unknown[][];
  private readonly executeQueue: unknown[];
  private readonly returningIds: string[];

  constructor(
    input: {
      selectQueue?: unknown[][];
      executeQueue?: unknown[];
      returningIds?: string[];
    } = {},
  ) {
    this.selectQueue = input.selectQueue ?? [];
    this.executeQueue = input.executeQueue ?? [];
    this.returningIds = input.returningIds ?? ["decision-id", "revision-id"];
  }

  select(_fields?: unknown) {
    return {
      from: () => this.selectChain(),
    };
  }

  selectDistinct(_fields?: unknown) {
    return {
      from: () => this.selectChain(),
    };
  }

  insert(_table: unknown) {
    return {
      values: (values: unknown) => {
        this.insertedValues.push(values);
        return {
          returning: async () => [{ id: this.returningIds.shift() ?? "id" }],
          onConflictDoNothing: async () => [],
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

  delete(table: unknown) {
    return {
      where: async () => {
        this.deletedTables.push(table);
        return [];
      },
    };
  }

  execute() {
    return this.executeQueue.shift() ?? [{ id: canonicalPageId }];
  }

  transaction<T>(fn: (tx: FakeDb) => Promise<T>) {
    return fn(this);
  }

  private selectChain() {
    const finish = async () => this.selectQueue.shift() ?? [];
    const chain = {
      leftJoin: () => this.selectChain(),
      innerJoin: () => this.selectChain(),
      where: () => this.selectChain(),
      orderBy: () => this.selectChain(),
      limit: finish,
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => finish().then(resolve, reject),
    };
    return chain;
  }
}

function input(
  overrides: Partial<CreateMutateToolsInput> = {},
): CreateMutateToolsInput {
  return {
    ingestion: {
      id: ingestionId,
      sourceName: "scheduled-agent",
      useReconciliation: true,
    },
    agentRunId,
    modelRunId,
    origin: "scheduled",
    scheduledRunId,
    scheduledAutoApply: true,
    allowDestructiveScheduledAgent: true,
    ...overrides,
  };
}

function ctx(db: FakeDb, seenPageIds: string[] = []) {
  const state = createAgentRunState();
  for (const pageId of seenPageIds) state.seenPageIds.add(pageId);
  return {
    db: db as never,
    workspaceId,
    state,
  };
}

function currentPage(
  id: string,
  title: string,
  revisionId: string,
  contentMd = "# Existing",
) {
  return [{ id, title, currentRevisionId: revisionId, contentMd }];
}

describe("createMutateTools destructive scheduled tools", () => {
  it("exposes delete_page and merge_pages only for scheduled origin", () => {
    const scheduledTools = createMutateTools(input({ origin: "scheduled" }));
    assert.ok(scheduledTools.delete_page);
    assert.ok(scheduledTools.merge_pages);

    const disabledTools = createMutateTools(
      input({ allowDestructiveScheduledAgent: false }),
    );
    assert.equal(disabledTools.delete_page, undefined);
    assert.equal(disabledTools.merge_pages, undefined);

    const ingestionTools = createMutateTools(input({ origin: "ingestion" }));
    assert.equal(ingestionTools.delete_page, undefined);
    assert.equal(ingestionTools.merge_pages, undefined);
  });

  it("rejects delete_page when the target page was not observed", async () => {
    const tools = createMutateTools(input());
    await assert.rejects(
      tools.delete_page.execute(ctx(new FakeDb()), {
        pageId: canonicalPageId,
        confidence: 0.99,
        reason: "redundant page",
      }),
      (err) =>
        err instanceof AgentToolError && err.code === "invalid_target_page",
    );
  });

  it("auto-applies delete decisions even when scheduled_auto_apply is off", async () => {
    // Scheduled Agent destructive tools are autonomous; the legacy
    // — workspace operators must explicitly opt into autonomous deletes via the
    // scheduled_auto_apply toggle no longer creates approval work.
    const db = new FakeDb({
      selectQueue: [
        currentPage(canonicalPageId, "Duplicate", baseRevisionId),
        [{ createdAt: new Date("2026-05-01T00:00:00Z") }],
        [],
        [{ id: canonicalPageId, title: "Duplicate" }],
        [],
      ],
      executeQueue: [[{ id: canonicalPageId }]],
    });
    const tools = createMutateTools(input({ scheduledAutoApply: false }));

    const result = await tools.delete_page.execute(ctx(db, [canonicalPageId]), {
      pageId: canonicalPageId,
      confidence: 0.99,
      reason: "duplicate of canonical content",
    });
    const data = result.data as { action: string; status: string };

    assert.equal(data.action, "delete");
    assert.equal(data.status, "auto_applied");
    const decision = db.insertedValues.find(
      (value) => (value as { action?: string }).action === "delete",
    ) as {
      status: string;
      targetPageId: string;
      scheduledRunId: string;
      rationaleJson: { kind: string; origin: string; tool: string };
    };
    assert.equal(decision.status, "auto_applied");
    assert.equal(decision.targetPageId, canonicalPageId);
    assert.equal(decision.scheduledRunId, scheduledRunId);
    assert.equal(decision.rationaleJson.kind, "delete");
    assert.equal(decision.rationaleJson.origin, "scheduled");
    assert.equal(decision.rationaleJson.tool, "delete_page");
    assert.ok(
      db.insertedValues.some(
        (value) =>
          (value as { action?: string }).action === "auto_apply_delete",
      ),
    );
    assert.ok(db.deletedTables.length > 0);
  });

  it("auto-applies merge decisions with a canonical revision and purged source metadata", async () => {
    // Scheduled Agent merges promote the canonical revision immediately and
    // permanently purge source pages to avoid trash restore conflicts.
    const db = new FakeDb({
      selectQueue: [
        currentPage(canonicalPageId, "Canonical", baseRevisionId, "# Old"),
        currentPage(sourcePageId, "Source", sourceRevisionId, "# Source"),
        [{ createdAt: new Date("2026-05-01T00:00:00Z") }],
        [],
        [{ createdAt: new Date("2026-05-01T00:00:00Z") }],
        [],
        [{ pageId: sourcePageId, path: "source" }],
        [{ id: sourcePageId, title: "Source" }],
        [],
      ],
      executeQueue: [[{ id: sourcePageId }], [{ id: sourcePageId }]],
      returningIds: ["decision-id", "revision-id"],
    });
    const tools = createMutateTools(input({ scheduledAutoApply: false }));

    const result = await tools.merge_pages.execute(
      ctx(db, [canonicalPageId, sourcePageId]),
      {
        canonicalPageId,
        sourcePageIds: [sourcePageId],
        mergedContentMd: "# Merged\n\nCombined content",
        confidence: 0.98,
        reason: "consolidate overlapping pages",
      },
    );
    const data = result.data as {
      action: string;
      status: string;
      revisionId: string;
    };

    assert.deepEqual(result.mutatedPageIds, [canonicalPageId, sourcePageId]);
    assert.equal(data.action, "merge");
    assert.equal(data.status, "auto_applied");
    assert.equal(data.revisionId, "revision-id");

    const decision = db.insertedValues.find(
      (value) => (value as { action?: string }).action === "merge",
    ) as {
      status: string;
      targetPageId: string;
      rationaleJson: {
        kind: string;
        canonicalPageId: string;
        sourcePageIds: string[];
      };
    };
    assert.equal(decision.status, "auto_applied");
    assert.equal(decision.targetPageId, canonicalPageId);
    assert.equal(decision.rationaleJson.kind, "merge");
    assert.deepEqual(decision.rationaleJson.sourcePageIds, [sourcePageId]);

    const revision = db.insertedValues.find((value) =>
      (value as { revisionNote?: string }).revisionNote?.includes(
        "merge_pages",
      ),
    ) as {
      pageId: string;
      baseRevisionId: string;
      sourceDecisionId: string;
      contentMd: string;
      source: string;
    };
    assert.equal(revision.pageId, canonicalPageId);
    assert.equal(revision.baseRevisionId, baseRevisionId);
    assert.equal(revision.sourceDecisionId, "decision-id");
    assert.equal(revision.contentMd, "# Merged\n\nCombined content");
    assert.equal(revision.source, "scheduled");

    assert.ok(
      db.updatedValues.some(
        (value) =>
          (value as { proposedRevisionId?: string }).proposedRevisionId ===
          "revision-id",
      ),
    );
    assert.ok(
      db.updatedValues.some(
        (value) =>
          (value as { currentRevisionId?: string }).currentRevisionId ===
          "revision-id",
      ),
    );
    assert.ok(
      db.insertedValues.some(
        (value) => (value as { action?: string }).action === "auto_apply_merge",
      ),
    );
    assert.ok(db.deletedTables.length > 0);
  });
});
