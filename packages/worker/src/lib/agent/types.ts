import type { NormalizedToolCall } from "@wekiflow/shared";
import type { getDb } from "@wekiflow/db/client";

export type AgentDb = ReturnType<typeof getDb>;

export interface AgentRunState {
  seenPageIds: Set<string>;
  seenBlockIds: Set<string>;
}

export interface AgentToolContext {
  db: AgentDb;
  workspaceId: string;
  state: AgentRunState;
}

export interface AgentToolResult<T = unknown> {
  data: T;
  observedPageIds?: string[];
  observedBlockIds?: string[];
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
    | "execution_failed";
  message: string;
  recoverable: boolean;
  details?: unknown;
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
  dispatchToolCalls(
    toolCalls: NormalizedToolCall[],
  ): Promise<AgentToolExecution[]>;
}

export class AgentToolError extends Error {
  constructor(
    public readonly code: AgentToolErrorPayload["code"],
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AgentToolError";
  }
}

export function createAgentRunState(): AgentRunState {
  return {
    seenPageIds: new Set<string>(),
    seenBlockIds: new Set<string>(),
  };
}
