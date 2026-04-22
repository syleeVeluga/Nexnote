import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphData } from "@nexnote/shared";
import { GraphPanel } from "./GraphPanel.js";

const graphMock = vi.fn();
let resolvedLanguage = "ko";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { resolvedLanguage, language: resolvedLanguage },
    t: (key: string, vars?: Record<string, string | number>) => {
      const messages: Record<string, string> = {
        graph: "Graph",
        graphDepth: "Depth",
        graphConfidence: "Confidence",
        graphEntityTypes: "Entity Types",
        graphPredicates: "Predicates",
        noGraphData: "No graph data",
        graphNoFilteredData: "No relations match the current filters",
        graphVisibleNodes: "{{count}} visible nodes",
        graphVisibleEdges: "{{count}} visible relations",
        graphFiltersApplied: "Filters applied",
        graphFiltersInactive: "All filters open",
        graphTruncated: "Graph truncated to {{limit}} nodes",
        "predicateLabels.works_at": "works at",
        "predicateLabels.authors": "authors",
        "common:loading": "Loading",
      };

      const template = messages[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(vars?.[name] ?? ""),
      );
    },
  }),
}));

vi.mock("../../lib/api-client.js", () => ({
  pages: {
    graph: (...args: unknown[]) => graphMock(...args),
  },
}));

vi.mock("react-force-graph-2d", () => ({
  default: ({
    graphData,
    onNodeClick,
    onNodeHover,
  }: {
    graphData: { nodes: Array<{ id: string; label: string }> };
    onNodeClick?: (node: { id: string; label: string }) => void;
    onNodeHover?: (node: { id: string; label: string } | null) => void;
  }) => (
    <div data-testid="force-graph-2d">
      {graphData.nodes.map((node) => (
        <button
          key={node.id}
          onClick={() => onNodeClick?.(node)}
          onMouseEnter={() => onNodeHover?.(node)}
          onMouseLeave={() => onNodeHover?.(null)}
        >
          {node.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("react-force-graph-3d", () => ({
  default: ({
    graphData,
  }: {
    graphData: { nodes: Array<{ id: string; label: string }> };
  }) => <div data-testid="force-graph-3d">{graphData.nodes.length}</div>,
}));

vi.mock("./NodeInspector.js", () => ({
  NodeInspector: ({ entityId }: { entityId: string }) => (
    <div data-testid="node-inspector">{entityId}</div>
  ),
}));

const sampleGraph: GraphData = {
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
  ],
  edges: [
    {
      id: "e1",
      source: "alice",
      target: "acme",
      predicate: "works_at",
      displayPredicate: "\uadfc\ubb34",
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
  ],
  meta: {
    pageId: "page-1",
    depth: 1,
    totalNodes: 3,
    totalEdges: 2,
    truncated: false,
  },
};

beforeEach(() => {
  graphMock.mockReset();
  graphMock.mockResolvedValue(sampleGraph);
  resolvedLanguage = "ko";
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

describe("GraphPanel", () => {
  it("refetches when depth and minConfidence change", async () => {
    render(
      <GraphPanel
        workspaceId="workspace-1"
        pageId="page-1"
        onClose={() => {}}
        onNavigateToPage={() => {}}
      />,
    );

    await waitFor(() =>
      expect(graphMock).toHaveBeenCalledWith("workspace-1", "page-1", {
        depth: 1,
        limit: 250,
        minConfidence: 0,
        locale: "ko",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "2" }));

    await waitFor(() =>
      expect(graphMock).toHaveBeenLastCalledWith("workspace-1", "page-1", {
        depth: 2,
        limit: 250,
        minConfidence: 0,
        locale: "ko",
      }),
    );

    fireEvent.change(screen.getByRole("slider", { name: "Confidence" }), {
      target: { value: "0.6" },
    });

    await waitFor(() =>
      expect(graphMock).toHaveBeenLastCalledWith("workspace-1", "page-1", {
        depth: 2,
        limit: 250,
        minConfidence: 0.6,
        locale: "ko",
      }),
    );
  });

  it("shows the filtered empty state when all entity types are disabled", async () => {
    render(
      <GraphPanel
        workspaceId="workspace-1"
        pageId="page-1"
        onClose={() => {}}
        onNavigateToPage={() => {}}
      />,
    );

    await screen.findByTestId("force-graph-2d");

    fireEvent.click(screen.getByRole("button", { name: /person/i }));
    fireEvent.click(screen.getByRole("button", { name: /organization/i }));
    fireEvent.click(screen.getByRole("button", { name: /concept/i }));

    await waitFor(() =>
      expect(
        screen.getByText("No relations match the current filters"),
      ).toBeInTheDocument(),
    );
  });

  it("renders localized predicate filter chips", async () => {
    render(
      <GraphPanel
        workspaceId="workspace-1"
        pageId="page-1"
        onClose={() => {}}
        onNavigateToPage={() => {}}
      />,
    );

    await screen.findByTestId("force-graph-2d");

    expect(
      screen.getByRole("button", { name: /\uadfc\ubb34/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /authors/i })).toBeInTheDocument();
  });

  it("normalizes regional English locales before calling the graph API", async () => {
    resolvedLanguage = "en-US";

    render(
      <GraphPanel
        workspaceId="workspace-1"
        pageId="page-1"
        onClose={() => {}}
        onNavigateToPage={() => {}}
      />,
    );

    await waitFor(() =>
      expect(graphMock).toHaveBeenCalledWith("workspace-1", "page-1", {
        depth: 1,
        limit: 250,
        minConfidence: 0,
        locale: "en",
      }),
    );
  });
});
