import { describe, it, expect } from "vitest";
import { extractDeterministicFacts } from "./deterministic-extractor.js";

describe("extractDeterministicFacts", () => {
  it("extracts frontmatter title, tags (inline array), and aliases (block)", () => {
    const md = `---
title: "Acme Corp"
tags: [company, east-asia]
aliases:
  - Acme
  - "Acme Inc"
---

Body text.`;
    const out = extractDeterministicFacts(md);
    expect(out.title).toBe("Acme Corp");
    expect(out.tags).toEqual(["company", "east-asia"]);
    expect(out.aliases).toEqual(["Acme", "Acme Inc"]);
    expect(out.strippedMarkdown).toBe("Body text.");
  });

  it("leaves markdown untouched when no frontmatter is present", () => {
    const md = "# Header\n\nContent.";
    const out = extractDeterministicFacts(md);
    expect(out.title).toBeNull();
    expect(out.tags).toEqual([]);
    expect(out.aliases).toEqual([]);
    expect(out.strippedMarkdown).toBe(md);
  });

  it("collects distinct external links, dropping relative or anchor hrefs", () => {
    const md = `See [OpenAI](https://openai.com) and [Docs](https://docs.openai.com).
Also [Internal](/pages/123) and [Anchor](#section) and [Repeat](https://openai.com "title").`;
    const out = extractDeterministicFacts(md);
    expect(out.externalLinks.map((l) => l.url).sort()).toEqual([
      "https://docs.openai.com",
      "https://openai.com",
    ]);
  });

  it("does not treat image syntax as a link", () => {
    const md = "![alt text](https://example.com/img.png)";
    const out = extractDeterministicFacts(md);
    expect(out.externalLinks).toEqual([]);
  });

  it("collects wikilinks with optional display label, dedup by target", () => {
    const md = "See [[Alpha]], [[Beta|second]], and [[Alpha]] again.";
    const out = extractDeterministicFacts(md);
    expect(out.wikilinks).toEqual([
      { target: "Alpha", display: null },
      { target: "Beta", display: "second" },
    ]);
  });

  it("accepts tags declared as comma-separated string", () => {
    const md = `---
tags: alpha, beta, gamma
---
body`;
    const out = extractDeterministicFacts(md);
    expect(out.tags).toEqual(["alpha", "beta", "gamma"]);
  });
});
