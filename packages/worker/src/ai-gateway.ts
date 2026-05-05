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
import { AI_MODELS, normalizeAIModelId } from "@wekiflow/shared";

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

function sanitizeSchemaForGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeSchemaForGemini);
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const result: JsonRecord = {};
  for (const [key, value] of Object.entries(schema as JsonRecord)) {
    if (key === "additionalProperties") continue;
    if (key === "type" && Array.isArray(value)) {
      const types = value.filter((t): t is string => typeof t === "string");
      const nonNull = types.filter((t) => t !== "null");
      const nullable = types.includes("null");
      result["type"] = nonNull[0] ?? "string";
      if (nullable) result["nullable"] = true;
      continue;
    }
    result[key] = sanitizeSchemaForGemini(value);
  }
  return result;
}

function toGeminiTool(tool: AIToolDefinition): JsonRecord {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: sanitizeSchemaForGemini(tool.parameters) as JsonRecord,
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

    const model = normalizeAIModelId(request.model);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

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

interface AnthropicWireMessage {
  role: "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | {
            type: "tool_use";
            id: string;
            name: string;
            input: JsonRecord;
          }
        | {
            type: "tool_result";
            tool_use_id: string;
            content: string;
          }
      >;
}

function toAnthropicMessages(messages: AIMessage[]): {
  system: string;
  messages: AnthropicWireMessage[];
} {
  const systemParts: string[] = [];
  const wire: AnthropicWireMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }

    if (message.role === "tool") {
      wire.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId ?? "tool_use",
            content: message.content,
          },
        ],
      });
      continue;
    }

    if (message.role === "assistant") {
      const blocks: Exclude<AnthropicWireMessage["content"], string> = [];
      if (message.content) {
        blocks.push({ type: "text", text: message.content });
      }
      for (const toolCall of message.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.arguments,
        });
      }
      wire.push({
        role: "assistant",
        content: blocks.length > 0 ? blocks : message.content,
      });
      continue;
    }

    wire.push({
      role: "user",
      content: message.content,
    });
  }

  return { system: systemParts.join("\n"), messages: wire };
}

function toAnthropicTool(tool: AIToolDefinition): JsonRecord {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.parameters,
  };
}

function toAnthropicToolChoice(
  choice?: AIToolChoice,
): JsonRecord | undefined {
  if (!choice) return undefined;
  if (choice === "required") return { type: "any" };
  if (choice === "none") return { type: "none" };
  return { type: "auto" };
}

function normalizeAnthropicToolCalls(
  blocks:
    | Array<{
        type?: string;
        id?: string;
        name?: string;
        input?: unknown;
      }>
    | undefined,
): NormalizedToolCall[] | undefined {
  const toolUses = blocks?.filter((block) => block.type === "tool_use") ?? [];
  if (!toolUses.length) return undefined;
  return toolUses.map((block, index) => {
    const name = block.name ?? "unknown_tool";
    return {
      id: block.id ?? normalizeToolCallId(index, name),
      name,
      arguments: parseToolArguments(block.input ?? {}),
    };
  });
}

function extractAnthropicText(
  blocks: Array<{ type?: string; text?: string }> | undefined,
): string {
  return (
    blocks
      ?.filter((block) => block.type === "text")
      .map((block) => block.text)
      .filter((text): text is string => typeof text === "string")
      .join("") ?? ""
  );
}

class AnthropicAdapter implements AIAdapter {
  readonly provider = "anthropic" as const;

  async chat(request: AIRequest): Promise<AIResponse> {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");

    const start = Date.now();
    const { system, messages } = toAnthropicMessages(request.messages);

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: request.model,
        ...(system ? { system } : {}),
        messages,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? 2048,
        ...(request.tools?.length
          ? { tools: request.tools.map(toAnthropicTool) }
          : {}),
        ...(request.toolChoice
          ? { tool_choice: toAnthropicToolChoice(request.toolChoice) }
          : {}),
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      content: Array<{
        type?: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
      }>;
      stop_reason?: string | null;
      usage: { input_tokens: number; output_tokens: number };
    };

    const toolCalls = normalizeAnthropicToolCalls(data.content);
    return {
      content: extractAnthropicText(data.content),
      ...(toolCalls ? { toolCalls } : {}),
      tokenInput: data.usage.input_tokens,
      tokenOutput: data.usage.output_tokens,
      latencyMs: Date.now() - start,
      finishReason: data.stop_reason ?? null,
    };
  }
}

const adapters: Record<AIProvider, AIAdapter> = {
  openai: new OpenAIAdapter(),
  gemini: new GeminiAdapter(),
  anthropic: new AnthropicAdapter(),
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
      model: normalizeAIModelId(
        process.env["OPENAI_MODEL"] ?? AI_MODELS.OPENAI_DEFAULT,
      ),
    };
  }
  if (process.env["GEMINI_API_KEY"]) {
    return {
      provider: "gemini",
      model: normalizeAIModelId(
        process.env["GEMINI_MODEL"] ?? AI_MODELS.GEMINI_DEFAULT,
      ),
    };
  }
  if (process.env["ANTHROPIC_API_KEY"]) {
    return {
      provider: "anthropic",
      model: normalizeAIModelId(
        process.env["ANTHROPIC_MODEL"] ?? AI_MODELS.ANTHROPIC_DEFAULT,
      ),
    };
  }
  throw new Error(
    "No AI provider configured. Set OPENAI_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY.",
  );
}
