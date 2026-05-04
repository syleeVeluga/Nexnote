import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFrontmatter } from "./frontmatter.js";

describe("parseFrontmatter", () => {
  it("returns data: null when no frontmatter is present", () => {
    const result = parseFrontmatter("# Just a heading\n\nbody text");
    assert.equal(result.data, null);
    assert.equal(result.parseError, undefined);
  });

  it("parses a typical frontmatter block", () => {
    const md = [
      "---",
      "title: My Page",
      'aliases: ["alpha", "beta"]',
      "tags:",
      "  - docs",
      "  - draft",
      "published: true",
      "version: 3",
      "---",
      "",
      "Body",
    ].join("\n");

    const result = parseFrontmatter(md);
    assert.deepEqual(result.data, {
      title: "My Page",
      aliases: ["alpha", "beta"],
      tags: ["docs", "draft"],
      published: true,
      version: 3,
    });
    assert.equal(result.parseError, undefined);
  });

  it("handles \\r\\n line endings", () => {
    const md = "---\r\ntitle: CRLF\r\n---\r\nbody";
    const result = parseFrontmatter(md);
    assert.deepEqual(result.data, { title: "CRLF" });
  });

  it("returns empty object for an empty frontmatter block", () => {
    const md = "---\n\n---\n\nbody";
    const result = parseFrontmatter(md);
    assert.deepEqual(result.data, {});
  });

  it("does not match a single --- line without the closing fence", () => {
    const md = "---\nbody only";
    const result = parseFrontmatter(md);
    assert.equal(result.data, null);
  });

  it("parses frontmatter even without trailing body", () => {
    const md = "---\nonly: true\n---\n";
    const result = parseFrontmatter(md);
    assert.deepEqual(result.data, { only: true });
  });

  it("flags malformed lines with a parseError but salvages parseable keys", () => {
    const md = ["---", "title: Mixed", "this is not a kv line", "---", ""].join(
      "\n",
    );
    const result = parseFrontmatter(md);
    assert.deepEqual(result.data, { title: "Mixed" });
    assert.match(result.parseError ?? "", /unparseable/);
  });

  it("handles a long frontmatter with many keys", () => {
    const lines = ["---"];
    for (let i = 0; i < 200; i += 1) {
      lines.push(`key_${i}: value_${i}`);
    }
    lines.push("---", "body");
    const result = parseFrontmatter(lines.join("\n"));
    assert.equal(result.parseError, undefined);
    assert.equal(Object.keys(result.data ?? {}).length, 200);
    assert.equal((result.data as Record<string, unknown>)["key_199"], "value_199");
  });
});
