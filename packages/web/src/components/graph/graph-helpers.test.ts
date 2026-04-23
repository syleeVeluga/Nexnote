import { describe, expect, it } from "vitest";
import type { GraphData } from "@wekiflow/shared";
import {
  buildGraphFilterCandidates,
  filterGraphData,
  getEntityRelations,
  getFocusedNeighborhood,
} from "./graph-helpers.js";
import {
  getPredicateDisplayLabel,
  humanizePredicate,
} from "./predicate-label.js";

const graphData: GraphData = {
  nodes: [
    {
      id: "alice",
      label: "Alice",
      type: "person",
      isCenter: true,
      pageCount: 3,
    },
    {
      id: "acme",
      label: "Acme",
      type: "organization",
      isCenter: false,
      pageCount: 2,
    },
    {
      id: "graph",
      label: "GraphQL",
      type: "concept",
      isCenter: false,
      pageCount: 1,
    },
    {
      id: "bob",
      label: "Bob",
      type: "person",
      isCenter: false,
      pageCount: 1,
    },
    {
      id: "strategy",
      label: "Strategy",
      type: "concept",
      isCenter: false,
      pageCount: 1,
    },
  ],
  edges: [
    {
      id: "e1",
      source: "alice",
      target: "acme",
      predicate: "works_at",
      confidence: 0.9,
      sourcePageId: "page-1",
    },
    {
      id: "e2",
      source: "alice",
      target: "graph",
      predicate: "authors",
      confidence: 0.7,
      sourcePageId: "page-1",
    },
    {
      id: "e3",
      source: "bob",
      target: "acme",
      predicate: "works_at",
      confidence: 0.55,
      sourcePageId: "page-2",
    },
    {
      id: "e4",
      source: "strategy",
      target: "alice",
      predicate: "informs",
      confidence: 0.8,
      sourcePageId: "page-3",
    },
  ],
  meta: {
    pageId: "page-1",
    depth: 2,
    totalNodes: 5,
    totalEdges: 4,
    truncated: false,
  },
};

describe("buildGraphFilterCandidates", () => {
  it("builds sorted entity type and predicate options", () => {
    const candidates = buildGraphFilterCandidates(graphData);

    expect(candidates.entityTypes).toEqual([
      { value: "concept", count: 2 },
      { value: "person", count: 2 },
      { value: "organization", count: 1 },
    ]);
    expect(candidates.predicates).toEqual([
      { value: "works_at", count: 2 },
      { value: "authors", count: 1 },
      { value: "informs", count: 1 },
    ]);
  });
});

describe("filterGraphData", () => {
  it("keeps only edges that match the active filters and the nodes they touch", () => {
    const filtered = filterGraphData(graphData, {
      activeEntityTypes: ["person", "organization"],
      activePredicates: ["works_at"],
      minConfidence: 0.6,
    });

    expect(filtered.edges.map((edge) => edge.id)).toEqual(["e1"]);
    expect(filtered.nodes.map((node) => node.id)).toEqual(["alice", "acme"]);
  });
});

describe("getFocusedNeighborhood", () => {
  it("returns the selected node, its one-hop neighbors, and their edges", () => {
    const focus = getFocusedNeighborhood(graphData, "alice", null);

    expect([...focus.nodeIds]).toEqual(
      expect.arrayContaining(["alice", "acme", "graph", "strategy"]),
    );
    expect([...focus.edgeIds]).toEqual(
      expect.arrayContaining(["e1", "e2", "e4"]),
    );
    expect(focus.activeNodeId).toBe("alice");
  });
});

describe("getEntityRelations", () => {
  it("splits outgoing and incoming relations for the selected node", () => {
    const relations = getEntityRelations(graphData, "alice");

    expect(relations.outgoing.map((relation) => relation.predicate)).toEqual([
      "authors",
      "works_at",
    ]);
    expect(relations.outgoing.map((relation) => relation.entity.label)).toEqual([
      "GraphQL",
      "Acme",
    ]);
    expect(relations.incoming.map((relation) => relation.predicate)).toEqual([
      "informs",
    ]);
    expect(relations.incoming[0]?.entity.label).toBe("Strategy");
  });
});

describe("predicate labels", () => {
  it("humanizes unknown predicates when no translation exists", () => {
    const t = ((key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key) as never;

    expect(humanizePredicate("works_at")).toBe("works at");
    expect(getPredicateDisplayLabel(t, "works_at")).toBe("works at");
  });

  it("returns the translated predicate label when one exists", () => {
    const t = ((key: string, options?: { defaultValue?: string }) => {
      if (key === "predicateLabels.works_at") {
        return "근무함";
      }

      return options?.defaultValue ?? key;
    }) as never;

    expect(getPredicateDisplayLabel(t, "works_at")).toBe("근무함");
  });

  it("prefers locale translations over stale preferred labels", () => {
    const t = ((key: string, options?: { defaultValue?: string }) => {
      if (key === "predicateLabels.part_of") {
        return "속함";
      }

      return options?.defaultValue ?? key;
    }) as never;

    expect(getPredicateDisplayLabel(t, "part_of", "구성")).toBe("속함");
  });

  it("falls back to the preferred label when no locale translation exists", () => {
    const t = ((key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key) as never;

    expect(getPredicateDisplayLabel(t, "custom_predicate", "사용함")).toBe(
      "사용함",
    );
  });
});
