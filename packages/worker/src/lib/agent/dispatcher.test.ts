import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentReadToolInputSchemas,
  type NormalizedToolCall,
} from "@wekiflow/shared";
import { createAgentDispatcher } from "./dispatcher.js";
import type { AgentDb, AgentToolDefinition } from "./types.js";

const fakeDb = {} as AgentDb;

function call(
  id: string,
  name: string,
  args: Record<string, unknown>,
): NormalizedToolCall {
  return { id, name, arguments: args };
}

describe("createAgentDispatcher", () => {
  it("closes over workspaceId, strips LLM workspaceId, and tracks observations", async () => {
    let calls = 0;
    const tools: Record<string, AgentToolDefinition> = {
      search_pages: {
        name: "search_pages",
        description: "test",
        schema: agentReadToolInputSchemas.search_pages,
        async execute(ctx, input) {
          calls += 1;
          assert.equal(ctx.workspaceId, "workspace-real");
          assert.deepEqual(input, { query: "alpha", limit: 10 });
          return {
            data: { input },
            observedPageIds: ["page-1"],
            observedBlockIds: ["block-1"],
          };
        },
      },
    };

    const dispatcher = createAgentDispatcher({
      db: fakeDb,
      workspaceId: "workspace-real",
      tools,
    });

    const [result] = await dispatcher.dispatchToolCalls([
      call("call-1", "search_pages", {
        query: "alpha",
        workspaceId: "workspace-evil",
      }),
    ]);

    assert.equal(calls, 1);
    assert.equal(result.ok, true);
    assert.equal(dispatcher.state.seenPageIds.has("page-1"), true);
    assert.equal(dispatcher.state.seenBlockIds.has("block-1"), true);
  });

  it("dedupes parsed args before quota accounting", async () => {
    let calls = 0;
    const tools: Record<string, AgentToolDefinition> = {
      search_pages: {
        name: "search_pages",
        description: "test",
        schema: agentReadToolInputSchemas.search_pages,
        async execute() {
          calls += 1;
          return { data: { calls } };
        },
      },
    };

    const dispatcher = createAgentDispatcher({
      db: fakeDb,
      workspaceId: "workspace-real",
      tools,
      options: { perToolQuota: { search_pages: 1 } },
    });

    const results = await dispatcher.dispatchToolCalls([
      call("call-1", "search_pages", { query: "alpha" }),
      call("call-2", "search_pages", { workspaceId: "ignored", query: "alpha" }),
      call("call-3", "search_pages", { query: "beta" }),
    ]);

    assert.equal(calls, 1);
    assert.deepEqual(
      results.map((result) => [result.ok, result.deduped]),
      [
        [true, false],
        [true, true],
        [false, false],
      ],
    );
    assert.equal(results[2].ok, false);
    if (!results[2].ok) {
      assert.equal(results[2].error.code, "quota_exceeded");
    }
  });

  it("returns recoverable errors for turn limits, unknown tools, and validation", async () => {
    const tools: Record<string, AgentToolDefinition> = {
      search_pages: {
        name: "search_pages",
        description: "test",
        schema: agentReadToolInputSchemas.search_pages,
        async execute() {
          return { data: { ok: true } };
        },
      },
    };

    const dispatcher = createAgentDispatcher({
      db: fakeDb,
      workspaceId: "workspace-real",
      tools,
      options: { maxCallsPerTurn: 2 },
    });

    const results = await dispatcher.dispatchToolCalls([
      call("call-1", "missing_tool", {}),
      call("call-2", "search_pages", {}),
      call("call-3", "search_pages", { query: "alpha" }),
    ]);

    assert.equal(results[0].ok, false);
    assert.equal(results[1].ok, false);
    assert.equal(results[2].ok, false);
    if (!results[0].ok) assert.equal(results[0].error.code, "unknown_tool");
    if (!results[1].ok) {
      assert.equal(results[1].error.code, "validation_failed");
    }
    if (!results[2].ok) {
      assert.equal(results[2].error.code, "turn_limit_exceeded");
    }
  });
});
