import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildKey } from "./s3.js";

describe("storage/s3 buildKey", () => {
  const workspaceId = "11111111-1111-1111-1111-111111111111";
  const sha = "a".repeat(64);

  it("includes workspace prefix, month slot, sha, and extension", () => {
    const key = buildKey(workspaceId, sha, ".pdf");
    assert.match(key, /^ws\/11111111-1111-1111-1111-111111111111\/\d{4}-\d{2}\/a+\.pdf$/);
  });

  it("accepts an extension without a leading dot", () => {
    const key = buildKey(workspaceId, sha, "html");
    assert.ok(key.endsWith(".html"), `expected .html suffix, got ${key}`);
  });

  it("omits extension when null", () => {
    const key = buildKey(workspaceId, sha, null);
    assert.ok(!key.includes("."), `expected no dot, got ${key}`);
  });

  it("omits extension when input is not alphanumeric", () => {
    const key = buildKey(workspaceId, sha, "../evil");
    // Suspicious extensions are silently dropped — buildKey should never emit
    // slashes or traversal sequences past the sha hex segment.
    assert.ok(
      !key.includes(".."),
      `expected no traversal, got ${key}`,
    );
    assert.ok(
      !key.includes("/evil"),
      `expected extension to be stripped, got ${key}`,
    );
  });

  it("lowercases extension", () => {
    const key = buildKey(workspaceId, sha, ".PDF");
    assert.ok(key.endsWith(".pdf"), `expected lowercased suffix, got ${key}`);
  });
});
