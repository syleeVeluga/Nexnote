import { Worker, type Job } from "bullmq";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  agentRuns,
  auditLogs,
  ingestionDecisions,
  ingestions,
  modelRuns,
  workspaces,
} from "@wekiflow/db";
import { getDb } from "@wekiflow/db/client";
import {
  agentTraceChannel,
  extractIngestionText,
  QUEUE_NAMES,
  AGENT_LIMITS,
  type IngestionAgentJobData,
  type IngestionAgentJobResult,
  type AgentRunDto,
  type AgentRunTraceEvent,
} from "@wekiflow/shared";
import { createRedisConnection } from "../connection.js";
import { createJobLogger } from "../logger.js";
import { getQueue } from "../queues.js";
import {
  AgentLoopTimeout,
  AgentWorkspaceTokenCapExceeded,
  runIngestionAgentShadow,
  type AgentModelRunRecord,
  type AgentWorkspaceTokenReservation,
  type AgentWorkspaceTokenReservationRequest,
} from "../lib/agent/loop.js";
import type { AgentRunTraceStep } from "../lib/agent/types.js";

function workerConcurrency(): number {
  const raw = process.env["AGENT_WORKER_CONCURRENCY"];
  const parsed = raw ? Number.parseInt(raw, 10) : 2;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
}

function errorStep(err: unknown): AgentRunTraceStep {
  return {
    step: 0,
    type: "error",
    ts: new Date().toISOString(),
    payload: {
      message: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : "Error",
    },
  };
}

function appendErrorStep(
  steps: AgentRunTraceStep[],
  err: unknown,
): AgentRunTraceStep[] {
  return [
    ...steps,
    {
      ...errorStep(err),
      step: steps.length,
    },
  ];
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildWorkspaceAgentEnv(
  workspace: {
    agentProvider: string | null;
    agentModelFast: string | null;
    agentModelLargeContext: string | null;
    agentFastThresholdTokens: number | null;
    agentDailyTokenCap: number | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  if (workspace.agentProvider) {
    next["AGENT_PROVIDER"] = workspace.agentProvider;
  }
  if (workspace.agentModelFast) {
    next["AGENT_MODEL_FAST"] = workspace.agentModelFast;
  }
  if (workspace.agentModelLargeContext) {
    next["AGENT_MODEL_LARGE_CONTEXT"] = workspace.agentModelLargeContext;
  }
  if (workspace.agentFastThresholdTokens) {
    next["AGENT_FAST_THRESHOLD_TOKENS"] = String(
      workspace.agentFastThresholdTokens,
    );
  }
  if (workspace.agentDailyTokenCap) {
    next["AGENT_WORKSPACE_DAILY_TOKEN_CAP"] = String(
      workspace.agentDailyTokenCap,
    );
  }
  return next;
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function msUntilNextUtcDay(now = new Date()): number {
  const nextDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return Math.max(1_000, nextDay - now.getTime());
}

function workspaceTokenReservationKey(
  workspaceId: string,
  now = new Date(),
): string {
  return `agent-runs:tokens:${workspaceId}:${now.toISOString().slice(0, 10)}`;
}

const RESERVE_WORKSPACE_TOKENS_LUA = `
local current = redis.call('GET', KEYS[1])
if not current then
  current = tonumber(ARGV[1]) or 0
  redis.call('SET', KEYS[1], tostring(current), 'PX', ARGV[4])
else
  current = tonumber(current) or 0
end

local amount = tonumber(ARGV[2]) or 0
local cap = tonumber(ARGV[3]) or 0
if current + amount > cap then
  return {0, current}
end

local next_value = current + amount
redis.call('SET', KEYS[1], tostring(next_value), 'PX', ARGV[4])
return {1, next_value}
`;

const ADJUST_WORKSPACE_TOKENS_LUA = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
local delta = tonumber(ARGV[1]) or 0
local next_value = current + delta
if next_value < 0 then
  next_value = 0
end
redis.call('SET', KEYS[1], tostring(next_value), 'PX', ARGV[2])
return next_value
`;

async function loadWorkspaceAgentTokensToday(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(coalesce(${modelRuns.tokenInput}, 0) + coalesce(${modelRuns.tokenOutput}, 0)), 0)::int`,
    })
    .from(modelRuns)
    .where(
      and(
        eq(modelRuns.workspaceId, workspaceId),
        eq(modelRuns.mode, "agent_plan"),
        gte(modelRuns.createdAt, startOfUtcDay()),
      ),
    );
  return Number(row?.total ?? 0);
}

function parseLuaNumberPair(result: unknown): [number, number] {
  if (!Array.isArray(result)) return [0, 0];
  return [Number(result[0] ?? 0), Number(result[1] ?? 0)];
}

async function reserveWorkspaceAgentTokens(
  redis: ReturnType<typeof createRedisConnection>,
  workspaceId: string,
  request: AgentWorkspaceTokenReservationRequest,
): Promise<AgentWorkspaceTokenReservation | null> {
  const reservedTokens = Math.max(1, Math.ceil(request.estimatedTokens));
  const key = workspaceTokenReservationKey(workspaceId);
  const ttlMs = msUntilNextUtcDay();
  const [ok, usedAfterReservation] = parseLuaNumberPair(
    await redis.eval(
      RESERVE_WORKSPACE_TOKENS_LUA,
      1,
      key,
      String(request.usedToday),
      String(reservedTokens),
      String(request.cap),
      String(ttlMs),
    ),
  );
  if (ok !== 1) return null;

  return {
    reservedTokens,
    usedAfterReservation,
    release: async (actualTokens: number) => {
      const delta = Math.ceil(actualTokens) - reservedTokens;
      if (delta === 0) return;
      await redis.eval(
        ADJUST_WORKSPACE_TOKENS_LUA,
        1,
        key,
        String(delta),
        String(msUntilNextUtcDay()),
      );
    },
  };
}

async function appendAgentRunStep(
  db: ReturnType<typeof getDb>,
  agentRunId: string,
  step: AgentRunTraceStep,
): Promise<void> {
  await db
    .update(agentRuns)
    .set({
      stepsJson: sql`coalesce(${agentRuns.stepsJson}, '[]'::jsonb) || ${JSON.stringify([step])}::jsonb`,
    })
    .where(eq(agentRuns.id, agentRunId));
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

async function publishAgentRunEvent(
  redis: ReturnType<typeof createRedisConnection>,
  agentRunId: string,
  event: AgentRunTraceEvent,
): Promise<void> {
  await redis
    .publish(agentTraceChannel(agentRunId), JSON.stringify(event))
    .catch(() => undefined);
}

async function loadAgentDecisionStats(
  db: ReturnType<typeof getDb>,
  agentRunId: string,
): Promise<{
  autoAppliedCount: number;
  queuedCount: number;
  failedCount: number;
}> {
  const rows = await db
    .select({
      status: ingestionDecisions.status,
      count: sql<number>`count(*)::int`,
    })
    .from(ingestionDecisions)
    .where(eq(ingestionDecisions.agentRunId, agentRunId))
    .groupBy(ingestionDecisions.status);

  let autoAppliedCount = 0;
  let queuedCount = 0;
  let failedCount = 0;
  for (const row of rows) {
    const count = Number(row.count ?? 0);
    if (row.status === "auto_applied") {
      autoAppliedCount += count;
    } else if (row.status === "suggested" || row.status === "needs_review") {
      queuedCount += count;
    } else if (row.status === "failed") {
      failedCount += count;
      queuedCount += count;
    }
  }

  return { autoAppliedCount, queuedCount, failedCount };
}

async function recordAgentRunCompletedActivity(
  db: ReturnType<typeof getDb>,
  input: {
    workspaceId: string;
    ingestionId: string;
    sourceName: string;
    agentRunId: string;
    status: string;
    proposedMutations: number;
    decisionsCount: number;
    totalTokens: number;
    totalLatencyMs: number;
    completedAt: Date | null;
  },
): Promise<void> {
  const [latestModelRun, stats] = await Promise.all([
    db
      .select({ id: modelRuns.id })
      .from(modelRuns)
      .where(eq(modelRuns.agentRunId, input.agentRunId))
      .orderBy(desc(modelRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    loadAgentDecisionStats(db, input.agentRunId),
  ]);

  await db.insert(auditLogs).values({
    workspaceId: input.workspaceId,
    userId: null,
    modelRunId: latestModelRun?.id ?? null,
    entityType: "ingestion",
    entityId: input.ingestionId,
    action: "agent_run_completed",
    afterJson: {
      source: "ingestion_agent",
      agentRunId: input.agentRunId,
      ingestionId: input.ingestionId,
      sourceName: input.sourceName,
      status: input.status,
      proposedMutations: input.proposedMutations,
      decisionsCount: input.decisionsCount,
      autoAppliedCount: stats.autoAppliedCount,
      queuedCount: stats.queuedCount,
      failedCount: stats.failedCount,
      totalTokens: input.totalTokens,
      totalLatencyMs: input.totalLatencyMs,
    },
    createdAt: input.completedAt ?? new Date(),
  });
}

export function createIngestionAgentWorker(): Worker {
  const db = getDb();
  const tracePublisher = createRedisConnection();

  const worker = new Worker<IngestionAgentJobData, IngestionAgentJobResult>(
    QUEUE_NAMES.INGESTION_AGENT,
    async (job: Job<IngestionAgentJobData>) => {
      const { ingestionId, workspaceId } = job.data;
      const log = createJobLogger("ingestion-agent", job.id);
      const runMode = job.data.mode;
      const completedStatus = runMode === "agent" ? "completed" : "shadow";
      log.info({ ingestionId, runMode }, "Processing ingestion agent run");

      await job.updateProgress(5);

      const [ingestion] = await db
        .select()
        .from(ingestions)
        .where(
          and(
            eq(ingestions.id, ingestionId),
            eq(ingestions.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      if (!ingestion) {
        throw new Error(`Ingestion ${ingestionId} not found`);
      }

      const [workspace] = await db
        .select({
          id: workspaces.id,
          agentInstructions: workspaces.agentInstructions,
          agentProvider: workspaces.agentProvider,
          agentModelFast: workspaces.agentModelFast,
          agentModelLargeContext: workspaces.agentModelLargeContext,
          agentFastThresholdTokens: workspaces.agentFastThresholdTokens,
          agentDailyTokenCap: workspaces.agentDailyTokenCap,
        })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);

      if (!workspace) {
        throw new Error(`Workspace ${workspaceId} not found`);
      }

      const [existingComplete] = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.ingestionId, ingestionId),
            eq(agentRuns.workspaceId, workspaceId),
            eq(agentRuns.status, completedStatus),
          ),
        )
        .orderBy(desc(agentRuns.startedAt))
        .limit(1);

      if (existingComplete) {
        log.info(
          { agentRunId: existingComplete.id },
          "Ingestion agent run already completed",
        );
        await job.updateProgress(100);
        return {
          ingestionId,
          agentRunId: existingComplete.id,
          status: completedStatus,
          proposedMutations: existingComplete.decisionsCount,
          totalTokens: existingComplete.totalTokens,
        };
      }

      const [latestRun] = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.ingestionId, ingestionId),
            eq(agentRuns.workspaceId, workspaceId),
          ),
        )
        .orderBy(desc(agentRuns.startedAt))
        .limit(1);

      const [agentRun] = latestRun
        ? await db
            .update(agentRuns)
            .set({
              status: "running",
              planJson: null,
              stepsJson: [],
              decisionsCount: 0,
              totalTokens: 0,
              totalLatencyMs: 0,
              startedAt: new Date(),
              completedAt: null,
            })
            .where(eq(agentRuns.id, latestRun.id))
            .returning()
        : await db
            .insert(agentRuns)
            .values({
              ingestionId,
              workspaceId,
              status: "running",
              stepsJson: [],
            })
            .returning();

      await job.updateProgress(15);
      await publishAgentRunEvent(tracePublisher, agentRun.id, {
        type: "snapshot",
        agentRun: toAgentRunDto(agentRun),
      });
      let stepFlush = Promise.resolve();
      const emitLiveStep = (step: AgentRunTraceStep): Promise<void> => {
        stepFlush = stepFlush
          .catch(() => undefined)
          .then(async () => {
            await appendAgentRunStep(db, agentRun.id, step);
            await publishAgentRunEvent(tracePublisher, agentRun.id, {
              type: "step",
              step,
            });
          });
        return stepFlush;
      };
      const flushLiveSteps = async (): Promise<void> => {
        await stepFlush.catch(() => undefined);
      };

      let normalizedText = ingestion.normalizedText;
      if (!normalizedText) {
        normalizedText = extractIngestionText(ingestion);
        await db
          .update(ingestions)
          .set({ normalizedText })
          .where(
            and(
              eq(ingestions.id, ingestionId),
              sql`${ingestions.normalizedText} IS NULL`,
            ),
          );
      }

      if (runMode === "agent") {
        await db
          .update(ingestions)
          .set({ status: "processing" })
          .where(eq(ingestions.id, ingestionId));
      }

      const workspaceDailyTokenCap = parsePositiveInt(
        process.env["AGENT_WORKSPACE_DAILY_TOKEN_CAP"],
        AGENT_LIMITS.WORKSPACE_DAILY_TOKEN_CAP,
      );
      const effectiveWorkspaceDailyTokenCap =
        workspace.agentDailyTokenCap ?? workspaceDailyTokenCap;
      const workspaceAgentEnv = buildWorkspaceAgentEnv(workspace);
      const workspaceTokensUsedToday = await loadWorkspaceAgentTokensToday(
        db,
        workspaceId,
      );

      const recordModelRun = async (
        record: AgentModelRunRecord,
      ): Promise<{ id: string }> => {
        const [modelRun] = await db
          .insert(modelRuns)
          .values({
            workspaceId,
            provider: record.request.provider,
            modelName: record.request.model,
            mode: record.request.mode,
            promptVersion: record.request.promptVersion,
            tokenInput: record.response?.tokenInput ?? 0,
            tokenOutput: record.response?.tokenOutput ?? 0,
            latencyMs: record.response?.latencyMs ?? 0,
            status: record.status,
            agentRunId: agentRun.id,
            requestMetaJson: {
              ...record.requestMetaJson,
              jobId: job.id ?? null,
              toolCount: record.request.tools?.length ?? 0,
              toolChoice: record.request.toolChoice ?? null,
              budget: record.request.budgetMeta ?? null,
            },
            responseMetaJson: record.responseMetaJson,
          })
          .returning({ id: modelRuns.id });
        return { id: modelRun.id };
      };

      try {
        await job.updateProgress(25);
        const result = await runIngestionAgentShadow({
          db,
          workspaceId,
          ingestion: { ...ingestion, normalizedText },
          mode: runMode,
          agentRunId: agentRun.id,
          workspaceAgentInstructions: workspace.agentInstructions,
          workspaceTokenUsage: {
            usedToday: workspaceTokensUsedToday,
            cap: effectiveWorkspaceDailyTokenCap,
          },
          env: workspaceAgentEnv,
          reserveWorkspaceTokens: (reservationRequest) =>
            reserveWorkspaceAgentTokens(
              tracePublisher,
              workspaceId,
              reservationRequest,
            ),
          onStep: emitLiveStep,
          recordModelRun,
          mutationQueues:
            runMode === "agent"
              ? {
                  patchQueue: getQueue(QUEUE_NAMES.PATCH),
                  extractionQueue: getQueue(QUEUE_NAMES.EXTRACTION),
                  searchQueue: getQueue(QUEUE_NAMES.SEARCH),
                }
              : undefined,
        });

        await flushLiveSteps();
        const [completedRun] = await db
          .update(agentRuns)
          .set({
            status: result.status,
            planJson: result.planJson,
            stepsJson: result.steps,
            decisionsCount: result.decisionsCount,
            totalTokens: result.totalTokens,
            totalLatencyMs: result.totalLatencyMs,
            completedAt: new Date(),
          })
          .where(eq(agentRuns.id, agentRun.id))
          .returning();
        if (completedRun) {
          await publishAgentRunEvent(tracePublisher, agentRun.id, {
            type: "status",
            agentRun: toAgentRunDto(completedRun),
          });
          await recordAgentRunCompletedActivity(db, {
            workspaceId,
            ingestionId,
            sourceName: ingestion.sourceName,
            agentRunId: completedRun.id,
            status: completedRun.status,
            proposedMutations: result.planJson.proposedPlan.length,
            decisionsCount: completedRun.decisionsCount,
            totalTokens: completedRun.totalTokens,
            totalLatencyMs: completedRun.totalLatencyMs,
            completedAt: completedRun.completedAt,
          }).catch((err) => {
            log.warn(
              { err, agentRunId: completedRun.id },
              "Failed to write agent run activity",
            );
          });
        }

        if (runMode === "agent") {
          await db
            .update(ingestions)
            .set({ status: "completed", processedAt: new Date() })
            .where(eq(ingestions.id, ingestionId));
        }

        await job.updateProgress(100);

        return {
          ingestionId,
          agentRunId: agentRun.id,
          status: result.status,
          proposedMutations: result.decisionsCount,
          totalTokens: result.totalTokens,
        };
      } catch (err) {
        if (err instanceof AgentWorkspaceTokenCapExceeded) {
          await flushLiveSteps();
          const finalSteps = appendErrorStep(err.steps, err);
          const [failedRun] = await db
            .update(agentRuns)
            .set({
              status: "failed",
              stepsJson: finalSteps,
              totalTokens: err.totalTokens,
              totalLatencyMs: err.totalLatencyMs,
              completedAt: new Date(),
            })
            .where(eq(agentRuns.id, agentRun.id))
            .returning();

          if (failedRun) {
            await publishAgentRunEvent(tracePublisher, agentRun.id, {
              type: "status",
              agentRun: toAgentRunDto(failedRun),
            });
          }

          if (runMode === "agent") {
            await db
              .update(ingestions)
              .set({ status: "failed", processedAt: new Date() })
              .where(eq(ingestions.id, ingestionId));
          }

          await job.updateProgress(100);
          return {
            ingestionId,
            agentRunId: agentRun.id,
            status: "failed",
            proposedMutations: 0,
            totalTokens: err.totalTokens,
          };
        }

        if (err instanceof AgentLoopTimeout) {
          await flushLiveSteps();
          const [timeoutRun] = await db
            .update(agentRuns)
            .set({
              status: "timeout",
              stepsJson: appendErrorStep(err.steps, err),
              totalTokens: err.totalTokens,
              totalLatencyMs: err.totalLatencyMs,
              completedAt: new Date(),
            })
            .where(eq(agentRuns.id, agentRun.id))
            .returning();

          if (timeoutRun) {
            await publishAgentRunEvent(tracePublisher, agentRun.id, {
              type: "status",
              agentRun: toAgentRunDto(timeoutRun),
            });
          }

          if (runMode === "agent") {
            await db
              .update(ingestions)
              .set({ status: "failed", processedAt: new Date() })
              .where(eq(ingestions.id, ingestionId));
          }

          await job.updateProgress(100);
          return {
            ingestionId,
            agentRunId: agentRun.id,
            status: "timeout",
            proposedMutations: 0,
            totalTokens: err.totalTokens,
          };
        }

        await flushLiveSteps();
        const finalErrorStep = errorStep(err);
        const [failedRun] = await db
          .update(agentRuns)
          .set({
            status: "failed",
            stepsJson: sql`coalesce(${agentRuns.stepsJson}, '[]'::jsonb) || ${JSON.stringify([finalErrorStep])}::jsonb`,
            completedAt: new Date(),
          })
          .where(eq(agentRuns.id, agentRun.id))
          .returning();
        if (failedRun) {
          await publishAgentRunEvent(tracePublisher, agentRun.id, {
            type: "status",
            agentRun: toAgentRunDto(failedRun),
          });
        }
        if (runMode === "agent") {
          await db
            .update(ingestions)
            .set({ status: "failed", processedAt: new Date() })
            .where(eq(ingestions.id, ingestionId));
        }
        throw err;
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: workerConcurrency(),
    },
  );

  worker.on("completed", (job, result) => {
    const log = createJobLogger("ingestion-agent", job.id);
    log.info(
      {
        status: result.status,
        agentRunId: result.agentRunId,
        proposedMutations: result.proposedMutations,
      },
      "Ingestion agent shadow run completed",
    );
  });

  worker.on("failed", (job, err) => {
    const log = createJobLogger("ingestion-agent", job?.id);
    log.error({ err }, "Job failed");
  });

  worker.on("closed", () => {
    void tracePublisher.quit();
  });

  return worker;
}
