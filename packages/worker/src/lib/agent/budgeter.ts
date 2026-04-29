import {
  AGENT_LIMITS,
  AI_MODELS,
  MODE_OUTPUT_RESERVE,
  allocateBudgets,
  estimateTokens,
  getModelContextBudget,
  sliceWithinTokenBudget,
  type AIBudgetMeta,
  type AIProvider,
} from "@wekiflow/shared";

export interface AgentRuntimeLimits {
  maxSteps: number;
  maxCallsPerTurn: number;
  maxMutations: number;
  timeoutMs: number;
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
}

export interface PackedAgentContext {
  text: string;
  budgetMeta: AIBudgetMeta;
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
    timeoutMs: positiveIntEnv(env, "AGENT_TIMEOUT_MS", AGENT_LIMITS.TIMEOUT_MS),
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
  if (value === "openai" || value === "gemini") return value;
  return null;
}

function defaultModelForProvider(
  provider: AIProvider,
  env: NodeJS.ProcessEnv,
): string {
  if (provider === "gemini") {
    return env["GEMINI_MODEL"] ?? AI_MODELS.GEMINI_DEFAULT;
  }
  return env["OPENAI_MODEL"] ?? AI_MODELS.OPENAI_DEFAULT;
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
  const provider =
    providerOverride ?? input.baseProvider ?? "openai";
  const baseModel =
    providerOverride && providerOverride !== input.baseProvider
      ? defaultModelForProvider(provider, env)
      : input.baseModel ?? defaultModelForProvider(provider, env);
  const fastThresholdTokens = positiveIntEnv(
    env,
    "AGENT_FAST_THRESHOLD_TOKENS",
    50_000,
  );

  if (
    estimatedInputTokens < fastThresholdTokens &&
    env["AGENT_MODEL_FAST"]
  ) {
    return {
      provider,
      model: env["AGENT_MODEL_FAST"],
      routing: "fast",
      estimatedInputTokens,
      fastThresholdTokens,
      reason: "estimated input is below the fast-model threshold",
    };
  }

  if (
    estimatedInputTokens >= fastThresholdTokens &&
    env["AGENT_MODEL_LARGE_CONTEXT"]
  ) {
    return {
      provider,
      model: env["AGENT_MODEL_LARGE_CONTEXT"],
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

export function packAgentExploreContext(input: {
  provider: AIProvider;
  model: string;
  systemPrompt: string;
  ingestionText: string;
  sourceName: string;
  contentType: string;
  titleHint: string | null;
  env?: NodeJS.ProcessEnv;
}): PackedAgentContext {
  const limits = readAgentRuntimeLimits(input.env);
  const modelBudget = getModelContextBudget(input.provider, input.model);
  const systemTokens = estimateTokens(input.systemPrompt);
  const reserve = Math.min(
    limits.outputTokenBudget,
    MODE_OUTPUT_RESERVE.agent_plan,
  );
  const scaffold = `Source: ${input.sourceName}
Content type: ${input.contentType}
Title hint: ${input.titleHint ?? "(none)"}
Incoming content:
---
`;
  const scaffoldTokens = estimateTokens(scaffold) + estimateTokens("\n---");
  const rawAvailable =
    Math.min(limits.inputTokenBudget, modelBudget.inputTokenBudget) -
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
}): PackedAgentContext {
  const limits = readAgentRuntimeLimits(input.env);
  const modelBudget = getModelContextBudget(input.provider, input.model);
  const systemTokens = estimateTokens(input.systemPrompt);
  const reserve = Math.min(
    limits.outputTokenBudget,
    MODE_OUTPUT_RESERVE.agent_plan,
  );
  const scaffoldTokens = 500;
  const rawAvailable =
    Math.min(limits.inputTokenBudget, modelBudget.inputTokenBudget) -
    reserve -
    systemTokens -
    scaffoldTokens;
  const available = Math.max(
    1_000,
    Math.floor(rawAvailable * modelBudget.safetyMarginRatio),
  );

  const slots = [
    {
      key: "ingestion",
      text: input.ingestionText,
      minTokens: Math.min(8_000, Math.floor(available * 0.5)),
      weight: 10,
    },
    ...input.blocks.map((block, index) => ({
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

  for (const block of input.blocks) {
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
  };
}
