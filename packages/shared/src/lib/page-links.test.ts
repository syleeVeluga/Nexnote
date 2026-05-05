import { describe, expect, it } from "vitest";
import {
  extractPageLinks,
  normalizePageLinkTarget,
  pageLinkTargetLookupKeys,
} from "./page-links.js";

describe("extractPageLinks", () => {
  it("extracts wikilinks and markdown links with offsets", () => {
    const md =
      "See [[Pricing Plan|pricing]] and [the plan](/docs/pricing-plan#intro).";

    expect(extractPageLinks(md)).toEqual([
      {
        targetSlug: "Pricing Plan",
        linkText: "pricing",
        linkType: "wikilink",
        positionInMd: 4,
      },
      {
        targetSlug: "docs/pricing-plan",
        linkText: "the plan",
        linkType: "markdown",
        positionInMd: 33,
      },
    ]);
  });

  it("skips external URLs, image links, and fenced code", () => {
    const md = [
      "![img](asset)",
      "[external](https://example.com)",
      "```",
      "[hidden](internal)",
      "[[Hidden]]",
      "```",
      "[visible](internal)",
    ].join("\n");

    expect(extractPageLinks(md)).toEqual([
      {
        targetSlug: "internal",
        linkText: "visible",
        linkType: "markdown",
        positionInMd: md.lastIndexOf("[visible]"),
      },
    ]);
  });
});

describe("normalizePageLinkTarget", () => {
  it("normalizes page paths and rejects non-page targets", () => {
    expect(normalizePageLinkTarget("/docs/page?tab=a#section")).toBe("docs/page");
    expect(normalizePageLinkTarget("#local")).toBeNull();
    expect(normalizePageLinkTarget("mailto:a@example.com")).toBeNull();
  });
});

describe("pageLinkTargetLookupKeys", () => {
  it("adds case-insensitive path and slug lookup aliases", () => {
    expect(pageLinkTargetLookupKeys("/docs/acme/Pricing-Plan#intro")).toEqual([
      "docs/acme/pricing-plan",
      "pricing-plan",
      "acme/pricing-plan",
    ]);
  });
});
