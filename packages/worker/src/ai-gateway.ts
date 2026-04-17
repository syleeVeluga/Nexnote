import type {
  AIAdapter,
  AIProvider,
  AIRequest,
  AIResponse,
} from "@nexnote/shared";
import { AI_MODELS } from "@nexnote/shared";

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

const adapters: Record<AIProvider, AIAdapter> = {
  openai: new OpenAIAdapter(),
  gemini: new GeminiAdapter(),
};

export function getAIAdapter(provider: AIProvider): AIAdapter {
  return adapters[provider];
}

export function getDefaultProvider(): { provider: AIProvider; model: string } {
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
