import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicDocPage } from "./PublicDocPage.js";

const docsMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("../lib/api-client.js", () => ({
  docs: docsMock,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string | number>) => {
      const messages: Record<string, string> = {
        backToList: "Back to docs",
        childPages: "Child Pages",
        loading: "Loading document...",
        notFound: "Document not found",
        notFoundDescription:
          "This page has not been published or does not exist.",
        publishedOn: "Published on {{date}}",
        tableOfContents: "Table of Contents",
        version: "Version {{version}}",
      };
      const template = messages[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(vars?.[name] ?? ""),
      );
    },
  }),
}));

function renderPublicDoc() {
  return render(
    <MemoryRouter initialEntries={["/docs/workspace/publish-parent"]}>
      <Routes>
        <Route path="/docs/:workspaceSlug/*" element={<PublicDocPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("PublicDocPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    docsMock.get.mockResolvedValue({
      id: "snapshot-parent",
      pageId: "page-parent",
      title: "Publish Parent",
      html: "<p>Parent body.</p>",
      markdown: "# Publish Parent\n\nParent body.",
      toc: [],
      versionNo: 1,
      publicPath: "/docs/workspace/publish-parent",
      publishedAt: "2026-01-01T00:00:00.000Z",
      workspace: { name: "Workspace", slug: "workspace" },
      children: [
        {
          id: "snapshot-child",
          pageId: "page-child",
          title: "Publish Child",
          publicPath: "/docs/workspace/publish-child",
          versionNo: 1,
          publishedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("renders published child documents as navigable links", async () => {
    renderPublicDoc();

    await screen.findByRole("heading", { name: "Publish Parent" });

    expect(screen.getByText("Child Pages")).toBeInTheDocument();
    expect(screen.getByText("Publish Child").closest("a")).toHaveAttribute(
      "href",
      "/docs/workspace/publish-child",
    );
  });
});
