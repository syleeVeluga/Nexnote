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
const pageId2 = "22222222-2222-4222-8222-222222222222";

function appendMutation(index: number) {
  return {
    action: "append",
    targetPageId: pageId,
    confidence: 0.9,
    reason: `Append note ${index}.`,
    tool: "append_to_page",
    args: {
      pageId,
      contentMd: `Note ${index}.`,
      confidence: 0.9,
      reason: `Append note ${index}.`,
    },
    evidence: [],
  };
}

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

  it("continues with replan turns when a plan exceeds the per-turn mutation cap", async () => {
    const calls: unknown[] = [];
    const mutateTools: Record<string, AgentToolDefinition> = {
      append_to_page: {
        name: "append_to_page",
        description: "test append",
        schema: agentMutateToolInputSchemas.append_to_page,
        async execute(_ctx, input) {
          calls.push(input);
          return {
            data: {
              decisionId: `decision-${calls.length}`,
              status: "auto_applied",
            },
            mutatedPageIds: [pageId],
          };
        },
      },
    };
    const adapter = new SequenceAdapter([
      response({ content: "No tools needed." }),
      response({
        content: JSON.stringify({
          summary: "Append many notes.",
          proposedPlan: Array.from({ length: 30 }, (_, index) =>
            appendMutation(index),
          ),
          openQuestions: [],
        }),
      }),
      response({
        content: JSON.stringify({
          summary: "Append remaining notes.",
          proposedPlan: Array.from({ length: 10 }, (_, index) =>
            appendMutation(index + 20),
          ),
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
        titleHint: "Bulk",
        normalizedText: "Bulk notes.",
        rawPayload: {},
      },
      mode: "agent",
      agentRunId: "33333333-3333-4333-8333-333333333333",
      adapter,
      baseProvider: "openai",
      baseModel: "gpt-5.4",
      tools: {},
      mutateTools,
      recordModelRun: async () => {
        modelRun += 1;
        return { id: `44444444-4444-4444-8444-44444444444${modelRun}` };
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.decisionsCount, 30);
    assert.equal(calls.length, 30);
    assert.equal(result.planJson.turns?.length, 2);
    assert.equal(result.planJson.turns?.[0]?.plan.proposedPlan.length, 20);
    assert.equal(result.planJson.turns?.[0]?.skippedPlan?.length, 10);
    assert.deepEqual(result.planJson.turns?.[0]?.mutatedPageIds, [pageId]);
    assert.deepEqual(result.planJson.turns?.[1]?.mutatedPageIds, [pageId]);
    assert.ok(result.steps.some((step) => step.type === "replan"));
    const replanPrompt = adapter.requests[2]?.messages[1]?.content ?? "";
    assert.match(replanPrompt, /"attempted": 20/);
    assert.match(replanPrompt, /"attemptedActions"/);
    assert.match(replanPrompt, /"unattemptedActions"/);
    assert.match(replanPrompt, /"index": 20/);
  });

  it("passes per-mutation outcomes into replans and preserves executed plan history", async () => {
    const mutateTools: Record<string, AgentToolDefinition> = {
      append_to_page: {
        name: "append_to_page",
        description: "test append",
        schema: agentMutateToolInputSchemas.append_to_page,
        async execute(_ctx, input) {
          const parsed = input as { contentMd: string };
          if (parsed.contentMd === "fail") {
            throw new AgentToolError(
              "patch_mismatch",
              "append content did not match the current page",
            );
          }
          return {
            data: {
              decisionId: "decision-success",
              status: "auto_applied",
            },
            mutatedPageIds: [pageId],
          };
        },
      },
    };
    const failedMutation = {
      ...appendMutation(1),
      args: {
        pageId,
        contentMd: "fail",
        confidence: 0.9,
        reason: "Append note 1.",
      },
    };
    const adapter = new SequenceAdapter([
      response({ content: "No tools needed." }),
      response({
        content: JSON.stringify({
          summary: "Append two notes.",
          proposedPlan: [appendMutation(0), failedMutation],
          openQuestions: [],
        }),
      }),
      response({
        content: JSON.stringify({
          summary: "No safe remaining changes.",
          proposedPlan: [],
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
        titleHint: "Mixed",
        normalizedText: "Mixed notes.",
        rawPayload: {},
      },
      mode: "agent",
      agentRunId: "33333333-3333-4333-8333-333333333333",
      adapter,
      baseProvider: "openai",
      baseModel: "gpt-5.4",
      tools: {},
      mutateTools,
      recordModelRun: async () => {
        modelRun += 1;
        return { id: `44444444-4444-4444-8444-44444444444${modelRun}` };
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.planJson.proposedPlan.length, 2);
    assert.equal(result.planJson.turns?.[0]?.outcomes?.length, 2);
    assert.equal(result.planJson.turns?.[0]?.outcomes?.[0]?.ok, true);
    assert.equal(result.planJson.turns?.[0]?.outcomes?.[1]?.ok, false);
    assert.equal(
      result.planJson.turns?.[0]?.outcomes?.[1]?.error?.code,
      "patch_mismatch",
    );
    const replanPrompt = adapter.requests[2]?.messages[1]?.content ?? "";
    assert.match(replanPrompt, /"outcomes"/);
    assert.match(replanPrompt, /"ok": false/);
    assert.match(replanPrompt, /"patch_mismatch"/);
  });

  it("returns partial when max turns are reached with remaining mutations", async () => {
    const calls: unknown[] = [];
    const mutateTools: Record<string, AgentToolDefinition> = {
      append_to_page: {
        name: "append_to_page",
        description: "test append",
        schema: agentMutateToolInputSchemas.append_to_page,
        async execute(_ctx, input) {
          calls.push(input);
          return {
            data: {
              decisionId: `decision-${calls.length}`,
              status: "auto_applied",
            },
            mutatedPageIds: [pageId],
          };
        },
      },
    };
    const adapter = new SequenceAdapter([
      response({ content: "No tools needed." }),
      response({
        content: JSON.stringify({
          summary: "Append more than one turn allows.",
          proposedPlan: Array.from({ length: 25 }, (_, index) =>
            appendMutation(index),
          ),
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
        titleHint: "Bulk",
        normalizedText: "Bulk notes.",
        rawPayload: {},
      },
      mode: "agent",
      agentRunId: "33333333-3333-4333-8333-333333333333",
      adapter,
      baseProvider: "openai",
      baseModel: "gpt-5.4",
      tools: {},
      mutateTools,
      env: { ...process.env, AGENT_MAX_TURNS: "1" },
      recordModelRun: async () => {
        modelRun += 1;
        return { id: `44444444-4444-4444-8444-44444444444${modelRun}` };
      },
    });

    assert.equal(result.status, "partial");
    assert.equal(result.decisionsCount, 20);
    assert.equal(calls.length, 20);
    assert.ok(
      result.steps.some(
        (step) =>
          step.type === "turn_aborted" &&
          step.payload["reason"] === "max_turns_reached",
      ),
    );
  });

  it("returns partial before a replan turn when the workspace pause hook fires after mutations", async () => {
    const calls: unknown[] = [];
    const mutateTools: Record<string, AgentToolDefinition> = {
      append_to_page: {
        name: "append_to_page",
        description: "test append",
        schema: agentMutateToolInputSchemas.append_to_page,
        async execute(_ctx, input) {
          calls.push(input);
          return {
            data: {
              decisionId: `decision-${calls.length}`,
              status: "auto_applied",
            },
            mutatedPageIds: [pageId],
          };
        },
      },
    };
    const adapter = new SequenceAdapter([
      response({ content: "No tools needed." }),
      response({
        content: JSON.stringify({
          summary: "Append two notes.",
          proposedPlan: [appendMutation(0), appendMutation(1)],
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
        titleHint: "Pause",
        normalizedText: "Bulk notes.",
        rawPayload: {},
      },
      mode: "agent",
      agentRunId: "33333333-3333-4333-8333-333333333333",
      adapter,
      baseProvider: "openai",
      baseModel: "gpt-5.4",
      tools: {},
      mutateTools,
      env: { ...process.env, AGENT_MAX_MUTATIONS_PER_TURN: "1" },
      checkAbortBeforeTurn: async ({ turnIndex, totalMutationsApplied }) =>
        turnIndex > 0
          ? {
              status: totalMutationsApplied > 0 ? "partial" : "aborted",
              reason: "workspace_autonomy_paused",
              details: { pausedUntil: "2026-05-05T00:00:00.000Z" },
            }
          : null,
      recordModelRun: async () => {
        modelRun += 1;
        return { id: `44444444-4444-4444-8444-44444444444${modelRun}` };
      },
    });

    assert.equal(result.status, "partial");
    assert.equal(result.decisionsCount, 1);
    assert.equal(calls.length, 1);
    assert.equal(adapter.requests.length, 2);
    assert.ok(
      result.steps.some(
        (step) =>
          step.type === "turn_aborted" &&
          step.payload["reason"] === "workspace_autonomy_paused",
      ),
    );
  });

  it("keeps free-form human review guidance out of suggestedAction", async () => {
    const calls: unknown[] = [];
    const mutateTools: Record<string, AgentToolDefinition> = {
      request_human_review: {
        name: "request_human_review",
        description: "test review",
        schema: agentMutateToolInputSchemas.request_human_review,
        async execute(_ctx, input) {
          calls.push(input);
          return {
            data: {
              decisionId: "22222222-2222-4222-8222-222222222222",
              status: "needs_review",
            },
          };
        },
      },
    };
    const adapter = new SequenceAdapter([
      response({ content: "No tools needed." }),
      response({
        content: JSON.stringify({
          summary: "Human review is needed.",
          proposedPlan: [
            {
              action: "needs_review",
              targetPageId: pageId,
              confidence: 0.4,
              reason: "Multiple pages may need consolidation.",
              tool: "request_human_review",
              args: {
                reason: "Multiple pages may need consolidation.",
                suggestedAction:
                  "Pick a canonical page, update it, and archive duplicates.",
                suggestedPageIds: [pageId],
                confidence: 0.4,
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
        titleHint: "HR answers",
        normalizedText: "HR note.",
        rawPayload: {},
      },
      mode: "agent",
      agentRunId: "33333333-3333-4333-8333-333333333333",
      adapter,
      baseProvider: "openai",
      baseModel: "gpt-5.4",
      tools: {},
      mutateTools,
      recordModelRun: async () => {
        modelRun += 1;
        return { id: `44444444-4444-4444-8444-44444444444${modelRun}` };
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.decisionsCount, 1);
    assert.deepEqual(calls, [
      {
        reason:
          "Multiple pages may need consolidation.\n\nSuggested action note: Pick a canonical page, update it, and archive duplicates.",
        suggestedPageIds: [pageId],
        confidence: 0.4,
      },
    ]);
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
    assert.match(
      adapter.requests[0].messages[0].content,
      /Scheduled user-directed wiki edit mode/,
    );
    assert.match(
      adapter.requests[0].messages[0].content,
      /Remove duplicate sections/,
    );
    assert.match(
      adapter.requests[0].messages[0].content,
      /Treat the user instruction as the primary task/,
    );
  });

  it("prefetches selected scheduled pages before planning", async () => {
    const readCalls: string[] = [];
    const tools: Record<string, AgentToolDefinition> = {
      read_page: {
        name: "read_page",
        description: "test read page",
        schema: agentReadToolInputSchemas.read_page,
        async execute(_ctx, input) {
          const parsed = input as { pageId: string; format?: string };
          readCalls.push(parsed.pageId);
          return {
            data: {
              page: { id: parsed.pageId, title: `Page ${readCalls.length}` },
              format: parsed.format ?? "markdown",
              contentMd: `# Page ${readCalls.length}\n\nFull body ${parsed.pageId}.`,
            },
            observedPageRevisions: [
              {
                pageId: parsed.pageId,
                revisionId: `revision-${readCalls.length}`,
              },
            ],
          };
        },
      },
    };
    const adapter = new SequenceAdapter([
      response({ content: "I have enough scheduled context." }),
      response({
        content: JSON.stringify({
          summary: "Create a consolidated page from the selected pages.",
          proposedPlan: [
            {
              action: "noop",
              targetPageId: null,
              confidence: 1,
              reason: "Test stops after planning.",
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
      origin: "scheduled",
      seedPageIds: [pageId, pageId2],
      instruction: "Create a new page containing all selected page contents.",
      ingestion: {
        id: "ingestion-1",
        sourceName: "scheduled-agent",
        contentType: "text/markdown",
        titleHint: "Scheduled wiki reorganize",
        normalizedText: `Selected page IDs: ${pageId}, ${pageId2}`,
        rawPayload: {},
      },
      adapter,
      baseProvider: "openai",
      baseModel: "gpt-5.4",
      tools,
    });

    assert.deepEqual(readCalls, [pageId, pageId2]);
    const planPrompt = adapter.requests[1]?.messages[1]?.content ?? "";
    assert.match(planPrompt, /Full body 11111111-1111-4111-8111-111111111111/);
    assert.match(planPrompt, /Full body 22222222-2222-4222-8222-222222222222/);
    assert.match(
      adapter.requests[1]?.messages[0].content ?? "",
      /drafting new docs/,
    );
    assert.match(
      adapter.requests[1]?.messages[0].content ?? "",
      /Preserve selected source pages/,
    );
  });

  it("uses the large-context plan model for explicit scheduled source-copy page creation", async () => {
    const seedPageIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ];
    const readModels: Array<string | undefined> = [];
    const tools: Record<string, AgentToolDefinition> = {
      read_page: {
        name: "read_page",
        description: "test read page",
        schema: agentReadToolInputSchemas.read_page,
        async execute(ctx, input) {
          readModels.push(ctx.model?.model);
          const parsed = input as { pageId: string; format?: string };
          return {
            data: {
              page: { id: parsed.pageId, title: `Page ${parsed.pageId}` },
              format: parsed.format ?? "markdown",
              contentMd: `# Page ${parsed.pageId}\n\nFull body.`,
            },
          };
        },
      },
    };
    const adapter = new SequenceAdapter([
      response({ content: "I have enough scheduled context." }),
      response({
        content: JSON.stringify({
          summary: "Create a copied source page.",
          proposedPlan: [
            {
              action: "noop",
              targetPageId: null,
              confidence: 1,
              reason: "Test stops after planning.",
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
      origin: "scheduled",
      seedPageIds,
      instruction:
        "Create a new page named Veluga Info and copy all selected page contents into it.",
      ingestion: {
        id: "ingestion-1",
        sourceName: "scheduled-agent",
        contentType: "text/markdown",
        titleHint: "Scheduled source copy",
        normalizedText: `Selected page IDs: ${seedPageIds.join(", ")}`,
        rawPayload: {},
      },
      adapter,
      baseProvider: "openai",
      baseModel: "gpt-5.4",
      env: {
        ...process.env,
        AGENT_MODEL_FAST: "gpt-5.4-mini",
        AGENT_MODEL_LARGE_CONTEXT: "gpt-5.4",
        AGENT_FAST_THRESHOLD_TOKENS: "500000",
      },
      tools,
    });

    assert.equal(adapter.requests[0]?.model, "gpt-5.4-mini");
    assert.equal(adapter.requests[1]?.model, "gpt-5.4");
    assert.deepEqual(
      readModels,
      seedPageIds.map(() => "gpt-5.4"),
    );
    assert.match(
      adapter.requests[1]?.messages[0].content ?? "",
      /explicit create_page \+ source-copy request/,
    );
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
