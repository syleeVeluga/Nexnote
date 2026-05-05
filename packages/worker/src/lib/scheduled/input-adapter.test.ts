import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildScheduledAgentInput } from "./input-adapter.js";
import type { AgentDb } from "../agent/types.js";

const folderId = "33333333-3333-4333-8333-333333333333";

function fakeDb(input?: {
  pageRows?: Array<Record<string, unknown>>;
  folderRows?: Array<Record<string, unknown>>;
}): AgentDb {
  const pageRows = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Meeting Notes",
      slug: "meeting-notes",
      parentFolderId: null,
      parentPageId: null,
      currentRevisionId: "22222222-2222-4222-8222-222222222222",
    },
  ];
  const folderRows = [
    {
      id: folderId,
      name: "벨루가",
      slug: "veluga",
      parentFolderId: null,
    },
  ];
  return {
    select: (selection?: Record<string, unknown>) => {
      const isFolderSelect =
        selection &&
        "name" in selection &&
        "slug" in selection &&
        !("currentRevisionId" in selection);
      const rows = isFolderSelect
        ? (input?.folderRows ?? folderRows)
        : (input?.pageRows ?? pageRows);
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: async (limit: number) => rows.slice(0, limit),
        then: <TResult1 = typeof rows, TResult2 = never>(
          onfulfilled?:
            | ((value: typeof rows) => TResult1 | PromiseLike<TResult1>)
            | null,
          onrejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | null,
        ) => Promise.resolve(rows).then(onfulfilled, onrejected),
      };
      return chain;
    },
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
    assert.match(
      result.normalizedText,
      /source material, edit targets, or both/,
    );
    assert.match(
      result.normalizedText,
      /Follow the user instruction as the primary task/,
    );
    assert.match(result.normalizedText, /Preserve selected pages unless/);
    assert.match(result.normalizedText, /옮겨 적기/);
    assert.match(result.normalizedText, /## Selected source\/target pages/);
    assert.match(result.normalizedText, /Write a new summary document/);
    assert.equal(result.targetFolderId, null);
    assert.equal(result.targetFolderInferred, false);
  });

  it("infers a target folder when all selected pages share one folder", async () => {
    const result = await buildScheduledAgentInput(
      fakeDb({
        pageRows: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            title: "벨루가 수행기관 현황",
            slug: "벨루가-수행기관-현황",
            parentFolderId: folderId,
            parentPageId: null,
            currentRevisionId: "22222222-2222-4222-8222-222222222222",
          },
          {
            id: "44444444-4444-4444-8444-444444444444",
            title: "벨루가 사업실적",
            slug: "벨루가-사업실적",
            parentFolderId: folderId,
            parentPageId: null,
            currentRevisionId: "55555555-5555-4555-8555-555555555555",
          },
        ],
      }),
      "workspace-1",
      {
        pageIds: [
          "11111111-1111-4111-8111-111111111111",
          "44444444-4444-4444-8444-444444444444",
        ],
        includeDescendants: false,
        instruction:
          '새로운 페이지 생성하기 "벨루가 정보"\n현재 폴더내 2개 페이지를 모두 그대로 두고 내용만 새롭게 생성한 "벨루가 정보" 옮겨 적기',
        perRunPageLimit: 20,
      },
    );

    assert.equal(result.targetFolderId, folderId);
    assert.equal(result.targetFolderInferred, true);
    assert.match(
      result.normalizedText,
      /All selected pages share target folder/,
    );
    assert.match(result.normalizedText, /create any new pages requested/);
    assert.doesNotMatch(result.normalizedText, /No target folder was provided/);
  });

  it("preserves the user's selected root page order", async () => {
    const firstPageId = "11111111-1111-4111-8111-111111111111";
    const secondPageId = "44444444-4444-4444-8444-444444444444";
    const result = await buildScheduledAgentInput(
      fakeDb({
        pageRows: [
          {
            id: secondPageId,
            title: "Second selected page",
            slug: "second-selected-page",
            parentFolderId: null,
            parentPageId: null,
            currentRevisionId: "55555555-5555-4555-8555-555555555555",
          },
          {
            id: firstPageId,
            title: "First selected page",
            slug: "first-selected-page",
            parentFolderId: null,
            parentPageId: null,
            currentRevisionId: "22222222-2222-4222-8222-222222222222",
          },
        ],
      }),
      "workspace-1",
      {
        pageIds: [firstPageId, secondPageId],
        includeDescendants: false,
        instruction: "Create a new page and copy the selected pages in order.",
        perRunPageLimit: 20,
      },
    );

    assert.deepEqual(result.seedPageIds, [firstPageId, secondPageId]);
    assert.ok(
      result.normalizedText.indexOf("First selected page") <
        result.normalizedText.indexOf("Second selected page"),
    );
  });
});
