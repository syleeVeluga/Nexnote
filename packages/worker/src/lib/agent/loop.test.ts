import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  agentReadToolInputSchemas,
  type AIAdapter,
  type AIRequest,
  type AIResponse,
} from "@wekiflow/shared";
import { runIngestionAgentShadow } from "./loop.js";
import type { AgentDb, AgentToolDefinition } from "./types.js";

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

function response(
  overrides: Partial<AIResponse>,
): AIResponse {
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
    assert.ok(adapter.requests[0].tools?.some((tool) => tool.name === "search_pages"));
    assert.equal(adapter.requests[0].budgetMeta?.strategy, "agent_explore_context_packing");
    assert.equal(adapter.requests[2].tools, undefined);
    assert.ok(result.steps.some((step) => step.type === "tool_result"));
    assert.ok(
      result.steps.some((step) => step.type === "shadow_execute_skipped"),
    );
  });
});
