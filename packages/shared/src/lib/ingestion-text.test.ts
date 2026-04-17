import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { extractIngestionText } from "./ingestion-text.js";

// ---------------------------------------------------------------------------
// extractIngestionText
// ---------------------------------------------------------------------------
describe("extractIngestionText", () => {
  // ---- normalizedText available ----

  it("returns normalizedText when it is a non-empty string", () => {
    const result = extractIngestionText({
      normalizedText: "already normalized",
      rawPayload: { content: "should not be used" },
    });
    assert.equal(result, "already normalized");
  });

  it("returns normalizedText even when rawPayload is a string", () => {
    const result = extractIngestionText({
      normalizedText: "normalized wins",
      rawPayload: "raw string",
    });
    assert.equal(result, "normalized wins");
  });

  // ---- normalizedText is null ----

  it("extracts .content from object rawPayload when normalizedText is null", () => {
    const result = extractIngestionText({
      normalizedText: null,
      rawPayload: { content: "  extracted content  " },
    });
    assert.equal(result, "extracted content");
  });

  it("returns trimmed string when rawPayload is a string and normalizedText is null", () => {
    const result = extractIngestionText({
      normalizedText: null,
      rawPayload: "  raw text with whitespace  ",
    });
    assert.equal(result, "raw text with whitespace");
  });

  it("JSON stringifies rawPayload when it is a number", () => {
    const result = extractIngestionText({
      normalizedText: null,
      rawPayload: 42,
    });
    assert.equal(result, "42");
  });

  it("JSON stringifies rawPayload when it is an array", () => {
    const result = extractIngestionText({
      normalizedText: null,
      rawPayload: [1, 2, 3],
    });
    assert.equal(result, "[1,2,3]");
  });

  it("JSON stringifies rawPayload when it is an object without any known text key", () => {
    const result = extractIngestionText({
      normalizedText: null,
      rawPayload: { title: "no text key" },
    });
    assert.equal(result, '{"title":"no text key"}');
  });

  it("extracts .text from object rawPayload", () => {
    const result = extractIngestionText({
      normalizedText: null,
      rawPayload: { text: "  from text field  " },
    });
    assert.equal(result, "from text field");
  });

  it("extracts .markdown from object rawPayload", () => {
    const result = extractIngestionText({
      normalizedText: null,
      rawPayload: { markdown: "# from markdown field" },
    });
    assert.equal(result, "# from markdown field");
  });

  it("extracts .body from object rawPayload", () => {
    const result = extractIngestionText({
      normalizedText: null,
      rawPayload: { body: "from body field" },
    });
    assert.equal(result, "from body field");
  });

  it("prefers .content over .text when both present", () => {
    const result = extractIngestionText({
      normalizedText: null,
      rawPayload: { text: "text wins not", content: "content wins" },
    });
    assert.equal(result, "content wins");
  });

  it("JSON stringifies null rawPayload", () => {
    const result = extractIngestionText({
      normalizedText: null,
      rawPayload: null,
    });
    assert.equal(result, "null");
  });

  it("JSON stringifies boolean rawPayload", () => {
    const result = extractIngestionText({
      normalizedText: null,
      rawPayload: true,
    });
    assert.equal(result, "true");
  });

  // ---- normalizedText is empty string (falsy) ----

  it("falls through when normalizedText is an empty string", () => {
    const result = extractIngestionText({
      normalizedText: "",
      rawPayload: { content: "fallback content" },
    });
    // empty string is falsy, so the function falls through to rawPayload
    assert.equal(result, "fallback content");
  });

  // ---- edge case: .content in rawPayload is not a string ----

  it("coerces non-string .content via String()", () => {
    const result = extractIngestionText({
      normalizedText: null,
      rawPayload: { content: 12345 },
    });
    assert.equal(result, "12345");
  });

  it("handles .content that is null via String()", () => {
    const result = extractIngestionText({
      normalizedText: null,
      rawPayload: { content: null },
    });
    assert.equal(result, "null");
  });
});
