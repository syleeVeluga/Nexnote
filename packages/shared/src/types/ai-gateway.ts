import type { AIProvider, ModelRunMode } from "../constants/index.js";

/**
 * Input-budgeting metadata attached by callers so `model_runs.requestMetaJson`
 * can track how much original source made it into the prompt. Adapters do
 * not read this — it's a read-through channel for observability.
 */
export interface AIBudgetMeta {
  inputTokenBudget: number;
  estimatedInputTokens: number;
  inputCharLength: number;
  truncated: boolean;
  /** e.g. "single_slot", "proportional_structure_preserving". */
  strategy: string;
  /** Per-slot allocations for multi-slot prompts (patch merge, classifier). */
  slotAllocations?: Record<
    string,
    { allocatedTokens: number; estimatedTokens: number; truncated: boolean }
  >;
}

export type AIToolChoice = "auto" | "required" | "none";

export interface AIToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Common request envelope for all AI calls */
export interface AIRequest {
  provider: AIProvider;
  model: string;
  mode: ModelRunMode;
  promptVersion: string;
  messages: AIMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "json" | "text";
  tools?: AIToolDefinition[];
  toolChoice?: AIToolChoice;
  budgetMeta?: AIBudgetMeta;
}

export interface AIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: NormalizedToolCall[];
}

/** Common response envelope from AI calls */
export interface AIResponse {
  content: string;
  toolCalls?: NormalizedToolCall[];
  tokenInput: number;
  tokenOutput: number;
  latencyMs: number;
  finishReason?: string | null;
}

/** Adapter interface that OpenAI / Gemini implementations must fulfill */
export interface AIAdapter {
  readonly provider: AIProvider;
  chat(request: AIRequest): Promise<AIResponse>;
}
