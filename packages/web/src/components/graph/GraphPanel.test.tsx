import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphData } from "@wekiflow/shared";
import { GraphPanel } from "./GraphPanel.js";

const pageGraphMock = vi.fn();
const folderGraphMock = vi.fn();
let resolvedLanguage = "ko";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { resolvedLanguage, language: resolvedLanguage },
    t: (key: string, vars?: Record<string, string | number>) => {
      const predicateMessages = resolvedLanguage.startsWith("ko")
        ? {
            "predicateLabels.works_at": "근무함",
            "predicateLabels.authors": "작성함",
          }
        : {
            "predicateLabels.works_at": "works at",
            "predicateLabels.authors": "authors",
          };
      const messages: Record<string, string> = {
        graph: "Relationships",
        graphDepth: "Traversal Range",
        graphNodeLimit: "Node limit",
        graphNodeLabels: "Node labels",
        graphNodeLabelsOn: "Shown",
        graphNodeLabelsOff: "Hidden",
        graphConfidence: "Relationship Confidence",
        graphEntityTypes: "Entity Types",
        graphPredicates: "Relationship Types",
        noGraphData: "No relationship data to display",
        "pages:wiki.folderGraphEmpty": "No relationship data in this folder.",
        graphNoFilteredData: "No relations match the current filters",
        graphVisibleNodes: "{{count}} displayed nodes",
        graphVisibleEdges: "{{count}} displayed relationships",
        graphFiltersApplied: "Filters applied",
        graphFiltersInactive: "All filters open",
        graphTruncated: "Graph truncated to {{limit}} nodes",
        "common:loading": "Loading",
        ...predicateMessages,
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
    graph: (...args: unknown[]) => pageGraphMock(...args),
  },
  folders: {
    graph: (...args: unknown[]) => folderGraphMock(...args),
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
    scope: "page",
    pageId: "page-1",
    depth: 1,
    totalNodes: 3,
    totalEdges: 2,
    truncated: false,
  },
};

beforeEach(() => {
  pageGraphMock.mockReset();
  pageGraphMock.mockResolvedValue(sampleGraph);
  folderGraphMock.mockReset();
  folderGraphMock.mockResolvedValue({
    ...sampleGraph,
    meta: {
      scope: "folder",
      folderId: "folder-1",
      depth: 1,
      totalNodes: 3,
      totalEdges: 2,
      truncated: false,
    },
  } satisfies GraphData);
  resolvedLanguage = "ko";
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

describe("GraphPanel", () => {
  it("refetches when depth changes and hides confidence controls", async () => {
    render(
      <GraphPanel
        mode="page"
        workspaceId="workspace-1"
        pageId="page-1"
        onClose={() => {}}
        onNavigateToPage={() => {}}
      />,
    );

    await waitFor(() =>
      expect(pageGraphMock).toHaveBeenCalledWith("workspace-1", "page-1", {
        depth: 1,
        limit: 500,
        minConfidence: 0,
        locale: "ko",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "2" }));

    await waitFor(() =>
      expect(pageGraphMock).toHaveBeenLastCalledWith("workspace-1", "page-1", {
        depth: 2,
        limit: 1000,
        minConfidence: 0,
        locale: "ko",
      }),
    );

    expect(
      screen.queryByRole("slider", { name: "Relationship Confidence" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Relationship Confidence")).not.toBeInTheDocument();
  });

  it("shows the filtered empty state when all entity types are disabled", async () => {
    render(
      <GraphPanel
        mode="page"
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
        mode="page"
        workspaceId="workspace-1"
        pageId="page-1"
        onClose={() => {}}
        onNavigateToPage={() => {}}
      />,
    );

    await screen.findByTestId("force-graph-2d");

    expect(
      screen.getByRole("button", { name: /근무함/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /작성함/i })).toBeInTheDocument();
  });

  it("uses entity node colors for active entity filter chips", async () => {
    render(
      <GraphPanel
        mode="page"
        workspaceId="workspace-1"
        pageId="page-1"
        onClose={() => {}}
        onNavigateToPage={() => {}}
      />,
    );

    await screen.findByTestId("force-graph-2d");

    expect(screen.getByRole("button", { name: /person/i })).toHaveStyle({
      "--graph-chip-color": "#4f46e5",
    });
    expect(screen.getByRole("button", { name: /organization/i })).toHaveStyle({
      "--graph-chip-color": "#059669",
    });
    expect(screen.getByRole("button", { name: /concept/i })).toHaveStyle({
      "--graph-chip-color": "#d97706",
    });
  });

  it("normalizes regional English locales before calling the graph API", async () => {
    resolvedLanguage = "en-US";

    render(
      <GraphPanel
        mode="page"
        workspaceId="workspace-1"
        pageId="page-1"
        onClose={() => {}}
        onNavigateToPage={() => {}}
      />,
    );

    await waitFor(() =>
      expect(pageGraphMock).toHaveBeenCalledWith("workspace-1", "page-1", {
        depth: 1,
        limit: 500,
        minConfidence: 0,
        locale: "en",
      }),
    );
  });

  it("fetches folder graphs in folder mode", async () => {
    render(
      <GraphPanel
        mode="folder"
        workspaceId="workspace-1"
        folderId="folder-1"
        onClose={() => {}}
        onNavigateToPage={() => {}}
      />,
    );

    await waitFor(() =>
      expect(folderGraphMock).toHaveBeenCalledWith("workspace-1", "folder-1", {
        depth: 1,
        limit: 500,
        minConfidence: 0,
        locale: "ko",
      }),
    );
    expect(pageGraphMock).not.toHaveBeenCalled();
  });

  it("uses the folder empty-state copy in folder mode", async () => {
    folderGraphMock.mockResolvedValue({
      nodes: [],
      edges: [],
      meta: {
        scope: "folder",
        folderId: "folder-1",
        depth: 1,
        totalNodes: 0,
        totalEdges: 0,
        truncated: false,
      },
    } satisfies GraphData);

    render(
      <GraphPanel
        mode="folder"
        workspaceId="workspace-1"
        folderId="folder-1"
        onClose={() => {}}
        onNavigateToPage={() => {}}
      />,
    );

    expect(
      await screen.findByText("No relationship data in this folder."),
    ).toBeInTheDocument();
  });

  it("toggles the node label control without changing relationship filters", async () => {
    render(
      <GraphPanel
        mode="page"
        workspaceId="workspace-1"
        pageId="page-1"
        onClose={() => {}}
        onNavigateToPage={() => {}}
      />,
    );

    await screen.findByTestId("force-graph-2d");

    const shownButton = screen.getByRole("button", { name: "Shown" });
    expect(shownButton).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(shownButton);

    expect(screen.getByRole("button", { name: "Hidden" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByText("Relationship Types:")).toBeInTheDocument();
  });

  it("refetches page graph data with the selected node limit", async () => {
    render(
      <GraphPanel
        mode="page"
        workspaceId="workspace-1"
        pageId="page-1"
        onClose={() => {}}
        onNavigateToPage={() => {}}
      />,
    );

    await screen.findByTestId("force-graph-2d");

    fireEvent.click(screen.getByRole("button", { name: "100" }));

    await waitFor(() =>
      expect(pageGraphMock).toHaveBeenLastCalledWith("workspace-1", "page-1", {
        depth: 1,
        limit: 100,
        minConfidence: 0,
        locale: "ko",
      }),
    );
  });

  it("refetches folder graph data with the selected node limit", async () => {
    render(
      <GraphPanel
        mode="folder"
        workspaceId="workspace-1"
        folderId="folder-1"
        onClose={() => {}}
        onNavigateToPage={() => {}}
      />,
    );

    await screen.findByTestId("force-graph-2d");

    fireEvent.click(screen.getByRole("button", { name: "200" }));

    await waitFor(() =>
      expect(folderGraphMock).toHaveBeenLastCalledWith(
        "workspace-1",
        "folder-1",
        {
          depth: 1,
          limit: 200,
          minConfidence: 0,
          locale: "ko",
        },
      ),
    );
  });
});
