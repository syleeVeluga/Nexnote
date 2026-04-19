import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { getAIAdapter, getDefaultProvider } from "./ai-gateway.js";

// ---------------------------------------------------------------------------
// Helper: save and restore environment variables around each suite
// ---------------------------------------------------------------------------
const ENV_KEYS = [
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_MODEL",
  "GEMINI_MODEL",
  "AI_TEST_MODE",
] as const;

type EnvSnapshot = Record<string, string | undefined>;

function snapshotEnv(): EnvSnapshot {
  const snap: EnvSnapshot = {};
  for (const key of ENV_KEYS) {
    snap[key] = process.env[key];
  }
  return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snap)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearAIEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

// ---------------------------------------------------------------------------
// getAIAdapter
// ---------------------------------------------------------------------------
describe("getAIAdapter", () => {
  it("returns an adapter for the openai provider", () => {
    const adapter = getAIAdapter("openai");
    assert.ok(adapter, "adapter should be defined");
    assert.equal(adapter.provider, "openai");
    assert.equal(typeof adapter.chat, "function");
  });

  it("returns an adapter for the gemini provider", () => {
    const adapter = getAIAdapter("gemini");
    assert.ok(adapter, "adapter should be defined");
    assert.equal(adapter.provider, "gemini");
    assert.equal(typeof adapter.chat, "function");
  });

  it("returns different adapter instances for different providers", () => {
    const openai = getAIAdapter("openai");
    const gemini = getAIAdapter("gemini");
    assert.notEqual(openai, gemini);
  });
});

// ---------------------------------------------------------------------------
// getDefaultProvider
// ---------------------------------------------------------------------------
describe("getDefaultProvider", () => {
  let saved: EnvSnapshot;

  before(() => {
    saved = snapshotEnv();
  });

  after(() => {
    restoreEnv(saved);
  });

  it("returns openai when OPENAI_API_KEY is set", () => {
    clearAIEnv();
    process.env["OPENAI_API_KEY"] = "sk-test-key";

    const result = getDefaultProvider();
    assert.equal(result.provider, "openai");
    assert.equal(result.model, "gpt-5.4");
  });

  it("returns gemini when only GEMINI_API_KEY is set", () => {
    clearAIEnv();
    process.env["GEMINI_API_KEY"] = "gem-test-key";

    const result = getDefaultProvider();
    assert.equal(result.provider, "gemini");
    assert.equal(result.model, "gemini-3.1-pro");
  });

  it("prefers openai when both keys are set", () => {
    clearAIEnv();
    process.env["OPENAI_API_KEY"] = "sk-test-key";
    process.env["GEMINI_API_KEY"] = "gem-test-key";

    const result = getDefaultProvider();
    assert.equal(result.provider, "openai");
  });

  it("throws when no AI provider keys are set", () => {
    clearAIEnv();

    assert.throws(
      () => getDefaultProvider(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /No AI provider configured/);
        return true;
      },
    );
  });

  it("respects OPENAI_MODEL override", () => {
    clearAIEnv();
    process.env["OPENAI_API_KEY"] = "sk-test-key";
    process.env["OPENAI_MODEL"] = "gpt-5.4-pro";

    const result = getDefaultProvider();
    assert.equal(result.provider, "openai");
    assert.equal(result.model, "gpt-5.4-pro");
  });

  it("respects GEMINI_MODEL override", () => {
    clearAIEnv();
    process.env["GEMINI_API_KEY"] = "gem-test-key";
    process.env["GEMINI_MODEL"] = "gemini-3.1-pro-custom";

    const result = getDefaultProvider();
    assert.equal(result.provider, "gemini");
    assert.equal(result.model, "gemini-3.1-pro-custom");
  });

  it("uses default model when OPENAI_MODEL is not set", () => {
    clearAIEnv();
    process.env["OPENAI_API_KEY"] = "sk-test-key";
    // explicitly no OPENAI_MODEL

    const result = getDefaultProvider();
    assert.equal(result.model, "gpt-5.4");
  });

  it("uses default model when GEMINI_MODEL is not set", () => {
    clearAIEnv();
    process.env["GEMINI_API_KEY"] = "gem-test-key";
    // explicitly no GEMINI_MODEL

    const result = getDefaultProvider();
    assert.equal(result.model, "gemini-3.1-pro");
  });
});
