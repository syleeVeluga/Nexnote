import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AIAdapter,
  AIProvider,
  AIRequest,
  AIResponse,
} from "@nexnote/shared";
import { AI_MODELS } from "@nexnote/shared";

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(currentDir, "../../../tests/fixtures/ai/markers.json");
const E2E_MARKER_PATTERN = /\[E2E_[A-Z_]+\]/g;

interface MockFixtureFile {
  markers: Record<
    string,
    {
      route_decision?: Record<string, unknown>;
      patch_generation?: string;
      triple_extraction?: Record<string, unknown>;
    }
  >;
}

let mockFixtureCache: MockFixtureFile | null = null;

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
    throw new Error(
      `Mock fixture for ${marker} does not define a response for ${request.mode}`,
    );
  }

  return typeof response === "string" ? response : JSON.stringify(response);
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
        messages: request.messages,
        temperature: request.temperature ?? 0.2,
        max_completion_tokens: request.maxTokens ?? 2048,
        ...(request.responseFormat === "json"
          ? { response_format: { type: "json_object" } }
          : {}),
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    return {
      content: data.choices[0].message.content,
      tokenInput: data.usage.prompt_tokens,
      tokenOutput: data.usage.completion_tokens,
      latencyMs: Date.now() - start,
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
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

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
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
      usageMetadata: {
        promptTokenCount: number;
        candidatesTokenCount: number;
      };
    };

    return {
      content: data.candidates[0].content.parts[0].text,
      tokenInput: data.usageMetadata.promptTokenCount,
      tokenOutput: data.usageMetadata.candidatesTokenCount,
      latencyMs: Date.now() - start,
    };
  }
}

// TODO(claude): register Anthropic adapter here once the `AIProvider` union in
// @nexnote/shared includes "anthropic" and an AnthropicAdapter is added — the
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
  throw new Error("No AI provider configured. Set OPENAI_API_KEY or GEMINI_API_KEY.");
}
