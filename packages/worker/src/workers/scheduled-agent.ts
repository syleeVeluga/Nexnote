import { Worker, type Job } from "bullmq";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  agentRuns,
  apiTokens,
  auditLogs,
  ingestions,
  ingestionDecisions,
  modelRuns,
  scheduledRuns,
  scheduledTasks,
  workspaces,
} from "@wekiflow/db";
import { getDb } from "@wekiflow/db/client";
import {
  AGENT_LIMITS,
  JOB_NAMES,
  QUEUE_NAMES,
  type AgentRunTraceEvent,
  type ScheduledAgentJobData,
  type ScheduledAgentJobResult,
} from "@wekiflow/shared";
import { createRedisConnection } from "../connection.js";
import { createJobLogger } from "../logger.js";
import { getQueue } from "../queues.js";
import {
  AgentLoopTimeout,
  AgentWorkspaceTokenCapExceeded,
  runIngestionAgentShadow,
  type AgentModelRunRecord,
} from "../lib/agent/loop.js";
import type { AgentRunTraceStep } from "../lib/agent/types.js";
import {
  buildScheduledAgentInput,
  type ScheduledAgentInput,
} from "../lib/scheduled/input-adapter.js";
import {
  appendAgentRunStep,
  buildWorkspaceAgentEnv,
  loadAgentDecisionStats,
  loadWorkspaceAgentTokensToday,
  parsePositiveInt,
  publishAgentRunEvent,
  reserveWorkspaceAgentTokens,
  toAgentRunDto,
} from "./ingestion-agent.js";

function workerConcurrency(): number {
  const raw = process.env["SCHEDULED_AGENT_WORKER_CONCURRENCY"];
  const parsed = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function errorStep(err: unknown): AgentRunTraceStep {
  const tokenCapDetails =
    err instanceof AgentWorkspaceTokenCapExceeded
      ? {
          cap: err.cap,
          usedToday: err.usedToday,
          totalTokens: err.totalTokens,
          remainingTokens: err.details.remainingTokens ?? null,
          estimatedTokens: err.details.estimatedTokens ?? null,
          phase: err.details.phase ?? null,
        }
      : {};
  return {
    step: 0,
    type: "error",
    ts: new Date().toISOString(),
    payload: {
      message: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : "Error",
      ...tokenCapDetails,
    },
  };
}

function appendErrorStep(
  steps: AgentRunTraceStep[],
  err: unknown,
): AgentRunTraceStep[] {
  return [...steps, { ...errorStep(err), step: steps.length }];
}

async function ensureInternalScheduledApiToken(input: {
  db: ReturnType<typeof getDb>;
  workspaceId: string;
  userId: string;
}): Promise<string> {
  const [existing] = await input.db
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.workspaceId, input.workspaceId),
        eq(apiTokens.name, "Scheduled Agent Internal"),
      ),
    )
    .orderBy(desc(apiTokens.createdAt))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await input.db
    .insert(apiTokens)
    .values({
      workspaceId: input.workspaceId,
      createdByUserId: input.userId,
      name: "Scheduled Agent Internal",
      sourceNameHint: "scheduled-agent",
      tokenHash: "internal:scheduled-agent:v1",
    })
    .returning({ id: apiTokens.id });
  return created.id;
}

async function ensureScheduledIngestion(input: {
  db: ReturnType<typeof getDb>;
  workspaceId: string;
  apiTokenId: string;
  scheduledRunId: string;
  taskId: string | null;
  normalizedText: string;
  instruction: string | null;
  pageIds: string[];
  includeDescendants: boolean;
}): Promise<typeof ingestions.$inferSelect> {
  const idempotencyKey = `scheduled-run:${input.scheduledRunId}`;
  const [existing] = await input.db
    .select()
    .from(ingestions)
    .where(
      and(
        eq(ingestions.workspaceId, input.workspaceId),
        eq(ingestions.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const [created] = await input.db
    .insert(ingestions)
    .values({
      workspaceId: input.workspaceId,
      apiTokenId: input.apiTokenId,
      sourceName: "scheduled-agent",
      externalRef: input.taskId,
      idempotencyKey,
      contentType: "text/markdown",
      titleHint: "Scheduled wiki reorganize",
      rawPayload: {
        source: "scheduled_agent",
        scheduledRunId: input.scheduledRunId,
        taskId: input.taskId,
        pageIds: input.pageIds,
        includeDescendants: input.includeDescendants,
        instruction: input.instruction,
      },
      normalizedText: input.normalizedText,
      status: "processing",
    })
    .returning();
  return created;
}

async function loadTokenTotals(
  db: ReturnType<typeof getDb>,
  agentRunId: string,
): Promise<{ tokensIn: number; tokensOut: number }> {
  const [row] = await db
    .select({
      tokensIn: sql<number>`coalesce(sum(${modelRuns.tokenInput}), 0)::int`,
      tokensOut: sql<number>`coalesce(sum(${modelRuns.tokenOutput}), 0)::int`,
    })
    .from(modelRuns)
    .where(eq(modelRuns.agentRunId, agentRunId));
  return {
    tokensIn: Number(row?.tokensIn ?? 0),
    tokensOut: Number(row?.tokensOut ?? 0),
  };
}

async function recordScheduledRunActivity(input: {
  db: ReturnType<typeof getDb>;
  workspaceId: string;
  scheduledRunId: string;
  taskId: string | null;
  agentRunId: string;
  status: string;
  decisionCount: number;
  totalTokens: number;
  completedAt: Date | null;
}): Promise<void> {
  const [latestModelRun, stats] = await Promise.all([
    input.db
      .select({ id: modelRuns.id })
      .from(modelRuns)
      .where(eq(modelRuns.agentRunId, input.agentRunId))
      .orderBy(desc(modelRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    loadAgentDecisionStats(input.db, input.agentRunId),
  ]);

  await input.db.insert(auditLogs).values({
    workspaceId: input.workspaceId,
    userId: null,
    modelRunId: latestModelRun?.id ?? null,
    entityType: "scheduled_run",
    entityId: input.scheduledRunId,
    action: "scheduled_agent_run_completed",
    afterJson: {
      source: "scheduled_agent",
      scheduledRunId: input.scheduledRunId,
      taskId: input.taskId,
      agentRunId: input.agentRunId,
      status: input.status,
      decisionsCount: input.decisionCount,
      autoAppliedCount: stats.autoAppliedCount,
      queuedCount: stats.queuedCount,
      failedCount: stats.failedCount,
      totalTokens: input.totalTokens,
    },
    createdAt: input.completedAt ?? new Date(),
  });
}

export function createScheduledAgentWorker(): Worker {
  const db = getDb();
  const tracePublisher = createRedisConnection();

  const worker = new Worker<ScheduledAgentJobData, ScheduledAgentJobResult>(
    QUEUE_NAMES.SCHEDULED_AGENT,
    async (job: Job<ScheduledAgentJobData>) => {
      const log = createJobLogger("scheduled-agent", job.id);
      const { workspaceId, triggeredBy } = job.data;
      log.info(
        { workspaceId, taskId: job.data.taskId ?? null, triggeredBy },
        "Processing scheduled agent run",
      );

      await job.updateProgress(5);

      const [workspace] = await db
        .select({
          id: workspaces.id,
          scheduledEnabled: workspaces.scheduledEnabled,
          scheduledAutoApply: workspaces.scheduledAutoApply,
          allowDestructiveScheduledAgent:
            workspaces.allowDestructiveScheduledAgent,
          scheduledDailyTokenCap: workspaces.scheduledDailyTokenCap,
          scheduledPerRunPageLimit: workspaces.scheduledPerRunPageLimit,
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
      if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);

      const task = job.data.taskId
        ? await db
            .select()
            .from(scheduledTasks)
            .where(
              and(
                eq(scheduledTasks.id, job.data.taskId),
                eq(scheduledTasks.workspaceId, workspaceId),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : null;
      if (job.data.taskId && !task) {
        throw new Error(`Scheduled task ${job.data.taskId} not found`);
      }

      const scheduledRun = job.data.scheduledRunId
        ? await db
            .update(scheduledRuns)
            .set({
              status: "running",
              startedAt: new Date(),
              completedAt: null,
            })
            .where(
              and(
                eq(scheduledRuns.id, job.data.scheduledRunId),
                eq(scheduledRuns.workspaceId, workspaceId),
              ),
            )
            .returning()
            .then((rows) => rows[0])
        : await db
            .insert(scheduledRuns)
            .values({
              taskId: task?.id ?? null,
              workspaceId,
              triggeredBy,
              status: "running",
            })
            .returning()
            .then((rows) => rows[0]);
      if (!scheduledRun) {
        throw new Error(`Scheduled run ${job.data.scheduledRunId} not found`);
      }

      const skippedReason =
        job.data.triggeredBy === "cron" && task && !task.enabled
          ? "task_disabled"
          : job.data.triggeredBy === "cron" && !workspace.scheduledEnabled
            ? "workspace_scheduled_disabled"
            : null;
      if (skippedReason) {
        const completedAt = new Date();
        await db
          .update(scheduledRuns)
          .set({
            status: "completed",
            decisionCount: 0,
            tokensIn: 0,
            tokensOut: 0,
            diagnosticsJson: { skippedReason },
            completedAt,
          })
          .where(eq(scheduledRuns.id, scheduledRun.id));
        await job.updateProgress(100);
        return {
          scheduledRunId: scheduledRun.id,
          agentRunId: null,
          status: "completed",
          decisionCount: 0,
          totalTokens: 0,
        };
      }

      const runInput: ScheduledAgentInput = {
        pageIds: job.data.pageIds ?? task?.targetPageIds ?? [],
        includeDescendants:
          job.data.includeDescendants ?? task?.includeDescendants ?? true,
        instruction: job.data.instruction ?? task?.instruction ?? null,
        perRunPageLimit: workspace.scheduledPerRunPageLimit,
      };
      if (runInput.pageIds.length === 0) {
        throw new Error("Scheduled agent requires at least one target page");
      }

      let ingestion: typeof ingestions.$inferSelect | null = null;
      let agentRun: typeof agentRuns.$inferSelect | null = null;
      let flushLiveSteps = async (): Promise<void> => {};

      try {
        const adapted = await buildScheduledAgentInput(
          db,
          workspaceId,
          runInput,
        );
        if (adapted.seedPageIds.length === 0) {
          throw new Error("Scheduled agent target pages were not found");
        }

        const userId = job.data.requestedByUserId ?? task?.createdBy ?? null;
        if (!userId) {
          throw new Error("Scheduled agent run requires a requesting user");
        }

        const apiTokenId = await ensureInternalScheduledApiToken({
          db,
          workspaceId,
          userId,
        });
        ingestion = await ensureScheduledIngestion({
          db,
          workspaceId,
          apiTokenId,
          scheduledRunId: scheduledRun.id,
          taskId: task?.id ?? null,
          normalizedText: adapted.normalizedText,
          instruction: runInput.instruction ?? null,
          pageIds: adapted.seedPageIds,
          includeDescendants: runInput.includeDescendants,
        });

        const [createdAgentRun] = await db
          .insert(agentRuns)
          .values({
            ingestionId: null,
            workspaceId,
            status: "running",
            stepsJson: [],
          })
          .returning();
        if (!createdAgentRun) {
          throw new Error("Failed to create scheduled agent run trace");
        }
        agentRun = createdAgentRun;
        const activeAgentRun = createdAgentRun;
        await db
          .update(scheduledRuns)
          .set({ agentRunId: activeAgentRun.id })
          .where(eq(scheduledRuns.id, scheduledRun.id));

        await job.updateProgress(20);
        await publishAgentRunEvent(tracePublisher, activeAgentRun.id, {
          type: "snapshot",
          agentRun: toAgentRunDto(activeAgentRun),
        } satisfies AgentRunTraceEvent);

        let stepFlush = Promise.resolve();
        const emitLiveStep = (step: AgentRunTraceStep): Promise<void> => {
          stepFlush = stepFlush
            .catch(() => undefined)
            .then(async () => {
              await appendAgentRunStep(db, activeAgentRun.id, step);
              await publishAgentRunEvent(tracePublisher, activeAgentRun.id, {
                type: "step",
                step,
              });
            });
          return stepFlush;
        };
        flushLiveSteps = async (): Promise<void> => {
          await stepFlush.catch(() => undefined);
        };

        const env = buildWorkspaceAgentEnv(workspace);
        const scheduledCap =
          workspace.scheduledDailyTokenCap ??
          workspace.agentDailyTokenCap ??
          parsePositiveInt(
            process.env["AGENT_WORKSPACE_DAILY_TOKEN_CAP"],
            AGENT_LIMITS.WORKSPACE_DAILY_TOKEN_CAP,
          );
        env["AGENT_WORKSPACE_DAILY_TOKEN_CAP"] = String(scheduledCap);
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
              agentRunId: activeAgentRun.id,
              requestMetaJson: {
                ...record.requestMetaJson,
                jobId: job.id ?? null,
                scheduledRunId: scheduledRun.id,
                taskId: task?.id ?? null,
                toolCount: record.request.tools?.length ?? 0,
                toolChoice: record.request.toolChoice ?? null,
                budget: record.request.budgetMeta ?? null,
              },
              responseMetaJson: record.responseMetaJson,
            })
            .returning({ id: modelRuns.id });
          return { id: modelRun.id };
        };

        const result = await runIngestionAgentShadow({
          db,
          workspaceId,
          ingestion: { ...ingestion, normalizedText: adapted.normalizedText },
          mode: "agent",
          origin: "scheduled",
          agentRunId: activeAgentRun.id,
          seedPageIds: adapted.seedPageIds,
          instruction: runInput.instruction,
          scheduledRunId: scheduledRun.id,
          scheduledAutoApply: workspace.scheduledAutoApply,
          allowDestructiveScheduledAgent:
            workspace.allowDestructiveScheduledAgent,
          workspaceAgentInstructions: workspace.agentInstructions,
          workspaceTokenUsage: {
            usedToday: workspaceTokensUsedToday,
            cap: scheduledCap,
          },
          env,
          reserveWorkspaceTokens: (reservationRequest) =>
            reserveWorkspaceAgentTokens(
              tracePublisher,
              workspaceId,
              reservationRequest,
            ),
          onStep: emitLiveStep,
          recordModelRun,
          mutationQueues: {
            patchQueue: getQueue(QUEUE_NAMES.PATCH),
            extractionQueue: getQueue(QUEUE_NAMES.EXTRACTION),
            searchQueue: getQueue(QUEUE_NAMES.SEARCH),
          },
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
          .where(eq(agentRuns.id, activeAgentRun.id))
          .returning();
        if (completedRun) {
          await publishAgentRunEvent(tracePublisher, activeAgentRun.id, {
            type: "status",
            agentRun: toAgentRunDto(completedRun),
          });
        }

        const tokenTotals = await loadTokenTotals(db, activeAgentRun.id);
        await Promise.all([
          db
            .update(ingestions)
            .set({ status: "completed", processedAt: new Date() })
            .where(eq(ingestions.id, ingestion.id)),
          db
            .update(scheduledRuns)
            .set({
              status: "completed",
              decisionCount: result.decisionsCount,
              tokensIn: tokenTotals.tokensIn,
              tokensOut: tokenTotals.tokensOut,
              diagnosticsJson: {
                pageCount: adapted.seedPageIds.length,
                scopeTruncated: adapted.truncated,
                scheduledAutoApply: workspace.scheduledAutoApply,
                allowDestructiveScheduledAgent:
                  workspace.allowDestructiveScheduledAgent,
              },
              completedAt: new Date(),
            })
            .where(eq(scheduledRuns.id, scheduledRun.id)),
          db
            .update(ingestionDecisions)
            .set({ scheduledRunId: scheduledRun.id })
            .where(eq(ingestionDecisions.agentRunId, activeAgentRun.id)),
        ]);

        await recordScheduledRunActivity({
          db,
          workspaceId,
          scheduledRunId: scheduledRun.id,
          taskId: task?.id ?? null,
          agentRunId: activeAgentRun.id,
          status: "completed",
          decisionCount: result.decisionsCount,
          totalTokens: result.totalTokens,
          completedAt: new Date(),
        }).catch((err) => {
          log.warn(
            { err, scheduledRunId: scheduledRun.id },
            "Failed to write scheduled run activity",
          );
        });

        await job.updateProgress(100);
        return {
          scheduledRunId: scheduledRun.id,
          agentRunId: activeAgentRun.id,
          status: "completed",
          decisionCount: result.decisionsCount,
          totalTokens: result.totalTokens,
        };
      } catch (err) {
        await flushLiveSteps();
        const steps =
          err instanceof AgentLoopTimeout ||
          err instanceof AgentWorkspaceTokenCapExceeded
            ? appendErrorStep(err.steps, err)
            : [errorStep(err)];
        const totalTokens =
          err instanceof AgentLoopTimeout ||
          err instanceof AgentWorkspaceTokenCapExceeded
            ? err.totalTokens
            : 0;
        const totalLatencyMs =
          err instanceof AgentLoopTimeout ||
          err instanceof AgentWorkspaceTokenCapExceeded
            ? err.totalLatencyMs
            : 0;

        if (agentRun) {
          const [failedRun] = await db
            .update(agentRuns)
            .set({
              status: err instanceof AgentLoopTimeout ? "timeout" : "failed",
              stepsJson: steps,
              totalTokens,
              totalLatencyMs,
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
        }
        const failureWrites: Array<Promise<unknown>> = [
          db
            .update(scheduledRuns)
            .set({
              status: "failed",
              diagnosticsJson: {
                error: err instanceof Error ? err.message : String(err),
              },
              completedAt: new Date(),
            })
            .where(eq(scheduledRuns.id, scheduledRun.id)),
        ];
        if (ingestion) {
          failureWrites.push(
            db
              .update(ingestions)
              .set({ status: "failed", processedAt: new Date() })
              .where(eq(ingestions.id, ingestion.id)),
          );
        }
        await Promise.all(failureWrites);
        throw err;
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: workerConcurrency(),
    },
  );

  worker.on("completed", (job, result) => {
    const log = createJobLogger("scheduled-agent", job.id);
    log.info(
      {
        scheduledRunId: result.scheduledRunId,
        agentRunId: result.agentRunId,
        decisionCount: result.decisionCount,
      },
      "Scheduled agent run completed",
    );
  });

  worker.on("failed", (job, err) => {
    const log = createJobLogger("scheduled-agent", job?.id);
    log.error({ err }, "Job failed");
  });

  worker.on("closed", () => {
    void tracePublisher.quit();
  });

  return worker;
}
