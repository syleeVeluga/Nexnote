import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAgentRunState, type AgentDb } from "../types.js";
import { createReadOnlyTools, parseMarkdownBlocks } from "./read.js";

function fakeReadPageDb(row: Record<string, unknown>): AgentDb {
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    limit: async () => [row],
  };
  return {
    select: () => chain,
  } as unknown as AgentDb;
}

describe("parseMarkdownBlocks", () => {
  it("splits markdown into stable block IDs", () => {
    const markdown = [
      "# Title",
      "",
      "Intro paragraph.",
      "",
      "```ts",
      "const answer = 42;",
      "",
      "console.log(answer);",
      "```",
      "",
      "- item one",
      "- item two",
      "",
    ].join("\n");

    const blocks = parseMarkdownBlocks(markdown);
    const again = parseMarkdownBlocks(markdown);

    assert.deepEqual(
      blocks.map((block) => block.type),
      ["heading", "paragraph", "code", "list"],
    );
    assert.deepEqual(
      blocks.map((block) => block.id),
      again.map((block) => block.id),
    );
    assert.match(blocks[0].id, /^blk_0000_[a-f0-9]{12}$/);
    assert.equal(blocks[0].headingLevel, 1);
    assert.equal(blocks[2].content.includes("\n\nconsole.log"), true);
  });
});

describe("read_page", () => {
  it("falls back from markdown to compact blocks when a page is too large", async () => {
    const pageId = "11111111-1111-4111-8111-111111111111";
    const contentMd = [
      "# Large Page",
      "",
      "intro ".repeat(2_000),
      "",
      "## Details",
      "",
      "details ".repeat(2_000),
    ].join("\n");
    const tools = createReadOnlyTools();

    const result = await tools.read_page.execute(
      {
        db: fakeReadPageDb({
          id: pageId,
          title: "Large Page",
          slug: "large-page",
          path: "large-page",
          currentRevisionId: "22222222-2222-4222-8222-222222222222",
          parentFolderId: null,
          parentPageId: null,
          updatedAt: new Date("2026-04-30T00:00:00.000Z"),
          lastAiUpdatedAt: null,
          lastHumanEditedAt: null,
          contentMd,
          contentJson: null,
          revisionCreatedAt: new Date("2026-04-30T00:00:00.000Z"),
        }),
        workspaceId: "workspace-1",
        state: createAgentRunState(),
        model: { provider: "openai", model: "gpt-5.4" },
        env: {
          AGENT_INPUT_TOKEN_BUDGET: "2000",
          AGENT_OUTPUT_TOKEN_BUDGET: "200",
          AGENT_READ_PAGE_MARKDOWN_FALLBACK_RATIO: "0.5",
          AGENT_READ_PAGE_MARKDOWN_TOKEN_LIMIT: "1000",
          AGENT_READ_PAGE_BLOCK_FALLBACK_CONTENT_TOKENS: "80",
        },
      },
      { pageId, format: "markdown" },
    );

    const data = result.data as {
      format: string;
      requestedFormat?: string;
      fallback?: { type?: string; contentTruncatedCount?: number };
      blocks?: Array<{ id: string; contentTruncated?: boolean }>;
    };
    assert.equal(data.format, "blocks");
    assert.equal(data.requestedFormat, "markdown");
    assert.equal(data.fallback?.type, "markdown_to_blocks");
    assert.ok((data.fallback?.contentTruncatedCount ?? 0) > 0);
    assert.ok((data.blocks?.length ?? 0) > 0);
    assert.deepEqual(
      result.observedBlockIds,
      data.blocks?.map((block) => block.id),
    );
  });

  it("caps heading blocks that include body text in markdown fallback", async () => {
    const pageId = "33333333-3333-4333-8333-333333333333";
    const contentMd = `# Large Page\n${"body ".repeat(2_000)}`;
    const tools = createReadOnlyTools();

    const result = await tools.read_page.execute(
      {
        db: fakeReadPageDb({
          id: pageId,
          title: "Large Page",
          slug: "large-page",
          path: "large-page",
          currentRevisionId: "44444444-4444-4444-8444-444444444444",
          parentFolderId: null,
          parentPageId: null,
          updatedAt: new Date("2026-04-30T00:00:00.000Z"),
          lastAiUpdatedAt: null,
          lastHumanEditedAt: null,
          contentMd,
          contentJson: null,
          revisionCreatedAt: new Date("2026-04-30T00:00:00.000Z"),
        }),
        workspaceId: "workspace-1",
        state: createAgentRunState(),
        model: { provider: "openai", model: "gpt-5.4" },
        env: {
          AGENT_INPUT_TOKEN_BUDGET: "2000",
          AGENT_OUTPUT_TOKEN_BUDGET: "200",
          AGENT_READ_PAGE_MARKDOWN_FALLBACK_RATIO: "0.5",
          AGENT_READ_PAGE_MARKDOWN_TOKEN_LIMIT: "1000",
          AGENT_READ_PAGE_BLOCK_FALLBACK_CONTENT_TOKENS: "80",
        },
      },
      { pageId, format: "markdown" },
    );

    const data = result.data as {
      fallback?: { contentTruncatedCount?: number };
      blocks?: Array<{
        type: string;
        content: string;
        contentTruncated?: boolean;
        contentTokenEstimate?: number;
      }>;
    };
    const [headingBlock] = data.blocks ?? [];

    assert.equal(data.fallback?.contentTruncatedCount, 1);
    assert.equal(headingBlock?.type, "heading");
    assert.equal(headingBlock?.contentTruncated, true);
    assert.ok(
      (headingBlock?.content.length ?? contentMd.length) < contentMd.length,
    );
  });
});
