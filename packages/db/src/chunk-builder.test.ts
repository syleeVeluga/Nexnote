import assert from "node:assert/strict";
import test from "node:test";
import { buildRevisionChunks } from "./chunk-builder.js";

test("buildRevisionChunks preserves document, section, and leaf offsets", () => {
  const markdown = `# Alpha

First paragraph about Alpha.

## Beta

Second paragraph about Beta.
`;

  const chunks = buildRevisionChunks(markdown);
  const document = chunks.find((chunk) => chunk.chunkKind === "document");
  const sections = chunks.filter((chunk) => chunk.chunkKind === "section");
  const leaves = chunks.filter((chunk) => chunk.chunkKind === "leaf");

  assert.ok(document);
  assert.equal(document.charStart, 0);
  assert.equal(document.charEnd, markdown.length);
  assert.equal(sections.length, 2);
  assert.ok(leaves.length >= 2);

  for (const chunk of chunks) {
    assert.equal(markdown.slice(chunk.charStart, chunk.charEnd), chunk.contentMd);
    assert.equal(chunk.contentHash.length, 64);
  }
});

test("buildRevisionChunks returns stable hashes for identical content", () => {
  const markdown = "# Stable\n\nRepeated content.";
  const first = buildRevisionChunks(markdown);
  const second = buildRevisionChunks(markdown);

  assert.deepEqual(
    first.map((chunk) => chunk.contentHash),
    second.map((chunk) => chunk.contentHash),
  );
});
