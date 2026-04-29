import { Worker, type Job } from "bullmq";
import { and, desc, eq, sql } from "drizzle-orm";
import { agentRuns, ingestions, modelRuns } from "@wekiflow/db";
import { getDb } from "@wekiflow/db/client";
import {
  extractIngestionText,
  QUEUE_NAMES,
  type IngestionAgentJobData,
  type IngestionAgentJobResult,
} from "@wekiflow/shared";
import { createRedisConnection } from "../connection.js";
import { createJobLogger } from "../logger.js";
import { getQueue } from "../queues.js";
import {
  AgentLoopTimeout,
  runIngestionAgentShadow,
  type AgentModelRunRecord,
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

export function createIngestionAgentWorker(): Worker {
  const db = getDb();

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

      const recordModelRun = async (
        record: AgentModelRunRecord,
      ): Promise<{ id: string }> => {
        const [modelRun] = await db.insert(modelRuns).values({
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
        }).returning({ id: modelRuns.id });
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

        await db
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
          .where(eq(agentRuns.id, agentRun.id));

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
        if (err instanceof AgentLoopTimeout) {
          await db
            .update(agentRuns)
            .set({
              status: "timeout",
              stepsJson: appendErrorStep(err.steps, err),
              totalTokens: err.totalTokens,
              totalLatencyMs: err.totalLatencyMs,
              completedAt: new Date(),
            })
            .where(eq(agentRuns.id, agentRun.id));

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

        await db
          .update(agentRuns)
          .set({
            status: "failed",
            stepsJson: [errorStep(err)],
            completedAt: new Date(),
          })
          .where(eq(agentRuns.id, agentRun.id));
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

  return worker;
}
