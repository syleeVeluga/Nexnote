import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMarkdownBlocks } from "./read.js";

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
