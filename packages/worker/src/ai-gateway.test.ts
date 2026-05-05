import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { getAIAdapter, getDefaultProvider } from "./ai-gateway.js";
import type { AIProvider, AIRequest, NormalizedToolCall } from "@wekiflow/shared";

// ---------------------------------------------------------------------------
// Helper: save and restore environment variables around each suite
// ---------------------------------------------------------------------------
const ENV_KEYS = [
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_MODEL",
  "GEMINI_MODEL",
  "ANTHROPIC_MODEL",
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

function makeToolFixtureRequest(provider: AIProvider): AIRequest {
  return {
    provider,
    model:
      provider === "openai"
        ? "gpt-5.4"
        : provider === "gemini"
          ? "gemini-3.1-pro"
          : "claude-sonnet-4-6",
    mode: "route_decision",
    promptVersion: "test-tool-calling",
    messages: [
      { role: "system", content: "Use tools when useful." },
      { role: "user", content: "Find Redis pages." },
    ],
    tools: [
      {
        name: "search_pages",
        description: "Search workspace pages.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer" },
          },
          required: ["query"],
        },
      },
    ],
    toolChoice: "required",
  };
}

// ---------------------------------------------------------------------------
// getAIAdapter
// ---------------------------------------------------------------------------
describe("getAIAdapter", () => {
  let saved: EnvSnapshot;

  before(() => {
    saved = snapshotEnv();
    clearAIEnv();
  });

  after(() => {
    restoreEnv(saved);
  });

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

  it("returns an adapter for the anthropic provider", () => {
    const adapter = getAIAdapter("anthropic");
    assert.ok(adapter, "adapter should be defined");
    assert.equal(adapter.provider, "anthropic");
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

  it("returns anthropic when only ANTHROPIC_API_KEY is set", () => {
    clearAIEnv();
    process.env["ANTHROPIC_API_KEY"] = "anthropic-test-key";

    const result = getDefaultProvider();
    assert.equal(result.provider, "anthropic");
    assert.equal(result.model, "claude-sonnet-4-6");
  });

  it("prefers openai when both keys are set", () => {
    clearAIEnv();
    process.env["OPENAI_API_KEY"] = "sk-test-key";
    process.env["GEMINI_API_KEY"] = "gem-test-key";
    process.env["ANTHROPIC_API_KEY"] = "anthropic-test-key";

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

  it("respects ANTHROPIC_MODEL override", () => {
    clearAIEnv();
    process.env["ANTHROPIC_API_KEY"] = "anthropic-test-key";
    process.env["ANTHROPIC_MODEL"] = "claude-opus-test";

    const result = getDefaultProvider();
    assert.equal(result.provider, "anthropic");
    assert.equal(result.model, "claude-opus-test");
  });

  it("normalizes legacy Gemini flash-lite model ids", () => {
    clearAIEnv();
    process.env["GEMINI_API_KEY"] = "gem-test-key";
    process.env["GEMINI_MODEL"] = "gemini-3.1-flash-lite";

    const result = getDefaultProvider();
    assert.equal(result.provider, "gemini");
    assert.equal(result.model, "gemini-3.1-flash-lite-preview");
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

  it("uses default model when ANTHROPIC_MODEL is not set", () => {
    clearAIEnv();
    process.env["ANTHROPIC_API_KEY"] = "anthropic-test-key";
    // explicitly no ANTHROPIC_MODEL

    const result = getDefaultProvider();
    assert.equal(result.model, "claude-sonnet-4-6");
  });
});

// ---------------------------------------------------------------------------
// tool-calling conformance
// ---------------------------------------------------------------------------
describe("AI gateway tool-calling normalization", () => {
  let savedEnv: EnvSnapshot;
  let savedFetch: typeof globalThis.fetch;

  before(() => {
    savedEnv = snapshotEnv();
    savedFetch = globalThis.fetch;
  });

  after(() => {
    restoreEnv(savedEnv);
    globalThis.fetch = savedFetch;
  });

  it("omits temperature for OpenAI GPT-5-family models", async () => {
    clearAIEnv();
    process.env["OPENAI_API_KEY"] = "sk-test-key";

    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "ok" },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    await getAIAdapter("openai").chat({
      provider: "openai",
      model: "gpt-5.4",
      mode: "agent_plan",
      promptVersion: "test-openai-temperature",
      messages: [{ role: "user", content: "go" }],
      temperature: 0.1,
    });

    await getAIAdapter("openai").chat({
      provider: "openai",
      model: "gpt-4.1",
      mode: "agent_plan",
      promptVersion: "test-openai-temperature",
      messages: [{ role: "user", content: "go" }],
      temperature: 0.1,
    });

    assert.equal(requests[0]?.["temperature"], undefined);
    assert.equal(requests[1]?.["temperature"], 0.1);
  });

  it("normalizes OpenAI and Gemini tool calls to the same shape", async () => {
    clearAIEnv();
    process.env["OPENAI_API_KEY"] = "sk-test-key";
    process.env["GEMINI_API_KEY"] = "gem-test-key";

    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = input.toString();
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      requests.push({ url, body });

      if (url.includes("api.openai.com")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "provider-call-123",
                      type: "function",
                      function: {
                        name: "search_pages",
                        arguments: JSON.stringify({
                          query: "redis",
                          limit: 5,
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    functionCall: {
                      name: "search_pages",
                      args: { query: "redis", limit: 5 },
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 11,
            candidatesTokenCount: 7,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    const openai = await getAIAdapter("openai").chat(
      makeToolFixtureRequest("openai"),
    );
    const gemini = await getAIAdapter("gemini").chat(
      makeToolFixtureRequest("gemini"),
    );

    const expected: NormalizedToolCall[] = [
      {
        id: "call_0_search_pages",
        name: "search_pages",
        arguments: { query: "redis", limit: 5 },
      },
    ];

    assert.deepEqual(openai.toolCalls, expected);
    assert.deepEqual(gemini.toolCalls, expected);
    assert.equal(openai.content, "");
    assert.equal(gemini.content, "");

    const openaiBody = requests.find((request) =>
      request.url.includes("api.openai.com"),
    )?.body as {
      tools?: Array<{ function?: { name?: string } }>;
      tool_choice?: string;
    };
    assert.equal(openaiBody.tools?.[0]?.function?.name, "search_pages");
    assert.equal(openaiBody.tool_choice, "required");

    const geminiBody = requests.find((request) =>
      request.url.includes("generativelanguage.googleapis.com"),
    )?.body as {
      tools?: Array<{ functionDeclarations?: Array<{ name?: string }> }>;
      toolConfig?: {
        functionCallingConfig?: { mode?: string };
      };
    };
    assert.equal(
      geminiBody.tools?.[0]?.functionDeclarations?.[0]?.name,
      "search_pages",
    );
    assert.equal(geminiBody.toolConfig?.functionCallingConfig?.mode, "ANY");
  });

  it("strips additionalProperties and rewrites nullable type unions for Gemini tools", async () => {
    clearAIEnv();
    process.env["GEMINI_API_KEY"] = "gem-test-key";

    let capturedBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      void input;
      return new Response(
        JSON.stringify({
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: "ok" }] } },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    await getAIAdapter("gemini").chat({
      provider: "gemini",
      model: "gemini-3.1-pro",
      mode: "agent_plan",
      promptVersion: "test-gemini-schema-sanitize",
      messages: [{ role: "user", content: "go" }],
      tools: [
        {
          name: "list_folder",
          parameters: {
            type: "object",
            properties: {
              folderId: { type: ["string", "null"], format: "uuid" },
            },
            additionalProperties: false,
          },
        },
      ],
    });

    const body = capturedBody as {
      tools?: Array<{
        functionDeclarations?: Array<{ parameters?: Record<string, unknown> }>;
      }>;
    } | null;
    const params = body?.tools?.[0]?.functionDeclarations?.[0]?.parameters as
      | {
          additionalProperties?: unknown;
          properties?: { folderId?: { type?: unknown; nullable?: unknown } };
        }
      | undefined;
    assert.ok(params, "expected sanitized parameters");
    assert.equal(params.additionalProperties, undefined);
    assert.equal(params.properties?.folderId?.type, "string");
    assert.equal(params.properties?.folderId?.nullable, true);
  });

  it("translates prior tool calls and tool results into provider-native messages", async () => {
    clearAIEnv();
    process.env["OPENAI_API_KEY"] = "sk-test-key";
    process.env["GEMINI_API_KEY"] = "gem-test-key";

    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = input.toString();
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      requests.push({ url, body });

      if (url.includes("api.openai.com")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "ok" },
              },
            ],
            usage: { prompt_tokens: 13, completion_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: "ok" }] },
            },
          ],
          usageMetadata: {
            promptTokenCount: 13,
            candidatesTokenCount: 1,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    const toolCall: NormalizedToolCall = {
      id: "call_0_search_pages",
      name: "search_pages",
      arguments: { query: "redis" },
    };

    const request = (provider: "openai" | "gemini"): AIRequest => ({
      ...makeToolFixtureRequest(provider),
      messages: [
        { role: "system", content: "Use tools when useful." },
        { role: "user", content: "Find Redis pages." },
        { role: "assistant", content: "", toolCalls: [toolCall] },
        {
          role: "tool",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: JSON.stringify({ results: [] }),
        },
        { role: "user", content: "Continue." },
      ],
    });

    await getAIAdapter("openai").chat(request("openai"));
    await getAIAdapter("gemini").chat(request("gemini"));

    const openaiBody = requests.find((item) =>
      item.url.includes("api.openai.com"),
    )?.body as {
      messages?: Array<{
        role?: string;
        tool_call_id?: string;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      }>;
    };
    const openaiAssistant = openaiBody.messages?.find(
      (message) => message.role === "assistant",
    );
    const openaiToolResult = openaiBody.messages?.find(
      (message) => message.role === "tool",
    );
    assert.equal(openaiAssistant?.tool_calls?.[0]?.id, toolCall.id);
    assert.equal(
      openaiAssistant?.tool_calls?.[0]?.function?.name,
      toolCall.name,
    );
    assert.equal(
      openaiAssistant?.tool_calls?.[0]?.function?.arguments,
      JSON.stringify(toolCall.arguments),
    );
    assert.equal(openaiToolResult?.tool_call_id, toolCall.id);

    const geminiBody = requests.find((item) =>
      item.url.includes("generativelanguage.googleapis.com"),
    )?.body as {
      contents?: Array<{
        role?: string;
        parts?: Array<{
          functionCall?: { name?: string; args?: Record<string, unknown> };
          functionResponse?: {
            name?: string;
            response?: Record<string, unknown>;
          };
        }>;
      }>;
    };
    const geminiFunctionCall = geminiBody.contents
      ?.flatMap((content) => content.parts ?? [])
      .find((part) => part.functionCall)?.functionCall;
    const geminiFunctionResponse = geminiBody.contents
      ?.flatMap((content) => content.parts ?? [])
      .find((part) => part.functionResponse)?.functionResponse;
    assert.equal(geminiFunctionCall?.name, toolCall.name);
    assert.deepEqual(geminiFunctionCall?.args, toolCall.arguments);
    assert.equal(geminiFunctionResponse?.name, toolCall.name);
    assert.deepEqual(geminiFunctionResponse?.response, { results: [] });
  });

  it("maps Anthropic messages, tools, tool choice, and tool calls", async () => {
    clearAIEnv();
    process.env["ANTHROPIC_API_KEY"] = "anthropic-test-key";

    let capturedBody: Record<string, unknown> | null = null;
    let capturedHeaders: { apiKey: string | null; version: string | null } | null =
      null;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      assert.equal(input.toString(), "https://api.anthropic.com/v1/messages");
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      const headers = new Headers(init?.headers);
      capturedHeaders = {
        apiKey: headers.get("x-api-key"),
        version: headers.get("anthropic-version"),
      };
      return new Response(
        JSON.stringify({
          content: [
            { type: "text", text: "Searching." },
            {
              type: "tool_use",
              id: "toolu_01_search",
              name: "search_pages",
              input: { query: "redis", limit: 5 },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 11, output_tokens: 7 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    const response = await getAIAdapter("anthropic").chat(
      makeToolFixtureRequest("anthropic"),
    );

    assert.equal(response.content, "Searching.");
    assert.deepEqual(response.toolCalls, [
      {
        id: "toolu_01_search",
        name: "search_pages",
        arguments: { query: "redis", limit: 5 },
      },
    ]);
    assert.equal(response.tokenInput, 11);
    assert.equal(response.tokenOutput, 7);
    assert.equal(response.finishReason, "tool_use");

    const headers = capturedHeaders as
      | { apiKey: string | null; version: string | null }
      | null;
    assert.equal(headers?.apiKey, "anthropic-test-key");
    assert.equal(headers?.version, "2023-06-01");

    const body = capturedBody as {
      system?: string;
      messages?: Array<{ role?: string; content?: unknown }>;
      tools?: Array<{ name?: string; input_schema?: unknown }>;
      tool_choice?: { type?: string };
    } | null;
    assert.equal(body?.system, "Use tools when useful.");
    assert.deepEqual(body?.messages, [
      { role: "user", content: "Find Redis pages." },
    ]);
    assert.equal(body?.tools?.[0]?.name, "search_pages");
    assert.deepEqual(body?.tools?.[0]?.input_schema, {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
    });
    assert.deepEqual(body?.tool_choice, { type: "any" });
  });

  it("maps Anthropic prior tool calls and tool results by tool_use id", async () => {
    clearAIEnv();
    process.env["ANTHROPIC_API_KEY"] = "anthropic-test-key";

    let capturedBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      void input;
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 13, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    const toolCall: NormalizedToolCall = {
      id: "toolu_01_search",
      name: "search_pages",
      arguments: { query: "redis" },
    };

    await getAIAdapter("anthropic").chat({
      ...makeToolFixtureRequest("anthropic"),
      messages: [
        { role: "system", content: "Use tools when useful." },
        { role: "user", content: "Find Redis pages." },
        { role: "assistant", content: "", toolCalls: [toolCall] },
        {
          role: "tool",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: JSON.stringify({ results: [] }),
        },
        { role: "user", content: "Continue." },
      ],
    });

    const body = capturedBody as {
      messages?: Array<{
        role?: string;
        content?: Array<{
          type?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
          tool_use_id?: string;
          content?: string;
        }>;
      }>;
    } | null;
    const assistantToolUse = body?.messages?.[1]?.content?.[0];
    const toolResult = body?.messages?.[2]?.content?.[0];
    assert.deepEqual(assistantToolUse, {
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.name,
      input: toolCall.arguments,
    });
    assert.deepEqual(toolResult, {
      type: "tool_result",
      tool_use_id: toolCall.id,
      content: JSON.stringify({ results: [] }),
    });
  });

  it("rejects Anthropic tool result messages without toolCallId", async () => {
    clearAIEnv();
    process.env["ANTHROPIC_API_KEY"] = "anthropic-test-key";

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;

    await assert.rejects(
      getAIAdapter("anthropic").chat({
        ...makeToolFixtureRequest("anthropic"),
        messages: [
          { role: "user", content: "Find Redis pages." },
          {
            role: "tool",
            toolName: "search_pages",
            content: JSON.stringify({ results: [] }),
          },
        ],
      }),
      /toolCallId/,
    );
    assert.equal(fetchCalled, false);
  });
});
