import type {
  AIProvider,
  AgentRunTraceStep as SharedAgentRunTraceStep,
  NormalizedToolCall,
} from "@wekiflow/shared";
import type { getDb } from "@wekiflow/db/client";

export type AgentDb = ReturnType<typeof getDb>;

export interface AgentRunState {
  seenPageIds: Set<string>;
  seenBlockIds: Set<string>;
  seenFolderIds: Set<string>;
  seenRevisionIds: Set<string>;
  observedPageRevisionIds: Map<string, string | null>;
  createdPageIds: Set<string>;
  createdFolderIds: Set<string>;
  mutatedPageIds: Set<string>;
  destructiveCount: number;
}

export interface AgentToolContext {
  db: AgentDb;
  workspaceId: string;
  state: AgentRunState;
  env?: NodeJS.ProcessEnv;
  model?: {
    provider: AIProvider;
    model: string;
  };
}

export interface AgentToolResult<T = unknown> {
  data: T;
  observedPageIds?: string[];
  observedPageRevisions?: Array<{
    pageId: string;
    revisionId: string | null;
  }>;
  observedBlockIds?: string[];
  observedFolderIds?: string[];
  observedRevisionIds?: string[];
  createdPageIds?: string[];
  createdFolderIds?: string[];
  mutatedPageIds?: string[];
}

export type AgentToolSchema<Input> = {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: Input }
    | { success: false; error: { issues: unknown[] } };
};

export interface AgentToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  schema: AgentToolSchema<Input>;
  execute(
    ctx: AgentToolContext,
    input: Input,
  ): Promise<AgentToolResult<Output>>;
}

export interface AgentToolErrorPayload {
  code:
    | "unknown_tool"
    | "validation_failed"
    | "quota_exceeded"
    | "turn_limit_exceeded"
    | "not_found"
    | "invalid_target_page"
    | "invalid_block_id"
    | "duplicate_mutation"
    | "patch_mismatch"
    | "ambiguous_match"
    | "conflict"
    | "destructive_limit_exceeded"
    | "execution_failed";
  message: string;
  recoverable: boolean;
  details?: unknown;
  selfCorrection?: {
    hint: string;
    candidates?: unknown;
  };
}

export type AgentToolExecution =
  | {
      toolCallId: string;
      name: string;
      ok: true;
      result: unknown;
      deduped: boolean;
    }
  | {
      toolCallId: string;
      name: string;
      ok: false;
      error: AgentToolErrorPayload;
      deduped: false;
    };

export interface AgentDispatcherOptions {
  maxCallsPerTurn?: number;
  perToolQuota?: Partial<Record<string, number>>;
}

export interface AgentDispatcher {
  readonly state: AgentRunState;
  invalidateCacheForToolCall(toolCall: NormalizedToolCall): void;
  invalidateReadCacheForPage(pageId: string): void;
  dispatchToolCalls(
    toolCalls: NormalizedToolCall[],
  ): Promise<AgentToolExecution[]>;
}

export type AgentRunTraceStep = SharedAgentRunTraceStep;

export class AgentToolError extends Error {
  constructor(
    public readonly code: AgentToolErrorPayload["code"],
    message: string,
    public readonly details?: unknown,
    public readonly selfCorrection?: AgentToolErrorPayload["selfCorrection"],
  ) {
    super(message);
    this.name = "AgentToolError";
  }
}

export function createAgentRunState(): AgentRunState {
  return {
    seenPageIds: new Set<string>(),
    seenBlockIds: new Set<string>(),
    seenFolderIds: new Set<string>(),
    seenRevisionIds: new Set<string>(),
    observedPageRevisionIds: new Map<string, string | null>(),
    createdPageIds: new Set<string>(),
    createdFolderIds: new Set<string>(),
    mutatedPageIds: new Set<string>(),
    destructiveCount: 0,
  };
}
