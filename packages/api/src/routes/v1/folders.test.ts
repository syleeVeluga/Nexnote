import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import Fastify from "fastify";
import folderRoutes from "./folders.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const folderId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const seedPageA = "44444444-4444-4444-8444-444444444444";
const seedPageB = "55555555-5555-4555-8555-555555555555";

interface FakeDbConfig {
  // result for db.select()…  awaited (one entry per select call, in order)
  selectQueue: unknown[][];
  // result for db.execute()… (one entry per execute call, in order)
  executeQueue: unknown[][];
}

function makeFakeDb(config: FakeDbConfig) {
  return {
    select(_fields?: unknown) {
      // Chain methods all return the chain; the queue is only consumed when
      // the chain is awaited via .then(). This matters because graph-builder
      // builds Promise.all([...]) inline and several entries terminate with
      // `.groupBy(...)` — if `groupBy` consumed the queue eagerly the rows
      // would land on the wrong sibling promise.
      const finish = async () => config.selectQueue.shift() ?? [];
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: () => chain,
        groupBy: () => chain,
        innerJoin: () => chain,
        leftJoin: () => chain,
        orderBy: () => chain,
        then: (
          resolve: (value: unknown[]) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => finish().then(resolve, reject),
      };
      return chain;
    },
    async execute(_query: unknown) {
      return config.executeQueue.shift() ?? [];
    },
  };
}

async function buildTestApp(config: FakeDbConfig) {
  const app = Fastify();
  // Stub the auth + db decorators normally provided by authPlugin / dbPlugin.
  app.decorate("authenticate", async (request: any) => {
    request.user = { sub: userId, email: "tester@example.com" };
  });
  app.decorate("db", makeFakeDb(config) as never);
  await app.register(folderRoutes, {
    prefix: "/api/v1/workspaces/:workspaceId/folders",
  });
  return app;
}

describe("GET /folders/:folderId/graph", () => {
  it("returns 200 with an empty closed graph when the folder has no descendant pages", async () => {
    const app = await buildTestApp({
      selectQueue: [
        // getMemberRole — caller is owner
        [{ role: "owner" }],
        [{ id: folderId }],
      ],
      executeQueue: [
        // collectFolderDescendantPageIds — folder is empty
        [],
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/folders/${folderId}/graph`,
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      nodes: unknown[];
      edges: unknown[];
      meta: {
        scope: string;
        folderId: string;
        depth: number;
        totalNodes: number;
        totalEdges: number;
        truncated: boolean;
      };
    };
    assert.deepEqual(body.nodes, []);
    assert.deepEqual(body.edges, []);
    assert.equal(body.meta.scope, "folder");
    assert.equal(body.meta.folderId, folderId);
    assert.equal(body.meta.totalNodes, 0);
    assert.equal(body.meta.totalEdges, 0);
    assert.equal(body.meta.truncated, false);
    await app.close();
  });

  it("returns 200 with E1/E2/E3 nodes only — outside-folder triples cannot leak in", async () => {
    // Scenario from folder-graph-plan.md §검증/API 통합 테스트 #2:
    //   P1, P2 inside the folder hold triples mentioning E1, E2, E3.
    //   P3 sits outside the folder and holds an E1↔E4 triple.
    //   Closed-scope guarantee: E4 must be absent from the response.
    //
    // The Fake DB returns rows that already exclude P3's triples (the SQL
    // would have filtered them via the `triples.source_page_id IN (P1, P2)`
    // constraint that graph-builder.test.ts proves is present).
    const app = await buildTestApp({
      selectQueue: [
        // getMemberRole — owner
        [{ role: "owner" }],
        [{ id: folderId }],
        // center triples (only from seed pages — E4 is already filtered out)
        [
          { subjectEntityId: "E1", objectEntityId: "E2" },
          { subjectEntityId: "E2", objectEntityId: "E3" },
        ],
        // BFS hop 1 — same triples, no new entities
        [
          { subjectEntityId: "E1", objectEntityId: "E2" },
          { subjectEntityId: "E2", objectEntityId: "E3" },
        ],
        // entities
        [
          { id: "E1", canonicalName: "Entity One", entityType: "concept" },
          { id: "E2", canonicalName: "Entity Two", entityType: "concept" },
          { id: "E3", canonicalName: "Entity Three", entityType: "concept" },
        ],
        // pageCount
        [
          { entityId: "E1", pageCount: 1 },
          { entityId: "E2", pageCount: 2 },
          { entityId: "E3", pageCount: 1 },
        ],
        // edges
        [
          {
            id: "t1",
            subjectEntityId: "E1",
            objectEntityId: "E2",
            predicate: "relates_to",
            confidence: 0.9,
            sourcePageId: seedPageA,
          },
          {
            id: "t2",
            subjectEntityId: "E2",
            objectEntityId: "E3",
            predicate: "relates_to",
            confidence: 0.9,
            sourcePageId: seedPageB,
          },
        ],
      ],
      executeQueue: [
        // collectFolderDescendantPageIds → P1, P2
        [{ id: seedPageA }, { id: seedPageB }],
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/folders/${folderId}/graph`,
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      nodes: Array<{ id: string }>;
      edges: Array<{ id: string; sourcePageId: string }>;
      meta: {
        scope: string;
        folderId: string;
        depth: number;
        totalNodes: number;
        totalEdges: number;
        truncated: boolean;
      };
    };
    const nodeIds = body.nodes.map((n) => n.id).sort();
    assert.deepEqual(nodeIds, ["E1", "E2", "E3"]);
    assert.ok(
      !nodeIds.includes("E4"),
      "E4 from outside-folder page must not appear in the response",
    );
    const edgeSourcePages = new Set(body.edges.map((e) => e.sourcePageId));
    for (const sp of edgeSourcePages) {
      assert.ok(
        sp === seedPageA || sp === seedPageB,
        `edge sourcePageId ${sp} must be inside the folder`,
      );
    }
    assert.equal(body.meta.scope, "folder");
    assert.equal(body.meta.folderId, folderId);
    assert.equal(body.meta.totalNodes, 3);
    assert.equal(body.meta.totalEdges, 2);
    assert.equal(body.meta.truncated, false);
    await app.close();
  });

  it("returns 404 when the folder does not exist in the workspace", async () => {
    const app = await buildTestApp({
      selectQueue: [[{ role: "owner" }], []],
      executeQueue: [],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/folders/${folderId}/graph`,
    });

    assert.equal(res.statusCode, 404);
    const body = res.json() as { code: string };
    assert.equal(body.code, "FOLDER_NOT_FOUND");
    await app.close();
  });

  it("marks the response truncated when folder seed pages are capped", async () => {
    const app = await buildTestApp({
      selectQueue: [
        [{ role: "owner" }],
        [{ id: folderId }],
        [{ subjectEntityId: "E1", objectEntityId: "E2" }],
        [{ subjectEntityId: "E1", objectEntityId: "E2" }],
        [
          { id: "E1", canonicalName: "Entity One", entityType: "concept" },
          { id: "E2", canonicalName: "Entity Two", entityType: "concept" },
        ],
        [
          { entityId: "E1", pageCount: 1 },
          { entityId: "E2", pageCount: 1 },
        ],
        [
          {
            id: "t1",
            subjectEntityId: "E1",
            objectEntityId: "E2",
            predicate: "relates_to",
            confidence: 0.9,
            sourcePageId: seedPageA,
          },
        ],
      ],
      executeQueue: [
        Array.from({ length: 1001 }, (_, i) => ({ id: `page-${i}` })),
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/folders/${folderId}/graph`,
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { meta: { truncated: boolean } };
    assert.equal(body.meta.truncated, true);
    await app.close();
  });

  it("returns 403 to a non-member of the workspace", async () => {
    const app = await buildTestApp({
      selectQueue: [
        // getMemberRole — caller has no membership row
        [],
      ],
      executeQueue: [],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/folders/${folderId}/graph`,
    });

    assert.equal(res.statusCode, 403);
    const body = res.json() as { code: string };
    assert.equal(body.code, "FORBIDDEN");
    await app.close();
  });
});
