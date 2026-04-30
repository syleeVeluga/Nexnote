import "@testing-library/jest-dom/vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PageEditorPage } from "./PageEditorPage.js";

const pagesMock = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  publish: vi.fn(),
  createRevision: vi.fn(),
  reformat: vi.fn(),
}));

vi.mock("../hooks/use-workspace.js", () => {
  const workspace = { id: "workspace-1", slug: "workspace", name: "Workspace" };
  return {
    useWorkspace: () => ({ current: workspace }),
  };
});

vi.mock("../lib/api-client.js", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  pages: pagesMock,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string | number>) => {
      const messages: Record<string, string> = {
        "common:cancel": "Cancel",
        "common:loading": "Loading",
        block: "Block",
        graph: "Relationships",
        history: "History",
        lastSaved: "Last saved: {{date}}",
        publish: "Publish",
        publishConfirm: "Are you sure you want to publish this page?",
        published: "Published",
        publishing: "Publishing...",
        publishScopeLabel: "Publish scope",
        publishScopeSelf: "This page only",
        publishScopeSubtree: "This page + descendants ({{count}} total)",
        publishScopeSubtreeLoading: "Checking descendants...",
        publishScopeSubtreeTooLarge: "More than {{limit}} pages",
        publishSubtreeConfirm:
          "Publish this page and descendants ({{count}} total pages)?",
        publishSubtreeSuccess:
          "Publish queued: {{published}}/{{total}} pages, {{skipped}} skipped, {{failed}} failed",
        publishSuccess: "Page published successfully",
        save: "Save",
        saved: "Saved",
        source: "Source",
        unsavedChanges: "Unsaved changes",
        viewPublished: "View published page",
      };

      const template = messages[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(vars?.[name] ?? ""),
      );
    },
  }),
}));

vi.mock("../components/editor/TiptapEditor.js", async () => {
  const React = await import("react");

  return {
    TiptapEditor: React.forwardRef(
      (
        props: { initialContent: string; onChange: (markdown: string) => void },
        ref,
      ) => {
        React.useImperativeHandle(ref, () => ({
          getJSON: () => ({}),
          getMarkdown: () => props.initialContent,
          setMarkdown: vi.fn(),
        }));
        return (
          <textarea aria-label="Editor" defaultValue={props.initialContent} />
        );
      },
    ),
  };
});

vi.mock("../components/editor/FreshnessBadge.js", () => ({
  FreshnessBadge: () => <span data-testid="freshness-badge" />,
}));

vi.mock("../components/graph/GraphPanel.js", () => ({
  GraphPanel: () => null,
}));

vi.mock("../components/revisions/RevisionHistoryPanel.js", () => ({
  RevisionHistoryPanel: () => null,
}));

function renderPageEditor() {
  return render(
    <MemoryRouter initialEntries={["/pages/page-parent"]}>
      <Routes>
        <Route path="/pages/:pageId" element={<PageEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("PageEditorPage publishing", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    pagesMock.get.mockResolvedValue({
      page: {
        id: "page-parent",
        workspaceId: "workspace-1",
        parentPageId: null,
        parentFolderId: null,
        title: "Publish Parent",
        slug: "publish-parent",
        status: "draft",
        sortOrder: 0,
        currentRevisionId: "revision-parent",
        lastAiUpdatedAt: null,
        lastHumanEditedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        latestRevisionActorType: "user",
        latestRevisionSource: "editor",
        latestRevisionCreatedAt: "2026-01-01T00:00:00.000Z",
        latestRevisionSourceIngestionId: null,
        latestRevisionSourceDecisionId: null,
        publishedAt: null,
        isLivePublished: false,
      },
      currentRevision: {
        id: "revision-parent",
        pageId: "page-parent",
        baseRevisionId: null,
        actorUserId: "user-1",
        modelRunId: null,
        actorType: "user",
        source: "editor",
        contentMd: "# Publish Parent",
        contentJson: null,
        revisionNote: null,
        sourceIngestionId: null,
        sourceDecisionId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });

    pagesMock.list.mockImplementation(
      async (_workspaceId: string, params?: { parentPageId?: string }) => {
        if (params?.parentPageId === "page-parent") {
          return {
            data: [
              {
                id: "page-child",
                parentPageId: "page-parent",
                parentFolderId: null,
              },
            ],
            total: 1,
          };
        }
        return { data: [], total: 0 };
      },
    );

    pagesMock.publish.mockResolvedValue({
      snapshot: {
        id: "snapshot-parent",
        pageId: "page-parent",
        versionNo: 1,
        publicPath: "/docs/workspace/publish-parent",
        title: "Publish Parent",
        isLive: true,
        publishedAt: "2026-01-01T00:00:00.000Z",
      },
      snapshots: [
        {
          id: "snapshot-parent",
          pageId: "page-parent",
          versionNo: 1,
          publicPath: "/docs/workspace/publish-parent",
          title: "Publish Parent",
          isLive: true,
          publishedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "snapshot-child",
          pageId: "page-child",
          versionNo: 1,
          publicPath: "/docs/workspace/publish-child",
          title: "Publish Child",
          isLive: true,
          publishedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      scope: "subtree",
      total: 2,
      publishedCount: 2,
      skippedCount: 0,
      failedCount: 0,
      skipped: [],
      failed: [],
    });
  });

  it("labels subtree scope as total pages and shows every published snapshot link", async () => {
    renderPageEditor();

    await screen.findByText("Publish Parent");
    await screen.findByText("This page + descendants (2 total)");

    fireEvent.change(screen.getByLabelText("Publish scope"), {
      target: { value: "subtree" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    const confirmBanner = await screen.findByText(
      "Publish this page and descendants (2 total pages)?",
    );
    fireEvent.click(
      within(
        confirmBanner.closest(".publish-banner-confirm") as HTMLElement,
      ).getByRole("button", { name: "Publish" }),
    );

    await waitFor(() =>
      expect(pagesMock.publish).toHaveBeenCalledWith(
        "workspace-1",
        "page-parent",
        { scope: "subtree" },
      ),
    );

    expect(
      await screen.findByRole("link", { name: "Publish Parent" }),
    ).toHaveAttribute("href", "/docs/workspace/publish-parent");
    expect(screen.getByRole("link", { name: "Publish Child" })).toHaveAttribute(
      "href",
      "/docs/workspace/publish-child",
    );
    expect(
      screen.getByText("Publish queued: 2/2 pages, 0 skipped, 0 failed"),
    ).toBeInTheDocument();
  });
});
