import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  agentMutateToolInputSchemas,
  agentReadToolInputSchemas,
  MODE_OUTPUT_RESERVE,
  type AIAdapter,
  type AIRequest,
  type AIResponse,
} from "@wekiflow/shared";
import {
  AgentWorkspaceTokenCapExceeded,
  runIngestionAgentShadow,
} from "./loop.js";
import {
  AgentToolError,
  type AgentDb,
  type AgentToolDefinition,
} from "./types.js";

const fakeDb = {} as AgentDb;
const pageId = "11111111-1111-4111-8111-111111111111";

class SequenceAdapter implements AIAdapter {
  readonly provider = "openai" as const;
  readonly requests: AIRequest[] = [];

  constructor(private readonly responses: AIResponse[]) {}

  async chat(request: AIRequest): Promise<AIResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("No fake AI response queued");
    return response;
  }
}

function response(overrides: Partial<AIResponse>): AIResponse {
  return {
    content: "",
    tokenInput: 10,
    tokenOutput: 5,
    latencyMs: 1,
    finishReason: "stop",
    ...overrides,
  };
}

describe("runIngestionAgentShadow", () => {
  it("runs read-tool exploration, records model calls, and returns a shadow plan", async () => {
    let toolCalls = 0;
    const tools: Record<string, AgentToolDefinition> = {
      search_pages: {
        name: "search_pages",
        description: "test search",
        schema: agentReadToolInputSchemas.search_pages,
        async execute(_ctx, input) {
          const parsedInput = input as { query: string };
          toolCalls += 1;
          assert.equal(parsedInput.query, "redis");
          return {
            data: {
              pages: [
                {
                  id: pageId,
                  title: "Redis",
                  excerpt: "Redis cache notes",
                },
              ],
            },
            observedPageIds: [pageId],
          };
        },
      },
    };
    const adapter = new SequenceAdapter([
      response({
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call_0_search_pages",
            name: "search_pages",
            arguments: { query: "redis" },
          },
        ],
      }),
      response({ content: "I have enough context." }),
      response({
        content: JSON.stringify({
          summary: "Update the existing Redis page.",
          proposedPlan: [
            {
              action: "update",
              targetPageId: pageId,
              confidence: 0.86,
              reason: "The ingestion overlaps with the existing Redis page.",
              evidence: [{ pageId, note: "search result matched Redis" }],
            },
          ],
          openQuestions: [],
        }),
      }),
    ]);
    const recorded: AIRequest[] = [];

    const result = await runIngestionAgentShadow({
      db: fakeDb,
      workspaceId: "workspace-1",
      ingestion: {
        id: "ingestion-1",
        sourceName: "test",
        contentType: "text/markdown",
        titleHint: "Redis update",
        normalizedText: "Redis cache changed.",
        rawPayload: {},
      },
      adapter,
      baseProvider: "openai",
      baseModel: "gpt-5.4",
      tools,
      recordModelRun: async (record) => {
        recorded.push(record.request);
      },
    });

    assert.equal(toolCalls, 1);
    assert.equal(result.status, "shadow");
    assert.equal(result.planJson.proposedPlan[0].action, "update");
    assert.equal(result.decisionsCount, 1);
    assert.equal(recorded.length, 3);
    assert.equal(adapter.requests[0].maxTokens, 4_096);
    assert.equal(adapter.requests[1].maxTokens, 4_096);
    assert.equal(adapter.requests[2].maxTokens, MODE_OUTPUT_RESERVE.agent_plan);
    assert.ok(
      adapter.requests[0].tools?.some((tool) => tool.name === "search_pages"),
    );
    assert.equal(
      adapter.requests[0].budgetMeta?.strategy,
      "agent_explore_context_packing",
    );
    assert.equal(adapter.requests[2].tools, undefined);
    assert.ok(result.steps.some((step) => step.type === "tool_result"));
    assert.ok(
      result.steps.some((step) => step.type === "shadow_execute_skipped"),
    );
  });

  it("executes typed mutate plans in agent mode", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const tools: Record<string, AgentToolDefinition> = {
      search_pages: {
        name: "search_pages",
        description: "test search",
        schema: agentReadToolInputSchemas.search_pages,
        async execute() {
          return {
            data: { pages: [{ id: pageId, title: "Redis" }] },
            observedPageIds: [pageId],
          };
        },
      },
    };
    const mutateTools: Record<string, AgentToolDefinition> = {
      append_to_page: {
        name: "append_to_page",
        description: "test append",
        schema: agentMutateToolInputSchemas.append_to_page,
        async execute(_ctx, input) {
          calls.push({ name: "append_to_page", input });
          return {
            data: {
              decisionId: "22222222-2222-4222-8222-222222222222",
              status: "auto_applied",
            },
            mutatedPageIds: [pageId],
          };
        },
      },
    };
    const adapter = new SequenceAdapter([
      response({
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call_0_search_pages",
            name: "search_pages",
            arguments: { query: "redis" },
          },
        ],
      }),
      response({ content: "I have enough context." }),
      response({
        content: JSON.stringify({
          summary: "Append to the existing Redis page.",
          proposedPlan: [
            {
              action: "append",
              targetPageId: pageId,
              confidence: 0.9,
              reason: "The ingestion adds a new Redis note.",
              tool: "append_to_page",
              args: {
                pageId,
                contentMd: "New Redis note.",
                confidence: 0.9,
                reason: "The ingestion adds a new Redis note.",
              },
              evidence: [{ pageId, note: "search result matched Redis" }],
            },
          ],
          openQuestions: [],
        }),
      }),
    ]);
    let modelRun = 0;

    const result = await runIngestionAgentShadow({
      db: fakeDb,
      workspaceId: "workspace-1",
      ingestion: {
        id: "ingestion-1",
        sourceName: "test",
        contentType: "text/markdown",
        titleHint: "Redis update",
        normalizedText: "Redis cache changed.",
        rawPayload: {},
      },
      mode: "agent",
      agentRunId: "33333333-3333-4333-8333-333333333333",
      adapter,
      baseProvider: "openai",
      baseModel: "gpt-5.4",
      tools,
      mutateTools,
      recordModelRun: async () => {
        modelRun += 1;
        return { id: `44444444-4444-4444-8444-44444444444${modelRun}` };
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.decisionsCount, 1);
    assert.equal(result.planJson.shadow, false);
    assert.deepEqual(calls, [
      {
        name: "append_to_page",
        input: {
          pageId,
          contentMd: "New Redis note.",
          confidence: 0.9,
          reason: "The ingestion adds a new Redis note.",
        },
      },
    ]);
    assert.ok(result.steps.some((step) => step.type === "mutation_result"));
  });

  it("runs one mutation repair turn when a mutate tool returns self-correction hints", async () => {
    let appendCalls = 0;
    const tools: Record<string, AgentToolDefinition> = {
      search_pages: {
        name: "search_pages",
        description: "test search",
        schema: agentReadToolInputSchemas.search_pages,
        async execute() {
          return {
            data: { pages: [{ id: pageId, title: "Redis" }] },
            observedPageIds: [pageId],
          };
        },
      },
    };
    const mutateTools: Record<string, AgentToolDefinition> = {
      append_to_page: {
        name: "append_to_page",
        description: "test append",
        schema: agentMutateToolInputSchemas.append_to_page,
        async execute(_ctx, input) {
          appendCalls += 1;
          const parsed = input as { contentMd: string };
          if (parsed.contentMd === "bad") {
            throw new AgentToolError(
              "patch_mismatch",
              "append content was too broad",
              { contentMd: "bad" },
              {
                hint: "Use the narrower Redis note.",
                candidates: ["New Redis note."],
              },
            );
          }
          return {
            data: {
              decisionId: "22222222-2222-4222-8222-222222222222",
              status: "auto_applied",
            },
            mutatedPageIds: [pageId],
          };
        },
      },
    };
    const adapter = new SequenceAdapter([
      response({
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call_0_search_pages",
            name: "search_pages",
            arguments: { query: "redis" },
          },
        ],
      }),
      response({ content: "I have enough context." }),
      response({
        content: JSON.stringify({
          summary: "Append to the existing Redis page.",
          proposedPlan: [
            {
              action: "append",
              targetPageId: pageId,
              confidence: 0.9,
              reason: "The ingestion adds a new Redis note.",
              tool: "append_to_page",
              args: {
                pageId,
                contentMd: "bad",
                confidence: 0.9,
                reason: "The ingestion adds a new Redis note.",
              },
              evidence: [],
            },
          ],
          openQuestions: [],
        }),
      }),
      response({
        content: JSON.stringify({
          summary: "Repair append content.",
          proposedPlan: [
            {
              action: "append",
              targetPageId: pageId,
              confidence: 0.88,
              reason: "Use the narrower candidate from the tool hint.",
              tool: "append_to_page",
              args: {
                pageId,
                contentMd: "New Redis note.",
                confidence: 0.88,
                reason: "Use the narrower candidate from the tool hint.",
              },
              evidence: [],
            },
          ],
          openQuestions: [],
        }),
      }),
    ]);
    let modelRun = 0;

    const result = await runIngestionAgentShadow({
      db: fakeDb,
      workspaceId: "workspace-1",
      ingestion: {
        id: "ingestion-1",
        sourceName: "test",
        contentType: "text/markdown",
        titleHint: "Redis update",
        normalizedText: "Redis cache changed.",
        rawPayload: {},
      },
      mode: "agent",
      agentRunId: "33333333-3333-4333-8333-333333333333",
      adapter,
      baseProvider: "openai",
      baseModel: "gpt-5.4",
      tools,
      mutateTools,
      recordModelRun: async () => {
        modelRun += 1;
        return { id: `44444444-4444-4444-8444-44444444444${modelRun}` };
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.decisionsCount, 1);
    assert.equal(appendCalls, 2);
    assert.ok(
      result.steps.some(
        (step) =>
          step.type === "plan" && step.payload["phase"] === "mutation_repair",
      ),
    );
    assert.ok(
      result.steps.some(
        (step) =>
          step.type === "mutation_result" &&
          step.payload["repairAttempt"] === true,
      ),
    );
  });

  it("prepends workspace agent instructions to explore and plan prompts", async () => {
    const adapter = new SequenceAdapter([
      response({ content: "No tools needed." }),
      response({
        content: JSON.stringify({
          summary: "No change.",
          proposedPlan: [
            {
              action: "noop",
              targetPageId: null,
              confidence: 1,
              reason: "The ingestion is already represented.",
              evidence: [],
            },
          ],
          openQuestions: [],
        }),
      }),
    ]);

    await runIngestionAgentShadow({
      db: fakeDb,
      workspaceId: "workspace-1",
      ingestion: {
        id: "ingestion-1",
        sourceName: "test",
        contentType: "text/markdown",
        titleHint: "Incident",
        normalizedText: "Incident note.",
        rawPayload: {},
      },
      adapter,
      baseProvider: "openai",
      baseModel: "gpt-5.4",
      tools: {},
      workspaceAgentInstructions:
        "Slack #incidents sources update existing incident pages; never create.",
    });

    assert.match(
      adapter.requests[0].messages[0].content,
      /Slack #incidents sources update existing incident pages/,
    );
    assert.match(
      adapter.requests[1].messages[0].content,
      /Workspace operator instructions/,
    );
  });

  it("prepends scheduled instructions and seeds selected pages in execute mode", async () => {
    let sawSeedPage = false;
    const adapter = new SequenceAdapter([
      response({ content: "I have enough scheduled context." }),
      response({
        content: JSON.stringify({
          summary: "Clean up the selected page.",
          proposedPlan: [
            {
              action: "update",
              targetPageId: pageId,
              confidence: 0.95,
              reason: "Selected page needs cleanup.",
              tool: "update_page",
              args: {
                pageId,
                newContentMd: "# Redis\n\nCleaned up.",
                confidence: 0.95,
                reason: "Selected page needs cleanup.",
              },
              evidence: [],
            },
          ],
          openQuestions: [],
        }),
      }),
    ]);

    const result = await runIngestionAgentShadow({
      db: fakeDb,
      workspaceId: "workspace-1",
      origin: "scheduled",
      mode: "agent",
      agentRunId: "agent-run-1",
      seedPageIds: [pageId],
      instruction: "Remove duplicate sections.",
      scheduledRunId: "scheduled-run-1",
      scheduledAutoApply: false,
      ingestion: {
        id: "ingestion-1",
        sourceName: "scheduled-agent",
        contentType: "text/markdown",
        titleHint: "Scheduled wiki reorganize",
        normalizedText: "Selected page IDs: " + pageId,
        rawPayload: {},
      },
      adapter,
      baseProvider: "openai",
      baseModel: "gpt-5.4",
      mutateTools: {
        update_page: {
          name: "update_page",
          description: "test update",
          schema: agentMutateToolInputSchemas.update_page,
          async execute(ctx) {
            sawSeedPage = ctx.state.seenPageIds.has(pageId);
            return {
              data: { decisionId: "decision-1", status: "suggested" },
              mutatedPageIds: [pageId],
            };
          },
        },
      } as Record<string, AgentToolDefinition>,
      recordModelRun: async () => ({ id: "model-run-1" }),
    });

    assert.equal(result.status, "completed");
    assert.equal(result.decisionsCount, 1);
    assert.equal(sawSeedPage, true);
    assert.match(adapter.requests[0].messages[0].content, /Scheduled reorganize mode/);
    assert.match(adapter.requests[0].messages[0].content, /Remove duplicate sections/);
  });

  it("stops before model calls when the workspace daily token cap is exhausted", async () => {
    const adapter = new SequenceAdapter([]);

    await assert.rejects(
      () =>
        runIngestionAgentShadow({
          db: fakeDb,
          workspaceId: "workspace-1",
          ingestion: {
            id: "ingestion-1",
            sourceName: "test",
            contentType: "text/markdown",
            titleHint: "Cap",
            normalizedText: "Token cap test.",
            rawPayload: {},
          },
          adapter,
          baseProvider: "openai",
          baseModel: "gpt-5.4",
          tools: {},
          workspaceTokenUsage: { usedToday: 100, cap: 100 },
        }),
      AgentWorkspaceTokenCapExceeded,
    );
    assert.equal(adapter.requests.length, 0);
  });

  it("reserves and releases workspace tokens around model calls", async () => {
    const adapter = new SequenceAdapter([
      response({ content: "No tools needed." }),
      response({
        content: JSON.stringify({
          summary: "No change.",
          proposedPlan: [
            {
              action: "noop",
              targetPageId: null,
              confidence: 1,
              reason: "The ingestion is already represented.",
              evidence: [],
            },
          ],
          openQuestions: [],
        }),
      }),
    ]);
    const reservations: Array<{
      phase: string;
      estimatedTokens: number;
      totalTokensInRun: number;
    }> = [];
    const releases: number[] = [];

    await runIngestionAgentShadow({
      db: fakeDb,
      workspaceId: "workspace-1",
      ingestion: {
        id: "ingestion-1",
        sourceName: "test",
        contentType: "text/markdown",
        titleHint: "Cap",
        normalizedText: "Token reservation test.",
        rawPayload: {},
      },
      adapter,
      baseProvider: "openai",
      baseModel: "gpt-5.4",
      tools: {},
      workspaceTokenUsage: { usedToday: 25, cap: 100_000 },
      reserveWorkspaceTokens: async (request) => {
        reservations.push({
          phase: request.phase,
          estimatedTokens: request.estimatedTokens,
          totalTokensInRun: request.totalTokensInRun,
        });
        return {
          reservedTokens: request.estimatedTokens,
          usedAfterReservation: request.usedToday + request.estimatedTokens,
          release: async (actualTokens) => {
            releases.push(actualTokens);
          },
        };
      },
    });

    assert.deepEqual(
      reservations.map((reservation) => reservation.phase),
      ["explore model call", "plan model call"],
    );
    assert.ok(
      reservations.every((reservation) => reservation.estimatedTokens > 0),
    );
    assert.deepEqual(releases, [15, 15]);
  });

  it("reports reservation details when the workspace token cap blocks a model call", async () => {
    const adapter = new SequenceAdapter([]);

    await assert.rejects(
      () =>
        runIngestionAgentShadow({
          db: fakeDb,
          workspaceId: "workspace-1",
          ingestion: {
            id: "ingestion-1",
            sourceName: "test",
            contentType: "text/markdown",
            titleHint: "Cap",
            normalizedText: "Token reservation cap test.",
            rawPayload: {},
          },
          adapter,
          baseProvider: "openai",
          baseModel: "gpt-5.4",
          tools: {},
          workspaceTokenUsage: { usedToday: 90, cap: 100 },
          reserveWorkspaceTokens: async () => null,
        }),
      (err: unknown) => {
        assert.ok(err instanceof AgentWorkspaceTokenCapExceeded);
        assert.equal(err.details.phase, "explore model call");
        assert.equal(err.details.remainingTokens, 10);
        assert.ok((err.details.estimatedTokens ?? 0) > 0);
        return true;
      },
    );
    assert.equal(adapter.requests.length, 0);
  });
});
