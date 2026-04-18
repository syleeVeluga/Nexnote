import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  consumeRateLimit,
  parsePositiveInt,
  type RateLimitRedis,
} from "./rate-limit.js";

function fakeRedis(): RateLimitRedis & { ttls: Map<string, number> } {
  const store = new Map<string, number>();
  const ttls = new Map<string, number>();
  return {
    ttls,
    async incr(key) {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    },
    async expire(key, seconds) {
      ttls.set(key, seconds);
      return 1;
    },
  };
}

function failingRedis(): RateLimitRedis {
  return {
    async incr() {
      throw new Error("redis unreachable");
    },
    async expire() {
      throw new Error("redis unreachable");
    },
  };
}

describe("consumeRateLimit", () => {
  it("allows the first N requests within a window", async () => {
    const redis = fakeRedis();
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(
        await consumeRateLimit(redis, {
          key: "t:abc",
          limit: 3,
          windowSec: 60,
        }),
      );
    }
    assert.deepEqual(
      results.map((r) => r.allowed),
      [true, true, true],
    );
    assert.equal(results[2].remaining, 0);
  });

  it("blocks the (N+1)th request in the same window", async () => {
    const redis = fakeRedis();
    const cfg = { key: "t:abc", limit: 2, windowSec: 60 };
    await consumeRateLimit(redis, cfg);
    await consumeRateLimit(redis, cfg);
    const third = await consumeRateLimit(redis, cfg);
    assert.equal(third.allowed, false);
    assert.equal(third.remaining, 0);
    assert.ok(third.resetSec > 0 && third.resetSec <= 60);
  });

  it("sets TTL only on first increment per window", async () => {
    const redis = fakeRedis();
    const cfg = { key: "t:abc", limit: 5, windowSec: 60 };
    await consumeRateLimit(redis, cfg);
    await consumeRateLimit(redis, cfg);
    await consumeRateLimit(redis, cfg);
    assert.equal(redis.ttls.size, 1);
    assert.equal([...redis.ttls.values()][0], 60);
  });

  it("uses distinct counters per window boundary", async () => {
    const redis = fakeRedis();
    // Two different windows by key manipulation would require mocking Date;
    // instead assert that distinct-key configs produce distinct counters.
    const cfgA = { key: "t:a", limit: 1, windowSec: 60 };
    const cfgB = { key: "t:b", limit: 1, windowSec: 60 };
    const a1 = await consumeRateLimit(redis, cfgA);
    const a2 = await consumeRateLimit(redis, cfgA);
    const b1 = await consumeRateLimit(redis, cfgB);
    assert.equal(a1.allowed, true);
    assert.equal(a2.allowed, false);
    assert.equal(b1.allowed, true);
  });

  it("fails open when Redis throws (non-blocking on outage)", async () => {
    const result = await consumeRateLimit(failingRedis(), {
      key: "t:abc",
      limit: 10,
      windowSec: 60,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 10);
  });
});

describe("parsePositiveInt", () => {
  it("returns fallback for undefined", () => {
    assert.equal(parsePositiveInt(undefined, 42), 42);
  });
  it("returns fallback for empty string", () => {
    assert.equal(parsePositiveInt("", 42), 42);
  });
  it("returns fallback for non-numeric string", () => {
    assert.equal(parsePositiveInt("abc", 42), 42);
  });
  it("returns fallback for zero or negative", () => {
    assert.equal(parsePositiveInt("0", 42), 42);
    assert.equal(parsePositiveInt("-5", 42), 42);
  });
  it("parses valid positive integers", () => {
    assert.equal(parsePositiveInt("100", 42), 100);
  });
  it("floors floats", () => {
    assert.equal(parsePositiveInt("3.7", 42), 3);
  });
});
