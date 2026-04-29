import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  createApiTokenValue,
  hashApiTokenSecret,
  parseApiTokenValue,
  verifyApiTokenSecret,
} from "./api-tokens.js";

describe("api token helpers", () => {
  it("creates parseable one-time token values and verifies hashes", () => {
    const tokenId = "00000000-0000-0000-0000-000000000001";
    const { token, secret } = createApiTokenValue(tokenId);
    const parsed = parseApiTokenValue(token);

    assert.deepEqual(parsed, { tokenId, secret });
    assert.equal(
      verifyApiTokenSecret(secret, hashApiTokenSecret(secret)),
      true,
    );
    assert.equal(
      verifyApiTokenSecret("not-the-secret", hashApiTokenSecret(secret)),
      false,
    );
  });

  it("rejects malformed token values", () => {
    assert.equal(parseApiTokenValue("Bearer abc"), null);
    assert.equal(parseApiTokenValue("wf_missing_parts"), null);
  });
});
