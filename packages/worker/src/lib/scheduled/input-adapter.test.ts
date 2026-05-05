import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildScheduledAgentInput } from "./input-adapter.js";
import type { AgentDb } from "../agent/types.js";

function fakeDb(): AgentDb {
  const pageRows = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Meeting Notes",
      slug: "meeting-notes",
      parentPageId: null,
      currentRevisionId: "22222222-2222-4222-8222-222222222222",
    },
  ];
  const chain = {
    from: () => chain,
    where: async () => pageRows,
  };
  return {
    select: () => chain,
  } as unknown as AgentDb;
}

describe("buildScheduledAgentInput", () => {
  it("frames scheduled runs as user-directed wiki edit requests", async () => {
    const result = await buildScheduledAgentInput(fakeDb(), "workspace-1", {
      pageIds: ["11111111-1111-4111-8111-111111111111"],
      includeDescendants: false,
      instruction: "Write a new summary document from these meeting notes.",
      perRunPageLimit: 20,
    });

    assert.match(result.normalizedText, /# User-directed wiki edit request/);
    assert.match(result.normalizedText, /source material, edit targets, or both/);
    assert.match(
      result.normalizedText,
      /Follow the user instruction as the primary task/,
    );
    assert.match(result.normalizedText, /Preserve selected pages unless/);
    assert.match(result.normalizedText, /## Selected source\/target pages/);
    assert.match(result.normalizedText, /Write a new summary document/);
  });
});
