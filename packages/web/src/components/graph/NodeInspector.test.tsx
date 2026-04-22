import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityProvenance, GraphData } from "../../lib/api-client.js";
import { NodeInspector } from "./NodeInspector.js";

const entityProvenanceMock = vi.fn();
let resolvedLanguage = "ko";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { resolvedLanguage, language: resolvedLanguage },
    t: (key: string, vars?: Record<string, string | number>) => {
      const predicateMessages = resolvedLanguage.startsWith("ko")
        ? {
            "predicateLabels.works_at": "근무함",
            "predicateLabels.documents": "기록함",
          }
        : {
            "predicateLabels.works_at": "works at",
            "predicateLabels.documents": "documents",
          };
      const messages: Record<string, string> = {
        graphNodeInspectorAria: "Node inspector",
        graphNodeInspectorLoadFailed: "Failed to load node details",
        graphNodeInspectorEmpty: "No node details available.",
        graphNodeInspectorSubtitle:
          "Appears in {{pageCount}} pages / {{relationCount}} relations",
        graphNodeInspectorRelations: "Direct Relationships",
        graphNodeInspectorRelationsCount: "Currently showing {{count}}",
        graphNodeInspectorOutgoing: "Outgoing",
        graphNodeInspectorIncoming: "Incoming",
        graphNodeInspectorNoOutgoing: "No outgoing relations in this view.",
        graphNodeInspectorNoIncoming: "No incoming relations in this view.",
        graphNodeInspectorSourcePages: "Evidence Documents",
        graphNodeInspectorNoPages: "No source pages found for this entity.",
        graphNodeInspectorPageReason: "{{count}} relations mention this entity",
        graphNodeInspectorOpenPage: "Open Page",
        graphNodeInspectorAlreadyOpen: "Already open",
        graphNodeInspectorEvidence: "Evidence",
        graphNodeInspectorNoPageEvidence:
          "No excerpts captured for this page.",
        graphNodeInspectorNoEvidence:
          "No evidence excerpts captured for this entity yet.",
        graphNodeInspectorMorePages: "+{{count}} more pages",
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
    entityProvenance: (...args: unknown[]) => entityProvenanceMock(...args),
  },
}));

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
      label: "OpenAI",
      type: "organization",
      isCenter: false,
      pageCount: 2,
    },
    {
      id: "notes",
      label: "Team Notes",
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
      source: "notes",
      target: "alice",
      predicate: "documents",
      confidence: 0.8,
      sourcePageId: "page-2",
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

const provenance: EntityProvenance = {
  entity: {
    id: "alice",
    canonicalName: "Alice",
    entityType: "person",
    totalSourcePages: 2,
    totalActiveTriples: 4,
  },
  sourcePages: [
    {
      pageId: "page-2",
      title: "Team Notes",
      slug: "team-notes",
      activeTripleCount: 2,
      lastUpdatedAt: "2026-04-22T00:00:00.000Z",
      lastAiUpdatedAt: null,
      evidenceExcerpts: [
        {
          tripleId: "e2",
          predicate: "documents",
          displayPredicate: "\ubb38\uc11c\ud654",
          excerpt: "Team Notes documents Alice.",
          spanStart: 0,
          spanEnd: 26,
        },
      ],
    },
  ],
  truncated: false,
};

beforeEach(() => {
  entityProvenanceMock.mockReset();
  entityProvenanceMock.mockResolvedValue(provenance);
  resolvedLanguage = "ko";
});

describe("NodeInspector", () => {
  it("renders direct relations and provenance together", async () => {
    const onSelectEntity = vi.fn();

    render(
      <NodeInspector
        workspaceId="workspace-1"
        entityId="alice"
        currentPageId="page-1"
        graphData={graphData}
        onClose={() => {}}
        onSelectEntity={onSelectEntity}
        onNavigateToPage={() => {}}
        getTypeColor={() => "#000000"}
      />,
    );

    expect(await screen.findByText("Direct Relationships")).toBeInTheDocument();
    expect(screen.getAllByText("Team Notes")).toHaveLength(3);
    expect(screen.getByText("Outgoing")).toBeInTheDocument();
    expect(screen.getByText("Incoming")).toBeInTheDocument();
    expect(screen.getByText("근무함")).toBeInTheDocument();
    expect(screen.getAllByText("기록함")).toHaveLength(2);

    expect(entityProvenanceMock).toHaveBeenCalledWith("workspace-1", "alice", {
      limit: 5,
      locale: "ko",
      signal: expect.any(AbortSignal),
    });

    fireEvent.click(screen.getByRole("button", { name: /OpenAI/i }));

    expect(onSelectEntity).toHaveBeenCalledWith("acme");
    expect(screen.getByText("Evidence")).toBeInTheDocument();
  });

  it("normalizes regional English locales before loading provenance", async () => {
    resolvedLanguage = "en-US";

    render(
      <NodeInspector
        workspaceId="workspace-1"
        entityId="alice"
        currentPageId="page-1"
        graphData={graphData}
        onClose={() => {}}
        onSelectEntity={() => {}}
        onNavigateToPage={() => {}}
        getTypeColor={() => "#000000"}
      />,
    );

    expect(await screen.findByText("Direct Relationships")).toBeInTheDocument();
    expect(entityProvenanceMock).toHaveBeenCalledWith("workspace-1", "alice", {
      limit: 5,
      locale: "en",
      signal: expect.any(AbortSignal),
    });
  });
});
