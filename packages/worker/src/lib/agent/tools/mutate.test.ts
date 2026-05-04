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
const rollbackTargetRevisionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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

    const autonomousTools = createMutateTools(
      input({
        origin: "ingestion",
        allowDestructiveScheduledAgent: false,
        autonomyMode: "autonomous",
      }),
    );
    assert.ok(autonomousTools.delete_page);
    assert.ok(autonomousTools.merge_pages);
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

  it("queues autonomous shadow destructive decisions without applying them", async () => {
    const db = new FakeDb({
      selectQueue: [
        currentPage(canonicalPageId, "Duplicate", baseRevisionId),
        [{ createdAt: new Date("2026-05-01T00:00:00Z") }],
        [],
      ],
    });
    const tools = createMutateTools(
      input({
        origin: "ingestion",
        scheduledRunId: null,
        scheduledAutoApply: false,
        allowDestructiveScheduledAgent: false,
        autonomyMode: "autonomous_shadow",
      }),
    );

    const result = await tools.delete_page.execute(ctx(db, [canonicalPageId]), {
      pageId: canonicalPageId,
      confidence: 0.99,
      reason: "duplicate of canonical content",
    });
    const data = result.data as { action: string; status: string };

    assert.equal(data.action, "delete");
    assert.equal(data.status, "suggested");
    assert.equal(db.deletedTables.length, 0);
    const decision = db.insertedValues.find(
      (value) => (value as { action?: string }).action === "delete",
    ) as {
      status: string;
      scheduledRunId: string | null;
      rationaleJson: { origin: string; tool: string };
    };
    assert.equal(decision.status, "suggested");
    assert.equal(decision.scheduledRunId, null);
    assert.equal(decision.rationaleJson.origin, "ingestion");
    assert.equal(decision.rationaleJson.tool, "delete_page");
  });

  it("soft-deletes autonomous ingestion delete decisions instead of purging", async () => {
    const db = new FakeDb({
      selectQueue: [
        currentPage(canonicalPageId, "Duplicate", baseRevisionId),
        [{ createdAt: new Date("2026-05-01T00:00:00Z") }],
        [],
        [{ id: canonicalPageId, title: "Duplicate", deletedAt: null }],
        [],
      ],
      executeQueue: [[{ id: canonicalPageId }], [], []],
    });
    const tools = createMutateTools(
      input({
        origin: "ingestion",
        scheduledRunId: null,
        scheduledAutoApply: false,
        allowDestructiveScheduledAgent: false,
        autonomyMode: "autonomous",
      }),
    );

    const result = await tools.delete_page.execute(ctx(db, [canonicalPageId]), {
      pageId: canonicalPageId,
      confidence: 0.99,
      reason: "duplicate of canonical content",
    });
    const data = result.data as {
      action: string;
      status: string;
      deletedPageIds: string[];
    };

    assert.equal(data.action, "delete");
    assert.equal(data.status, "auto_applied");
    assert.deepEqual(data.deletedPageIds, [canonicalPageId]);
    assert.equal(db.deletedTables.length, 0);
    assert.ok(
      db.updatedValues.some((value) =>
        Object.prototype.hasOwnProperty.call(value as object, "deletedAt"),
      ),
    );
    assert.ok(
      db.insertedValues.some(
        (value) =>
          (value as { action?: string; beforeJson?: { source?: string } })
            .action === "delete" &&
          (value as { beforeJson?: { source?: string } }).beforeJson?.source ===
            "ingestion_agent_delete",
      ),
    );
    const autoApplyAudit = db.insertedValues.find(
      (value) => (value as { action?: string }).action === "auto_apply_delete",
    ) as { afterJson: { purgedPageIds?: string[] } };
    assert.equal(autoApplyAudit.afterJson.purgedPageIds, undefined);
  });

  it("rejects destructive tools after the per-run autonomy cap", async () => {
    const db = new FakeDb({
      selectQueue: [
        currentPage(canonicalPageId, "Duplicate", baseRevisionId),
        [{ createdAt: new Date("2026-05-01T00:00:00Z") }],
        [],
      ],
    });
    const tools = createMutateTools(
      input({
        origin: "ingestion",
        scheduledRunId: null,
        allowDestructiveScheduledAgent: false,
        autonomyMode: "autonomous",
        autonomyMaxDestructivePerRun: 0,
      }),
    );

    await assert.rejects(
      tools.delete_page.execute(ctx(db, [canonicalPageId]), {
        pageId: canonicalPageId,
        confidence: 0.99,
        reason: "duplicate of canonical content",
      }),
      (err) =>
        err instanceof AgentToolError &&
        err.code === "destructive_limit_exceeded",
    );
    assert.equal(
      db.insertedValues.some(
        (value) => (value as { action?: string }).action === "delete",
      ),
      false,
    );
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

  it("rejects rollback_to_revision when the target page was not observed", async () => {
    const tools = createMutateTools(input({ origin: "ingestion" }));
    await assert.rejects(
      tools.rollback_to_revision.execute(ctx(new FakeDb()), {
        pageId: canonicalPageId,
        revisionId: rollbackTargetRevisionId,
        confidence: 0.99,
        reason: "undo mistaken autonomous edit",
      }),
      (err) =>
        err instanceof AgentToolError && err.code === "invalid_target_page",
    );
  });

  it("queues rollback_to_revision in autonomous shadow with human-revision warning", async () => {
    const db = new FakeDb({
      selectQueue: [
        currentPage(canonicalPageId, "Canonical", baseRevisionId, "# Current"),
        [{ id: rollbackTargetRevisionId, actorType: "user" }],
        [{ baseRevisionId: rollbackTargetRevisionId }],
      ],
    });
    const tools = createMutateTools(
      input({
        origin: "ingestion",
        scheduledRunId: null,
        allowDestructiveScheduledAgent: false,
        autonomyMode: "autonomous_shadow",
      }),
    );

    const result = await tools.rollback_to_revision.execute(
      ctx(db, [canonicalPageId]),
      {
        pageId: canonicalPageId,
        revisionId: rollbackTargetRevisionId,
        confidence: 0.99,
        reason: "undo mistaken autonomous edit",
      },
    );
    const data = result.data as { action: string; status: string };

    assert.equal(data.action, "update");
    assert.equal(data.status, "suggested");
    assert.equal(db.updatedValues.length, 0);
    const decision = db.insertedValues.find(
      (value) =>
        (value as { rationaleJson?: { tool?: string } }).rationaleJson?.tool ===
        "rollback_to_revision",
    ) as {
      action: string;
      status: string;
      targetPageId: string;
      rationaleJson: {
        rollbackTargetRevisionId: string;
        humanRecentRevisionWarning: boolean;
      };
    };
    assert.equal(decision.action, "update");
    assert.equal(decision.status, "suggested");
    assert.equal(decision.targetPageId, canonicalPageId);
    assert.equal(
      decision.rationaleJson.rollbackTargetRevisionId,
      rollbackTargetRevisionId,
    );
    assert.equal(decision.rationaleJson.humanRecentRevisionWarning, true);
  });

  it("downgrades rollback_to_revision when a human edited after the observed revision", async () => {
    const humanRevisionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const db = new FakeDb({
      selectQueue: [
        currentPage(canonicalPageId, "Canonical", humanRevisionId, "# Human"),
        [{ id: rollbackTargetRevisionId, actorType: "ai" }],
        [{ baseRevisionId: rollbackTargetRevisionId }],
        [{ createdAt: new Date("2026-05-05T00:00:00Z") }],
        [
          {
            id: humanRevisionId,
            actorUserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            createdAt: new Date("2026-05-05T00:05:00Z"),
            revisionNote: "manual correction",
          },
        ],
      ],
    });
    const context = ctx(db, [canonicalPageId]);
    context.state.observedPageRevisionIds.set(canonicalPageId, baseRevisionId);
    const tools = createMutateTools(
      input({
        origin: "ingestion",
        scheduledRunId: null,
        allowDestructiveScheduledAgent: false,
      }),
    );

    const result = await tools.rollback_to_revision.execute(context, {
      pageId: canonicalPageId,
      revisionId: rollbackTargetRevisionId,
      confidence: 0.99,
      reason: "undo mistaken autonomous edit",
    });
    const data = result.data as { action: string; status: string };

    assert.equal(data.action, "update");
    assert.equal(data.status, "suggested");
    assert.equal(db.updatedValues.length, 0);
    const decision = db.insertedValues.find(
      (value) =>
        (value as { rationaleJson?: { tool?: string } }).rationaleJson?.tool ===
        "rollback_to_revision",
    ) as {
      status: string;
      rationaleJson: {
        observedBaseRevisionId: string;
        conflict: { humanRevisionId: string; baseRevisionId: string };
      };
    };
    assert.equal(decision.status, "suggested");
    assert.equal(decision.rationaleJson.observedBaseRevisionId, baseRevisionId);
    assert.equal(
      decision.rationaleJson.conflict.humanRevisionId,
      humanRevisionId,
    );
    assert.equal(
      decision.rationaleJson.conflict.baseRevisionId,
      baseRevisionId,
    );
  });

  it("auto-applies rollback_to_revision without consuming destructive caps", async () => {
    const db = new FakeDb({
      selectQueue: [
        currentPage(canonicalPageId, "Canonical", baseRevisionId, "# Current"),
        [{ id: rollbackTargetRevisionId, actorType: "ai" }],
        [{ baseRevisionId: rollbackTargetRevisionId }],
        [{ createdAt: new Date("2026-05-05T00:00:00Z") }],
        [],
        [
          {
            id: rollbackTargetRevisionId,
            pageId: canonicalPageId,
            contentMd: "# Restored",
            contentJson: null,
          },
        ],
        [
          {
            id: canonicalPageId,
            currentRevisionId: baseRevisionId,
            currentContentMd: "# Current",
            currentContentJson: null,
          },
        ],
      ],
      returningIds: ["decision-id", "rollback-revision-id"],
    });
    const context = ctx(db, [canonicalPageId]);
    const tools = createMutateTools(
      input({
        origin: "ingestion",
        scheduledRunId: null,
        allowDestructiveScheduledAgent: false,
        autonomyMode: "autonomous",
        autonomyMaxDestructivePerRun: 0,
      }),
    );

    const result = await tools.rollback_to_revision.execute(context, {
      pageId: canonicalPageId,
      revisionId: rollbackTargetRevisionId,
      confidence: 0.99,
      reason: "undo mistaken autonomous edit",
    });
    const data = result.data as {
      action: string;
      status: string;
      revisionId: string;
    };

    assert.equal(data.action, "update");
    assert.equal(data.status, "auto_applied");
    assert.equal(data.revisionId, "rollback-revision-id");
    assert.equal(context.state.destructiveCount, 0);
    assert.ok(
      db.insertedValues.some(
        (value) =>
          (value as { action?: string; afterJson?: { actorType?: string } })
            .action === "rollback" &&
          (value as { afterJson?: { actorType?: string } }).afterJson
            ?.actorType === "ai",
      ),
    );
    assert.ok(
      db.updatedValues.some(
        (value) =>
          (value as { proposedRevisionId?: string }).proposedRevisionId ===
          "rollback-revision-id",
      ),
    );
  });
});
