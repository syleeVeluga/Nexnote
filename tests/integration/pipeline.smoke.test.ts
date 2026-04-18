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
  triples,
} from "../../packages/db/src/index.ts";
import { createAuthContext, authHeaders } from "../support/api-fixtures.ts";
import { startIntegrationStack, type IntegrationStack } from "../support/integration-stack.ts";
import {
  closeTestConnections,
  prepareTestDatabase,
  resetTestState,
} from "../support/services.ts";
import { waitFor } from "../support/wait.ts";

describe("pipeline smoke", { concurrency: false }, () => {
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

  it("auto-applies an ingestion through revision, triple, and audit persistence", async () => {
    const db = getDb();
    const auth = await createAuthContext(stack.app, "smoke-auto");

    const ingestionResponse = await stack.app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${auth.workspaceId}/ingestions/text`,
      headers: authHeaders(auth.token),
      payload: {
        titleHint: "Auto Apply Smoke",
        content: `# [E2E_AUTO]

[E2E_AUTO] verifies the auto apply pipeline.`,
      },
    });

    assert.equal(ingestionResponse.statusCode, 202);
    const ingestionBody = ingestionResponse.json() as { id: string };

    const settled = await waitFor(
      async () => {
        const [ingestion] = await db
          .select()
          .from(ingestions)
          .where(eq(ingestions.id, ingestionBody.id))
          .limit(1);
        const [decision] = await db
          .select()
          .from(ingestionDecisions)
          .where(eq(ingestionDecisions.ingestionId, ingestionBody.id))
          .limit(1);

        if (
          !ingestion ||
          ingestion.status !== "completed" ||
          !decision ||
          decision.status !== "auto_applied" ||
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
        const [revision] = await db
          .select()
          .from(pageRevisions)
          .where(eq(pageRevisions.id, decision.proposedRevisionId))
          .limit(1);
        const [triple] = await db
          .select()
          .from(triples)
          .where(eq(triples.sourceRevisionId, decision.proposedRevisionId))
          .limit(1);
        const auditRows = await db
          .select()
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.workspaceId, auth.workspaceId),
              eq(auditLogs.entityId, decision.targetPageId),
              eq(auditLogs.action, "create"),
            ),
          );

        if (!page || !revision || !triple || auditRows.length === 0) {
          return false;
        }

        return { ingestion, decision, page, revision, triple, auditRows };
      },
      { timeoutMs: 20_000, description: "auto-applied ingestion settlement" },
    );

    assert.equal(settled.decision.status, "auto_applied");
    assert.equal(settled.page.title, "E2E Auto Page");
    assert.equal(settled.page.currentRevisionId, settled.revision.id);
    assert.ok(settled.page.lastAiUpdatedAt, "expected lastAiUpdatedAt to be set");
    assert.equal(settled.revision.sourceIngestionId, ingestionBody.id);
    assert.equal(settled.revision.sourceDecisionId, settled.decision.id);
    assert.equal(settled.triple.status, "active");
    assert.equal(settled.auditRows[0].entityType, "page");
  });
});
