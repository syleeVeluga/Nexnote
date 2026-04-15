import { describe, it, expect } from "vitest";
import {
  computeMarkdownDiff,
  computeBlockDiff,
  computeDiff,
} from "./diff-engine.js";

// ---------------------------------------------------------------------------
// Markdown diff
// ---------------------------------------------------------------------------

describe("computeMarkdownDiff", () => {
  it("empty to content — all additions", () => {
    const diff = computeMarkdownDiff("", "# Hello\n\nWorld\n");
    expect(diff).toContain("+# Hello");
    expect(diff).toContain("+World");
  });

  it("content to empty — all deletions", () => {
    const diff = computeMarkdownDiff("# Hello\n\nWorld\n", "");
    expect(diff).toContain("-# Hello");
    expect(diff).toContain("-World");
  });

  it("identical content — no hunks", () => {
    const text = "# Title\n\nSome content\n";
    const diff = computeMarkdownDiff(text, text);
    // Unified diff for identical files has no hunk headers
    expect(diff).not.toContain("@@");
  });

  it("single line change", () => {
    const old = "line1\nline2\nline3\n";
    const next = "line1\nmodified\nline3\n";
    const diff = computeMarkdownDiff(old, next);
    expect(diff).toContain("-line2");
    expect(diff).toContain("+modified");
    // Unchanged lines should appear as context
    expect(diff).toContain(" line1");
    expect(diff).toContain(" line3");
  });

  it("multi-hunk diff", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join(
      "\n",
    );
    // Change line 2 and line 18 (separated by >2*context lines)
    const modified = lines
      .replace("line2", "changed2")
      .replace("line18", "changed18");
    const diff = computeMarkdownDiff(lines, modified);
    // Should have two hunk headers
    const hunkCount = (diff.match(/^@@/gm) || []).length;
    expect(hunkCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Block diff
// ---------------------------------------------------------------------------

function makeDoc(blocks: unknown[]) {
  return { type: "doc", content: blocks };
}

function para(text: string) {
  return {
    type: "paragraph",
    content: [{ type: "text", text }],
  };
}

describe("computeBlockDiff", () => {
  it("add a block", () => {
    const old = makeDoc([para("a"), para("b")]);
    const next = makeDoc([para("a"), para("b"), para("c")]);
    const result = computeBlockDiff(
      old as Record<string, unknown>,
      next as Record<string, unknown>,
    );
    expect(result.changedBlocks).toBe(1);
    expect(result.ops.filter((o) => o.type === "add")).toHaveLength(1);
    expect(result.ops.filter((o) => o.type === "keep")).toHaveLength(2);
  });

  it("remove a block", () => {
    const old = makeDoc([para("a"), para("b"), para("c")]);
    const next = makeDoc([para("a"), para("b")]);
    const result = computeBlockDiff(
      old as Record<string, unknown>,
      next as Record<string, unknown>,
    );
    expect(result.changedBlocks).toBe(1);
    expect(result.ops.filter((o) => o.type === "remove")).toHaveLength(1);
  });

  it("modify a block", () => {
    const old = makeDoc([para("a"), para("b")]);
    const next = makeDoc([para("a"), para("changed")]);
    const result = computeBlockDiff(
      old as Record<string, unknown>,
      next as Record<string, unknown>,
    );
    expect(result.changedBlocks).toBe(1);
    expect(result.ops[0].type).toBe("keep");
    expect(result.ops[1].type).toBe("modify");
  });

  it("identical — zero changes", () => {
    const doc = makeDoc([para("a"), para("b")]);
    const result = computeBlockDiff(
      doc as Record<string, unknown>,
      doc as Record<string, unknown>,
    );
    expect(result.changedBlocks).toBe(0);
    expect(result.ops.every((o) => o.type === "keep")).toBe(true);
  });

  it("null oldJson — all adds", () => {
    const next = makeDoc([para("a"), para("b")]);
    const result = computeBlockDiff(
      null,
      next as Record<string, unknown>,
    );
    expect(result.changedBlocks).toBe(2);
    expect(result.ops.every((o) => o.type === "add")).toBe(true);
  });

  it("null newJson — all removes", () => {
    const old = makeDoc([para("a"), para("b")]);
    const result = computeBlockDiff(
      old as Record<string, unknown>,
      null,
    );
    expect(result.changedBlocks).toBe(2);
    expect(result.ops.every((o) => o.type === "remove")).toBe(true);
  });

  it("both null — no changes", () => {
    const result = computeBlockDiff(null, null);
    expect(result.changedBlocks).toBe(0);
    expect(result.ops).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Combined diff
// ---------------------------------------------------------------------------

describe("computeDiff", () => {
  it("returns diffMd, diffOpsJson, and changedBlocks", () => {
    const old = makeDoc([para("hello")]);
    const next = makeDoc([para("world")]);
    const result = computeDiff(
      "hello\n",
      "world\n",
      old as Record<string, unknown>,
      next as Record<string, unknown>,
    );
    expect(result.diffMd).toContain("-hello");
    expect(result.diffMd).toContain("+world");
    expect(result.changedBlocks).toBe(1);
    expect(result.diffOpsJson).toHaveLength(1);
    expect(result.diffOpsJson[0].type).toBe("modify");
  });
});
