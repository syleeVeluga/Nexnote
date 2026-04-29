import {
  extractIngestionText,
  ingestionAgentPlanSchema,
  estimateTokens,
  MODE_OUTPUT_RESERVE,
  type AIAdapter,
  type AIBudgetMeta,
  type AIMessage,
  type AIProvider,
  type AIRequest,
  type AIResponse,
  type AIToolDefinition,
  type IngestionAgentPlan,
  type ModelRunStatus,
} from "@wekiflow/shared";
import { getAIAdapter, getDefaultProvider } from "../../ai-gateway.js";
import { createAgentDispatcher } from "./dispatcher.js";
import {
  packAgentExploreContext,
  packAgentPlanContext,
  readAgentRuntimeLimits,
  selectAgentModel,
  type AgentContextBlock,
  type AgentModelSelection,
} from "./budgeter.js";
import type {
  AgentDb,
  AgentRunTraceStep,
  AgentToolDefinition,
  AgentToolExecution,
} from "./types.js";

const PROMPT_VERSION = "ingestion-agent-shadow-v1";

const EXPLORE_SYSTEM_PROMPT = `You are a read-only exploration agent for WekiFlow's Markdown knowledge wiki.
Investigate the incoming ingestion with the available read-only tools, then stop calling tools when you have enough context to plan possible wiki updates.
Never invent page IDs. Only refer to pages that tools returned. Do not propose or execute mutations during exploration.`;

const PLAN_SYSTEM_PROMPT = `You are planning wiki maintenance mutations in shadow mode.
Use the ingestion and read-only context to propose what the future ingestion agent should do, but do not execute anything.
Prefer surgical update or append proposals to creating duplicate pages. Keep confidence calibrated.

Return only JSON with this exact shape:
{
  "summary": "short explanation",
  "proposedPlan": [
    {
      "action": "create" | "update" | "append" | "noop" | "needs_review",
      "targetPageId": "uuid or null",
      "confidence": 0.0,
      "reason": "why",
      "proposedTitle": "required for create",
      "sectionHint": "optional",
      "contentSummary": "optional",
      "evidence": [{ "pageId": "uuid", "note": "short evidence" }]
    }
  ],
  "openQuestions": []
}`;

export interface AgentIngestionInput {
  id: string;
  sourceName: string;
  contentType: string;
  titleHint: string | null;
  normalizedText: string | null;
  rawPayload: unknown;
}

export interface AgentModelRunRecord {
  request: AIRequest;
  response?: AIResponse;
  status: ModelRunStatus;
  requestMetaJson: Record<string, unknown>;
  responseMetaJson: Record<string, unknown>;
}

export interface RunIngestionAgentShadowInput {
  db: AgentDb;
  workspaceId: string;
  ingestion: AgentIngestionInput;
  agentRunId?: string;
  adapter?: AIAdapter;
  baseProvider?: AIProvider;
  baseModel?: string;
  tools?: Record<string, AgentToolDefinition>;
  env?: NodeJS.ProcessEnv;
  recordModelRun?: (record: AgentModelRunRecord) => Promise<void>;
}

export interface IngestionAgentShadowResult {
  status: "shadow";
  planJson: IngestionAgentPlan & {
    shadow: true;
    model: AgentModelSelection;
    budget: AIBudgetMeta;
    parseFailed?: boolean;
  };
  steps: AgentRunTraceStep[];
  decisionsCount: number;
  totalTokens: number;
  totalLatencyMs: number;
}

export class AgentLoopTimeout extends Error {
  constructor(
    message: string,
    public readonly steps: AgentRunTraceStep[],
    public readonly totalTokens: number,
    public readonly totalLatencyMs: number,
  ) {
    super(message);
    this.name = "AgentLoopTimeout";
  }
}

function readToolDefinitions(): AIToolDefinition[] {
  return [
    {
      name: "search_pages",
      description:
        "Search pages by title, full-text content, title similarity, and entity overlap.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 500 },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "read_page",
      description:
        "Read a page as markdown, deterministic summary, or stable markdown blocks.",
      parameters: {
        type: "object",
        properties: {
          pageId: { type: "string", format: "uuid" },
          format: { type: "string", enum: ["markdown", "summary", "blocks"] },
        },
        required: ["pageId"],
        additionalProperties: false,
      },
    },
    {
      name: "list_folder",
      description: "List child folders and top-level pages under a folder.",
      parameters: {
        type: "object",
        properties: {
          folderId: { type: ["string", "null"], format: "uuid" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "find_related_entities",
      description:
        "Find known entities matching text and pages connected by active triples.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: 5000 },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    {
      name: "list_recent_pages",
      description: "List recently touched pages in the workspace.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        additionalProperties: false,
      },
    },
  ];
}

function pushStep(
  steps: AgentRunTraceStep[],
  type: AgentRunTraceStep["type"],
  payload: Record<string, unknown>,
): void {
  steps.push({
    step: steps.length,
    type,
    payload,
    ts: new Date().toISOString(),
  });
}

function compactJson(value: unknown, maxChars: number): unknown {
  const raw = JSON.stringify(value);
  if (raw.length <= maxChars) return value;
  return {
    truncated: true,
    charLength: raw.length,
    excerpt: raw.slice(0, maxChars),
  };
}

function stringifyToolMessage(execution: AgentToolExecution): string {
  const payload = execution.ok
    ? {
        ok: true,
        deduped: execution.deduped,
        result: execution.result,
      }
    : {
        ok: false,
        error: execution.error,
      };
  const raw = JSON.stringify(payload);
  if (raw.length <= 200_000) return raw;
  return JSON.stringify(compactJson(payload, 200_000));
}

function executionToContextBlock(
  execution: AgentToolExecution,
  index: number,
): AgentContextBlock | null {
  if (!execution.ok) return null;
  return {
    key: `tool_${index}_${execution.name}`,
    label: `${execution.name}#${index}`,
    text: JSON.stringify(
      {
        tool: execution.name,
        deduped: execution.deduped,
        result: execution.result,
      },
      null,
      2,
    ),
    minTokens: execution.name === "read_page" ? 2_000 : 500,
    weight: execution.name === "read_page" ? 4 : 2,
  };
}

function normalizeRawPlan(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const record = raw as Record<string, unknown>;
  if (!("proposedPlan" in record) && Array.isArray(record["mutations"])) {
    return { ...record, proposedPlan: record["mutations"] };
  }
  return raw;
}

function parsePlan(content: string): {
  plan: IngestionAgentPlan;
  parseFailed: boolean;
  error?: string;
} {
  try {
    const raw = JSON.parse(content) as unknown;
    return {
      plan: ingestionAgentPlanSchema.parse(normalizeRawPlan(raw)),
      parseFailed: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      plan: {
        summary: "Agent plan parsing failed.",
        proposedPlan: [
          {
            action: "needs_review",
            targetPageId: null,
            confidence: 0,
            reason: `Agent plan parsing failed: ${message.slice(0, 500)}`,
            evidence: [],
          },
        ],
        openQuestions: [],
      },
      parseFailed: true,
      error: message,
    };
  }
}

function remainingMs(deadlineMs: number): number {
  return deadlineMs - Date.now();
}

async function chatBeforeDeadline(
  adapter: AIAdapter,
  request: AIRequest,
  deadlineMs: number,
  steps: AgentRunTraceStep[],
  totals: { tokens: number; latencyMs: number },
): Promise<AIResponse> {
  const ms = remainingMs(deadlineMs);
  if (ms <= 0) {
    throw new AgentLoopTimeout(
      "Ingestion agent timed out before the next model call",
      steps,
      totals.tokens,
      totals.latencyMs,
    );
  }

  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      adapter.chat(request),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new AgentLoopTimeout(
              "Ingestion agent timed out during a model call",
              steps,
              totals.tokens,
              totals.latencyMs,
            ),
          );
        }, ms);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function addUsage(
  totals: { tokens: number; latencyMs: number },
  response: AIResponse,
): void {
  totals.tokens += response.tokenInput + response.tokenOutput;
  totals.latencyMs += response.latencyMs;
}

async function recordModelRun(
  input: RunIngestionAgentShadowInput,
  record: AgentModelRunRecord,
): Promise<void> {
  if (!input.recordModelRun) return;
  await input.recordModelRun(record);
}

export async function runIngestionAgentShadow(
  input: RunIngestionAgentShadowInput,
): Promise<IngestionAgentShadowResult> {
  const limits = readAgentRuntimeLimits(input.env);
  const deadlineMs = Date.now() + limits.timeoutMs;
  const steps: AgentRunTraceStep[] = [];
  const totals = { tokens: 0, latencyMs: 0 };
  const ingestionText = extractIngestionText(input.ingestion);
  const base =
    input.baseProvider && input.baseModel
      ? { provider: input.baseProvider, model: input.baseModel }
      : getDefaultProvider();
  const initialEstimate = estimateTokens(ingestionText);
  const exploreModel = selectAgentModel({
    estimatedInputTokens: initialEstimate,
    baseProvider: base.provider,
    baseModel: base.model,
    env: input.env,
  });
  const adapter = input.adapter ?? getAIAdapter(exploreModel.provider);

  pushStep(steps, "model_selection", {
    phase: "explore",
    ...exploreModel,
  });
  const packedExplore = packAgentExploreContext({
    provider: exploreModel.provider,
    model: exploreModel.model,
    systemPrompt: EXPLORE_SYSTEM_PROMPT,
    ingestionText,
    sourceName: input.ingestion.sourceName,
    contentType: input.ingestion.contentType,
    titleHint: input.ingestion.titleHint,
    env: input.env,
  });

  const dispatcher = createAgentDispatcher({
    db: input.db,
    workspaceId: input.workspaceId,
    tools: input.tools,
    options: { maxCallsPerTurn: limits.maxCallsPerTurn },
  });
  const toolContextBlocks: AgentContextBlock[] = [];
  const messages: AIMessage[] = [
    { role: "system", content: EXPLORE_SYSTEM_PROMPT },
    { role: "user", content: packedExplore.text },
  ];

  for (let i = 0; i < limits.maxSteps; i += 1) {
    const request: AIRequest = {
      provider: exploreModel.provider,
      model: exploreModel.model,
      mode: "agent_plan",
      promptVersion: PROMPT_VERSION,
      messages,
      temperature: 0.1,
      maxTokens: MODE_OUTPUT_RESERVE.agent_plan,
      tools: readToolDefinitions(),
      toolChoice: "auto",
      budgetMeta: packedExplore.budgetMeta,
    };

    let response: AIResponse;
    try {
      response = await chatBeforeDeadline(
        adapter,
        request,
        deadlineMs,
        steps,
        totals,
      );
    } catch (err) {
      await recordModelRun(input, {
        request,
        status: "failed",
        requestMetaJson: {
          ingestionId: input.ingestion.id,
          agentRunId: input.agentRunId,
          phase: "explore",
          budget: packedExplore.budgetMeta,
        },
        responseMetaJson: {
          error: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }

    addUsage(totals, response);
    await recordModelRun(input, {
      request,
      response,
      status: "success",
      requestMetaJson: {
        ingestionId: input.ingestion.id,
        agentRunId: input.agentRunId,
        phase: "explore",
        budget: packedExplore.budgetMeta,
      },
      responseMetaJson: {
        finishReason: response.finishReason ?? null,
        toolCallCount: response.toolCalls?.length ?? 0,
      },
    });
    pushStep(steps, "ai_response", {
      phase: "explore",
      finishReason: response.finishReason ?? null,
      tokenInput: response.tokenInput,
      tokenOutput: response.tokenOutput,
      latencyMs: response.latencyMs,
      contentExcerpt: response.content.slice(0, 2_000),
      toolCalls: response.toolCalls ?? [],
    });

    if (!response.toolCalls?.length) break;

    const executions = await dispatcher.dispatchToolCalls(response.toolCalls);
    messages.push({
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
    });
    for (const execution of executions) {
      pushStep(steps, "tool_result", {
        name: execution.name,
        toolCallId: execution.toolCallId,
        ok: execution.ok,
        deduped: execution.deduped,
        result: execution.ok ? compactJson(execution.result, 4_000) : undefined,
        error: execution.ok ? undefined : execution.error,
      });
      const block = executionToContextBlock(
        execution,
        toolContextBlocks.length,
      );
      if (block) toolContextBlocks.push(block);
      messages.push({
        role: "tool",
        toolCallId: execution.toolCallId,
        toolName: execution.name,
        content: stringifyToolMessage(execution),
      });
    }
  }

  const planEstimate =
    initialEstimate +
    toolContextBlocks.reduce(
      (sum, block) => sum + estimateTokens(block.text),
      0,
    );
  const planModel = selectAgentModel({
    estimatedInputTokens: planEstimate,
    baseProvider: base.provider,
    baseModel: base.model,
    env: input.env,
  });
  pushStep(steps, "model_selection", {
    phase: "plan",
    ...planModel,
  });

  const packed = packAgentPlanContext({
    provider: planModel.provider,
    model: planModel.model,
    systemPrompt: PLAN_SYSTEM_PROMPT,
    ingestionText,
    sourceName: input.ingestion.sourceName,
    contentType: input.ingestion.contentType,
    titleHint: input.ingestion.titleHint,
    blocks: toolContextBlocks,
    env: input.env,
  });
  const planAdapter =
    input.adapter ??
    (planModel.provider === exploreModel.provider
      ? adapter
      : getAIAdapter(planModel.provider));
  const planRequest: AIRequest = {
    provider: planModel.provider,
    model: planModel.model,
    mode: "agent_plan",
    promptVersion: PROMPT_VERSION,
    messages: [
      { role: "system", content: PLAN_SYSTEM_PROMPT },
      { role: "user", content: packed.text },
    ],
    temperature: 0.1,
    maxTokens: MODE_OUTPUT_RESERVE.agent_plan,
    responseFormat: "json",
    budgetMeta: packed.budgetMeta,
  };

  let planResponse: AIResponse;
  try {
    planResponse = await chatBeforeDeadline(
      planAdapter,
      planRequest,
      deadlineMs,
      steps,
      totals,
    );
  } catch (err) {
    await recordModelRun(input, {
      request: planRequest,
      status: "failed",
      requestMetaJson: {
        ingestionId: input.ingestion.id,
        agentRunId: input.agentRunId,
        phase: "plan",
        budget: packed.budgetMeta,
      },
      responseMetaJson: {
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }

  addUsage(totals, planResponse);
  const parsed = parsePlan(planResponse.content);
  await recordModelRun(input, {
    request: planRequest,
    response: planResponse,
    status: parsed.parseFailed ? "failed" : "success",
    requestMetaJson: {
      ingestionId: input.ingestion.id,
      agentRunId: input.agentRunId,
      phase: "plan",
      budget: packed.budgetMeta,
    },
    responseMetaJson: {
      finishReason: planResponse.finishReason ?? null,
      mutationCount: parsed.plan.proposedPlan.length,
      parseFailed: parsed.parseFailed,
      error: parsed.error,
    },
  });

  pushStep(steps, "plan", {
    parseFailed: parsed.parseFailed,
    mutationCount: parsed.plan.proposedPlan.length,
    contentExcerpt: planResponse.content.slice(0, 4_000),
    budget: packed.budgetMeta,
  });
  pushStep(steps, "shadow_execute_skipped", {
    reason: "AGENT-4 shadow mode records plan_json only.",
    proposedMutations: parsed.plan.proposedPlan.length,
  });

  return {
    status: "shadow",
    planJson: {
      ...parsed.plan,
      shadow: true,
      model: planModel,
      budget: packed.budgetMeta,
      ...(parsed.parseFailed ? { parseFailed: true } : {}),
    },
    steps,
    decisionsCount: parsed.plan.proposedPlan.length,
    totalTokens: totals.tokens,
    totalLatencyMs: totals.latencyMs,
  };
}
