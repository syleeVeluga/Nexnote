import "../support/load-test-env.ts";

import { randomUUID } from "node:crypto";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import {
  agentReadToolInputSchemas,
  type AIAdapter,
  type AIRequest,
  type AIResponse,
} from "../../packages/shared/src/index.ts";
import {
  agentRuns,
  apiTokens,
  auditLogs,
  getDb,
  ingestionDecisions,
  ingestions,
  modelRuns,
  pagePaths,
  pageRevisions,
  pages,
  triples,
  workspaces,
} from "../../packages/db/src/index.ts";
import { runIngestionAgentShadow } from "../../packages/worker/src/lib/agent/loop.ts";
import type { AgentToolDefinition } from "../../packages/worker/src/lib/agent/types.ts";
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

class SequenceAdapter implements AIAdapter {
  readonly provider = "openai" as const;

  constructor(private readonly responses: AIResponse[]) {}

  async chat(request: AIRequest): Promise<AIResponse> {
    const response = this.responses.shift();
    if (!response) {
      throw new Error(`No fake AI response queued for ${request.mode}`);
    }
    return response;
  }
}

function response(overrides: Partial<AIResponse>): AIResponse {
  return {
    content: "",
    tokenInput: 10,
    tokenOutput: 5,
    latencyMs: 1,
    finishReason: "stop",
    ...overrides,
  };
}

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
    assert.ok(
      settled.page.lastAiUpdatedAt,
      "expected lastAiUpdatedAt to be set",
    );
    assert.equal(settled.revision.sourceIngestionId, ingestionBody.id);
    assert.equal(settled.revision.sourceDecisionId, settled.decision.id);
    assert.equal(settled.triple.status, "active");
    assert.equal(settled.auditRows[0].entityType, "page");
  });

  it("executes an agent-mode create_page through revision, audit, and triples", async () => {
    const db = getDb();
    const auth = await createAuthContext(stack.app, "agent-execute");
    await db
      .update(workspaces)
      .set({ ingestionMode: "agent" })
      .where(eq(workspaces.id, auth.workspaceId));

    const ingestionResponse = await stack.app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${auth.workspaceId}/ingestions/text`,
      headers: authHeaders(auth.token),
      payload: {
        titleHint: "Agent Execute Smoke",
        content:
          "# Agent Execute Smoke\n\n[E2E_AGENT_CREATE] should be owned by the ingestion agent.",
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
        const [agentRun] = await db
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.ingestionId, ingestionBody.id))
          .limit(1);
        const decisionRows = await db
          .select()
          .from(ingestionDecisions)
          .where(eq(ingestionDecisions.ingestionId, ingestionBody.id));
        const decision = decisionRows[0];

        if (
          !ingestion ||
          ingestion.status !== "completed" ||
          !agentRun ||
          agentRun.status !== "completed" ||
          decisionRows.length !== 1 ||
          !decision ||
          decision.status !== "auto_applied" ||
          !decision.targetPageId ||
          !decision.proposedRevisionId ||
          decision.agentRunId !== agentRun.id
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

        return {
          agentRun,
          auditRows,
          decision,
          ingestion,
          page,
          revision,
          triple,
        };
      },
      {
        timeoutMs: 20_000,
        description: "agent execute create_page settlement",
      },
    );

    assert.equal(settled.agentRun.decisionsCount, 1);
    assert.equal(settled.page.title, "E2E Agent Page");
    assert.equal(settled.page.currentRevisionId, settled.revision.id);
    assert.equal(settled.revision.sourceIngestionId, ingestionBody.id);
    assert.equal(settled.revision.sourceDecisionId, settled.decision.id);
    assert.equal(settled.decision.agentRunId, settled.agentRun.id);
    assert.equal(settled.auditRows[0].modelRunId, settled.revision.modelRunId);
    assert.equal(settled.triple.status, "active");
  });

  it("downgrades an agent direct patch when a human edit lands after observation", async () => {
    const db = getDb();
    const auth = await createAuthContext(stack.app, "agent-conflict");
    const [token] = await db
      .insert(apiTokens)
      .values({
        workspaceId: auth.workspaceId,
        createdByUserId: auth.userId,
        name: "agent-conflict-token",
        tokenHash: randomUUID(),
      })
      .returning({ id: apiTokens.id });
    const [ingestion] = await db
      .insert(ingestions)
      .values({
        workspaceId: auth.workspaceId,
        apiTokenId: token.id,
        sourceName: "agent-conflict",
        idempotencyKey: randomUUID(),
        contentType: "text/markdown",
        titleHint: "Redis update",
        rawPayload: { content: "Cache uses Dragonfly." },
        normalizedText: "Cache uses Dragonfly.",
      })
      .returning();
    const [page] = await db
      .insert(pages)
      .values({
        workspaceId: auth.workspaceId,
        title: "Redis",
        slug: "redis",
      })
      .returning();
    await db.insert(pagePaths).values({
      workspaceId: auth.workspaceId,
      pageId: page.id,
      path: "redis",
      isCurrent: true,
    });
    const [baseRevision] = await db
      .insert(pageRevisions)
      .values({
        pageId: page.id,
        actorType: "user",
        source: "editor",
        contentMd: "# Redis\n\nCache uses Redis.",
        revisionNote: "Seed Redis page",
      })
      .returning();
    await db
      .update(pages)
      .set({ currentRevisionId: baseRevision.id })
      .where(eq(pages.id, page.id));
    const [agentRun] = await db
      .insert(agentRuns)
      .values({
        ingestionId: ingestion.id,
        workspaceId: auth.workspaceId,
        status: "running",
        stepsJson: [],
      })
      .returning();

    const tools: Record<string, AgentToolDefinition> = {
      read_page: {
        name: "read_page",
        description: "observe Redis then simulate a concurrent human edit",
        schema: agentReadToolInputSchemas.read_page,
        async execute() {
          const [humanRevision] = await db
            .insert(pageRevisions)
            .values({
              pageId: page.id,
              baseRevisionId: baseRevision.id,
              actorUserId: auth.userId,
              actorType: "user",
              source: "editor",
              contentMd: "# Redis\n\nCache uses Redis.\n\nHuman note.",
              revisionNote: "Concurrent human edit",
            })
            .returning();
          await db
            .update(pages)
            .set({ currentRevisionId: humanRevision.id })
            .where(eq(pages.id, page.id));
          return {
            data: {
              page: {
                id: page.id,
                title: page.title,
                currentRevisionId: baseRevision.id,
              },
              revision: { id: baseRevision.id },
              format: "markdown",
              contentMd: "# Redis\n\nCache uses Redis.",
            },
            observedPageIds: [page.id],
            observedPageRevisions: [
              { pageId: page.id, revisionId: baseRevision.id },
            ],
          };
        },
      },
    };
    const adapter = new SequenceAdapter([
      response({
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call_0_read_page",
            name: "read_page",
            arguments: { pageId: page.id, format: "markdown" },
          },
        ],
      }),
      response({ content: "Enough context." }),
      response({
        content: JSON.stringify({
          summary: "Patch Redis cache note.",
          proposedPlan: [
            {
              action: "update",
              targetPageId: page.id,
              confidence: 0.95,
              reason: "Dragonfly replaces the old cache note.",
              tool: "replace_in_page",
              args: {
                pageId: page.id,
                find: "Cache uses Redis.",
                replace: "Cache uses Dragonfly.",
                confidence: 0.95,
                reason: "Dragonfly replaces the old cache note.",
              },
              evidence: [],
            },
          ],
          openQuestions: [],
        }),
      }),
    ]);
    let modelRunCount = 0;

    const result = await runIngestionAgentShadow({
      db,
      workspaceId: auth.workspaceId,
      ingestion,
      mode: "agent",
      agentRunId: agentRun.id,
      adapter,
      baseProvider: "openai",
      baseModel: "gpt-5.4",
      tools,
      recordModelRun: async (record) => {
        modelRunCount += 1;
        const [modelRun] = await db
          .insert(modelRuns)
          .values({
            workspaceId: auth.workspaceId,
            provider: record.request.provider,
            modelName: record.request.model,
            mode: record.request.mode,
            promptVersion: record.request.promptVersion,
            tokenInput: record.response?.tokenInput ?? 0,
            tokenOutput: record.response?.tokenOutput ?? 0,
            latencyMs: record.response?.latencyMs ?? 0,
            status: record.status,
            agentRunId: agentRun.id,
            requestMetaJson: record.requestMetaJson,
            responseMetaJson: record.responseMetaJson,
          })
          .returning({ id: modelRuns.id });
        return { id: modelRun.id };
      },
    });

    const [decision] = await db
      .select()
      .from(ingestionDecisions)
      .where(eq(ingestionDecisions.agentRunId, agentRun.id))
      .limit(1);
    const [currentPage] = await db
      .select()
      .from(pages)
      .where(eq(pages.id, page.id))
      .limit(1);
    const [proposedRevision] = await db
      .select()
      .from(pageRevisions)
      .where(eq(pageRevisions.id, decision.proposedRevisionId))
      .limit(1);

    assert.equal(result.status, "completed");
    assert.equal(result.decisionsCount, 1);
    assert.equal(modelRunCount, 3);
    assert.equal(decision.status, "suggested");
    assert.equal(decision.agentRunId, agentRun.id);
    assert.equal(
      currentPage.currentRevisionId,
      proposedRevision.baseRevisionId,
    );
    assert.notEqual(currentPage.currentRevisionId, proposedRevision.id);
    assert.match(
      JSON.stringify(decision.rationaleJson),
      /conflict_with_human_edit/,
    );
  });
});
