import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  estimateTokens,
  sliceWithinTokenBudget,
  allocateBudgets,
} from "./token-budget.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    assert.equal(estimateTokens(""), 0);
  });

  it("counts Latin text at ~4 chars per token", () => {
    const text = "a".repeat(100);
    const tokens = estimateTokens(text);
    assert.ok(tokens >= 24 && tokens <= 26, `expected ~25, got ${tokens}`);
  });

  it("counts CJK text at ~1 token per 1.5 chars", () => {
    const text = "한".repeat(100);
    const tokens = estimateTokens(text);
    assert.ok(tokens >= 66 && tokens <= 68, `expected ~67, got ${tokens}`);
  });

  it("mixes CJK and Latin correctly", () => {
    const ascii = estimateTokens("a".repeat(400));
    const cjk = estimateTokens("한".repeat(100));
    const mixed = estimateTokens("a".repeat(400) + "한".repeat(100));
    // Mixed total should equal sum of individual estimates (within rounding).
    assert.ok(Math.abs(mixed - (ascii + cjk)) <= 1);
  });
});

describe("sliceWithinTokenBudget", () => {
  it("returns full text when under budget", () => {
    const text = "hello world";
    const result = sliceWithinTokenBudget(text, 100);
    assert.equal(result.text, text);
    assert.equal(result.truncated, false);
    assert.equal(result.droppedChars, 0);
  });

  it("truncates when over budget", () => {
    const text = "a".repeat(1000);
    const result = sliceWithinTokenBudget(text, 10);
    assert.ok(result.text.length < text.length);
    assert.equal(result.truncated, true);
    assert.ok(result.droppedChars > 0);
  });

  it("preserves paragraph boundaries when preserveStructure is true", () => {
    const para1 = "First paragraph with some content.";
    const para2 = "Second paragraph after a blank line.";
    const para3 = "Third paragraph well beyond the budget.";
    const text = [para1, para2, para3].join("\n\n");
    // Budget just large enough for ~2 paragraphs.
    const tokensForTwo = estimateTokens([para1, para2].join("\n\n"));
    const result = sliceWithinTokenBudget(text, tokensForTwo, {
      preserveStructure: true,
    });
    assert.equal(result.truncated, true);
    assert.ok(result.text.includes(para1));
    // Should cut on a paragraph boundary — no partial third paragraph.
    assert.ok(!result.text.includes("beyond"));
  });

  it("returns empty result for empty input", () => {
    const result = sliceWithinTokenBudget("", 100);
    assert.equal(result.text, "");
    assert.equal(result.truncated, false);
  });

  it("returns empty result for zero budget", () => {
    const result = sliceWithinTokenBudget("hello", 0);
    assert.equal(result.text, "");
    assert.equal(result.truncated, true);
  });
});

describe("allocateBudgets", () => {
  it("gives each slot its full text when total fits", () => {
    const result = allocateBudgets(
      [
        { key: "a", text: "short", minTokens: 10, weight: 1 },
        { key: "b", text: "also short", minTokens: 10, weight: 1 },
      ],
      10_000,
    );
    assert.equal(result.a.text, "short");
    assert.equal(result.b.text, "also short");
    assert.equal(result.a.truncated, false);
    assert.equal(result.b.truncated, false);
  });

  it("splits a tight budget by weight", () => {
    const aText = "a".repeat(4000);
    const bText = "b".repeat(4000);
    const result = allocateBudgets(
      [
        { key: "a", text: aText, minTokens: 100, weight: 3 },
        { key: "b", text: bText, minTokens: 100, weight: 1 },
      ],
      500,
    );
    // Both should be truncated, and 'a' should get more chars than 'b'.
    assert.equal(result.a.truncated, true);
    assert.equal(result.b.truncated, true);
    assert.ok(result.a.text.length > result.b.text.length);
  });

  it("redistributes slack from a short slot to a hungry one", () => {
    const shortText = "tiny";
    const longText = "x".repeat(10_000);
    const resultFair = allocateBudgets(
      [
        { key: "short", text: shortText, minTokens: 50, weight: 1 },
        { key: "long", text: longText, minTokens: 50, weight: 1 },
      ],
      500,
    );
    // 'short' gets exactly its length; surplus goes to 'long'.
    assert.equal(resultFair.short.text, shortText);
    assert.equal(resultFair.short.truncated, false);
    assert.equal(resultFair.long.truncated, true);
    // long should exceed its half-share because it absorbed slack.
    assert.ok(resultFair.long.allocatedTokens > 250);
  });

  it("respects minTokens floors even when weight is zero", () => {
    const result = allocateBudgets(
      [
        { key: "pinned", text: "z".repeat(1000), minTokens: 50, weight: 0 },
        { key: "main", text: "m".repeat(1000), minTokens: 50, weight: 1 },
      ],
      200,
    );
    // Pinned slot must still get at least enough tokens for its floor.
    assert.ok(result.pinned.allocatedTokens >= 50);
  });

  it("returns empty object for empty slot list", () => {
    const result = allocateBudgets([], 1000);
    assert.deepEqual(result, {});
  });
});
