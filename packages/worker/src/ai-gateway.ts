import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AIAdapter,
  AIMessage,
  AIProvider,
  AIRequest,
  AIResponse,
  AIToolChoice,
  AIToolDefinition,
  NormalizedToolCall,
} from "@wekiflow/shared";
import { AI_MODELS } from "@wekiflow/shared";

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(
  currentDir,
  "../../../tests/fixtures/ai/markers.json",
);
const E2E_MARKER_PATTERN = /\[E2E_[A-Z_]+\]/g;

interface MockFixtureFile {
  markers: Record<
    string,
    {
      route_decision?: Record<string, unknown>;
      agent_plan?: Record<string, unknown>;
      patch_generation?: string;
      triple_extraction?: Record<string, unknown>;
      entity_match_judge?: Record<string, unknown>;
      content_reformat?: string;
      predicate_label?: Record<string, unknown>;
      synthesis_generation?: string;
      synthesis_map?: string;
    }
  >;
}

let mockFixtureCache: MockFixtureFile | null = null;

type JsonRecord = Record<string, unknown>;

interface OpenAIWireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

interface GeminiWireContent {
  role: "user" | "model";
  parts: Array<
    | { text: string }
    | { functionCall: { name: string; args: JsonRecord } }
    | { functionResponse: { name: string; response: JsonRecord } }
  >;
}

function isMockModeEnabled(): boolean {
  return process.env["AI_TEST_MODE"] === "mock";
}

function loadMockFixtures(): MockFixtureFile {
  if (mockFixtureCache) {
    return mockFixtureCache;
  }

  if (!existsSync(fixturePath)) {
    throw new Error(
      `AI_TEST_MODE=mock requires fixture file at ${fixturePath}`,
    );
  }

  mockFixtureCache = JSON.parse(
    readFileSync(fixturePath, "utf8"),
  ) as MockFixtureFile;

  return mockFixtureCache;
}

function detectMarker(messages: AIRequest["messages"]): string | null {
  const haystack = messages.map((message) => message.content).join("\n");
  const matches = haystack.match(E2E_MARKER_PATTERN);
  return matches?.[0] ?? null;
}

function resolveMockContent(request: AIRequest): string {
  const marker = detectMarker(request.messages);
  if (!marker) {
    if (request.mode === "triple_extraction") {
      return JSON.stringify({ triples: [] });
    }
    if (request.mode === "patch_generation") {
      return "# E2E Mock Patch\n\nNo explicit marker was provided.\n";
    }
    if (request.mode === "agent_plan") {
      return JSON.stringify({
        summary: "Mock agent plan.",
        proposedPlan: [
          {
            action: "needs_review",
            targetPageId: null,
            confidence: 0,
            reason: "No explicit marker was provided.",
            evidence: [],
          },
        ],
        openQuestions: [],
      });
    }
    if (request.mode === "predicate_label") {
      return JSON.stringify({ labels: [] });
    }
    if (request.mode === "entity_match_judge") {
      return JSON.stringify({
        sameEntity: false,
        confidence: 0,
        reason: "No explicit marker was provided.",
      });
    }
    if (request.mode === "synthesis_generation") {
      return "# E2E Synthesis\n\nNo explicit marker was provided.\n";
    }
    if (request.mode === "synthesis_map") {
      return "E2E map summary placeholder.";
    }
    throw new Error(
      `AI_TEST_MODE=mock requires one of the registered markers (${Object.keys(loadMockFixtures().markers).join(", ")}) in the prompt`,
    );
  }

  const fixture = loadMockFixtures().markers[marker];
  if (!fixture) {
    throw new Error(`No AI mock fixture registered for marker ${marker}`);
  }

  const response = fixture[request.mode];
  if (response == null) {
    if (request.mode === "agent_plan") {
      return JSON.stringify({
        summary: "Mock agent plan.",
        proposedPlan: [
          {
            action: "needs_review",
            targetPageId: null,
            confidence: 0,
            reason: `Mock fixture ${marker} does not define an agent_plan response.`,
            evidence: [],
          },
        ],
        openQuestions: [],
      });
    }
    throw new Error(
      `Mock fixture for ${marker} does not define a response for ${request.mode}`,
    );
  }

  return typeof response === "string" ? response : JSON.stringify(response);
}

function normalizeToolCallId(index: number, name: string): string {
  const safeName = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return `call_${index}_${safeName || "tool"}`;
}

function parseToolArguments(raw: unknown): JsonRecord {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as JsonRecord;
  }

  if (typeof raw !== "string" || raw.trim() === "") {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonRecord;
    }
    return { value: parsed };
  } catch {
    return { __raw: raw };
  }
}

function stringifyToolArguments(args: JsonRecord): string {
  return JSON.stringify(args);
}

function toOpenAITool(tool: AIToolDefinition): JsonRecord {
  return {
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters,
    },
  };
}

function toOpenAIToolChoice(choice?: AIToolChoice): string | undefined {
  if (!choice) return undefined;
  if (choice === "required") return "required";
  return choice;
}

function toOpenAIMessage(message: AIMessage): OpenAIWireMessage {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: stringifyToolArguments(toolCall.arguments),
        },
      })),
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}

function toGeminiTool(tool: AIToolDefinition): JsonRecord {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters,
  };
}

function toGeminiToolMode(choice?: AIToolChoice): string | undefined {
  if (!choice) return undefined;
  if (choice === "required") return "ANY";
  return choice.toUpperCase();
}

function toolResponsePayload(content: string): JsonRecord {
  const parsed = parseToolArguments(content);
  if ("__raw" in parsed || "value" in parsed) {
    return { content };
  }
  return parsed;
}

function toGeminiContent(message: AIMessage): GeminiWireContent | null {
  if (message.role === "system") {
    return null;
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    const parts: GeminiWireContent["parts"] = [];
    if (message.content) {
      parts.push({ text: message.content });
    }
    for (const toolCall of message.toolCalls) {
      parts.push({
        functionCall: {
          name: toolCall.name,
          args: toolCall.arguments,
        },
      });
    }
    return { role: "model", parts };
  }

  if (message.role === "tool") {
    return {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: message.toolName ?? "tool_result",
            response: toolResponsePayload(message.content),
          },
        },
      ],
    };
  }

  return {
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  };
}

function normalizeOpenAIToolCalls(
  toolCalls:
    | Array<{
        function?: { name?: string; arguments?: string };
      }>
    | undefined,
): NormalizedToolCall[] | undefined {
  if (!toolCalls?.length) return undefined;

  return toolCalls.map((toolCall, index) => {
    const name = toolCall.function?.name ?? "unknown_tool";
    return {
      id: normalizeToolCallId(index, name),
      name,
      arguments: parseToolArguments(toolCall.function?.arguments ?? "{}"),
    };
  });
}

function normalizeGeminiToolCalls(
  parts:
    | Array<{
        functionCall?: { name?: string; args?: unknown };
      }>
    | undefined,
): NormalizedToolCall[] | undefined {
  const functionCalls =
    parts
      ?.filter((part) => part.functionCall)
      .map((part) => part.functionCall) ?? [];
  if (!functionCalls.length) return undefined;

  return functionCalls.map((functionCall, index) => {
    const name = functionCall?.name ?? "unknown_tool";
    return {
      id: normalizeToolCallId(index, name),
      name,
      arguments: parseToolArguments(functionCall?.args ?? {}),
    };
  });
}

function extractGeminiText(
  parts: Array<{ text?: string }> | undefined,
): string {
  return (
    parts
      ?.map((part) => part.text)
      .filter((text): text is string => typeof text === "string")
      .join("") ?? ""
  );
}

class MockAIAdapter implements AIAdapter {
  readonly provider = "openai" as const;

  async chat(request: AIRequest): Promise<AIResponse> {
    const content = resolveMockContent(request);
    return {
      content,
      tokenInput: Math.max(16, content.length),
      tokenOutput: Math.max(16, Math.ceil(content.length / 4)),
      latencyMs: 1,
      finishReason: "stop",
    };
  }
}

class OpenAIAdapter implements AIAdapter {
  readonly provider = "openai" as const;

  async chat(request: AIRequest): Promise<AIResponse> {
    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) throw new Error("OPENAI_API_KEY is required");

    const start = Date.now();

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map(toOpenAIMessage),
        temperature: request.temperature ?? 0.2,
        max_completion_tokens: request.maxTokens ?? 2048,
        ...(request.responseFormat === "json"
          ? { response_format: { type: "json_object" } }
          : {}),
        ...(request.tools?.length
          ? { tools: request.tools.map(toOpenAITool) }
          : {}),
        ...(request.toolChoice
          ? { tool_choice: toOpenAIToolChoice(request.toolChoice) }
          : {}),
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      choices: Array<{
        finish_reason?: string | null;
        message: {
          content?: string | null;
          tool_calls?: Array<{
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices[0];
    const toolCalls = normalizeOpenAIToolCalls(choice.message.tool_calls);
    return {
      content: choice.message.content ?? "",
      ...(toolCalls ? { toolCalls } : {}),
      tokenInput: data.usage.prompt_tokens,
      tokenOutput: data.usage.completion_tokens,
      latencyMs: Date.now() - start,
      finishReason: choice.finish_reason ?? null,
    };
  }
}

class GeminiAdapter implements AIAdapter {
  readonly provider = "gemini" as const;

  async chat(request: AIRequest): Promise<AIResponse> {
    const apiKey = process.env["GEMINI_API_KEY"];
    if (!apiKey) throw new Error("GEMINI_API_KEY is required");

    const start = Date.now();

    const systemInstruction = request.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");

    const contents = request.messages
      .map(toGeminiContent)
      .filter((content): content is GeminiWireContent => content !== null);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${request.model}:generateContent`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        ...(systemInstruction
          ? { systemInstruction: { parts: [{ text: systemInstruction }] } }
          : {}),
        contents,
        generationConfig: {
          temperature: request.temperature ?? 0.2,
          maxOutputTokens: request.maxTokens ?? 2048,
          ...(request.responseFormat === "json"
            ? { responseMimeType: "application/json" }
            : {}),
        },
        ...(request.tools?.length
          ? {
              tools: [
                {
                  functionDeclarations: request.tools.map(toGeminiTool),
                },
              ],
            }
          : {}),
        ...(request.toolChoice
          ? {
              toolConfig: {
                functionCallingConfig: {
                  mode: toGeminiToolMode(request.toolChoice),
                },
              },
            }
          : {}),
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      candidates: Array<{
        finishReason?: string;
        content: {
          parts: Array<{
            text?: string;
            functionCall?: { name?: string; args?: unknown };
          }>;
        };
      }>;
      usageMetadata: {
        promptTokenCount: number;
        candidatesTokenCount: number;
      };
    };

    const candidate = data.candidates[0];
    const toolCalls = normalizeGeminiToolCalls(candidate.content.parts);
    return {
      content: extractGeminiText(candidate.content.parts),
      ...(toolCalls ? { toolCalls } : {}),
      tokenInput: data.usageMetadata.promptTokenCount,
      tokenOutput: data.usageMetadata.candidatesTokenCount,
      latencyMs: Date.now() - start,
      finishReason: candidate.finishReason ?? null,
    };
  }
}

// TODO(claude): register Anthropic adapter here once the `AIProvider` union in
// @wekiflow/shared includes "anthropic" and an AnthropicAdapter is added — the
// large-context pre-chunk rollout (Phase 0) is provider-aware but ships with
// only OpenAI + Gemini wired.
const adapters: Record<AIProvider, AIAdapter> = {
  openai: new OpenAIAdapter(),
  gemini: new GeminiAdapter(),
};
const mockAdapter = new MockAIAdapter();

export function getAIAdapter(provider: AIProvider): AIAdapter {
  if (isMockModeEnabled()) {
    return mockAdapter;
  }
  return adapters[provider];
}

export function getDefaultProvider(): { provider: AIProvider; model: string } {
  if (isMockModeEnabled()) {
    return {
      provider: "openai",
      model: "mock-e2e",
    };
  }
  if (process.env["OPENAI_API_KEY"]) {
    return {
      provider: "openai",
      model: process.env["OPENAI_MODEL"] ?? AI_MODELS.OPENAI_DEFAULT,
    };
  }
  if (process.env["GEMINI_API_KEY"]) {
    return {
      provider: "gemini",
      model: process.env["GEMINI_MODEL"] ?? AI_MODELS.GEMINI_DEFAULT,
    };
  }
  throw new Error(
    "No AI provider configured. Set OPENAI_API_KEY or GEMINI_API_KEY.",
  );
}
