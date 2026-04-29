import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentToolError } from "../types.js";
import { parseMarkdownBlocks } from "../tools/read.js";
import { applyBlockPatch } from "./block-patch.js";
import { applyReplaceInPagePatch } from "./inline-patch.js";
import { applySectionPatch } from "./section-patch.js";

describe("agent patch primitives", () => {
  it("applies exact replace_in_page patches and rejects ambiguity", () => {
    const markdown = "Redis TTL is 30s.\nRedis TTL changed later.\n";
    const patched = applyReplaceInPagePatch(markdown, {
      find: "30s",
      replace: "60s",
    });

    assert.equal(patched.contentMd, "Redis TTL is 60s.\nRedis TTL changed later.\n");

    assert.throws(
      () =>
        applyReplaceInPagePatch(markdown, {
          find: "Redis",
          replace: "Valkey",
        }),
      (err) =>
        err instanceof AgentToolError &&
        err.code === "ambiguous_match" &&
        Array.isArray(err.selfCorrection?.candidates),
    );
  });

  it("returns nearest text candidates when replace_in_page misses", () => {
    assert.throws(
      () =>
        applyReplaceInPagePatch("Redis TTL is 30 seconds.\nCache notes.\n", {
          find: "Redis TTL is 60 seconds.",
          replace: "Redis TTL is 90 seconds.",
        }),
      (err) =>
        err instanceof AgentToolError &&
        err.code === "patch_mismatch" &&
        Array.isArray(err.selfCorrection?.candidates) &&
        err.selfCorrection.candidates.length > 0,
    );
  });

  it("applies block replace, insert, and delete operations", () => {
    const markdown = ["# Title", "", "Keep me.", "", "Replace me.", ""].join(
      "\n",
    );
    const blocks = parseMarkdownBlocks(markdown);
    const result = applyBlockPatch(markdown, [
      {
        blockId: blocks[1].id,
        op: "insert_after",
        content: "Inserted paragraph.",
      },
      {
        blockId: blocks[2].id,
        op: "replace",
        content: "Replacement paragraph.",
      },
    ]);

    assert.match(result.contentMd, /Keep me\.\n\nInserted paragraph\./);
    assert.match(result.contentMd, /Replacement paragraph\./);
    assert.equal(result.changedBlocks, 2);
  });

  it("applies heading section operations within peer heading boundaries", () => {
    const markdown = [
      "# Page",
      "",
      "Intro.",
      "",
      "## API Reference",
      "",
      "Old endpoint.",
      "",
      "### Details",
      "",
      "Old detail.",
      "",
      "## Changelog",
      "",
      "Initial.",
      "",
    ].join("\n");

    const result = applySectionPatch(markdown, {
      sectionAnchor: "api-reference",
      op: "replace",
      content: "New endpoint.",
    });

    assert.match(result.contentMd, /## API Reference\n\nNew endpoint\./);
    assert.doesNotMatch(result.contentMd, /Old detail\./);
    assert.match(result.contentMd, /## Changelog\n\nInitial\./);
  });

  it("ignores markdown-looking headings inside fenced code blocks", () => {
    const markdown = [
      "# Page",
      "",
      "```md",
      "## API Reference",
      "code sample",
      "```",
      "",
      "## API Reference",
      "",
      "Old endpoint.",
      "",
    ].join("\n");

    const result = applySectionPatch(markdown, {
      sectionAnchor: "api-reference",
      op: "replace",
      content: "New endpoint.",
    });

    assert.match(result.contentMd, /```md\n## API Reference\ncode sample\n```/);
    assert.match(result.contentMd, /## API Reference\n\nNew endpoint\./);
    assert.doesNotMatch(result.contentMd, /Old endpoint\./);
  });
});
