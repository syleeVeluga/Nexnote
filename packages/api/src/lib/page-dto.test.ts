import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mapPageDto } from "./page-dto.js";

describe("mapPageDto", () => {
  it("adds latest revision and live publish metadata", () => {
    const page = mapPageDto({
      id: "page-1",
      workspaceId: "workspace-1",
      parentPageId: null,
      parentFolderId: "folder-1",
      title: "Roadmap",
      slug: "roadmap",
      status: "published",
      sortOrder: 0,
      currentRevisionId: "revision-1",
      lastAiUpdatedAt: null,
      lastHumanEditedAt: null,
      createdAt: new Date("2026-04-29T00:00:00.000Z"),
      updatedAt: new Date("2026-04-29T00:00:01.000Z"),
      latestRevisionActorType: "ai",
      latestRevisionSource: "ingest_api",
      latestRevisionCreatedAt: new Date("2026-04-29T00:00:02.000Z"),
      latestRevisionSourceIngestionId: "ingestion-1",
      latestRevisionSourceDecisionId: "decision-1",
      publishedAt: new Date("2026-04-29T00:00:03.000Z"),
      isLivePublished: true,
    });

    assert.equal(page.latestRevisionActorType, "ai");
    assert.equal(page.latestRevisionSource, "ingest_api");
    assert.equal(page.latestRevisionCreatedAt, "2026-04-29T00:00:02.000Z");
    assert.equal(page.latestRevisionSourceIngestionId, "ingestion-1");
    assert.equal(page.latestRevisionSourceDecisionId, "decision-1");
    assert.equal(page.publishedAt, "2026-04-29T00:00:03.000Z");
    assert.equal(page.isLivePublished, true);
  });

  it("defaults missing metadata to nullable fields", () => {
    const page = mapPageDto({
      id: "page-1",
      workspaceId: "workspace-1",
      parentPageId: null,
      title: "Draft",
      slug: "draft",
      status: "draft",
      sortOrder: 0,
      currentRevisionId: null,
      createdAt: new Date("2026-04-29T00:00:00.000Z"),
      updatedAt: new Date("2026-04-29T00:00:01.000Z"),
    });

    assert.equal(page.parentFolderId, null);
    assert.equal(page.latestRevisionActorType, null);
    assert.equal(page.latestRevisionSource, null);
    assert.equal(page.latestRevisionCreatedAt, null);
    assert.equal(page.publishedAt, null);
    assert.equal(page.isLivePublished, false);
  });
});
