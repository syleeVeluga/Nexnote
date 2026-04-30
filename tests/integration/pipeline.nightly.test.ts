import "../support/load-test-env.ts";

import { afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  getDb,
  ingestionDecisions,
  ingestions,
  pageRevisions,
  pages,
  publishedSnapshots,
  triples,
} from "../../packages/db/src/index.ts";
import { createAuthContext, authHeaders } from "../support/api-fixtures.ts";
import {
  startIntegrationStack,
  type IntegrationStack,
} from "../support/integration-stack.ts";
import {
  closeTestConnections,
  prepareTestDatabase,
  resetTestState,
} from "../support/services.ts";
import { waitFor } from "../support/wait.ts";

describe("pipeline nightly", { concurrency: false }, () => {
  let stack: IntegrationStack;

  before(async () => {
    await prepareTestDatabase();
  });

  beforeEach(async () => {
    await resetTestState();
    stack = await startIntegrationStack();
  });

  afterEach(async () => {
    await stack.stop();
    await closeTestConnections();
  });

  it("keeps suggested decisions queued until a reviewer approves them", async () => {
    const db = getDb();
    const auth = await createAuthContext(stack.app, "nightly-suggest");

    const response = await stack.app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${auth.workspaceId}/ingestions/text`,
      headers: authHeaders(auth.token),
      payload: {
        titleHint: "Suggested Review",
        content: `# [E2E_SUGGEST]

[E2E_SUGGEST] requires human approval before publish.`,
      },
    });

    assert.equal(response.statusCode, 202);
    const { id: ingestionId } = response.json() as { id: string };

    const initialDecision = await waitFor(
      async () => {
        const [decision] = await db
          .select()
          .from(ingestionDecisions)
          .where(eq(ingestionDecisions.ingestionId, ingestionId))
          .limit(1);
        if (!decision || decision.status !== "suggested") {
          return false;
        }
        return decision;
      },
      { timeoutMs: 20_000, description: "suggested decision" },
    );

    const beforeApprovePages = await db
      .select()
      .from(pages)
      .where(eq(pages.workspaceId, auth.workspaceId));
    assert.equal(beforeApprovePages.length, 0);

    const approveResponse = await stack.app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${auth.workspaceId}/decisions/${initialDecision.id}/approve`,
      headers: authHeaders(auth.token),
    });
    assert.equal(approveResponse.statusCode, 200);

    const approved = await waitFor(
      async () => {
        const [decision] = await db
          .select()
          .from(ingestionDecisions)
          .where(eq(ingestionDecisions.id, initialDecision.id))
          .limit(1);
        if (
          !decision ||
          decision.status !== "approved" ||
          !decision.targetPageId ||
          !decision.proposedRevisionId
        ) {
          return false;
        }

        const [page] = await db
          .select()
          .from(pages)
          .where(eq(pages.id, decision.targetPageId))
          .limit(1);
        const [triple] = await db
          .select()
          .from(triples)
          .where(eq(triples.sourceRevisionId, decision.proposedRevisionId))
          .limit(1);
        if (!page || !triple) {
          return false;
        }

        return { decision, page, triple };
      },
      { timeoutMs: 20_000, description: "approved suggested decision" },
    );

    assert.equal(approved.page.title, "E2E Suggested Page");
    assert.equal(approved.triple.status, "active");
  });

  it("keeps needs-review decisions out of revisions and supports rejection", async () => {
    const db = getDb();
    const auth = await createAuthContext(stack.app, "nightly-review");

    const response = await stack.app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${auth.workspaceId}/ingestions/text`,
      headers: authHeaders(auth.token),
      payload: {
        titleHint: "Needs Review",
        content: `# [E2E_REVIEW]

[E2E_REVIEW] blocks automatic apply in tests.`,
      },
    });

    assert.equal(response.statusCode, 202);
    const { id: ingestionId } = response.json() as { id: string };

    const decision = await waitFor(
      async () => {
        const [row] = await db
          .select()
          .from(ingestionDecisions)
          .where(eq(ingestionDecisions.ingestionId, ingestionId))
          .limit(1);
        if (!row || row.status !== "needs_review") {
          return false;
        }
        return row;
      },
      { timeoutMs: 20_000, description: "needs-review decision" },
    );

    const pageCount = await db
      .select()
      .from(pages)
      .where(eq(pages.workspaceId, auth.workspaceId));
    assert.equal(pageCount.length, 0);

    const rejectResponse = await stack.app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${auth.workspaceId}/decisions/${decision.id}/reject`,
      headers: authHeaders(auth.token),
      payload: {
        reason: "Rejected in nightly coverage",
      },
    });
    assert.equal(rejectResponse.statusCode, 200);

    const rejected = await waitFor(
      async () => {
        const [row] = await db
          .select()
          .from(ingestionDecisions)
          .where(eq(ingestionDecisions.id, decision.id))
          .limit(1);
        if (!row || row.status !== "rejected") {
          return false;
        }
        return row;
      },
      { timeoutMs: 20_000, description: "rejected needs-review decision" },
    );

    const revisionsAfterReject = await db
      .select()
      .from(pageRevisions)
      .where(eq(pageRevisions.sourceDecisionId, rejected.id));
    assert.equal(revisionsAfterReject.length, 0);
  });

  it("publishes an immutable snapshot and serves it through docs", async () => {
    const db = getDb();
    const auth = await createAuthContext(stack.app, "nightly-publish");

    const createResponse = await stack.app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${auth.workspaceId}/pages`,
      headers: authHeaders(auth.token),
      payload: {
        title: "Publishable Page",
        slug: "publishable-page",
        contentMd: "# Publishable Page\n\nPublished body.",
      },
    });
    assert.equal(createResponse.statusCode, 201);
    const createBody = createResponse.json() as {
      page: { id: string };
      revision: { id: string };
    };

    const publishResponse = await stack.app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${auth.workspaceId}/pages/${createBody.page.id}/publish`,
      headers: authHeaders(auth.token),
      payload: {},
    });
    assert.equal(publishResponse.statusCode, 202);

    const snapshot = await waitFor(
      async () => {
        const [row] = await db
          .select()
          .from(publishedSnapshots)
          .where(eq(publishedSnapshots.pageId, createBody.page.id))
          .limit(1);
        if (!row || !row.snapshotHtml) {
          return false;
        }
        return row;
      },
      { timeoutMs: 20_000, description: "published snapshot render" },
    );

    const docsResponse = await stack.app.inject({
      method: "GET",
      url: `/api/v1/docs/${auth.workspaceSlug}/publishable-page`,
    });
    assert.equal(docsResponse.statusCode, 200);
    const docsBody = docsResponse.json() as {
      html: string;
      publicPath: string;
    };

    assert.match(snapshot.snapshotHtml, /Publishable Page/);
    assert.match(docsBody.html, /Published body\./);
    assert.equal(
      docsBody.publicPath,
      `/docs/${auth.workspaceSlug}/publishable-page`,
    );
  });

  it("publishes the current page and active descendants when scope is subtree", async () => {
    const db = getDb();
    const auth = await createAuthContext(stack.app, "nightly-subtree-publish");

    const parentResponse = await stack.app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${auth.workspaceId}/pages`,
      headers: authHeaders(auth.token),
      payload: {
        title: "Publish Parent",
        slug: "publish-parent",
        contentMd: "# Publish Parent\n\nParent body.",
      },
    });
    assert.equal(parentResponse.statusCode, 201);
    const parentBody = parentResponse.json() as { page: { id: string } };

    const childResponse = await stack.app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${auth.workspaceId}/pages`,
      headers: authHeaders(auth.token),
      payload: {
        title: "Publish Child",
        slug: "publish-child",
        parentPageId: parentBody.page.id,
        contentMd: "# Publish Child\n\nChild body.",
      },
    });
    assert.equal(childResponse.statusCode, 201);
    const childBody = childResponse.json() as { page: { id: string } };

    const siblingResponse = await stack.app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${auth.workspaceId}/pages`,
      headers: authHeaders(auth.token),
      payload: {
        title: "Publish Sibling",
        slug: "publish-sibling",
        contentMd: "# Publish Sibling\n\nSibling body.",
      },
    });
    assert.equal(siblingResponse.statusCode, 201);
    const siblingBody = siblingResponse.json() as { page: { id: string } };

    const publishResponse = await stack.app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${auth.workspaceId}/pages/${parentBody.page.id}/publish`,
      headers: authHeaders(auth.token),
      payload: { scope: "subtree" },
    });
    assert.equal(publishResponse.statusCode, 202);
    const publishBody = publishResponse.json() as {
      scope: "self" | "subtree";
      total: number;
      publishedCount: number;
      skippedCount: number;
      failedCount: number;
      snapshots: Array<{ pageId: string; publicPath: string }>;
    };

    assert.equal(publishBody.scope, "subtree");
    assert.equal(publishBody.total, 2);
    assert.equal(publishBody.publishedCount, 2);
    assert.equal(publishBody.skippedCount, 0);
    assert.equal(publishBody.failedCount, 0);
    assert.equal(publishBody.snapshots.length, 2);
    assert.deepEqual(
      new Set(publishBody.snapshots.map((snapshot) => snapshot.pageId)),
      new Set([parentBody.page.id, childBody.page.id]),
    );

    const parentSnapshots = await db
      .select()
      .from(publishedSnapshots)
      .where(
        and(
          eq(publishedSnapshots.pageId, parentBody.page.id),
          eq(publishedSnapshots.isLive, true),
        ),
      );
    const childSnapshots = await db
      .select()
      .from(publishedSnapshots)
      .where(
        and(
          eq(publishedSnapshots.pageId, childBody.page.id),
          eq(publishedSnapshots.isLive, true),
        ),
      );
    const siblingSnapshots = await db
      .select()
      .from(publishedSnapshots)
      .where(eq(publishedSnapshots.pageId, siblingBody.page.id));

    assert.equal(parentSnapshots.length, 1);
    assert.equal(childSnapshots.length, 1);
    assert.equal(siblingSnapshots.length, 0);

    const parentDocsResponse = await stack.app.inject({
      method: "GET",
      url: `/api/v1/docs/${auth.workspaceSlug}/publish-parent`,
    });
    assert.equal(parentDocsResponse.statusCode, 200);
    const parentDocsBody = parentDocsResponse.json() as {
      html: string;
      publicPath: string;
    };
    assert.match(parentDocsBody.html, /Parent body\./);
    assert.equal(
      parentDocsBody.publicPath,
      `/docs/${auth.workspaceSlug}/publish-parent`,
    );

    const childDocsResponse = await stack.app.inject({
      method: "GET",
      url: `/api/v1/docs/${auth.workspaceSlug}/publish-child`,
    });
    assert.equal(childDocsResponse.statusCode, 200);
    const childDocsBody = childDocsResponse.json() as {
      html: string;
      publicPath: string;
    };
    assert.match(childDocsBody.html, /Child body\./);
    assert.equal(
      childDocsBody.publicPath,
      `/docs/${auth.workspaceSlug}/publish-child`,
    );

    const siblingDocsResponse = await stack.app.inject({
      method: "GET",
      url: `/api/v1/docs/${auth.workspaceSlug}/publish-sibling`,
    });
    assert.equal(siblingDocsResponse.statusCode, 404);
  });

  it("marks ingestions failed when a mock marker is missing", async () => {
    const db = getDb();
    const auth = await createAuthContext(stack.app, "nightly-invalid");

    const response = await stack.app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${auth.workspaceId}/ingestions/text`,
      headers: authHeaders(auth.token),
      payload: {
        titleHint: "Unknown Marker",
        content: "# [E2E_UNKNOWN]\n\nUnknown fixture marker.",
      },
    });
    assert.equal(response.statusCode, 202);
    const { id: ingestionId } = response.json() as { id: string };

    const failedIngestion = await waitFor(
      async () => {
        const [ingestion] = await db
          .select()
          .from(ingestions)
          .where(eq(ingestions.id, ingestionId))
          .limit(1);
        if (!ingestion || ingestion.status !== "failed") {
          return false;
        }
        return ingestion;
      },
      {
        timeoutMs: 20_000,
        description: "failed ingestion from missing marker",
      },
    );

    const decisionsForFailedIngestion = await db
      .select()
      .from(ingestionDecisions)
      .where(eq(ingestionDecisions.ingestionId, failedIngestion.id));
    const failureAudits = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.workspaceId, auth.workspaceId),
          eq(auditLogs.entityId, failedIngestion.id),
        ),
      );

    assert.equal(decisionsForFailedIngestion.length, 0);
    assert.ok(failureAudits.length >= 1);
  });
});
