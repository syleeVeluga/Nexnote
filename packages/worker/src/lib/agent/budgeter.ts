import {
  AGENT_LIMITS,
  AI_MODELS,
  allocateBudgets,
  estimateTokens,
  getModelContextBudget,
  getAgentModelProvider,
  normalizeAIModelId,
  sliceWithinTokenBudget,
  type AIBudgetMeta,
  type AIMessage,
  type AIProvider,
  type TurnMutationOutcome,
  type TurnRecord,
} from "@wekiflow/shared";

export type { TurnMutationOutcome, TurnRecord };

const COMPACTION_THRESHOLD_RATIO = 1;
const COMPACTED_TOOL_PREFIX = "[COMPACTED_TOOL_RESULT]";

export interface AgentRuntimeLimits {
  maxSteps: number;
  maxCallsPerTurn: number;
  maxMutations: number;
  maxMutationsPerTurn: number;
  maxTurns: number;
  maxTotalMutations: number;
  timeoutMs: number;
  turnRemainingTimeThresholdMs: number;
  inputTokenBudget: number;
  outputTokenBudget: number;
  workspaceDailyTokenCap: number;
}

export interface AgentModelSelection {
  provider: AIProvider;
  model: string;
  routing: "fast" | "large_context" | "default";
  estimatedInputTokens: number;
  fastThresholdTokens: number;
  reason: string;
}

export interface AgentContextBlock {
  key: string;
  label: string;
  text: string;
  minTokens?: number;
  weight?: number;
  compacted?: boolean;
}

export interface PackedAgentContext {
  text: string;
  budgetMeta: AIBudgetMeta;
  compactionNotices?: AgentContextCompactionNotice[];
}

export interface AgentContextCompactionNotice {
  key: string;
  label: string;
  toolName?: string;
  toolCallId?: string;
  originalEstimatedTokens: number;
  compactedEstimatedTokens: number;
}

function positiveIntEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveFloatEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readAgentRuntimeLimits(
  env: NodeJS.ProcessEnv = process.env,
): AgentRuntimeLimits {
  return {
    maxSteps: positiveIntEnv(env, "AGENT_MAX_STEPS", AGENT_LIMITS.MAX_STEPS),
    maxCallsPerTurn: positiveIntEnv(
      env,
      "AGENT_MAX_CALLS_PER_TURN",
      AGENT_LIMITS.MAX_CALLS_PER_TURN,
    ),
    maxMutations: positiveIntEnv(
      env,
      "AGENT_MAX_MUTATIONS",
      AGENT_LIMITS.MAX_MUTATIONS,
    ),
    maxMutationsPerTurn: positiveIntEnv(
      env,
      "AGENT_MAX_MUTATIONS_PER_TURN",
      positiveIntEnv(
        env,
        "AGENT_MAX_MUTATIONS",
        AGENT_LIMITS.MAX_MUTATIONS_PER_TURN,
      ),
    ),
    maxTurns: positiveIntEnv(env, "AGENT_MAX_TURNS", AGENT_LIMITS.MAX_TURNS),
    maxTotalMutations: positiveIntEnv(
      env,
      "AGENT_MAX_TOTAL_MUTATIONS",
      AGENT_LIMITS.MAX_TOTAL_MUTATIONS,
    ),
    timeoutMs: positiveIntEnv(env, "AGENT_TIMEOUT_MS", AGENT_LIMITS.TIMEOUT_MS),
    turnRemainingTimeThresholdMs: positiveIntEnv(
      env,
      "AGENT_TURN_REMAINING_TIME_THRESHOLD_MS",
      AGENT_LIMITS.TURN_REMAINING_TIME_THRESHOLD_MS,
    ),
    inputTokenBudget: positiveIntEnv(
      env,
      "AGENT_INPUT_TOKEN_BUDGET",
      AGENT_LIMITS.INPUT_TOKEN_BUDGET,
    ),
    outputTokenBudget: positiveIntEnv(
      env,
      "AGENT_OUTPUT_TOKEN_BUDGET",
      AGENT_LIMITS.OUTPUT_TOKEN_BUDGET,
    ),
    workspaceDailyTokenCap: positiveIntEnv(
      env,
      "AGENT_WORKSPACE_DAILY_TOKEN_CAP",
      AGENT_LIMITS.WORKSPACE_DAILY_TOKEN_CAP,
    ),
  };
}

function providerFromEnv(value: string | undefined): AIProvider | null {
  if (value === "openai" || value === "gemini" || value === "anthropic") {
    return value;
  }
  return null;
}

function defaultModelForProvider(
  provider: AIProvider,
  env: NodeJS.ProcessEnv,
): string {
  if (provider === "gemini") {
    return normalizeAIModelId(env["GEMINI_MODEL"] ?? AI_MODELS.GEMINI_DEFAULT);
  }
  if (provider === "anthropic") {
    return normalizeAIModelId(
      env["ANTHROPIC_MODEL"] ?? AI_MODELS.ANTHROPIC_DEFAULT,
    );
  }
  return normalizeAIModelId(env["OPENAI_MODEL"] ?? AI_MODELS.OPENAI_DEFAULT);
}

function agentModelOverrideForProvider(
  model: string | undefined,
  provider: AIProvider,
): string | undefined {
  if (!model) return undefined;
  const modelProvider = getAgentModelProvider(model);
  if (modelProvider && modelProvider !== provider) return undefined;
  return normalizeAIModelId(model);
}

export function selectAgentModel(
  input: {
    estimatedInputTokens?: number;
    baseProvider?: AIProvider;
    baseModel?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): AgentModelSelection {
  const env = input.env ?? process.env;
  const estimatedInputTokens = input.estimatedInputTokens ?? 0;
  const providerOverride = providerFromEnv(env["AGENT_PROVIDER"]);
  const provider = providerOverride ?? input.baseProvider ?? "openai";
  const baseModel =
    providerOverride && providerOverride !== input.baseProvider
      ? defaultModelForProvider(provider, env)
      : (input.baseModel ?? defaultModelForProvider(provider, env));
  const fastThresholdTokens = positiveIntEnv(
    env,
    "AGENT_FAST_THRESHOLD_TOKENS",
    50_000,
  );
  const fastModel = agentModelOverrideForProvider(
    env["AGENT_MODEL_FAST"],
    provider,
  );
  const largeContextModel = agentModelOverrideForProvider(
    env["AGENT_MODEL_LARGE_CONTEXT"],
    provider,
  );

  if (estimatedInputTokens < fastThresholdTokens && fastModel) {
    return {
      provider,
      model: fastModel,
      routing: "fast",
      estimatedInputTokens,
      fastThresholdTokens,
      reason: "estimated input is below the fast-model threshold",
    };
  }

  if (estimatedInputTokens >= fastThresholdTokens && largeContextModel) {
    return {
      provider,
      model: largeContextModel,
      routing: "large_context",
      estimatedInputTokens,
      fastThresholdTokens,
      reason: "estimated input needs the large-context model",
    };
  }

  return {
    provider,
    model: baseModel,
    routing: "default",
    estimatedInputTokens,
    fastThresholdTokens,
    reason: "no agent-specific model override matched",
  };
}

export function agentModelOutputTokenBudget(input: {
  provider: AIProvider;
  model: string;
}): number {
  return getModelContextBudget(input.provider, input.model).outputTokenBudget;
}

function agentInputCapacity(input: {
  provider: AIProvider;
  model: string;
  env?: NodeJS.ProcessEnv;
  reserve?: number;
}): number {
  const modelBudget = getModelContextBudget(input.provider, input.model);
  const reserve = input.reserve ?? modelBudget.outputTokenBudget;
  return Math.max(
    1_000,
    Math.floor(
      (modelBudget.inputTokenBudget -
        Math.min(modelBudget.outputTokenBudget, reserve)) *
        modelBudget.safetyMarginRatio,
    ),
  );
}

export interface ReadPageMarkdownFallbackBudget {
  shouldFallback: boolean;
  estimatedTokens: number;
  thresholdTokens: number;
  capacityTokens: number;
  thresholdRatio: number;
  tokenLimit: number;
  provider: AIProvider;
  model: string;
}

export function readPageMarkdownFallbackBudget(input: {
  contentMd: string;
  provider?: AIProvider;
  model?: string;
  env?: NodeJS.ProcessEnv;
  thresholdRatio?: number;
  tokenLimit?: number;
}): ReadPageMarkdownFallbackBudget {
  const env = input.env ?? process.env;
  const provider =
    input.provider ?? providerFromEnv(env["AGENT_PROVIDER"]) ?? "openai";
  const model = input.model ?? defaultModelForProvider(provider, env);
  const thresholdRatio = Math.max(
    0.01,
    Math.min(
      1,
      input.thresholdRatio ??
        positiveFloatEnv(env, "AGENT_READ_PAGE_MARKDOWN_FALLBACK_RATIO", 1),
    ),
  );
  const capacityTokens = agentInputCapacity({ provider, model, env });
  const tokenLimit =
    input.tokenLimit ??
    positiveIntEnv(
      env,
      "AGENT_READ_PAGE_MARKDOWN_TOKEN_LIMIT",
      capacityTokens,
    );
  const thresholdTokens = Math.max(
    1,
    Math.min(tokenLimit, Math.floor(capacityTokens * thresholdRatio)),
  );
  const estimatedTokens = estimateTokens(input.contentMd);

  return {
    shouldFallback: estimatedTokens > thresholdTokens,
    estimatedTokens,
    thresholdTokens,
    capacityTokens,
    thresholdRatio,
    tokenLimit,
    provider,
    model,
  };
}

function compactExcerpt(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function summarizeToolPayload(content: string): Record<string, unknown> {
  try {
    const payload = JSON.parse(content) as Record<string, unknown>;
    const result = payload["result"];
    if (result && typeof result === "object" && !Array.isArray(result)) {
      const record = result as Record<string, unknown>;
      const page = record["page"];
      const format = record["format"];
      if (format === "markdown" && typeof record["contentMd"] === "string") {
        return {
          ok: payload["ok"] ?? true,
          format,
          page,
          contentCharLength: record["contentMd"].length,
          excerpt: compactExcerpt(record["contentMd"], 1_200),
        };
      }
      if (format === "blocks" && Array.isArray(record["blocks"])) {
        return {
          ok: payload["ok"] ?? true,
          format,
          page,
          blockCount: record["blocks"].length,
          blocks: record["blocks"].slice(0, 30),
        };
      }
      if (format === "summary") {
        return {
          ok: payload["ok"] ?? true,
          format,
          page,
          summary: record["summary"],
        };
      }
    }
    return {
      ok: payload["ok"] ?? true,
      excerpt: compactExcerpt(content, 1_200),
    };
  } catch {
    return { excerpt: compactExcerpt(content, 1_200) };
  }
}

function compactToolContent(message: AIMessage): string {
  return JSON.stringify({
    compacted: true,
    marker: COMPACTED_TOOL_PREFIX,
    toolName: message.toolName ?? null,
    toolCallId: message.toolCallId ?? null,
    summary: summarizeToolPayload(message.content),
    notice:
      "This prior tool result was compacted because the agent approached its context budget. Call the same read tool again if exact original content is needed.",
  });
}

function buildSystemCompactionNotice(
  notices: AgentContextCompactionNotice[],
): AIMessage {
  const compacted = notices
    .map(
      (notice) =>
        `${notice.toolName ?? notice.label} (${notice.toolCallId ?? notice.key})`,
    )
    .join(", ");
  return {
    role: "system",
    content:
      `Context compaction ran: prior tool result(s) ${compacted} were replaced with summary form. ` +
      "If exact original content is needed, call the relevant read tool again.",
  };
}

function isCompactableToolMessage(message: AIMessage): boolean {
  return (
    message.role === "tool" &&
    !message.content.startsWith(COMPACTED_TOOL_PREFIX) &&
    !message.content.includes(`"marker":"${COMPACTED_TOOL_PREFIX}"`)
  );
}

export function compactAgentMessages(input: {
  provider: AIProvider;
  model: string;
  messages: AIMessage[];
  env?: NodeJS.ProcessEnv;
  thresholdRatio?: number;
}): {
  messages: AIMessage[];
  notices: AgentContextCompactionNotice[];
  compactedToolCallIds: string[];
  estimatedInputTokens: number;
  thresholdTokens: number;
} {
  const thresholdRatio = input.thresholdRatio ?? COMPACTION_THRESHOLD_RATIO;
  const capacity = agentInputCapacity({
    provider: input.provider,
    model: input.model,
    env: input.env,
  });
  const thresholdTokens = Math.floor(capacity * thresholdRatio);
  let estimatedInputTokens = input.messages.reduce(
    (sum, message) => sum + estimateTokens(message.content),
    0,
  );
  if (estimatedInputTokens <= thresholdTokens) {
    return {
      messages: input.messages,
      notices: [],
      compactedToolCallIds: [],
      estimatedInputTokens,
      thresholdTokens,
    };
  }

  const messages = [...input.messages];
  const notices: AgentContextCompactionNotice[] = [];
  const compactedToolCallIds: string[] = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!isCompactableToolMessage(message)) continue;

    const originalEstimatedTokens = estimateTokens(message.content);
    const compactedContent = compactToolContent(message);
    const compactedEstimatedTokens = estimateTokens(compactedContent);
    messages[i] = { ...message, content: compactedContent };
    estimatedInputTokens += compactedEstimatedTokens - originalEstimatedTokens;
    notices.push({
      key: message.toolCallId ?? `message_${i}`,
      label: message.toolName ?? `tool#${i}`,
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      originalEstimatedTokens,
      compactedEstimatedTokens,
    });
    if (message.toolCallId) compactedToolCallIds.push(message.toolCallId);
    if (estimatedInputTokens <= thresholdTokens) break;
  }

  if (notices.length > 0) {
    const notice = buildSystemCompactionNotice(notices);
    messages.push(notice);
    estimatedInputTokens += estimateTokens(notice.content);
  }

  return {
    messages,
    notices,
    compactedToolCallIds,
    estimatedInputTokens,
    thresholdTokens,
  };
}

function compactContextBlock(block: AgentContextBlock): {
  block: AgentContextBlock;
  notice: AgentContextCompactionNotice;
} {
  const originalEstimatedTokens = estimateTokens(block.text);
  const compactedPayload = {
    compacted: true,
    marker: COMPACTED_TOOL_PREFIX,
    label: block.label,
    summary: summarizeToolPayload(block.text),
    notice:
      "This read context was compacted before planning. Re-run the relevant read tool if exact source text is needed.",
  };
  const compactedText = JSON.stringify(compactedPayload, null, 2);
  return {
    block: {
      ...block,
      text: compactedText,
      minTokens: Math.min(block.minTokens ?? 500, 250),
      weight: 0.5,
      compacted: true,
    },
    notice: {
      key: block.key,
      label: block.label,
      originalEstimatedTokens,
      compactedEstimatedTokens: estimateTokens(compactedText),
    },
  };
}

export function compactAgentContextBlocks(input: {
  blocks: AgentContextBlock[];
  ingestionText: string;
  availableTokens: number;
  thresholdRatio?: number;
}): {
  blocks: AgentContextBlock[];
  notices: AgentContextCompactionNotice[];
  estimatedBeforeTokens: number;
  estimatedAfterTokens: number;
  thresholdTokens: number;
} {
  const thresholdTokens = Math.floor(
    input.availableTokens *
      (input.thresholdRatio ?? COMPACTION_THRESHOLD_RATIO),
  );
  const ingestionTokens = estimateTokens(input.ingestionText);
  const blocks = [...input.blocks];
  const notices: AgentContextCompactionNotice[] = [];
  let estimatedAfterTokens =
    ingestionTokens +
    blocks.reduce((sum, block) => sum + estimateTokens(block.text), 0);
  const estimatedBeforeTokens = estimatedAfterTokens;

  if (estimatedAfterTokens <= thresholdTokens) {
    return {
      blocks,
      notices,
      estimatedBeforeTokens,
      estimatedAfterTokens,
      thresholdTokens,
    };
  }

  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i].compacted) continue;
    const originalTokens = estimateTokens(blocks[i].text);
    const compacted = compactContextBlock(blocks[i]);
    blocks[i] = compacted.block;
    notices.push(compacted.notice);
    estimatedAfterTokens +=
      compacted.notice.compactedEstimatedTokens - originalTokens;
    if (estimatedAfterTokens <= thresholdTokens) break;
  }

  return {
    blocks,
    notices,
    estimatedBeforeTokens,
    estimatedAfterTokens,
    thresholdTokens,
  };
}

export function packAgentExploreContext(input: {
  provider: AIProvider;
  model: string;
  systemPrompt: string;
  ingestionText: string;
  sourceName: string;
  contentType: string;
  titleHint: string | null;
  env?: NodeJS.ProcessEnv;
  outputReserveTokens?: number;
}): PackedAgentContext {
  const modelBudget = getModelContextBudget(input.provider, input.model);
  const systemTokens = estimateTokens(input.systemPrompt);
  const reserve = Math.min(
    modelBudget.outputTokenBudget,
    input.outputReserveTokens ?? Math.min(4_096, modelBudget.outputTokenBudget),
  );
  const scaffold = `Source: ${input.sourceName}
Content type: ${input.contentType}
Title hint: ${input.titleHint ?? "(none)"}
Incoming content:
---
`;
  const scaffoldTokens = estimateTokens(scaffold) + estimateTokens("\n---");
  const rawAvailable =
    modelBudget.inputTokenBudget -
    reserve -
    systemTokens -
    scaffoldTokens;
  const available = Math.max(
    0,
    Math.floor(rawAvailable * modelBudget.safetyMarginRatio),
  );
  const sliced = sliceWithinTokenBudget(input.ingestionText, available, {
    preserveStructure: true,
  });

  return {
    text: `${scaffold}${sliced.text}\n---`,
    budgetMeta: {
      inputTokenBudget: available,
      estimatedInputTokens:
        systemTokens + scaffoldTokens + sliced.estimatedTokens,
      inputCharLength:
        input.systemPrompt.length + scaffold.length + sliced.text.length + 4,
      truncated: sliced.truncated,
      strategy: "agent_explore_context_packing",
      slotAllocations: {
        ingestion: {
          allocatedTokens: available,
          estimatedTokens: sliced.estimatedTokens,
          truncated: sliced.truncated,
        },
      },
    },
  };
}

export function packAgentPlanContext(input: {
  provider: AIProvider;
  model: string;
  systemPrompt: string;
  ingestionText: string;
  sourceName: string;
  contentType: string;
  titleHint: string | null;
  blocks: AgentContextBlock[];
  env?: NodeJS.ProcessEnv;
  outputReserveTokens?: number;
}): PackedAgentContext {
  const modelBudget = getModelContextBudget(input.provider, input.model);
  const systemTokens = estimateTokens(input.systemPrompt);
  const reserve = Math.min(
    modelBudget.outputTokenBudget,
    input.outputReserveTokens ?? modelBudget.outputTokenBudget,
  );
  const scaffoldTokens = 500;
  const rawAvailable =
    modelBudget.inputTokenBudget -
    reserve -
    systemTokens -
    scaffoldTokens;
  const available = Math.max(
    1_000,
    Math.floor(rawAvailable * modelBudget.safetyMarginRatio),
  );

  const compaction = compactAgentContextBlocks({
    blocks: input.blocks,
    ingestionText: input.ingestionText,
    availableTokens: available,
  });
  const contextBlocks = compaction.blocks;

  const slots = [
    {
      key: "ingestion",
      text: input.ingestionText,
      minTokens: Math.min(8_000, Math.floor(available * 0.5)),
      weight: 10,
    },
    ...contextBlocks.map((block, index) => ({
      key: block.key || `context_${index}`,
      text: block.text,
      minTokens: block.minTokens ?? 500,
      weight: block.weight ?? 2,
    })),
  ];
  const allocations = allocateBudgets(slots, available, {
    preserveStructure: true,
  });

  const chunks = [
    `[INGESTION]
Source: ${input.sourceName}
Content type: ${input.contentType}
Title hint: ${input.titleHint ?? "(none)"}
---
${allocations.ingestion.text}
---`,
  ];

  if (compaction.notices.length > 0) {
    chunks.push(
      `[SYSTEM_NOTICE:context_compaction]
Prior read context was compacted using oldest-first summary form because the plan prompt approached the model context budget. Re-run read_page for exact original content if needed.
${JSON.stringify(compaction.notices, null, 2)}`,
    );
  }

  for (const block of contextBlocks) {
    const allocated = allocations[block.key];
    if (!allocated || allocated.text.trim() === "") continue;
    chunks.push(`[CONTEXT:${block.label}]\n${allocated.text}`);
  }

  const slotAllocations: NonNullable<AIBudgetMeta["slotAllocations"]> = {};
  let estimatedInputTokens = systemTokens + scaffoldTokens;
  let inputCharLength = input.systemPrompt.length;
  let truncated = false;
  for (const [key, allocation] of Object.entries(allocations)) {
    slotAllocations[key] = {
      allocatedTokens: allocation.allocatedTokens,
      estimatedTokens: allocation.estimatedTokens,
      truncated: allocation.truncated,
    };
    estimatedInputTokens += allocation.estimatedTokens;
    inputCharLength += allocation.text.length;
    truncated ||= allocation.truncated;
  }

  return {
    text: chunks.join("\n\n"),
    budgetMeta: {
      inputTokenBudget: available,
      estimatedInputTokens,
      inputCharLength,
      truncated,
      strategy: "agent_plan_context_packing",
      slotAllocations,
    },
    compactionNotices: compaction.notices,
  };
}

export function packPlanContextForTurn(input: {
  provider: AIProvider;
  model: string;
  systemPrompt: string;
  ingestionText: string;
  sourceName: string;
  contentType: string;
  titleHint: string | null;
  blocks: AgentContextBlock[];
  priorTurns: TurnRecord[];
  turnIndex: number;
  env?: NodeJS.ProcessEnv;
  outputReserveTokens?: number;
}): PackedAgentContext {
  if (input.turnIndex === 0) {
    return packAgentPlanContext(input);
  }

  const priorTurnsBlock: AgentContextBlock = {
    key: "prior_turns",
    label: "Prior turns",
    text: JSON.stringify(
      input.priorTurns.map((turn) => ({
        turn: turn.turnIndex,
        summary: turn.plan.summary,
        proposedCount:
          turn.execution.attempted + (turn.skippedPlan?.length ?? 0),
        attempted: turn.execution.attempted,
        succeeded: turn.execution.succeeded,
        failed: turn.execution.failed,
        mutatedPageIds: turn.mutatedPageIds,
        outcomes: turn.outcomes ?? [],
        attemptedActions: turn.plan.proposedPlan.map((mutation, index) => ({
          index,
          action: mutation.action,
          tool: mutation.tool,
          targetPageId: mutation.targetPageId,
        })),
        unattemptedActions: (turn.skippedPlan ?? []).map((mutation, index) => ({
          index: turn.execution.attempted + index,
          action: mutation.action,
          tool: mutation.tool,
          targetPageId: mutation.targetPageId,
          reason: mutation.reason,
        })),
      })),
      null,
      2,
    ),
    minTokens: 1_000,
    weight: 5,
  };

  return packAgentPlanContext({
    ...input,
    blocks: [...input.blocks, priorTurnsBlock],
  });
}
