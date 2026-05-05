import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildEntityGraph } from "./graph-builder.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const seedPageA = "22222222-2222-4222-8222-222222222222";
const seedPageB = "33333333-3333-4333-8333-333333333333";
const outsidePage = "44444444-4444-4444-8444-444444444444";

interface QueryFrame {
  fromTable: string | null;
  fromSql: string;
  whereSql: string;
}

class FakeDb {
  readonly queries: QueryFrame[] = [];

  constructor(private readonly results: unknown[][]) {}

  select(_fields?: unknown) {
    return this.queryChain();
  }

  private queryChain() {
    const finish = async () => this.results.shift() ?? [];
    const frame: QueryFrame = { fromTable: null, fromSql: "", whereSql: "" };
    const chain = {
      from: (source: unknown) => {
        frame.fromTable = getTableName(source);
        frame.fromSql = renderSqlWithValues(source);
        this.queries.push(frame);
        return chain;
      },
      where: (condition: unknown) => {
        frame.whereSql = renderSqlWithValues(condition);
        return chain;
      },
      groupBy: finish,
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => finish().then(resolve, reject),
    };
    return chain;
  }
}

function getTableName(source: unknown): string | null {
  if (!source || typeof source !== "object") return null;
  const nameSym = Object.getOwnPropertySymbols(source).find(
    (s) => s.description === "drizzle:Name",
  );
  if (!nameSym) return null;
  const v = (source as Record<symbol, unknown>)[nameSym];
  return typeof v === "string" ? v : null;
}

// Walks the drizzle SQL template and inlines column references, Param values,
// and inArray value lists so we can pattern-match the resulting SQL.
function renderSqlWithValues(query: unknown): string {
  if (query === null || query === undefined) return "";
  if (typeof query === "string") return query;
  if (typeof query !== "object") return String(query);

  // Nested SQL template
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    return chunks.map(renderSqlWithValues).join("");
  }

  // inArray binds the value list as a raw JS array chunk.
  if (Array.isArray(query)) {
    return "(" + query.map(renderSqlWithValues).join(", ") + ")";
  }

  // Drizzle column reference (PgUUID / PgText / etc.)
  const colName = (query as { name?: unknown; columnType?: unknown }).name;
  const colType = (query as { columnType?: unknown }).columnType;
  if (typeof colName === "string" && typeof colType === "string") {
    return `"${colName}"`;
  }

  // StringChunk shape: { value: [strings] }
  // Param shape: { brand, value, encoder } — value can be any scalar
  const value = (query as { value?: unknown }).value;
  if (Array.isArray(value)) return value.join("");
  if (value !== undefined) return String(value);

  return "";
}

describe("buildEntityGraph", () => {
  it("returns an empty graph when seed pages have no center triples", async () => {
    const db = new FakeDb([[]]);

    const graph = await buildEntityGraph(db as never, {
      workspaceId,
      seedPageIds: [seedPageA],
      depth: 1,
      limit: 60,
      minConfidence: 0,
      locale: undefined,
      restrictToSeedScope: false,
    });

    assert.deepEqual(graph, { nodes: [], edges: [], truncated: false });
  });

  it("returns an empty graph for an empty seed list (folder with zero pages)", async () => {
    const db = new FakeDb([]);

    const graph = await buildEntityGraph(db as never, {
      workspaceId,
      seedPageIds: [],
      depth: 1,
      limit: 60,
      minConfidence: 0,
      locale: undefined,
      restrictToSeedScope: true,
    });

    assert.deepEqual(graph, { nodes: [], edges: [], truncated: false });
    assert.equal(
      db.queries.length,
      0,
      "no DB roundtrip should fire when seed pages are empty",
    );
  });

  it("assembles nodes and edges from seed-scoped triples", async () => {
    const db = new FakeDb([
      [{ subjectEntityId: "entity-1", objectEntityId: "entity-2" }],
      [],
      [
        { entityId: "entity-1", pageCount: 1 },
        { entityId: "entity-2", pageCount: 1 },
      ],
      [
        {
          id: "entity-1",
          canonicalName: "Entity One",
          entityType: "concept",
        },
        {
          id: "entity-2",
          canonicalName: "Entity Two",
          entityType: "concept",
        },
      ],
      [
        {
          id: "triple-1",
          subjectEntityId: "entity-1",
          objectEntityId: "entity-2",
          predicate: "relates_to",
          confidence: 0.9,
          sourcePageId: seedPageA,
        },
      ],
    ]);

    const graph = await buildEntityGraph(db as never, {
      workspaceId,
      seedPageIds: [seedPageA],
      depth: 1,
      limit: 60,
      minConfidence: 0,
      locale: undefined,
      restrictToSeedScope: true,
    });

    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.nodes[0].isCenter, true);
    assert.equal(graph.edges[0].sourcePageId, seedPageA);
  });

  it("with restrictToSeedScope: true, every triples query is restricted to seed pages — outside-folder triples cannot leak in", async () => {
    // Seed pages = the folder's two pages. The "outside" page must never
    // appear in any WHERE clause that touches the triples table.
    const db = new FakeDb([
      // center: two triples, both rooted in seed pages
      [
        { subjectEntityId: "E1", objectEntityId: "E2" },
        { subjectEntityId: "E2", objectEntityId: "E3" },
      ],
      // BFS hop 1: same triples (no new entities — still no E4)
      [
        { subjectEntityId: "E1", objectEntityId: "E2" },
        { subjectEntityId: "E2", objectEntityId: "E3" },
      ],
      // entities
      [
        { id: "E1", canonicalName: "E1", entityType: "concept" },
        { id: "E2", canonicalName: "E2", entityType: "concept" },
        { id: "E3", canonicalName: "E3", entityType: "concept" },
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
    ]);

    await buildEntityGraph(db as never, {
      workspaceId,
      seedPageIds: [seedPageA, seedPageB],
      depth: 1,
      limit: 60,
      minConfidence: 0,
      locale: undefined,
      restrictToSeedScope: true,
    });

    const triplesQueries = db.queries.filter((q) => q.fromTable === "triples");
    assert.ok(
      triplesQueries.length >= 3,
      `expected center + BFS + edges queries on triples (got ${triplesQueries.length})`,
    );
    for (const q of triplesQueries) {
      assert.match(
        q.whereSql,
        /"source_page_id"\s+in\s+\(/i,
        `every triples query must restrict source_page_id when restrictToSeedScope=true; got: ${q.whereSql}`,
      );
      assert.ok(
        q.whereSql.includes(seedPageA) && q.whereSql.includes(seedPageB),
        "the seed page IDs (and only those) must be the bound list",
      );
      assert.ok(
        !q.whereSql.includes(outsidePage),
        `no outside-folder page should appear in the WHERE clause; got: ${q.whereSql}`,
      );
    }

    // The pageCount sub-query (fromSql is a raw SQL template) joins
    // sourcePageId too — verify the closed-scope guard applies there as well.
    const pageCountQuery = db.queries.find((q) => /\bpc\b/.test(q.fromSql));
    assert.ok(pageCountQuery, "pageCount sub-query should be issued");
    assert.match(
      pageCountQuery.fromSql,
      /"source_page_id"/,
      "pageCount sub-query should restrict on source_page_id",
    );
    assert.ok(
      pageCountQuery.fromSql.includes(seedPageA),
      "pageCount sub-query should bind the seed page list",
    );
    assert.ok(
      !pageCountQuery.fromSql.includes(outsidePage),
      "pageCount sub-query must not include outside-folder pages",
    );
  });

  it("with restrictToSeedScope: false, BFS expansion and edge query are not restricted to seed pages", async () => {
    // Symmetry check: the page-mode caller (existing /pages/:id/graph) must
    // continue to allow neighbor edges from any page in the workspace.
    const db = new FakeDb([
      [{ subjectEntityId: "E1", objectEntityId: "E2" }],
      [{ subjectEntityId: "E1", objectEntityId: "E2" }],
      [{ id: "E1", canonicalName: "E1", entityType: "concept" }],
      [{ entityId: "E1", pageCount: 1 }],
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
    ]);

    await buildEntityGraph(db as never, {
      workspaceId,
      seedPageIds: [seedPageA],
      depth: 1,
      limit: 60,
      minConfidence: 0,
      locale: undefined,
      restrictToSeedScope: false,
    });

    const triplesQueries = db.queries.filter((q) => q.fromTable === "triples");

    // Center triples query is always restricted to seed pages (it defines
    // which entities sit in the center of the graph). The 2nd and later
    // triples queries (BFS expansion, final edge query) must NOT carry the
    // restriction in page-mode.
    assert.ok(triplesQueries.length >= 3);
    assert.match(
      triplesQueries[0].whereSql,
      /"source_page_id"\s+in/i,
      "center triples are always seed-restricted (this defines the center set)",
    );
    for (const q of triplesQueries.slice(1)) {
      assert.doesNotMatch(
        q.whereSql,
        /"source_page_id"\s+in/i,
        `non-center triples queries must not restrict to seed pages when restrictToSeedScope=false; got: ${q.whereSql}`,
      );
    }
  });

  it("caps center entities to the requested limit before loading graph details", async () => {
    const db = new FakeDb([
      [
        { subjectEntityId: "entity-1", objectEntityId: "entity-2" },
        { subjectEntityId: "entity-3", objectEntityId: null },
      ],
      [],
      [
        { entityId: "entity-1", pageCount: 1 },
        { entityId: "entity-2", pageCount: 1 },
      ],
      [
        {
          id: "entity-1",
          canonicalName: "Entity One",
          entityType: "concept",
        },
        {
          id: "entity-2",
          canonicalName: "Entity Two",
          entityType: "concept",
        },
      ],
      [
        {
          id: "triple-1",
          subjectEntityId: "entity-1",
          objectEntityId: "entity-2",
          predicate: "relates_to",
          confidence: 0.9,
          sourcePageId: seedPageA,
        },
      ],
    ]);

    const graph = await buildEntityGraph(db as never, {
      workspaceId,
      seedPageIds: [seedPageA],
      depth: 1,
      limit: 2,
      minConfidence: 0,
      locale: undefined,
      restrictToSeedScope: true,
    });

    assert.equal(graph.truncated, true);
    assert.equal(graph.nodes.length, 2);
    assert.deepEqual(
      graph.nodes.map((node) => node.id).sort(),
      ["entity-1", "entity-2"],
    );
  });
});
