import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { agentRuns, modelRuns, workspaces } from "@wekiflow/db";
import {
  AGENT_LIMITS,
  AI_MODELS,
  agentTraceChannel,
  agentRunTraceEventSchema,
  getAgentModelProvider,
  normalizeAIModelId,
  type AIProvider,
  type AgentRunDto,
  type AgentRunTraceStep,
  type WorkspaceRole,
} from "@wekiflow/shared";
import {
  ADMIN_PLUS_ROLES,
  forbidden,
  getMemberRole,
  insufficientRole,
  workspaceParamsSchema,
} from "../../lib/workspace-auth.js";
import { sendValidationError } from "../../lib/reply-helpers.js";
import {
  evaluateAgentParityGate,
  listAgentParityDailyRows,
  readAgentParityGateCriteriaForWorkspace,
} from "../../lib/agent-parity-gate.js";

const agentRunParamsSchema = workspaceParamsSchema.extend({
  agentRunId: z.string().uuid(),
});

const listQuerySchema = z.object({
  ingestionId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const diagnosticsQuerySchema = z.object({
  sinceDays: z.coerce.number().int().min(1).max(30).default(7),
});

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAgentProvider(
  value: string | null | undefined,
): AIProvider | null {
  return value === "openai" || value === "gemini" ? value : null;
}

function defaultProviderFromEnv(env: NodeJS.ProcessEnv): AIProvider | null {
  if (env["AI_TEST_MODE"] === "mock") return "openai";
  if (env["OPENAI_API_KEY"]) return "openai";
  if (env["GEMINI_API_KEY"]) return "gemini";
  return null;
}

function defaultModelForProvider(
  provider: AIProvider,
  env: NodeJS.ProcessEnv,
): { model: string; source: "env" | "mock" | "default" } {
  if (env["AI_TEST_MODE"] === "mock") {
    return { model: "mock-e2e", source: "mock" };
  }
  if (provider === "gemini") {
    return {
      model: normalizeAIModelId(
        env["GEMINI_MODEL"] ?? AI_MODELS.GEMINI_DEFAULT,
      ),
      source: env["GEMINI_MODEL"] ? "env" : "default",
    };
  }
  return {
    model: normalizeAIModelId(env["OPENAI_MODEL"] ?? AI_MODELS.OPENAI_DEFAULT),
    source: env["OPENAI_MODEL"] ? "env" : "default",
  };
}

function agentModelOverrideForProvider(
  model: string | null | undefined,
  provider: AIProvider | null,
): string | null {
  if (!model || !provider) return null;
  const modelProvider = getAgentModelProvider(model);
  if (modelProvider && modelProvider !== provider) return null;
  return normalizeAIModelId(model);
}

function effectiveAgentModelOverride(input: {
  workspaceModel: string | null | undefined;
  envModel: string | undefined;
  provider: AIProvider | null;
}): { model: string | null; source: "workspace" | "env" | "unset" } {
  if (input.workspaceModel) {
    const model = agentModelOverrideForProvider(
      input.workspaceModel,
      input.provider,
    );
    return model
      ? { model, source: "workspace" }
      : { model: null, source: "unset" };
  }

  const model = agentModelOverrideForProvider(input.envModel, input.provider);
  return model ? { model, source: "env" } : { model: null, source: "unset" };
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function rowsArray<T extends Record<string, unknown>>(rows: unknown): T[] {
  const arr = (rows as { rows?: T[] }).rows ?? (rows as T[] | undefined) ?? [];
  return Array.isArray(arr) ? arr : [];
}

function toAgentRunDto(row: typeof agentRuns.$inferSelect): AgentRunDto {
  return {
    id: row.id,
    ingestionId: row.ingestionId,
    workspaceId: row.workspaceId,
    status: row.status as AgentRunDto["status"],
    plan: row.planJson ?? null,
    steps: Array.isArray(row.stepsJson)
      ? (row.stepsJson as AgentRunTraceStep[])
      : [],
    decisionsCount: row.decisionsCount,
    totalTokens: row.totalTokens,
    totalLatencyMs: row.totalLatencyMs,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

async function requireWorkspaceMember(
  request: FastifyRequest,
  reply: FastifyReply,
  workspaceId: string,
): Promise<WorkspaceRole | null> {
  const role = await getMemberRole(
    request.server.db,
    workspaceId,
    request.user.sub,
  );
  if (!role) {
    forbidden(reply);
    return null;
  }
  return role;
}

async function requireWorkspaceAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  workspaceId: string,
): Promise<boolean> {
  const role = await requireWorkspaceMember(request, reply, workspaceId);
  if (!role) return false;
  if (!ADMIN_PLUS_ROLES.includes(role)) {
    insufficientRole(reply);
    return false;
  }
  return true;
}

const agentRunRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      if (!params.success)
        return sendValidationError(reply, params.error.issues);
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) return sendValidationError(reply, query.error.issues);

      const { workspaceId } = params.data;
      if (!(await requireWorkspaceMember(request, reply, workspaceId))) return;

      const conditions = [eq(agentRuns.workspaceId, workspaceId)];
      if (query.data.ingestionId) {
        conditions.push(eq(agentRuns.ingestionId, query.data.ingestionId));
      }

      const rows = await fastify.db
        .select()
        .from(agentRuns)
        .where(and(...conditions))
        .orderBy(desc(agentRuns.startedAt))
        .limit(query.data.limit);

      return reply.send({ data: rows.map(toAgentRunDto), total: rows.length });
    },
  );

  fastify.get(
    "/diagnostics",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      if (!params.success)
        return sendValidationError(reply, params.error.issues);
      const query = diagnosticsQuerySchema.safeParse(request.query);
      if (!query.success) return sendValidationError(reply, query.error.issues);

      const { workspaceId } = params.data;
      if (!(await requireWorkspaceAdmin(request, reply, workspaceId))) return;
      const { sinceDays } = query.data;

      const aggregateRows = rowsArray<{
        agentRunCount: number | string | null;
        comparableCount: number | string | null;
        actionMatches: number | string | null;
        targetMatches: number | string | null;
        fullMatches: number | string | null;
        actionAgreementRate: number | string | null;
        targetPageAgreementRate: number | string | null;
        fullAgreementRate: number | string | null;
        totalAgentTokens: number | string | null;
      }>(
        await fastify.db.execute(sql`
          WITH latest_agent AS (
            SELECT DISTINCT ON (ar.ingestion_id)
              ar.id AS agent_run_id,
              ar.workspace_id,
              ar.ingestion_id,
              ar.status,
              ar.plan_json,
              ar.decisions_count,
              ar.total_tokens,
              ar.started_at,
              ar.completed_at
            FROM agent_runs ar
            WHERE ar.workspace_id = ${workspaceId}
              AND ar.status IN ('shadow', 'completed')
              AND ar.started_at >= now() - (${sinceDays}::int * interval '1 day')
            ORDER BY ar.ingestion_id, ar.started_at DESC
          ),
          agent_first AS (
            SELECT
              la.agent_run_id,
              la.workspace_id,
              la.ingestion_id,
              la.status,
              la.decisions_count,
              la.total_tokens,
              la.started_at,
              la.plan_json #>> '{proposedPlan,0,action}' AS agent_action,
              NULLIF(la.plan_json #>> '{proposedPlan,0,targetPageId}', '') AS agent_target_page_id
            FROM latest_agent la
          ),
          classic_first AS (
            SELECT DISTINCT ON (d.ingestion_id)
              d.ingestion_id,
              d.action AS classic_action,
              d.target_page_id::text AS classic_target_page_id,
              d.status AS classic_status
            FROM ingestion_decisions d
            INNER JOIN ingestions i ON i.id = d.ingestion_id
            WHERE i.workspace_id = ${workspaceId}
              AND d.agent_run_id IS NULL
            ORDER BY d.ingestion_id, d.created_at ASC
          )
          SELECT
            count(*)::int AS "agentRunCount",
            count(cf.ingestion_id)::int AS "comparableCount",
            count(*) FILTER (
              WHERE cf.ingestion_id IS NOT NULL
                AND af.agent_action = cf.classic_action
            )::int AS "actionMatches",
            count(*) FILTER (
              WHERE cf.ingestion_id IS NOT NULL
                AND af.agent_target_page_id IS NOT DISTINCT FROM cf.classic_target_page_id
            )::int AS "targetMatches",
            count(*) FILTER (
              WHERE cf.ingestion_id IS NOT NULL
                AND af.agent_action = cf.classic_action
                AND af.agent_target_page_id IS NOT DISTINCT FROM cf.classic_target_page_id
            )::int AS "fullMatches",
            CASE WHEN count(cf.ingestion_id) = 0 THEN NULL ELSE
              count(*) FILTER (
                WHERE cf.ingestion_id IS NOT NULL
                  AND af.agent_action = cf.classic_action
              )::float / count(cf.ingestion_id)::float
            END AS "actionAgreementRate",
            CASE WHEN count(cf.ingestion_id) = 0 THEN NULL ELSE
              count(*) FILTER (
                WHERE cf.ingestion_id IS NOT NULL
                  AND af.agent_target_page_id IS NOT DISTINCT FROM cf.classic_target_page_id
              )::float / count(cf.ingestion_id)::float
            END AS "targetPageAgreementRate",
            CASE WHEN count(cf.ingestion_id) = 0 THEN NULL ELSE
              count(*) FILTER (
                WHERE cf.ingestion_id IS NOT NULL
                  AND af.agent_action = cf.classic_action
                  AND af.agent_target_page_id IS NOT DISTINCT FROM cf.classic_target_page_id
              )::float / count(cf.ingestion_id)::float
            END AS "fullAgreementRate",
            coalesce(sum(af.total_tokens), 0)::int AS "totalAgentTokens"
          FROM agent_first af
          LEFT JOIN classic_first cf ON cf.ingestion_id = af.ingestion_id
        `),
      );

      const mismatchRows = rowsArray<{
        agentRunId: string;
        ingestionId: string;
        startedAt: string | Date;
        agentAction: string | null;
        classicAction: string | null;
        agentTargetPageId: string | null;
        classicTargetPageId: string | null;
        titleHint: string | null;
        sourceName: string;
      }>(
        await fastify.db.execute(sql`
          WITH latest_agent AS (
            SELECT DISTINCT ON (ar.ingestion_id)
              ar.id AS agent_run_id,
              ar.ingestion_id,
              ar.plan_json,
              ar.started_at
            FROM agent_runs ar
            WHERE ar.workspace_id = ${workspaceId}
              AND ar.status IN ('shadow', 'completed')
              AND ar.started_at >= now() - (${sinceDays}::int * interval '1 day')
            ORDER BY ar.ingestion_id, ar.started_at DESC
          ),
          agent_first AS (
            SELECT
              la.agent_run_id,
              la.ingestion_id,
              la.started_at,
              la.plan_json #>> '{proposedPlan,0,action}' AS agent_action,
              NULLIF(la.plan_json #>> '{proposedPlan,0,targetPageId}', '') AS agent_target_page_id
            FROM latest_agent la
          ),
          classic_first AS (
            SELECT DISTINCT ON (d.ingestion_id)
              d.ingestion_id,
              d.action AS classic_action,
              d.target_page_id::text AS classic_target_page_id
            FROM ingestion_decisions d
            INNER JOIN ingestions i ON i.id = d.ingestion_id
            WHERE i.workspace_id = ${workspaceId}
              AND d.agent_run_id IS NULL
            ORDER BY d.ingestion_id, d.created_at ASC
          )
          SELECT
            af.agent_run_id AS "agentRunId",
            af.ingestion_id AS "ingestionId",
            af.started_at AS "startedAt",
            af.agent_action AS "agentAction",
            cf.classic_action AS "classicAction",
            af.agent_target_page_id AS "agentTargetPageId",
            cf.classic_target_page_id AS "classicTargetPageId",
            i.title_hint AS "titleHint",
            i.source_name AS "sourceName"
          FROM agent_first af
          INNER JOIN ingestions i ON i.id = af.ingestion_id
          LEFT JOIN classic_first cf ON cf.ingestion_id = af.ingestion_id
          WHERE cf.ingestion_id IS NULL
            OR af.agent_action IS DISTINCT FROM cf.classic_action
            OR af.agent_target_page_id IS DISTINCT FROM cf.classic_target_page_id
          ORDER BY af.started_at DESC
          LIMIT 20
        `),
      );

      const [tokenRow] = await fastify.db
        .select({
          used: sql<number>`coalesce(sum(coalesce(${modelRuns.tokenInput}, 0) + coalesce(${modelRuns.tokenOutput}, 0)), 0)::int`,
        })
        .from(modelRuns)
        .where(
          and(
            eq(modelRuns.workspaceId, workspaceId),
            eq(modelRuns.mode, "agent_plan"),
            gte(modelRuns.createdAt, startOfUtcDay()),
          ),
        );

      const [workspaceSettings] = await fastify.db
        .select({
          agentProvider: workspaces.agentProvider,
          agentModelFast: workspaces.agentModelFast,
          agentModelLargeContext: workspaces.agentModelLargeContext,
          agentFastThresholdTokens: workspaces.agentFastThresholdTokens,
          agentDailyTokenCap: workspaces.agentDailyTokenCap,
        })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);

      const a = aggregateRows[0] ?? {};
      const dailyCap = parsePositiveInt(
        process.env["AGENT_WORKSPACE_DAILY_TOKEN_CAP"],
        AGENT_LIMITS.WORKSPACE_DAILY_TOKEN_CAP,
      );
      const effectiveDailyCap =
        workspaceSettings?.agentDailyTokenCap ?? dailyCap;
      const effectiveFastThreshold =
        workspaceSettings?.agentFastThresholdTokens ??
        parsePositiveInt(process.env["AGENT_FAST_THRESHOLD_TOKENS"], 50_000);
      const envProvider = parseAgentProvider(process.env["AGENT_PROVIDER"]);
      const baseProvider = defaultProviderFromEnv(process.env);
      const effectiveProvider =
        parseAgentProvider(workspaceSettings?.agentProvider) ??
        envProvider ??
        baseProvider;
      const defaultModel = effectiveProvider
        ? defaultModelForProvider(effectiveProvider, process.env)
        : null;
      const effectiveFastModel = effectiveAgentModelOverride({
        workspaceModel: workspaceSettings?.agentModelFast,
        envModel: process.env["AGENT_MODEL_FAST"],
        provider: effectiveProvider,
      });
      const effectiveLargeContextModel = effectiveAgentModelOverride({
        workspaceModel: workspaceSettings?.agentModelLargeContext,
        envModel: process.env["AGENT_MODEL_LARGE_CONTEXT"],
        provider: effectiveProvider,
      });
      const gateCriteria = await readAgentParityGateCriteriaForWorkspace(
        fastify.db,
        workspaceId,
      );
      const dailyAgreement = await listAgentParityDailyRows(
        fastify.db,
        workspaceId,
        Math.max(sinceDays, gateCriteria.minObservedDays),
      );
      const gateAgreement =
        sinceDays <= gateCriteria.minObservedDays
          ? dailyAgreement
          : await listAgentParityDailyRows(
              fastify.db,
              workspaceId,
              gateCriteria.minObservedDays,
            );
      const gate = evaluateAgentParityGate(gateAgreement, gateCriteria);

      return reply.send({
        sinceDays,
        agreement: {
          agentRunCount: Number(a.agentRunCount ?? 0),
          comparableCount: Number(a.comparableCount ?? 0),
          actionMatches: Number(a.actionMatches ?? 0),
          targetMatches: Number(a.targetMatches ?? 0),
          fullMatches: Number(a.fullMatches ?? 0),
          actionAgreementRate:
            a.actionAgreementRate == null
              ? null
              : Number(a.actionAgreementRate),
          targetPageAgreementRate:
            a.targetPageAgreementRate == null
              ? null
              : Number(a.targetPageAgreementRate),
          fullAgreementRate:
            a.fullAgreementRate == null ? null : Number(a.fullAgreementRate),
          totalAgentTokens: Number(a.totalAgentTokens ?? 0),
        },
        dailyTokenUsage: {
          used: Number(tokenRow?.used ?? 0),
          cap: effectiveDailyCap,
          remaining: Math.max(
            0,
            effectiveDailyCap - Number(tokenRow?.used ?? 0),
          ),
        },
        agentSettings: {
          provider: workspaceSettings?.agentProvider ?? null,
          modelFast: workspaceSettings?.agentModelFast ?? null,
          modelLargeContext: workspaceSettings?.agentModelLargeContext ?? null,
          fastThresholdTokens:
            workspaceSettings?.agentFastThresholdTokens ?? null,
          dailyTokenCap: workspaceSettings?.agentDailyTokenCap ?? null,
          effective: {
            provider: effectiveProvider,
            modelFast: effectiveFastModel.model,
            modelLargeContext: effectiveLargeContextModel.model,
            fastThresholdTokens: effectiveFastThreshold,
            dailyTokenCap: effectiveDailyCap,
          },
        },
        currentModels: {
          provider: effectiveProvider,
          providerSource: workspaceSettings?.agentProvider
            ? "workspace"
            : envProvider
              ? "env"
              : baseProvider
                ? process.env["AI_TEST_MODE"] === "mock"
                  ? "mock"
                  : "default"
                : "unconfigured",
          baseModel: defaultModel?.model ?? null,
          baseModelSource: defaultModel?.source ?? "unconfigured",
          fastModel: effectiveFastModel.model,
          fastModelSource: effectiveFastModel.source,
          largeContextModel: effectiveLargeContextModel.model,
          largeContextModelSource: effectiveLargeContextModel.source,
          fastThresholdTokens: effectiveFastThreshold,
          fastThresholdSource: workspaceSettings?.agentFastThresholdTokens
            ? "workspace"
            : process.env["AGENT_FAST_THRESHOLD_TOKENS"]
              ? "env"
              : "default",
          dailyTokenCap: effectiveDailyCap,
          dailyTokenCapSource: workspaceSettings?.agentDailyTokenCap
            ? "workspace"
            : process.env["AGENT_WORKSPACE_DAILY_TOKEN_CAP"]
              ? "env"
              : "default",
        },
        dailyAgreement,
        gate,
        recentMismatches: mismatchRows.map((row) => ({
          agentRunId: row.agentRunId,
          ingestionId: row.ingestionId,
          startedAt: new Date(row.startedAt).toISOString(),
          agentAction: row.agentAction,
          classicAction: row.classicAction,
          agentTargetPageId: row.agentTargetPageId,
          classicTargetPageId: row.classicTargetPageId,
          titleHint: row.titleHint,
          sourceName: row.sourceName,
        })),
      });
    },
  );

  fastify.get(
    "/:agentRunId",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = agentRunParamsSchema.safeParse(request.params);
      if (!params.success)
        return sendValidationError(reply, params.error.issues);
      const { workspaceId, agentRunId } = params.data;
      if (!(await requireWorkspaceMember(request, reply, workspaceId))) return;

      const [row] = await fastify.db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, agentRunId),
            eq(agentRuns.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      if (!row) {
        return reply.code(404).send({
          error: "Not found",
          code: "NOT_FOUND",
          details: "Agent run not found",
        });
      }

      return reply.send(toAgentRunDto(row));
    },
  );

  fastify.get(
    "/:agentRunId/events",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const params = agentRunParamsSchema.safeParse(request.params);
      if (!params.success)
        return sendValidationError(reply, params.error.issues);
      const { workspaceId, agentRunId } = params.data;
      if (!(await requireWorkspaceMember(request, reply, workspaceId))) return;

      const [row] = await fastify.db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, agentRunId),
            eq(agentRuns.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      if (!row) {
        return reply.code(404).send({
          error: "Not found",
          code: "NOT_FOUND",
          details: "Agent run not found",
        });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const sendEvent = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const subscriber = fastify.redis.duplicate();
      const channel = agentTraceChannel(agentRunId);
      const heartbeat = setInterval(() => {
        reply.raw.write(": heartbeat\n\n");
      }, 15_000);

      const cleanup = async () => {
        clearInterval(heartbeat);
        subscriber.removeAllListeners("message");
        await subscriber.unsubscribe(channel).catch(() => undefined);
        await subscriber.quit().catch(() => undefined);
      };

      request.raw.on("close", () => {
        void cleanup();
      });

      subscriber.on("message", (_channel, message) => {
        let raw: unknown;
        try {
          raw = JSON.parse(message) as unknown;
        } catch {
          return;
        }
        const parsed = agentRunTraceEventSchema.safeParse(raw);
        if (!parsed.success) return;
        sendEvent(parsed.data.type, parsed.data);
      });

      await subscriber.subscribe(channel);
      const [latestRow] = await fastify.db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, agentRunId),
            eq(agentRuns.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      sendEvent("snapshot", {
        type: "snapshot",
        agentRun: toAgentRunDto(latestRow ?? row),
      });
    },
  );
};

export default agentRunRoutes;
