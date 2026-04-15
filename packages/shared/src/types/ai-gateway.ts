import type { AIProvider, ModelRunMode } from "../constants/index.js";

/** Common request envelope for all AI calls */
export interface AIRequest {
  provider: AIProvider;
  model: string;
  mode: ModelRunMode;
  promptVersion: string;
  messages: AIMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "json";
}

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Common response envelope from AI calls */
export interface AIResponse {
  content: string;
  tokenInput: number;
  tokenOutput: number;
  latencyMs: number;
}

/** Adapter interface that OpenAI / Gemini implementations must fulfill */
export interface AIAdapter {
  readonly provider: AIProvider;
  chat(request: AIRequest): Promise<AIResponse>;
}
