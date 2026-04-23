import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { slugify } from "./slugify.js";
import { normalizeKey } from "./normalize-key.js";
import { slugSchema } from "../schemas/common.js";

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------
describe("slugify", () => {
  // ---- ASCII inputs ----

  it("converts ASCII title to lowercase hyphenated slug", () => {
    assert.equal(slugify("Hello World"), "hello-world");
  });

  it("replaces multiple special characters with a single hyphen", () => {
    assert.equal(slugify("Hello!@#$World"), "hello-world");
  });

  it("removes leading and trailing hyphens", () => {
    assert.equal(slugify("--hello--"), "hello");
  });

  it("collapses consecutive hyphens from mixed separators", () => {
    assert.equal(slugify("a   b---c"), "a-b-c");
  });

  it("returns 'untitled' for empty string", () => {
    assert.equal(slugify(""), "untitled");
  });

  it("returns 'untitled' for only special characters", () => {
    assert.equal(slugify("!@#$%^&*()"), "untitled");
  });

  it("preserves digits", () => {
    assert.equal(slugify("Version 2.0 Release"), "version-2-0-release");
  });

  // ---- Korean inputs ----

  it("preserves Korean (Hangul) characters", () => {
    assert.equal(slugify("한국어 가이드"), "한국어-가이드");
  });

  it("handles fully Korean title", () => {
    assert.equal(slugify("소개 문서"), "소개-문서");
  });

  it("handles mixed Korean and ASCII", () => {
    assert.equal(slugify("React 19 사용법"), "react-19-사용법");
  });

  it("handles Korean with special characters", () => {
    assert.equal(slugify("WekiFlow: 소개 & 설치"), "wekiflow-소개-설치");
  });

  it("does not produce 'untitled' for Korean-only titles", () => {
    const result = slugify("타입스크립트");
    assert.notEqual(result, "untitled");
    assert.equal(result, "타입스크립트");
  });

  // ---- CJK / other scripts ----

  it("preserves Japanese characters", () => {
    assert.equal(slugify("東京タワー"), "東京タワー");
  });

  it("preserves Cyrillic characters", () => {
    assert.equal(slugify("Привет мир"), "привет-мир");
  });

  // ---- maxLength ----

  it("truncates to maxLength", () => {
    const long = "a".repeat(300);
    const result = slugify(long);
    assert.equal(result.length, 200);
  });

  it("respects custom maxLength", () => {
    const result = slugify("hello-world-test", 5);
    assert.equal(result, "hello");
  });

  // ---- cross-validation with slugSchema ----

  it("ASCII slug passes slugSchema", () => {
    const result = slugify("Hello World");
    assert.ok(slugSchema.safeParse(result).success, `"${result}" should pass slugSchema`);
  });

  it("Korean slug passes slugSchema", () => {
    const result = slugify("한국어 가이드");
    assert.ok(slugSchema.safeParse(result).success, `"${result}" should pass slugSchema`);
  });

  it("mixed slug passes slugSchema", () => {
    const result = slugify("React 19 사용법");
    assert.ok(slugSchema.safeParse(result).success, `"${result}" should pass slugSchema`);
  });

  it("'untitled' fallback passes slugSchema", () => {
    const result = slugify("");
    assert.ok(slugSchema.safeParse(result).success, `"${result}" should pass slugSchema`);
  });
});

// ---------------------------------------------------------------------------
// normalizeKey
// ---------------------------------------------------------------------------
describe("normalizeKey", () => {
  it("normalizes ASCII name to lowercase underscored key", () => {
    assert.equal(normalizeKey("TypeScript"), "typescript");
  });

  it("replaces spaces and special chars with underscores", () => {
    assert.equal(normalizeKey("React Native"), "react_native");
  });

  it("removes leading and trailing underscores", () => {
    assert.equal(normalizeKey("--hello--"), "hello");
  });

  it("preserves Korean characters", () => {
    assert.equal(normalizeKey("타입스크립트"), "타입스크립트");
  });

  it("normalizes mixed Korean and ASCII", () => {
    assert.equal(normalizeKey("React 컴포넌트"), "react_컴포넌트");
  });

  it("handles Korean with special characters", () => {
    assert.equal(normalizeKey("WekiFlow: 소개"), "wekiflow_소개");
  });

  it("does not produce empty string for Korean-only input", () => {
    const result = normalizeKey("한국어");
    assert.ok(result.length > 0, "should not be empty");
    assert.equal(result, "한국어");
  });
});
