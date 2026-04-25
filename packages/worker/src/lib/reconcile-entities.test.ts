import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  MATCH_METHODS,
  matchAgainstVocabulary,
  stripHonorificTokens,
} from "./reconcile-entities.js";
import { normalizeKey } from "@wekiflow/shared";

describe("stripHonorificTokens", () => {
  it("strips Korean leading honorifics", () => {
    assert.equal(stripHonorificTokens(normalizeKey("주식회사 벨루가")), "벨루가");
    assert.equal(stripHonorificTokens(normalizeKey("(주) 벨루가")), "벨루가");
    assert.equal(stripHonorificTokens(normalizeKey("(주)벨루가")), "벨루가");
  });

  it("strips English suffix honorifics", () => {
    assert.equal(stripHonorificTokens(normalizeKey("Veluga Inc")), "veluga");
    assert.equal(stripHonorificTokens(normalizeKey("Veluga Corp.")), "veluga");
    assert.equal(stripHonorificTokens(normalizeKey("Veluga Co Ltd")), "veluga");
  });

  it("returns null when no honorific token is present", () => {
    assert.equal(stripHonorificTokens(normalizeKey("벨루가")), null);
    assert.equal(stripHonorificTokens(normalizeKey("Apple")), null);
  });

  it("returns null on single-segment keys to avoid stripping a sole honorific", () => {
    assert.equal(stripHonorificTokens("주"), null);
    assert.equal(stripHonorificTokens("inc"), null);
  });
});

describe("matchAgainstVocabulary", () => {
  const candidates = [
    {
      id: "a",
      normalizedKey: "벨루가",
      canonicalName: "벨루가",
      mentionCount: 5,
      strippedKey: stripHonorificTokens("벨루가"),
    },
    {
      id: "b",
      normalizedKey: "wekiflow",
      canonicalName: "WekiFlow",
      mentionCount: 3,
      strippedKey: stripHonorificTokens("wekiflow"),
    },
  ];
  const contextById = new Map(candidates.map((c) => [c.id, c]));

  it("returns exact reuse when normalizedKey matches a candidate", () => {
    const out = matchAgainstVocabulary({
      normalizedKey: "벨루가",
      contextEntities: candidates,
      contextById,
      contextAliasIndex: new Map(),
    });
    assert.equal(out?.result.action, "reuse");
    if (out?.result.action === "reuse") {
      assert.equal(out.result.entityId, "a");
      assert.equal(out.result.matchMethod, MATCH_METHODS.EXACT);
    }
  });

  it("reuses on prior alias hit", () => {
    const aliasIndex = new Map<string, string>([
      [normalizeKey("주식회사 벨루가"), "a"],
    ]);
    const out = matchAgainstVocabulary({
      normalizedKey: normalizeKey("주식회사 벨루가"),
      contextEntities: candidates,
      contextById,
      contextAliasIndex: aliasIndex,
    });
    assert.equal(out?.result.action, "reuse");
    if (out?.result.action === "reuse") {
      assert.equal(out.result.entityId, "a");
      assert.equal(out.result.matchMethod, MATCH_METHODS.EXACT);
    }
  });

  it("reuses via honorific strip → exact match", () => {
    const out = matchAgainstVocabulary({
      normalizedKey: normalizeKey("주식회사 벨루가"),
      contextEntities: candidates,
      contextById,
      contextAliasIndex: new Map(),
    });
    assert.equal(out?.result.action, "reuse");
    if (out?.result.action === "reuse") {
      assert.equal(out.result.entityId, "a");
      assert.equal(out.result.matchMethod, MATCH_METHODS.HONORIFIC);
    }
  });

  it("falls through (returns null) when nothing in vocabulary matches synchronously", () => {
    const out = matchAgainstVocabulary({
      normalizedKey: normalizeKey("New Company"),
      contextEntities: candidates,
      contextById,
      contextAliasIndex: new Map(),
    });
    assert.equal(out, null);
  });

  it("returns null when vocabulary is empty", () => {
    const out = matchAgainstVocabulary({
      normalizedKey: "벨루가",
      contextEntities: [],
      contextById: new Map(),
      contextAliasIndex: new Map(),
    });
    assert.equal(out, null);
  });
});
