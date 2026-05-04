import {
  extractIngestionText,
  ingestionAgentPlanSchema,
  estimateTokens,
  INGESTION_ACTIONS,
  MODE_OUTPUT_RESERVE,
  type AIAdapter,
  type AIBudgetMeta,
  type AIMessage,
  type AIProvider,
  type AIRequest,
  type AIResponse,
  type AIToolDefinition,
  type AgentMutateToolName,
  type AgentPlanMutation,
  type AutonomyMode,
  type IngestionAgentPlan,
  type ModelRunStatus,
  type NormalizedToolCall,
} from "@wekiflow/shared";
import { getAIAdapter, getDefaultProvider } from "../../ai-gateway.js";
import { createAgentDispatcher } from "./dispatcher.js";
import {
  createMutateTools,
  recordAgentMutationFailure,
  type CreateMutateToolsInput,
} from "./tools/mutate.js";
import {
  compactAgentMessages,
  packAgentExploreContext,
  packAgentPlanContext,
  readAgentRuntimeLimits,
  selectAgentModel,
  type AgentContextBlock,
  type AgentModelSelection,
} from "./budgeter.js";
import type {
  AgentDb,
  AgentRunState,
  AgentRunTraceStep,
  AgentToolDefinition,
  AgentToolErrorPayload,
  AgentToolExecution,
} from "./types.js";
import { createAgentRunState } from "./types.js";

const PROMPT_VERSION = "ingestion-agent-v1";
const EXPLORE_OUTPUT_RESERVE = Math.min(4_096, MODE_OUTPUT_RESERVE.agent_plan);
const INGESTION_ACTION_SET = new Set<string>(INGESTION_ACTIONS);

const EXPLORE_SYSTEM_PROMPT = `You are a read-only exploration agent for WekiFlow's Markdown knowledge wiki.
Investigate the incoming ingestion with the available read-only tools, then stop calling tools when you have enough context to plan possible wiki updates.
Never invent page IDs. Only refer to pages that tools returned. Do not propose or execute mutations during exploration.

Before proposing a new page, actively rule out duplication:
- Search by title hint, source-specific nouns, and canonical entity names.
- If search_pages returns weak or empty results, use list_recent_pages, list_folder, or find_related_entities before assuming create.
- When the same read tool arguments are repeated and the dispatcher returns a cached result, refine the query or continue planning instead of repeating the same call.`;

const PLAN_SYSTEM_PROMPT = `You are planning wiki maintenance mutations for WekiFlow.
Use the ingestion and read-only context to propose exact wiki changes.
Prefer the narrowest safe mutate tool to creating duplicate pages. Keep confidence calibrated.
Honor workspace operator instructions about where knowledge belongs, source-specific routing, aliases, and forbidden create/update paths.
If context is insufficient to avoid a duplicate or unsafe rewrite, return request_human_review instead of create_page. In scheduled mode, prefer noop over request_human_review when no safe autonomous change exists.

When you can make an exact edit, return a typed tool plan:
{
  "tool": "replace_in_page" | "edit_page_blocks" | "edit_page_section" | "update_page" | "append_to_page" | "create_page" | "move_page" | "rename_page" | "create_folder" | "delete_page" | "merge_pages" | "rollback_to_revision" | "noop" | "request_human_review",
  "args": { ...tool arguments... },
  "action": "create" | "update" | "append" | "delete" | "merge" | "noop" | "needs_review",
  "targetPageId": "uuid or null",
  "confidence": 0.0,
  "reason": "why"
}

Tool argument contracts:
- replace_in_page: { pageId, find, replace, occurrence?, confidence, reason }
- edit_page_blocks: { pageId, ops: [{ blockId, op: "replace"|"insert_after"|"insert_before"|"delete", content? }], confidence, reason }
- edit_page_section: { pageId, sectionAnchor, op: "replace"|"append"|"prepend"|"delete", content?, confidence, reason }
- update_page: { pageId, newContentMd, confidence, reason }
- append_to_page: { pageId, contentMd, sectionHint?, confidence, reason }
- create_page: { title, contentMd, parentFolderId?, parentPageId?, confidence, reason }
- move_page: { pageId, newParentPageId?, newParentFolderId?, newSortOrder?, reorderIntent?: "before"|"after"|"append"|"explicit", reorderAnchorPageId?, confidence, reason }
- rename_page: { pageId, newTitle?, newSlug?, confidence, reason }
- create_folder: { name, parentFolderId?, confidence, reason }
- delete_page: { pageId, confidence, reason } (Scheduled reorganize or autonomous workspace mode only; scheduled auto-apply purges the page subtree, autonomous ingestion auto-apply soft-deletes it)
- merge_pages: { canonicalPageId, sourcePageIds, mergedContentMd, confidence, reason } (Scheduled reorganize or autonomous workspace mode only; scheduled auto-apply purges source page subtrees, autonomous ingestion auto-apply soft-deletes them after updating the canonical page)
- rollback_to_revision: { pageId, revisionId, confidence, reason } (Use only to self-correct a recent autonomous mistake on an observed page; never roll back human-authored recent work)
- noop: { reason, confidence? }
- request_human_review: { reason, suggestedAction?, suggestedPageIds?, confidence? } where suggestedAction must be one of "create", "update", "append", "delete", "merge", "noop", "needs_review"; put free-form guidance in reason, not suggestedAction.

Use update_page only when a narrower tool cannot represent the change. Never invent page IDs or block IDs.
When restructuring is needed, prefer move_page/rename_page over recreating pages. Use create_folder before move_page when the target folder does not exist yet.
Use delete_page and merge_pages only for scheduled wiki reorganization or autonomous workspace mode. If neither mode applies, request human review instead.
In autonomous workspace mode, delete_page and merge_pages may be used for high-confidence ingestion cleanup when the target pages were observed in this run. In autonomous_shadow mode, plan the same tool you would use autonomously, but it will be queued for human review.
Use rollback_to_revision only after the target page and rollback revision were observed and the rollback restores the page from a recent autonomous error. Prefer request_human_review if the target revision appears to be recent human-authored work.

Return only JSON with this exact shape:
{
  "summary": "short explanation",
  "proposedPlan": [
    {
      "action": "create" | "update" | "append" | "delete" | "merge" | "noop" | "needs_review",
      "targetPageId": "uuid or null",
      "confidence": 0.0,
      "reason": "why",
      "tool": "optional mutate tool name",
      "args": { "optional": "mutate tool args" },
      "proposedTitle": "required for create",
      "sectionHint": "optional",
      "contentSummary": "optional",
      "evidence": [{ "pageId": "uuid", "note": "short evidence" }]
    }
  ],
  "openQuestions": []
}`;

const MUTATION_REPAIR_SYSTEM_PROMPT = `You repair one failed WekiFlow mutate tool call.
Use the tool error and self-correction hints to return a single corrected mutation.
Do not introduce unrelated page changes. If the error cannot be repaired safely, return request_human_review.

Return only JSON with this shape:
{
  "summary": "short repair explanation",
  "proposedPlan": [
    {
      "action": "update" | "append" | "create" | "delete" | "merge" | "noop" | "needs_review",
      "targetPageId": "uuid or null",
      "confidence": 0.0,
      "reason": "why this repaired mutation is safe",
      "tool": "replace_in_page" | "edit_page_blocks" | "edit_page_section" | "update_page" | "append_to_page" | "create_page" | "move_page" | "rename_page" | "create_folder" | "delete_page" | "merge_pages" | "rollback_to_revision" | "noop" | "request_human_review",
      "args": { "corrected": "tool arguments" },
      "evidence": []
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
  targetFolderId?: string | null;
  targetParentPageId?: string | null;
  useReconciliation?: boolean;
}

export interface AgentModelRunRecord {
  request: AIRequest;
  response?: AIResponse;
  status: ModelRunStatus;
  requestMetaJson: Record<string, unknown>;
  responseMetaJson: Record<string, unknown>;
}

export interface AgentWorkspaceTokenReservationRequest {
  phase: string;
  estimatedTokens: number;
  cap: number;
  usedToday: number;
  totalTokensInRun: number;
}

export interface AgentWorkspaceTokenReservation {
  reservedTokens: number;
  usedAfterReservation: number;
  release(actualTokens: number): Promise<void>;
}

export interface RunIngestionAgentShadowInput {
  db: AgentDb;
  workspaceId: string;
  ingestion: AgentIngestionInput;
  origin?: "ingestion" | "scheduled";
  mode?: "shadow" | "agent";
  agentRunId?: string;
  seedPageIds?: string[];
  instruction?: string | null;
  scheduledRunId?: string | null;
  scheduledAutoApply?: boolean;
  allowDestructiveScheduledAgent?: boolean;
  autonomyMode?: AutonomyMode;
  autonomyMaxDestructivePerRun?: number;
  consumeDestructiveDailyOperation?: CreateMutateToolsInput["consumeDestructiveDailyOperation"];
  adapter?: AIAdapter;
  baseProvider?: AIProvider;
  baseModel?: string;
  tools?: Record<string, AgentToolDefinition>;
  mutateTools?: Record<string, AgentToolDefinition>;
  mutationQueues?: Pick<
    CreateMutateToolsInput,
    "patchQueue" | "extractionQueue" | "searchQueue"
  >;
  workspaceAgentInstructions?: string | null;
  workspaceTokenUsage?: {
    usedToday: number;
    cap?: number;
  };
  reserveWorkspaceTokens?: (
    request: AgentWorkspaceTokenReservationRequest,
  ) => Promise<AgentWorkspaceTokenReservation | null>;
  onStep?: (step: AgentRunTraceStep) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
  recordModelRun?: (
    record: AgentModelRunRecord,
  ) => Promise<{ id?: string } | void>;
}

export interface IngestionAgentShadowResult {
  status: "shadow" | "completed";
  planJson: IngestionAgentPlan & {
    shadow: boolean;
    model: AgentModelSelection;
    budget: AIBudgetMeta;
    parseFailed?: boolean;
    execution?: {
      mode: "agent";
      succeeded: number;
      failed: number;
    };
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

export class AgentWorkspaceTokenCapExceeded extends Error {
  constructor(
    message: string,
    public readonly steps: AgentRunTraceStep[],
    public readonly totalTokens: number,
    public readonly totalLatencyMs: number,
    public readonly cap: number,
    public readonly usedToday: number,
    public readonly details: {
      phase?: string;
      estimatedTokens?: number;
      remainingTokens?: number;
    } = {},
  ) {
    super(message);
    this.name = "AgentWorkspaceTokenCapExceeded";
  }
}

function withWorkspaceInstructions(
  basePrompt: string,
  instructions: string | null | undefined,
): string {
  const trimmed = instructions?.trim();
  if (!trimmed) return basePrompt;
  return `${basePrompt}

Workspace operator instructions:
${trimmed}

Treat these workspace instructions as routing and editing policy. If they conflict with tool safety, confidence gates, or provenance requirements, keep the safety requirement and request human review.`;
}

function scheduledPromptPrefix(input: RunIngestionAgentShadowInput): string {
  if (input.origin !== "scheduled") return "";
  const seedPageIds = [...new Set(input.seedPageIds ?? [])];
  const lines = [
    "Scheduled reorganize mode:",
    "- This is not an external fact ingestion. It is a request to reorganize and improve existing wiki pages.",
    "- Prefer replace_in_page, edit_page_blocks, or edit_page_section over full rewrites.",
    "- Use create_page only as a last resort when the target knowledge cannot fit into existing selected pages.",
    input.allowDestructiveScheduledAgent
      ? "- Use delete_page when a selected page is fully redundant with another existing page."
      : "- Destructive tools are disabled for this workspace; do not plan delete_page.",
    input.allowDestructiveScheduledAgent
      ? "- Use merge_pages to consolidate 2+ short pages into one canonical page; include full mergedContentMd."
      : "- Destructive tools are disabled for this workspace; do not plan merge_pages.",
    "- Scheduled mutations apply autonomously; do not route cleanup work to human approval.",
    "- If no safe autonomous change exists, use noop with a clear reason instead of request_human_review.",
  ];
  if (seedPageIds.length > 0) {
    lines.push(
      `- Seed page IDs selected by the user: ${seedPageIds.join(", ")}`,
    );
  }
  const instruction = input.instruction?.trim();
  if (instruction) {
    lines.push("", "User instruction:", instruction);
  }
  return lines.join("\n");
}

function mergeAgentInstructions(
  input: RunIngestionAgentShadowInput,
): string | null {
  const scheduled = scheduledPromptPrefix(input);
  const workspace = input.workspaceAgentInstructions?.trim() ?? "";
  if (!scheduled && !workspace) return null;
  return [scheduled, workspace].filter(Boolean).join("\n\n");
}

function createInitialAgentRunState(
  seedPageIds: string[] | undefined,
): AgentRunState {
  const state = createAgentRunState();
  for (const pageId of seedPageIds ?? []) {
    state.seenPageIds.add(pageId);
  }
  return state;
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
): AgentRunTraceStep {
  const step = {
    step: steps.length,
    type,
    payload,
    ts: new Date().toISOString(),
  };
  steps.push(step);
  return step;
}

function emitStep(
  input: Pick<RunIngestionAgentShadowInput, "onStep">,
  step: AgentRunTraceStep,
): void {
  const result = input.onStep?.(step);
  if (result && typeof (result as Promise<void>).catch === "function") {
    void (result as Promise<void>).catch(() => undefined);
  }
}

function traceStep(
  input: Pick<RunIngestionAgentShadowInput, "onStep">,
  steps: AgentRunTraceStep[],
  type: AgentRunTraceStep["type"],
  payload: Record<string, unknown>,
): AgentRunTraceStep {
  const step = pushStep(steps, type, payload);
  emitStep(input, step);
  return step;
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

function readPageFallbackNotice(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const fallback = (result as Record<string, unknown>)["fallback"];
  if (!fallback || typeof fallback !== "object") return null;
  const record = fallback as Record<string, unknown>;
  if (record["type"] !== "markdown_to_blocks") return null;
  const page = (result as Record<string, unknown>)["page"];
  const pageTitle =
    page && typeof page === "object"
      ? ((page as Record<string, unknown>)["title"] as string | undefined)
      : undefined;
  return (
    `read_page returned blocks for ${pageTitle ?? "the requested page"} because full markdown exceeded the safe context budget. ` +
    "Use the returned block IDs and request summary/blocks again if more structure is needed; avoid asking for full markdown unless necessary."
  );
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

const ACTION_TO_TOOL: Record<
  NonNullable<AgentPlanMutation["action"]>,
  AgentMutateToolName
> = {
  create: "create_page",
  update: "update_page",
  append: "append_to_page",
  delete: "delete_page",
  merge: "merge_pages",
  noop: "noop",
  needs_review: "request_human_review",
};

function appendReasonNote(
  reason: string,
  label: string,
  value: string,
): string {
  const note = `${label}: ${value}`;
  const next = reason.trim().length > 0 ? `${reason}\n\n${note}` : note;
  return next.slice(0, 2_000);
}

function normalizeRequestHumanReviewArgs(
  args: Record<string, unknown>,
  fallback: Pick<AgentPlanMutation, "confidence" | "reason" | "targetPageId">,
): Record<string, unknown> {
  const normalized = { ...args };
  normalized.reason =
    typeof normalized.reason === "string" && normalized.reason.trim().length > 0
      ? normalized.reason
      : fallback.reason;
  normalized.confidence =
    typeof normalized.confidence === "number"
      ? normalized.confidence
      : fallback.confidence;
  if (!Array.isArray(normalized.suggestedPageIds) && fallback.targetPageId) {
    normalized.suggestedPageIds = [fallback.targetPageId];
  }

  const suggestedAction = normalized.suggestedAction;
  if (suggestedAction === undefined) return normalized;
  if (
    typeof suggestedAction === "string" &&
    INGESTION_ACTION_SET.has(suggestedAction)
  ) {
    return normalized;
  }

  delete normalized.suggestedAction;
  if (
    typeof suggestedAction === "string" &&
    suggestedAction.trim().length > 0
  ) {
    normalized.reason = appendReasonNote(
      String(normalized.reason),
      "Suggested action note",
      suggestedAction,
    );
  }
  return normalized;
}

function mutationToToolCall(
  mutation: AgentPlanMutation,
  index: number,
  ingestionText: string,
): NormalizedToolCall {
  if (mutation.tool) {
    const args = {
      ...(mutation.args ?? {}),
      confidence:
        (mutation.args?.["confidence"] as unknown) ?? mutation.confidence,
      reason: (mutation.args?.["reason"] as unknown) ?? mutation.reason,
    };
    return {
      id: `mutation_${index}_${mutation.tool}`,
      name: mutation.tool,
      arguments:
        mutation.tool === "request_human_review"
          ? normalizeRequestHumanReviewArgs(args, mutation)
          : args,
    };
  }

  const action = mutation.action ?? "needs_review";
  const name = ACTION_TO_TOOL[action];
  const common = {
    confidence: mutation.confidence,
    reason: mutation.reason,
  };

  if (action === "create") {
    return {
      id: `mutation_${index}_${name}`,
      name,
      arguments: {
        ...common,
        title: mutation.proposedTitle ?? "Untitled (ingested)",
        contentMd: ingestionText,
      },
    };
  }

  if (action === "update") {
    return {
      id: `mutation_${index}_${name}`,
      name,
      arguments: {
        ...common,
        pageId: mutation.targetPageId,
        newContentMd: ingestionText,
      },
    };
  }

  if (action === "append") {
    return {
      id: `mutation_${index}_${name}`,
      name,
      arguments: {
        ...common,
        pageId: mutation.targetPageId,
        contentMd: ingestionText,
        sectionHint: mutation.sectionHint,
      },
    };
  }

  if (action === "delete") {
    return {
      id: `mutation_${index}_${name}`,
      name,
      arguments: {
        ...common,
        pageId: mutation.targetPageId,
      },
    };
  }

  if (action === "noop") {
    return {
      id: `mutation_${index}_${name}`,
      name,
      arguments: common,
    };
  }

  return {
    id: `mutation_${index}_${name}`,
    name,
    arguments: {
      reason: mutation.reason,
      confidence: mutation.confidence,
      suggestedAction: undefined,
      suggestedPageIds: mutation.targetPageId ? [mutation.targetPageId] : [],
    },
  };
}

function resultDecisionId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const id = (result as Record<string, unknown>)["decisionId"];
  return typeof id === "string" ? id : null;
}

async function executeMutations(input: {
  db: AgentDb;
  workspaceId: string;
  ingestion: AgentIngestionInput;
  agentRunId: string;
  modelRunId: string;
  origin?: RunIngestionAgentShadowInput["origin"];
  scheduledRunId?: RunIngestionAgentShadowInput["scheduledRunId"];
  scheduledAutoApply?: RunIngestionAgentShadowInput["scheduledAutoApply"];
  allowDestructiveScheduledAgent?: RunIngestionAgentShadowInput["allowDestructiveScheduledAgent"];
  autonomyMode?: RunIngestionAgentShadowInput["autonomyMode"];
  autonomyMaxDestructivePerRun?: RunIngestionAgentShadowInput["autonomyMaxDestructivePerRun"];
  consumeDestructiveDailyOperation?: CreateMutateToolsInput["consumeDestructiveDailyOperation"];
  ingestionText: string;
  plan: IngestionAgentPlan;
  state: AgentRunState;
  mutateTools?: Record<string, AgentToolDefinition>;
  mutationQueues?: RunIngestionAgentShadowInput["mutationQueues"];
  steps: AgentRunTraceStep[];
  onStep?: RunIngestionAgentShadowInput["onStep"];
  repairMutation?: (failure: {
    index: number;
    mutation: AgentPlanMutation;
    toolCall: NormalizedToolCall;
    error: AgentToolErrorPayload;
  }) => Promise<AgentPlanMutation | null>;
}): Promise<{ succeeded: number; failed: number }> {
  const mutationInput: CreateMutateToolsInput = {
    ingestion: input.ingestion,
    agentRunId: input.agentRunId,
    modelRunId: input.modelRunId,
    origin: input.origin,
    scheduledRunId: input.scheduledRunId,
    scheduledAutoApply: input.scheduledAutoApply,
    allowDestructiveScheduledAgent: input.allowDestructiveScheduledAgent,
    autonomyMode: input.autonomyMode,
    autonomyMaxDestructivePerRun: input.autonomyMaxDestructivePerRun,
    consumeDestructiveDailyOperation: input.consumeDestructiveDailyOperation,
    ...input.mutationQueues,
  };
  const tools =
    input.mutateTools ??
    createMutateTools(mutationInput as CreateMutateToolsInput);
  const dispatcher = createAgentDispatcher({
    db: input.db,
    workspaceId: input.workspaceId,
    state: input.state,
    tools,
    options: { maxCallsPerTurn: 1 },
  });

  let succeeded = 0;
  let failed = 0;
  for (const [index, mutation] of input.plan.proposedPlan.entries()) {
    const toolCall = mutationToToolCall(mutation, index, input.ingestionText);
    const [execution] = await dispatcher.dispatchToolCalls([toolCall]);
    traceStep(input, input.steps, "mutation_result", {
      name: execution.name,
      toolCallId: execution.toolCallId,
      ok: execution.ok,
      result: execution.ok ? compactJson(execution.result, 4_000) : undefined,
      error: execution.ok ? undefined : execution.error,
    });

    if (execution.ok) {
      succeeded += resultDecisionId(execution.result) ? 1 : 0;
      continue;
    }

    let finalError = execution.error;
    if (input.repairMutation) {
      const repaired = await input.repairMutation({
        index,
        mutation,
        toolCall,
        error: execution.error,
      });
      if (repaired) {
        const repairedToolCall = mutationToToolCall(
          repaired,
          index,
          input.ingestionText,
        );
        const [repairedExecution] = await dispatcher.dispatchToolCalls([
          repairedToolCall,
        ]);
        traceStep(input, input.steps, "mutation_result", {
          name: repairedExecution.name,
          toolCallId: repairedExecution.toolCallId,
          ok: repairedExecution.ok,
          repairAttempt: true,
          result: repairedExecution.ok
            ? compactJson(repairedExecution.result, 4_000)
            : undefined,
          error: repairedExecution.ok ? undefined : repairedExecution.error,
        });
        if (repairedExecution.ok) {
          succeeded += resultDecisionId(repairedExecution.result) ? 1 : 0;
          continue;
        }
        finalError = repairedExecution.error;
      }
    }

    failed += 1;
    if (!input.mutateTools) {
      const failureDecisionId = await recordAgentMutationFailure(
        {
          db: input.db,
          workspaceId: input.workspaceId,
          state: dispatcher.state,
        },
        mutationInput,
        {
          tool: execution.name,
          message: finalError.message,
          details: {
            details: finalError.details,
            selfCorrection: finalError.selfCorrection,
          },
        },
      );
      traceStep(input, input.steps, "mutation_result", {
        name: "request_human_review",
        ok: true,
        result: { decisionId: failureDecisionId, status: "failed" },
        source: "mutation_failure_fallback",
      });
      succeeded += 1;
    }
  }

  return { succeeded, failed };
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

function estimateReservationTokens(request: AIRequest): number {
  const messageText = request.messages
    .map((message) =>
      [
        message.role,
        message.toolName ?? "",
        message.toolCallId ?? "",
        message.content,
        message.toolCalls?.length ? JSON.stringify(message.toolCalls) : "",
      ].join("\n"),
    )
    .join("\n\n");
  const messageTokens = estimateTokens(messageText);
  const toolTokens = request.tools?.length
    ? estimateTokens(JSON.stringify(request.tools))
    : 0;
  const estimatedInputTokens = Math.max(
    request.budgetMeta?.estimatedInputTokens ?? 0,
    messageTokens + toolTokens,
  );
  return Math.max(
    1,
    Math.ceil(estimatedInputTokens * 1.15) + (request.maxTokens ?? 0),
  );
}

function enforceWorkspaceTokenCap(input: {
  steps: AgentRunTraceStep[];
  totals: { tokens: number; latencyMs: number };
  cap: number;
  usedToday: number;
  phase: string;
}): void {
  if (input.usedToday + input.totals.tokens < input.cap) return;
  throw new AgentWorkspaceTokenCapExceeded(
    `Workspace daily agent token cap exceeded before ${input.phase}`,
    input.steps,
    input.totals.tokens,
    input.totals.latencyMs,
    input.cap,
    input.usedToday,
    {
      phase: input.phase,
      remainingTokens: Math.max(
        0,
        input.cap - input.usedToday - input.totals.tokens,
      ),
    },
  );
}

function enforceWorkspaceTokenCapAfterUsage(input: {
  steps: AgentRunTraceStep[];
  totals: { tokens: number; latencyMs: number };
  cap: number;
  usedToday: number;
  phase: string;
}): void {
  if (input.usedToday + input.totals.tokens <= input.cap) return;
  throw new AgentWorkspaceTokenCapExceeded(
    `Workspace daily agent token cap exceeded after ${input.phase}`,
    input.steps,
    input.totals.tokens,
    input.totals.latencyMs,
    input.cap,
    input.usedToday,
    {
      phase: input.phase,
      remainingTokens: Math.max(
        0,
        input.cap - input.usedToday - input.totals.tokens,
      ),
    },
  );
}

async function reserveWorkspaceTokensForRequest(
  input: RunIngestionAgentShadowInput,
  request: AIRequest,
  control: {
    steps: AgentRunTraceStep[];
    totals: { tokens: number; latencyMs: number };
    cap: number;
    usedToday: number;
    phase: string;
  },
): Promise<AgentWorkspaceTokenReservation | null> {
  const estimatedTokens = estimateReservationTokens(request);
  const remainingTokens = Math.max(
    0,
    control.cap - control.usedToday - control.totals.tokens,
  );
  if (!input.reserveWorkspaceTokens) {
    enforceWorkspaceTokenCap(control);
    return null;
  }

  const reservation = await input.reserveWorkspaceTokens({
    phase: control.phase,
    estimatedTokens,
    cap: control.cap,
    usedToday: control.usedToday,
    totalTokensInRun: control.totals.tokens,
  });
  if (reservation) return reservation;

  throw new AgentWorkspaceTokenCapExceeded(
    `Workspace daily agent token cap exceeded before ${control.phase}`,
    control.steps,
    control.totals.tokens,
    control.totals.latencyMs,
    control.cap,
    control.usedToday,
    {
      phase: control.phase,
      estimatedTokens,
      remainingTokens,
    },
  );
}

async function releaseWorkspaceTokenReservation(
  reservation: AgentWorkspaceTokenReservation | null,
  actualTokens: number,
): Promise<void> {
  if (!reservation) return;
  await reservation.release(Math.max(0, actualTokens)).catch(() => undefined);
}

async function recordModelRun(
  input: RunIngestionAgentShadowInput,
  record: AgentModelRunRecord,
): Promise<{ id?: string } | void> {
  if (!input.recordModelRun) return undefined;
  return input.recordModelRun(record);
}

export async function runIngestionAgentShadow(
  input: RunIngestionAgentShadowInput,
): Promise<IngestionAgentShadowResult> {
  const mode = input.mode ?? "shadow";
  const limits = readAgentRuntimeLimits(input.env);
  const workspaceTokenCap =
    input.workspaceTokenUsage?.cap ?? limits.workspaceDailyTokenCap;
  const workspaceTokensUsedToday = Math.max(
    0,
    input.workspaceTokenUsage?.usedToday ?? 0,
  );
  const deadlineMs = Date.now() + limits.timeoutMs;
  const steps: AgentRunTraceStep[] = [];
  const totals = { tokens: 0, latencyMs: 0 };
  const ingestionText = extractIngestionText(input.ingestion);
  const mergedInstructions = mergeAgentInstructions(input);
  const exploreSystemPrompt = withWorkspaceInstructions(
    EXPLORE_SYSTEM_PROMPT,
    mergedInstructions,
  );
  const planSystemPrompt = withWorkspaceInstructions(
    PLAN_SYSTEM_PROMPT,
    mergedInstructions,
  );
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

  traceStep(input, steps, "model_selection", {
    phase: "explore",
    ...exploreModel,
    workspaceTokenCap,
    workspaceTokensUsedToday,
  });
  const packedExplore = packAgentExploreContext({
    provider: exploreModel.provider,
    model: exploreModel.model,
    systemPrompt: exploreSystemPrompt,
    ingestionText,
    sourceName: input.ingestion.sourceName,
    contentType: input.ingestion.contentType,
    titleHint: input.ingestion.titleHint,
    env: input.env,
  });

  const initialState = createInitialAgentRunState(input.seedPageIds);
  const dispatcher = createAgentDispatcher({
    db: input.db,
    workspaceId: input.workspaceId,
    state: initialState,
    tools: input.tools,
    env: input.env,
    model: { provider: exploreModel.provider, model: exploreModel.model },
    options: { maxCallsPerTurn: limits.maxCallsPerTurn },
  });
  const toolContextBlocks: AgentContextBlock[] = [];
  let messages: AIMessage[] = [
    { role: "system", content: exploreSystemPrompt },
    { role: "user", content: packedExplore.text },
  ];
  const toolCallsById = new Map<string, NormalizedToolCall>();

  for (let i = 0; i < limits.maxSteps; i += 1) {
    const compacted = compactAgentMessages({
      provider: exploreModel.provider,
      model: exploreModel.model,
      messages,
      env: input.env,
    });
    if (compacted.notices.length > 0) {
      messages = compacted.messages;
      for (const toolCallId of compacted.compactedToolCallIds) {
        const toolCall = toolCallsById.get(toolCallId);
        if (toolCall) dispatcher.invalidateCacheForToolCall(toolCall);
      }
      traceStep(input, steps, "context_compaction", {
        phase: "explore",
        notices: compacted.notices,
        estimatedInputTokens: compacted.estimatedInputTokens,
        thresholdTokens: compacted.thresholdTokens,
        invalidatedToolCallIds: compacted.compactedToolCallIds,
      });
    }

    const request: AIRequest = {
      provider: exploreModel.provider,
      model: exploreModel.model,
      mode: "agent_plan",
      promptVersion: PROMPT_VERSION,
      messages,
      temperature: 0.1,
      maxTokens: EXPLORE_OUTPUT_RESERVE,
      tools: readToolDefinitions(),
      toolChoice: "auto",
      budgetMeta: packedExplore.budgetMeta,
    };

    let response: AIResponse;
    let reservation: AgentWorkspaceTokenReservation | null = null;
    try {
      reservation = await reserveWorkspaceTokensForRequest(input, request, {
        steps,
        totals,
        cap: workspaceTokenCap,
        usedToday: workspaceTokensUsedToday,
        phase: "explore model call",
      });
      response = await chatBeforeDeadline(
        adapter,
        request,
        deadlineMs,
        steps,
        totals,
      );
    } catch (err) {
      await releaseWorkspaceTokenReservation(reservation, 0);
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
    await releaseWorkspaceTokenReservation(
      reservation,
      response.tokenInput + response.tokenOutput,
    );
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
    traceStep(input, steps, "ai_response", {
      phase: "explore",
      finishReason: response.finishReason ?? null,
      tokenInput: response.tokenInput,
      tokenOutput: response.tokenOutput,
      latencyMs: response.latencyMs,
      contentExcerpt: response.content.slice(0, 2_000),
      toolCalls: response.toolCalls ?? [],
    });
    if (!input.reserveWorkspaceTokens) {
      enforceWorkspaceTokenCapAfterUsage({
        steps,
        totals,
        cap: workspaceTokenCap,
        usedToday: workspaceTokensUsedToday,
        phase: "explore model call",
      });
    }

    if (!response.toolCalls?.length) break;
    for (const toolCall of response.toolCalls) {
      toolCallsById.set(toolCall.id, toolCall);
    }

    const executions = await dispatcher.dispatchToolCalls(response.toolCalls);
    messages.push({
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
    });
    for (const execution of executions) {
      traceStep(input, steps, "tool_result", {
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
      if (execution.ok && execution.name === "read_page") {
        const notice = readPageFallbackNotice(execution.result);
        if (notice) {
          messages.push({
            role: "system",
            content: notice,
          });
        }
      }
      if (execution.ok && execution.deduped) {
        messages.push({
          role: "system",
          content:
            `The ${execution.name} call ${execution.toolCallId} reused a cached result for identical arguments. ` +
            "Avoid repeating that same read call; refine the query or move to planning.",
        });
      }
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
  traceStep(input, steps, "model_selection", {
    phase: "plan",
    ...planModel,
  });

  const packed = packAgentPlanContext({
    provider: planModel.provider,
    model: planModel.model,
    systemPrompt: planSystemPrompt,
    ingestionText,
    sourceName: input.ingestion.sourceName,
    contentType: input.ingestion.contentType,
    titleHint: input.ingestion.titleHint,
    blocks: toolContextBlocks,
    env: input.env,
  });
  if (packed.compactionNotices?.length) {
    traceStep(input, steps, "context_compaction", {
      phase: "plan",
      notices: packed.compactionNotices,
    });
  }
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
      { role: "system", content: planSystemPrompt },
      { role: "user", content: packed.text },
    ],
    temperature: 0.1,
    maxTokens: MODE_OUTPUT_RESERVE.agent_plan,
    responseFormat: "json",
    budgetMeta: packed.budgetMeta,
  };

  let planResponse: AIResponse;
  let planReservation: AgentWorkspaceTokenReservation | null = null;
  try {
    planReservation = await reserveWorkspaceTokensForRequest(
      input,
      planRequest,
      {
        steps,
        totals,
        cap: workspaceTokenCap,
        usedToday: workspaceTokensUsedToday,
        phase: "plan model call",
      },
    );
    planResponse = await chatBeforeDeadline(
      planAdapter,
      planRequest,
      deadlineMs,
      steps,
      totals,
    );
  } catch (err) {
    await releaseWorkspaceTokenReservation(planReservation, 0);
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
  await releaseWorkspaceTokenReservation(
    planReservation,
    planResponse.tokenInput + planResponse.tokenOutput,
  );
  const parsed = parsePlan(planResponse.content);
  const planModelRun = await recordModelRun(input, {
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

  traceStep(input, steps, "plan", {
    parseFailed: parsed.parseFailed,
    mutationCount: parsed.plan.proposedPlan.length,
    contentExcerpt: planResponse.content.slice(0, 4_000),
    budget: packed.budgetMeta,
  });
  if (!input.reserveWorkspaceTokens) {
    enforceWorkspaceTokenCapAfterUsage({
      steps,
      totals,
      cap: workspaceTokenCap,
      usedToday: workspaceTokensUsedToday,
      phase: "plan model call",
    });
  }

  if (mode === "shadow") {
    traceStep(input, steps, "shadow_execute_skipped", {
      reason: "Shadow mode records plan_json only.",
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

  if (!input.agentRunId) {
    throw new Error("agentRunId is required for ingestion agent execute mode");
  }
  if (!planModelRun?.id) {
    throw new Error(
      "plan modelRunId is required for ingestion agent execute mode",
    );
  }

  const execution = await executeMutations({
    db: input.db,
    workspaceId: input.workspaceId,
    ingestion: input.ingestion,
    agentRunId: input.agentRunId,
    modelRunId: planModelRun.id,
    origin: input.origin,
    scheduledRunId: input.scheduledRunId,
    scheduledAutoApply: input.scheduledAutoApply,
    allowDestructiveScheduledAgent: input.allowDestructiveScheduledAgent,
    autonomyMode: input.autonomyMode,
    autonomyMaxDestructivePerRun: input.autonomyMaxDestructivePerRun,
    consumeDestructiveDailyOperation: input.consumeDestructiveDailyOperation,
    ingestionText,
    plan: parsed.plan,
    state: dispatcher.state,
    mutateTools: input.mutateTools,
    mutationQueues: input.mutationQueues,
    steps,
    onStep: input.onStep,
    repairMutation: async (failure) => {
      if (!failure.error.selfCorrection) return null;
      const repairRequest: AIRequest = {
        provider: planModel.provider,
        model: planModel.model,
        mode: "agent_plan",
        promptVersion: PROMPT_VERSION,
        messages: [
          { role: "system", content: MUTATION_REPAIR_SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify(
              {
                failedMutation: failure.mutation,
                failedToolCall: failure.toolCall,
                error: failure.error,
                instruction:
                  "Return exactly one corrected proposedPlan item, or request_human_review if the hint is insufficient.",
              },
              null,
              2,
            ),
          },
        ],
        temperature: 0.1,
        maxTokens: Math.min(4_096, MODE_OUTPUT_RESERVE.agent_plan),
        responseFormat: "json",
        budgetMeta: packed.budgetMeta,
      };

      let repairResponse: AIResponse;
      let repairReservation: AgentWorkspaceTokenReservation | null = null;
      try {
        repairReservation = await reserveWorkspaceTokensForRequest(
          input,
          repairRequest,
          {
            steps,
            totals,
            cap: workspaceTokenCap,
            usedToday: workspaceTokensUsedToday,
            phase: "mutation repair model call",
          },
        );
        repairResponse = await chatBeforeDeadline(
          planAdapter,
          repairRequest,
          deadlineMs,
          steps,
          totals,
        );
      } catch (err) {
        await releaseWorkspaceTokenReservation(repairReservation, 0);
        await recordModelRun(input, {
          request: repairRequest,
          status: "failed",
          requestMetaJson: {
            ingestionId: input.ingestion.id,
            agentRunId: input.agentRunId,
            phase: "mutation_repair",
            failedTool: failure.toolCall.name,
          },
          responseMetaJson: {
            error: err instanceof Error ? err.message : String(err),
          },
        });
        return null;
      }

      addUsage(totals, repairResponse);
      await releaseWorkspaceTokenReservation(
        repairReservation,
        repairResponse.tokenInput + repairResponse.tokenOutput,
      );
      const repaired = parsePlan(repairResponse.content);
      await recordModelRun(input, {
        request: repairRequest,
        response: repairResponse,
        status: repaired.parseFailed ? "failed" : "success",
        requestMetaJson: {
          ingestionId: input.ingestion.id,
          agentRunId: input.agentRunId,
          phase: "mutation_repair",
          failedTool: failure.toolCall.name,
        },
        responseMetaJson: {
          finishReason: repairResponse.finishReason ?? null,
          parseFailed: repaired.parseFailed,
          error: repaired.error,
        },
      });
      traceStep(input, steps, "plan", {
        phase: "mutation_repair",
        parseFailed: repaired.parseFailed,
        contentExcerpt: repairResponse.content.slice(0, 2_000),
      });
      if (!input.reserveWorkspaceTokens) {
        enforceWorkspaceTokenCapAfterUsage({
          steps,
          totals,
          cap: workspaceTokenCap,
          usedToday: workspaceTokensUsedToday,
          phase: "mutation repair model call",
        });
      }

      return repaired.parseFailed
        ? null
        : (repaired.plan.proposedPlan[0] ?? null);
    },
  });

  return {
    status: "completed",
    planJson: {
      ...parsed.plan,
      shadow: false,
      model: planModel,
      budget: packed.budgetMeta,
      execution: {
        mode: "agent",
        succeeded: execution.succeeded,
        failed: execution.failed,
      },
      ...(parsed.parseFailed ? { parseFailed: true } : {}),
    },
    steps,
    decisionsCount: execution.succeeded,
    totalTokens: totals.tokens,
    totalLatencyMs: totals.latencyMs,
  };
}
