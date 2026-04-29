import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compactAgentMessages,
  packAgentExploreContext,
  packAgentPlanContext,
  selectAgentModel,
} from "./budgeter.js";

describe("selectAgentModel", () => {
  it("uses the fast model below the routing threshold", () => {
    const selected = selectAgentModel({
      estimatedInputTokens: 10_000,
      baseProvider: "openai",
      baseModel: "gpt-5.4",
      env: {
        AGENT_MODEL_FAST: "gpt-5.4-mini",
        AGENT_MODEL_LARGE_CONTEXT: "gpt-5.4-pro",
        AGENT_FAST_THRESHOLD_TOKENS: "50000",
      },
    });

    assert.equal(selected.provider, "openai");
    assert.equal(selected.model, "gpt-5.4-mini");
    assert.equal(selected.routing, "fast");
  });

  it("uses the large-context model above the routing threshold", () => {
    const selected = selectAgentModel({
      estimatedInputTokens: 80_000,
      baseProvider: "gemini",
      baseModel: "gemini-3.1-pro",
      env: {
        AGENT_MODEL_FAST: "gemini-3.1-flash-lite",
        AGENT_MODEL_LARGE_CONTEXT: "gemini-3.1-pro",
        AGENT_FAST_THRESHOLD_TOKENS: "50000",
      },
    });

    assert.equal(selected.provider, "gemini");
    assert.equal(selected.model, "gemini-3.1-pro");
    assert.equal(selected.routing, "large_context");
  });

  it("uses the overridden provider's default model when providers differ", () => {
    const selected = selectAgentModel({
      estimatedInputTokens: 10_000,
      baseProvider: "openai",
      baseModel: "gpt-5.4",
      env: {
        AGENT_PROVIDER: "gemini",
        GEMINI_MODEL: "gemini-3.1-pro",
        AGENT_FAST_THRESHOLD_TOKENS: "50000",
      },
    });

    assert.equal(selected.provider, "gemini");
    assert.equal(selected.model, "gemini-3.1-pro");
    assert.equal(selected.routing, "default");
  });
});

describe("agent context packing", () => {
  it("truncates the exploration prompt before the first model call", () => {
    const packed = packAgentExploreContext({
      provider: "openai",
      model: "gpt-5.4",
      systemPrompt: "Explore carefully.",
      ingestionText: `${"incoming ".repeat(20_000)}TAIL_MARKER`,
      sourceName: "test",
      contentType: "text/markdown",
      titleHint: "Incoming",
      env: {
        AGENT_INPUT_TOKEN_BUDGET: "5000",
        AGENT_OUTPUT_TOKEN_BUDGET: "1000",
      },
    });

    assert.match(packed.text, /Incoming content:/);
    assert.equal(packed.text.includes("TAIL_MARKER"), false);
    assert.equal(packed.budgetMeta.truncated, true);
    assert.equal(
      packed.budgetMeta.slotAllocations?.ingestion.truncated,
      true,
    );
  });

  it("truncates read context to fit the selected model budget", () => {
    const packed = packAgentPlanContext({
      provider: "openai",
      model: "gpt-5.4",
      systemPrompt: "Plan carefully.",
      ingestionText: "incoming ".repeat(2_000),
      sourceName: "test",
      contentType: "text/markdown",
      titleHint: "Incoming",
      blocks: [
        {
          key: "read_1",
          label: "read_page#1",
          text: "page ".repeat(100_000),
          minTokens: 200,
          weight: 1,
        },
      ],
      env: {
        AGENT_INPUT_TOKEN_BUDGET: "5000",
        AGENT_OUTPUT_TOKEN_BUDGET: "1000",
      },
    });

    assert.match(packed.text, /\[INGESTION\]/);
    assert.match(packed.text, /\[CONTEXT:read_page#1\]/);
    assert.equal(packed.budgetMeta.truncated, true);
    assert.equal(
      packed.budgetMeta.slotAllocations?.read_1.truncated,
      true,
    );
  });

  it("compacts oldest tool messages and emits a re-read notice near the threshold", () => {
    const messages = [
      { role: "system" as const, content: "Explore carefully." },
      { role: "user" as const, content: "Incoming content" },
      {
        role: "tool" as const,
        toolName: "read_page",
        toolCallId: "call_read_1",
        content: JSON.stringify({
          ok: true,
          result: {
            format: "markdown",
            page: { id: "page-1", title: "Large Page" },
            contentMd: "page ".repeat(20_000),
          },
        }),
      },
    ];

    const compacted = compactAgentMessages({
      provider: "openai",
      model: "gpt-5.4",
      messages,
      env: {
        AGENT_INPUT_TOKEN_BUDGET: "5000",
        AGENT_OUTPUT_TOKEN_BUDGET: "1000",
      },
    });

    assert.deepEqual(compacted.compactedToolCallIds, ["call_read_1"]);
    assert.equal(compacted.notices.length, 1);
    assert.match(
      compacted.messages.at(-1)?.content ?? "",
      /call the relevant read tool again/i,
    );
    assert.match(
      compacted.messages[2].content,
      /COMPACTED_TOOL_RESULT/,
    );
  });

  it("compacts oldest plan context blocks before allocation", () => {
    const packed = packAgentPlanContext({
      provider: "openai",
      model: "gpt-5.4",
      systemPrompt: "Plan carefully.",
      ingestionText: "incoming ".repeat(500),
      sourceName: "test",
      contentType: "text/markdown",
      titleHint: "Incoming",
      blocks: [
        {
          key: "read_1",
          label: "read_page#1",
          text: JSON.stringify({
            ok: true,
            result: {
              format: "markdown",
              page: { id: "page-1", title: "Large Page" },
              contentMd: "page ".repeat(20_000),
            },
          }),
          minTokens: 200,
          weight: 1,
        },
      ],
      env: {
        AGENT_INPUT_TOKEN_BUDGET: "5000",
        AGENT_OUTPUT_TOKEN_BUDGET: "1000",
      },
    });

    assert.equal(packed.compactionNotices?.length, 1);
    assert.match(packed.text, /SYSTEM_NOTICE:context_compaction/);
    assert.match(packed.text, /COMPACTED_TOOL_RESULT/);
  });
});
