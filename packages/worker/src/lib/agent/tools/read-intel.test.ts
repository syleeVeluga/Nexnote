import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAgentRunState, type AgentDb } from "../types.js";
import { createReadOnlyTools } from "./read.js";

interface QueuedResult {
  rows: unknown[];
}

function fakeDb(queued: QueuedResult[]): AgentDb {
  let cursor = 0;
  const next = () => {
    if (cursor >= queued.length) {
      throw new Error(
        `Mock DB ran out of queued results (cursor=${cursor}). Provided ${queued.length}.`,
      );
    }
    const result = queued[cursor];
    cursor += 1;
    return result.rows;
  };

  const chain: Record<string, unknown> = {};
  const sink = (..._args: unknown[]) => chain;
  chain.from = sink;
  chain.innerJoin = sink;
  chain.leftJoin = sink;
  chain.where = sink;
  chain.orderBy = sink;
  chain.groupBy = sink;
  chain.limit = async () => next();
  chain.offset = sink;
  // Allow awaiting the chain directly (e.g. count queries)
  (chain as unknown as { then: unknown }).then = async (
    onFulfilled: (value: unknown) => unknown,
  ) => onFulfilled(next());

  return {
    select: () => chain,
  } as unknown as AgentDb;
}

const ctxBase = {
  workspaceId: "ws-1",
  model: { provider: "openai" as const, model: "gpt-5.4" },
  env: undefined,
};

describe("read_page_metadata", () => {
  it("returns metadata, parent path, and frontmatter", async () => {
    const tools = createReadOnlyTools();
    const pageId = "11111111-1111-4111-8111-111111111111";
    const parentPageId = "22222222-2222-4222-8222-222222222222";
    const grandFolderId = "33333333-3333-4333-8333-333333333333";

    const db = fakeDb([
      {
        rows: [
          {
            id: pageId,
            title: "Child Page",
            slug: "child-page",
            parentPageId,
            parentFolderId: null,
            currentRevisionId: "44444444-4444-4444-8444-444444444444",
            lastAiUpdatedAt: new Date("2026-04-01T00:00:00Z"),
            lastHumanEditedAt: null,
            latestPublishedSnapshotId: null,
            contentMd:
              "---\ntitle: Child Page\ntags: [docs, draft]\n---\n\nbody",
          },
        ],
      },
      // childCount query
      { rows: [{ value: 0 }] },
      // livePublished snapshot query
      { rows: [{ id: "snap-1" }] },
      // openSuggestions query
      { rows: [{ value: 0 }] },
      // parent page lookup
      {
        rows: [
          {
            id: parentPageId,
            title: "Parent Page",
            parentPageId: null,
            parentFolderId: grandFolderId,
          },
        ],
      },
      // grandparent folder lookup
      {
        rows: [
          {
            id: grandFolderId,
            name: "Engineering",
            parentFolderId: null,
          },
        ],
      },
    ]);

    const result = await tools.read_page_metadata.execute(
      { db, ...ctxBase, state: createAgentRunState() },
      { pageId },
    );

    const data = result.data as Record<string, unknown>;
    assert.equal(data.pageId, pageId);
    assert.equal(data.parentPath, "Engineering / Parent Page");
    assert.equal(data.isPublished, true);
    assert.equal(data.hasOpenSuggestions, false);
    assert.equal(data.childCount, 0);
    assert.deepEqual(data.frontmatter, {
      title: "Child Page",
      tags: ["docs", "draft"],
    });
    assert.deepEqual(result.observedPageIds, [pageId]);
  });

  it("throws not_found when page is missing", async () => {
    const tools = createReadOnlyTools();
    const db = fakeDb([{ rows: [] }]);

    await assert.rejects(
      () =>
        tools.read_page_metadata.execute(
          { db, ...ctxBase, state: createAgentRunState() },
          { pageId: "00000000-0000-4000-8000-000000000000" },
        ),
      /not found/,
    );
  });
});

describe("find_backlinks", () => {
  it("classifies wikilink and markdown matches and registers seen pages", async () => {
    const tools = createReadOnlyTools();
    const targetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const linkerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const linkerRevisionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    const db = fakeDb([
      // target page lookup
      {
        rows: [{ id: targetId, title: "Pricing Plan", slug: "pricing-plan" }],
      },
      // backlink scan
      {
        rows: [
          {
            id: linkerId,
            title: "Customer Notes",
            slug: "customer-notes",
            currentRevisionId: linkerRevisionId,
            contentMd:
              "Refer to [[Pricing Plan]] and our [archive](/notes/pricing-plan) page.",
            lastAiUpdatedAt: new Date("2026-04-02T00:00:00Z"),
          },
        ],
      },
    ]);

    const result = await tools.find_backlinks.execute(
      { db, ...ctxBase, state: createAgentRunState() },
      { pageId: targetId, limit: 30 },
    );

    const data = result.data as {
      backlinks: Array<{ matchType: string; pageId: string; snippet: string }>;
      total: number;
      limited: boolean;
    };
    assert.equal(data.total, 1);
    assert.equal(data.limited, false);
    assert.equal(data.backlinks[0].matchType, "wikilink_title");
    assert.equal(data.backlinks[0].pageId, linkerId);
    assert.match(data.backlinks[0].snippet, /Pricing Plan/);
    assert.deepEqual(result.observedPageIds, [linkerId]);
  });

  it("keeps SQL ILIKE and classifier matching case-insensitive", async () => {
    const tools = createReadOnlyTools();
    const targetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const linkerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    const db = fakeDb([
      {
        rows: [{ id: targetId, title: "Pricing Plan", slug: "pricing-plan" }],
      },
      {
        rows: [
          {
            id: linkerId,
            title: "Case Variant",
            slug: "case-variant",
            currentRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            contentMd: "See [[pricing plan]] before launch.",
            lastAiUpdatedAt: new Date("2026-04-02T00:00:00Z"),
          },
        ],
      },
    ]);

    const result = await tools.find_backlinks.execute(
      { db, ...ctxBase, state: createAgentRunState() },
      { pageId: targetId, limit: 30 },
    );

    const data = result.data as {
      backlinks: Array<{ matchType: string; pageId: string }>;
      total: number;
    };
    assert.equal(data.total, 1);
    assert.equal(data.backlinks[0].matchType, "wikilink_title");
    assert.equal(data.backlinks[0].pageId, linkerId);
  });

  it("disables wikilink_title for short titles", async () => {
    const tools = createReadOnlyTools();
    const targetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    const db = fakeDb([
      { rows: [{ id: targetId, title: "AI", slug: "ai" }] },
      { rows: [] },
    ]);

    const result = await tools.find_backlinks.execute(
      { db, ...ctxBase, state: createAgentRunState() },
      { pageId: targetId, limit: 30 },
    );

    const data = result.data as { shortTitleSkipped: boolean; total: number };
    assert.equal(data.shortTitleSkipped, true);
    assert.equal(data.total, 0);
  });

  it("flags limited=true when probe returns more than limit", async () => {
    const tools = createReadOnlyTools();
    const targetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    const rows = Array.from({ length: 4 }, (_, i) => ({
      id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, "0")}`,
      title: `Linker ${i}`,
      slug: `linker-${i}`,
      currentRevisionId: `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, "0")}`,
      contentMd: "[[Pricing Plan]]",
      lastAiUpdatedAt: new Date("2026-04-02T00:00:00Z"),
    }));

    const db = fakeDb([
      { rows: [{ id: targetId, title: "Pricing Plan", slug: "pricing-plan" }] },
      { rows },
    ]);

    const result = await tools.find_backlinks.execute(
      { db, ...ctxBase, state: createAgentRunState() },
      { pageId: targetId, limit: 3 },
    );

    const data = result.data as { limited: boolean; total: number };
    assert.equal(data.limited, true);
    assert.equal(data.total, 3);
  });
});

describe("read_revision_history", () => {
  it("returns revisions and registers them in observedRevisionIds", async () => {
    const tools = createReadOnlyTools();
    const pageId = "11111111-1111-4111-8111-111111111111";
    const r1 = "22222222-2222-4222-8222-222222222221";
    const r2 = "22222222-2222-4222-8222-222222222222";

    const db = fakeDb([
      { rows: [{ id: pageId }] },
      {
        rows: [
          {
            id: r1,
            pageId,
            baseRevisionId: r2,
            actorUserId: null,
            actorType: "ai",
            source: "ingestion",
            revisionNote: null,
            createdAt: new Date("2026-04-02T00:00:00Z"),
            changedBlocks: 3,
            sourceIngestionId: "i-1",
            sourceDecisionId: "d-1",
          },
          {
            id: r2,
            pageId,
            baseRevisionId: null,
            actorUserId: "u-1",
            actorType: "user",
            source: "editor",
            revisionNote: "first draft",
            createdAt: new Date("2026-04-01T00:00:00Z"),
            changedBlocks: null,
            sourceIngestionId: null,
            sourceDecisionId: null,
          },
        ],
      },
    ]);

    const result = await tools.read_revision_history.execute(
      { db, ...ctxBase, state: createAgentRunState() },
      { pageId, limit: 20 },
    );

    const data = result.data as { revisions: Array<{ id: string }>; limited: boolean };
    assert.equal(data.revisions.length, 2);
    assert.equal(data.limited, false);
    assert.deepEqual(result.observedRevisionIds, [r1, r2]);
  });

  it("rejects pages not found in the workspace", async () => {
    const tools = createReadOnlyTools();
    const db = fakeDb([{ rows: [] }]);

    await assert.rejects(
      () =>
        tools.read_revision_history.execute(
          { db, ...ctxBase, state: createAgentRunState() },
          {
            pageId: "00000000-0000-4000-8000-000000000000",
            limit: 20,
          },
        ),
      /not found/,
    );
  });
});

describe("read_revision", () => {
  const pageId = "11111111-1111-4111-8111-111111111111";
  const revisionId = "22222222-2222-4222-8222-222222222222";
  const currentRevisionId = "33333333-3333-4333-8333-333333333333";

  function revisionRow() {
    return {
      id: revisionId,
      pageId,
      baseRevisionId: null,
      actorUserId: null,
      actorType: "ai",
      source: "ingestion",
      revisionNote: null,
      createdAt: new Date("2026-04-02T00:00:00Z"),
      contentMd: "# Hello\n\nworld",
      contentJson: { type: "doc" },
      diffMd: "+ hello",
      diffOpsJson: [{ op: "insert", text: "hello" }],
      pageWorkspaceId: "ws-1",
      pageDeletedAt: null,
      pageCurrentRevisionId: revisionId,
    };
  }

  it("returns content when revision is observed via state.seenRevisionIds", async () => {
    const tools = createReadOnlyTools();
    const state = createAgentRunState();
    state.seenRevisionIds.add(revisionId);

    const db = fakeDb([{ rows: [revisionRow()] }]);
    const result = await tools.read_revision.execute(
      { db, ...ctxBase, state },
      { revisionId, includeContent: true },
    );
    const data = result.data as { contentMd: string; lineDiff: string | null };
    assert.equal(data.contentMd, "# Hello\n\nworld");
    assert.equal(data.lineDiff, "+ hello");
  });

  it("rejects when neither revisionId nor pageId is observed", async () => {
    const tools = createReadOnlyTools();
    const db = fakeDb([{ rows: [revisionRow()] }]);

    await assert.rejects(
      () =>
        tools.read_revision.execute(
          { db, ...ctxBase, state: createAgentRunState() },
          { revisionId, includeContent: true },
        ),
      /already observed/,
    );
  });

  it("allows an observed page to read a revision in its current chain", async () => {
    const tools = createReadOnlyTools();
    const state = createAgentRunState();
    state.seenPageIds.add(pageId);

    const db = fakeDb([
      {
        rows: [
          {
            ...revisionRow(),
            pageCurrentRevisionId: currentRevisionId,
          },
        ],
      },
      {
        rows: [
          {
            id: currentRevisionId,
            baseRevisionId: revisionId,
          },
        ],
      },
    ]);

    const result = await tools.read_revision.execute(
      { db, ...ctxBase, state },
      { revisionId, includeContent: true },
    );

    const data = result.data as { id: string; contentMd: string | null };
    assert.equal(data.id, revisionId);
    assert.equal(data.contentMd, "# Hello\n\nworld");
  });

  it("rejects an observed page when the revision is outside the current chain", async () => {
    const tools = createReadOnlyTools();
    const state = createAgentRunState();
    state.seenPageIds.add(pageId);

    const db = fakeDb([
      {
        rows: [
          {
            ...revisionRow(),
            pageCurrentRevisionId: currentRevisionId,
          },
        ],
      },
      {
        rows: [
          {
            id: currentRevisionId,
            baseRevisionId: null,
          },
        ],
      },
    ]);

    await assert.rejects(
      () =>
        tools.read_revision.execute(
          { db, ...ctxBase, state },
          { revisionId, includeContent: true },
        ),
      /current revision chain/,
    );
  });

  it("rejects when the revision belongs to a different workspace", async () => {
    const tools = createReadOnlyTools();
    const state = createAgentRunState();
    state.seenRevisionIds.add(revisionId);

    const otherWorkspaceRow = { ...revisionRow(), pageWorkspaceId: "ws-2" };
    const db = fakeDb([{ rows: [otherWorkspaceRow] }]);

    await assert.rejects(
      () =>
        tools.read_revision.execute(
          { db, ...ctxBase, state },
          { revisionId, includeContent: true },
        ),
      /not found/,
    );
  });

  it("omits content when includeContent=false", async () => {
    const tools = createReadOnlyTools();
    const state = createAgentRunState();
    state.seenPageIds.add(pageId);

    const db = fakeDb([{ rows: [revisionRow()] }]);
    const result = await tools.read_revision.execute(
      { db, ...ctxBase, state },
      { revisionId, includeContent: false },
    );
    const data = result.data as { contentMd: string | null };
    assert.equal(data.contentMd, null);
  });
});
