import type { AIProvider, NormalizedToolCall } from "@wekiflow/shared";
import { AGENT_LIMITS } from "@wekiflow/shared";
import { createReadOnlyTools } from "./tools/read.js";
import {
  AgentToolError,
  createAgentRunState,
  type AgentDb,
  type AgentDispatcher,
  type AgentDispatcherOptions,
  type AgentRunState,
  type AgentToolContext,
  type AgentToolDefinition,
  type AgentToolErrorPayload,
  type AgentToolExecution,
  type AgentToolResult,
} from "./types.js";

export const DEFAULT_READ_TOOL_QUOTAS: Record<string, number> = {
  search_pages: 8,
  read_page: 20,
  list_folder: 20,
  find_related_entities: 8,
  list_recent_pages: 8,
  read_page_metadata: 30,
  find_backlinks: 5,
  read_revision_history: 10,
  read_revision: 30,
};

interface CreateAgentDispatcherInput {
  db: AgentDb;
  workspaceId: string;
  tools?: Record<string, AgentToolDefinition>;
  state?: AgentRunState;
  options?: AgentDispatcherOptions;
  env?: NodeJS.ProcessEnv;
  model?: {
    provider: AIProvider;
    model: string;
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function errorExecution(
  toolCall: NormalizedToolCall,
  error: AgentToolErrorPayload,
): AgentToolExecution {
  return {
    toolCallId: toolCall.id,
    name: toolCall.name,
    ok: false,
    error,
    deduped: false,
  };
}

function successExecution(
  toolCall: NormalizedToolCall,
  result: unknown,
  deduped: boolean,
): AgentToolExecution {
  return {
    toolCallId: toolCall.id,
    name: toolCall.name,
    ok: true,
    result,
    deduped,
  };
}

function observeResult(state: AgentRunState, result: AgentToolResult): void {
  for (const pageId of result.observedPageIds ?? []) {
    state.seenPageIds.add(pageId);
  }
  for (const observed of result.observedPageRevisions ?? []) {
    state.seenPageIds.add(observed.pageId);
    state.observedPageRevisionIds.set(observed.pageId, observed.revisionId);
    if (observed.revisionId) {
      state.seenRevisionIds.add(observed.revisionId);
    }
  }
  for (const blockId of result.observedBlockIds ?? []) {
    state.seenBlockIds.add(blockId);
  }
  for (const folderId of result.observedFolderIds ?? []) {
    state.seenFolderIds.add(folderId);
  }
  for (const revisionId of result.observedRevisionIds ?? []) {
    state.seenRevisionIds.add(revisionId);
  }
  for (const pageId of result.createdPageIds ?? []) {
    state.createdPageIds.add(pageId);
    state.seenPageIds.add(pageId);
  }
  for (const folderId of result.createdFolderIds ?? []) {
    state.createdFolderIds.add(folderId);
    state.seenFolderIds.add(folderId);
  }
  for (const pageId of result.mutatedPageIds ?? []) {
    state.mutatedPageIds.add(pageId);
  }
}

function toExecutionError(err: unknown): AgentToolErrorPayload {
  if (err instanceof AgentToolError) {
    return {
      code: err.code,
      message: err.message,
      recoverable: true,
      details: err.details,
      selfCorrection: err.selfCorrection,
    };
  }

  return {
    code: "execution_failed",
    message: err instanceof Error ? err.message : String(err),
    recoverable: true,
  };
}

export function createAgentDispatcher(
  input: CreateAgentDispatcherInput,
): AgentDispatcher {
  const state = input.state ?? createAgentRunState();
  const tools: Record<string, AgentToolDefinition> =
    input.tools ?? createReadOnlyTools();
  const maxCallsPerTurn =
    input.options?.maxCallsPerTurn ?? AGENT_LIMITS.MAX_CALLS_PER_TURN;
  const quotas = {
    ...DEFAULT_READ_TOOL_QUOTAS,
    ...input.options?.perToolQuota,
  };
  const usedCounts = new Map<string, number>();
  const cache = new Map<string, AgentToolExecution>();

  const ctx: AgentToolContext = {
    db: input.db,
    workspaceId: input.workspaceId,
    state,
    env: input.env,
    model: input.model,
  };

  return {
    state,
    invalidateCacheForToolCall(toolCall: NormalizedToolCall): void {
      const tool = tools[toolCall.name];
      if (!tool) return;
      const parsed = tool.schema.safeParse(toolCall.arguments);
      if (!parsed.success) return;
      cache.delete(`${toolCall.name}:${stableJson(parsed.data)}`);
    },
    async dispatchToolCalls(
      toolCalls: NormalizedToolCall[],
    ): Promise<AgentToolExecution[]> {
      const executions: AgentToolExecution[] = [];

      for (const [index, toolCall] of toolCalls.entries()) {
        if (index >= maxCallsPerTurn) {
          executions.push(
            errorExecution(toolCall, {
              code: "turn_limit_exceeded",
              message: `Tool call turn limit exceeded (${maxCallsPerTurn})`,
              recoverable: true,
            }),
          );
          continue;
        }

        const tool = tools[toolCall.name];
        if (!tool) {
          executions.push(
            errorExecution(toolCall, {
              code: "unknown_tool",
              message: `Unknown tool: ${toolCall.name}`,
              recoverable: true,
            }),
          );
          continue;
        }

        const parsed = tool.schema.safeParse(toolCall.arguments);
        if (!parsed.success) {
          executions.push(
            errorExecution(toolCall, {
              code: "validation_failed",
              message: `Invalid arguments for ${toolCall.name}`,
              recoverable: true,
              details: parsed.error.issues,
            }),
          );
          continue;
        }

        const cacheKey = `${toolCall.name}:${stableJson(parsed.data)}`;
        const cached = cache.get(cacheKey);
        if (cached?.ok) {
          executions.push(successExecution(toolCall, cached.result, true));
          continue;
        }

        const used = usedCounts.get(toolCall.name) ?? 0;
        const quota = quotas[toolCall.name] ?? Number.POSITIVE_INFINITY;
        if (used >= quota) {
          executions.push(
            errorExecution(toolCall, {
              code: "quota_exceeded",
              message: `${toolCall.name} quota exceeded (${quota})`,
              recoverable: true,
            }),
          );
          continue;
        }

        usedCounts.set(toolCall.name, used + 1);

        try {
          const result = await tool.execute(ctx, parsed.data);
          observeResult(state, result);
          const execution = successExecution(toolCall, result.data, false);
          cache.set(cacheKey, execution);
          executions.push(execution);
        } catch (err) {
          executions.push(errorExecution(toolCall, toExecutionError(err)));
        }
      }

      return executions;
    },
  };
}
