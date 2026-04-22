import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildPromptMessages,
  parsePredicateLabelPayload,
} from "./predicate-label-cache.js";

describe("buildPromptMessages", () => {
  it("builds Korean prompt guidance", () => {
    const [systemMessage, userMessage] = buildPromptMessages("ko", [
      "works_at",
    ]);

    assert.match(systemMessage.content, /Korean display labels/);
    assert.match(systemMessage.content, /\uadfc\ubb34/);
    assert.equal(
      userMessage.content,
      JSON.stringify({ locale: "ko", predicates: ["works_at"] }),
    );
  });

  it("builds English prompt guidance", () => {
    const [systemMessage, userMessage] = buildPromptMessages("en", [
      "works_at",
    ]);

    assert.match(systemMessage.content, /English display labels/);
    assert.match(systemMessage.content, /works at/);
    assert.equal(
      userMessage.content,
      JSON.stringify({ locale: "en", predicates: ["works_at"] }),
    );
  });
});

describe("parsePredicateLabelPayload", () => {
  it("keeps only expected predicates with normalized labels", () => {
    const result = parsePredicateLabelPayload(
      JSON.stringify({
        labels: [
          { predicate: "works_at", displayLabel: "  \uadfc\ubb34  " },
          { predicate: "ignored", displayLabel: "\ubb34\uc2dc" },
          { predicate: "works_at", displayLabel: "\uc911\ubcf5" },
        ],
      }),
      ["works_at"],
    );

    assert.deepEqual(result, [
      { predicate: "works_at", displayLabel: "\uadfc\ubb34" },
    ]);
  });

  it("throws when the payload shape is invalid", () => {
    assert.throws(
      () =>
        parsePredicateLabelPayload(JSON.stringify({ nope: [] }), ["works_at"]),
      /labels array/,
    );
  });
});
